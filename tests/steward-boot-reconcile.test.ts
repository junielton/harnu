/**
 * Campaign ch.5a (T597) Delta 1 — the boot race. `registerHookBridge` resolves on its own clock and
 * `registerScheduler` loads the workers on another; reconciling stewards read the Scheduler's
 * in-memory list, so a bridge that came up FIRST reconciled against an empty list and re-pointed
 * nothing. `reconcileStewardsOnBoot` now waits for the Scheduler to have loaded.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
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
vi.mock('../src/main/hook-bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/hook-bridge')>()),
  getTaskStates: () => new Map(),
  addTaskEventObserver: () => () => {},
  getStewardHookEndpoint: () => ({ port: 5150, token: 'fresh-boot-token' })
}))
vi.mock('../src/main/pty', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/pty')>()),
  liveSessionKeys: () => new Set()
}))

const MISSION = 'mnt-0a0a0a0a'
let repo = ''

async function seedWorld(): Promise<void> {
  repo = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-boot-repo-')), 'main')
  await fs.mkdir(path.join(repo, '.git'), { recursive: true })
  h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-boot-ud-'))
  // A steward persisted by the previous boot, and hooks in the folder pointing at the OLD boot's port/token.
  await fs.writeFile(
    path.join(h.userDataDir, 'schedulers.json'),
    JSON.stringify({
      version: 1,
      workers: [
        {
          id: 'steward-1',
          name: 'Steward · boot',
          enabled: true,
          prompt: 'steward',
          folder: repo,
          everyMinutes: 20,
          runOnBoot: false,
          model: 'sonnet',
          effort: 'low',
          mode: 'steward',
          category: 'steward',
          missionId: MISSION,
          timeoutSeconds: 600,
          carryLastResult: false,
          notifyOn: 'silent',
          allowNetwork: false,
          failureStreak: 0
        }
      ]
    })
  )
  const { stewardHookFragment } = await import('../src/main/steward-hooks')
  await fs.mkdir(path.join(repo, '.claude'), { recursive: true })
  await fs.writeFile(
    path.join(repo, '.claude', 'settings.local.json'),
    JSON.stringify({ hooks: stewardHookFragment({ port: 1111, token: 'old-boot-token' }) })
  )
}

beforeEach(() => {
  vi.resetModules()
})

describe('reconcileStewardsOnBoot waits for the Scheduler', () => {
  it('the bridge resolving FIRST still finds the stewards and re-points their hooks at the live bridge', async () => {
    await seedWorld()
    const bridge = await import('../src/main/steward-bridge')
    const shell = await import('../src/main/scheduler-shell')

    // Boot order that used to lose: the bridge's `.then` runs reconcile before the Scheduler loaded.
    const reconciled = bridge.reconcileStewardsOnBoot()
    await new Promise((r) => setTimeout(r, 50))
    // Nothing has been reconciled yet: it is waiting, not running against an empty cache.
    expect(await fs.readFile(path.join(repo, '.claude', 'settings.local.json'), 'utf8')).toContain(
      'old-boot-token'
    )

    shell.registerScheduler(() => null, { dispatch: async () => ({}) } as never)
    await reconciled
    shell.stopSchedulerTicker()

    const after = await fs.readFile(path.join(repo, '.claude', 'settings.local.json'), 'utf8')
    expect(after).toContain('fresh-boot-token')
    expect(after).not.toContain('old-boot-token')
    expect(after).toContain(':5150/steward/')
  })

  it('whenSchedulerLoaded stays pending until registerScheduler has loaded the store', async () => {
    await seedWorld()
    const shell = await import('../src/main/scheduler-shell')
    let settled = false
    const waiting = shell.whenSchedulerLoaded().then(() => {
      settled = true
    })
    await new Promise((r) => setTimeout(r, 30))
    expect(settled).toBe(false)
    shell.registerScheduler(() => null, { dispatch: async () => ({}) } as never)
    await waiting
    expect(shell.listStewards().map((s) => s.missionId)).toEqual([MISSION])
    shell.stopSchedulerTicker()
  })
})
