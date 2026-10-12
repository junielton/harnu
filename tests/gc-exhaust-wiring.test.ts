// Delta-1 item 13: the wiring of gc-exhaust-shell, end to end, against a fake trash. A clean (the real
// executor, with the real trash-time recording and the real journal), then the trash listing, then
// "Empty", then a check that ONLY Harnu's exact entries were removed: not a folder the user trashed,
// not one the user restored and trashed again, not one Harnu trashed after the dialog opened.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { promises as fsp } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const h = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({
  app: { getPath: (): string => h.userData, isPackaged: false },
  ipcMain: { handle: (): void => {}, on: (): void => {} }
}))
vi.mock('../src/main/reaper/scanner-shell', () => ({ lastSnapshot: () => null }))

import { cleanItem, type ExecutorDeps } from '../src/main/reaper/executor-core'
import { appendTombstone } from '../src/main/reaper/journal'
import { recordTrash, type TrashEnv } from '../src/main/gc/trash-shell'
import {
  deleteConfirmedArchives,
  emptyHarnuTrashNow,
  expireArchivesNow,
  gatherTrash
} from '../src/main/gc/gc-exhaust-shell'
import { execFileSync } from 'node:child_process'
import type { ReapItem } from '../src/main/reaper/reaper-core'

let root: string
let trash: string
let env: TrashEnv

const pad = (n: number): string => String(n).padStart(2, '0')
function stamp(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** The OS trashing a folder: a rename into files/ and a fresh .trashinfo. */
function osTrash(folder: string): string {
  mkdirSync(path.join(trash, 'files'), { recursive: true })
  mkdirSync(path.join(trash, 'info'), { recursive: true })
  let name = path.basename(folder)
  for (let n = 2; existsSync(path.join(trash, 'info', `${name}.trashinfo`)); n++) {
    name = `${path.basename(folder)}.${n}`
  }
  renameSync(folder, path.join(trash, 'files', name))
  writeFileSync(
    path.join(trash, 'info', `${name}.trashinfo`),
    `[Trash Info]\nPath=${folder}\nDeletionDate=${stamp(Date.now())}\n`
  )
  return name
}

function folder(name: string): string {
  const p = path.join(root, 'ws', name)
  mkdirSync(p, { recursive: true })
  writeFileSync(path.join(p, 'data.txt'), name)
  return p
}

function item(p: string): ReapItem {
  return {
    id: `item-${path.basename(p)}`,
    repoPath: '/repo',
    kind: 'worktree',
    branch: `feat/${path.basename(p)}`,
    path: p,
    hidden: false,
    ageDays: 12,
    diskBytes: 1000,
    checkpoints: [],
    verdict: 'harvestable',
    blockers: [],
    needsRemoteDelete: false,
    justifiedBy: 'gh-merged'
  }
}

/** Harnu cleans a worktree: the real executor, trashing through the real recording. */
async function harnuClean(p: string): Promise<void> {
  const deps: ExecutorDeps = {
    probeStatus: async () => ({ trackedDirty: false, untracked: [] }),
    hasUnpushed: async () => false,
    trash: async (target) => ({
      trashEntry: await recordTrash(env, target, async () => {
        osTrash(target)
      })
    }),
    measureBytes: async () => 100,
    git: async () => '',
    resolveSha: async () => 'sha123',
    archiveTip: async (_r, _ref, sha) => sha,
    archiveWip: async () => 'wip123',
    detachSidebar: async () => undefined,
    canUnregister: async () => true,
    removeWorktreeAdmin: async () => true,
    appendTombstone,
    now: () => Date.now()
  }
  const r = await cleanItem(item(p), { deleteRemote: false }, deps)
  expect(r.ok).toBe(true)
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'harnu-exhaust-'))
  h.userData = path.join(root, 'userData')
  mkdirSync(h.userData, { recursive: true })
  trash = path.join(root, 'home', '.local', 'share', 'Trash')
  mkdirSync(path.join(trash, 'files'), { recursive: true })
  mkdirSync(path.join(trash, 'info'), { recursive: true })
  env = { platform: 'linux', homeTrash: trash, uid: 1000, isMountPoint: async () => false }
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const inTrash = (name: string): boolean => existsSync(path.join(trash, 'files', name, 'data.txt'))

describe('clean → list → empty, against a fake trash', () => {
  it('lists what Harnu trashed, and empties exactly those entries', async () => {
    await harnuClean(folder('wt-a'))
    await sleep(1100) // the trashinfo date has one-second resolution; keep the moves apart
    await harnuClean(folder('wt-b'))
    // The user's own trash, and a folder of theirs that shares a name with a Harnu one.
    const users = osTrash(folder('holiday'))

    const card = await gatherTrash(env)
    expect(card.inTrashCount).toBe(2)
    expect(card.entries.map((e) => e.name).sort()).toEqual(['wt-a', 'wt-b'])
    expect(card.inTrashBytes).toBe(200)
    expect(card.unverifiedCount).toBe(0)

    const ack = await emptyHarnuTrashNow(
      card.entries.map((e) => e.id),
      env
    )
    expect(ack).toMatchObject({ emptied: 2, skipped: 0, failed: 0, emptiedBytes: 200 })
    expect(inTrash('wt-a')).toBe(false)
    expect(inTrash('wt-b')).toBe(false)
    expect(inTrash(users)).toBe(true)
    expect((await gatherTrash(env)).inTrashCount).toBe(0)
  })

  it('probe A through the whole wiring: restored by the user, trashed again, it survives "Empty"', async () => {
    const wtA = folder('wt-a')
    await harnuClean(wtA)
    const dialog = await gatherTrash(env)
    // The user opens the trash, restores wt-a, works a bit, trashes it again.
    renameSync(path.join(trash, 'files', 'wt-a'), wtA)
    rmSync(path.join(trash, 'info', 'wt-a.trashinfo'))
    await sleep(1100)
    osTrash(wtA)
    const ack = await emptyHarnuTrashNow(
      dialog.entries.map((e) => e.id),
      env
    )
    expect(ack.emptied).toBe(0)
    expect(ack.skipped).toBe(1)
    expect(inTrash('wt-a')).toBe(true)
    expect(readFileSync(path.join(trash, 'files', 'wt-a', 'data.txt'), 'utf8')).toBe('wt-a')
  })

  it('what Harnu trashes while the dialog is open is not deleted by it (only the ids it listed)', async () => {
    await harnuClean(folder('wt-a'))
    const dialog = await gatherTrash(env) // the dialog lists wt-a
    await sleep(1100)
    await harnuClean(folder('wt-late')) // the autopilot cleans another one meanwhile
    const ack = await emptyHarnuTrashNow(
      dialog.entries.map((e) => e.id),
      env
    )
    expect(ack.emptied).toBe(1)
    expect(inTrash('wt-a')).toBe(false)
    expect(inTrash('wt-late')).toBe(true)
    // It is still listed, for the next time.
    expect((await gatherTrash(env)).entries.map((e) => e.name)).toEqual(['wt-late'])
  })

  it('an id that is not in the ledger deletes nothing', async () => {
    await harnuClean(folder('wt-a'))
    const ack = await emptyHarnuTrashNow(['0|/made/up'], env)
    expect(ack.emptied).toBe(0)
    expect(inTrash('wt-a')).toBe(true)
  })

  it('a journal line from before the exact record is listed as unverified, never as in the trash', async () => {
    const wtOld = folder('wt-old')
    const name = osTrash(wtOld)
    await appendTombstone({
      at: Date.now(),
      repoPath: '/repo',
      kind: 'worktree',
      branch: 'feat/old',
      sha: 'x',
      deleted: [],
      justifiedBy: null,
      restoreHint: null,
      archiveTipRef: null,
      archiveWipRef: null,
      trashedPath: wtOld,
      trashedBytes: 777,
      trashedAt: Date.now()
    })
    const card = await gatherTrash(env)
    expect(card.inTrashCount).toBe(0)
    expect(card.unverifiedCount).toBe(1)
    expect(card.unverifiedBytes).toBe(777)
    await emptyHarnuTrashNow(['anything'], env)
    expect(inTrash(name)).toBe(true)
  })

  it('a gather does not re-read the journal or any trash directory per entry (delta-1 item 10)', async () => {
    for (const n of ['wt-a', 'wt-b', 'wt-c']) {
      await harnuClean(folder(n))
      await sleep(5)
    }
    const readFile = vi.spyOn(fsp, 'readFile')
    const readdir = vi.spyOn(fsp, 'readdir')
    await gatherTrash(env)
    await gatherTrash(env)
    const journalReads = readFile.mock.calls.filter((c) =>
      String(c[0]).endsWith('reaper-log.jsonl')
    )
    // Read once for both gathers (it only changes by appending), not once per entry or per gather.
    expect(journalReads.length).toBeLessThanOrEqual(1)
    // Each entry is checked by its recorded name: no directory of the trash is listed at all.
    expect(readdir.mock.calls.filter((c) => String(c[0]).startsWith(trash))).toEqual([])
    readFile.mockRestore()
    readdir.mockRestore()
  })
})

describe('never-clean protects archives too (delta-2 item 1)', () => {
  const ENV = {
    ...process.env,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.com'
  }
  const gitIn = (cwd: string, ...a: string[]): string =>
    execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', env: ENV }).trim()
  const OLD = 'refs/archive/feat/old/20260101T000000Z/tip'

  /** A repo with one old archive, and a journal line naming it so Cleanup knows the repo. */
  async function repoWithOldArchive(name: string): Promise<string> {
    const repo = path.join(root, 'repos', name)
    mkdirSync(repo, { recursive: true })
    execFileSync('git', ['init', '-q', '-b', 'main', repo], { env: ENV })
    writeFileSync(path.join(repo, 'a.txt'), name)
    gitIn(repo, 'add', '-A')
    gitIn(repo, 'commit', '-q', '-m', 'x')
    gitIn(repo, 'update-ref', OLD, 'HEAD')
    await appendTombstone({
      at: Date.parse('2026-01-01T00:00:00Z'),
      repoPath: repo,
      kind: 'worktree',
      branch: 'feat/old',
      sha: 'x',
      deleted: [],
      justifiedBy: null,
      restoreHint: null,
      archiveTipRef: OLD,
      archiveWipRef: null
    })
    return repo
  }
  const has = (repo: string): boolean =>
    gitIn(repo, 'for-each-ref', 'refs/archive/').includes('feat/old')
  const NOW_MS = Date.parse('2026-10-12T12:00:00Z')

  it('the autopilot expiry skips a repo on the never-clean list, and expires the others', async () => {
    const kept = await repoWithOldArchive('kept')
    const other = await repoWithOldArchive('other')
    const r = await expireArchivesNow(30, NOW_MS, [kept])
    expect(r.deleted).toBe(1)
    expect(has(kept)).toBe(true)
    expect(has(other)).toBe(false)
  })

  it('a never-clean path ABOVE the repo protects it too, and so does a symlinked spelling', async () => {
    const repo = await repoWithOldArchive('inside')
    const link = path.join(root, 'link-to-repo')
    symlinkSync(repo, link)
    expect((await expireArchivesNow(30, NOW_MS, [path.join(root, 'repos')])).deleted).toBe(0)
    expect((await expireArchivesNow(30, NOW_MS, [link])).deleted).toBe(0)
    expect(has(repo)).toBe(true)
  })

  it('an archive of a folder that was under a never-clean path is protected, in a repo that is not', async () => {
    const repo = await repoWithOldArchive('plain')
    const protectedDir = path.join(root, 'protected-ws')
    await appendTombstone({
      at: Date.parse('2026-01-02T00:00:00Z'),
      repoPath: repo,
      kind: 'worktree',
      branch: 'feat/mine',
      sha: 'y',
      deleted: [],
      justifiedBy: null,
      restoreHint: null,
      archiveTipRef: 'refs/archive/feat/mine/20260102T000000Z/tip',
      archiveWipRef: null,
      trashedPath: path.join(protectedDir, 'wt-mine'),
      trashedAt: Date.parse('2026-01-02T00:00:00Z')
    })
    gitIn(repo, 'update-ref', 'refs/archive/feat/mine/20260102T000000Z/tip', 'HEAD')
    const r = await expireArchivesNow(30, NOW_MS, [protectedDir])
    expect(r.deleted).toBe(1) // feat/old goes
    expect(gitIn(repo, 'for-each-ref', 'refs/archive/')).toContain('feat/mine')
    expect(has(repo)).toBe(false)
  })

  it('deleting by hand refuses a never-clean repo too ("never cleaned, automatically or by hand")', async () => {
    const repo = await repoWithOldArchive('manual')
    const tip = gitIn(repo, 'rev-parse', OLD)
    const ack = await deleteConfirmedArchives(
      {
        repoPath: repo,
        archives: [
          { namespace: 'refs/archive/feat/old/20260101T000000Z', tipSha: tip, wipSha: null }
        ]
      },
      [repo]
    )
    expect(ack.neverClean).toBe(true)
    expect(ack.deleted).toBe(0)
    expect(has(repo)).toBe(true)
  })
})

describe('a read-only gather writes nothing (delta-2 item 3)', () => {
  const settledFile = (): string => path.join(h.userData, 'gc-trash-settled.json')

  it('gatherTrash with persist:false leaves the settled file alone, even for an entry that is gone', async () => {
    const wtA = folder('wt-a')
    await harnuClean(wtA)
    // The user restored it: the ledger would settle it as gone on a persisting gather.
    renameSync(path.join(trash, 'files', 'wt-a'), wtA)
    rmSync(path.join(trash, 'info', 'wt-a.trashinfo'))
    const card = await gatherTrash(env, { persist: false })
    expect(card.inTrashCount).toBe(0)
    expect(existsSync(settledFile())).toBe(false)
  })

  it("a persisting gather does settle it (the operator's and the timer's gathers keep the ledger tidy)", async () => {
    const wtA = folder('wt-a')
    await harnuClean(wtA)
    renameSync(path.join(trash, 'files', 'wt-a'), wtA)
    rmSync(path.join(trash, 'info', 'wt-a.trashinfo'))
    await gatherTrash(env)
    expect(existsSync(settledFile())).toBe(true)
  })
})
