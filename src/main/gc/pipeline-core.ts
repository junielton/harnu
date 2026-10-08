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
   * Re-reads presence, HEAD and the stacks touching the worktree right before `cleanGit`: the
   * docker steps and drop-deps take time, and a session opened, a commit made or a stack
   * started meanwhile must stop the archive and trash. Any stack still touching the worktree
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

export interface GcRunOptions {
  removeVolumes: boolean
  /** The operator explicitly chose to clean `decide` bundles too. Never set by default. */
  confirmDecide?: boolean
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
 * Only a proven corpse runs, or a `decide` bundle the operator explicitly confirmed. A
 * protection flag refuses whatever the bucket says, since a stale or hand-built bundle can
 * carry a corpse bucket next to a flag set after the scan.
 *
 * A shared stack refuses even a confirmed `decide`: the pipeline stops only the exclusive
 * stacks, so the folder would be trashed under a foreign stack that still runs from it.
 * Returns the refusal, or null when the bundle may run.
 */
function refusalOf(b: WorktreeBundle, opts: GcRunOptions): string | null {
  if (b.isMainCheckout || b.neverClean || b.keep || isMainCheckoutByPath(b)) return 'not-a-corpse'
  if (b.sharedStackIds.length > 0) return 'shared-stack'
  const runs = b.bucket === 'corpse' || (opts.confirmDecide === true && b.bucket === 'decide')
  return runs ? null : 'not-a-corpse'
}

/**
 * Clean one bundle in a fixed order: reprobe, stop stacks, remove containers, remove
 * volumes, drop deps, recheck, then the git side. The order is what makes it safe: nothing
 * under the checkout is touched until the stack running from it is gone, and nothing is
 * removed at all unless the reprobe still agrees with the scan.
 *
 * Anything but a proven corpse (or a confirmed `decide`), and anything with a shared stack,
 * is refused before any op runs.
 * The first failing step halts this bundle; later steps never run. Never rejects.
 */
export async function runBundle(
  b: WorktreeBundle,
  ops: GcOps,
  opts: GcRunOptions
): Promise<GcItemResult> {
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
    try {
      await fn()
      return null
    } catch (err) {
      return fail(name, messageOf(err))
    }
  }

  let probe: Awaited<ReturnType<GcOps['reprobe']>>
  try {
    probe = await ops.reprobe(b)
  } catch (err) {
    return fail('reprobe', messageOf(err))
  }
  if (!probe.ok) return fail('reprobe', probe.reason)

  let halted: GcItemResult | null
  if (b.stackIds.length > 0) {
    halted = await step('stop-stack', () => ops.stopStacks(b.stackIds))
    if (halted) return halted
    halted = await step('rm-containers', () => ops.removeContainers(b.stackIds))
    if (halted) return halted
    if (opts.removeVolumes && b.ownedVolumes.length > 0) {
      halted = await step('rm-volumes', async () => {
        const r = await ops.removeVolumes(b.ownedVolumes)
        if (r) skippedVolumes = r.skipped
      })
      if (halted) return halted
    }
  }

  // Accepted spec §4 deviation: cleanItem is one call, and its archive skips the ignored dirs.
  halted = await step('drop-deps', async () => {
    freedBytes = await ops.dropDeps(b)
  })
  if (halted) return halted

  // The deps are already gone, so their bytes stay counted whatever the recheck says.
  let still: Awaited<ReturnType<GcOps['recheck']>> | null = null
  try {
    still = await ops.recheck(b)
  } catch {
    // A recheck that cannot answer is not a green light.
  }
  if (!still?.ok) return fail('archive', 'changed-mid-run')

  try {
    await ops.cleanGit(b)
  } catch (err) {
    // The deps are already gone, so their bytes stay counted.
    return fail(err instanceof GcStepError ? err.step : 'archive', messageOf(err))
  }
  return { id: b.item.id, ok: true, haltedAt: null, freedBytes, ...skipped() }
}

/** Sequential on purpose: docker and git are shared resources, and one failure never stops the rest. */
export async function runBatch(
  bs: WorktreeBundle[],
  ops: GcOps,
  opts: GcRunOptions
): Promise<GcItemResult[]> {
  const results: GcItemResult[] = []
  for (const b of bs) results.push(await runBundle(b, ops, opts))
  return results
}
