// Pure worktree bundle builder and bucket rules (design: workspace-gc §3–§4).
// A bundle joins one Reaper worktree item with the Docker stacks that run from it and the
// session that works in it, then puts it in exactly one bucket. No I/O — every decision is
// unit-tested in tests/gc-bundle-core.test.ts.

import { posix, win32 } from 'node:path'
import { resolveDetachedFate, resolveFate, type FateResult } from './fate-core'
import type { BranchFacts, ReapItem } from '../reaper/reaper-core'
import {
  COMPOSE_PROJECT_LABEL,
  COMPOSE_WORKING_DIR_LABEL,
  isInside,
  lastContainerEvent,
  normalizePath,
  type InspectedContainer,
  type StackGroup,
  type VolumeFact
} from '../containers/containers-core'

const DAY_MS = 86_400_000

/**
 * The one form every GC path comparison uses: lexically resolved, so `REPO/.` and
 * `…/worktrees/../www` are `REPO` itself; forward slashes; no trailing slash; case-folded on
 * darwin and win32, whose default filesystems ignore case. Pure: it never touches the disk,
 * so a symlink is resolved by the caller first. An empty path stays empty instead of
 * resolving to the working directory.
 */
export function canonicalPathKey(p: string, platform: string): string {
  if (!p) return ''
  const win = platform === 'win32'
  let out = win ? win32.resolve(p).replace(/\\/g, '/') : posix.resolve(p)
  if (out.length > 1 && out.endsWith('/') && !/^[a-z]:\/$/i.test(out)) out = out.slice(0, -1)
  return win || platform === 'darwin' ? out.toLowerCase() : out
}

/**
 * A path's real location, as the shell read it from disk (symlinks resolved). `resolved` is
 * false when it could not be read; `path` is then the spelling as given, which may be an
 * alias of anything, so whatever it touches can never be proven ready.
 */
export type CanonicalPath = (p: string) => { path: string; resolved: boolean }

/** No resolver: every path is taken as its own real path. Only for pure callers and tests. */
export const AS_GIVEN: CanonicalPath = (p) => ({ path: p, resolved: true })

/** The comparison key of a path's real location. */
const realKey = (p: string, platform: string, canonical: CanonicalPath): string =>
  canonicalPathKey(canonical(p).path, platform)

/** True when one path lies inside the other (either way). Empty keys relate to nothing. */
export const relatesTo = (a: string, b: string): boolean =>
  a !== '' && b !== '' && (isInside(a, b) || isInside(b, a))
export type SessionPresence = 'working' | 'needs-input' | 'open-idle' | 'none'
export type Bucket = 'ready' | 'review' | 'in-use'
export type ReviewCode =
  | 'dirty'
  | 'unpushed'
  | 'open-idle-session'
  | 'closed-unmerged'
  | 'remote-gone'
  | 'detached'
  | 'unknown-fate'
  | 'weak-merge-signal'
  | 'shared-stack'
  | 'cleanup-failed'
  | 'path-unresolved'
  | 'nested-worktree'
  | 'check-failed'
  | 'locked'

/** `detail` is one English sentence with the concrete fact; the renderer translates by `code`. */
export interface ReviewReason {
  code: ReviewCode
  detail: string
}

export interface BundleFacts {
  item: ReapItem
  fate: FateResult
  session: SessionPresence
  lastSignOfLifeAt: number | null
  /** Stacks attributed ONLY to this worktree. */
  stackIds: string[]
  /** Stacks that also run from somewhere outside this worktree. */
  sharedStackIds: string[]
  ownedVolumes: string[]
  depsBytes: number | null
  keep: boolean
  neverClean: boolean
  isMainCheckout: boolean
  /**
   * The local tip the fate was judged on (the checked-out commit for a detached worktree).
   * The reprobe refuses if HEAD moved since, because a strong merge proof covers only this
   * commit. Null or absent when unknown, and then the reprobe refuses (`tip-unknown`).
   */
  localTip?: string | null
  /**
   * The grace window (in days) the bundle was bucketed with. The reprobe re-checks it at
   * execution time, so a bundle without it is never cleaned.
   */
  graceDays?: number
  /**
   * Every path the bundle was judged on resolved to its real location: its own path, its
   * repo path, and every container and open (not history-only) session folder inside it or
   * above it. An unresolved one may be an alias of anything, so false, or absent, is never
   * ready.
   */
  pathsResolved: boolean
  /**
   * Real paths of the other known worktrees (other bundles and `knownFolders`) that lie
   * strictly inside this one. Trashing this folder would take theirs with it, uncommitted
   * work included, so any entry, or a list that is absent, is never ready (delta 6, F1).
   */
  nestedWorktrees: string[]
  /**
   * Every `.git` entry the shell's walk found inside this worktree besides its own (delta 7):
   * a worktree of another repo or a plain clone, which no known path shows. Any entry, or a
   * list that is absent (the scan did not walk it), is never ready.
   */
  foreignCheckouts: string[]
  /**
   * Git lists this worktree as locked (delta 6): it cannot be unregistered, so it is never
   * ready. Optional, and absent means unlocked: the reprobe asks git again before any step.
   */
  locked?: boolean
}

export interface WorktreeBundle extends BundleFacts {
  bucket: Bucket
  reason: ReviewReason | null
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/**
 * The project name Compose gives a folder when none is set: its basename, lowercased, with
 * every character outside [a-z0-9_-] dropped and the leading `_` and `-` trimmed, as
 * compose-go's NormalizeProjectName does (so `_www` runs as `www`). The S4 housekeeping
 * module has its own copy, which is not reachable from this branch, hence this duplicate.
 */
export function composeDefaultProject(path: string): string {
  const base =
    path
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() ?? ''
  return base
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .replace(/^[_-]+/, '')
}

/**
 * Named volumes only the bundle's stacks use. A volume that a container outside the bundle
 * also mounts is never listed: removing it would pull data from under a stack we do not own.
 * Bind mounts have no volume name, so they never qualify.
 *
 * Fail closed on the volume's own compose project label: it must be present and equal the
 * project of every bundle stack mounting it. An unlabelled volume, or one with no fact at
 * all, may be anyone's (an `external` volume, a `docker volume create`), so it is never
 * owned; one labelled with another project belongs to that project, even while its
 * containers are down.
 *
 * That project must also be unique to the bundle. It is not when it is in
 * `protectedProjects`, when a container outside the bundle (running or stopped) carries it,
 * or when it is the Compose default name of one of `otherFolders`: a main checkout that
 * shares the project and ran `compose down` has no container left, yet the volume is still
 * its data.
 */
export function ownedVolumes(
  bundleStacks: readonly StackGroup[],
  allContainers: readonly InspectedContainer[],
  volumes: ReadonlyMap<string, VolumeFact>,
  otherFolders: readonly string[] = [],
  protectedProjects: ReadonlySet<string> = new Set()
): string[] {
  const inBundle = new Set<string>()
  const projectOf = new Map<string, string>()
  const rejected = new Set<string>()
  for (const s of bundleStacks) {
    for (const c of s.containers) {
      inBundle.add(c.id)
      for (const m of c.mounts) {
        if (m.type !== 'volume' || !m.name) continue
        const project = volumes.get(m.name)?.project
        if (project == null || project !== s.project) rejected.add(m.name)
        else projectOf.set(m.name, project)
      }
    }
  }
  const foreignProjects = new Set(protectedProjects)
  for (const folder of otherFolders) {
    const project = composeDefaultProject(folder)
    if (project) foreignProjects.add(project)
  }
  for (const c of allContainers) {
    if (inBundle.has(c.id)) continue
    for (const m of c.mounts) if (m.name) rejected.add(m.name)
    const project = c.labels[COMPOSE_PROJECT_LABEL]
    if (project) foreignProjects.add(project)
  }
  return [...projectOf]
    .filter(([name, project]) => !rejected.has(name) && !foreignProjects.has(project))
    .map(([name]) => name)
    .sort()
}

const FATE_REVIEWS: Record<
  Exclude<FateResult['fate'], 'merged' | 'open'>,
  { code: ReviewCode; detail: string }
> = {
  'closed-unmerged': {
    code: 'closed-unmerged',
    detail: 'The pull request was closed without being merged.'
  },
  'remote-gone': {
    code: 'remote-gone',
    detail: 'The remote branch is gone and no pull request records a merge.'
  },
  detached: {
    code: 'detached',
    detail: 'This worktree has a detached HEAD, so there is no branch to judge.'
  },
  unknown: {
    code: 'unknown-fate',
    detail: 'The state of the branch could not be determined (GitHub or the remote did not answer).'
  }
}

/**
 * First matching rule wins (master plan rules 1–11). Anything that could be someone's live
 * work is `in-use`; anything uncertain is `review`; only a strongly merged, clean, idle
 * worktree past its grace window is `ready`.
 */
export function bucketOf(
  f: BundleFacts,
  now: number,
  graceDays: number
): { bucket: Bucket; reason: ReviewReason | null } {
  const inUse = { bucket: 'in-use' as const, reason: null }
  const review = (code: ReviewCode, detail: string): { bucket: Bucket; reason: ReviewReason } => ({
    bucket: 'review',
    reason: { code, detail }
  })

  if (f.isMainCheckout || f.neverClean) return inUse
  if (f.session === 'working' || f.session === 'needs-input') return inUse
  if (f.fate.fate === 'open') return inUse
  // No sign of life at all is "unknown age", which must not read as "old enough". Neither
  // is a NaN, infinite or negative input: each would make the comparison below false.
  const known = (n: number | null): n is number => Number.isFinite(n) && (n as number) >= 0
  if (!known(f.lastSignOfLifeAt) || !known(graceDays) || !known(now)) return inUse
  if (now - f.lastSignOfLifeAt < graceDays * DAY_MS) return inUse
  if (f.keep) return inUse

  if (f.session === 'open-idle')
    return review('open-idle-session', 'A session is still open in this worktree, though idle.')
  // Only a session read as exactly `none` can be ready; anything else is not proven idle.
  if (f.session !== 'none')
    return review('open-idle-session', 'The session state of this worktree is unknown.')

  if (f.sharedStackIds.length > 0) {
    const n = f.sharedStackIds.length
    return review(
      'shared-stack',
      `${plural(n, 'other stack')} also ${n === 1 ? 'uses' : 'use'} this worktree: ${f.sharedStackIds.join(', ')}.`
    )
  }

  // A worktree nested inside this one (Claude Code's worktree command run from inside a
  // linked worktree puts it at `.claude/worktrees/*`) would be trashed with it, and its git
  // status shows only `?? .claude/`, so the parent reads clean (delta 6, F1). A list that
  // is missing or not a list cannot show there is none: that is a probe that did not answer
  // (`check-failed`), a different fact from one that found something inside.
  const where = f.item.path ?? f.item.repoPath
  const unchecked = (): { bucket: Bucket; reason: ReviewReason } =>
    review(
      'check-failed',
      `Harnu could not look inside ${where} for other worktrees or checkouts, so it cannot tell whether removing it would take one along.`
    )
  if (!Array.isArray(f.nestedWorktrees)) return unchecked()
  if (f.nestedWorktrees.length > 0) {
    const n = f.nestedWorktrees.length
    return review(
      'nested-worktree',
      `${plural(n, 'other worktree')} ${n === 1 ? 'lives' : 'live'} inside this one: ${f.nestedWorktrees.join(', ')}.`
    )
  }

  // A worktree of another repo or a plain clone inside this one (delta 7) goes with it too.
  if (!Array.isArray(f.foreignCheckouts)) return unchecked()
  if (f.foreignCheckouts.length > 0) {
    const n = f.foreignCheckouts.length
    return review(
      'nested-worktree',
      `${plural(n, 'other checkout')} ${n === 1 ? 'lives' : 'live'} inside this one: ${f.foreignCheckouts.join(', ')}.`
    )
  }

  if (f.locked === true) return review('locked', 'This worktree is locked in git.')

  if (f.pathsResolved !== true)
    return review(
      'path-unresolved',
      'A path tied to this worktree could not be resolved to its real location, so what uses it is unknown.'
    )

  if (f.fate.fate !== 'merged') {
    const d = FATE_REVIEWS[f.fate.fate]
    return review(d.code, d.detail)
  }

  if (!f.fate.strong)
    return review(
      'weak-merge-signal',
      f.fate.signal === 'gh-merged'
        ? 'Merged by gh-merged, but the local tip differs from the PR head.'
        : `Merged only by the inferred signal ${f.fate.signal ?? 'unknown'}.`
    )

  const blockers = f.item.blockers
  if (blockers.includes('dirty') || blockers.includes('unpushed')) {
    const hit = ['dirty', 'unpushed'].filter((b) => blockers.includes(b))
    const detail = `${plural(hit.length, 'blocker')}: ${hit.join(', ')}.`
    return review(hit[0] === 'dirty' ? 'dirty' : 'unpushed', detail)
  }
  // No blocker is not proof of clean: a status probe that failed leaves no blocker either.
  // Only a green local-clean checkpoint shows the tracked files were read and clean.
  if (f.item.checkpoints.find((c) => c.id === 'local-clean')?.state !== 'green')
    return review('dirty', 'The working tree could not be verified clean.')

  return { bucket: 'ready', reason: null }
}

export interface BuildBundlesInput {
  items: ReapItem[]
  /** Facts and the real local tip per item id. Missing entry → fate `unknown` (fail closed). */
  fateInputs: Map<string, { facts: BranchFacts; localTip: string | null }>
  stacks: StackGroup[]
  /** Path the shell attributed a stack to, by stack id. */
  stackPaths: Map<string, string>
  containers: InspectedContainer[]
  sessions: Map<string, { presence: SessionPresence; lastActivityAt: number | null }>
  keep: Set<string>
  neverClean: Set<string>
  now: number
  graceDays: number
  /** Containers Harnu itself stopped; their stop is not a sign of life. */
  harnuStoppedAt?: ReadonlyMap<string, number>
  /**
   * Volume facts from `docker system df -v`. Required: a volume is owned only when its fact
   * carries the project label of the stack mounting it, so no map would mean none is owned.
   */
  volumes: ReadonlyMap<string, VolumeFact>
  /**
   * Folders Harnu knows besides the items' own paths and repo paths (sidebar folders, say).
   * A volume whose project is the Compose default name of any of them is never owned.
   */
  knownFolders: string[]
  /**
   * Compose project names no bundle may own a volume of: explicit `COMPOSE_PROJECT_NAME` or
   * `name:` values, and the default name of every other existing known folder.
   */
  protectedProjects: Set<string>
  /**
   * Bundle id → when an agent released it. A release lifts the grace window and nothing else,
   * and only for a strongly merged fate; every other bucket rule still decides.
   */
  released?: ReadonlyMap<string, number>
  /**
   * The tip each release was made at. A release applies only when this matches the bundle's
   * current tip; a mark with no entry here (a legacy one) never applies.
   */
  releasedTips?: ReadonlyMap<string, string>
  /**
   * Each path's real location, read by the caller (the shell realpaths them; this module
   * never touches the disk). Every path below is compared through it: item and repo paths,
   * container working dirs and bind sources, session folders, stackPaths, neverClean and
   * known folders. Required, so no caller can skip it and compare aliases by spelling.
   */
  canonical: CanonicalPath
  /**
   * The `.git` entries the shell's foreign-checkout walk found inside each worktree, by item
   * id (delta 7). Required: a worktree with no entry was not walked, so it is never ready.
   */
  foreignCheckouts: ReadonlyMap<string, string[]>
  /** Ids of the items git lists as locked (delta 6); absent means none. See {@link lockedItemIds}. */
  locked?: ReadonlySet<string>
}

/** Merge time from the `pr-merged` checkpoint detail; anything that is not a date is ignored. */
function mergedAtOf(item: ReapItem): number | null {
  const detail = item.checkpoints.find((c) => c.id === 'pr-merged')?.detail
  if (!detail) return null
  const t = Date.parse(detail)
  return Number.isFinite(t) ? t : null
}

/** The folders one container touches, as docker spells them (see {@link containerFolders}). */
export function containerFolderPaths(c: InspectedContainer): string[] {
  const out: string[] = []
  const dir = c.labels[COMPOSE_WORKING_DIR_LABEL]
  if (dir) out.push(dir)
  for (const m of c.mounts) if (m.type === 'bind' && m.source) out.push(m.source)
  return out
}

/**
 * Every folder one container touches: its compose working dir AND the source of each bind
 * mount. A stack run from elsewhere that bind-mounts a worktree still uses it, so trashing
 * the folder would pull files from under a running container. The builder and the
 * execution-time reprobe both call this, so a stack the scan attributed to a worktree is
 * seen by the reprobe through the same rule. Empty means nothing ties it to a folder.
 * Each folder is keyed on its real path, so a symlinked working dir counts where it lands.
 */
export function containerFolders(
  c: InspectedContainer,
  platform: string,
  canonical: CanonicalPath = AS_GIVEN
): string[] {
  return [...new Set(containerFolderPaths(c).map((p) => realKey(p, platform, canonical)))]
}

/**
 * Every folder a stack runs from: each container's folders plus the path the shell
 * attributed it to. `groupStacks` merges by compose project NAME, so two worktrees with
 * the same project name arrive as one stack with several working dirs.
 */
function stackFolders(
  stack: StackGroup,
  stackPaths: Map<string, string>,
  platform: string,
  canonical: CanonicalPath
): string[] {
  const out = new Set<string>()
  for (const c of stack.containers) {
    for (const d of containerFolders(c, platform, canonical)) out.add(d)
  }
  const attributed = stackPaths.get(stack.id)
  if (attributed) out.add(realKey(attributed, platform, canonical))
  return [...out]
}

const PRESENCE_RANK: Record<SessionPresence, number> = {
  none: 0,
  'open-idle': 1,
  'needs-input': 2,
  working: 2
}

type SessionEntry = BuildBundlesInput['sessions'] extends Map<string, infer V> ? V : never

/**
 * Every session that works in the worktree or in any folder under it: a session started in
 * `WT/api` is as alive as one in `WT`. The strongest presence wins and the latest activity
 * is kept. Containment is by path segment, so a sibling `WT-other` never counts.
 */
function sessionOf(
  sessions: BuildBundlesInput['sessions'],
  path: string,
  platform: string,
  canonical: CanonicalPath
): SessionEntry | undefined {
  let out: SessionEntry | undefined
  for (const [folder, s] of sessions) {
    if (!folder || !isInside(realKey(folder, platform, canonical), path)) continue
    const activity = [out?.lastActivityAt ?? null, s.lastActivityAt].filter(
      (t): t is number => t !== null
    )
    out = {
      presence:
        out && PRESENCE_RANK[out.presence] >= PRESENCE_RANK[s.presence] ? out.presence : s.presence,
      lastActivityAt: activity.length > 0 ? Math.max(...activity) : null
    }
  }
  return out
}

export function buildBundles(input: BuildBundlesInput): WorktreeBundle[] {
  const platform = process.platform
  const canonical = input.canonical
  const real = (p: string): string => realKey(p, platform, canonical)
  const stoppedByHarnu = input.harnuStoppedAt ?? new Map<string, number>()

  const folders = input.items
    .filter((i) => (i.kind === 'worktree' || i.kind === 'detached-worktree') && i.path)
    .map((item) => ({ item, path: real(item.path as string) }))

  // Every container, session and known worktree folder that did not resolve, keyed on its
  // spelling. Such a folder may be an alias of any worktree, so one inside a bundle or above
  // it (where it may see the bundle) keeps that bundle from being proven ready. A
  // history-only session (`none`) is exempt (delta 5, 2026-10-08): nothing runs there, so
  // its folder, often a deleted subfolder, cannot hide anything that uses the worktree.
  const openSessionFolders = [...input.sessions]
    .filter(([, s]) => s.presence !== 'none')
    .map(([folder]) => folder)
  const unresolved = [
    ...new Set([
      ...[...input.containers, ...input.stacks.flatMap((s) => s.containers)].flatMap(
        containerFolderPaths
      ),
      ...openSessionFolders,
      ...input.stackPaths.values(),
      // Every known worktree path too (delta 6, F1): one that cannot be resolved may be an
      // alias of a worktree nested inside this one, which the nested rule then cannot see.
      ...folders.map((f) => f.item.path as string),
      ...input.knownFolders
    ])
  ]
    .filter((p) => p && !canonical(p).resolved)
    .map((p) => canonicalPathKey(p, platform))

  // A stack is attributed to a bundle only through a folder at or inside it. A stack whose
  // folders are all above the bundle, or elsewhere, is not this bundle's at all
  // (orchestrator ruling, delta 5, 2026-10-08): Sail and most dev stacks bind-mount REPO,
  // so with worktrees nested at REPO/.claude/worktrees/* counting those made every one of
  // them non-ready, and a container that can merely see a proven-ready nested worktree
  // does not depend on it. Unresolved folders above it still block it below.
  // Once attributed, a stack is exclusive only if EVERY folder it runs from is inside the
  // bundle. One that also runs from above it or elsewhere (the main checkout's own stack
  // bind-mounting a folder of a nested worktree), or that two bundles both claim outright
  // (nested paths), is shared, and nobody may remove it (ruling on delta 5 concern 1).
  const exclusive = new Map<string, StackGroup[]>()
  const shared = new Map<string, string[]>()
  for (const stack of input.stacks) {
    const dirs = stackFolders(stack, input.stackPaths, platform, canonical)
    if (dirs.length === 0) continue
    const full: string[] = []
    const partial: string[] = []
    for (const f of folders) {
      const inside = dirs.filter((d) => isInside(d, f.path)).length
      if (inside === 0) continue
      if (inside === dirs.length) full.push(f.item.id)
      else partial.push(f.item.id)
    }
    if (full.length === 1 && partial.length === 0) {
      exclusive.set(full[0]!, [...(exclusive.get(full[0]!) ?? []), stack])
    } else {
      for (const id of [...full, ...partial]) shared.set(id, [...(shared.get(id) ?? []), stack.id])
    }
  }

  const neverClean = new Set([...input.neverClean].map(real))

  // Every known worktree path a bundle could contain: each bundle's own path and every known
  // folder, on real paths (delta 6, F1). One that did not resolve is left to the
  // path-unresolved rule instead, since its spelling says nothing about where it lives.
  const knownWorktrees = [
    ...new Set(
      [...folders.map((f) => f.item.path as string), ...input.knownFolders]
        .filter((p) => p && canonical(p).resolved)
        .map(real)
    )
  ]

  // Every folder that could share a compose project with a bundle: each item's checkout and
  // its repo's main checkout, plus whatever else the caller knows about.
  const knownFolders = new Set(
    [
      ...input.items.flatMap((i) => (i.path ? [i.path, i.repoPath] : [i.repoPath])),
      ...input.knownFolders
    ].map(real)
  )

  return folders.map(({ item, path }) => {
    const fateInput = input.fateInputs.get(item.id)
    const fate: FateResult =
      item.kind === 'detached-worktree'
        ? resolveDetachedFate()
        : fateInput
          ? resolveFate(fateInput.facts, fateInput.localTip)
          : { fate: 'unknown', signal: null, strong: false }

    const stacks = exclusive.get(item.id) ?? []
    // Segment containment, so a sibling `WT-other` is not nested, and strictly inside, so
    // the bundle's own path (however it was spelled) is not either.
    const nestedWorktrees = knownWorktrees
      .filter((k) => k !== '' && k !== path && isInside(k, path))
      .sort()
    // On real paths, so a trailing slash, a `..` or a symlink must not hide a session, and a
    // session in a subfolder counts too.
    const session = sessionOf(input.sessions, path, platform, canonical)
    const events = lastContainerEvent(
      stacks.flatMap((s) => s.containers),
      stoppedByHarnu
    )
    const signs = [mergedAtOf(item), session?.lastActivityAt ?? null, events].filter(
      (t): t is number => t !== null
    )
    // A release is an agent saying it is done with the worktree: the grace no longer applies,
    // and with no other sign of life the release time stands in for one. The facts record the
    // grace actually used, so the execution-time reprobe agrees with the bucket.
    // It applies only to a strongly merged fate: any weaker proof keeps the normal window.
    const mark = input.released?.get(item.id)
    const markTip = input.releasedTips?.get(item.id)
    const tip =
      item.kind === 'detached-worktree' ? (item.headSha ?? null) : (fateInput?.localTip ?? null)
    const releasedAt =
      mark !== undefined &&
      fate.fate === 'merged' &&
      fate.strong &&
      typeof markTip === 'string' &&
      tip === markTip
        ? mark
        : undefined
    const graceDays = releasedAt !== undefined ? 0 : input.graceDays

    const facts: BundleFacts = {
      item,
      fate,
      session: session?.presence ?? 'none',
      lastSignOfLifeAt: signs.length > 0 ? Math.max(...signs) : (releasedAt ?? null),
      stackIds: stacks.map((s) => s.id),
      sharedStackIds: shared.get(item.id) ?? [],
      ownedVolumes: ownedVolumes(
        stacks,
        input.containers,
        input.volumes,
        [...knownFolders].filter((f) => f !== path),
        input.protectedProjects
      ),
      depsBytes: item.hydration?.reclaimableBytes ?? null,
      keep: input.keep.has(item.id),
      neverClean: neverClean.has(path) || neverClean.has(real(item.repoPath)),
      isMainCheckout: path === real(item.repoPath),
      localTip:
        item.kind === 'detached-worktree' ? (item.headSha ?? null) : (fateInput?.localTip ?? null),
      graceDays,
      pathsResolved:
        canonical(item.path as string).resolved &&
        canonical(item.repoPath).resolved &&
        !unresolved.some(
          (u) => relatesTo(u, path) || relatesTo(u, canonicalPathKey(item.path as string, platform))
        ),
      nestedWorktrees,
      // Passed through as given: a missing or malformed entry stays so, and bucketOf and
      // refusalOf both fail closed on it.
      foreignCheckouts: input.foreignCheckouts.get(item.id) as string[],
      ...(input.locked?.has(item.id) ? { locked: true } : {})
    }
    return { ...facts, ...bucketOf(facts, input.now, graceDays) }
  })
}

/**
 * What a gather learned about worktrees that may have been cleaned. Built by the shell, which
 * owns the Reaper snapshot and the disk; this module only decides.
 */
export interface ReleaseGone {
  /** Repos the Reaper snapshot covered. Empty when there was no snapshot. */
  scannedRepos: ReadonlySet<string>
  /** Where each released worktree was, as recorded when it was released. */
  from: Readonly<Record<string, { repoPath: string; path: string; localTip?: string }>>
  /** Recorded folders confirmed absent from disk (a missing file, not an unreadable one). */
  missingPaths: ReadonlySet<string>
}

/**
 * Release marks to drop after a gather. A mark goes in two cases only:
 *  1. its bundle IS in this gather and its fate is no longer merged and strong, or (given the
 *     gather's context) its tip is no longer the tip it was released at (a reopened or
 *     extended branch must not come back pre-released);
 *  2. its bundle is absent, its repo WAS scanned, and the folder it recorded is gone from disk
 *     (it was cleaned).
 * Absence alone proves nothing: the gather at app start runs before the Reaper's first scan and
 * builds no bundles, and a repo that dropped out of a scan builds none of its own. A mark that
 * recorded no folder can never be shown cleaned, so it stays.
 */
export function staleReleases(
  bundles: ReadonlyArray<Pick<WorktreeBundle, 'item' | 'fate' | 'localTip'>>,
  released: Readonly<Record<string, number>>,
  gone?: ReleaseGone
): string[] {
  const present = new Map(bundles.map((b) => [b.item.id, b]))
  const platform = process.platform
  const norm = (p: string): string => normalizePath(p, platform)
  const scanned = new Set([...(gone?.scannedRepos ?? [])].map(norm))
  const missing = new Set([...(gone?.missingPaths ?? [])].map(norm))
  return Object.keys(released).filter((id) => {
    const b = present.get(id)
    if (b !== undefined) {
      if (!(b.fate.fate === 'merged' && b.fate.strong)) return true
      // With the gather's context a mark must still match the tip it was made at. A mark that
      // recorded none is dropped too: it would never apply, so it is only clutter.
      return gone !== undefined && gone.from[id]?.localTip !== (b.localTip ?? undefined)
    }
    const from = gone?.from[id]
    return from !== undefined && scanned.has(norm(from.repoPath)) && missing.has(norm(from.path))
  })
}
