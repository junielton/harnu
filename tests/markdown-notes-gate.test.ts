import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Quick notes gate rule: the markdown read / write / watch channels admit
 * `<main checkout>/.harnu/notes/YYYY-MM-DD.md` even when only a WORKTREE of that
 * repo is a known root. Known roots are mocked the way
 * tests/markdown-write-containment.test.ts does it.
 */
const h = vi.hoisted(() => ({ roots: [] as string[] }))

vi.mock('electron', () => ({
  app: { getPath: (): string => tmpdir() },
  dialog: {},
  shell: {},
  BrowserWindow: class {},
  ipcMain: { handle: (): void => {}, on: (): void => {} }
}))
vi.mock('../src/main/user-projects', () => ({
  readUserProjects: async (): Promise<{ projects: { path: string }[] }> => ({
    projects: h.roots.map((p) => ({ path: p }))
  })
}))
vi.mock('../src/main/claude-reader', () => ({
  scanFolders: async (): Promise<unknown[]> => []
}))

import { isNotesFilePath } from '../src/main/notes-core'
import { markdownGate, readMarkdownFile } from '../src/main/markdown-read'
import { writeMarkdownFile } from '../src/main/markdown-write'
import { clearRootCache } from '../src/main/data-dir'

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

describe('notes gate rule', () => {
  let tmp: string
  let main: string
  let wt: string
  const day = '2026-11-24'
  let note: string

  beforeEach(async () => {
    clearRootCache()
    tmp = await realpath(await mkdtemp(join(tmpdir(), 'notes-gate-')))
    main = join(tmp, 'main')
    wt = join(tmp, 'wt')
    await mkdir(main)
    git(main, 'init', '-q')
    git(
      main,
      '-c',
      'user.email=t@t',
      '-c',
      'user.name=t',
      'commit',
      '--allow-empty',
      '-q',
      '-m',
      'i'
    )
    git(main, 'worktree', 'add', '-q', wt, '-b', 'wt')
    await mkdir(join(main, '.harnu', 'notes'), { recursive: true })
    note = join(main, '.harnu', 'notes', `${day}.md`)
    await writeFile(note, '# note\n')
    await writeFile(join(main, 'README.md'), '# readme\n')
    h.roots = [wt]
  })
  afterEach(() => rm(tmp, { recursive: true, force: true }))

  describe('isNotesFilePath', () => {
    it('admits a dated note in the main checkout when only the worktree is a root', () => {
      expect(isNotesFilePath(note, [wt])).toBe(true)
    })

    it('refuses non-date names, a wrong directory and an unrelated repo', () => {
      expect(isNotesFilePath(join(main, '.harnu', 'notes', 'evil.md'), [wt])).toBe(false)
      expect(isNotesFilePath(join(main, '.harnu', 'notes', '2026-02-30.md'), [wt])).toBe(false)
      expect(isNotesFilePath(join(main, '.harnu', `${day}.md`), [wt])).toBe(false)
      expect(isNotesFilePath(join(tmp, 'x', '.harnu', 'notes', `${day}.md`), [wt])).toBe(false)
    })

    it('does not resolve roots for a name that cannot be a note', () => {
      expect(isNotesFilePath(join(tmp, 'anything', 'README.md'), [wt])).toBe(false)
    })
  })

  describe('markdownGate', () => {
    it('passes a note, refuses other files in the main checkout', async () => {
      expect(await markdownGate(note)).toEqual({ ok: true })
      expect(await markdownGate(join(main, 'README.md'))).toEqual({
        ok: false,
        code: 'outside-roots'
      })
    })

    it('refuses a symlinked note file and a symlinked notes dir', async () => {
      const target = join(tmp, 'secret.md')
      await writeFile(target, 'secret')
      const linked = join(main, '.harnu', 'notes', '2026-11-25.md')
      await symlink(target, linked)
      expect(await markdownGate(linked)).toEqual({ ok: false, code: 'symlink' })

      await rm(join(main, '.harnu', 'notes'), { recursive: true })
      await mkdir(join(tmp, 'elsewhere'))
      await writeFile(join(tmp, 'elsewhere', `${day}.md`), 'x')
      await symlink(join(tmp, 'elsewhere'), join(main, '.harnu', 'notes'))
      expect(await markdownGate(note)).toEqual({ ok: false, code: 'symlink' })
    })
  })

  describe('read / write channels', () => {
    it('reads and writes a note through a worktree-only root', async () => {
      const r = await readMarkdownFile(note)
      expect(r).toMatchObject({ ok: true, kind: 'text', content: '# note\n' })
      const w = await writeMarkdownFile(note, '# changed\n')
      expect(w.ok).toBe(true)
      expect(await readFile(note, 'utf8')).toBe('# changed\n')
    })

    it('still refuses the main checkout README', async () => {
      const readme = join(main, 'README.md')
      expect(await readMarkdownFile(readme)).toMatchObject({ ok: false, code: 'outside-roots' })
      expect(await writeMarkdownFile(readme, 'x')).toMatchObject({
        ok: false,
        code: 'outside-roots'
      })
    })

    it('refuses a symlinked note for read and write', async () => {
      const target = join(tmp, 'secret.md')
      await writeFile(target, 'secret')
      const linked = join(main, '.harnu', 'notes', '2026-11-25.md')
      await symlink(target, linked)
      expect(await readMarkdownFile(linked)).toMatchObject({ ok: false, code: 'symlink' })
      expect(await writeMarkdownFile(linked, 'x')).toMatchObject({ ok: false, code: 'symlink' })
      expect(await readFile(target, 'utf8')).toBe('secret')
    })
  })
})
