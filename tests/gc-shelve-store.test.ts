import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  SHELVED_FILE,
  isShelvedFolder,
  normalizeShelved,
  readShelved,
  shelvedFolders,
  withShelved,
  withoutShelved,
  writeShelved,
  type ShelvedEntry,
  type ShelvedFile
} from '../src/main/gc/shelve-store'

const entry = (over: Partial<ShelvedEntry> = {}): ShelvedEntry => ({
  id: '/ws/org/proj/www::worktree::/ws/org/proj/www-trees/feat-x',
  repoPath: '/ws/org/proj/www',
  worktreePath: '/ws/org/proj/www-trees/feat-x',
  branch: 'feat/x',
  headSha: 'a'.repeat(40),
  namespace: 'refs/archive/feat/x/20261105T100000Z',
  shelvedAt: 1_000,
  idleDays: 9,
  reason: 'Shelved feat/x — idle 9 d, branch kept',
  freedBytes: 123_456,
  ...over
})

const empty: ShelvedFile = { version: 1, entries: [] }

describe('the shelved store (AC-5)', () => {
  it('remembers an entry and replaces the same id instead of duplicating it', () => {
    const a = withShelved(empty, entry())
    const b = withShelved(a, entry({ shelvedAt: 2_000 }))
    expect(b.entries).toHaveLength(1)
    expect(b.entries[0]!.shelvedAt).toBe(2_000)
  })

  it('forgets by id and leaves the others', () => {
    const f = withShelved(withShelved(empty, entry()), entry({ id: 'other', worktreePath: '/w/2' }))
    expect(withoutShelved(f, ['other']).entries.map((e) => e.id)).toEqual([entry().id])
  })

  it('drops malformed entries and an unknown version when normalizing', () => {
    const raw = {
      version: 1,
      entries: [entry(), { id: 'bad' }, 'junk', { ...entry({ id: 'x' }), shelvedAt: 'soon' }]
    }
    expect(normalizeShelved(raw).entries.map((e) => e.id)).toEqual([entry().id])
    expect(normalizeShelved({ version: 2, entries: [entry()] })).toEqual(empty)
    expect(normalizeShelved(null)).toEqual(empty)
    expect(normalizeShelved('x')).toEqual(empty)
  })

  it('a detached worktree is remembered with a null branch', () => {
    const f = normalizeShelved({ version: 1, entries: [entry({ branch: null })] })
    expect(f.entries[0]!.branch).toBeNull()
  })

  it('lists the folders it holds', () => {
    expect(shelvedFolders(withShelved(empty, entry()))).toEqual([entry().worktreePath])
  })

  it('a folder is shelved when it is, or lies inside, a shelved worktree — whole segments only', () => {
    const f = withShelved(empty, entry())
    const wt = entry().worktreePath
    expect(isShelvedFolder(f, wt)).toBe(true)
    expect(isShelvedFolder(f, `${wt}/api`)).toBe(true)
    expect(isShelvedFolder(f, `${wt}/`)).toBe(true)
    expect(isShelvedFolder(f, `${wt}-other`)).toBe(false)
    expect(isShelvedFolder(f, '/ws/org/proj/www')).toBe(false)
    expect(isShelvedFolder(empty, wt)).toBe(false)
  })
})

describe('the shelved store on disk', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'harnu-shelved-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('round-trips through an atomic write', async () => {
    const file = path.join(dir, SHELVED_FILE)
    const data = withShelved(empty, entry())
    await writeShelved(file, data)
    expect(await readShelved(file)).toEqual(data)
    expect(() => readFileSync(`${file}.tmp`)).toThrow()
  })

  it('a missing file reads as empty; a corrupt one does too and is not thrown at the caller', async () => {
    const file = path.join(dir, SHELVED_FILE)
    expect(await readShelved(file)).toEqual(empty)
    writeFileSync(file, '{ not json')
    expect(await readShelved(file)).toEqual(empty)
  })

  it('the file lives under the name the docs promise', () => {
    expect(SHELVED_FILE).toBe('gc-shelved.json')
  })
})
