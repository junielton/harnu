// Delta 2 item 6: a guided prep writes what it is about to change BEFORE changing it, so quitting (or
// crashing) mid-prep cannot lose a lock or leave a stack stopped for good. On the next boot an orphaned
// entry whose worktree folder is still there is put back.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createPrepJournal, recoverPrepJournal } from '../src/main/gc/gc-prep-journal'

let dir = ''
let file = ''
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'harnu-prep-journal-'))
  file = path.join(dir, 'gc-prep-journal.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const unlockEntry = {
  kind: 'unlock' as const,
  at: 1,
  repoPath: '/r',
  path: '/r/wt',
  reason: 'não mexer "x"'
}
const stopEntry = {
  kind: 'stop-stack' as const,
  at: 2,
  path: '/r/wt',
  containerIds: ['c1', 'c2'],
  containerNames: ['n1', 'n2'],
  bindSources: ['/r/wt/data', '/ws/infra']
}

describe('the prep journal', () => {
  it('survives a restart: an entry written is read back, byte for byte', async () => {
    const j = createPrepJournal(file)
    const id = await j.begin(unlockEntry)
    const again = await createPrepJournal(file).entries()
    expect(again).toHaveLength(1)
    expect(again[0]).toMatchObject({ id, ...unlockEntry })
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

describe('boot recovery', () => {
  const deps = (over: Partial<Parameters<typeof recoverPrepJournal>[1]> = {}) => {
    const calls = { lock: [] as Array<[string, string | null]>, started: [] as string[][] }
    return {
      calls,
      deps: {
        exists: async () => true,
        lockReason: async () => undefined as string | null | undefined,
        lock: async (_r: string, p: string, reason: string | null) =>
          void calls.lock.push([p, reason]),
        start: async (ids: string[]) => (calls.started.push(ids), { done: ids, error: null }),
        ...over
      }
    }
  }

  it('re-locks an orphaned unlock with the original reason', async () => {
    const j = createPrepJournal(file)
    await j.begin(unlockEntry)
    const { deps: d, calls } = deps()
    const report = await recoverPrepJournal(j, d)
    expect(calls.lock).toEqual([['/r/wt', 'não mexer "x"']])
    expect(report).toEqual([expect.objectContaining({ outcome: 'relocked', path: '/r/wt' })])
    expect(await j.entries()).toEqual([])
  })

  it('a worktree that is already locked again is left alone, and the entry is cleared', async () => {
    const j = createPrepJournal(file)
    await j.begin(unlockEntry)
    const { deps: d, calls } = deps({ lockReason: async () => 'x' })
    await recoverPrepJournal(j, d)
    expect(calls.lock).toEqual([])
    expect(await j.entries()).toEqual([])
  })

  it('a worktree whose folder is gone has nothing to roll back to', async () => {
    const j = createPrepJournal(file)
    await j.begin(unlockEntry)
    await j.begin(stopEntry)
    const { deps: d, calls } = deps({ exists: async () => false })
    const report = await recoverPrepJournal(j, d)
    expect(calls.lock).toEqual([])
    expect(calls.started).toEqual([])
    expect(report.map((r) => r.outcome)).toEqual(['dropped', 'dropped'])
    expect(await j.entries()).toEqual([])
  })

  it('starts again the containers a stop left stopped, when their bind sources still exist', async () => {
    const j = createPrepJournal(file)
    await j.begin(stopEntry)
    const { deps: d, calls } = deps()
    const report = await recoverPrepJournal(j, d)
    expect(calls.started).toEqual([['c1', 'c2']])
    expect(report).toEqual([expect.objectContaining({ outcome: 'restarted' })])
    expect(await j.entries()).toEqual([])
  })

  it('does not start containers whose bind source is gone, and says they were left', async () => {
    const j = createPrepJournal(file)
    await j.begin(stopEntry)
    const { deps: d, calls } = deps({ exists: async (p: string) => p !== '/ws/infra' })
    const report = await recoverPrepJournal(j, d)
    expect(calls.started).toEqual([])
    expect(report).toEqual([expect.objectContaining({ outcome: 'left' })])
    expect(await j.entries()).toEqual([])
  })

  it('a rollback that fails keeps the entry for the next boot and says so', async () => {
    const j = createPrepJournal(file)
    await j.begin(unlockEntry)
    const { deps: d } = deps({
      lock: async () => {
        throw new Error('git is gone')
      }
    })
    const report = await recoverPrepJournal(j, d)
    expect(report).toEqual([expect.objectContaining({ outcome: 'failed' })])
    expect(await j.entries()).toHaveLength(1)
  })
})
