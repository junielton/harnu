// Pure cleanup pipeline for one worktree bundle (design: workspace-gc §4, absorbs T321).
// Every side effect is an injected op, so the ordering and halt-on-failure rules are
// unit-tested in tests/gc-pipeline-core.test.ts without touching docker, git or disk.

import type { WorktreeBundle } from './bundle-core'

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
  removeVolumes(names: string[]): Promise<void>
  /** Resolves to the bytes freed. */
  dropDeps(b: WorktreeBundle): Promise<number>
  /** archive → trash → prune → branch-delete → detach, remote branch deletion forced off. */
  cleanGit(b: WorktreeBundle): Promise<void>
}

export interface GcItemResult {
  id: string
  ok: boolean
  haltedAt: GcStep | null
  error?: string
  freedBytes: number
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
 * Only a proven corpse runs, or a `decide` bundle the operator explicitly confirmed. A
 * protection flag refuses whatever the bucket says, since a stale or hand-built bundle can
 * carry a corpse bucket next to a flag set after the scan.
 */
function mayRun(b: WorktreeBundle, opts: GcRunOptions): boolean {
  if (b.isMainCheckout || b.neverClean || b.keep) return false
  return b.bucket === 'corpse' || (opts.confirmDecide === true && b.bucket === 'decide')
}

/**
 * Clean one bundle in a fixed order: reprobe, stop stacks, remove containers, remove
 * volumes, drop deps, then the git side. The order is what makes it safe: nothing under
 * the checkout is touched until the stack running from it is gone, and nothing is removed
 * at all unless the reprobe still agrees with the scan.
 *
 * Dropping deps runs before `cleanGit` (which contains the archive) because cleanItem is
 * one call. That is safe: dehydration removes only git-ignored directories and the archive
 * excludes ignored files.
 *
 * Anything but a proven corpse (or a confirmed `decide`) is refused before any op runs.
 * The first failing step halts this bundle; later steps never run. Never rejects.
 */
export async function runBundle(
  b: WorktreeBundle,
  ops: GcOps,
  opts: GcRunOptions
): Promise<GcItemResult> {
  if (!mayRun(b, opts)) {
    return { id: b.item.id, ok: false, haltedAt: 'reprobe', error: 'not-a-corpse', freedBytes: 0 }
  }
  let freedBytes = 0
  const fail = (haltedAt: GcStep, error: string): GcItemResult => ({
    id: b.item.id,
    ok: false,
    haltedAt,
    error,
    freedBytes
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
      halted = await step('rm-volumes', () => ops.removeVolumes(b.ownedVolumes))
      if (halted) return halted
    }
  }

  halted = await step('drop-deps', async () => {
    freedBytes = await ops.dropDeps(b)
  })
  if (halted) return halted

  try {
    await ops.cleanGit(b)
  } catch (err) {
    // The deps are already gone, so their bytes stay counted.
    return fail(err instanceof GcStepError ? err.step : 'archive', messageOf(err))
  }
  return { id: b.item.id, ok: true, haltedAt: null, freedBytes }
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
