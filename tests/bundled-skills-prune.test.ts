/**
 * T616 — pruning the staged skill dirs of folders that no longer exist.
 *
 * `<userData>/skills/<folder-hash>/harnu/` is a regenerable copy, rebuilt at every spawn. It is
 * only harmful to delete while a running `claude` uses it as `--plugin-dir`, so the rule is about
 * live (or parked) sessions, not about whether the folder still exists. The decision is a pure
 * function (`planStagingPrune`); the shell (`pruneStagedSkills`) is exercised against a real
 * filesystem with Electron's `app` mocked, like `bundled-skills-staging.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  folderStageKey,
  planStagingPrune,
  STAGING_GRACE_MS,
  STAGING_JUST_STAGED_MS
} from '../src/main/bundled-skills-core'

const h = vi.hoisted(() => ({ userDataDir: '', appPath: '' }))

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: (): string => h.userDataDir,
    getAppPath: (): string => h.appPath
  },
  ipcMain: { handle: (): void => {} }
}))

const HOUR = 3_600_000
const DAY = 24 * HOUR
const NOW = Date.UTC(2026, 10, 13, 12, 0, 0)

const exists = (p: string): Promise<boolean> =>
  fs
    .access(p)
    .then(() => true)
    .catch(() => false)

async function load(): Promise<typeof import('../src/main/bundled-skills')> {
  vi.resetModules()
  return import('../src/main/bundled-skills')
}

describe('planStagingPrune (pure decision)', () => {
  const entry = (folder: string, ageMs: number) => ({
    name: folderStageKey(folder),
    isDirectory: true,
    mtimeMs: NOW - ageMs
  })

  it('AC-1: removes every old dir that is not in use, including ones with no metadata', () => {
    const plan = planStagingPrune({
      entries: [entry('/w/a', 30 * DAY), entry('/w/b', 10 * DAY), entry('/w/c', 2 * DAY)],
      inUseFolders: [],
      knownFolders: ['/w/a'],
      now: NOW
    })
    expect(plan.remove.sort()).toEqual(
      ['/w/a', '/w/b', '/w/c'].map((f) => folderStageKey(f)).sort()
    )
  })

  it('AC-2: never removes the dir of a folder with a live or parked session, however old', () => {
    const plan = planStagingPrune({
      entries: [entry('/w/live', 90 * DAY), entry('/w/dead', 90 * DAY)],
      inUseFolders: ['/w/live'],
      knownFolders: ['/w/live', '/w/dead'],
      now: NOW
    })
    expect(plan.remove).toEqual([folderStageKey('/w/dead')])
    expect(plan.keep).toContainEqual({ name: folderStageKey('/w/live'), reason: 'in-use' })
  })

  it('AC-3: an unmatched dir survives inside the grace window and goes after it', () => {
    const young = entry('/unknown/young', STAGING_GRACE_MS - HOUR)
    const old = entry('/unknown/old', STAGING_GRACE_MS + HOUR)
    const plan = planStagingPrune({
      entries: [young, old],
      inUseFolders: [],
      knownFolders: [],
      now: NOW
    })
    expect(plan.remove).toEqual([old.name])
    expect(plan.keep).toContainEqual({ name: young.name, reason: 'within-grace' })
  })

  it('AC-3: a known but idle folder is removed, unless it was staged moments ago', () => {
    const justNow = entry('/w/just-now', STAGING_JUST_STAGED_MS - 1000)
    const idle = entry('/w/idle', STAGING_JUST_STAGED_MS + 1000)
    const plan = planStagingPrune({
      entries: [justNow, idle],
      inUseFolders: [],
      knownFolders: ['/w/just-now', '/w/idle'],
      now: NOW
    })
    expect(plan.remove).toEqual([idle.name])
    expect(plan.keep).toContainEqual({ name: justNow.name, reason: 'just-staged' })
  })

  it('never touches entries that are not stage dirs (stray files, foreign names)', () => {
    const plan = planStagingPrune({
      entries: [
        { name: 'stray-file', isDirectory: false, mtimeMs: NOW - 99 * DAY },
        { name: 'abc123', isDirectory: true, mtimeMs: NOW - 99 * DAY },
        { name: folderStageKey('/f'), isDirectory: false, mtimeMs: NOW - 99 * DAY }
      ],
      inUseFolders: [],
      knownFolders: [],
      now: NOW
    })
    expect(plan.remove).toEqual([])
  })
})

describe('pruneStagedSkills (shell, real filesystem)', () => {
  let root: string

  beforeEach(async () => {
    h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-prune-ud-'))
    h.appPath = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-prune-app-'))
    root = path.join(h.userDataDir, 'skills')
    await fs.mkdir(root, { recursive: true })
    const base = path.join(h.appPath, 'resources', 'skills')
    await fs.mkdir(path.join(base, '.claude-plugin'), { recursive: true })
    await fs.writeFile(
      path.join(base, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'harnu', version: '1.0.0', description: 'test' })
    )
    await fs.writeFile(path.join(base, 'CATALOG.md'), '<!-- harnu-skills v1 -->\n')
    await fs.mkdir(path.join(base, 'skills', 'a'), { recursive: true })
    await fs.writeFile(
      path.join(base, 'skills', 'a', 'SKILL.md'),
      '---\nname: a\ndescription: skill a\n---\n\nbody\n'
    )
  })

  afterEach(async () => {
    // Undo any permission trap so the temp dirs can go.
    await fs.chmod(path.join(root, folderStageKey('/trap'), 'sub'), 0o700).catch(() => {})
  })

  /** Seed `<root>/<hash>/harnu/...` for a folder, with the dir's mtime set `ageMs` ago. */
  async function seed(folder: string, ageMs: number, legacyNoMeta = false): Promise<string> {
    const dir = path.join(root, folderStageKey(folder))
    await fs.mkdir(dir, { recursive: true })
    if (!legacyNoMeta) {
      await fs.mkdir(path.join(dir, 'harnu', 'skills', 'a'), { recursive: true })
      await fs.writeFile(path.join(dir, 'harnu', '.stamp'), 'v1\n')
    }
    const t = new Date(NOW - ageMs)
    await fs.utimes(dir, t, t)
    return dir
  }

  it('AC-1: removes dead dirs, legacy dirs with no metadata included; keeps strays', async () => {
    const dead = await seed('/w/dead', 20 * DAY)
    const legacy = await seed('/w/legacy', 20 * DAY, true)
    await fs.writeFile(path.join(root, 'stray-file'), 'keep')
    await fs.mkdir(path.join(root, 'abc123'), { recursive: true })
    const m = await load()
    const res = await m.pruneStagedSkills({
      inUseFolders: async () => [],
      knownFolders: async () => ['/w/dead'],
      now: () => NOW
    })
    expect(res.removed).toBe(2)
    expect(await exists(dead)).toBe(false)
    expect(await exists(legacy)).toBe(false)
    expect(await exists(path.join(root, 'stray-file'))).toBe(true)
    expect(await exists(path.join(root, 'abc123'))).toBe(true)
  })

  it('AC-2: keeps the dir of an in-use folder, removes the rest', async () => {
    const live = await seed('/w/live', 60 * DAY)
    const dead = await seed('/w/dead', 60 * DAY)
    const m = await load()
    await m.pruneStagedSkills({
      inUseFolders: async () => ['/w/live'],
      knownFolders: async () => ['/w/live', '/w/dead'],
      now: () => NOW
    })
    expect(await exists(live)).toBe(true)
    expect(await exists(dead)).toBe(false)
  })

  it('AC-3: an unmatched dir written moments ago survives; an old one does not', async () => {
    const fresh = await seed('/w/new-unknown', 5 * 60_000)
    const stale = await seed('/w/old-unknown', 3 * DAY)
    const m = await load()
    await m.pruneStagedSkills({
      inUseFolders: async () => [],
      knownFolders: async () => [],
      now: () => NOW
    })
    expect(await exists(fresh)).toBe(true)
    expect(await exists(stale)).toBe(false)
  })

  it('AC-4: a spawn into a pruned folder stages a fresh copy', async () => {
    await fs.writeFile(
      path.join(h.userDataDir, 'bundled-skills.json'),
      JSON.stringify({ version: 1, enabled: { a: true }, userLevelInstall: {} })
    )
    const m = await load()
    const first = await m.stageSkillsForFolder('/w/again')
    expect(first).not.toBeNull()
    const hashDir = path.dirname(first!.dir)
    const old = new Date(NOW - 40 * DAY)
    await fs.utimes(hashDir, old, old)
    const res = await m.pruneStagedSkills({
      inUseFolders: async () => [],
      knownFolders: async () => ['/w/again'],
      now: () => NOW
    })
    expect(res.removed).toBe(1)
    expect(await exists(first!.dir)).toBe(false)
    const second = await m.stageSkillsForFolder('/w/again')
    expect(second?.dir).toBe(first!.dir)
    expect(await exists(path.join(second!.dir, 'skills', 'a', 'SKILL.md'))).toBe(true)
  })

  it('a stage that is still current refreshes the dir mtime, so "unused for 24 h" is real', async () => {
    await fs.writeFile(
      path.join(h.userDataDir, 'bundled-skills.json'),
      JSON.stringify({ version: 1, enabled: { a: true }, userLevelInstall: {} })
    )
    const m = await load()
    const staged = await m.stageSkillsForFolder('/w/busy')
    const hashDir = path.dirname(staged!.dir)
    const old = new Date(Date.now() - 40 * DAY)
    await fs.utimes(hashDir, old, old)
    await m.stageSkillsForFolder('/w/busy') // stamp matches: no re-copy
    const st = await fs.stat(hashDir)
    expect(Date.now() - st.mtimeMs).toBeLessThan(HOUR)
  })

  it('AC-5: never throws, and prunes nothing when it cannot tell what is in use', async () => {
    const dead = await seed('/w/dead', 30 * DAY)
    const m = await load()
    await expect(
      m.pruneStagedSkills({
        inUseFolders: async () => {
          throw new Error('boom')
        },
        knownFolders: async () => [],
        now: () => NOW
      })
    ).resolves.toMatchObject({ removed: 0 })
    expect(await exists(dead)).toBe(true)
  })

  it('AC-5: an undeletable dir is skipped and the rest are still removed', async () => {
    const trap = await seed('/trap', 30 * DAY)
    await fs.mkdir(path.join(trap, 'sub'))
    await fs.writeFile(path.join(trap, 'sub', 'f'), 'x')
    await fs.chmod(path.join(trap, 'sub'), 0o500)
    const t = new Date(NOW - 30 * DAY)
    await fs.utimes(trap, t, t)
    const other = await seed('/w/other', 30 * DAY)
    const m = await load()
    const res = await m.pruneStagedSkills({
      inUseFolders: async () => [],
      knownFolders: async () => [],
      now: () => NOW
    })
    expect(await exists(other)).toBe(false)
    expect(res.failed).toBeGreaterThanOrEqual(1)
  })

  it('AC-5: a missing staging root is a quiet no-op', async () => {
    await fs.rm(root, { recursive: true, force: true })
    const m = await load()
    await expect(
      m.pruneStagedSkills({ inUseFolders: async () => [], knownFolders: async () => [] })
    ).resolves.toMatchObject({ removed: 0 })
  })
})
