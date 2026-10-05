// Pure core for Cleanup's dehydrate / rehydrate (T250,
// `docs/specs/2026-08-28-reaper-dehydrate-worktrees.md`).
//
// Dehydration removes regenerable dependency directories from an idle worktree
// and keeps everything else — the checkout, the branch, every uncommitted edit.
// It is the only Cleanup action a `blocked` row can take, because a gitignored
// dependency directory is not work.
//
// The whole feature is the four guards in `planDehydrate`. A path is removable
// only when ALL of them hold, and any uncertainty skips the path and says why:
//
//   1. it is listed in the manifest's `ephemeral:` (or the default list);
//   2. `git check-ignore` confirms the repo ignores it;
//   3. `git ls-files -- <path>` is empty — independent of the ignore rules;
//   4. no live session is in the worktree — re-probed at execution time.
//
// No I/O here (ADR-0001): the git, fs and manifest reads arrive as facts or as
// injected deps, so every decision is table-testable (`tests/reaper-dehydrate-core.test.ts`).

import * as path from 'node:path'
import {
  classifyManifestFailure,
  type ManifestFailureKind,
  type WorktreeProvisionStep
} from '../worktree-manifest'
import type { DehydrateSkip, HydrationInfo, ReapItem, ReapItemKind } from './reaper-core'

/** The only kinds that carry a checkout to dehydrate (design.md "Hydration × kind"). */
export function isHydratableKind(kind: ReapItemKind): boolean {
  return kind === 'worktree' || kind === 'detached-worktree'
}

// ---- entry validation --------------------------------------------------------

const GLOB_CHARS = /[*?[\]{}]/

/**
 * Normalize one `ephemeral:` entry to a plain worktree-relative POSIX path, or
 * null when it is unsafe to act on: absolute, escaping (`..`), naming `.git`,
 * carrying a glob or a backslash, or empty. The manifest is trusted committed
 * content, but this list feeds a recursive removal — a hand-typed `..` must
 * never reach `fs.rm`.
 */
export function normalizeEphemeralEntry(raw: string): string | null {
  const trimmed = raw.trim().replace(/\/+$/, '')
  if (trimmed === '' || trimmed === '.') return null
  if (trimmed.includes('\\') || GLOB_CHARS.test(trimmed)) return null
  if (trimmed.startsWith('/') || /^[A-Za-z]:/.test(trimmed)) return null
  const segments = trimmed.split('/')
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return null
  if (segments[0] === '.git') return null
  return segments.join('/')
}

// ---- guards -----------------------------------------------------------------

/** What `lstat` found at an entry's path; `unreadable` = lstat failed with anything but ENOENT. */
export type EntryPresence = 'absent' | 'dir' | 'symlink' | 'other' | 'unreadable'

/** The probed facts about one entry, gathered by the shell. */
export interface EphemeralEntryFacts {
  /** Normalized worktree-relative path. */
  path: string
  presence: EntryPresence
  /** Whether the entry's real parent resolves inside the worktree (no symlinked-parent escape). */
  contained: boolean
  /** `git check-ignore` verdict; null when the probe failed or did not run. */
  ignored: boolean | null
  /** Whether `git ls-files` listed anything under it; null when the probe failed or did not run. */
  tracked: boolean | null
}

export interface DehydratePlanInput {
  sessionLive: boolean
  /** The manifest's `ephemeral:` list, verbatim (validated here). */
  ephemeral: readonly string[]
  entries: readonly EphemeralEntryFacts[]
}

export interface DehydratePlan {
  removable: string[]
  skipped: DehydrateSkip[]
}

/**
 * The removable-or-skip decision. Guard 1 is structural: only listed entries are
 * iterated, so a directory missing from `ephemeral` can never be removable no
 * matter what facts arrive about it. An absent entry is neither — there is
 * nothing to remove and nothing to explain.
 *
 * Guard 4 is expressed here, not left to the renderer. `stores/reaper.ts`
 * filters `active` rows out of the list, so in the UI a live worktree simply has
 * no button — correct by accident, and not something a test can demonstrate.
 */
export function planDehydrate(input: DehydratePlanInput): DehydratePlan {
  const byPath = new Map(input.entries.map((e) => [e.path, e]))
  const removable: string[] = []
  const skipped: DehydrateSkip[] = []
  const seen = new Set<string>()

  for (const raw of input.ephemeral) {
    const rel = normalizeEphemeralEntry(raw)
    if (rel === null) {
      skipped.push({ path: raw, reason: 'unsafe-path' })
      continue
    }
    if (seen.has(rel)) continue
    seen.add(rel)

    const facts = byPath.get(rel)
    if (!facts || facts.presence === 'absent') continue
    if (input.sessionLive) {
      skipped.push({ path: rel, reason: 'session-live' })
      continue
    }
    if (facts.presence === 'symlink') {
      skipped.push({ path: rel, reason: 'symlink' })
      continue
    }
    if (facts.presence === 'other') {
      skipped.push({ path: rel, reason: 'not-directory' })
      continue
    }
    if (facts.presence === 'unreadable') {
      skipped.push({ path: rel, reason: 'probe-failed' })
      continue
    }
    if (!facts.contained) {
      skipped.push({ path: rel, reason: 'unsafe-path' })
      continue
    }
    // Tracked outranks not-ignored: a committed `vendor/` is usually both, and
    // "tracked by git" is the reason that explains it.
    if (facts.tracked === true) {
      skipped.push({ path: rel, reason: 'tracked' })
      continue
    }
    if (facts.ignored === false) {
      skipped.push({ path: rel, reason: 'not-ignored' })
      continue
    }
    if (facts.tracked === null || facts.ignored === null) {
      skipped.push({ path: rel, reason: 'probe-failed' })
      continue
    }
    removable.push(rel)
  }

  // An entry nested inside another removable one goes with its ancestor.
  const covered = (p: string): boolean => removable.some((a) => a !== p && p.startsWith(`${a}/`))
  return { removable: removable.filter((p) => !covered(p)), skipped }
}

// ---- persisted hydration records ---------------------------------------------

/**
 * What Harnu did to one worktree, persisted so a row can say "dehydrated" only
 * when Harnu dehydrated it. Deriving the state from "no `node_modules` present"
 * alone would call a never-installed checkout dehydrated and offer to rehydrate
 * something that was never hydrated.
 */
export interface HydrationRecord {
  dehydratedAt: number | null
  /** The paths the last dehydration removed. */
  removed: string[]
  rehydratedAt: number | null
  /** Tracked files the last rehydrate modified. */
  rehydrateChanged: string[]
}

export interface HydrationRecordFile {
  version: 1
  /** Keyed by absolute worktree path. */
  worktrees: Record<string, HydrationRecord>
}

export function emptyHydrationFile(): HydrationRecordFile {
  return { version: 1, worktrees: {} }
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []
}

function numberOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** Tolerates junk; a record that carries nothing is dropped. */
export function normalizeHydrationFile(raw: unknown): HydrationRecordFile {
  const out = emptyHydrationFile()
  if (!raw || typeof raw !== 'object') return out
  const worktrees = (raw as { worktrees?: unknown }).worktrees
  if (!worktrees || typeof worktrees !== 'object' || Array.isArray(worktrees)) return out
  for (const [key, value] of Object.entries(worktrees as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue
    const r = value as Record<string, unknown>
    const record: HydrationRecord = {
      dehydratedAt: numberOrNull(r.dehydratedAt),
      removed: stringList(r.removed),
      rehydratedAt: numberOrNull(r.rehydratedAt),
      rehydrateChanged: stringList(r.rehydrateChanged)
    }
    if (!isEmptyRecord(record)) out.worktrees[key] = record
  }
  return out
}

function isEmptyRecord(r: HydrationRecord): boolean {
  return r.dehydratedAt === null && r.rehydrateChanged.length === 0
}

function put(
  file: HydrationRecordFile,
  worktreePath: string,
  record: HydrationRecord
): HydrationRecordFile {
  const worktrees = { ...file.worktrees }
  if (isEmptyRecord(record)) delete worktrees[worktreePath]
  else worktrees[worktreePath] = record
  return { version: 1, worktrees }
}

function blankRecord(): HydrationRecord {
  return { dehydratedAt: null, removed: [], rehydratedAt: null, rehydrateChanged: [] }
}

/** Records a dehydration. A second dehydrate while still dehydrated widens the set. */
export function withDehydrated(
  file: HydrationRecordFile,
  worktreePath: string,
  removed: string[],
  at: number
): HydrationRecordFile {
  const prev = file.worktrees[worktreePath] ?? blankRecord()
  const carried = prev.dehydratedAt !== null ? prev.removed : []
  return put(file, worktreePath, {
    dehydratedAt: at,
    removed: [...new Set([...carried, ...removed])],
    rehydratedAt: prev.rehydratedAt,
    // A fresh dehydration makes the last rehydrate's disclosure moot.
    rehydrateChanged: []
  })
}

/**
 * Records a rehydrate. A successful one clears the dehydrated state; a failed
 * one keeps it — the row still owes a rehydrate — but either way the tracked
 * files the install modified are kept, so the row can name them.
 */
export function withRehydrated(
  file: HydrationRecordFile,
  worktreePath: string,
  changed: string[],
  ok: boolean,
  at: number
): HydrationRecordFile {
  const prev = file.worktrees[worktreePath] ?? blankRecord()
  return put(file, worktreePath, {
    dehydratedAt: ok ? null : prev.dehydratedAt,
    removed: ok ? [] : prev.removed,
    rehydratedAt: at,
    rehydrateChanged: [...new Set([...(ok ? [] : prev.rehydrateChanged), ...changed])]
  })
}

/**
 * Scan-time reconciliation: drop the dehydrated state once the removed paths are
 * back (the operator ran their own install), and keep only the rehydrate-changed
 * files that are still modified (committed or reverted ones stop being news).
 */
export function withReconciled(
  file: HydrationRecordFile,
  worktreePath: string,
  opts: { dehydrationStale: boolean; stillChanged: string[] }
): HydrationRecordFile {
  const prev = file.worktrees[worktreePath]
  if (!prev) return file
  return put(file, worktreePath, {
    dehydratedAt: opts.dehydrationStale ? null : prev.dehydratedAt,
    removed: opts.dehydrationStale ? [] : prev.removed,
    rehydratedAt: prev.rehydratedAt,
    rehydrateChanged: opts.stillChanged
  })
}

// ---- derived row state -------------------------------------------------------

export interface DeriveHydrationInput {
  record: HydrationRecord | undefined
  /** Facts for the ephemeral list AND the record's removed paths. */
  entries: readonly EphemeralEntryFacts[]
  plan: DehydratePlan
  canRehydrate: boolean
  /** The record's `rehydrateChanged` files that are still modified right now. */
  stillChanged: string[]
  reclaimableBytes: number | null
}

export interface DerivedHydration {
  info: HydrationInfo
  /** The record says dehydrated but a removed path is back on disk. */
  dehydrationStale: boolean
}

/**
 * `dehydrated` iff Harnu's record says so AND none of the paths it removed are
 * back on disk. A partial failure therefore still reads `dehydrated` (what was
 * removed is gone) and offers Rehydrate, which re-runs the whole install.
 */
export function deriveHydration(input: DeriveHydrationInput): DerivedHydration {
  const present = new Set(input.entries.filter((e) => e.presence !== 'absent').map((e) => e.path))
  const record = input.record
  const recorded = !!record && record.dehydratedAt !== null && record.removed.length > 0
  const back = recorded && record!.removed.some((p) => present.has(p))
  return {
    info: {
      state: recorded && !back ? 'dehydrated' : 'hydrated',
      removable: input.plan.removable,
      skipped: input.plan.skipped,
      reclaimableBytes: input.plan.removable.length > 0 ? input.reclaimableBytes : null,
      canRehydrate: input.canRehydrate,
      rehydrateChanged: input.stillChanged
    },
    dehydrationStale: recorded && back
  }
}

// ---- tracked-set fingerprint ---------------------------------------------------

/**
 * Tracked paths with a working-tree change, from `git status --porcelain -z`,
 * keyed to their two-letter status. Untracked (`??`) and ignored (`!!`) records
 * are dropped; a rename/copy's source field is skipped (see `parsePorcelainStatus`).
 */
export function parseTrackedStatus(stdout: string): Map<string, string> {
  const out = new Map<string, string>()
  const fields = stdout.split('\0')
  for (let i = 0; i < fields.length; i++) {
    const record = fields[i]
    if (record.length < 4) continue
    const xy = record.slice(0, 2)
    const file = record.slice(3)
    if (xy === '??' || xy === '!!') continue
    out.set(file, xy)
    if (xy[0] === 'R' || xy[0] === 'C') i++
  }
  return out
}

/** Path → `status:content-hash` for every tracked path that differs from HEAD. */
export type TrackedFingerprint = Map<string, string>

/** Paths whose tracked state differs between two fingerprints, sorted. */
export function diffFingerprints(before: TrackedFingerprint, after: TrackedFingerprint): string[] {
  const changed = new Set<string>()
  for (const [p, v] of after) if (before.get(p) !== v) changed.add(p)
  for (const p of before.keys()) if (!after.has(p)) changed.add(p)
  return [...changed].sort()
}

// ---- disk measurement ------------------------------------------------------------

/**
 * Parse `du -sb -0 <child…> <root>` — children FIRST. GNU du counts every inode
 * once across all its arguments, so a root listed after its children reports
 * only the remainder: the children's lines are their own sizes and the sum of
 * every line is the whole checkout, from one traversal instead of two.
 */
export function parseDuMulti(
  stdout: string,
  root: string,
  children: readonly string[]
): { total: number | null; byPath: Map<string, number | null> } {
  const seen = new Map<string, number>()
  for (const line of stdout.split('\0')) {
    const tab = line.indexOf('\t')
    if (tab <= 0) continue
    const n = Number.parseInt(line.slice(0, tab), 10)
    if (Number.isFinite(n)) seen.set(line.slice(tab + 1).replace(/\n$/, ''), n)
  }
  const byPath = new Map<string, number | null>()
  for (const c of children) byPath.set(c, seen.get(c) ?? null)
  if (!seen.has(root)) return { total: null, byPath }
  let total = 0
  for (const n of seen.values()) total += n
  return { total, byPath }
}

// ---- dehydrate executor ---------------------------------------------------------

export interface DehydrateResult {
  itemId: string
  ok: boolean
  removed: string[]
  skipped: DehydrateSkip[]
  failed: Array<{ path: string; error: string }>
  /**
   * Tracked paths whose state differs after the removal. Must be empty — the
   * guards only ever reach ignored, untracked directories — and a non-empty
   * list fails the result loudly rather than let it pass as a success.
   */
  trackedChanged: string[]
  /** A refusal or probe failure that stopped the item before any removal. */
  error?: string
}

export interface ManifestFacts {
  ephemeral: string[]
  setup: string[]
}

/**
 * The dehydrate-relevant half of a resolved manifest — fail-closed on a
 * DEGRADED one. `resolveManifest` never throws: a `WORKTREE.md` whose front
 * matter does not parse resolves to the built-in default recipe (`source:
 * 'default'`). For creation that is the right robustness rule; here it would
 * silently WIDEN the removable set back to the default list when the author had
 * narrowed it (say, to keep an expensive `.venv`). A manifest file that exists
 * but did not parse therefore yields nothing removable and no `setup` — the row
 * offers no Dehydrate, and never claims Harnu can rehydrate from rules it could
 * not read.
 */
export function manifestFactsFor(
  manifest: { ephemeral: string[]; setup: string[]; source: string },
  hadManifestFile: boolean
): ManifestFacts {
  if (hadManifestFile && manifest.source === 'default') return { ephemeral: [], setup: [] }
  return { ephemeral: manifest.ephemeral, setup: manifest.setup }
}

export interface DehydrateDeps {
  /** Guard 4, at execution time — the scan that produced the row may be stale. */
  isSessionLive(worktreePath: string): Promise<boolean>
  readManifest(repoPath: string): Promise<ManifestFacts>
  probeEntries(worktreePath: string, entries: readonly string[]): Promise<EphemeralEntryFacts[]>
  trackedFingerprint(worktreePath: string): Promise<TrackedFingerprint>
  /**
   * Permanent recursive removal — NOT the trash. See `removeEphemeralDir` in
   * `dehydrate-shell.ts` for why this is the one step in the engine exempt from
   * `shell.trashItem`.
   */
  removeDir(absPath: string): Promise<void>
  recordDehydrated(worktreePath: string, removed: string[]): Promise<void>
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Dehydrate one item. Every guard is re-established here from fresh probes, not
 * trusted from the scan: a session can start, or a `git add -f vendor` can land,
 * between the scan that drew the row and the click. The repo-level "dehydrate
 * all idle" runs through this same function, so it inherits every re-probe.
 */
export async function dehydrateItem(item: ReapItem, deps: DehydrateDeps): Promise<DehydrateResult> {
  const base = { itemId: item.id, removed: [], skipped: [], failed: [], trackedChanged: [] }
  const refuse = (error: string, skipped: DehydrateSkip[] = []): DehydrateResult => ({
    ...base,
    ok: false,
    skipped,
    error
  })

  if (!isHydratableKind(item.kind) || !item.path) {
    return refuse(`a ${item.kind} has no checkout to dehydrate`)
  }
  const worktree = item.path

  let manifest: ManifestFacts
  try {
    manifest = await deps.readManifest(item.repoPath)
  } catch (err) {
    return refuse(`manifest read failed: ${errorMessage(err)}`)
  }
  const listed = manifest.ephemeral
    .map(normalizeEphemeralEntry)
    .filter((p): p is string => p !== null)

  let entries: EphemeralEntryFacts[]
  let before: TrackedFingerprint
  try {
    entries = await deps.probeEntries(worktree, listed)
    before = await deps.trackedFingerprint(worktree)
  } catch (err) {
    return refuse(`guard re-probe failed: ${errorMessage(err)}`)
  }

  // As late as possible: the last check before anything is removed.
  let sessionLive: boolean
  try {
    sessionLive = item.verdict === 'active' || (await deps.isSessionLive(worktree))
  } catch (err) {
    return refuse(`session re-probe failed: ${errorMessage(err)}`)
  }

  const plan = planDehydrate({ sessionLive, ephemeral: manifest.ephemeral, entries })
  if (plan.removable.length === 0) {
    return refuse(
      sessionLive ? 'a session is live in this worktree' : 'nothing removable',
      plan.skipped
    )
  }

  const removed: string[] = []
  const failed: Array<{ path: string; error: string }> = []
  for (const rel of plan.removable) {
    try {
      await deps.removeDir(path.join(worktree, rel))
      removed.push(rel)
    } catch (err) {
      // A per-path failure (EPERM / long path on Windows, a busy file) is an
      // outcome to report, not an exception to escape: the other paths go on.
      failed.push({ path: rel, error: errorMessage(err) })
    }
  }

  let trackedChanged: string[] = []
  let error: string | undefined
  try {
    trackedChanged = diffFingerprints(before, await deps.trackedFingerprint(worktree))
  } catch (err) {
    error = `could not re-verify the tracked set: ${errorMessage(err)}`
  }

  if (removed.length > 0) {
    try {
      await deps.recordDehydrated(worktree, removed)
    } catch (err) {
      error = `removed, but the hydration record was not written: ${errorMessage(err)}`
    }
  }

  return {
    itemId: item.id,
    ok: failed.length === 0 && trackedChanged.length === 0 && error === undefined,
    removed,
    skipped: plan.skipped,
    failed,
    trackedChanged,
    ...(error !== undefined ? { error } : {})
  }
}

// ---- rehydrate --------------------------------------------------------------------

/** One `setup` step's outcome, already classified (BUG-28 vocabulary). */
export type SetupStepOutcome =
  | { ok: true }
  | { ok: false; kind: ManifestFailureKind; binary?: string; exitCode?: number; stderr?: string }

/**
 * A rehydrate failure in `create_worktree`'s `WORKTREE_PROVISION_FAILED`
 * vocabulary (`stage`, `step`, `command`, `kind`, `binary`, `path`) — reused, not
 * reinvented. `rolledBack` / `branchDeleted` are absent on purpose: they describe
 * undoing a *creation*, and a rehydrate creates no checkout and no branch.
 */
export interface RehydrateFailure {
  error: 'WORKTREE_PROVISION_FAILED'
  message: string
  stage: 'setup'
  step: WorktreeProvisionStep
  command: string
  kind: ManifestFailureKind
  binary?: string
  /** The resolved `PATH` the setup shell used — set only on `binary-missing`. */
  path?: string
  exitCode?: number
  stderr?: string
}

export interface RehydrateResult {
  itemId: string
  ok: boolean
  /**
   * Tracked files whose state the install changed — a rewritten lockfile, most
   * often. Reported even on failure: a step that failed may have written first.
   */
  changedTracked: string[]
  failure?: RehydrateFailure
  /** A refusal (no setup, live session, not a worktree) or probe failure. */
  error?: string
}

export interface RehydrateDeps {
  isSessionLive(worktreePath: string): Promise<boolean>
  readManifest(repoPath: string): Promise<ManifestFacts>
  /** ADR-0005 D3 pre-flight — throws when no POSIX shell can run `setup` (Windows). */
  preflightShell(setup: string[]): Promise<void>
  runSetupStep(command: string, cwd: string): Promise<SetupStepOutcome>
  /** The PATH the setup shell resolves binaries against, for a `binary-missing` report. */
  setupPath(): Promise<string | undefined>
  trackedFingerprint(worktreePath: string): Promise<TrackedFingerprint>
  recordRehydrated(worktreePath: string, changed: string[], ok: boolean): Promise<void>
}

const STDERR_CAP = 4000

/** Human rendering of a {@link RehydrateFailure}, mirroring `formatProvisionError`'s lines. */
export function formatRehydrateFailure(f: Omit<RehydrateFailure, 'message' | 'error'>): string {
  const lines: string[] = []
  const exitSuffix =
    f.kind === 'command-failed' && f.exitCode !== undefined ? ` (exit ${f.exitCode})` : ''
  lines.push(`setup step ${f.step.index} of ${f.step.total} failed: \`${f.command}\`${exitSuffix}`)
  if (f.kind === 'binary-missing') {
    lines.push(`${f.binary}: command not found — Harnu's setup shell could not find it.`)
    if (f.path) lines.push(`PATH used: ${f.path}`)
  } else if (f.kind === 'timeout') {
    lines.push('The command timed out and was killed.')
  } else if (f.stderr) {
    lines.push(f.stderr)
  }
  lines.push(
    'Dependencies may be partly installed. Fix the step in WORKTREE.md and rehydrate again, ' +
      'or run the install yourself.'
  )
  return lines.join('\n')
}

/**
 * Convert whatever running a setup step threw into a classified outcome. A
 * `ManifestCommandFailure` (duck-typed: it carries `classification`) is already
 * classified; an `execFile` rejection is classified here with the same pure
 * `classifyManifestFailure` `create_worktree` uses.
 */
export function toSetupOutcome(err: unknown, command: string): SetupStepOutcome {
  const e = (err ?? {}) as {
    classification?: { kind: ManifestFailureKind; binary?: string; exitCode?: number }
    rawStderr?: string
    code?: number | string | null
    signal?: string | null
    killed?: boolean
    stderr?: string
    message?: string
  }
  const stderr = (e.rawStderr ?? e.stderr ?? e.message ?? '').trim()
  const c =
    e.classification ??
    classifyManifestFailure(
      { code: e.code ?? null, signal: e.signal ?? null, killed: e.killed === true, stderr },
      command
    )
  return {
    ok: false,
    kind: c.kind,
    ...(c.binary ? { binary: c.binary } : {}),
    ...(c.exitCode !== undefined ? { exitCode: c.exitCode } : {}),
    ...(stderr ? { stderr: stderr.slice(0, STDERR_CAP) } : {})
  }
}

/**
 * Rehydrate one item: re-run the manifest's `setup` in the worktree — the same
 * recipe `create_worktree` provisions with — then diff the tracked set, because
 * installs rewrite lockfiles and a clean worktree can come back `blocked` with
 * Harnu as the cause. That diff is reported, never hidden.
 */
export async function rehydrateItem(item: ReapItem, deps: RehydrateDeps): Promise<RehydrateResult> {
  const refuse = (error: string): RehydrateResult => ({
    itemId: item.id,
    ok: false,
    changedTracked: [],
    error
  })
  if (!isHydratableKind(item.kind) || !item.path) {
    return refuse(`a ${item.kind} has no checkout to rehydrate`)
  }
  const worktree = item.path

  let manifest: ManifestFacts
  try {
    manifest = await deps.readManifest(item.repoPath)
  } catch (err) {
    return refuse(`manifest read failed: ${errorMessage(err)}`)
  }
  if (manifest.setup.length === 0) {
    return refuse('WORKTREE.md declares no setup step — Harnu cannot rehydrate this worktree')
  }

  try {
    if (item.verdict === 'active' || (await deps.isSessionLive(worktree))) {
      return refuse('a session is live in this worktree')
    }
    await deps.preflightShell(manifest.setup)
  } catch (err) {
    return refuse(errorMessage(err))
  }

  let before: TrackedFingerprint
  try {
    before = await deps.trackedFingerprint(worktree)
  } catch (err) {
    return refuse(`status probe failed: ${errorMessage(err)}`)
  }

  let failure: RehydrateFailure | undefined
  for (let i = 0; i < manifest.setup.length; i++) {
    const command = manifest.setup[i]
    let outcome: SetupStepOutcome
    try {
      outcome = await deps.runSetupStep(command, worktree)
    } catch (err) {
      outcome = toSetupOutcome(err, command)
    }
    if (outcome.ok) continue
    const fields = {
      stage: 'setup' as const,
      step: { index: i + 1, total: manifest.setup.length },
      command,
      kind: outcome.kind,
      ...(outcome.binary ? { binary: outcome.binary } : {}),
      ...(outcome.kind === 'binary-missing' ? { path: await deps.setupPath() } : {}),
      ...(outcome.exitCode !== undefined ? { exitCode: outcome.exitCode } : {}),
      ...(outcome.stderr ? { stderr: outcome.stderr } : {})
    }
    failure = {
      error: 'WORKTREE_PROVISION_FAILED',
      message: formatRehydrateFailure(fields),
      ...fields
    }
    break
  }

  let changedTracked: string[] = []
  let error: string | undefined
  try {
    changedTracked = diffFingerprints(before, await deps.trackedFingerprint(worktree))
  } catch (err) {
    error = `could not diff the tracked set afterwards: ${errorMessage(err)}`
  }

  try {
    await deps.recordRehydrated(worktree, changedTracked, failure === undefined)
  } catch (err) {
    error ??= `the hydration record was not written: ${errorMessage(err)}`
  }

  return {
    itemId: item.id,
    ok: failure === undefined && error === undefined,
    changedTracked,
    ...(failure ? { failure } : {}),
    ...(error !== undefined ? { error } : {})
  }
}
