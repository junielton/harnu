import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/**
 * Delta-2 item 1, proof (a): Harnu keeps its own record of the folders it removed, written at the one
 * door every removal path ends at (`detachFromSidebar`), so a folder it removed is positively known
 * to be gone however it was removed.
 *
 * Isolation (BUG-215): every test gets its OWN module instances, each bound to its own temp dir. The
 * ledger module keeps a write queue, and the body of a test that timed out keeps running after the
 * runner moved on, so a shared module reading a shared "current dir" let a dead test's in-flight
 * writes land in the next test's ledger. Here a stale write can only ever reach its own dir.
 */

type Ledger = typeof import('../src/main/gc/gc-removed-folders')
type Sidebar = typeof import('../src/main/user-projects')

interface Fresh {
  userData: string
  ledger: Ledger
  sidebar: Sidebar
}

const made: Fresh[] = []

/** A fresh userData dir plus fresh instances of the ledger and the removal door bound to it. */
async function fresh(): Promise<Fresh> {
  const userData = mkdtempSync(path.join(os.tmpdir(), 'harnu-ledger-'))
  vi.resetModules()
  vi.doMock('electron', () => ({
    app: { getPath: (): string => userData },
    ipcMain: { handle: (): void => {} }
  }))
  vi.doMock('../src/main/claude-reader', () => ({ scanFolders: async () => [] }))
  const ctx: Fresh = {
    userData,
    ledger: await import('../src/main/gc/gc-removed-folders'),
    sidebar: await import('../src/main/user-projects')
  }
  made.push(ctx)
  return ctx
}

describe('the ledger of folders Harnu removed', () => {
  // Reassigned per test: a test body binds what it needs from `ctx` up front, before its first
  // `await`, so a body that outlives its test keeps talking to its own instances.
  let ctx: Fresh

  beforeEach(async () => {
    ctx = await fresh()
  })
  afterEach(async () => {
    for (const c of made.splice(0)) {
      // Let this test's queued writes finish first, so none recreates the dir after it is removed.
      await c.ledger.recordRemovedFolder('/w/_drain')
      rmSync(c.userData, { recursive: true, force: true })
    }
  })

  it('starts empty and reads back what was recorded, once each', async () => {
    const { readRemovedFolders, recordRemovedFolder } = ctx.ledger
    expect(await readRemovedFolders()).toEqual([])
    await recordRemovedFolder('/w/a')
    await recordRemovedFolder('/w/b')
    await recordRemovedFolder('/w/a')
    expect((await readRemovedFolders()).sort()).toEqual(['/w/a', '/w/b'])
  })

  it('is bounded: the oldest entries go first', async () => {
    const { userData } = ctx
    const { MAX_REMOVED_FOLDERS, readRemovedFolders, recordRemovedFolder } = ctx.ledger
    // Start from a full ledger (oldest first) instead of filling it one slow write at a time.
    const full = Array.from({ length: MAX_REMOVED_FOLDERS }, (_, i) => `/w/f${i}`)
    writeFileSync(
      path.join(userData, 'removed-folders.json'),
      JSON.stringify({ version: 1, folders: full })
    )
    for (let i = MAX_REMOVED_FOLDERS; i < MAX_REMOVED_FOLDERS + 5; i++) {
      await recordRemovedFolder(`/w/f${i}`)
    }
    // Exactly the newest MAX entries, in order: f0..f4 went, f5 is now the oldest.
    const expected = Array.from({ length: MAX_REMOVED_FOLDERS }, (_, i) => `/w/f${i + 5}`)
    expect(await readRemovedFolders()).toEqual(expected)
  })

  it('a damaged file reads as nothing recorded, never as an error', async () => {
    const { userData } = ctx
    const { readRemovedFolders, recordRemovedFolder } = ctx.ledger
    writeFileSync(path.join(userData, 'removed-folders.json'), '{not json')
    expect(await readRemovedFolders()).toEqual([])
    await recordRemovedFolder('/w/a')
    expect(await readRemovedFolders()).toEqual(['/w/a'])
  })

  it('the shared removal door records the folder it was told is gone', async () => {
    const { ledger, sidebar } = ctx
    await sidebar.detachFromSidebar(() => null, '/nonexistent/unit-d/removed/wt')
    expect(await ledger.readRemovedFolders()).toContain('/nonexistent/unit-d/removed/wt')
  })

  it('a write still in flight from an earlier test never shows up in the next one', async () => {
    const { ledger } = ctx
    // The earlier test: it starts a write and is abandoned (as a timed-out test is) before it settles.
    const stale = ledger.recordRemovedFolder('/w/stale')
    // The next test: its own instances, its own dir.
    const next = await fresh()
    await stale
    expect(await ledger.readRemovedFolders()).toEqual(['/w/stale']) // landed in its own dir
    expect(await next.ledger.readRemovedFolders()).toEqual([]) // and nowhere else
  })
})
