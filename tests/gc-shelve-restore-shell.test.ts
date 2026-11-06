import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createShelveRestorer, type ShelveRestoreDeps } from '../src/main/gc/shelve-restore-shell'
import type { ShelveRecord } from '../src/main/gc/shelve-core'
import type { ShelvedEntry, ShelvedFile } from '../src/main/gc/shelve-store'
import type { RestoreResult, VerifyResult } from '../src/main/gc/shelve-shell'
import type { RepoLockResult } from '../src/main/gc/repo-lock-shell'
import { leftoverPathFor } from '../src/main/gc/shelve-restore-core'

const NOW = Date.UTC(2026, 10, 5, 9, 8, 7)

const entry: ShelvedEntry = {
  id: '/ws/repo::worktree::/t/feat-x',
  repoPath: '/ws/repo',
  worktreePath: '/t/feat-x',
  branch: 'feat/x',
  headSha: 'a'.repeat(40),
  namespace: 'refs/archive/feat/x/20261105T100000Z',
  shelvedAt: 1_000,
  idleDays: 9,
  reason: 'Shelved `feat/x` — idle 9 d, branch kept',
  freedBytes: 10
}

const record = { namespace: entry.namespace, worktreePath: entry.worktreePath } as ShelveRecord

const restoredOk = (): RestoreResult => ({
  ok: true,
  path: entry.worktreePath,
  attached: true,
  reason: null,
  stashes: []
})

interface Harness {
  deps: ShelveRestoreDeps
  store: { file: ShelvedFile }
  calls: string[]
  exists: { value: boolean }
  verify: { value: VerifyResult }
  inUse: { value: boolean }
  restore: ReturnType<typeof vi.fn>
  forget: ReturnType<typeof vi.fn>
  moveAside: ReturnType<typeof vi.fn>
  changed: ReturnType<typeof vi.fn>
  lockAnswers: Array<RepoLockResult<never> | 'run'>
}

function harness(over: Partial<ShelveRestoreDeps> = {}): Harness {
  const store = { file: { version: 1, entries: [entry] } as ShelvedFile }
  const calls: string[] = []
  const exists = { value: false }
  const verify = { value: { ok: true, mode: 'live' } as VerifyResult }
  const inUse = { value: false }
  const lockAnswers: Harness['lockAnswers'] = []
  const restore = vi.fn(async () => {
    calls.push('restore')
    // Let concurrent callers pile up while the restore is in flight.
    await new Promise((r) => setTimeout(r, 5))
    return restoredOk()
  })
  const forget = vi.fn(async (id: string) => {
    calls.push('forget')
    store.file = { version: 1, entries: store.file.entries.filter((e) => e.id !== id) }
  })
  const moveAside = vi.fn(async () => {
    calls.push('moveAside')
  })
  const changed = vi.fn()
  const deps: ShelveRestoreDeps = {
    readStore: async () => store.file,
    forget,
    readRecord: async () => record,
    restore,
    verifyLive: async () => verify.value,
    exists: async () => exists.value,
    inUse: async () => inUse.value,
    moveAside,
    lock: async <T>(_repo: string, work: () => Promise<T>): Promise<RepoLockResult<T>> => {
      calls.push('lock')
      const answer = lockAnswers.shift() ?? 'run'
      if (answer !== 'run') return answer as RepoLockResult<T>
      return { ok: true, value: await work() }
    },
    sleep: async () => undefined,
    now: () => NOW,
    changed,
    ...over
  }
  return {
    deps,
    store,
    calls,
    exists,
    verify,
    inUse,
    restore,
    forget,
    moveAside,
    changed,
    lockAnswers
  }
}

describe('createShelveRestorer.ensure', () => {
  let h: Harness
  beforeEach(() => {
    h = harness()
  })

  it('does nothing for a folder that is not shelved, and takes no lock', async () => {
    const out = await createShelveRestorer(h.deps).ensure('/elsewhere')
    expect(out).toEqual({ status: 'not-shelved' })
    expect(h.restore).not.toHaveBeenCalled()
    expect(h.calls).not.toContain('lock')
  })

  it('restores a shelved worktree whose folder is gone, then forgets the entry', async () => {
    const out = await createShelveRestorer(h.deps).ensure('/t/feat-x')
    expect(out).toEqual({ status: 'restored', entry, attached: true, movedAside: null })
    expect(h.calls).toEqual(['lock', 'restore', 'forget'])
    expect(h.changed).toHaveBeenCalledTimes(1)
  })

  it('restores once when two callers ask at the same time (worktree and a subfolder)', async () => {
    const r = createShelveRestorer(h.deps)
    const [a, b] = await Promise.all([r.ensure('/t/feat-x'), r.ensure('/t/feat-x/api')])
    expect(h.restore).toHaveBeenCalledTimes(1)
    expect(a).toEqual(b)
    expect(a.status).toBe('restored')
  })

  it('treats a whole folder as already present and drops the stale entry', async () => {
    h.exists.value = true
    const out = await createShelveRestorer(h.deps).ensure('/t/feat-x')
    expect(out).toEqual({ status: 'present', entry })
    expect(h.restore).not.toHaveBeenCalled()
    expect(h.forget).toHaveBeenCalledWith(entry.id)
  })

  it('refuses while a session is working in the folder that is in the way', async () => {
    h.exists.value = true
    h.verify.value = { ok: false, reason: 'worktree-changed', message: 'differs' }
    h.inUse.value = true
    const out = await createShelveRestorer(h.deps).ensure('/t/feat-x')
    expect(out).toMatchObject({ status: 'failed', reason: 'in-use' })
    expect(h.moveAside).not.toHaveBeenCalled()
    expect(h.restore).not.toHaveBeenCalled()
  })

  it('moves a folder in the way aside, never deletes it, then restores', async () => {
    h.exists.value = true
    h.verify.value = { ok: false, reason: 'worktree-changed', message: 'differs' }
    const out = await createShelveRestorer(h.deps).ensure('/t/feat-x')
    const aside = leftoverPathFor(entry.worktreePath, NOW)
    expect(h.moveAside).toHaveBeenCalledWith(entry.worktreePath, aside)
    expect(out).toEqual({ status: 'restored', entry, attached: true, movedAside: aside })
    expect(h.calls).toEqual(['lock', 'moveAside', 'restore', 'forget'])
  })

  it('leaves the moved folder where it is when the restore then fails', async () => {
    h.exists.value = true
    h.verify.value = { ok: false, reason: 'worktree-changed', message: 'differs' }
    h.restore.mockResolvedValueOnce({
      ok: false,
      reason: 'worktree-add-failed',
      message: 'boom'
    })
    const out = await createShelveRestorer(h.deps).ensure('/t/feat-x')
    expect(out).toMatchObject({ status: 'failed', reason: 'worktree-add-failed', message: 'boom' })
    expect(h.moveAside).toHaveBeenCalledTimes(1)
    expect(h.forget).not.toHaveBeenCalled()
  })

  it('fails with move-aside-failed and restores nothing when the move fails', async () => {
    h.exists.value = true
    h.verify.value = { ok: false, reason: 'worktree-changed', message: 'differs' }
    h.moveAside.mockRejectedValueOnce(new Error('EXDEV'))
    const out = await createShelveRestorer(h.deps).ensure('/t/feat-x')
    expect(out).toMatchObject({ status: 'failed', reason: 'move-aside-failed' })
    expect(h.restore).not.toHaveBeenCalled()
  })

  it('fails with record-missing and keeps the entry when the archive record is gone', async () => {
    const out = await createShelveRestorer(harness({ readRecord: async () => null }).deps).ensure(
      '/t/feat-x'
    )
    expect(out).toMatchObject({ status: 'failed', reason: 'record-missing' })
  })

  it('reports the engine reason and keeps the entry when restoreWorktree refuses', async () => {
    h.restore.mockResolvedValueOnce({
      ok: false,
      reason: 'archive-unverified',
      message: 'ref-missing: gone'
    })
    const out = await createShelveRestorer(h.deps).ensure('/t/feat-x')
    expect(out).toMatchObject({
      status: 'failed',
      reason: 'archive-unverified',
      message: 'ref-missing: gone'
    })
    expect(h.forget).not.toHaveBeenCalled()
  })

  it('gives up with repo-busy after five locked answers', async () => {
    for (let i = 0; i < 5; i++) {
      h.lockAnswers.push({ ok: false, reason: 'locked', holder: null })
    }
    const out = await createShelveRestorer(h.deps).ensure('/t/feat-x')
    expect(out).toMatchObject({ status: 'failed', reason: 'repo-busy' })
    expect(h.restore).not.toHaveBeenCalled()
  })

  it('goes ahead when the lock frees up on the third try', async () => {
    h.lockAnswers.push({ ok: false, reason: 'locked', holder: null })
    h.lockAnswers.push({ ok: false, reason: 'locked', holder: null })
    const out = await createShelveRestorer(h.deps).ensure('/t/feat-x')
    expect(out.status).toBe('restored')
  })

  it('stops at once when the lock is unavailable', async () => {
    h.lockAnswers.push({ ok: false, reason: 'unavailable', message: 'no git dir' })
    const out = await createShelveRestorer(h.deps).ensure('/t/feat-x')
    expect(out).toMatchObject({ status: 'failed', reason: 'repo-busy', message: 'no git dir' })
  })

  it('stays restored when only forgetting the entry fails, and sees it as present next time', async () => {
    h.forget.mockRejectedValueOnce(new Error('disk full'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const r = createShelveRestorer(h.deps)
    const first = await r.ensure('/t/feat-x')
    expect(first.status).toBe('restored')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
    h.exists.value = true
    const second = await r.ensure('/t/feat-x')
    expect(second.status).toBe('present')
  })
})

describe('createShelveRestorer.restoreById', () => {
  it('restores the entry with that id and answers not-shelved for an unknown one', async () => {
    const h = harness()
    const r = createShelveRestorer(h.deps)
    expect((await r.restoreById('nope')).status).toBe('not-shelved')
    expect((await r.restoreById(entry.id)).status).toBe('restored')
  })
})
