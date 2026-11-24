import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isValidNoteDate,
  listNotes,
  localDateStamp,
  noteHeader,
  notesDirFor,
  openNote
} from '../src/main/notes-core'

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

describe('notes-core pure helpers', () => {
  it('noteHeader builds the dated title', () => {
    expect(noteHeader('2026-11-24')).toBe('# 2026-11-24 Notes\n\n')
  })

  it('isValidNoteDate accepts only real YYYY-MM-DD calendar dates', () => {
    expect(isValidNoteDate('2026-11-24')).toBe(true)
    expect(isValidNoteDate('2026-02-30')).toBe(false)
    expect(isValidNoteDate('26-11-24')).toBe(false)
    expect(isValidNoteDate('../x')).toBe(false)
    expect(isValidNoteDate(20261124)).toBe(false)
  })

  it('localDateStamp formats the local date', () => {
    expect(localDateStamp(new Date(2026, 10, 2, 23, 59))).toBe('2026-11-02')
    expect(localDateStamp()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('notes-core fs', () => {
  let tmp: string
  let main: string
  let worktree: string

  beforeEach(async () => {
    tmp = await realpath(await mkdtemp(join(tmpdir(), 'notes-core-')))
    main = join(tmp, 'main')
    worktree = join(tmp, 'wt')
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
    git(main, 'worktree', 'add', '-q', worktree, '-b', 'wt')
  })

  afterEach(() => rm(tmp, { recursive: true, force: true }))

  it('creates today in the MAIN checkout from a worktree, then reopens without rewriting', async () => {
    const file = join(main, '.harnu', 'notes', `${localDateStamp()}.md`)
    const first = await openNote(worktree, undefined, [worktree])
    expect(first).toEqual({ ok: true, filePath: file, created: true })
    expect(await readFile(file, 'utf8')).toBe(noteHeader(localDateStamp()))

    await writeFile(file, noteHeader(localDateStamp()) + 'x')
    const second = await openNote(worktree, undefined, [worktree])
    expect(second).toEqual({ ok: true, filePath: file, created: false })
    expect(await readFile(file, 'utf8')).toBe(noteHeader(localDateStamp()) + 'x')
  })

  it('two concurrent opens on a fresh day both succeed with exactly the header', async () => {
    const [a, b] = await Promise.all([
      openNote(main, undefined, [main]),
      openNote(main, undefined, [main])
    ])
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    // Exactly one of the racing opens created the file; the other reopened it.
    const created = [a, b].filter((r) => r.ok && r.created)
    expect(created).toHaveLength(1)
    const file = join(notesDirFor(main), `${localDateStamp()}.md`)
    expect(await readFile(file, 'utf8')).toBe(noteHeader(localDateStamp()))
  })

  it('opening a given date requires it to exist and be valid', async () => {
    expect(await openNote(main, '2020-01-01', [main])).toEqual({ ok: false, code: 'not-found' })
    expect(await openNote(main, '../x', [main])).toEqual({ ok: false, code: 'invalid-args' })
    await mkdir(notesDirFor(main), { recursive: true })
    const file = join(notesDirFor(main), '2020-01-01.md')
    await writeFile(file, 'old')
    expect(await openNote(main, '2020-01-01', [main])).toEqual({
      ok: true,
      filePath: file,
      created: false
    })
  })

  it('keeps notes in <folder>/.harnu/notes outside a git repo', async () => {
    const plain = join(tmp, 'plain')
    await mkdir(plain)
    const r = await openNote(plain, undefined, [plain])
    expect(r).toEqual({
      ok: true,
      filePath: join(plain, '.harnu', 'notes', `${localDateStamp()}.md`),
      created: true
    })
  })

  it('listNotes returns valid note dates newest first and ignores other files', async () => {
    const dir = notesDirFor(main)
    await mkdir(dir, { recursive: true })
    for (const name of [
      '2025-12-31.md',
      '2026-11-02.md',
      '2026-11-24.md',
      'notes.txt',
      '2026-13-01.md'
    ]) {
      await writeFile(join(dir, name), 'x')
    }
    const r = await listNotes(main, [main])
    expect(r).toEqual({
      ok: true,
      notesDir: dir,
      today: localDateStamp(),
      notes: [
        { date: '2026-11-24', filePath: join(dir, '2026-11-24.md') },
        { date: '2026-11-02', filePath: join(dir, '2026-11-02.md') },
        { date: '2025-12-31', filePath: join(dir, '2025-12-31.md') }
      ]
    })
  })

  it('listNotes on a missing notes dir is an empty list', async () => {
    const r = await listNotes(main, [main])
    expect(r).toMatchObject({ ok: true, notes: [], today: localDateStamp() })
  })

  it('refuses a folder outside the known roots', async () => {
    const outside = join(tmp, 'outside')
    await mkdir(outside)
    expect(await openNote(outside, undefined, [main])).toEqual({
      ok: false,
      code: 'folder-not-allowed'
    })
    expect(await listNotes(outside, [main])).toEqual({ ok: false, code: 'folder-not-allowed' })
  })

  it('rejects a non-string folder', async () => {
    expect(await openNote('', undefined, [main])).toEqual({ ok: false, code: 'invalid-args' })
    expect(await listNotes(undefined as unknown as string, [main])).toEqual({
      ok: false,
      code: 'invalid-args'
    })
  })

  it('refuses a symlinked notes dir', async () => {
    const real = join(tmp, 'elsewhere')
    await mkdir(real)
    await mkdir(join(main, '.harnu'), { recursive: true })
    await symlink(real, join(main, '.harnu', 'notes'))
    expect(await openNote(main, undefined, [main])).toEqual({ ok: false, code: 'symlink' })
    expect(await listNotes(main, [main])).toEqual({ ok: false, code: 'symlink' })
  })

  it('refuses a symlinked .harnu dir, like the markdown gate, and creates nothing behind it', async () => {
    const real = join(tmp, 'elsewhere-harnu')
    await mkdir(join(real, 'notes'), { recursive: true })
    await writeFile(join(real, 'notes', '2020-01-01.md'), 'x')
    await symlink(real, join(main, '.harnu'))
    expect(await openNote(main, undefined, [main])).toEqual({ ok: false, code: 'symlink' })
    expect(await openNote(main, '2020-01-01', [main])).toEqual({ ok: false, code: 'symlink' })
    expect(await listNotes(main, [main])).toEqual({ ok: false, code: 'symlink' })
    // Today's note was not created through the link.
    await expect(readFile(join(real, 'notes', `${localDateStamp()}.md`), 'utf8')).rejects.toThrow()
  })

  it('refuses a symlinked note file', async () => {
    const target = join(tmp, 'target.md')
    await writeFile(target, 'secret')
    await mkdir(notesDirFor(main), { recursive: true })
    await symlink(target, join(notesDirFor(main), '2020-01-01.md'))
    expect(await openNote(main, '2020-01-01', [main])).toEqual({ ok: false, code: 'symlink' })
  })
})
