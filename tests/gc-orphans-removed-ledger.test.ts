import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/**
 * Delta-2 item 1, proof (a): Harnu keeps its own record of the folders it removed, written at the one
 * door every removal path ends at (`detachFromSidebar`), so a folder it removed is positively known
 * to be gone however it was removed.
 */

const h = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({
  app: { getPath: (): string => h.userData },
  ipcMain: { handle: (): void => {} }
}))
vi.mock('../src/main/claude-reader', () => ({ scanFolders: async () => [] }))

import {
  MAX_REMOVED_FOLDERS,
  readRemovedFolders,
  recordRemovedFolder
} from '../src/main/gc/gc-removed-folders'
import { detachFromSidebar } from '../src/main/user-projects'

describe('the ledger of folders Harnu removed', () => {
  beforeEach(() => {
    h.userData = mkdtempSync(path.join(os.tmpdir(), 'harnu-ledger-'))
  })
  afterEach(() => rmSync(h.userData, { recursive: true, force: true }))

  it('starts empty and reads back what was recorded, once each', async () => {
    expect(await readRemovedFolders()).toEqual([])
    await recordRemovedFolder('/w/a')
    await recordRemovedFolder('/w/b')
    await recordRemovedFolder('/w/a')
    expect((await readRemovedFolders()).sort()).toEqual(['/w/a', '/w/b'])
  })

  it('is bounded: the oldest entries go first', async () => {
    for (let i = 0; i < MAX_REMOVED_FOLDERS + 5; i++) await recordRemovedFolder(`/w/f${i}`)
    const all = await readRemovedFolders()
    expect(all).toHaveLength(MAX_REMOVED_FOLDERS)
    expect(all).not.toContain('/w/f0')
    expect(all).toContain(`/w/f${MAX_REMOVED_FOLDERS + 4}`)
  })

  it('a damaged file reads as nothing recorded, never as an error', async () => {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(path.join(h.userData, 'removed-folders.json'), '{not json')
    expect(await readRemovedFolders()).toEqual([])
    await recordRemovedFolder('/w/a')
    expect(await readRemovedFolders()).toEqual(['/w/a'])
  })

  it('the shared removal door records the folder it was told is gone', async () => {
    await detachFromSidebar(() => null, '/nonexistent/unit-d/removed/wt')
    expect(await readRemovedFolders()).toContain('/nonexistent/unit-d/removed/wt')
  })
})
