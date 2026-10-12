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
  writeFileSync
} from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
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
import { emptyHarnuTrashNow, gatherTrash } from '../src/main/gc/gc-exhaust-shell'
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
})
