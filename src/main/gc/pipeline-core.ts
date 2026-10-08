// Pure cleanup pipeline for one worktree bundle (design: workspace-gc §4, absorbs T321).
// Every side effect is an injected op, so the ordering and halt-on-failure rules are
// unit-tested in tests/gc-pipeline-core.test.ts without touching docker, git or disk.

import { canonicalPathKey, type WorktreeBundle } from './bundle-core'

export type GcStep =
  | 'reprobe'
  | 'stop-stack'
  | 'rm-containers'
  | 'rm-volumes'
  | 'archive'
  | 'drop-deps'
  | 'trash'
  | 'prune'
  | 'branch-delete'
  | 'detach'

export interface GcOps {
  /** Re-reads the facts the bucket was decided on; any drift since the scan refuses the clean. */
  reprobe(b: WorktreeBundle): Promise<{ ok: true } | { ok: false; reason: string }>
  stopStacks(ids: string[]): Promise<void>
  removeContainers(ids: string[]): Promise<void>
  /**
   * Re-lists who mounts each volume first: one a remaining container still mounts is
   * skipped, not removed, and reported so the operator sees what was left behind.
   */
  removeVolumes(names: string[]): Promise<void | { skipped: SkippedVolume[] }>
  /** Resolves to the bytes freed. */
  dropDeps(b: WorktreeBundle): Promise<number>
  /**
   * Re-reads presence, HEAD and the stacks touching the worktree, right before drop-deps and
   * again right before `cleanGit`: the docker steps and drop-deps take time, and a session
   * opened (in any subfolder), a commit made or a stack started meanwhile must stop the
   * removal of the deps, the archive and the trash. Any stack still touching the worktree
   * refuses, a scanned one included: by then the run removed every stack it may remove.
   */
  recheck(b: WorktreeBundle): Promise<{ ok: true } | { ok: false; reason: string }>
  /** archive → trash → prune → branch-delete → detach, remote branch deletion forced off. */
  cleanGit(b: WorktreeBundle): Promise<void>
}

/** A volume the run left in place because a container still mounted it at execution time. */
export interface SkippedVolume {
  name: string
  reason: 'volume-in-use'
}

export interface GcItemResult {
  id: string
  ok: boolean
  haltedAt: GcStep | null
  error?: string
  freedBytes: number
  /** Present only when non-empty, on success and on a later failure alike. */
  skippedVolumes?: SkippedVolume[]
}

/**
 * `cleanGit` wraps a monolithic executor, so a failure inside it would otherwise be
 * attributable only to "git". Throwing this names the exact step that failed.
 */
export class GcStepError extends Error {
  constructor(
    readonly step: GcStep,
    message: string
  ) {
    super(message)
    this.name = 'GcStepError'
  }
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** The error of a probe that threw or answered in a shape no op is allowed to (delta 6, F3). */
const PROBE_FAILED = 'probe-failed'

/** A reprobe or recheck answer: `ok` must be a real boolean, never just truthy. */
const isProbeAnswer = (r: unknown): r is { ok: boolean; reason?: unknown } =>
  typeof r === 'object' && r !== null && typeof (r as { ok?: unknown }).ok === 'boolean'

const isStringList = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((s) => typeof s === 'string')

/**
 * The fields runBundle reads before and between the ops. A stale, hand-built or corrupt
 * bundle missing one is refused up front instead of throwing halfway through a run.
 */
function wellFormed(b: unknown): b is WorktreeBundle {
  if (typeof b !== 'object' || b === null) return false
  const x = b as Partial<WorktreeBundle>
  return (
    typeof x.item === 'object' &&
    x.item !== null &&
    typeof x.item.id === 'string' &&
    isStringList(x.stackIds) &&
    isStringList(x.sharedStackIds) &&
    isStringList(x.ownedVolumes)
  )
}

/** removeVolumes answers nothing, or the volumes it skipped; anything else is unexpected. */
function skippedOf(r: unknown): SkippedVolume[] {
  if (r === undefined || r === null) return []
  const list = typeof r === 'object' ? (r as { skipped?: unknown }).skipped : undefined
  if (
    Array.isArray(list) &&
    list.every(
      (v) =>
        typeof v === 'object' &&
        v !== null &&
        typeof (v as SkippedVolume).name === 'string' &&
        (v as SkippedVolume).reason === 'volume-in-use'
    )
  ) {
    return list as SkippedVolume[]
  }
  throw new Error('removeVolumes answered an unexpected result')
}

export interface GcRunOptions {
  removeVolumes: boolean
  /** The operator explicitly chose to clean `review` bundles too. Never set by default. */
  confirmReview?: boolean
}

/**
 * The main checkout told by its path rather than by the flag the scan set: a hand-built or
 * stale bundle can carry `isMainCheckout: false` for the repo's own folder.
 */
export function isMainCheckoutByPath(b: WorktreeBundle): boolean {
  const path = b.item.path
  if (!path) return false
  return (
    canonicalPathKey(path, process.platform) === canonicalPathKey(b.item.repoPath, process.platform)
  )
}

/**
 * Only a proven ready bundle runs, or a `review` bundle the operator explicitly confirmed. A
 * protection flag refuses whatever the bucket says, since a stale or hand-built bundle can
 * carry a ready bucket next to a flag set after the scan.
 *
 * A shared stack refuses even a confirmed `review`: the pipeline stops only the exclusive
 * stacks, so the folder would be trashed under a foreign stack that still runs from it.
 * Returns the refusal, or null when the bundle may run.
 */
function refusalOf(b: WorktreeBundle, opts: GcRunOptions): string | null {
  if (b.isMainCheckout || b.neverClean || b.keep || isMainCheckoutByPath(b)) return 'not-ready'
  if (b.sharedStackIds.length > 0) return 'shared-stack'
  // A nested worktree refuses even a confirmed `review` (delta 6, F1). The reprobe sees this
  // repo's `git worktree list` and, since delta 7, every `.git` on disk inside the worktree,
  // but a nested folder known only as a known folder (no `.git` of its own) passes both. A
  // list that is missing or not a list cannot show there is none.
  if (!Array.isArray(b.nestedWorktrees) || b.nestedWorktrees.length > 0) return 'nested-worktree'
  // So does a foreign checkout the scan found (delta 7), whatever the operator confirmed.
  if (!Array.isArray(b.foreignCheckouts) || b.foreignCheckouts.length > 0) return 'nested-worktree'
  const runs = b.bucket === 'ready' || (opts.confirmReview === true && b.bucket === 'review')
  return runs ? null : 'not-ready'
}

/**
 * Clean one bundle in a fixed order: reprobe, stop stacks, remove containers, remove
 * volumes, recheck, drop deps, recheck, then the git side. The order is what makes it safe: nothing
 * under the checkout is touched until the stack running from it is gone, and nothing is
 * removed at all unless the reprobe still agrees with the scan.
 *
 * Anything but a proven ready bundle (or a confirmed `review`), and anything with a shared stack,
 * is refused before any op runs.
 * The first failing step halts this bundle; later steps never run. Never rejects: a throw or
 * an unexpected answer from any op, or a malformed bundle, halts this item and nothing else
 * (delta 6, F3), so `runBatch` always reaches the items after it.
 */
export async function runBundle(
  b: WorktreeBundle,
  ops: GcOps,
  opts: GcRunOptions
): Promise<GcItemResult> {
  // Where the run is, so a throw nobody expected still reports the step it happened in and
  // the bytes already freed, never "nothing was touched" after the docker steps ran.
  const progress: { step: GcStep; freedBytes: number } = { step: 'reprobe', freedBytes: 0 }
  try {
    return await runChecked(b, ops, opts, progress)
  } catch {
    const id = (b as Partial<WorktreeBundle> | null | undefined)?.item?.id
    return {
      id: typeof id === 'string' ? id : 'unknown',
      ok: false,
      haltedAt: progress.step,
      error: PROBE_FAILED,
      freedBytes: progress.freedBytes
    }
  }
}

async function runChecked(
  b: WorktreeBundle,
  ops: GcOps,
  opts: GcRunOptions,
  progress: { step: GcStep; freedBytes: number }
): Promise<GcItemResult> {
  // Throws on a malformed bundle, which runBundle reports as probe-failed at the reprobe.
  if (!wellFormed(b)) throw new TypeError('malformed bundle')
  const refused = refusalOf(b, opts)
  if (refused) {
    return { id: b.item.id, ok: false, haltedAt: 'reprobe', error: refused, freedBytes: 0 }
  }
  let freedBytes = 0
  let skippedVolumes: SkippedVolume[] = []
  const skipped = (): Pick<GcItemResult, 'skippedVolumes'> =>
    skippedVolumes.length > 0 ? { skippedVolumes } : {}
  const fail = (haltedAt: GcStep, error: string): GcItemResult => ({
    id: b.item.id,
    ok: false,
    haltedAt,
    error,
    freedBytes,
    ...skipped()
  })
  /** Runs one step; returns the failure when it throws, null otherwise. */
  const step = async (name: GcStep, fn: () => Promise<void>): Promise<GcItemResult | null> => {
    progress.step = name
    try {
      await fn()
      return null
    } catch (err) {
      return fail(name, messageOf(err))
    }
  }

  let probe: unknown
  try {
    probe = await ops.reprobe(b)
  } catch (err) {
    return fail('reprobe', messageOf(err))
  }
  // Only a real `ok: true` is a green light; any other shape is a probe that did not answer.
  if (!isProbeAnswer(probe)) return fail('reprobe', PROBE_FAILED)
  if (probe.ok !== true) {
    return fail('reprobe', typeof probe.reason === 'string' ? probe.reason : PROBE_FAILED)
  }

  let halted: GcItemResult | null
  if (b.stackIds.length > 0) {
    halted = await step('stop-stack', () => ops.stopStacks(b.stackIds))
    if (halted) return halted
    halted = await step('rm-containers', () => ops.removeContainers(b.stackIds))
    if (halted) return halted
    if (opts.removeVolumes && b.ownedVolumes.length > 0) {
      halted = await step('rm-volumes', async () => {
        skippedVolumes = skippedOf(await ops.removeVolumes(b.ownedVolumes))
      })
      if (halted) return halted
    }
  }

  // The docker steps take time: a session that opened meanwhile, in the worktree or any
  // folder under it, must keep its deps. dehydrateItem's own live check matches the exact
  // folder only, so the full recheck runs first.
  progress.step = 'drop-deps'
  if (!(await rechecked(ops, b))) return fail('drop-deps', 'changed-mid-run')

  // Accepted spec §4 deviation: cleanItem is one call, and its archive skips the ignored dirs.
  halted = await step('drop-deps', async () => {
    const bytes: unknown = await ops.dropDeps(b)
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) {
      throw new Error('dropDeps answered an unexpected result')
    }
    freedBytes = bytes
    progress.freedBytes = bytes
  })
  if (halted) return halted

  // The deps are already gone, so their bytes stay counted whatever the recheck says.
  progress.step = 'archive'
  if (!(await rechecked(ops, b))) return fail('archive', 'changed-mid-run')

  try {
    await ops.cleanGit(b)
  } catch (err) {
    // The deps are already gone, so their bytes stay counted.
    return fail(err instanceof GcStepError ? err.step : 'archive', messageOf(err))
  }
  return { id: b.item.id, ok: true, haltedAt: null, freedBytes, ...skipped() }
}

/**
 * True only for a recheck that answered a real `ok: true`. One that throws, or answers in
 * any other shape, cannot show nothing changed, so it is not a green light.
 */
async function rechecked(ops: GcOps, b: WorktreeBundle): Promise<boolean> {
  try {
    const r: unknown = await ops.recheck(b)
    return isProbeAnswer(r) && r.ok === true
  } catch {
    return false
  }
}

/** Sequential on purpose: docker and git are shared resources, and one failure never stops the rest. */
export async function runBatch(
  bs: WorktreeBundle[],
  ops: GcOps,
  opts: GcRunOptions
): Promise<GcItemResult[]> {
  const results: GcItemResult[] = []
  for (const b of bs) {
    // runBundle never rejects; this guard keeps one bad item from aborting the rest even so.
    try {
      results.push(await runBundle(b, ops, opts))
    } catch {
      const id = (b as Partial<WorktreeBundle> | null | undefined)?.item?.id
      results.push({
        id: typeof id === 'string' ? id : 'unknown',
        ok: false,
        haltedAt: 'reprobe',
        error: PROBE_FAILED,
        freedBytes: 0
      })
    }
  }
  return results
}
