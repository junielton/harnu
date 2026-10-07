// Pure worktree bundle builder and bucket rules (design: workspace-gc §3–§4).
// A bundle joins one Reaper worktree item with the Docker stacks that run from it and the
// session that works in it, then puts it in exactly one bucket. No I/O — every decision is
// unit-tested in tests/gc-bundle-core.test.ts.

import { resolveDetachedFate, resolveFate, type FateResult } from './fate-core'
import type { BranchFacts, ReapItem } from '../reaper/reaper-core'
import {
  COMPOSE_WORKING_DIR_LABEL,
  isInside,
  lastContainerEvent,
  normalizePath,
  type InspectedContainer,
  type StackGroup
} from '../containers/containers-core'

const DAY_MS = 86_400_000

export type SessionPresence = 'working' | 'needs-input' | 'open-idle' | 'none'
export type Bucket = 'corpse' | 'decide' | 'alive'
export type DecideCode =
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

/** `detail` is one English sentence with the concrete fact; the renderer translates by `code`. */
export interface DecideReason {
  code: DecideCode
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
   * commit. Null or absent when unknown, and then nothing is re-checked.
   */
  localTip?: string | null
}

export interface WorktreeBundle extends BundleFacts {
  bucket: Bucket
  reason: DecideReason | null
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/**
 * Named volumes only the bundle's stacks use. A volume that a container outside the bundle
 * also mounts is never listed: removing it would pull data from under a stack we do not own.
 * Bind mounts have no volume name, so they never qualify.
 */
export function ownedVolumes(
  bundleStacks: readonly StackGroup[],
  allContainers: readonly InspectedContainer[]
): string[] {
  const inBundle = new Set<string>()
  const names = new Set<string>()
  for (const s of bundleStacks) {
    for (const c of s.containers) {
      inBundle.add(c.id)
      for (const m of c.mounts) if (m.type === 'volume' && m.name) names.add(m.name)
    }
  }
  for (const c of allContainers) {
    if (inBundle.has(c.id)) continue
    for (const m of c.mounts) if (m.name) names.delete(m.name)
  }
  return [...names].sort()
}

const FATE_DECISIONS: Record<
  Exclude<FateResult['fate'], 'merged' | 'open'>,
  { code: DecideCode; detail: string }
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
 * work is `alive`; anything uncertain is `decide`; only a strongly merged, clean, idle
 * worktree past its grace window is a `corpse`.
 */
export function bucketOf(
  f: BundleFacts,
  now: number,
  graceDays: number
): { bucket: Bucket; reason: DecideReason | null } {
  const alive = { bucket: 'alive' as const, reason: null }
  const decide = (code: DecideCode, detail: string): { bucket: Bucket; reason: DecideReason } => ({
    bucket: 'decide',
    reason: { code, detail }
  })

  if (f.isMainCheckout || f.neverClean) return alive
  if (f.session === 'working' || f.session === 'needs-input') return alive
  if (f.fate.fate === 'open') return alive
  // No sign of life at all is "unknown age", which must not read as "old enough".
  if (f.lastSignOfLifeAt === null || now - f.lastSignOfLifeAt < graceDays * DAY_MS) return alive
  if (f.keep) return alive

  if (f.session === 'open-idle')
    return decide('open-idle-session', 'A session is still open in this worktree, though idle.')

  if (f.sharedStackIds.length > 0) {
    const n = f.sharedStackIds.length
    return decide(
      'shared-stack',
      `${plural(n, 'other stack')} also ${n === 1 ? 'uses' : 'use'} this worktree: ${f.sharedStackIds.join(', ')}.`
    )
  }

  if (f.fate.fate !== 'merged') {
    const d = FATE_DECISIONS[f.fate.fate]
    return decide(d.code, d.detail)
  }

  if (!f.fate.strong)
    return decide(
      'weak-merge-signal',
      f.fate.signal === 'gh-merged'
        ? 'Merged by gh-merged, but the local tip differs from the PR head.'
        : `Merged only by the inferred signal ${f.fate.signal ?? 'unknown'}.`
    )

  const blockers = f.item.blockers
  if (blockers.includes('dirty') || blockers.includes('unpushed')) {
    const hit = ['dirty', 'unpushed'].filter((b) => blockers.includes(b))
    const detail = `${plural(hit.length, 'blocker')}: ${hit.join(', ')}.`
    return decide(hit[0] === 'dirty' ? 'dirty' : 'unpushed', detail)
  }

  return { bucket: 'corpse', reason: null }
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
}

/** Merge time from the `pr-merged` checkpoint detail; anything that is not a date is ignored. */
function mergedAtOf(item: ReapItem): number | null {
  const detail = item.checkpoints.find((c) => c.id === 'pr-merged')?.detail
  if (!detail) return null
  const t = Date.parse(detail)
  return Number.isFinite(t) ? t : null
}

/**
 * The folders one container runs from: its compose working dir when it has one, otherwise
 * the sources of its bind mounts. The builder and the execution-time reprobe both call this,
 * so a stack the scan attributed to a worktree is seen by the reprobe through the same rule.
 * Empty means nothing ties the container to a folder.
 */
export function containerFolders(c: InspectedContainer, platform: string): string[] {
  const dir = c.labels[COMPOSE_WORKING_DIR_LABEL]
  if (dir) return [normalizePath(dir, platform)]
  const out = new Set<string>()
  for (const m of c.mounts) {
    if (m.type === 'bind' && m.source) out.add(normalizePath(m.source, platform))
  }
  return [...out]
}

/**
 * Every folder a stack runs from: each container's folders plus the path the shell
 * attributed it to. `groupStacks` merges by compose project NAME, so two worktrees with
 * the same project name arrive as one stack with several working dirs.
 */
function stackFolders(
  stack: StackGroup,
  stackPaths: Map<string, string>,
  platform: string
): string[] {
  const out = new Set<string>()
  for (const c of stack.containers) for (const d of containerFolders(c, platform)) out.add(d)
  const attributed = stackPaths.get(stack.id)
  if (attributed) out.add(normalizePath(attributed, platform))
  return [...out]
}

export function buildBundles(input: BuildBundlesInput): WorktreeBundle[] {
  const platform = process.platform
  const stoppedByHarnu = input.harnuStoppedAt ?? new Map<string, number>()

  const folders = input.items
    .filter((i) => (i.kind === 'worktree' || i.kind === 'detached-worktree') && i.path)
    .map((item) => ({ item, path: normalizePath(item.path as string, platform) }))

  // A stack is exclusive to a bundle only if EVERY folder it runs from is inside that
  // bundle. If a stack touches a bundle but also runs from outside it, or two bundles both
  // claim it outright (nested paths), nobody may remove it: it is shared.
  const exclusive = new Map<string, StackGroup[]>()
  const shared = new Map<string, string[]>()
  for (const stack of input.stacks) {
    const dirs = stackFolders(stack, input.stackPaths, platform)
    if (dirs.length === 0) continue
    const full: string[] = []
    const partial: string[] = []
    for (const f of folders) {
      const inside = dirs.filter((d) => isInside(d, f.path)).length
      if (inside === dirs.length) full.push(f.item.id)
      else if (inside > 0) partial.push(f.item.id)
    }
    if (full.length === 1 && partial.length === 0) {
      exclusive.set(full[0]!, [...(exclusive.get(full[0]!) ?? []), stack])
    } else {
      for (const id of [...full, ...partial]) shared.set(id, [...(shared.get(id) ?? []), stack.id])
    }
  }

  const neverClean = new Set([...input.neverClean].map((p) => normalizePath(p, platform)))

  return folders.map(({ item, path }) => {
    const fateInput = input.fateInputs.get(item.id)
    const fate: FateResult =
      item.kind === 'detached-worktree'
        ? resolveDetachedFate()
        : fateInput
          ? resolveFate(fateInput.facts, fateInput.localTip)
          : { fate: 'unknown', signal: null, strong: false }

    const stacks = exclusive.get(item.id) ?? []
    const session = input.sessions.get(item.path as string)
    const events = lastContainerEvent(
      stacks.flatMap((s) => s.containers),
      stoppedByHarnu
    )
    const signs = [mergedAtOf(item), session?.lastActivityAt ?? null, events].filter(
      (t): t is number => t !== null
    )

    const facts: BundleFacts = {
      item,
      fate,
      session: session?.presence ?? 'none',
      lastSignOfLifeAt: signs.length > 0 ? Math.max(...signs) : null,
      stackIds: stacks.map((s) => s.id),
      sharedStackIds: shared.get(item.id) ?? [],
      ownedVolumes: ownedVolumes(stacks, input.containers),
      depsBytes: item.hydration?.reclaimableBytes ?? null,
      keep: input.keep.has(item.id),
      neverClean: neverClean.has(path) || neverClean.has(normalizePath(item.repoPath, platform)),
      isMainCheckout: path === normalizePath(item.repoPath, platform),
      localTip:
        item.kind === 'detached-worktree' ? (item.headSha ?? null) : (fateInput?.localTip ?? null)
    }
    return { ...facts, ...bucketOf(facts, input.now, input.graceDays) }
  })
}
