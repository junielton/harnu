// A guided prep writes what it is about to change BEFORE changing it, so quitting (or crashing) mid-prep
// cannot lose a lock or leave a stack stopped for good (delta 2). At the next boot (delta 3):
//   - a lock is put back ONLY when the worktree is provably the same one (admin id, gitdir, HEAD);
//   - containers are NEVER started automatically: an interrupted stop becomes a notice the operator
//     answers ("Start again" / "Leave stopped");
//   - every entry that needs the operator stays as a notice until dismissed, is announced ONCE, and is
//     kept until the renderer acknowledges the announcement.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  ackRecovery,
  actOnRecovery,
  createPrepJournal,
  listRecovery,
  recoverPrepJournal,
  type LockIdentity,
  type RecoveryDeps
} from '../src/main/gc/gc-prep-journal'

let dir = ''
let file = ''
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'harnu-prep-journal-'))
  file = path.join(dir, 'gc-prep-journal.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const ID: LockIdentity = {
  adminId: 'wt',
  gitdir: '/r/wt/.git',
  head: 'a'.repeat(40),
  inode: 42,
  birth: 1_000
}
const unlockEntry = {
  kind: 'unlock' as const,
  at: 1,
  repoPath: '/r',
  path: '/r/wt',
  reason: 'café "x" 日本',
  identity: ID
}
const stopEntry = {
  kind: 'stop-stack' as const,
  at: 2,
  path: '/r/wt',
  containerIds: ['c1', 'c2'],
  containerNames: ['n1', 'n2'],
  bindSources: ['/r/wt/data', '/ws/infra']
}

interface Calls {
  lock: Array<[string, string | null]>
  lockedPlain: string[]
  started: string[][]
}
function world(over: Partial<RecoveryDeps> = {}): { calls: Calls; deps: RecoveryDeps } {
  const calls: Calls = { lock: [], lockedPlain: [], started: [] }
  return {
    calls,
    deps: {
      exists: async () => true,
      lockReason: async () => undefined,
      identityOf: async () => ID,
      lock: async (_r, p, reason) => void calls.lock.push([p, reason]),
      containersPresent: async (ids) => ids,
      start: async (ids) => (calls.started.push(ids), { done: ids, error: null }),
      ...over
    }
  }
}

describe('the prep journal', () => {
  it('survives a restart: an entry written is read back, byte for byte', async () => {
    const j = createPrepJournal(file)
    const id = await j.begin(unlockEntry)
    const again = await createPrepJournal(file).entries()
    expect(again).toHaveLength(1)
    expect(again[0]).toMatchObject({ id, ...unlockEntry, state: 'pending', announced: false })
  })

  it('end removes only its own entry', async () => {
    const j = createPrepJournal(file)
    const a = await j.begin(unlockEntry)
    await j.begin(stopEntry)
    await j.end(a)
    expect((await j.entries()).map((e) => e.kind)).toEqual(['stop-stack'])
  })

  it('a missing or corrupt file reads as empty and never throws', async () => {
    expect(await createPrepJournal(file).entries()).toEqual([])
    const fs = await import('node:fs/promises')
    await fs.writeFile(file, '{ not json')
    expect(await createPrepJournal(file).entries()).toEqual([])
  })
})

describe('boot recovery: a lock', () => {
  it('is put back when it is provably the same worktree, and announced once', async () => {
    const j = createPrepJournal(file)
    await j.begin(unlockEntry)
    const { deps, calls } = world()
    await recoverPrepJournal(j, deps)
    expect(calls.lock).toEqual([['/r/wt', 'café "x" 日本']])
    const items = await listRecovery(j)
    expect(items).toEqual([expect.objectContaining({ state: 'resolved', outcome: 'relocked' })])
  })

  it('is NOT put back on a folder re-created at the same path (a different admin dir)', async () => {
    const j = createPrepJournal(file)
    await j.begin(unlockEntry)
    const { deps, calls } = world({ identityOf: async () => ({ ...ID, adminId: 'wt1' }) })
    await recoverPrepJournal(j, deps)
    expect(calls.lock).toEqual([])
    expect(await listRecovery(j)).toEqual([
      expect.objectContaining({ state: 'notice', notice: 'lock-skipped', path: '/r/wt' })
    ])
  })

  it.each([
    ['gitdir', { gitdir: '/elsewhere/.git' }],
    ['HEAD', { head: 'b'.repeat(40) }],
    // A worktree removed and added again at the same path gets the same admin id, gitdir and HEAD back,
    // but it is a new admin directory.
    ['admin directory (re-created with the same names)', { inode: 43, birth: 2_000 }]
  ])('is NOT put back when the %s changed', async (_what, change) => {
    const j = createPrepJournal(file)
    await j.begin(unlockEntry)
    const { deps, calls } = world({ identityOf: async () => ({ ...ID, ...change }) })
    await recoverPrepJournal(j, deps)
    expect(calls.lock).toEqual([])
    expect((await listRecovery(j))[0]).toMatchObject({ notice: 'lock-skipped' })
  })

  it('is NOT put back when no identity was recorded', async () => {
    const j = createPrepJournal(file)
    await j.begin({ ...unlockEntry, identity: null })
    const { deps, calls } = world()
    await recoverPrepJournal(j, deps)
    expect(calls.lock).toEqual([])
    expect((await listRecovery(j))[0]).toMatchObject({ notice: 'lock-skipped' })
  })

  it('already locked again, or a folder that is gone: nothing to do, nothing to announce', async () => {
    const j = createPrepJournal(file)
    await j.begin(unlockEntry)
    await j.begin(unlockEntry)
    let n = 0
    const { deps, calls } = world({
      lockReason: async () => (n++ === 0 ? 'x' : undefined),
      exists: async () => n < 2
    })
    await recoverPrepJournal(j, deps)
    expect(calls.lock).toEqual([])
    expect(await listRecovery(j)).toEqual([])
    expect(await j.entries()).toEqual([])
  })

  it('a lock that cannot be put back becomes a notice, never a silent failure', async () => {
    const j = createPrepJournal(file)
    await j.begin(unlockEntry)
    const { deps } = world({
      lock: async () => {
        throw new Error('git is gone')
      }
    })
    await recoverPrepJournal(j, deps)
    expect((await listRecovery(j))[0]).toMatchObject({
      state: 'notice',
      notice: 'lock-skipped',
      detail: expect.stringContaining('git is gone')
    })
  })
})

describe('boot recovery: containers are never started by Harnu on its own', () => {
  it('an interrupted stop is a notice naming the containers, and nothing is started', async () => {
    const j = createPrepJournal(file)
    await j.begin(stopEntry)
    const { deps, calls } = world()
    await recoverPrepJournal(j, deps)
    expect(calls.started).toEqual([])
    expect(await listRecovery(j)).toEqual([
      expect.objectContaining({ state: 'notice', notice: 'stack-stopped', detail: 'n1, n2' })
    ])
  })

  it('containers that no longer exist: one notice, dismissable', async () => {
    const j = createPrepJournal(file)
    await j.begin(stopEntry)
    const { deps } = world({ containersPresent: async () => [] })
    await recoverPrepJournal(j, deps)
    expect((await listRecovery(j))[0]).toMatchObject({ notice: 'containers-gone' })
  })

  it('a folder that is gone is dropped without a notice', async () => {
    const j = createPrepJournal(file)
    await j.begin(stopEntry)
    const { deps } = world({ exists: async () => false })
    await recoverPrepJournal(j, deps)
    expect(await listRecovery(j)).toEqual([])
    expect(await j.entries()).toEqual([])
  })
})

describe('notices are announced once, kept until dismissed, and survive a lost announcement', () => {
  it('the next boot does not process or announce them again', async () => {
    const j = createPrepJournal(file)
    await j.begin(stopEntry)
    const first = world()
    await recoverPrepJournal(j, first.deps)
    const items = await listRecovery(j)
    await ackRecovery(
      j,
      items.map((i) => i.id)
    )

    const second = world()
    await recoverPrepJournal(j, second.deps)
    const after = await listRecovery(j)
    expect(after).toHaveLength(1)
    expect(after[0]).toMatchObject({ id: items[0].id, announced: true })
    expect(second.calls.started).toEqual([])
  })

  it('an announcement nobody acknowledged is listed again, so it cannot be lost', async () => {
    const j = createPrepJournal(file)
    await j.begin(unlockEntry)
    await recoverPrepJournal(j, world().deps)
    expect((await listRecovery(j))[0]).toMatchObject({ announced: false })
    // The renderer never acknowledged (it was not up yet): the next listing still has it.
    expect((await listRecovery(j))[0]).toMatchObject({ announced: false })
  })

  it('acknowledging a resolved entry removes it; a notice stays', async () => {
    const j = createPrepJournal(file)
    await j.begin(unlockEntry)
    await j.begin(stopEntry)
    await recoverPrepJournal(j, world().deps)
    const items = await listRecovery(j)
    await ackRecovery(
      j,
      items.map((i) => i.id)
    )
    expect((await listRecovery(j)).map((i) => i.state)).toEqual(['notice'])
  })
})

describe('the operator answers a notice', () => {
  const noticeFor = async (
    entry: Parameters<ReturnType<typeof createPrepJournal>['begin']>[0],
    deps: RecoveryDeps
  ) => {
    const j = createPrepJournal(file)
    await j.begin(entry)
    await recoverPrepJournal(j, deps)
    return { j, id: (await listRecovery(j))[0].id }
  }

  it('Leave stopped (dismiss) clears it, and nothing is started', async () => {
    const w = world()
    const { j, id } = await noticeFor(stopEntry, w.deps)
    expect(await actOnRecovery(j, id, 'dismiss', w.deps)).toEqual({ ok: true })
    expect(await j.entries()).toEqual([])
    expect(w.calls.started).toEqual([])
  })

  it('Start again starts exactly those containers, then clears it', async () => {
    const w = world()
    const { j, id } = await noticeFor(stopEntry, w.deps)
    expect(await actOnRecovery(j, id, 'start', w.deps)).toEqual({ ok: true })
    expect(w.calls.started).toEqual([['c1', 'c2']])
    expect(await j.entries()).toEqual([])
  })

  it('Start again that fails keeps the notice and says why', async () => {
    const w = world({ start: async () => ({ done: [], error: 'daemon gone' }) })
    const { j, id } = await noticeFor(stopEntry, w.deps)
    expect(await actOnRecovery(j, id, 'start', w.deps)).toEqual({ ok: false, error: 'daemon gone' })
    expect(await j.entries()).toHaveLength(1)
  })

  it('Lock again locks the worktree with its recorded reason, then clears it', async () => {
    const w = world({ identityOf: async () => ({ ...ID, adminId: 'other' }) })
    const { j, id } = await noticeFor(unlockEntry, w.deps)
    expect(await actOnRecovery(j, id, 'lock', w.deps)).toEqual({ ok: true })
    expect(w.calls.lock).toEqual([['/r/wt', 'café "x" 日本']])
    expect(await j.entries()).toEqual([])
  })

  it('an action only fits its own kind of notice', async () => {
    const w = world()
    const { j, id } = await noticeFor(stopEntry, w.deps)
    expect(await actOnRecovery(j, id, 'lock', w.deps)).toMatchObject({ ok: false })
    expect(await actOnRecovery(j, 'nope', 'dismiss', w.deps)).toMatchObject({ ok: false })
  })
})
