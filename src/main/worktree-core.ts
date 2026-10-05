/**
 * Pure core for the git-worktree feature: slug derivation, argv construction,
 * agent-controlled-input validation, porcelain parsing, and adopt planning.
 *
 * Framework-free + side-effect-free so it is unit-testable in the node vitest
 * env (`tests/worktree-*.test.ts`) and lands in coverage per ADR-0001
 * (pure-core / thin-shell). The shell layer (`worktree.ts`, IPC) calls
 * {@link validateWorktreeRequest} BEFORE shelling out, then feeds the validated
 * fields to {@link buildWorktreeAddArgs} and runs them via `execFile` (no shell).
 *
 * SECURITY: every argv position the agent can influence — `branch`, `baseRef`,
 * and the worktree `path` — is validated here. The two real threats with
 * `execFile` (no shell) are **argument injection** (a value parsed as a flag
 * because it starts with `-`) and **path traversal** (a worktree escaping the
 * managed `<root>/.claude/worktrees` directory). Both fail closed.
 */

import * as path from 'node:path'
import { isFolderDenied } from './mcp/permission-core'

/**
 * Characters allowed in a branch name / ref. LOAD-BEARING beyond argv safety:
 * `branch` (and its slug) is interpolated into the manifest `dir`/`create`/`remove`
 * templates, and those `create`/`remove`/`setup` strings run via `sh -c`
 * (worktree-ipc). These classes exclude every shell metacharacter (`;|&$\`()<>`,
 * quotes, whitespace, `!`), so a validated branch/ref can never break out of the
 * trusted command string. Do NOT loosen them without re-auditing that shell seam.
 */
const SAFE_BRANCH = /^[A-Za-z0-9._/-]+$/
/** Characters allowed in a commit-ish / ref (`origin/main`, `HEAD~3`, `v1^{commit}`, a SHA). */
const SAFE_REF = /^[A-Za-z0-9._/~^@{}+-]+$/

/**
 * Slugify a branch name into a filesystem-safe directory name. Runs of unsafe
 * characters (anything outside `[A-Za-z0-9._-]`, notably `/` and whitespace)
 * collapse to a single `-`, and leading/trailing dashes are trimmed.
 * `'feat/login'` → `'feat-login'`, `'release/1.2.0'` → `'release-1.2.0'`.
 */
export function slugifyBranch(branch: string): string {
  return branch
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Absolute path of the managed worktrees directory for `root`. */
export function worktreesRoot(root: string): string {
  return path.join(root, '.claude', 'worktrees')
}

/** Drop a single trailing path separator unless the path is the root itself. */
function stripTrailingSep(p: string): string {
  if (p.length > 1 && p.endsWith(path.sep)) return p.slice(0, -1)
  return p
}

/**
 * Recognize Harnu's CANONICAL worktree layout and return the parent repo root, or
 * `null` when the path is not a direct child of a `<repo>/.claude/worktrees/`
 * directory (T61). Pure string math — a worktree at
 * `<repo>/.claude/worktrees/<slug>` yields `<repo>`; anything else (a custom
 * `--path` worktree outside `.claude/worktrees`, a nested path, a non-worktree
 * folder) yields `null` so agent-control inheritance applies ONLY to the layout
 * Harnu itself creates (the fail-closed default — T61 §5).
 */
export function canonicalWorktreeParentRepo(worktreePath: string): string | null {
  const norm = stripTrailingSep(path.normalize(worktreePath))
  const parent = path.dirname(norm) // …/.claude/worktrees
  const grandparent = path.dirname(parent) // …/.claude
  const repoRoot = path.dirname(grandparent) // …
  if (path.basename(parent) !== 'worktrees') return null
  if (path.basename(grandparent) !== '.claude') return null
  // Confirm the exact single-segment shape: the worktree must be a DIRECT child of
  // `<repoRoot>/.claude/worktrees` (rejects deeper nestings + degenerate roots).
  if (stripTrailingSep(worktreesRoot(repoRoot)) !== parent) return null
  if (!repoRoot || repoRoot === norm) return null
  return repoRoot
}

/**
 * Decide whether a worktree inherits agent control from its parent repo (T61).
 * Pure AND: the global opt-in setting is ON, the parent repo IS agent-allowed,
 * and the human did NOT opt out at create time. Every clause defaults toward NO
 * inheritance — a false anywhere leaves the worktree fail-closed (agents still
 * need an explicit per-folder grant), which is the whole security posture.
 */
export function decideWorktreeInheritance(input: {
  settingEnabled: boolean
  baseRepoAllowed: boolean
  optedOut: boolean
}): boolean {
  return input.settingEnabled && input.baseRepoAllowed && !input.optedOut
}

/**
 * Derive the on-disk path for a worktree. With no `explicit` path the worktree
 * lands at `<root>/.claude/worktrees/<slugifyBranch(branch)>`. An `explicit`
 * path is resolved against the worktrees root when relative, or normalized
 * verbatim when absolute. Derivation does NOT validate containment — callers
 * must gate with {@link validateWorktreeRequest}.
 */
export function deriveWorktreePath(root: string, branch: string, explicit?: string): string {
  const base = worktreesRoot(root)
  const e = explicit?.trim()
  if (e) {
    return path.isAbsolute(e) ? stripTrailingSep(path.normalize(e)) : path.resolve(base, e)
  }
  return path.join(base, slugifyBranch(branch))
}

/**
 * Discriminated spec for the three `git worktree add` shapes:
 * - `new-branch`: create `branch` off `baseRef` at `path`.
 * - `existing-branch`: check out an existing `branch` at `path`.
 * - `detached`: check out `baseRef` detached at `path`.
 */
export type WorktreeAddSpec =
  | {
      kind: 'new-branch'
      branch: string
      path: string
      baseRef: string
      /**
       * Emit `--no-track` (BUG-26). Set when `baseRef` is a remote-tracking ref Harnu
       * chose IMPLICITLY: without it, git's `branch.autoSetupMerge` default would give
       * the new branch `origin/main` as its upstream, and a bare `git push` under
       * `push.default=simple` then refuses ("upstream branch name does not match").
       * An explicit, caller-named base keeps git's default tracking.
       */
      noTrack?: boolean
    }
  | { kind: 'existing-branch'; branch: string; path: string }
  | { kind: 'detached'; path: string; baseRef: string }

/**
 * Build the argv (after the `git` executable) for `git worktree add`. The
 * fields MUST already be validated via {@link validateWorktreeRequest}; this
 * function only assembles tokens, it does not re-check them.
 */
export function buildWorktreeAddArgs(spec: WorktreeAddSpec): string[] {
  switch (spec.kind) {
    case 'new-branch':
      return [
        'worktree',
        'add',
        ...(spec.noTrack ? ['--no-track'] : []),
        '-b',
        spec.branch,
        spec.path,
        spec.baseRef
      ]
    case 'existing-branch':
      return ['worktree', 'add', spec.path, spec.branch]
    case 'detached':
      return ['worktree', 'add', '--detach', spec.path, spec.baseRef]
  }
}

/**
 * Decide the base a NEW-branch worktree is cut from, and whether the literal
 * `HEAD` sentinel must be pinned to the passed folder's tip (BUG-12/T64).
 *
 * Precedence: an explicit `baseRef` (dialog picker / caller-supplied) wins, else
 * the manifest `from`, else the `HEAD` sentinel. The catch: `git -C <repoRoot>
 * worktree add … HEAD` resolves `HEAD` against the SHARED repo root, not the
 * `folder` the caller asked to branch FROM — so a stacked worktree (cut wt2 from
 * wt1's work) silently used the main checkout's HEAD. A NAMED ref (`main`,
 * `origin/x`, a SHA) means the same commit from any worktree and passes through
 * as-is; only the bare `HEAD` needs pinning to the folder's actual commit, which
 * the env-bound caller does via `git -C <folder> rev-parse HEAD`.
 *
 * @param baseRef - the caller's explicit base (empty/absent → fall through).
 * @param manifestFrom - the manifest `from` (already defaulted to `'HEAD'`).
 * @returns the resolved base, and `pinToFolderHead` when it is the HEAD sentinel.
 */
export function resolveWorktreeBase(
  baseRef: string | undefined,
  manifestFrom: string
): { base: string; pinToFolderHead: boolean } {
  const explicit = baseRef?.trim()
  if (explicit) return { base: explicit, pinToFolderHead: false }
  const from = manifestFrom.trim() || 'HEAD'
  if (from !== 'HEAD') return { base: from, pinToFolderHead: false }
  return { base: 'HEAD', pinToFolderHead: true }
}

/**
 * How a new-branch worktree's base must be resolved (BUG-26). The plan is decided
 * purely; the env shell ({@link worktree-ipc}) then runs the fetch/rev-parse for it
 * and hands the results back to {@link finalizeWorktreeBase}.
 *
 * - `explicit` — the caller named the base (dialog picker / `baseRef`). Passes through
 *   verbatim: no fetch, no remap, no `--no-track`. Untouched by BUG-26 by design.
 * - `named` — the manifest's `from:` (e.g. `main`). Resolved to its remote-tracking
 *   counterpart (`origin/main`) rather than used as a literal LOCAL branch tip.
 * - `remote-default` — the `HEAD` sentinel in the repo's PRIMARY worktree. That
 *   checkout is shared and mutable (other Harnu sessions live in it), so its `HEAD` is
 *   transient state, not a base. Resolved to the remote's default branch.
 * - `folder-head` — the `HEAD` sentinel in a LINKED worktree. That checkout belongs to
 *   one session and its tip IS the intended base (stacking — T64/BUG-12), so it is
 *   still pinned to the folder's own commit.
 */
export type WorktreeBasePlan =
  | { kind: 'explicit'; base: string }
  | { kind: 'named'; name: string }
  | { kind: 'remote-default' }
  | { kind: 'folder-head' }

/**
 * Decide HOW a new worktree's base must be resolved (BUG-26).
 *
 * The old resolver ({@link resolveWorktreeBase}) is still the precedence primitive —
 * explicit `baseRef` > manifest `from` > `HEAD` sentinel — but its two implicit
 * outcomes were both resolved against MUTABLE LOCAL STATE: a bare `from: main` became
 * the LOCAL `main` tip (routinely 6+ commits behind `origin/main` in a long session
 * where nobody pulls), and the `HEAD` sentinel became `git -C <folder> rev-parse HEAD`
 * on a checkout other Harnu sessions share — which in the wild returned the tip of a
 * completely unrelated branch, because another session was mid-work in that directory
 * at the moment of the call.
 *
 * So both implicit outcomes are re-pointed at the remote-tracking state, which no
 * concurrent session can perturb. The one implicit case that is NOT shared state — the
 * `HEAD` sentinel in a linked worktree, i.e. deliberately stacking on another
 * worktree's work (T64) — keeps pinning to that folder's tip.
 *
 * @param baseRef - the caller's explicit base (empty/absent → fall through).
 * @param manifestFrom - the manifest `from` (already defaulted to `'HEAD'`).
 * @param probes.folderIsPrimaryWorktree - whether the folder being branched FROM is the
 *   repo's primary (shared) checkout. The shell fails this OPEN (unknown → `true`), so
 *   an unprobeable repo lands on the deterministic path rather than back on the bug.
 */
export function planWorktreeBase(
  baseRef: string | undefined,
  manifestFrom: string,
  probes: { folderIsPrimaryWorktree: boolean }
): WorktreeBasePlan {
  const resolved = resolveWorktreeBase(baseRef, manifestFrom)
  const explicit = baseRef?.trim()
  if (explicit) return { kind: 'explicit', base: resolved.base }
  if (!resolved.pinToFolderHead) return { kind: 'named', name: resolved.base }
  return probes.folderIsPrimaryWorktree ? { kind: 'remote-default' } : { kind: 'folder-head' }
}

/**
 * Parse `git rev-parse --git-dir --git-common-dir` into its two paths, or `null` when
 * the output is not the expected pair.
 *
 * The `null` case is LOAD-BEARING, not defensive noise. `git rev-parse` does not fail on
 * an unrecognized option — it ECHOES it as an output line and still exits 0. So an
 * earlier version of this probe, which asked for `--path-format=absolute` (git ≥ 2.31),
 * did not throw on Ubuntu 20.04 / Debian 11 git (2.25 / 2.30): it got the flag back as
 * line 1, compared it against a real path, concluded "these differ → this is a linked
 * worktree", and fell straight back onto the shared-checkout `rev-parse HEAD` that
 * BUG-26 exists to eliminate. Silently, on a whole class of machines Harnu ships a `.deb`
 * to. Hence: no version-gated flags here, and any line that looks like a flag is a
 * parse failure, never a path.
 *
 * Both paths may be RELATIVE to the queried folder (git prints a bare `.git` for the
 * primary worktree), so the caller resolves them against it before comparing.
 */
export function parseGitDirPair(stdout: string): { gitDir: string; commonDir: string } | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  if (lines.length !== 2) return null
  if (lines.some((l) => l.startsWith('-'))) return null
  return { gitDir: lines[0], commonDir: lines[1] }
}

/** The remote + branch the shell must fetch, and the tracking ref it then resolves. */
export interface RemoteTrackingTarget {
  /** Remote to fetch from (`origin`). */
  remote: string
  /** Branch name on that remote (`main`). */
  branch: string
  /** The remote-tracking ref the fetch updates (`origin/main`) — the base we want. */
  trackingRef: string
}

/** A 7-to-40-char all-hex name — a commit SHA, not something with a remote counterpart. */
const LOOKS_LIKE_SHA = /^[0-9a-f]{7,40}$/i

/**
 * Map a manifest `from` name onto the remote it should be resolved against. Pure —
 * `knownRemotes` comes from a `git remote` probe.
 *
 * - `main` (bare name) → fetch `origin main`, resolve `origin/main`.
 * - `origin/main` (already remote-qualified, first segment IS a known remote) → fetch
 *   `origin main`, resolve `origin/main`. Freshening it is still worth a fetch: the
 *   local remote-tracking ref goes stale exactly the same way.
 * - a SHA, or a repo with no such remote → `null`: nothing to resolve remotely, the
 *   caller keeps the literal name (a SHA already denotes one immutable commit).
 *
 * A name that merely LOOKS like a SHA but is really a branch (`deadbeef`) is left
 * literal — accepted: it still resolves, just against the local ref, and no real repo
 * names a branch that way.
 */
export function remoteTrackingTarget(
  name: string,
  knownRemotes: readonly string[],
  defaultRemote = 'origin'
): RemoteTrackingTarget | null {
  const trimmed = name.trim()
  if (!trimmed) return null
  if (LOOKS_LIKE_SHA.test(trimmed)) return null

  const slash = trimmed.indexOf('/')
  if (slash > 0) {
    const head = trimmed.slice(0, slash)
    const rest = trimmed.slice(slash + 1)
    if (rest && knownRemotes.includes(head)) {
      return { remote: head, branch: rest, trackingRef: trimmed }
    }
  }

  if (!knownRemotes.includes(defaultRemote)) return null
  return {
    remote: defaultRemote,
    branch: trimmed,
    trackingRef: `${defaultRemote}/${trimmed}`
  }
}

/** What the shell resolved for a {@link WorktreeBasePlan}, feeding {@link finalizeWorktreeBase}. */
export interface WorktreeBaseProbes {
  /**
   * The remote-tracking ref that verified after the fetch (`origin/main`), or `null`
   * when the repo has no remote, the branch does not exist on it, or git failed.
   */
  remoteRef: string | null
  /** The passed folder's `HEAD` commit SHA, or `null` on a commit-less repo / failure. */
  folderHead: string | null
  /**
   * The passed folder's current branch name (`develop`), or `null` when detached/unknown.
   * Used ONLY to warn when the remote default we picked is not the line of development
   * the operator's checkout is actually on — see {@link finalizeWorktreeBase}.
   */
  folderBranch?: string | null
  /**
   * `explicit` plan only: how far the caller's named LOCAL base trails its
   * remote-tracking counterpart, or `null` when it has none (a remote ref, a SHA, or an
   * unpushed local branch) or is already caught up. Never gates the create — see
   * {@link finalizeWorktreeBase}'s `explicit` case.
   */
  explicitBehindRemote?: { aheadCount: number; upstream: string } | null
}

/** The base a worktree is actually cut from, plus how it got there. */
export interface ResolvedBase {
  /** The commit-ish handed to `git worktree add`. */
  base: string
  /**
   * True when Harnu RESOLVED the base to a remote-tracking ref itself (the `named` and
   * `remote-default` plans). The create then passes `--no-track`, so the new branch does
   * not silently inherit `origin/main` as its upstream — which would make a bare
   * `git push` fail under `push.default=simple` ("upstream branch name does not match").
   *
   * False for an `explicit` base, even one that names a remote ref: a caller who passed
   * `origin/main` by hand gets git's normal tracking behavior, exactly as before.
   */
  remoteTracked: boolean
  /** Set when resolution DEGRADED to a local fallback — surfaced in the create warnings. */
  warning?: string
}

/**
 * Turn a {@link WorktreeBasePlan} + the shell's probe results into the final base
 * (BUG-26). Pure. Every remote path degrades to the old local behavior rather than
 * failing the create — an offline machine or a remote-less repo must still get a
 * worktree — but a degrade always emits a `warning` so the operator sees that the base
 * is NOT the deterministic one, instead of silently re-living the bug.
 */
export function finalizeWorktreeBase(
  plan: WorktreeBasePlan,
  probes: WorktreeBaseProbes
): ResolvedBase {
  switch (plan.kind) {
    case 'explicit': {
      const behind = probes.explicitBehindRemote
      return {
        base: plan.base,
        remoteTracked: false,
        ...(behind ? { warning: explicitBehindRemoteWarning(plan.base, behind) } : {})
      }
    }

    case 'named':
      if (probes.remoteRef) return { base: probes.remoteRef, remoteTracked: true }
      return {
        base: plan.name,
        remoteTracked: false,
        warning:
          `could not resolve "${plan.name}" against a remote; ` +
          `branching from the LOCAL "${plan.name}", which may be stale`
      }

    case 'remote-default':
      if (probes.remoteRef) {
        return {
          base: probes.remoteRef,
          remoteTracked: true,
          // Don't be silent about the one case where this fix overrides an intent the
          // operator plausibly had: their checkout sits on `develop` (a release line),
          // and with no explicit base we still cut from `origin/main`. Deterministic —
          // and deliberate — but they must not discover it at PR time.
          ...(divergentDefault(probes.remoteRef, probes.folderBranch)
            ? {
                warning:
                  `branched from "${probes.remoteRef}" (the remote default), but this ` +
                  `checkout is on "${probes.folderBranch}" — pass an explicit base to ` +
                  'branch from that line instead'
              }
            : {})
        }
      }
      if (probes.folderHead) {
        return {
          base: probes.folderHead,
          remoteTracked: false,
          warning:
            'could not resolve the remote default branch; branching from the folder’s ' +
            'current HEAD, which is shared with any other session in that checkout'
        }
      }
      return { base: 'HEAD', remoteTracked: false }

    case 'folder-head':
      if (probes.folderHead) return { base: probes.folderHead, remoteTracked: false }
      return { base: 'HEAD', remoteTracked: false }
  }
}

/** Whether the remote ref we picked names a different branch than the folder is on. */
function divergentDefault(remoteRef: string, folderBranch: string | null | undefined): boolean {
  if (!folderBranch || folderBranch === 'HEAD') return false
  return !remoteRef.endsWith(`/${folderBranch}`)
}

/**
 * Warning text for an explicit LOCAL base that trails its remote-tracking counterpart —
 * BUG-26's exact smell, one level up. This card WARNS rather than refuses: deliberately
 * branching off a not-yet-pushed local branch is the normal stacking case; only a base
 * that is stale relative to its own remote is worth naming.
 */
export function explicitBehindRemoteWarning(
  base: string,
  behind: { aheadCount: number; upstream: string }
): string {
  return (
    `explicit base "${base}" is ${behind.aheadCount} commit(s) behind its remote-tracking ` +
    `counterpart "${behind.upstream}" — branching from it anyway; push "${base}" first if that's not intended`
  )
}

/**
 * Steerable error for an explicit base that does not resolve to a real commit (this
 * card). Never a silent fallback to main — the caller asked for a specific base and
 * must be told loudly when it doesn't exist, naming the exact ref so it's actionable.
 */
export function badExplicitBaseError(base: string): string {
  return `BAD_BASE: base ref "${base}" does not exist`
}

/**
 * Reject a resolved base that git would read as an OPTION rather than a commit-ish.
 *
 * `baseRef` (agent-supplied) is already gated by {@link validateWorktreeRequest}, but the
 * manifest `from:` never was — it is only checked for non-blankness when the manifest is
 * parsed, and it lands in the last argv slot of `git worktree add`, which happily parses
 * a leading-dash positional as a flag. `WORKTREE.md` is "trusted" only insofar as the
 * repo author wrote it; Harnu opens whatever repo the user points it at, so a hostile
 * `from: --upload-pack=…` is a real (pre-existing) argv-injection seam that this change
 * makes more load-bearing. Fail closed on the resolved base, wherever it came from.
 */
export function validateResolvedBase(base: string): ValidationResult {
  const trimmed = base.trim()
  if (!trimmed) return fail('resolved base is empty')
  if (trimmed.startsWith('-')) return fail(`resolved base must not start with "-": ${trimmed}`)
  if (!SAFE_REF.test(trimmed)) return fail(`resolved base contains invalid characters: ${trimmed}`)
  return { ok: true }
}

/**
 * Choose the `git worktree add` spec from the request + a checkout probe (T44 S2
 * — "complete controls"). The closed loop of real workflows (e.g. review an
 * existing PR branch, BUG-6) needs to CHECK OUT an existing ref, not only branch
 * a new one:
 *
 *  - **no `ref`** → `new-branch` (`-b <branch> <base>`) — the default create.
 *  - **`ref`, not checked out elsewhere** → `existing-branch` (`add <path> <ref>`)
 *    — git DWIMs a local branch, or creates a tracking branch from `origin/<ref>`.
 *  - **`ref`, already checked out in another worktree** → `detached`
 *    (`add --detach <path> <ref>`) — a branch can't be checked out twice, so we
 *    detach at its commit (the BUG-6 "branch checked out elsewhere" case).
 *
 * Pure: the caller supplies `refCheckedOutElsewhere` from a `git worktree list`
 * probe. `path` is the already-resolved (validated) target.
 */
export function chooseWorktreeAddSpec(input: {
  branch: string
  path: string
  base: string
  ref?: string
  refCheckedOutElsewhere?: boolean
  /** See {@link WorktreeAddSpec} — only meaningful on the `new-branch` shape (BUG-26). */
  noTrack?: boolean
}): WorktreeAddSpec {
  const ref = input.ref?.trim()
  if (!ref) {
    return {
      kind: 'new-branch',
      branch: input.branch,
      path: input.path,
      baseRef: input.base,
      ...(input.noTrack ? { noTrack: true } : {})
    }
  }
  if (input.refCheckedOutElsewhere) {
    return { kind: 'detached', path: input.path, baseRef: ref }
  }
  return { kind: 'existing-branch', branch: ref, path: input.path }
}

/** A worktree-creation request as supplied by the (agent-controlled) caller. */
export interface WorktreeRequest {
  /** Absolute repo root the worktree belongs to. */
  root: string
  /** Branch name to create or check out. */
  branch: string
  /** Optional commit-ish to branch from / detach at. */
  baseRef?: string
  /**
   * Optional EXISTING ref to check out instead of creating a new branch (T44 S2).
   * When set, the worktree checks out this ref (DWIM local/remote tracking, or
   * detached if it is already checked out elsewhere) rather than branching from
   * `baseRef`. `branch` still names the worktree directory. Validated like a ref.
   */
  ref?: string
  /** Optional custom worktree location (relative to the worktrees root, or absolute). */
  explicitPath?: string
}

/** Result of {@link validateWorktreeRequest}: `ok`, or a machine-readable `reason`. */
export type ValidationResult = { ok: true } | { ok: false; reason: string }

function fail(reason: string): ValidationResult {
  return { ok: false, reason }
}

/**
 * Whether `child` is `parent` itself or a path nested inside it. Pure string
 * comparison via `path.relative` (no fs) — a `..`-prefixed or absolute relative
 * result means `child` escaped `parent`. A directory whose name merely starts
 * with `..` (e.g. `..foo`) is correctly treated as inside.
 */
function isInside(parent: string, child: string): boolean {
  if (child === parent) return true
  const rel = path.relative(parent, child)
  if (rel === '') return true
  if (rel === '..' || path.isAbsolute(rel)) return false
  return !rel.startsWith('..' + path.sep)
}

/**
 * Validate every agent-controlled argv position before a worktree is created.
 * Rejects:
 * - a `branch` that is empty, starts with `-` (argv injection), contains `..`
 *   (ref-range / traversal), or any character outside {@link SAFE_BRANCH};
 * - a `baseRef` that starts with `-` or contains a character outside
 *   {@link SAFE_REF};
 * - an `explicitPath` whose derived worktree escapes `<root>/.claude/worktrees`.
 */
export function validateWorktreeRequest(req: WorktreeRequest): ValidationResult {
  const branch = req.branch?.trim() ?? ''
  if (!branch) return fail('branch is required')
  if (branch.startsWith('-')) return fail('branch must not start with "-"')
  if (branch.includes('..')) return fail('branch must not contain ".."')
  if (!SAFE_BRANCH.test(branch)) return fail('branch contains invalid characters')

  if (req.baseRef !== undefined) {
    const baseRef = req.baseRef.trim()
    if (baseRef) {
      if (baseRef.startsWith('-')) return fail('baseRef must not start with "-"')
      if (!SAFE_REF.test(baseRef)) return fail('baseRef contains invalid characters')
    }
  }

  // `ref` (T44 S2) shares an argv position with a branch/commit-ish, so gate it
  // like a ref: no leading `-` (argv injection), no `..` (range/traversal).
  if (req.ref !== undefined) {
    const ref = req.ref.trim()
    if (ref) {
      if (ref.startsWith('-')) return fail('ref must not start with "-"')
      if (ref.includes('..')) return fail('ref must not contain ".."')
      if (!SAFE_REF.test(ref)) return fail('ref contains invalid characters')
    }
  }

  const target = deriveWorktreePath(req.root, branch, req.explicitPath)
  if (!isInside(worktreesRoot(req.root), target)) {
    return fail('worktree path escapes the worktrees root')
  }

  return { ok: true }
}

/** One worktree as reported by `git worktree list --porcelain`. */
export interface WorktreeListEntry {
  /** Absolute path of the worktree. */
  path: string
  /** Checked-out commit SHA (empty for a bare repo). */
  head: string
  /** Short branch name (`refs/heads/` stripped); empty when detached or bare. */
  branch: string
  /** Whether HEAD is detached. */
  detached: boolean
  /** Whether the entry is the bare repository. */
  bare: boolean
  /** Set (true) only when git printed a `prunable` line: the worktree's directory is gone. */
  prunable?: boolean
  /** Set (true) only when git printed a `locked` line (with or without a reason). */
  locked?: boolean
}

/** One compact, redacted worktree row for the `list_worktrees` MCP read (T44 S3b). */
export interface WorktreeListingRow {
  /** Stable redacted label (path basename) — the only identity disclosed by default. */
  alias: string
  /** Absolute path — present ONLY when `redactPaths` is false. */
  path?: string
  /** Short branch name; empty when detached. */
  branch: string
  /** Short (12-char) checked-out commit SHA. */
  head: string
  /** Whether HEAD is detached. */
  detached: boolean
  /** True iff the worktree path is on the agent allowlist (actionable). */
  controllable: boolean
  /** True iff the worktree has uncommitted changes. */
  dirty: boolean
}

/**
 * Project real `git worktree list` entries (+ a dirty probe + the block list) into
 * the compact, redacted rows an MCP agent reads (T44 S3b — proprioception; the
 * "list_worktrees diverged from git" face of BUG-4). Pure + deterministic: drops
 * bare entries, sorts by path, shortens the SHA, and marks `dirty` from the probe
 * map. Absolute paths leak only when `redactPaths` is false.
 *
 * `controllable` is now the INVERSE of a block, not membership of an allowlist:
 * post-reversal an agent may act in every worktree except one the operator blocked
 * (prefix-scoped, so blocking a repo blocks its worktrees). A worktree the agent
 * just created reads `controllable: true` immediately — under the old allowlist it
 * read `false`, which told the agent to stand down in the very worktree it had been
 * asked to work in.
 */
export function toWorktreeListing(
  entries: readonly WorktreeListEntry[],
  opts: {
    /** Absolute folder paths the operator BLOCKED (`Policy.denyFolders`). */
    denyFolders?: readonly string[]
    dirtyByPath: Readonly<Record<string, boolean>>
    redactPaths: boolean
  }
): WorktreeListingRow[] {
  const denied = opts.denyFolders ?? []
  return entries
    .filter((e) => !e.bare)
    .slice()
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((e) => {
      const row: WorktreeListingRow = {
        alias: basenameOf(e.path),
        branch: e.branch,
        head: e.head.slice(0, 12),
        detached: e.detached,
        controllable: !isFolderDenied(e.path, denied),
        dirty: opts.dirtyByPath[e.path] === true
      }
      if (!opts.redactPaths) row.path = e.path
      return row
    })
}

/** Last path segment (basename) — the redacted worktree alias. */
function basenameOf(p: string): string {
  const trimmed = p.replace(/[/\\]+$/, '')
  const seg = trimmed.split(/[/\\]/).pop() ?? ''
  return seg.length > 0 ? seg : p
}

const HEADS_PREFIX = 'refs/heads/'

/**
 * Parse `git worktree list --porcelain` output. Each record begins with a
 * `worktree <path>` line; subsequent `HEAD`, `branch`, `detached`, and `bare`
 * lines fill the entry until the next `worktree` line (blank-line separators
 * and unknown attributes are ignored). `locked` and `prunable` annotations
 * (with or without a reason) set the optional `locked`/`prunable` flags; an
 * entry without them keeps the original shape. Tolerates CRLF and a missing
 * trailing blank line.
 */
export function parseWorktreeList(porcelain: string): WorktreeListEntry[] {
  const entries: WorktreeListEntry[] = []
  let cur: WorktreeListEntry | null = null

  for (const rawLine of porcelain.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '')
    if (line.startsWith('worktree ')) {
      if (cur) entries.push(cur)
      cur = {
        path: line.slice('worktree '.length).trim(),
        head: '',
        branch: '',
        detached: false,
        bare: false
      }
      continue
    }
    if (!cur) continue
    if (line.startsWith('HEAD ')) {
      cur.head = line.slice('HEAD '.length).trim()
    } else if (line.startsWith('branch ')) {
      const ref = line.slice('branch '.length).trim()
      cur.branch = ref.startsWith(HEADS_PREFIX) ? ref.slice(HEADS_PREFIX.length) : ref
    } else if (line === 'detached') {
      cur.detached = true
    } else if (line === 'bare') {
      cur.bare = true
    } else if (line === 'locked' || line.startsWith('locked ')) {
      cur.locked = true
    } else if (line === 'prunable' || line.startsWith('prunable ')) {
      cur.prunable = true
    }
    // Blank lines and unknown attributes: ignored.
  }
  if (cur) entries.push(cur)
  return entries
}

/**
 * A worktree's working-tree status, split along the axis `git status --porcelain`
 * collapses (BUG-75).
 *
 * `git status --porcelain` emits one line per change and includes `??` records
 * for untracked paths, so "any output at all" conflates two very different
 * facts: a tracked file the operator edited and never committed, and a stray
 * file git was never asked to track. Cleanup blocks on the first and must not
 * block on the second — an untracked file is disclosed and archived, never a
 * reason to refuse a provably-merged worktree.
 */
export interface WorktreeStatus {
  /** True when at least one TRACKED path is modified/staged/deleted/renamed/conflicted. */
  trackedDirty: boolean
  /**
   * Untracked paths, verbatim from the `??` records. With git's default
   * `--untracked-files=normal` an untracked directory collapses to a single
   * `dir/` entry, so this is a disclosure list, not a file count.
   */
  untracked: string[]
}

/**
 * Parse `git status --porcelain -z` into a {@link WorktreeStatus}.
 *
 * `-z` (NUL-terminated, never quoted) is what makes the path list trustworthy:
 * the default format C-quotes any path with a space or a non-ASCII byte, and a
 * disclosure dialog that shows `"my file.txt"` — or worse, splits it — is worse
 * than one that shows nothing. A rename/copy record (`R`/`C` in either column) emits TWO
 * NUL-terminated fields (new path, then original), so the original is consumed
 * here rather than being misread as the next record.
 */
export function parsePorcelainStatus(stdout: string): WorktreeStatus {
  const fields = stdout.split('\0')
  const untracked: string[] = []
  let trackedDirty = false

  for (let i = 0; i < fields.length; i++) {
    const record = fields[i]
    // The last field after a trailing NUL is empty; a blank field is never a record.
    if (record.length < 4) continue
    const xy = record.slice(0, 2)
    const path = record.slice(3)
    if (xy === '??') {
      untracked.push(path)
      continue
    }
    // `!!` only appears with --ignored, which this probe never passes; treat it
    // as neither tracked-dirty nor untracked if a caller ever adds the flag.
    if (xy === '!!') continue
    trackedDirty = true
    // A rename/copy carries its source path as the very next NUL-terminated
    // field; skip it so it cannot be parsed as a record of its own. Either
    // column can carry the `R`/`C`: an unstaged rename (an intent-to-added new
    // path) is ` R`, and reading only X let its source swallow the next record
    // (BUG-124). The v1 format carries at most one source field per record.
    if (xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C') i++
  }

  return { trackedDirty, untracked }
}

/** A listable branch for the New-worktree dialog's base-ref select (T48). */
export interface BranchRef {
  /** Short name: `main`, `feat/login`, `origin/main`. */
  name: string
  /** true when it comes from `refs/remotes` (grouped under the "Remote" optgroup). */
  remote: boolean
  /** Short SHA of the ref's commit (for a tooltip / future dedupe). */
  head: string
}

/**
 * Parse `git for-each-ref --format='%(refname:short)%09%(objectname:short)'`.
 * One ref per line, `name \t head`. Blank lines are skipped, and any
 * `<remote>/HEAD` entry (a symbolic pointer like `origin/HEAD`, not a
 * checkout-able branch) is dropped. The `remote` flag comes from the caller —
 * the shell issues one `for-each-ref` per refspec (`refs/heads` vs
 * `refs/remotes`) and passes the
 * origin explicitly, avoiding a fragile `/`-in-name heuristic. Order is
 * preserved (git already sorts by refname).
 */
export function parseBranchRefs(stdout: string, opts: { remote: boolean }): BranchRef[] {
  const out: BranchRef[] = []
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const tab = line.indexOf('\t')
    const name = (tab === -1 ? line : line.slice(0, tab)).trim()
    if (!name) continue
    if (/\/HEAD$/.test(name)) continue // origin/HEAD symbolic pointer — not a branch
    const head = tab === -1 ? '' : line.slice(tab + 1).trim()
    out.push({ name, remote: opts.remote, head })
  }
  return out
}

/**
 * A pre-existing branch or worktree whose name embeds a card's slug — a
 * non-blocking collision signal (BUG-40 §3.5 / BUG-50 absorbed).
 */
export interface ExistingWorkMatch {
  kind: 'branch' | 'worktree'
  /** The branch name, or the worktree's absolute path. */
  name: string
}

const CARD_BRANCH_PREFIX = 'card/'

/**
 * The dispatch slug a branch name carries: everything after `card/` for the
 * `card/<slug>` convention (`dispatch-substrate.ts`'s `worktreeDispatchBranch`),
 * else the branch name itself. Pure string math — lets the collision matcher
 * below work for both card-dispatched and hand-named branches.
 */
export function slugFromBranch(branch: string): string {
  return branch.startsWith(CARD_BRANCH_PREFIX) ? branch.slice(CARD_BRANCH_PREFIX.length) : branch
}

/**
 * Find local branches/worktrees whose name embeds `slug` — cheap, deterministic
 * evidence that a card may already have a worktree, branch, or (via a pushed
 * remote-tracking ref) an open PR, since `deriveWorktreePath`/`worktreeDispatchBranch`
 * both key a card's work by its slug (BUG-40 root cause). `excludeBranch` skips the
 * literal branch about to be created, so a plain first-time create for that exact
 * branch never warns about itself. Warn, never block (spec §3.5): an orchestrator
 * may legitimately want a fresh attempt, and a `gh pr list` network probe is
 * deliberately out of scope — this only reads already-fetched local git state.
 */
export function findExistingWorkForSlug(
  slug: string,
  branches: readonly BranchRef[],
  worktrees: readonly WorktreeListEntry[],
  excludeBranch?: string
): ExistingWorkMatch[] {
  const matches: ExistingWorkMatch[] = []
  if (!slug) return matches
  const seen = new Set<string>()
  for (const b of branches) {
    if (b.name === excludeBranch) continue
    if (!b.name.includes(slug)) continue
    const key = `branch:${b.name}`
    if (seen.has(key)) continue
    seen.add(key)
    matches.push({ kind: 'branch', name: b.name })
  }
  for (const w of worktrees) {
    if (w.bare) continue
    if (w.branch === excludeBranch) continue
    if (!w.branch.includes(slug) && !w.path.includes(slug)) continue
    const key = `worktree:${w.path}`
    if (seen.has(key)) continue
    seen.add(key)
    matches.push({ kind: 'worktree', name: w.path })
  }
  return matches
}

/** What to do with an adopt candidate: nothing (already tracked) or add it. */
export type AdoptPlan = 'noop' | 'add'

/** Normalize a worktree path for stable equality (collapse `.`/`..`, strip trailing sep). */
function normalizeWorktreePath(p: string): string {
  return stripTrailingSep(path.normalize(p))
}

/**
 * Decide whether a candidate worktree path needs adopting. Returns `'noop'`
 * when the normalized candidate already appears among `existingPaths`,
 * otherwise `'add'`. Paths are normalized (trailing slash + `.`/`..` segments
 * collapsed) before comparison so trivially-different spellings dedupe.
 */
export function planAdopt(existingPaths: string[], candidate: string): AdoptPlan {
  const target = normalizeWorktreePath(candidate)
  const set = new Set(existingPaths.map(normalizeWorktreePath))
  return set.has(target) ? 'noop' : 'add'
}

/** A read-only worktree-creation plan for the New-worktree dialog's dry-run (T32/AC5). */
export interface WorktreePlanPreview {
  /** Absolute, slugified target dir the worktree would be created at. */
  targetPath: string
  /** The raw branch ref (e.g. `feature/foo`), shown intact. */
  branch: string
  /** Resolved base ref (explicit → manifest `from` → `HEAD`); in a ref checkout, the ref itself. */
  baseRef: string
  /**
   * How the worktree is produced:
   * - `new-branch` — `git worktree add -b <branch> <base>` (the default create).
   * - `delegated-create` — the manifest's own `create:` script owns the flow.
   * - `existing-branch` — check out an existing local/remote `ref` (PR review, T44 S2).
   * - `detached` — check out a `ref` that's already checked out elsewhere, detached.
   */
  mode: 'new-branch' | 'delegated-create' | 'existing-branch' | 'detached'
  /** Which manifest source won (`worktree-md` | `default` | …), for display. */
  source: string
  /** The `copy`/`link` seed entry lists from the manifest. */
  seed: { copy: string[]; link: string[] }
  /** The `setup`/`create` shell commands that WILL run — disclosed before confirm. */
  commands: string[]
  /** Non-fatal manifest degradation (malformed front matter, skipped seeds, …). */
  warnings: string[]
}

/** A stage boundary in the worktree create pipeline (for the dialog's stepper). */
export type WorktreeStage = 'resolve' | 'worktree-add' | 'seed' | 'setup' | 'adopt'

/** A create-progress event emitted per stage boundary (T32/AC8). */
export interface WorktreeProgress {
  /** Which pipeline stage this event is about. */
  stage: WorktreeStage
  /** Optional human detail (e.g. the seed op or setup command index). */
  detail?: string
  /** True on the terminal event — the whole create finished successfully. */
  done?: boolean
}

/** A typed reason `worktree:plan` could not produce a plan (never thrown to the UI). */
export type WorktreePlanError =
  | { error: 'target-exists'; path: string }
  | { error: 'branch-checked-out'; worktree: string }
  | { error: 'no-commits' }
  | { error: 'unsafe-target'; path: string }
  | { error: 'invalid-request'; reason: string }

/** The `worktree:plan` result: a preview or a typed pre-check failure. */
export type WorktreePlanResult = WorktreePlanPreview | WorktreePlanError

/** Runtime guard: is a {@link WorktreePlanResult} the error variant? */
export function isWorktreePlanError(r: WorktreePlanResult): r is WorktreePlanError {
  return 'error' in r
}

/**
 * Apply the AC6 pre-checks to a resolved plan preview. Pure — the env shell
 * supplies the probe results from git/fs. Precedence: target-exists →
 * branch-checked-out → no-commits → the plan. (`invalid-request` and
 * `unsafe-target` are decided upstream, before/around manifest resolution.)
 */
export function classifyWorktreePlan(
  preview: WorktreePlanPreview,
  probes: { targetExists: boolean; checkedOutWorktree: string | null; hasCommits: boolean }
): WorktreePlanResult {
  if (probes.targetExists) return { error: 'target-exists', path: preview.targetPath }
  if (probes.checkedOutWorktree) {
    return { error: 'branch-checked-out', worktree: probes.checkedOutWorktree }
  }
  if (!probes.hasCommits) return { error: 'no-commits' }
  return preview
}

/** Why a worktree removal is blocked, or `null` when it may proceed. */
export type RemovalBlock = 'uncommitted' | 'unpushed' | null

/**
 * Decide whether a worktree removal is blocked (T32/AC18). Pure: `force`
 * overrides everything; otherwise uncommitted changes block first (most urgent
 * to lose), then unpushed commits. Returns `null` when removal may proceed. The
 * env-bound shell (`worktree-ipc`) supplies `dirty`/`unpushed` from git probes;
 * a worktree with no upstream is treated as `unpushed` (safe default) there.
 */
export function worktreeRemovalBlock(input: {
  dirty: boolean
  unpushed: boolean
  force: boolean
}): RemovalBlock {
  if (input.force) return null
  if (input.dirty) return 'uncommitted'
  if (input.unpushed) return 'unpushed'
  return null
}

/** What {@link resolveWorktreeRemovalPlan} decides for a `removeWorktree` call. */
export interface WorktreeRemovalPlan {
  /** Whether to probe `isWorktreeDirty`/`hasUnpushedCommits` before removing. */
  runPreflight: boolean
  /** Whether `git worktree remove` must pass `--force`. */
  effectiveForce: boolean
  /** Whether it's meaningful to read the current branch before removing. */
  readBranch: boolean
}

/**
 * Decide how to run `git worktree remove` for a worktree whose directory may
 * already be gone from disk (BUG-38 — folded into BUG-56). When the directory
 * doesn't exist, there is nothing left to probe: `git status --porcelain`
 * against a missing path fails hard (unlike its siblings, the pre-flight
 * dirty check has no try/catch — see `isWorktreeDirty`), and `git worktree
 * remove` itself refuses a missing working tree without `--force`. So a gone
 * directory always short-circuits straight to a forced removal, regardless of
 * what the caller passed for `force` — there is no data left to lose by
 * skipping the guard.
 */
export function resolveWorktreeRemovalPlan(input: {
  dirExists: boolean
  force: boolean
}): WorktreeRemovalPlan {
  const effectiveForce = input.force || !input.dirExists
  return {
    runPreflight: !effectiveForce,
    effectiveForce,
    readBranch: input.dirExists
  }
}
