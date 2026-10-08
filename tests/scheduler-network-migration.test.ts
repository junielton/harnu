/**
 * BUG-166 — boot migration: workers saved before `allowNetwork` existed load with the network
 * OFF, the file is healed (every worker carries an explicit `allowNetwork`), and ONE notice lists
 * the observe workers whose prompt names a URL or WebFetch. A second boot says nothing.
 *
 * e2e-shaped like tests/scheduler-store-load-guard.test.ts: the boot load and the file write are
 * the env-bound half (ADR-0001), so this runs against a real userData dir with Electron mocked.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

type IpcHandler = (event: unknown, ...args: never[]) => Promise<unknown>

const h = vi.hoisted(() => ({
  userDataDir: '',
  ipc: new Map<string, (event: unknown, ...args: never[]) => Promise<unknown>>()
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: (): string => h.userDataDir,
    getAppPath: (): string => h.userDataDir
  },
  dialog: {},
  shell: {},
  BrowserWindow: class {},
  ipcMain: {
    handle: (channel: string, fn: IpcHandler): void => {
      h.ipc.set(channel, fn)
    },
    on: (): void => {}
  }
}))

const base = {
  enabled: true,
  folder: '/repo',
  everyMinutes: 30,
  runOnBoot: false,
  model: 'haiku',
  effort: 'low',
  timeoutSeconds: 300,
  carryLastResult: false,
  failureStreak: 0
}

let stop: (() => void) | null = null

async function boot(): Promise<{
  dispatched: Array<{ cmd: string; args: Record<string, unknown> }>
}> {
  vi.resetModules()
  h.ipc.clear()
  const shell = await import('../src/main/scheduler-shell')
  const dispatched: Array<{ cmd: string; args: Record<string, unknown> }> = []
  shell.registerScheduler(() => null, {
    dispatch: async (cmd: string, args: Record<string, unknown>) => {
      dispatched.push({ cmd, args })
      return {}
    }
  } as unknown as Parameters<typeof shell.registerScheduler>[1])
  stop = shell.stopSchedulerTicker
  await h.ipc.get('scheduler:list')!({} as never)
  return { dispatched }
}

describe('BUG-166 — boot migration to allowNetwork: false', () => {
  beforeEach(async () => {
    h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-net-mig-'))
    await fs.writeFile(
      path.join(h.userDataDir, 'schedulers.json'),
      JSON.stringify({
        version: 1,
        workers: [
          {
            ...base,
            id: 'a',
            name: 'Status page',
            mode: 'observe',
            prompt: 'read https://status.example.com'
          },
          { ...base, id: 'b', name: 'Repo summary', mode: 'observe', prompt: 'summarise the repo' },
          {
            ...base,
            id: 'c',
            name: 'Fetcher',
            mode: 'observe',
            prompt: 'use WebFetch on the docs'
          },
          { ...base, id: 'd', name: 'Writer', mode: 'act', prompt: 'push to https://example.com' }
        ]
      })
    )
  })

  afterEach(() => {
    stop?.()
    stop = null
  })

  it('loads every legacy worker with network off', async () => {
    await boot()
    const list = (await h.ipc.get('scheduler:list')!({} as never)) as Array<{
      id: string
      allowNetwork: boolean
    }>
    expect(list.map((w) => [w.id, w.allowNetwork])).toEqual([
      ['a', false],
      ['b', false],
      ['c', false],
      ['d', false]
    ])
  })

  it('posts ONE notice naming exactly the observe workers that mention a URL or WebFetch', async () => {
    const { dispatched } = await boot()
    const notices = dispatched.filter((d) => d.cmd === 'notify.push')
    expect(notices).toHaveLength(1)
    const text = String(notices[0].args.description)
    expect(text).toContain('Status page')
    expect(text).toContain('Fetcher')
    expect(text).not.toContain('Repo summary')
    expect(text).not.toContain('Writer')
    expect(notices[0].args.folderPath).toBe('/repo')
  })

  it('heals the file, so the next boot has nothing to say', async () => {
    await boot()
    const healed = JSON.parse(
      await fs.readFile(path.join(h.userDataDir, 'schedulers.json'), 'utf8')
    ) as { workers: Array<{ allowNetwork: boolean }> }
    expect(healed.workers.every((w) => w.allowNetwork === false)).toBe(true)

    stop?.()
    const second = await boot()
    expect(second.dispatched.filter((d) => d.cmd === 'notify.push')).toEqual([])
  })

  it('a file with no worker mentioning the network heals silently', async () => {
    await fs.writeFile(
      path.join(h.userDataDir, 'schedulers.json'),
      JSON.stringify({
        version: 1,
        workers: [{ ...base, id: 'b', name: 'B', mode: 'observe', prompt: 'p' }]
      })
    )
    const { dispatched } = await boot()
    expect(dispatched.filter((d) => d.cmd === 'notify.push')).toEqual([])
    const healed = JSON.parse(
      await fs.readFile(path.join(h.userDataDir, 'schedulers.json'), 'utf8')
    ) as { workers: Array<{ allowNetwork: boolean }> }
    expect(healed.workers[0].allowNetwork).toBe(false)
  })

  it('a first-boot install with no file writes nothing and notifies nothing', async () => {
    await fs.rm(path.join(h.userDataDir, 'schedulers.json'))
    const { dispatched } = await boot()
    expect(dispatched).toEqual([])
    await expect(fs.access(path.join(h.userDataDir, 'schedulers.json'))).rejects.toThrow()
  })
})
