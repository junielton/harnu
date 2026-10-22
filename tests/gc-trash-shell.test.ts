// AC-C5: "Empty what Harnu moved to the trash" deletes ONLY the exact trash entry Harnu created.
//
// The entry is identified AT TRASH TIME (the trash listing before and after the move, plus a
// fingerprint of the entry: its name, the `.trashinfo`'s date, inode and mtime, and the trashed
// folder's own inode), and "Empty" deletes an entry only when ALL of that still matches. It never
// matches by original path and time: a user who restores a folder and trashes it again gets a new
// entry with the same path, and that one is theirs. Everything runs against a FAKE trash dir.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  emptyHarnuTrash,
  observeTrashEntries,
  recordTrash,
  type TrashEnv
} from '../src/main/gc/trash-shell'
import {
  parseTrashInfo,
  trashKey,
  trashedEntries,
  type TrashedEntry
} from '../src/main/gc/trash-core'
import type { Tombstone } from '../src/main/reaper/journal'

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
const NOW = Date.parse('2026-10-12T09:30:00')

/**
 * What the OS does when something is trashed: the folder is RENAMED into `files/` (so it keeps its
 * inode) and a fresh `.trashinfo` is written. Returns the name it took.
 */
function osTrash(
  trashDir: string,
  folder: string,
  at: number,
  encodedPath = folder,
  relativeTo?: string
): string {
  mkdirSync(path.join(trashDir, 'files'), { recursive: true })
  mkdirSync(path.join(trashDir, 'info'), { recursive: true })
  let name = path.basename(folder)
  for (let n = 2; existsSync(path.join(trashDir, 'info', `${name}.trashinfo`)); n++) {
    name = `${path.basename(folder)}.${n}`
  }
  renameSync(folder, path.join(trashDir, 'files', name))
  const recorded = relativeTo ? path.relative(relativeTo, folder) : encodedPath
  writeFileSync(
    path.join(trashDir, 'info', `${name}.trashinfo`),
    `[Trash Info]\nPath=${recorded}\nDeletionDate=${localStamp(at)}\n`
  )
  return name
}

/** What the user does in the file manager: Restore. */
function osRestore(trashDir: string, name: string, to: string): void {
  renameSync(path.join(trashDir, 'files', name), to)
  rmSync(path.join(trashDir, 'info', `${name}.trashinfo`))
}

function makeFolder(p: string): string {
  mkdirSync(p, { recursive: true })
  writeFileSync(path.join(p, 'data.txt'), 'x')
  return p
}

const asEntry = (
  p: string,
  at: number,
  exact: TrashedEntry['exact'],
  bytes: number | null = 1000
): TrashedEntry => ({
  key: trashKey(at, p),
  path: p,
  bytes,
  at,
  repoPath: '/ws/repo',
  branch: 'feat/x',
  exact
})

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'harnu-trash-'))
  trash = path.join(root, 'home', '.local', 'share', 'Trash')
  mkdirSync(path.join(trash, 'files'), { recursive: true })
  mkdirSync(path.join(trash, 'info'), { recursive: true })
  env = { platform: 'linux', homeTrash: trash, uid: 1000, isMountPoint: async () => false }
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
      deletionDate: '2026-10-12T09:30:00',
      deletedAt: new Date(2026, 9, 12, 9, 30, 0).getTime()
    })
  })

  it('is null for a file that is not a trashinfo, and NaN for an unreadable date', () => {
    expect(parseTrashInfo('hello')).toBeNull()
    expect(parseTrashInfo('[Trash Info]\nPath=/a\nDeletionDate=garbage')?.deletedAt).toBeNaN()
  })
})

describe('recordTrash: identifying the exact entry at trash time', () => {
  it('records the one new entry: where it is, its name, its date and its fingerprint', async () => {
    const folder = makeFolder(path.join(root, 'ws', 'wt-a'))
    const ino = lstatSync(folder).ino
    const record = await recordTrash(env, folder, async () => {
      osTrash(trash, folder, NOW)
    })
    expect(record).toMatchObject({
      kind: 'freedesktop',
      trashDir: trash,
      name: 'wt-a',
      deletionDate: localStamp(NOW),
      ino
    })
    expect(record!.infoIno).toBe(lstatSync(path.join(trash, 'info', 'wt-a.trashinfo')).ino)
  })

  it('takes the renamed name when the trash already holds one of that name', async () => {
    osTrash(trash, makeFolder(path.join(root, 'old', 'wt-a')), NOW - 3_600_000)
    const folder = makeFolder(path.join(root, 'ws', 'wt-a'))
    const record = await recordTrash(env, folder, async () => {
      osTrash(trash, folder, NOW)
    })
    expect(record).toMatchObject({ name: 'wt-a.2' })
  })

  it('records NOTHING when two entries appeared at once: it cannot tell which is its own', async () => {
    const mine = makeFolder(path.join(root, 'ws', 'wt-a'))
    const users = makeFolder(path.join(root, 'ws', 'notes'))
    const record = await recordTrash(env, mine, async () => {
      osTrash(trash, mine, NOW)
      osTrash(trash, users, NOW)
    })
    expect(record).toBeNull()
  })

  it('records nothing when the one new entry came from somewhere else', async () => {
    const mine = makeFolder(path.join(root, 'ws', 'wt-a'))
    const users = makeFolder(path.join(root, 'ws', 'notes'))
    const record = await recordTrash(env, mine, async () => {
      // The OS trashed `mine` elsewhere (not seen), while the user trashed another folder here.
      rmSync(mine, { recursive: true })
      osTrash(trash, users, NOW)
    })
    expect(record).toBeNull()
  })

  it('reads a percent-encoded original path with spaces', async () => {
    const folder = makeFolder(path.join(root, 'my ws', 'wt a'))
    const record = await recordTrash(env, folder, async () => {
      osTrash(trash, folder, NOW, folder.replace(/ /g, '%20'))
    })
    expect(record?.name).toBe('wt a')
  })

  it('finds an entry in a per-volume trash, with a path relative to the mount point', async () => {
    const mount = path.join(root, 'mnt', 'disk')
    const volTrash = path.join(mount, '.Trash-1000')
    mkdirSync(volTrash, { recursive: true })
    const folder = makeFolder(path.join(mount, 'work', 'wt-a'))
    const volEnv: TrashEnv = { ...env, isMountPoint: async (p) => p === mount }
    const record = await recordTrash(volEnv, folder, async () => {
      osTrash(volTrash, folder, NOW, folder, mount)
    })
    expect(record).toMatchObject({ trashDir: volTrash, name: 'wt-a' })
  })

  it('records nothing on a platform whose trash it cannot read', async () => {
    const folder = makeFolder(path.join(root, 'ws', 'wt-a'))
    const record = await recordTrash({ ...env, platform: 'win32' }, folder, async () => {
      rmSync(folder, { recursive: true })
    })
    expect(record).toBeNull()
  })

  it('on macOS the entry is the new name in ~/.Trash with its inode', async () => {
    const macTrash = path.join(root, 'home', '.Trash')
    mkdirSync(macTrash, { recursive: true })
    const folder = makeFolder(path.join(root, 'ws', 'wt-a'))
    const ino = lstatSync(folder).ino
    const record = await recordTrash(
      { ...env, platform: 'darwin', homeTrash: macTrash },
      folder,
      async () => renameSync(folder, path.join(macTrash, 'wt-a'))
    )
    expect(record).toMatchObject({ kind: 'macos', trashDir: macTrash, name: 'wt-a', ino })
  })
})

describe('emptyHarnuTrash: only the exact entry (AC-C5)', () => {
  /** Harnu trashes `folder` and records the entry, as the executor does. */
  async function harnuTrash(folder: string, at = NOW): Promise<TrashedEntry> {
    const record = await recordTrash(env, folder, async () => {
      osTrash(trash, folder, at)
    })
    return asEntry(folder, at, record)
  }

  it("removes Harnu's entry (data and record) and leaves the user's other trash alone", async () => {
    const ours = await harnuTrash(makeFolder(path.join(root, 'ws', 'wt-a')))
    const theirs = osTrash(trash, makeFolder(path.join(root, 'docs', 'holiday')), NOW - 3_600_000)
    const result = await emptyHarnuTrash([ours], [ours.key], env)
    expect(result.emptied).toEqual([ours.key])
    expect(existsSync(path.join(trash, 'files', 'wt-a'))).toBe(false)
    expect(existsSync(path.join(trash, 'info', 'wt-a.trashinfo'))).toBe(false)
    expect(existsSync(path.join(trash, 'files', theirs))).toBe(true)
  })

  it('PROBE A: the user restored the folder and re-trashed it 30 s later — their item survives', async () => {
    const folder = makeFolder(path.join(root, 'ws', 'wt-a'))
    const ours = await harnuTrash(folder)
    osRestore(trash, 'wt-a', folder)
    osTrash(trash, folder, NOW + 30_000) // the user's own trashing, same path, same name
    const result = await emptyHarnuTrash([ours], [ours.key], env)
    expect(result.emptied).toEqual([])
    expect(result.changed).toEqual([ours.key])
    expect(existsSync(path.join(trash, 'files', 'wt-a', 'data.txt'))).toBe(true)
    expect(existsSync(path.join(trash, 'info', 'wt-a.trashinfo'))).toBe(true)
  })

  it("restored and re-trashed within the same second: still not Harnu's (the rename touched the folder)", async () => {
    const folder = makeFolder(path.join(root, 'ws', 'wt-a'))
    const ours = await harnuTrash(folder)
    await sleep(25)
    osRestore(trash, 'wt-a', folder)
    await sleep(25)
    osTrash(trash, folder, NOW) // same name, same date string, same inode of the folder
    const result = await emptyHarnuTrash([ours], [ours.key], env)
    expect(result.emptied).toEqual([])
    expect(result.changed).toEqual([ours.key])
    expect(existsSync(path.join(trash, 'files', 'wt-a', 'data.txt'))).toBe(true)
  })

  it('restored and NOT re-trashed: reported gone, the restored folder untouched', async () => {
    const folder = makeFolder(path.join(root, 'ws', 'wt-a'))
    const ours = await harnuTrash(folder)
    osRestore(trash, 'wt-a', folder)
    const result = await emptyHarnuTrash([ours], [ours.key], env)
    expect(result.emptied).toEqual([])
    expect(result.missing).toEqual([ours.key])
    expect(existsSync(path.join(folder, 'data.txt'))).toBe(true)
  })

  it('two entries for the same path: only the exactly identified one goes, whatever readdir lists first', async () => {
    // The user's copy is trashed first and sorts first; Harnu's is wt-a.2.
    const users = osTrash(trash, makeFolder(path.join(root, 'ws', 'wt-a')), NOW - 5_000)
    const ours = await harnuTrash(makeFolder(path.join(root, 'ws', 'wt-a')), NOW)
    expect(ours.exact).toMatchObject({ name: 'wt-a.2' })
    const result = await emptyHarnuTrash([ours], [ours.key], env)
    expect(result.emptied).toEqual([ours.key])
    expect(existsSync(path.join(trash, 'files', users))).toBe(true)
    expect(existsSync(path.join(trash, 'files', 'wt-a.2'))).toBe(false)
  })

  it('an entry with no exact record is never touched, and says so', async () => {
    const folder = makeFolder(path.join(root, 'ws', 'wt-a'))
    osTrash(trash, folder, NOW)
    const legacy = asEntry(folder, NOW, null)
    const result = await emptyHarnuTrash([legacy], [legacy.key], env)
    expect(result.emptied).toEqual([])
    expect(result.unverifiable).toEqual([legacy.key])
    expect(existsSync(path.join(trash, 'files', 'wt-a'))).toBe(true)
  })

  it("a different folder moved into the same name is not Harnu's (the folder's own inode differs)", async () => {
    const folder = makeFolder(path.join(root, 'ws', 'wt-a'))
    const ours = await harnuTrash(folder)
    // Swap the data under the same name and keep a copy of the info file's identity as it was.
    rmSync(path.join(trash, 'files', 'wt-a'), { recursive: true })
    makeFolder(path.join(trash, 'files', 'wt-a'))
    const result = await emptyHarnuTrash([ours], [ours.key], env)
    expect(result.emptied).toEqual([])
    expect(result.changed).toEqual([ours.key])
    expect(existsSync(path.join(trash, 'files', 'wt-a', 'data.txt'))).toBe(true)
  })

  it('removes a symlink inside a trashed folder, never follows it out of the trash', async () => {
    const outside = path.join(root, 'precious')
    mkdirSync(outside)
    writeFileSync(path.join(outside, 'keep.txt'), 'keep me')
    const folder = makeFolder(path.join(root, 'ws', 'wt-a'))
    symlinkSync(outside, path.join(folder, 'link-out'))
    const ours = await harnuTrash(folder)
    await emptyHarnuTrash([ours], [ours.key], env)
    expect(existsSync(path.join(trash, 'files', 'wt-a'))).toBe(false)
    expect(existsSync(path.join(outside, 'keep.txt'))).toBe(true)
  })

  it('does nothing where the trash cannot be read item by item', async () => {
    const ours = await harnuTrash(makeFolder(path.join(root, 'ws', 'wt-a')))
    const result = await emptyHarnuTrash([ours], [ours.key], { ...env, platform: 'darwin' })
    expect(result.unsupported).toBe(true)
    expect(existsSync(path.join(trash, 'files', 'wt-a'))).toBe(true)
  })

  it('reports the bytes it emptied, from what the journal recorded', async () => {
    const a = await harnuTrash(makeFolder(path.join(root, 'ws', 'wt-a')))
    const b = await harnuTrash(makeFolder(path.join(root, 'ws', 'wt-b')), NOW + 1000)
    const result = await emptyHarnuTrash(
      [
        { ...a, bytes: 400 },
        { ...b, bytes: 600 }
      ],
      [a.key, b.key],
      env
    )
    expect(result.emptiedBytes).toBe(1000)
  })
})

describe('observeTrashEntries: is it still there?', () => {
  it('present, gone and changed are told apart; none of it reads a directory listing', async () => {
    const present = asEntry(
      '/ws/a',
      NOW,
      await recordTrash(env, makeFolder(path.join(root, 'ws', 'a')), async () => {
        osTrash(trash, path.join(root, 'ws', 'a'), NOW)
      })
    )
    const goneFolder = makeFolder(path.join(root, 'ws', 'b'))
    const goneEntry = asEntry(
      '/ws/b',
      NOW,
      await recordTrash(env, goneFolder, async () => {
        osTrash(trash, goneFolder, NOW + 1000)
      })
    )
    osRestore(trash, 'b', goneFolder)
    const r = await observeTrashEntries([present, goneEntry], env)
    expect(r.present.map((e) => e.key)).toEqual([present.key])
    expect(r.gone.map((e) => e.key)).toEqual([goneEntry.key])
    expect(r.unknown).toEqual([])
  })

  it('on macOS an entry is verified by its recorded name and inode in ~/.Trash', async () => {
    const macTrash = path.join(root, 'home', '.Trash')
    mkdirSync(macTrash, { recursive: true })
    const macEnv: TrashEnv = { ...env, platform: 'darwin', homeTrash: macTrash }
    const folder = makeFolder(path.join(root, 'ws', 'wt-a'))
    const record = await recordTrash(macEnv, folder, async () =>
      renameSync(folder, path.join(macTrash, 'wt-a'))
    )
    const entry = asEntry(folder, NOW, record)
    expect((await observeTrashEntries([entry], macEnv)).present).toHaveLength(1)
    rmSync(path.join(macTrash, 'wt-a'), { recursive: true })
    expect((await observeTrashEntries([entry], macEnv)).gone).toHaveLength(1)
  })

  it('where presence cannot be verified (Windows, or a journal line with no record) it says unknown', async () => {
    const legacy = asEntry('/ws/a', NOW, null)
    expect((await observeTrashEntries([legacy], env)).unknown.map((e) => e.key)).toEqual([
      legacy.key
    ])
    const withRecord = asEntry('/ws/a', NOW, {
      kind: 'freedesktop',
      trashDir: trash,
      name: 'a',
      deletionDate: localStamp(NOW),
      dev: 1,
      ino: 1,
      infoIno: 1,
      infoMtimeMs: 1
    })
    expect(
      (await observeTrashEntries([withRecord], { ...env, platform: 'win32' })).unknown
    ).toHaveLength(1)
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
  const exact = {
    kind: 'freedesktop' as const,
    trashDir: '/t',
    name: 'new',
    deletionDate: '2026-10-12T09:30:00',
    dev: 1,
    ino: 2,
    infoIno: 3,
    infoMtimeMs: 4
  }

  it('lists lines that recorded a trashed path, newest first, with their exact entry', () => {
    const entries = trashedEntries(
      [
        line({ at: NOW - 5000, trashedPath: '/ws/old', trashedBytes: 5, trashedAt: NOW - 5000 }),
        line({ at: NOW }), // nothing trashed
        line({
          at: NOW - 1000,
          trashedPath: '/ws/new',
          trashedBytes: 7,
          trashedAt: NOW - 1000,
          trashEntry: exact
        })
      ],
      new Set()
    )
    expect(entries.map((e) => e.path)).toEqual(['/ws/new', '/ws/old'])
    expect(entries[0]).toMatchObject({ bytes: 7, exact })
    expect(entries[1]!.exact).toBeNull()
  })

  it('skips what is already settled', () => {
    const l = line({ trashedPath: '/ws/a', trashedBytes: 5, trashedAt: NOW })
    expect(trashedEntries([l], new Set([trashKey(NOW, '/ws/a')]))).toEqual([])
  })
})

describe('only real trash directories count (freedesktop spec)', () => {
  it('a symlinked .Trash-<uid> is never a candidate, so nothing is recorded in it', async () => {
    const mount = path.join(root, 'mnt', 'disk')
    const elsewhere = path.join(root, 'elsewhere')
    mkdirSync(path.join(elsewhere, 'files'), { recursive: true })
    mkdirSync(path.join(elsewhere, 'info'), { recursive: true })
    mkdirSync(mount, { recursive: true })
    symlinkSync(elsewhere, path.join(mount, '.Trash-1000'))
    const folder = makeFolder(path.join(mount, 'work', 'wt-a'))
    const volEnv: TrashEnv = { ...env, isMountPoint: async (p) => p === mount }
    const record = await recordTrash(volEnv, folder, async () => {
      osTrash(elsewhere, folder, NOW, folder, mount)
    })
    expect(record).toBeNull()
  })

  it('a per-volume trash under a directory that is NOT a mount point is ignored', async () => {
    const notMount = path.join(root, 'plain', 'dir')
    const volTrash = path.join(notMount, '.Trash-1000')
    mkdirSync(volTrash, { recursive: true })
    const folder = makeFolder(path.join(notMount, 'wt-a'))
    const record = await recordTrash(env, folder, async () => {
      osTrash(volTrash, folder, NOW, folder, notMount)
    })
    expect(record).toBeNull()
  })

  it('a shared .Trash/<uid> needs a real .Trash with the sticky bit', async () => {
    const mount = path.join(root, 'mnt', 'disk')
    const shared = path.join(mount, '.Trash')
    const mine = path.join(shared, '1000')
    mkdirSync(mine, { recursive: true })
    const volEnv: TrashEnv = { ...env, isMountPoint: async (p) => p === mount }
    const withoutSticky = makeFolder(path.join(mount, 'a', 'wt-a'))
    expect(
      await recordTrash(volEnv, withoutSticky, async () => {
        osTrash(mine, withoutSticky, NOW, withoutSticky, mount)
      })
    ).toBeNull()
    chmodSync(shared, 0o1777)
    const withSticky = makeFolder(path.join(mount, 'b', 'wt-b'))
    const record = await recordTrash(volEnv, withSticky, async () => {
      osTrash(mine, withSticky, NOW, withSticky, mount)
    })
    expect(record).toMatchObject({ trashDir: mine, name: 'wt-b' })
  })

  it('"Empty" refuses a record whose trash directory became a symlink', async () => {
    const folder = makeFolder(path.join(root, 'ws', 'wt-a'))
    const record = await recordTrash(env, folder, async () => {
      osTrash(trash, folder, NOW)
    })
    const entry = asEntry(folder, NOW, record)
    const moved = path.join(root, 'moved-trash')
    renameSync(trash, moved)
    symlinkSync(moved, trash)
    const result = await emptyHarnuTrash([entry], [entry.key], env)
    expect(result.emptied).toEqual([])
    expect(result.changed).toEqual([entry.key])
    expect(existsSync(path.join(moved, 'files', 'wt-a', 'data.txt'))).toBe(true)
  })

  it('"Empty" refuses a record that points outside any trash directory of this user', async () => {
    const outside = path.join(root, 'not-a-trash')
    mkdirSync(path.join(outside, 'files', 'x'), { recursive: true })
    const lstat = lstatSync(path.join(outside, 'files', 'x'))
    const entry = asEntry('/ws/x', NOW, {
      kind: 'freedesktop',
      trashDir: outside,
      name: 'x',
      deletionDate: localStamp(NOW),
      dev: lstat.dev,
      ino: lstat.ino,
      ctimeMs: lstat.ctimeMs,
      infoIno: 1,
      infoMtimeMs: 1
    })
    const result = await emptyHarnuTrash([entry], [entry.key], env)
    expect(result.emptied).toEqual([])
    expect(existsSync(path.join(outside, 'files', 'x'))).toBe(true)
  })
})

describe('an unmounted volume is unknown, never gone (delta-1 item 6)', () => {
  const rec = (trashDir: string, dev: number) =>
    ({
      kind: 'freedesktop',
      trashDir,
      name: 'wt-a',
      deletionDate: localStamp(NOW),
      dev,
      ino: 5,
      ctimeMs: 1,
      infoIno: 6,
      infoMtimeMs: 1
    }) as const

  it('the trash dir is missing and the mount point sits on another device: unknown', async () => {
    const mount = path.join(root, 'mnt', 'disk') // exists, but "the disk" is not mounted on it
    mkdirSync(mount, { recursive: true })
    const entry = asEntry(
      path.join(mount, 'wt-a'),
      NOW,
      rec(path.join(mount, '.Trash-1000'), 424242)
    )
    const r = await observeTrashEntries([entry], env)
    expect(r.unknown.map((e) => e.key)).toEqual([entry.key])
    expect(r.gone).toEqual([])
  })

  it('the same missing dir on the SAME device is a trash that was really deleted: gone', async () => {
    const mount = path.join(root, 'mnt', 'disk')
    mkdirSync(mount, { recursive: true })
    const entry = asEntry(
      path.join(mount, 'wt-a'),
      NOW,
      rec(path.join(mount, '.Trash-1000'), lstatSync(mount).dev)
    )
    const r = await observeTrashEntries([entry], env)
    expect(r.gone.map((e) => e.key)).toEqual([entry.key])
  })
})

describe('no symlink between the trash dir and the entry (delta-2 item 2)', () => {
  async function harnuEntry(): Promise<TrashedEntry> {
    const folder = makeFolder(path.join(root, 'ws', 'wt-a'))
    const record = await recordTrash(env, folder, async () => {
      osTrash(trash, folder, NOW)
    })
    return asEntry(folder, NOW, record)
  }

  /** A folder the attacker (or a mistake) points `files/` at, holding a same-named entry of value. */
  function precious(): string {
    const dir = path.join(root, 'precious')
    mkdirSync(path.join(dir, 'wt-a'), { recursive: true })
    writeFileSync(path.join(dir, 'wt-a', 'keep.txt'), 'keep me')
    return dir
  }

  it('files/ swapped for a symlink AFTER the check: nothing outside the trash is deleted', async () => {
    const entry = await harnuEntry()
    const target = precious()
    const result = await emptyHarnuTrash([entry], [entry.key], env, {
      beforeDelete: async () => {
        renameSync(path.join(trash, 'files'), path.join(root, 'files-moved'))
        symlinkSync(target, path.join(trash, 'files'))
      }
    })
    expect(result.emptied).toEqual([])
    expect(existsSync(path.join(target, 'wt-a', 'keep.txt'))).toBe(true)
  })

  it('files/ already a symlink to a folder holding the very same entry: refused', async () => {
    const entry = await harnuEntry()
    const moved = path.join(root, 'files-moved')
    renameSync(path.join(trash, 'files'), moved)
    symlinkSync(moved, path.join(trash, 'files'))
    const result = await emptyHarnuTrash([entry], [entry.key], env)
    expect(result.emptied).toEqual([])
    expect(result.changed).toEqual([entry.key])
    expect(existsSync(path.join(moved, 'wt-a', 'data.txt'))).toBe(true)
  })

  it('info/ swapped for a symlink after the check: the record outside the trash is not deleted either', async () => {
    const entry = await harnuEntry()
    const target = path.join(root, 'elsewhere')
    mkdirSync(target)
    writeFileSync(path.join(target, 'wt-a.trashinfo'), 'not a trash record')
    await emptyHarnuTrash([entry], [entry.key], env, {
      beforeDelete: async () => {
        // The data goes first; swap info/ just before its record is removed.
      },
      betweenDeletes: async () => {
        renameSync(path.join(trash, 'info'), path.join(root, 'info-moved'))
        symlinkSync(target, path.join(trash, 'info'))
      }
    })
    expect(existsSync(path.join(target, 'wt-a.trashinfo'))).toBe(true)
  })
})

describe('a changed entry is not forgotten (delta-2 item 4)', () => {
  it('is reported as unknown ("can\'t check"), not gone: a remount that changes a device number must not make real entries vanish', async () => {
    const folder = makeFolder(path.join(root, 'ws', 'wt-a'))
    const record = await recordTrash(env, folder, async () => {
      osTrash(trash, folder, NOW)
    })
    // The same entry, but the device number it was recorded with is not the one it reports now.
    const entry = asEntry(folder, NOW, { ...record!, dev: record!.dev + 1 } as typeof record)
    const r = await observeTrashEntries([entry], env)
    expect(r.unknown.map((e) => e.key)).toEqual([entry.key])
    expect(r.gone).toEqual([])
    expect(r.present).toEqual([])
  })
})

describe('the first trash onto a volume is recorded too (delta-2 item 5)', () => {
  it('a .Trash-<uid> that the move itself creates is diffed after the move', async () => {
    const mount = path.join(root, 'mnt', 'fresh')
    mkdirSync(mount, { recursive: true })
    const volTrash = path.join(mount, '.Trash-1000')
    expect(existsSync(volTrash)).toBe(false)
    const folder = makeFolder(path.join(mount, 'work', 'wt-a'))
    const volEnv: TrashEnv = { ...env, isMountPoint: async (p) => p === mount }
    const record = await recordTrash(volEnv, folder, async () => {
      osTrash(volTrash, folder, NOW, folder, mount)
    })
    expect(record).toMatchObject({ trashDir: volTrash, name: 'wt-a' })
  })

  it('still records nothing when TWO new entries show up in the fresh directory', async () => {
    const mount = path.join(root, 'mnt', 'fresh')
    mkdirSync(mount, { recursive: true })
    const volTrash = path.join(mount, '.Trash-1000')
    const mine = makeFolder(path.join(mount, 'work', 'wt-a'))
    const users = makeFolder(path.join(mount, 'work', 'notes'))
    const volEnv: TrashEnv = { ...env, isMountPoint: async (p) => p === mount }
    const record = await recordTrash(volEnv, mine, async () => {
      osTrash(volTrash, mine, NOW, mine, mount)
      osTrash(volTrash, users, NOW, users, mount)
    })
    expect(record).toBeNull()
  })
})

describe('a parent of the trash dir swapped between the check and the delete (delta-3 item 2)', () => {
  it('redirects nothing: the entry is checked again against the record, on the same real path', async () => {
    const folder = makeFolder(path.join(root, 'ws', 'wt-a'))
    const record = await recordTrash(env, folder, async () => {
      osTrash(trash, folder, NOW)
    })
    const entry = asEntry(folder, NOW, record)
    // A decoy tree with the same layout and a same-named entry of value.
    const decoyShare = path.join(root, 'decoy', 'share')
    mkdirSync(path.join(decoyShare, 'Trash', 'files', 'wt-a'), { recursive: true })
    mkdirSync(path.join(decoyShare, 'Trash', 'info'), { recursive: true })
    writeFileSync(path.join(decoyShare, 'Trash', 'files', 'wt-a', 'keep.txt'), 'keep me')
    writeFileSync(path.join(decoyShare, 'Trash', 'info', 'wt-a.trashinfo'), 'decoy record')
    const share = path.join(root, 'home', '.local', 'share')
    const result = await emptyHarnuTrash([entry], [entry.key], env, {
      beforeDelete: async () => {
        renameSync(share, path.join(root, 'share-moved'))
        symlinkSync(decoyShare, share)
      }
    })
    expect(result.emptied).toEqual([])
    expect(existsSync(path.join(decoyShare, 'Trash', 'files', 'wt-a', 'keep.txt'))).toBe(true)
    expect(existsSync(path.join(decoyShare, 'Trash', 'info', 'wt-a.trashinfo'))).toBe(true)
  })

  it('also between the two deletes: the record is not removed through a swapped parent', async () => {
    const folder = makeFolder(path.join(root, 'ws', 'wt-a'))
    const record = await recordTrash(env, folder, async () => {
      osTrash(trash, folder, NOW)
    })
    const entry = asEntry(folder, NOW, record)
    const decoyShare = path.join(root, 'decoy', 'share')
    mkdirSync(path.join(decoyShare, 'Trash', 'files'), { recursive: true })
    mkdirSync(path.join(decoyShare, 'Trash', 'info'), { recursive: true })
    writeFileSync(path.join(decoyShare, 'Trash', 'info', 'wt-a.trashinfo'), 'decoy record')
    const share = path.join(root, 'home', '.local', 'share')
    await emptyHarnuTrash([entry], [entry.key], env, {
      betweenDeletes: async () => {
        renameSync(share, path.join(root, 'share-moved'))
        symlinkSync(decoyShare, share)
      }
    })
    expect(existsSync(path.join(decoyShare, 'Trash', 'info', 'wt-a.trashinfo'))).toBe(true)
  })
})
