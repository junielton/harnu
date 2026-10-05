import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

vi.mock('electron', () => ({
  app: { getPath: (): string => os.tmpdir(), isPackaged: false, getAppPath: () => process.cwd() },
  dialog: {},
  shell: {},
  BrowserWindow: class {},
  ipcMain: { handle: (): void => {}, on: (): void => {} }
}))

import {
  archiveCardFile,
  restoreCardFile,
  deleteCardFile,
  createCardFile,
  ensureManageable
} from '../src/main/roadmap-ipc'

/**
 * T148: real fs coverage for archive/restore/delete — proves the effect
 * actually happens on disk, not just that the schema/gate layers accept the
 * call (roadmap-ipc.ts is env-bound, so this is the e2e side of ADR-0001's
 * pure-core/thin-shell split; roadmap-core.ts carries the pure logic tests).
 */
describe('archiveCardFile / restoreCardFile / deleteCardFile (real fs)', () => {
  let folder: string

  beforeEach(async () => {
    folder = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-archive-verify-'))
  })

  afterEach(async () => {
    await fs.rm(folder, { recursive: true, force: true })
  })

  it('archive moves the file out of roadmap/ into roadmap-archive/, and restore moves it back', async () => {
    const created = await createCardFile(folder, 'T1-test', '---\nid: T1\n---\nbody')
    expect(created.ok).toBe(true)

    const roadmapDir = path.join(folder, '.harnu', 'memory', 'roadmap')
    const archiveDir = path.join(folder, '.harnu', 'memory', 'roadmap-archive')

    expect(await fs.readdir(roadmapDir)).toContain('T1-test.md')

    const archived = await archiveCardFile(folder, 'T1-test')
    expect(archived.ok).toBe(true)
    await expect(fs.access(path.join(roadmapDir, 'T1-test.md'))).rejects.toThrow()
    expect(await fs.readdir(archiveDir)).toContain('T1-test.md')

    const restored = await restoreCardFile(folder, 'T1-test')
    expect(restored.ok).toBe(true)
    expect(await fs.readdir(roadmapDir)).toContain('T1-test.md')
    await expect(fs.access(path.join(archiveDir, 'T1-test.md'))).rejects.toThrow()
  })

  it('delete removes the file from disk for good, ENOENT-as-success on a second call', async () => {
    await createCardFile(folder, 'T2-test', '---\nid: T2\n---\nbody')
    const roadmapDir = path.join(folder, '.harnu', 'memory', 'roadmap')
    expect(await fs.readdir(roadmapDir)).toContain('T2-test.md')

    const deleted = await deleteCardFile(folder, 'T2-test')
    expect(deleted.ok).toBe(true)
    await expect(fs.access(path.join(roadmapDir, 'T2-test.md'))).rejects.toThrow()

    const deletedAgain = await deleteCardFile(folder, 'T2-test')
    expect(deletedAgain.ok).toBe(true)
  })

  it('archive/restore/delete refuse a traversal-shaped slug (bad-args, never touches disk)', async () => {
    expect(await archiveCardFile(folder, '../escape')).toEqual({ ok: false, code: 'bad-args' })
    expect(await restoreCardFile(folder, '../escape')).toEqual({ ok: false, code: 'bad-args' })
    expect(await deleteCardFile(folder, '../escape')).toEqual({ ok: false, code: 'bad-args' })
  })

  it('archive fails closed (not-found) but leaves a prior archived copy intact', async () => {
    const roadmapDir = path.join(folder, '.harnu', 'memory', 'roadmap')
    const archiveDir = path.join(folder, '.harnu', 'memory', 'roadmap-archive')

    // Archive a real card so a copy exists in roadmap-archive/.
    await createCardFile(folder, 'T3-keep', '---\nid: T3\n---\noriginal')
    expect((await archiveCardFile(folder, 'T3-keep')).ok).toBe(true)
    expect(await fs.readFile(path.join(archiveDir, 'T3-keep.md'), 'utf8')).toContain('original')

    // Archiving again with no active card present must fail (nothing to move)
    // WITHOUT destroying the copy already in the archive.
    const again = await archiveCardFile(folder, 'T3-keep')
    expect(again).toEqual({ ok: false, code: 'not-found' })
    expect(await fs.readFile(path.join(archiveDir, 'T3-keep.md'), 'utf8')).toContain('original')
    await expect(fs.access(path.join(roadmapDir, 'T3-keep.md'))).rejects.toThrow()
  })

  it('ensureManageable rejects an in-progress card, fails closed on a missing/bad slug', async () => {
    // in-progress → bad-status (a bound session must keep its card).
    await createCardFile(folder, 'T5-wip', '---\nid: T5\nstatus: in-progress\n---\nbody')
    expect(await ensureManageable(folder, 'T5-wip')).toEqual({ ok: false, code: 'bad-status' })

    // A manageable card (backlog) passes.
    await createCardFile(folder, 'T6-ok', '---\nid: T6\nstatus: backlog\n---\nbody')
    expect(await ensureManageable(folder, 'T6-ok')).toEqual({ ok: true })

    // Fail closed: an unreadable (missing) card and a traversal slug both reject.
    expect(await ensureManageable(folder, 'T7-missing')).toEqual({ ok: false, code: 'not-found' })
    expect(await ensureManageable(folder, '../escape')).toEqual({ ok: false, code: 'bad-args' })
  })

  it('restore refuses to clobber a live card of the same slug (write-failed)', async () => {
    const roadmapDir = path.join(folder, '.harnu', 'memory', 'roadmap')

    await createCardFile(folder, 'T4-dup', '---\nid: T4\n---\noriginal')
    expect((await archiveCardFile(folder, 'T4-dup')).ok).toBe(true)

    // A NEW card mints onto the same slug while the old one sits archived.
    await createCardFile(folder, 'T4-dup', '---\nid: T4\n---\nreplacement')

    const restored = await restoreCardFile(folder, 'T4-dup')
    expect(restored).toEqual({ ok: false, code: 'write-failed' })
    // The live card is untouched — never overwritten by the archived copy.
    expect(await fs.readFile(path.join(roadmapDir, 'T4-dup.md'), 'utf8')).toContain('replacement')
  })
})
