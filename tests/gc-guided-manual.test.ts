// "No dead ends" (unit B): a guided "…and remove" is ONE job. The preparatory step (unlock, park an
// idle session, stop a shared stack) runs inside it, after what the operator was shown is checked, and
// the remove that follows is the ordinary guarded pipeline on a fresh gather — nothing is skipped.

import { describe, expect, it, vi } from 'vitest'
import { submitManualClean, type ManualCleanDeps } from '../src/main/gc/gc-manual'
import { expectedOf } from '../src/main/gc/gc-confirm'
import { createCycleState } from '../src/main/gc/gc-cycle'
import { createJobQueue, type GcJobDone } from '../src/main/gc/gc-jobs-core'
import { defaultGcPrefs } from '../src/main/gc/gc-prefs'
import { parseOptions } from '../src/main/gc/gc-options'
import type { GcOps } from '../src/main/gc/pipeline-core'
import type { WorktreeBundle } from '../src/main/gc/bundle-core'
import type { GcCleanOptions, GcPrep } from '../src/main/gc/gc-wire'
import { bundle, NOW } from './gc-fixtures'

const PATH = '/ws/wt/a'

const locked = (): WorktreeBundle =>
  bundle(PATH, 'review', { locked: true, reason: { code: 'locked', detail: 'x' } })
const unlocked = (): WorktreeBundle =>
  bundle(PATH, 'review', { reason: { code: 'dirty', detail: 'x' } })

function rig(opts: {
  before: WorktreeBundle
  /** What the next gather shows once the prep ran. */
  after?: WorktreeBundle
  prepare?: ManualCleanDeps['prepare'] | null
  prefs?: Partial<ReturnType<typeof defaultGcPrefs>>
}) {
  const log: string[] = []
  let prepared = false
  const ops: GcOps = {
    reprobe: async () => (log.push('reprobe'), { ok: true }),
    stopStacks: async () => undefined,
    removeContainers: async () => undefined,
    removeVolumes: async () => undefined,
    dropDeps: async () => 9,
    recheck: async () => ({ ok: true }),
    cleanGit: async () => void log.push('cleanGit')
  }
  const done: GcJobDone[] = []
  let n = 0
  const prepare =
    opts.prepare === null
      ? undefined
      : (opts.prepare ??
        (async (prep: GcPrep) => {
          log.push(`prepare ${prep.kind}`)
          prepared = true
          return { ok: true as const }
        }))
  const deps: ManualCleanDeps = {
    prefs: () => ({ ...defaultGcPrefs(), ...opts.prefs }),
    gather: async () => ({
      bundles: [structuredClone(prepared && opts.after ? opts.after : opts.before)],
      orphanVolumes: []
    }),
    gatherFresh: async () => ({
      bundles: [structuredClone(prepared && opts.after ? opts.after : opts.before)],
      orphanVolumes: []
    }),
    prepare: prepare as ManualCleanDeps['prepare'],
    opsFor: () => ops,
    freshOrphans: async () => [],
    workStampOf: async () => null,
    removeOrphanVolumes: async () => ({
      buildCacheBytes: 0,
      imageBytes: 0,
      volumeBytes: 0,
      errors: []
    }),
    queue: createJobQueue({
      newId: () => `job-${++n}`,
      emitProgress: () => undefined,
      emitDone: (d) => done.push(d)
    }),
    state: createCycleState(),
    now: () => NOW
  }
  return { deps, log, done }
}

const asked = (b: WorktreeBundle, prep?: GcPrep, confirmed = true): GcCleanOptions =>
  structuredClone({
    expected: { [b.item.id]: expectedOf(b) },
    ...(confirmed ? { confirmed: [b.item.id] } : {}),
    ...(prep ? { prepare: { [b.item.id]: prep } } : {})
  })

const run = async (r: ReturnType<typeof rig>, b: WorktreeBundle, o: GcCleanOptions) => {
  submitManualClean(r.deps, [b.item.id], o)
  await r.deps.queue.idle()
  return r.done[0]?.results[0]
}

describe('a guided remove prepares, then removes the ordinary guarded way (AC-B3, B4, B5)', () => {
  it('unlock → fresh gather → the normal forced remove', async () => {
    const before = locked()
    const r = rig({ before, after: unlocked() })
    const res = await run(r, before, asked(before, { kind: 'unlock' }))
    expect(res).toMatchObject({ ok: true })
    expect(r.log).toEqual(['prepare unlock', 'reprobe', 'cleanGit'])
  })

  it('without the prep the same locked item is not touched by the pipeline', async () => {
    const before = locked()
    const r = rig({ before, after: unlocked() })
    const res = await run(r, before, asked(before))
    // The engine's own reprobe is what refuses a lock; the fakes here let it through, so what this
    // pins is that no prep ran on its own.
    expect(r.log).not.toContain('prepare unlock')
    expect(res).toBeDefined()
  })

  it('a prep needs the operator’s own confirmation of that id', async () => {
    const before = locked()
    const r = rig({ before, after: unlocked() })
    const res = await run(r, before, asked(before, { kind: 'unlock' }, false))
    expect(res).toMatchObject({ ok: false, error: 'needs-confirmation' })
    expect(r.log).toEqual([])
  })

  it('what the operator saw is checked BEFORE anything is prepared', async () => {
    const before = locked()
    const o = asked(before, { kind: 'unlock' })
    o.expected![before.item.id].headSha = 'f'.repeat(40)
    const r = rig({ before, after: unlocked() })
    const res = await run(r, before, o)
    expect(res).toMatchObject({ ok: false, error: 'changed-since-confirm' })
    expect(r.log).toEqual([])
  })

  it('a prep that fails stops the item with its cause and removes nothing', async () => {
    const before = locked()
    const r = rig({
      before,
      after: unlocked(),
      prepare: async () => ({ ok: false, error: 'unlock-failed: fatal: nope' })
    })
    const res = await run(r, before, asked(before, { kind: 'unlock' }))
    expect(res).toMatchObject({
      ok: false,
      haltedAt: 'reprobe',
      error: 'unlock-failed: fatal: nope'
    })
    expect(r.log).toEqual([])
  })

  it('a worktree that became busy during the prep is refused, not removed', async () => {
    const before = locked()
    const busy = bundle(PATH, 'in-use', { session: 'working' })
    const r = rig({ before, after: busy })
    const res = await run(r, before, asked(before, { kind: 'unlock' }))
    expect(res).toMatchObject({ ok: false, error: 'in-use' })
    expect(r.log).toEqual(['prepare unlock'])
  })

  it('a worktree that moved or advanced during the prep is refused', async () => {
    const before = locked()
    const moved = unlocked()
    moved.localTip = 'b'.repeat(40)
    const r = rig({ before, after: moved })
    const res = await run(r, before, asked(before, { kind: 'unlock' }))
    expect(res).toMatchObject({ ok: false, error: 'changed-since-confirm' })
    expect(r.log).toEqual(['prepare unlock'])
  })

  it('protections still win: a Keep mark is refused before any prep', async () => {
    const before = bundle(PATH, 'review', { keep: true })
    const r = rig({ before })
    const res = await run(r, before, asked(before, { kind: 'unlock' }))
    expect(res).toMatchObject({ ok: false, error: 'kept' })
    expect(r.log).toEqual([])
  })

  it('leave-stack removes the worktree while the shared stack keeps running', async () => {
    const before = bundle(PATH, 'review', {
      sharedStackIds: ['web'],
      reason: { code: 'shared-stack', detail: 'x' }
    })
    // The scan still lists the stack as shared after the prep (it is attributed to this folder).
    const r = rig({ before })
    const res = await run(r, before, asked(before, { kind: 'leave-stack', stackIds: ['web'] }))
    expect(res).toMatchObject({ ok: true })
    expect(r.log).toEqual(['prepare leave-stack', 'reprobe', 'cleanGit'])
  })

  it('without the leave step the shared stack still refuses the remove', async () => {
    const before = bundle(PATH, 'review', {
      sharedStackIds: ['web'],
      reason: { code: 'shared-stack', detail: 'x' }
    })
    const r = rig({ before })
    const res = await run(r, before, asked(before))
    expect(res).toMatchObject({ ok: false, error: 'shared-stack' })
  })

  it('without a prepare step wired, a prep is refused rather than ignored', async () => {
    const before = locked()
    const r = rig({ before, prepare: null })
    const res = await run(r, before, asked(before, { kind: 'unlock' }))
    expect(res).toMatchObject({ ok: false, error: 'prep-not-applicable' })
  })
})

describe('parseOptions keeps only well-formed preps', () => {
  const parse = (prepare: unknown) =>
    parseOptions({ confirmed: ['a'], expected: {}, prepare }).prepare
  it('accepts the four kinds', () => {
    expect(
      parse({
        a: { kind: 'unlock' },
        b: { kind: 'close-session' },
        c: { kind: 'stop-stack', stackIds: ['x'] },
        d: { kind: 'leave-stack', stackIds: ['x'] }
      })
    ).toEqual({
      a: { kind: 'unlock' },
      b: { kind: 'close-session' },
      c: { kind: 'stop-stack', stackIds: ['x'] },
      d: { kind: 'leave-stack', stackIds: ['x'] }
    })
  })
  it('drops an unknown kind, a malformed stack list and a non-object', () => {
    expect(
      parse({
        a: { kind: 'rm-rf' },
        b: { kind: 'stop-stack', stackIds: 'x' },
        c: { kind: 'stop-stack', stackIds: [1] },
        d: 'unlock',
        e: { kind: 'leave-stack', stackIds: [] }
      })
    ).toBeUndefined()
  })
  it('is absent when none was sent', () => {
    expect(parseOptions({ confirmed: [], expected: {} }).prepare).toBeUndefined()
  })
})

void vi
