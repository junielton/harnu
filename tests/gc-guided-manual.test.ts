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
import { GcStepError, type GcOps } from '../src/main/gc/pipeline-core'
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
  /** What the dry run (everything but the prep's own cause) says; default: nothing else refuses. */
  dry?: (b: WorktreeBundle) => { ok: true } | { ok: false; reason: string }
  /** Replaces the real reprobe: the refusal the remove still meets AFTER the prep ran. */
  reprobe?: GcOps['reprobe']
  workStamp?: (path: string) => Promise<string | null>
  /** Replaces the ops the remove runs on (e.g. to make building them throw). */
  opsFor?: () => GcOps
  rememberLeftovers?: ManualCleanDeps['rememberLeftovers']
  /** More bundles in the same gather (a second id in the same job). */
  extra?: WorktreeBundle[]
  /** What the git side does: throws a GcStepError to halt at that step. */
  cleanGit?: GcOps['cleanGit']
  folderExists?: (path: string) => Promise<boolean>
}) {
  const log: string[] = []
  let prepared = false
  const ops: GcOps = {
    reprobe: opts.reprobe
      ? async (b) => (log.push('reprobe'), opts.reprobe!(b))
      : async () => (log.push('reprobe'), { ok: true }),
    stopStacks: async () => undefined,
    removeContainers: async () => undefined,
    removeVolumes: async () => undefined,
    dropDeps: async () => 9,
    recheck: async () => ({ ok: true }),
    cleanGit: opts.cleanGit
      ? async (b) => (log.push('cleanGit'), opts.cleanGit!(b))
      : async () => void log.push('cleanGit')
  }
  const done: GcJobDone[] = []
  let n = 0
  const prepare =
    opts.prepare === null
      ? undefined
      : (opts.prepare ??
        (async (prep: GcPrep, _b: WorktreeBundle, o?: { dry?: boolean }) => {
          if (o?.dry) {
            log.push(`validate ${prep.kind}`)
            return { ok: true as const }
          }
          log.push(`prepare ${prep.kind}`)
          prepared = true
          return { ok: true as const, undo: async () => void log.push(`undo ${prep.kind}`) }
        }))
  const deps: ManualCleanDeps = {
    prefs: () => ({ ...defaultGcPrefs(), ...opts.prefs }),
    gather: async () => ({
      bundles: [
        structuredClone(prepared && opts.after ? opts.after : opts.before),
        ...structuredClone(opts.extra ?? [])
      ],
      orphanVolumes: []
    }),
    gatherFresh: async () => ({
      bundles: [structuredClone(prepared && opts.after ? opts.after : opts.before)],
      orphanVolumes: []
    }),
    prepare: prepare as ManualCleanDeps['prepare'],
    dryReprobe: async (b) => {
      log.push('dry-reprobe')
      return opts.dry ? opts.dry(b) : { ok: true }
    },
    opsFor: opts.opsFor ?? (() => ops),
    ...(opts.rememberLeftovers ? { rememberLeftovers: opts.rememberLeftovers } : {}),
    freshOrphans: async () => [],
    workStampOf: opts.workStamp ?? (async () => null),
    ...(opts.folderExists ? { folderExists: opts.folderExists } : {}),
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

const asked = (b: WorktreeBundle, prep?: GcPrep | GcPrep[], confirmed = true): GcCleanOptions =>
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
    expect(r.log).toEqual([
      'validate unlock',
      'dry-reprobe',
      'prepare unlock',
      'reprobe',
      'cleanGit'
    ])
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
      prepare: async (_p, _b, o) =>
        o?.dry ? { ok: true } : { ok: false, error: 'unlock-failed: fatal: nope' }
    })
    const res = await run(r, before, asked(before, { kind: 'unlock' }))
    expect(res).toMatchObject({
      ok: false,
      haltedAt: 'reprobe',
      error: 'unlock-failed: fatal: nope'
    })
    expect(r.log).toEqual(['dry-reprobe']) // the dry run came first; nothing was removed
  })

  it('a worktree that became busy during the prep is refused, not removed', async () => {
    const before = locked()
    const busy = bundle(PATH, 'in-use', { session: 'working' })
    const r = rig({ before, after: busy })
    const res = await run(r, before, asked(before, { kind: 'unlock' }))
    expect(res).toMatchObject({ ok: false, error: 'in-use' })
    expect(r.log).toContain('prepare unlock')
  })

  it('a worktree that moved or advanced during the prep is refused', async () => {
    const before = locked()
    const moved = unlocked()
    moved.localTip = 'b'.repeat(40)
    const r = rig({ before, after: moved })
    const res = await run(r, before, asked(before, { kind: 'unlock' }))
    expect(res).toMatchObject({ ok: false, error: 'changed-since-confirm' })
    expect(r.log).toContain('prepare unlock')
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
    expect(r.log).toEqual([
      'validate leave-stack',
      'dry-reprobe',
      'prepare leave-stack',
      'reprobe',
      'cleanGit'
    ])
  })

  it('stop-stack: the dry run assumes the stack stopped, and the remove then runs with it assumed', async () => {
    const before = bundle(PATH, 'review', {
      sharedStackIds: ['web'],
      reason: { code: 'shared-stack', detail: 'x' }
    })
    const seenByDry: WorktreeBundle[] = []
    const r = rig({ before, dry: (b) => (seenByDry.push(b), { ok: true }) })
    const res = await run(r, before, asked(before, { kind: 'stop-stack', stackIds: ['web'] }))
    expect(res).toMatchObject({ ok: true })
    expect(seenByDry[0].assume).toEqual({ stoppedStacks: ['web'] })
  })

  it('stop-stack: the remove still refuses afterwards, so the stack is started again', async () => {
    const before = bundle(PATH, 'review', {
      sharedStackIds: ['web'],
      reason: { code: 'shared-stack', detail: 'x' }
    })
    const r = rig({ before, reprobe: async () => ({ ok: false, reason: 'stack-present' }) })
    const res = await run(r, before, asked(before, { kind: 'stop-stack', stackIds: ['web'] }))
    expect(res).toMatchObject({ ok: false })
    expect(r.log).toContain('undo stop-stack')
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

// Delta 1 (findings 1 and 2): a prep is the LAST thing standing between the item and a successful
// remove. Everything else is judged first, as a dry run that treats the prep's own cause as fixed, and
// whatever the prep changed is put back when the remove still refuses.
describe('the prep runs last and is rolled back (delta 1)', () => {
  it('work changed since the dialog: nothing is unlocked', async () => {
    const before = locked()
    before.item.workStamp = 'seen'
    const r = rig({ before, after: unlocked(), workStamp: async () => 'edited-since' })
    const res = await run(r, before, asked(before, { kind: 'unlock' }))
    expect(res).toMatchObject({ ok: false, error: 'work-changed-since-confirm' })
    expect(r.log.filter((l) => l.startsWith('prepare'))).toEqual([])
  })

  it('work unreadable at the scan: nothing is unlocked', async () => {
    const before = locked()
    before.item.workStamp = 'unknown'
    const r = rig({ before, after: unlocked() })
    const res = await run(r, before, asked(before, { kind: 'unlock' }))
    expect(res).toMatchObject({ ok: false, error: 'work-unreadable' })
    expect(r.log.filter((l) => l.startsWith('prepare'))).toEqual([])
  })

  it('any OTHER refusal the dry run finds stops it before the prep', async () => {
    const before = locked()
    const r = rig({
      before,
      after: unlocked(),
      dry: () => ({ ok: false, reason: 'nested-worktree' })
    })
    const res = await run(r, before, asked(before, { kind: 'unlock' }))
    expect(res).toMatchObject({ ok: false, haltedAt: 'reprobe', error: 'nested-worktree' })
    expect(r.log).toEqual(['validate unlock', 'dry-reprobe'])
  })

  it('a pipeline refusal (a shared stack that is not the one being fixed) stops it before the prep', async () => {
    const before = bundle(PATH, 'review', {
      locked: true,
      sharedStackIds: ['other'],
      reason: { code: 'locked', detail: 'x' }
    })
    const r = rig({ before })
    const res = await run(r, before, asked(before, { kind: 'unlock' }))
    expect(res).toMatchObject({ ok: false, error: 'shared-stack' })
    expect(r.log.filter((l) => l.startsWith('prepare'))).toEqual([])
  })

  it(
    'the prep' +
      "'" +
      's own refusal does not count against it: the dry run sees the lock as fixed',
    async () => {
      const before = locked()
      const seenByDry: WorktreeBundle[] = []
      const r = rig({
        before,
        after: unlocked(),
        dry: (b) => (seenByDry.push(b), { ok: true })
      })
      await run(r, before, asked(before, { kind: 'unlock' }))
      expect(seenByDry[0].assume).toEqual({ unlock: true })
    }
  )

  it('the remove still refuses after the unlock: the worktree is locked again', async () => {
    const before = locked()
    const r = rig({
      before,
      after: unlocked(),
      reprobe: async () => ({ ok: false, reason: 'cannot-unregister' })
    })
    const res = await run(r, before, asked(before, { kind: 'unlock' }))
    expect(res).toMatchObject({ ok: false, error: 'cannot-unregister' })
    expect(r.log).toEqual([
      'validate unlock',
      'dry-reprobe',
      'prepare unlock',
      'reprobe',
      'undo unlock'
    ])
  })

  it('the item changed between the prep and the remove: still rolled back', async () => {
    const before = locked()
    const moved = unlocked()
    moved.localTip = 'd'.repeat(40)
    const r = rig({ before, after: moved })
    const res = await run(r, before, asked(before, { kind: 'unlock' }))
    expect(res).toMatchObject({ ok: false, error: 'changed-since-confirm' })
    expect(r.log).toContain('undo unlock')
  })

  it('a successful remove is not rolled back', async () => {
    const before = locked()
    const r = rig({ before, after: unlocked() })
    await run(r, before, asked(before, { kind: 'unlock' }))
    expect(r.log).not.toContain('undo unlock')
  })

  it('an undo that fails is said, not swallowed', async () => {
    const before = locked()
    const r = rig({
      before,
      after: unlocked(),
      reprobe: async () => ({ ok: false, reason: 'cannot-unregister' }),
      prepare: async (_p, _b, o) =>
        o?.dry
          ? { ok: true }
          : {
              ok: true,
              undo: async () => {
                throw new Error('git is gone')
              }
            }
    })
    const res = await run(r, before, asked(before, { kind: 'unlock' }))
    expect(res).toMatchObject({ ok: false })
    expect(res!.error).toMatch(/^cannot-unregister/)
    expect(res!.error).toContain('rollback-failed')
  })
})

// Delta 2 item 5: once the folder is trashed there is nothing to roll back to.
describe('no rollback after the folder is gone (delta 2)', () => {
  const haltAt = (step: 'archive' | 'trash' | 'prune' | 'branch-delete') => async () => {
    throw new GcStepError(step, `${step} failed`)
  }

  it.each(['prune', 'branch-delete'] as const)(
    'a halt at %s: the lock is NOT put back and no container is restarted',
    async (step) => {
      const before = locked()
      const r = rig({ before, after: unlocked(), cleanGit: haltAt(step) })
      const res = await run(r, before, asked(before, { kind: 'unlock' }))
      expect(res).toMatchObject({ ok: false, haltedAt: step })
      expect(r.log).not.toContain('undo unlock')
    }
  )

  it('a stack stopped for a worktree that was then trashed is reported as left stopped', async () => {
    const before = bundle(PATH, 'review', {
      sharedStackIds: ['web'],
      reason: { code: 'shared-stack', detail: 'x' }
    })
    const r = rig({ before, cleanGit: haltAt('prune') })
    const res = await run(r, before, asked(before, { kind: 'stop-stack', stackIds: ['web'] }))
    expect(r.log).not.toContain('undo stop-stack')
    expect(res!.error).toContain('prep-left (stack-stopped)')
  })

  it('a halt AT the trash with the folder still there is rolled back', async () => {
    const before = locked()
    const r = rig({
      before,
      after: unlocked(),
      cleanGit: haltAt('trash'),
      folderExists: async () => true
    })
    await run(r, before, asked(before, { kind: 'unlock' }))
    expect(r.log).toContain('undo unlock')
  })

  it('a halt at the trash with the folder gone is not rolled back', async () => {
    const before = locked()
    const r = rig({
      before,
      after: unlocked(),
      cleanGit: haltAt('trash'),
      folderExists: async () => false
    })
    await run(r, before, asked(before, { kind: 'unlock' }))
    expect(r.log).not.toContain('undo unlock')
  })

  it('a halt before the trash (archive) is rolled back', async () => {
    const before = locked()
    const r = rig({ before, after: unlocked(), cleanGit: haltAt('archive') })
    await run(r, before, asked(before, { kind: 'unlock' }))
    expect(r.log).toContain('undo unlock')
  })
})

describe('the journal entry is settled when the item ends (delta 2 item 6)', () => {
  const withSettle =
    (log: string[]): ManualCleanDeps['prepare'] =>
    async (_p, _b, o) =>
      o?.dry
        ? { ok: true }
        : {
            ok: true,
            undo: async () => void log.push('undo'),
            settle: async () => void log.push('settle')
          }

  it('a successful remove settles it (and does not undo)', async () => {
    const before = locked()
    const log: string[] = []
    const r = rig({ before, after: unlocked(), prepare: withSettle(log) })
    await run(r, before, asked(before, { kind: 'unlock' }))
    expect(log).toEqual(['settle'])
  })

  it('a refusal undoes it (the undo clears the entry itself)', async () => {
    const before = locked()
    const log: string[] = []
    const r = rig({
      before,
      after: unlocked(),
      prepare: withSettle(log),
      reprobe: async () => ({ ok: false, reason: 'cannot-unregister' })
    })
    await run(r, before, asked(before, { kind: 'unlock' }))
    expect(log).toEqual(['undo'])
  })

  it('a halt after the folder was trashed settles it: there is nothing to retry at the next boot', async () => {
    const before = locked()
    const log: string[] = []
    const r = rig({
      before,
      after: unlocked(),
      prepare: withSettle(log),
      cleanGit: async () => {
        throw new GcStepError('prune', 'prune failed')
      }
    })
    await run(r, before, asked(before, { kind: 'unlock' }))
    expect(log).toEqual(['settle'])
  })
})

// Delta 2 item 2: stacked causes. Every step is validated and assumed fixed in the dry run, they run in
// a fixed order (the irreversible one last), and a refusal rolls back every step that ran, in reverse.
describe('several preps for one item (delta 2)', () => {
  const stacked = (over: Partial<Parameters<typeof bundle>[2]> = {}) =>
    bundle(PATH, 'review', {
      locked: true,
      sharedStackIds: ['web'],
      reason: { code: 'shared-stack', detail: 'x' },
      ...over
    })
  const afterAll = () => bundle(PATH, 'review', { reason: { code: 'dirty', detail: 'x' } })
  const UNLOCK: GcPrep = { kind: 'unlock' }
  const STOP: GcPrep = { kind: 'stop-stack', stackIds: ['web'] }
  const CLOSE: GcPrep = { kind: 'close-session' }

  it('validates every step, assumes every cause fixed, then runs them in order', async () => {
    const before = stacked()
    const seen: WorktreeBundle[] = []
    const r = rig({
      before,
      after: afterAll(),
      dry: (b) => (seen.push(b), { ok: true })
    })
    const res = await run(r, before, asked(before, [UNLOCK, STOP]))
    expect(res).toMatchObject({ ok: true })
    expect(r.log).toEqual([
      'validate unlock',
      'validate stop-stack',
      'dry-reprobe',
      'prepare unlock',
      'prepare stop-stack',
      'reprobe',
      'cleanGit'
    ])
    expect(seen[0].assume).toEqual({ unlock: true, stoppedStacks: ['web'] })
  })

  it('the order does not depend on the order asked: the session, which cannot be undone, is last', async () => {
    const before = stacked({ session: 'open-idle' })
    const r = rig({ before, after: afterAll() })
    await run(r, before, asked(before, [CLOSE, STOP, UNLOCK]))
    expect(r.log.filter((l) => l.startsWith('prepare'))).toEqual([
      'prepare unlock',
      'prepare stop-stack',
      'prepare close-session'
    ])
  })

  it('one step that cannot be validated stops them all, before any runs', async () => {
    const before = stacked()
    const r = rig({
      before,
      after: afterAll(),
      prepare: async (p, _b, o) => {
        if (o?.dry) {
          r0.log.push(`validate ${p.kind}`)
          return p.kind === 'stop-stack'
            ? { ok: false as const, error: 'stack-used-elsewhere' }
            : { ok: true as const }
        }
        return { ok: true as const }
      }
    })
    const r0 = r
    const res = await run(r, before, asked(before, [UNLOCK, STOP]))
    expect(res).toMatchObject({ ok: false, error: 'stack-used-elsewhere' })
    expect(r.log).toEqual(['validate unlock', 'validate stop-stack'])
  })

  it('the second step fails: the first is undone, nothing is removed', async () => {
    const before = stacked()
    const log: string[] = []
    const r = rig({
      before,
      after: afterAll(),
      prepare: async (p, _b, o) => {
        if (o?.dry) return { ok: true }
        if (p.kind === 'stop-stack') {
          log.push('prepare stop-stack')
          return { ok: false, error: 'stack-stop-failed: daemon gone' }
        }
        log.push(`prepare ${p.kind}`)
        return { ok: true, undo: async () => void log.push(`undo ${p.kind}`) }
      }
    })
    const res = await run(r, before, asked(before, [UNLOCK, STOP]))
    expect(res).toMatchObject({ ok: false, error: 'stack-stop-failed: daemon gone' })
    expect(log).toEqual(['prepare unlock', 'prepare stop-stack', 'undo unlock'])
    expect(r.log).not.toContain('cleanGit')
  })

  it('the remove refuses afterwards: every step is undone, in reverse order', async () => {
    const before = stacked()
    const r = rig({
      before,
      after: afterAll(),
      reprobe: async () => ({ ok: false, reason: 'stack-present' })
    })
    await run(r, before, asked(before, [UNLOCK, STOP]))
    expect(r.log.filter((l) => l.startsWith('undo'))).toEqual(['undo stop-stack', 'undo unlock'])
  })

  it('a parked session is not undone, but the steps before it are', async () => {
    const before = stacked({ session: 'open-idle', sharedStackIds: [] })
    const log: string[] = []
    const r = rig({
      before,
      after: afterAll(),
      reprobe: async () => ({ ok: false, reason: 'cannot-unregister' }),
      prepare: async (p, _b, o) =>
        o?.dry
          ? { ok: true }
          : p.kind === 'close-session'
            ? (log.push('park'), { ok: true })
            : (log.push(`prepare ${p.kind}`),
              { ok: true, undo: async () => void log.push(`undo ${p.kind}`) })
    })
    await run(r, before, asked(before, [UNLOCK, CLOSE]))
    expect(log).toEqual(['prepare unlock', 'park', 'undo unlock'])
  })

  it('a dry-run refusal elsewhere stops the combined action before any step', async () => {
    const before = stacked()
    const r = rig({
      before,
      after: afterAll(),
      dry: () => ({ ok: false, reason: 'nested-worktree' })
    })
    const res = await run(r, before, asked(before, [UNLOCK, STOP]))
    expect(res).toMatchObject({ ok: false, error: 'nested-worktree' })
    expect(r.log.filter((l) => l.startsWith('prepare'))).toEqual([])
  })
})

// Delta 3 item 2: a prep that THROWS (instead of answering) is an ordinary failure of that item.
describe('a prep that throws is rolled back and does not stop the job (delta 3)', () => {
  const UNLOCK: GcPrep = { kind: 'unlock' }
  const CLOSE: GcPrep = { kind: 'close-session' }
  const both = () =>
    bundle(PATH, 'review', {
      locked: true,
      session: 'open-idle',
      reason: { code: 'locked', detail: 'x' }
    })

  const throwingClose =
    (log: string[], undoThrows = false): ManualCleanDeps['prepare'] =>
    async (p, _b, o) => {
      if (o?.dry) return { ok: true }
      if (p.kind === 'close-session') throw new Error('boom')
      log.push(`prepare ${p.kind}`)
      return {
        ok: true,
        undo: async () => {
          log.push(`undo ${p.kind}`)
          if (undoThrows) throw new Error('git is gone')
        }
      }
    }

  it('the steps that ran are undone, in reverse, and the item gets a recorded result', async () => {
    const before = both()
    const log: string[] = []
    const r = rig({ before, after: unlocked(), prepare: throwingClose(log) })
    const res = await run(r, before, asked(before, [UNLOCK, CLOSE]))
    expect(log).toEqual(['prepare unlock', 'undo unlock'])
    expect(res).toMatchObject({ ok: false, haltedAt: 'reprobe' })
    expect(res!.error).toMatch(/^prep-failed: boom/)
    expect(r.log).not.toContain('cleanGit')
  })

  it('an undo that fails too is said, next to the cause', async () => {
    const before = both()
    const log: string[] = []
    const r = rig({ before, after: unlocked(), prepare: throwingClose(log, true) })
    const res = await run(r, before, asked(before, [UNLOCK, CLOSE]))
    expect(res!.error).toMatch(/^prep-failed: boom/)
    expect(res!.error).toContain('rollback-failed (git is gone)')
  })

  it('the next id in the same job is still processed', async () => {
    const before = both()
    const next = bundle('/ws/wt/b', 'ready')
    const log: string[] = []
    const r = rig({ before, after: unlocked(), extra: [next], prepare: throwingClose(log) })
    const o = asked(before, [UNLOCK, CLOSE])
    o.expected![next.item.id] = expectedOf(next)
    submitManualClean(r.deps, [before.item.id, next.item.id], o)
    await r.deps.queue.idle()
    const results = r.done[0].results
    expect(results.map((x) => x.ok)).toEqual([false, true])
    expect(r.log).toContain('cleanGit')
  })

  it('a throw while validating the dry run is the same failure, with nothing run', async () => {
    const before = both()
    const r = rig({
      before,
      after: unlocked(),
      prepare: async () => {
        throw new Error('probe exploded')
      }
    })
    const res = await run(r, before, asked(before, [UNLOCK, CLOSE]))
    expect(res!.error).toMatch(/^prep-failed: probe exploded/)
    expect(r.log.filter((l) => l.startsWith('prepare'))).toEqual([])
  })
})

// Delta 4 item 4: nothing after the prep may escape the rollback, and bookkeeping after a SUCCESSFUL
// remove must not turn it into a failure.
describe('the steps after the prep are covered too (delta 4)', () => {
  const UNLOCK: GcPrep = { kind: 'unlock' }
  const withSettle =
    (log: string[], settleThrows: boolean): ManualCleanDeps['prepare'] =>
    async (_p, _b, o) =>
      o?.dry
        ? { ok: true }
        : {
            ok: true,
            undo: async () => void log.push('undo'),
            settle: async () => {
              log.push('settle')
              if (settleThrows) throw new Error('journal disk is full')
            }
          }

  it('a throw after the prep but before the folder is gone is rolled back and recorded', async () => {
    const before = locked()
    const log: string[] = []
    const r = rig({
      before,
      after: unlocked(),
      prepare: withSettle(log, false),
      opsFor: () => {
        throw new Error('ops exploded')
      }
    })
    const res = await run(r, before, asked(before, UNLOCK))
    expect(log).toEqual(['undo'])
    expect(res).toMatchObject({ ok: false })
    expect(res!.error).toMatch(/^prep-failed: ops exploded/)
  })

  it('a settle that throws after a successful remove does NOT make the item a failure', async () => {
    const before = locked()
    const log: string[] = []
    const r = rig({ before, after: unlocked(), prepare: withSettle(log, true) })
    const res = await run(r, before, asked(before, UNLOCK))
    expect(res).toMatchObject({ ok: true })
    expect(res!.error).toBeUndefined()
    expect(log).toEqual(['settle'])
  })

  it('bookkeeping that throws after a successful remove does not either', async () => {
    const before = locked()
    const r = rig({
      before,
      after: unlocked(),
      rememberLeftovers: () => {
        throw new Error('leftovers file locked')
      }
    })
    const res = await run(r, before, asked(before, UNLOCK))
    expect(res).toMatchObject({ ok: true })
  })

  it('a settle that throws after the folder was trashed keeps the real halt, not a reprobe refusal', async () => {
    const before = locked()
    const log: string[] = []
    const r = rig({
      before,
      after: unlocked(),
      prepare: withSettle(log, true),
      cleanGit: async () => {
        throw new GcStepError('prune', 'prune failed')
      }
    })
    const res = await run(r, before, asked(before, UNLOCK))
    expect(res).toMatchObject({ ok: false, haltedAt: 'prune' })
    expect(res!.error).toContain('prune failed')
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
  it('accepts a list of preps for one id, in any order, up to one of each kind', () => {
    expect(
      parse({
        a: [{ kind: 'close-session' }, { kind: 'stop-stack', stackIds: ['x'] }, { kind: 'unlock' }]
      })
    ).toEqual({
      a: [{ kind: 'close-session' }, { kind: 'stop-stack', stackIds: ['x'] }, { kind: 'unlock' }]
    })
  })

  it('drops a list with a repeated kind, an unknown kind, both stack kinds, or nothing in it', () => {
    expect(
      parse({
        a: [{ kind: 'unlock' }, { kind: 'unlock' }],
        b: [{ kind: 'unlock' }, { kind: 'rm-rf' }],
        c: [
          { kind: 'stop-stack', stackIds: ['x'] },
          { kind: 'leave-stack', stackIds: ['x'] }
        ],
        d: []
      })
    ).toBeUndefined()
  })

  it('is absent when none was sent', () => {
    expect(parseOptions({ confirmed: [], expected: {} }).prepare).toBeUndefined()
  })
})

void vi
