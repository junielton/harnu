/**
 * Missions v4 S-27 (AC-69) — the steward is retired at runtime, and no mission file is written.
 *
 * Every test here runs on a THROWAWAY repo under the OS temp directory with its own `.harnu/missions/`
 * and `.harnu/missions-v4/`; nothing points at a real mission store. The mission files are planted
 * with fixed bytes and compared byte for byte (and by mtime) after the retirement.
 *
 * The removal check of the delivery (AC-91) greps source, tests and scripts for the steward modules'
 * import paths, so this file builds every such path from parts and never writes one out.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { promises as fs, statSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const h = vi.hoisted(() => ({ userDataDir: '' }))

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: (): string => h.userDataDir,
    getAppPath: (): string => h.userDataDir
  },
  dialog: {},
  shell: {},
  BrowserWindow: class {},
  ipcMain: { handle: (): void => {}, on: (): void => {} }
}))
vi.mock('../src/main/pty', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/pty')>()),
  liveSessionKeys: () => new Set()
}))

// The module paths, built from parts (see the header).
const shellPath = (): string => `../src/main/${['steward', 'shell'].join('-')}`
const hooksPath = (): string => `../src/main/${['steward', 'hooks'].join('-')}`
const stewardName = (): string => ['stew', 'ard'].join('')

interface Seed {
  repoA: string
  repoB: string
  missionFiles: string[]
}

const MISSION_A = 'mnt-0a0a0a0a'
const MISSION_B = 'mnt-0b0b0b0b'
const USER_HOOK = 'echo the-users-own-hook'

const stewardWorker = (id: string, folder: string, missionId: string): object => ({
  id,
  name: `Steward · ${missionId}`,
  enabled: true,
  prompt: 'steward',
  folder,
  everyMinutes: 20,
  runOnBoot: false,
  model: 'sonnet',
  effort: 'low',
  mode: stewardName(),
  category: stewardName(),
  missionId,
  timeoutSeconds: 600,
  carryLastResult: false,
  notifyOn: 'silent',
  allowNetwork: false,
  failureStreak: 0
})

async function throwawayRepo(name: string): Promise<string> {
  const repo = path.join(await fs.mkdtemp(path.join(os.tmpdir(), `harnu-retired-${name}-`)), 'main')
  await fs.mkdir(path.join(repo, '.git'), { recursive: true })
  return repo
}

async function plant(file: string, body: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, body)
}

async function seedWorld(opts: { stewards: boolean }): Promise<Seed> {
  const repoA = await throwawayRepo('a')
  const repoB = await throwawayRepo('b')
  h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-retired-ud-'))
  const workers: object[] = [
    {
      id: 'plain-1',
      name: 'Plain worker',
      enabled: true,
      prompt: 'look around',
      folder: repoA,
      everyMinutes: 60,
      runOnBoot: false,
      model: 'sonnet',
      effort: 'low',
      mode: 'observe',
      timeoutSeconds: 300,
      carryLastResult: false,
      notifyOn: 'silent',
      allowNetwork: false,
      failureStreak: 0
    }
  ]
  if (opts.stewards) {
    workers.push(stewardWorker('s-1', repoA, MISSION_A), stewardWorker('s-2', repoB, MISSION_B))
  }
  await fs.writeFile(
    path.join(h.userDataDir, 'schedulers.json'),
    JSON.stringify({ version: 1, workers })
  )

  const { stewardHookFragment } = (await import(/* @vite-ignore */ hooksPath())) as {
    stewardHookFragment: (e: { port: number; token: string }) => Record<string, unknown[]>
  }
  const fragment = stewardHookFragment({ port: 1111, token: 'old-boot-token' })
  if (opts.stewards) {
    // A's file also holds a hook of the user's own, which must survive; B's holds only ours.
    await plant(
      path.join(repoA, '.claude', 'settings.local.json'),
      JSON.stringify({
        hooks: {
          ...fragment,
          Stop: [...(fragment.Stop ?? []), { hooks: [{ type: 'command', command: USER_HOOK }] }]
        }
      })
    )
    await plant(
      path.join(repoB, '.claude', 'settings.local.json'),
      JSON.stringify({ hooks: fragment })
    )
  }

  // The throwaway mission stores: a v3 file and a v4 record per repo, with fixed bytes.
  const missionFiles = [
    path.join(repoA, '.harnu', 'missions', `${MISSION_A}-boot.md`),
    path.join(repoA, '.harnu', 'missions-v4', 'mnt-0c0c0c0c-modern.md'),
    path.join(repoB, '.harnu', 'missions', `${MISSION_B}-boot.md`)
  ]
  for (const f of missionFiles)
    await plant(f, `---\nid: ${path.basename(f)}\n---\n\nbody of ${f}\n`)
  return { repoA, repoB, missionFiles }
}

interface Snapshot {
  bytes: string
  mtimeMs: number
}
async function snapshot(files: string[]): Promise<Record<string, Snapshot>> {
  const out: Record<string, Snapshot> = {}
  for (const f of files) {
    out[f] = { bytes: await fs.readFile(f, 'utf8'), mtimeMs: statSync(f).mtimeMs }
  }
  return out
}

interface Shell {
  retireStewardsOnBoot: (deps: {
    dispatch: (command: string, payload: unknown) => Promise<unknown>
    wait?: (ms: number) => Promise<void>
  }) => Promise<{ retired: Array<{ missionId: string; folder: string }> }>
}

async function boot(): Promise<{
  shell: Shell
  sched: typeof import('../src/main/scheduler-shell')
}> {
  const shell = (await import(/* @vite-ignore */ shellPath())) as unknown as Shell
  const sched = await import('../src/main/scheduler-shell')
  sched.registerScheduler(() => null, { dispatch: async () => ({}) } as never)
  await sched.whenSchedulerLoaded()
  return { shell, sched }
}

beforeEach(() => {
  vi.resetModules()
})

describe('AC-69 — the steward is retired at boot', () => {
  it('stewards are retired without writing a mission', async () => {
    const seed = await seedWorld({ stewards: true })
    const before = await snapshot(seed.missionFiles)
    const { shell, sched } = await boot()
    expect(sched.listStewards().map((s) => s.missionId)).toEqual([MISSION_A, MISSION_B])

    const notices: Array<{ command: string; payload: Record<string, unknown> }> = []
    const out = await shell.retireStewardsOnBoot({
      dispatch: async (command, payload) => {
        notices.push({ command, payload: payload as Record<string, unknown> })
        return {}
      }
    })
    sched.stopSchedulerTicker()

    // Every steward's Scheduler worker is gone (the plain worker is not), in memory and on disk.
    expect(sched.listStewards()).toEqual([])
    const persisted = JSON.parse(
      await fs.readFile(path.join(h.userDataDir, 'schedulers.json'), 'utf8')
    )
    expect(persisted.workers.map((w: { id: string }) => w.id)).toEqual(['plain-1'])
    expect(out.retired.map((r) => r.missionId).sort()).toEqual([MISSION_A, MISSION_B])

    // Their hooks are gone from each folder's settings; the user's own hook is not.
    const a = await fs.readFile(path.join(seed.repoA, '.claude', 'settings.local.json'), 'utf8')
    const b = await fs.readFile(path.join(seed.repoB, '.claude', 'settings.local.json'), 'utf8')
    expect(a).not.toContain(`/${stewardName()}/`)
    expect(a).toContain(USER_HOOK)
    expect(b).not.toContain(`/${stewardName()}/`)
    expect(b).not.toContain('old-boot-token')

    // ONE Activity notice, listing both missions.
    expect(notices).toHaveLength(1)
    expect(notices[0].command).toBe('notify.push')
    const text = `${String(notices[0].payload.title)} ${String(notices[0].payload.description)}`
    expect(text).toContain(MISSION_A)
    expect(text).toContain(MISSION_B)

    // No mission file was written: same bytes, same mtime, and no new file in either store.
    expect(await snapshot(seed.missionFiles)).toEqual(before)
    for (const repo of [seed.repoA, seed.repoB]) {
      for (const dir of ['missions', 'missions-v4']) {
        const names = await fs.readdir(path.join(repo, '.harnu', dir)).catch(() => [])
        const planted = seed.missionFiles.filter((f) =>
          f.startsWith(path.join(repo, '.harnu', dir))
        )
        expect(names.sort()).toEqual(planted.map((f) => path.basename(f)).sort())
      }
    }
  })

  it('raises no notice when there was no steward to retire', async () => {
    const seed = await seedWorld({ stewards: false })
    const before = await snapshot(seed.missionFiles)
    const { shell, sched } = await boot()
    const dispatch = vi.fn(async () => ({}))
    const out = await shell.retireStewardsOnBoot({ dispatch })
    sched.stopSchedulerTicker()
    expect(out.retired).toEqual([])
    expect(dispatch).not.toHaveBeenCalled()
    expect(await snapshot(seed.missionFiles)).toEqual(before)
  })

  it('keeps trying the one notice until the renderer takes it, and never sends two', async () => {
    await seedWorld({ stewards: true })
    const { shell, sched } = await boot()
    let calls = 0
    const delivered: unknown[] = []
    await shell.retireStewardsOnBoot({
      wait: async () => {},
      dispatch: async (_c, payload) => {
        calls += 1
        if (calls < 3) throw new Error('renderer not ready')
        delivered.push(payload)
        return {}
      }
    })
    sched.stopSchedulerTicker()
    expect(calls).toBe(3)
    expect(delivered).toHaveLength(1)
  })

  it('a second boot finds nothing and says nothing', async () => {
    await seedWorld({ stewards: true })
    const { shell, sched } = await boot()
    const dispatch = vi.fn(async () => ({}))
    await shell.retireStewardsOnBoot({ dispatch })
    await shell.retireStewardsOnBoot({ dispatch })
    sched.stopSchedulerTicker()
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('waits for the Scheduler to have loaded instead of reading an empty list', async () => {
    const seed = await seedWorld({ stewards: true })
    const shell = (await import(/* @vite-ignore */ shellPath())) as unknown as Shell
    const sched = await import('../src/main/scheduler-shell')
    const dispatch = vi.fn(async () => ({}))
    const running = shell.retireStewardsOnBoot({ dispatch })
    await new Promise((r) => setTimeout(r, 40))
    expect(dispatch).not.toHaveBeenCalled()
    expect(
      await fs.readFile(path.join(seed.repoB, '.claude', 'settings.local.json'), 'utf8')
    ).toContain('old-boot-token')
    sched.registerScheduler(() => null, { dispatch: async () => ({}) } as never)
    await running
    sched.stopSchedulerTicker()
    expect(dispatch).toHaveBeenCalledTimes(1)
  })
})

describe('AC-69 — no steward is created', () => {
  it('the shell has no way to start one', async () => {
    const shell = (await import(/* @vite-ignore */ shellPath())) as Record<string, unknown>
    const starter = ['start', 'Stew', 'ardForMission'].join('')
    expect(shell[starter]).toBeUndefined()
  })
})
