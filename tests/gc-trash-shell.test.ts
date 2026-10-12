// AC-C5: "Empty what Harnu moved to the trash" deletes ONLY the items Harnu itself trashed, found
// through the freedesktop trash's own `.trashinfo` records, against a FAKE trash directory. Never
// the user's other trash, never a later trashing of a folder at the same path.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { emptyHarnuTrash, presentInTrash, type TrashEnv } from '../src/main/gc/trash-shell'
import {
  matchesTrashed,
  parseTrashInfo,
  trashKey,
  trashedEntries,
  type TrashedEntry
} from '../src/main/gc/trash-core'
import type { Tombstone } from '../src/main/reaper/journal'

const MIN = 60_000

/** `2026-10-12T09:30:00`: a trashinfo date is local wall-clock time, with no zone. */
function localStamp(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(
    d.getMinutes()
  )}:${p(d.getSeconds())}`
}

let root: string
let trash: string
let env: TrashEnv

/** Puts an item in the fake trash the way the OS does: the data under files/, a record under info/. */
function trashItem(
  trashDir: string,
  name: string,
  originalPath: string,
  at: number,
  encoded = originalPath
): string {
  mkdirSync(path.join(trashDir, 'files', name), { recursive: true })
  writeFileSync(path.join(trashDir, 'files', name, 'data.txt'), 'x')
  mkdirSync(path.join(trashDir, 'info'), { recursive: true })
  writeFileSync(
    path.join(trashDir, 'info', `${name}.trashinfo`),
    `[Trash Info]\nPath=${encoded}\nDeletionDate=${localStamp(at)}\n`
  )
  return path.join(trashDir, 'files', name)
}

const entry = (p: string, at: number, bytes: number | null = 1000): TrashedEntry => ({
  key: trashKey(at, p),
  path: p,
  bytes,
  at,
  repoPath: '/ws/repo',
  branch: 'feat/x'
})

const NOW = Date.parse('2026-10-12T09:30:00')

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'harnu-trash-'))
  trash = path.join(root, 'home', '.local', 'share', 'Trash')
  mkdirSync(path.join(trash, 'files'), { recursive: true })
  mkdirSync(path.join(trash, 'info'), { recursive: true })
  env = { platform: 'linux', homeTrash: trash, uid: 1000 }
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('parseTrashInfo', () => {
  it('reads the path (percent-decoded) and the local deletion date', () => {
    const info = parseTrashInfo(
      '[Trash Info]\nPath=/ws/my%20repo/wt-a\nDeletionDate=2026-10-12T09:30:00\n'
    )
    expect(info).toEqual({
      path: '/ws/my repo/wt-a',
      relative: false,
      deletedAt: new Date(2026, 9, 12, 9, 30, 0).getTime()
    })
  })

  it('a relative path (a per-volume trash) is flagged relative', () => {
    expect(
      parseTrashInfo('[Trash Info]\nPath=work/wt-a\nDeletionDate=2026-10-12T09:30:00')?.relative
    ).toBe(true)
  })

  it('is null for a file that is not a trashinfo, and NaN for an unreadable date', () => {
    expect(parseTrashInfo('hello')).toBeNull()
    expect(parseTrashInfo('[Trash Info]\nPath=/a\nDeletionDate=garbage')?.deletedAt).toBeNaN()
  })
})

describe('matchesTrashed', () => {
  const info = (p: string, at: number) =>
    parseTrashInfo(`[Trash Info]\nPath=${p}\nDeletionDate=${localStamp(at)}`)!

  it('needs the same path AND the same moment, give or take the clock', () => {
    const e = entry('/ws/wt-a', NOW)
    expect(matchesTrashed(info('/ws/wt-a', NOW - 20_000), e, null)).toBe(true)
    expect(matchesTrashed(info('/ws/wt-a', NOW + 3 * MIN), e, null)).toBe(false)
    expect(matchesTrashed(info('/ws/wt-a', NOW - 3 * MIN), e, null)).toBe(false)
    expect(matchesTrashed(info('/ws/wt-b', NOW), e, null)).toBe(false)
  })

  it('a relative path joins the trash top directory', () => {
    const e = entry('/mnt/disk/wt-a', NOW)
    expect(matchesTrashed(info('wt-a', NOW), e, '/mnt/disk')).toBe(true)
    expect(matchesTrashed(info('wt-a', NOW), e, null)).toBe(false)
  })
})

describe('trashedEntries (the journal as the ledger)', () => {
  const line = (over: Partial<Tombstone>): Tombstone => ({
    at: NOW,
    repoPath: '/ws/repo',
    kind: 'worktree',
    branch: 'feat/x',
    sha: 'a',
    deleted: [],
    justifiedBy: null,
    restoreHint: null,
    archiveTipRef: null,
    archiveWipRef: null,
    ...over
  })

  it('lists only lines that recorded a trashed path, newest first', () => {
    const entries = trashedEntries(
      [
        line({ at: NOW - 5000, trashedPath: '/ws/old', trashedBytes: 5, trashedAt: NOW - 5000 }),
        line({ at: NOW }), // nothing trashed (a branch-only item, or an older line)
        line({ at: NOW - 1000, trashedPath: '/ws/new', trashedBytes: 7, trashedAt: NOW - 1000 })
      ],
      new Set()
    )
    expect(entries.map((e) => e.path)).toEqual(['/ws/new', '/ws/old'])
    expect(entries[0]).toMatchObject({ bytes: 7, at: NOW - 1000 })
  })

  it('skips what is already settled (emptied, or found gone)', () => {
    const l = line({ trashedPath: '/ws/a', trashedBytes: 5, trashedAt: NOW })
    expect(trashedEntries([l], new Set([trashKey(NOW, '/ws/a')]))).toEqual([])
  })
})

describe('emptyHarnuTrash (AC-C5)', () => {
  it("removes Harnu's item and its record, and leaves the user's other trash alone", async () => {
    const ours = trashItem(trash, 'wt-a', '/ws/org/wt-a', NOW)
    const theirs = trashItem(trash, 'holiday-photos', '/home/u/holiday-photos', NOW - 60 * MIN)
    const result = await emptyHarnuTrash([entry('/ws/org/wt-a', NOW)], env)
    expect(result.emptied).toEqual([trashKey(NOW, '/ws/org/wt-a')])
    expect(existsSync(ours)).toBe(false)
    expect(existsSync(path.join(trash, 'info', 'wt-a.trashinfo'))).toBe(false)
    expect(existsSync(theirs)).toBe(true)
    expect(existsSync(path.join(trash, 'info', 'holiday-photos.trashinfo'))).toBe(true)
  })

  it('never takes a later trashing of a folder at the same path (the user recreated it)', async () => {
    trashItem(trash, 'wt-a', '/ws/org/wt-a', NOW)
    const later = trashItem(trash, 'wt-a.2', '/ws/org/wt-a', NOW + 24 * 60 * MIN)
    const result = await emptyHarnuTrash([entry('/ws/org/wt-a', NOW)], env)
    expect(result.emptied).toHaveLength(1)
    expect(existsSync(later)).toBe(true)
  })

  it('finds the renamed copy when two items shared a name (wt-a.2)', async () => {
    trashItem(trash, 'wt-a', '/ws/org/wt-a', NOW - 90 * MIN)
    const ours = trashItem(trash, 'wt-a.2', '/ws/org/wt-a', NOW)
    const result = await emptyHarnuTrash([entry('/ws/org/wt-a', NOW)], env)
    expect(result.emptied).toHaveLength(1)
    expect(existsSync(ours)).toBe(false)
    expect(existsSync(path.join(trash, 'files', 'wt-a'))).toBe(true)
  })

  it('reads a percent-encoded path with spaces', async () => {
    const ours = trashItem(trash, 'wt a', '/ws/my repo/wt a', NOW, '/ws/my%20repo/wt%20a')
    const result = await emptyHarnuTrash([entry('/ws/my repo/wt a', NOW)], env)
    expect(result.emptied).toHaveLength(1)
    expect(existsSync(ours)).toBe(false)
  })

  it('an item the user already emptied is reported missing, not an error', async () => {
    const result = await emptyHarnuTrash([entry('/ws/org/gone', NOW)], env)
    expect(result.emptied).toEqual([])
    expect(result.missing).toEqual([trashKey(NOW, '/ws/org/gone')])
    expect(result.failed).toEqual([])
  })

  it('reports the bytes it emptied, from what the journal recorded', async () => {
    trashItem(trash, 'wt-a', '/ws/org/wt-a', NOW)
    trashItem(trash, 'wt-b', '/ws/org/wt-b', NOW + MIN)
    const result = await emptyHarnuTrash(
      [
        entry('/ws/org/wt-a', NOW, 400),
        entry('/ws/org/wt-b', NOW + MIN, 600),
        entry('/ws/org/x', NOW, 999)
      ],
      env
    )
    expect(result.emptiedBytes).toBe(1000)
  })

  it('does not follow a symlink inside a trashed folder out of the trash', async () => {
    const outside = path.join(root, 'precious')
    mkdirSync(outside)
    writeFileSync(path.join(outside, 'keep.txt'), 'keep me')
    const ours = trashItem(trash, 'wt-a', '/ws/org/wt-a', NOW)
    symlinkSync(outside, path.join(ours, 'link-out'))
    await emptyHarnuTrash([entry('/ws/org/wt-a', NOW)], env)
    expect(existsSync(ours)).toBe(false)
    expect(existsSync(path.join(outside, 'keep.txt'))).toBe(true)
  })

  it('finds an item in a per-volume trash (a relative Path= under <mount>/.Trash-<uid>)', async () => {
    const mount = path.join(root, 'mnt', 'disk')
    const volTrash = path.join(mount, '.Trash-1000')
    const ours = trashItem(volTrash, 'wt-a', 'work/wt-a', NOW)
    const result = await emptyHarnuTrash([entry(path.join(mount, 'work', 'wt-a'), NOW)], env)
    expect(result.emptied).toHaveLength(1)
    expect(existsSync(ours)).toBe(false)
  })

  it('does nothing on a platform whose trash it cannot read selectively', async () => {
    const ours = trashItem(trash, 'wt-a', '/ws/org/wt-a', NOW)
    const result = await emptyHarnuTrash([entry('/ws/org/wt-a', NOW)], {
      ...env,
      platform: 'darwin'
    })
    expect(result.unsupported).toBe(true)
    expect(result.emptied).toEqual([])
    expect(existsSync(ours)).toBe(true)
  })
})

describe('presentInTrash', () => {
  it('splits the ledger into what is still in the trash and what is gone', async () => {
    trashItem(trash, 'wt-a', '/ws/org/wt-a', NOW)
    const there = entry('/ws/org/wt-a', NOW)
    const gone = entry('/ws/org/wt-b', NOW)
    const r = await presentInTrash([there, gone], env)
    expect(r.present.map((e) => e.path)).toEqual(['/ws/org/wt-a'])
    expect(r.gone.map((e) => e.path)).toEqual(['/ws/org/wt-b'])
    expect(r.unsupported).toBe(false)
  })

  it('cannot tell on another platform: everything counts as present, and it says so', async () => {
    const e = entry('/ws/org/wt-a', NOW)
    const r = await presentInTrash([e], { ...env, platform: 'darwin' })
    expect(r.unsupported).toBe(true)
    expect(r.present).toEqual([e])
    expect(r.gone).toEqual([])
  })
})
