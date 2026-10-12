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
  type PrepJournal,
  type RecoveryDeps
} from '../src/main/gc/gc-prep-journal'

/** The next run's journal over the same file: what was left `pending` is an orphan to it. */
const boot = (): PrepJournal => createPrepJournal(file, 'boot')

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
    const j = createPrepJournal(file, 'previous-run')
    const id = await j.begin(unlockEntry)
    const again = await createPrepJournal(file).entries()
    expect(again).toHaveLength(1)
    expect(again[0]).toMatchObject({ id, ...unlockEntry, state: 'pending', announced: false })
  })

  it('end removes only its own entry', async () => {
    const j = createPrepJournal(file, 'previous-run')
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

describe('boot recovery leaves this run’s own entries alone', () => {
  it('an entry written by the running Harnu is a prep in flight, not an orphan', async () => {
    const mine = createPrepJournal(file, 'run-now')
    await mine.begin(unlockEntry)
    const { deps, calls } = world()
    await recoverPrepJournal(mine, deps)
    expect(calls.lock).toEqual([])
    expect((await mine.entries())[0]).toMatchObject({ state: 'pending' })
    // The next run sees it as an orphan.
    await recoverPrepJournal(createPrepJournal(file, 'run-next'), deps)
    expect(calls.lock).toHaveLength(1)
  })
})

describe('boot recovery: a lock', () => {
  it('is put back when it is provably the same worktree, and announced once', async () => {
    const j = createPrepJournal(file, 'previous-run')
    await j.begin(unlockEntry)
    const { deps, calls } = world()
    await recoverPrepJournal(boot(), deps)
    expect(calls.lock).toEqual([['/r/wt', 'café "x" 日本']])
    const items = await listRecovery(j)
    expect(items).toEqual([expect.objectContaining({ state: 'resolved', outcome: 'relocked' })])
  })

  it('is NOT put back on a folder re-created at the same path (a different admin dir)', async () => {
    const j = createPrepJournal(file, 'previous-run')
    await j.begin(unlockEntry)
    const { deps, calls } = world({ identityOf: async () => ({ ...ID, adminId: 'wt1' }) })
    await recoverPrepJournal(boot(), deps)
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
    const j = createPrepJournal(file, 'previous-run')
    await j.begin(unlockEntry)
    const { deps, calls } = world({ identityOf: async () => ({ ...ID, ...change }) })
    await recoverPrepJournal(boot(), deps)
    expect(calls.lock).toEqual([])
    expect((await listRecovery(j))[0]).toMatchObject({ notice: 'lock-skipped' })
  })

  it('is NOT put back when no identity was recorded', async () => {
    const j = createPrepJournal(file, 'previous-run')
    await j.begin({ ...unlockEntry, identity: null })
    const { deps, calls } = world()
    await recoverPrepJournal(boot(), deps)
    expect(calls.lock).toEqual([])
    expect((await listRecovery(j))[0]).toMatchObject({ notice: 'lock-skipped' })
  })

  it('already locked again: nothing to do, nothing to announce', async () => {
    const j = createPrepJournal(file, 'previous-run')
    await j.begin(unlockEntry)
    const { deps, calls } = world({ lockReason: async () => 'x' })
    await recoverPrepJournal(boot(), deps)
    expect(calls.lock).toEqual([])
    expect(await listRecovery(j)).toEqual([])
    expect(await j.entries()).toEqual([])
  })

  it('a folder that is gone: nothing to do, nothing to announce', async () => {
    const j = createPrepJournal(file, 'previous-run')
    await j.begin(unlockEntry)
    const { deps, calls } = world({ exists: async () => false })
    await recoverPrepJournal(boot(), deps)
    expect(calls.lock).toEqual([])
    expect(await j.entries()).toEqual([])
  })

  it('a lock that cannot be put back becomes a notice, never a silent failure', async () => {
    const j = createPrepJournal(file, 'previous-run')
    await j.begin(unlockEntry)
    const { deps } = world({
      lock: async () => {
        throw new Error('git is gone')
      }
    })
    await recoverPrepJournal(boot(), deps)
    // The worktree IS the same one: the notice must say the lock failed, not that it is a different worktree.
    expect((await listRecovery(j))[0]).toMatchObject({
      state: 'notice',
      notice: 'lock-failed',
      detail: expect.stringContaining('git is gone')
    })
  })
})

describe('boot recovery: containers are never started by Harnu on its own', () => {
  it('an interrupted stop is a notice naming the containers, and nothing is started', async () => {
    const j = createPrepJournal(file, 'previous-run')
    await j.begin(stopEntry)
    const { deps, calls } = world()
    await recoverPrepJournal(boot(), deps)
    expect(calls.started).toEqual([])
    expect(await listRecovery(j)).toEqual([
      expect.objectContaining({ state: 'notice', notice: 'stack-stopped', detail: 'n1, n2' })
    ])
  })

  it('containers that no longer exist: one notice, dismissable', async () => {
    const j = createPrepJournal(file, 'previous-run')
    await j.begin(stopEntry)
    const { deps } = world({ containersPresent: async () => [] })
    await recoverPrepJournal(boot(), deps)
    expect((await listRecovery(j))[0]).toMatchObject({ notice: 'containers-gone' })
  })

  it('a folder that is gone is dropped without a notice', async () => {
    const j = createPrepJournal(file, 'previous-run')
    await j.begin(stopEntry)
    const { deps } = world({ exists: async () => false })
    await recoverPrepJournal(boot(), deps)
    expect(await listRecovery(j)).toEqual([])
    expect(await j.entries()).toEqual([])
  })
})

describe('notices are announced once, kept until dismissed, and survive a lost announcement', () => {
  it('the next boot does not process or announce them again', async () => {
    const j = createPrepJournal(file, 'previous-run')
    await j.begin(stopEntry)
    const first = world()
    await recoverPrepJournal(boot(), first.deps)
    const items = await listRecovery(j)
    await ackRecovery(
      j,
      items.map((i) => i.id)
    )

    const second = world()
    await recoverPrepJournal(boot(), second.deps)
    const after = await listRecovery(j)
    expect(after).toHaveLength(1)
    expect(after[0]).toMatchObject({ id: items[0].id, announced: true })
    expect(second.calls.started).toEqual([])
  })

  it('an announcement nobody acknowledged is listed again, so it cannot be lost', async () => {
    const j = createPrepJournal(file, 'previous-run')
    await j.begin(unlockEntry)
    await recoverPrepJournal(boot(), world().deps)
    expect((await listRecovery(j))[0]).toMatchObject({ announced: false })
    // The renderer never acknowledged (it was not up yet): the next listing still has it.
    expect((await listRecovery(j))[0]).toMatchObject({ announced: false })
  })

  it('acknowledging a resolved entry removes it; a notice stays', async () => {
    const j = createPrepJournal(file, 'previous-run')
    await j.begin(unlockEntry)
    await j.begin(stopEntry)
    await recoverPrepJournal(boot(), world().deps)
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
    const j = createPrepJournal(file, 'previous-run')
    await j.begin(entry)
    await recoverPrepJournal(boot(), deps)
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

// Delta 4 item 2: starting containers whose folders are gone would make docker recreate empty folders.
describe('Start again checks the folders are still there (delta 4)', () => {
  const noticeOf = async (deps: RecoveryDeps) => {
    const j = createPrepJournal(file, 'previous-run')
    await j.begin(stopEntry)
    await recoverPrepJournal(boot(), world().deps)
    const [item] = await listRecovery(j, deps)
    return { j, item }
  }

  it('offers Start again only when the worktree and every bind source exist', async () => {
    const w = world()
    const { item } = await noticeOf(w.deps)
    expect(item).toMatchObject({ notice: 'stack-stopped', canStart: true })
  })

  it('a missing bind source: no Start again, and the reason says why', async () => {
    const w = world({ exists: async (p) => p !== '/ws/infra' })
    const { item } = await noticeOf(w.deps)
    expect(item.canStart).toBe(false)
    expect(item.cannotStart).toContain('/ws/infra')
    expect(item.cannotStart).toMatch(/recreate empty folders/)
  })

  it('a missing worktree folder: no Start again', async () => {
    const w = world({ exists: async (p) => p !== '/r/wt' })
    const { item } = await noticeOf(w.deps)
    expect(item.canStart).toBe(false)
  })

  it('the click re-checks: a folder that vanished since the listing refuses, and starts nothing', async () => {
    const w = world()
    const { j, item } = await noticeOf(w.deps)
    const gone = world({ exists: async (p) => p !== '/ws/infra' })
    const r = await actOnRecovery(j, item.id, 'start', gone.deps)
    expect(r).toMatchObject({ ok: false })
    expect((r as { error: string }).error).toMatch(/recreate empty folders/)
    expect(gone.calls.started).toEqual([])
    expect(await j.entries()).toHaveLength(1)
  })

  it('Dismiss is still answerable when starting is not', async () => {
    const gone = world({ exists: async () => false })
    const { j, item } = await noticeOf(world().deps)
    expect(await actOnRecovery(j, item.id, 'dismiss', gone.deps)).toEqual({ ok: true })
  })
})

// Delta 4 item 5: a birth time of 0 is "unknown" (the filesystem did not say), which proves nothing.
describe('an unknown birth time is not a match (delta 4)', () => {
  it('both sides 0: the lock is NOT put back, and the operator is told', async () => {
    const j = createPrepJournal(file, 'previous-run')
    const unknown = { ...ID, birth: 0 }
    await j.begin({ ...unlockEntry, identity: unknown })
    const { deps, calls } = world({ identityOf: async () => unknown })
    await recoverPrepJournal(boot(), deps)
    expect(calls.lock).toEqual([])
    expect((await listRecovery(j))[0]).toMatchObject({ state: 'notice', notice: 'lock-skipped' })
  })

  it('a known birth time on both sides still matches', async () => {
    const j = createPrepJournal(file, 'previous-run')
    await j.begin(unlockEntry)
    const { deps, calls } = world()
    await recoverPrepJournal(boot(), deps)
    expect(calls.lock).toHaveLength(1)
  })
})

// Delta 4 item 3: "Lock again" checks who the worktree is NOW, and never locks silently.
describe('Lock again re-checks the identity at click time (delta 4)', () => {
  const skipped = async (identityNow: LockIdentity | null) => {
    const j = createPrepJournal(file, 'previous-run')
    await j.begin(unlockEntry)
    const w = world({ identityOf: async () => ({ ...ID, adminId: 'other' }) })
    await recoverPrepJournal(boot(), w.deps)
    const [item] = await listRecovery(j)
    const click = world({ identityOf: async () => identityNow })
    return { j, item, click }
  }

  it('an identity that matches now: locked with the recorded reason', async () => {
    const { j, item, click } = await skipped(ID)
    expect(await actOnRecovery(j, item.id, 'lock', click.deps)).toEqual({ ok: true })
    expect(click.calls.lock).toEqual([['/r/wt', 'café "x" 日本']])
    expect(await j.entries()).toEqual([])
  })

  it('an identity that still does not match: NOT locked, and the mismatch is named', async () => {
    const { j, item, click } = await skipped({ ...ID, adminId: 'other' })
    const r = await actOnRecovery(j, item.id, 'lock', click.deps)
    expect(r).toMatchObject({ ok: false })
    expect((r as { mismatch: string }).mismatch).toContain('admin directory')
    expect(click.calls.lock).toEqual([])
    expect((await listRecovery(j))[0].mismatch).toContain('admin directory')
  })

  it.each([
    ['gitdir', { gitdir: '/elsewhere/.git' }, 'gitdir'],
    ['HEAD', { head: 'b'.repeat(40) }, 'commit'],
    ['creation time', { birth: 0 }, 'creation time']
  ])('names a %s mismatch', async (_n, change, word) => {
    const { j, item, click } = await skipped({ ...ID, ...change })
    const r = await actOnRecovery(j, item.id, 'lock', click.deps)
    expect((r as { mismatch: string }).mismatch).toContain(word)
  })

  it('git no longer has a registration for it: said, not locked', async () => {
    const { j, item, click } = await skipped(null)
    const r = await actOnRecovery(j, item.id, 'lock', click.deps)
    expect((r as { mismatch: string }).mismatch).toContain('no registration')
    expect(click.calls.lock).toEqual([])
  })

  it('"Lock this worktree anyway" is only possible after the mismatch was shown', async () => {
    const { j, item, click } = await skipped({ ...ID, adminId: 'other' })
    const early = await actOnRecovery(j, item.id, 'lock-anyway', click.deps)
    expect(early).toMatchObject({ ok: false })
    expect(click.calls.lock).toEqual([])
    await actOnRecovery(j, item.id, 'lock', click.deps)
    expect(await actOnRecovery(j, item.id, 'lock-anyway', click.deps)).toEqual({ ok: true })
    expect(click.calls.lock).toEqual([['/r/wt', 'café "x" 日本']])
    expect(await j.entries()).toEqual([])
  })

  it('anyway still needs the folder, and does not fit a stack notice', async () => {
    const { j, item, click } = await skipped({ ...ID, adminId: 'other' })
    await actOnRecovery(j, item.id, 'lock', click.deps)
    const gone = world({ exists: async () => false })
    expect(await actOnRecovery(j, item.id, 'lock-anyway', gone.deps)).toMatchObject({ ok: false })
    const j2 = createPrepJournal(file, 'previous-run')
    await j2.begin(stopEntry)
    await recoverPrepJournal(boot(), world().deps)
    const stack = (await listRecovery(j2)).find((i) => i.kind === 'stop-stack')!
    expect(await actOnRecovery(j2, stack.id, 'lock-anyway', world().deps)).toMatchObject({
      ok: false
    })
  })
})
