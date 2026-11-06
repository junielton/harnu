import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { openSessionArchive } from '../src/main/session-archive-core'

/**
 * T655 — the main-process archive store.
 *
 * The archive set used to live in the renderer's `localStorage`; it now lives in a JSON
 * file the main process owns, so the `archive_session` verb works with the window closed.
 * Everything here runs with NO electron and NO renderer: the store is a plain module over
 * a file path, which is exactly what AC-5 asks to prove.
 */

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'harnu-archive-'))
  file = path.join(dir, 'archived-sessions.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('session archive store', () => {
  it('survives a reload: archiving with no window open persists, a fresh store sees the same set', async () => {
    const a = await openSessionArchive(file)
    expect(await a.archive(['s-1', 's-2'])).toEqual(['s-1', 's-2'])

    const b = await openSessionArchive(file)
    expect([...b.ids()].sort()).toEqual(['s-1', 's-2'])

    expect(await b.unarchive(['s-1'])).toEqual(['s-1'])
    const c = await openSessionArchive(file)
    expect([...c.ids()]).toEqual(['s-2'])
  })

  it('is idempotent: archiving twice reports only what changed and emits one change', async () => {
    const store = await openSessionArchive(file)
    const events: string[][] = []
    store.onChange((ids) => events.push(ids))

    expect(await store.archive(['s-1'])).toEqual(['s-1'])
    expect(await store.archive(['s-1'])).toEqual([])
    expect(await store.unarchive(['s-9'])).toEqual([])
    expect(events).toEqual([['s-1']])
  })

  it('only its own file: no transcript, worktree or other file is touched, no temp file is left', async () => {
    const transcript = path.join(dir, 's-1.jsonl')
    const worktree = path.join(dir, 'worktree')
    writeFileSync(transcript, '{"type":"user"}\n')
    mkdirSync(worktree)
    writeFileSync(path.join(worktree, 'keep.txt'), 'keep')

    const store = await openSessionArchive(file)
    await store.archive(['s-1'])
    await store.unarchive(['s-1'])
    await store.archive(['s-1'])

    expect(readdirSync(dir).sort()).toEqual(['archived-sessions.json', 's-1.jsonl', 'worktree'])
    expect(readFileSync(transcript, 'utf8')).toBe('{"type":"user"}\n')
    expect(readFileSync(path.join(worktree, 'keep.txt'), 'utf8')).toBe('keep')
  })

  it('a missing or corrupt file opens empty and the next write repairs it', async () => {
    expect([...(await openSessionArchive(file)).ids()]).toEqual([])

    writeFileSync(file, '{not json')
    const store = await openSessionArchive(file)
    expect([...store.ids()]).toEqual([])
    await store.archive(['s-1'])
    expect(JSON.parse(readFileSync(file, 'utf8')).ids).toEqual(['s-1'])
  })

  it('concurrent writes do not lose an id', async () => {
    const store = await openSessionArchive(file)
    await Promise.all([store.archive(['a']), store.archive(['b']), store.archive(['c'])])
    const reopened = await openSessionArchive(file)
    expect([...reopened.ids()].sort()).toEqual(['a', 'b', 'c'])
  })
})

describe('legacy import (localStorage -> main store)', () => {
  it('legacy import: merges the old ids exactly once and loses nothing', async () => {
    const store = await openSessionArchive(file)
    await store.archive(['already-here'])
    expect(store.legacyImported()).toBe(false)

    const first = await store.importLegacy(['old-1', 'old-2', 'already-here'])
    expect(first.imported).toBe(true)
    expect([...store.ids()].sort()).toEqual(['already-here', 'old-1', 'old-2'])
    expect(store.legacyImported()).toBe(true)

    // A second boot sends the same (or any) legacy list again: ignored, nothing changes.
    const second = await store.importLegacy(['late-3'])
    expect(second.imported).toBe(false)
    expect(store.has('late-3')).toBe(false)

    // The flag is on disk: a restart does not import again either.
    const reopened = await openSessionArchive(file)
    expect(reopened.legacyImported()).toBe(true)
    expect((await reopened.importLegacy(['late-4'])).imported).toBe(false)
    expect([...reopened.ids()].sort()).toEqual(['already-here', 'old-1', 'old-2'])
  })

  it('legacy import: an import of nothing still counts as the one import', async () => {
    const store = await openSessionArchive(file)
    expect((await store.importLegacy([])).imported).toBe(true)
    expect((await store.importLegacy(['x'])).imported).toBe(false)
  })

  it('legacy import: junk entries are dropped, real ids are kept', async () => {
    const store = await openSessionArchive(file)
    await store.importLegacy(['ok', '', 42 as unknown as string, null as unknown as string])
    expect([...store.ids()]).toEqual(['ok'])
  })

  it('legacy import: a session archived through the verb before the first import is kept', async () => {
    const store = await openSessionArchive(file)
    await store.archive(['verb-archived'])
    await store.importLegacy(['legacy'])
    expect([...store.ids()].sort()).toEqual(['legacy', 'verb-archived'])
  })

  it('a failed write leaves the in-memory set, the import flag and the listeners untouched', async () => {
    // The parent of the store path is a regular file, so every write fails with ENOTDIR.
    const blocker = path.join(dir, 'blocker')
    writeFileSync(blocker, 'not a directory')
    const store = await openSessionArchive(path.join(blocker, 'archived-sessions.json'))
    const heard: string[][] = []
    store.onChange((ids) => heard.push(ids))

    await expect(store.archive(['s-1'])).rejects.toThrow()
    expect(store.has('s-1')).toBe(false)
    await expect(store.unarchive(['s-1'])).resolves.toEqual([])
    await expect(store.importLegacy(['legacy'])).rejects.toThrow()
    expect(store.legacyImported()).toBe(false)
    expect([...store.ids()]).toEqual([])
    expect(heard).toEqual([])
  })
})

describe('ids() is a view nobody can write through (BUG-254)', () => {
  it('AC-4: mutating the returned set changes neither has(), nor the next ids(), nor the file', async () => {
    const store = await openSessionArchive(file)
    await store.archive(['s-1'])

    const leaked = store.ids() as Set<string>
    leaked.add('intruder')
    leaked.delete('s-1')

    expect(store.has('intruder')).toBe(false)
    expect(store.has('s-1')).toBe(true)
    expect([...store.ids()]).toEqual(['s-1'])

    // A no-op archive must not be fooled either: it still reports nothing new to write.
    expect(await store.archive(['s-1'])).toEqual([])
    expect(JSON.parse(readFileSync(file, 'utf8')).ids).toEqual(['s-1'])
  })
})
