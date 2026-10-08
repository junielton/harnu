/**
 * The Containers service and its IPC handlers (T330). Electron's `ipcMain` is
 * captured and the docker shell is mocked, so these tests drive the REAL
 * `containers:*` handlers — the renderer's path into the action function —
 * without a docker daemon. userData is a throwaway temp dir.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { BrowserWindow } from 'electron'

const h = vi.hoisted(() => ({
  userDataDir: '',
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  scan: vi.fn(),
  docker: {
    stop: vi.fn(),
    start: vi.fn(),
    removeContainers: vi.fn(),
    removeVolumes: vi.fn()
  }
}))

vi.mock('electron', () => ({
  app: { getPath: (): string => h.userDataDir },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown): void => {
      h.handlers.set(channel, fn)
    }
  }
}))

vi.mock('../src/main/containers/containers-shell', () => ({
  scanContainers: h.scan,
  dockerActions: h.docker
}))

import {
  INITIAL_DELAY_MS,
  createContainersService,
  getContainersService,
  registerContainersHandlers,
  type ContainersService
} from '../src/main/containers/containers-ipc'
import { defaultPrefs, prefsFile, writePrefs } from '../src/main/containers/containers-prefs'
import type {
  ActResult,
  ContainersPrefs,
  ContainersSnapshot,
  Tombstone
} from '../src/main/containers/containers-wire'
import { NOW, available, stackRow } from './containers-fixtures'

const STACKS = [
  stackRow({ id: 'z-run', verdict: 'zombie' }),
  stackRow({ id: 'z-off', verdict: 'zombie', running: false }),
  stackRow({ id: 'u', verdict: 'unknown' }),
  stackRow({ id: 'a', verdict: 'active' }),
  stackRow({ id: 'p', verdict: 'protected', running: false })
]
const SNAPSHOT = available(STACKS)

function resetDocker(): void {
  for (const fn of Object.values(h.docker)) {
    fn.mockReset()
    fn.mockImplementation(async (ids: string[]) => ({ done: ids, error: null }))
  }
}

const services: ContainersService[] = []

beforeEach(async () => {
  h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-containers-ipc-'))
  h.handlers.clear()
  h.scan.mockReset()
  h.scan.mockImplementation(async () => SNAPSHOT)
  resetDocker()
})

afterEach(async () => {
  for (const s of services.splice(0)) s.stop()
  vi.useRealTimers()
  await fs.rm(h.userDataDir, { recursive: true, force: true })
})

describe('registerContainersHandlers', () => {
  const sent: Array<[string, unknown]> = []
  const win = {
    isDestroyed: (): boolean => false,
    webContents: { send: (ch: string, payload: unknown): number => sent.push([ch, payload]) }
  } as unknown as BrowserWindow

  function register(): (channel: string, ...args: unknown[]) => Promise<unknown> {
    sent.length = 0
    services.push(registerContainersHandlers(() => win))
    return async (channel, ...args) => {
      const fn = h.handlers.get(channel)
      if (!fn) throw new Error(`no handler for ${channel}`)
      return fn({}, ...args)
    }
  }

  it('registers every containers channel and exposes the service to the MCP verbs', () => {
    register()
    expect([...h.handlers.keys()].sort()).toEqual([
      'containers:act',
      'containers:journal',
      'containers:prefs',
      'containers:scan',
      'containers:setPrefs',
      'containers:snapshot'
    ])
    expect(getContainersService()).toBe(services[0])
  })

  it('scan returns the snapshot, remembers it and pushes containers:update', async () => {
    const invoke = register()
    expect(await invoke('containers:snapshot')).toBeNull()
    const snap = await invoke('containers:scan')
    expect(snap).toBe(SNAPSHOT)
    expect(await invoke('containers:snapshot')).toBe(SNAPSHOT)
    // T332: the first scan also announces the two zombies it found, once.
    expect(sent).toEqual([
      ['containers:newZombies', { count: 2, names: ['z-run', 'z-off'] }],
      ['containers:update', SNAPSHOT]
    ])
    await invoke('containers:scan')
    expect(sent.map(([ch]) => ch)).toEqual([
      'containers:newZombies',
      'containers:update',
      'containers:update'
    ])
  })

  describe('containers:act refuses tier violations from the renderer (PRD §7.4)', () => {
    it('remove on a running stack → STACK_RUNNING, docker never called', async () => {
      const invoke = register()
      const res = (await invoke('containers:act', { verb: 'remove', stack: 'z-run' })) as ActResult
      expect(res.ok).toBe(false)
      expect(res.results).toEqual([
        expect.objectContaining({ stack: 'z-run', error: 'STACK_RUNNING' })
      ])
      expect(h.docker.removeContainers).not.toHaveBeenCalled()
    })

    it.each([
      [{ verb: 'stop', stacks: ['u'], force: true }],
      [{ verb: 'start', stacks: ['u'] }],
      [{ verb: 'remove', stack: 'u', removeVolumes: true }]
    ])('any action on unknown → STACK_NOT_ATTRIBUTABLE: %j', async (req) => {
      const invoke = register()
      const res = (await invoke('containers:act', req)) as ActResult
      expect(res.results[0]).toMatchObject({ ok: false, error: 'STACK_NOT_ATTRIBUTABLE' })
      for (const fn of Object.values(h.docker)) expect(fn).not.toHaveBeenCalled()
    })

    it('remove on active / protected is refused even when stopped', async () => {
      const invoke = register()
      const a = (await invoke('containers:act', { verb: 'remove', stack: 'a' })) as ActResult
      const p = (await invoke('containers:act', { verb: 'remove', stack: 'p' })) as ActResult
      expect(a.results[0]!.error).toBe('STACK_IN_USE')
      expect(p.results[0]!.error).toBe('STACK_PROTECTED')
      expect(h.docker.removeContainers).not.toHaveBeenCalled()
    })

    it('a bulk stop cannot be widened by the payload', async () => {
      const invoke = register()
      const res = (await invoke('containers:act', {
        verb: 'stop',
        bulk: true,
        stacks: ['a', 'u', 'p'],
        force: true
      })) as ActResult
      expect(res.results.map((r) => r.stack)).toEqual(['z-run'])
      expect(h.docker.stop).toHaveBeenCalledTimes(1)
    })

    it('a malformed payload is BAD_REQUEST', async () => {
      const invoke = register()
      const res = (await invoke('containers:act', {
        verb: 'remove',
        stacks: ['z-off']
      })) as ActResult
      expect(res).toMatchObject({ ok: false, error: 'BAD_REQUEST' })
      expect(h.scan).not.toHaveBeenCalled()
    })
  })

  it('an allowed action journals as the operator, whatever the payload claims, then pushes', async () => {
    const invoke = register()
    const res = (await invoke('containers:act', {
      verb: 'stop',
      stacks: ['z-run'],
      actor: 'agent'
    })) as ActResult
    expect(res.ok).toBe(true)
    const journal = (await invoke('containers:journal')) as Tombstone[]
    expect(journal).toHaveLength(1)
    expect(journal[0]).toMatchObject({ actor: 'operator', verb: 'stop' })
    const raw = await fs.readFile(path.join(h.userDataDir, 'containers-log.jsonl'), 'utf8')
    expect(raw.trim().split('\n')).toHaveLength(1)
    // The scan that judges the tiers is the first one, so it announces the zombies (T332).
    expect(sent.map(([ch]) => ch)).toEqual(['containers:newZombies', 'containers:update'])
  })

  it('prefs round-trip through userData, clamped', async () => {
    const invoke = register()
    expect(await invoke('containers:prefs')).toEqual(defaultPrefs())
    const next = (await invoke('containers:setPrefs', {
      ...defaultPrefs(),
      intervalMs: 10,
      zombieAfterDays: 0
    })) as ContainersPrefs
    expect(next).toMatchObject({ intervalMs: 1_800_000, zombieAfterDays: 1 })
    const onDisk = JSON.parse(await fs.readFile(prefsFile(h.userDataDir), 'utf8'))
    expect(onDisk).toEqual(next)
  })
})

describe('the service', () => {
  function service(over: Partial<Parameters<typeof createContainersService>[0]> = {}): {
    svc: ContainersService
    pushes: ContainersSnapshot[]
  } {
    const pushes: ContainersSnapshot[] = []
    const svc = createContainersService({
      scan: h.scan,
      docker: h.docker,
      userDataDir: h.userDataDir,
      push: (s) => pushes.push(s),
      now: () => NOW,
      ...over
    })
    services.push(svc)
    return { svc, pushes }
  }

  it('a slow start() read never overwrites a newer setPrefs', async () => {
    // start()'s prefs read is held open. It resolves with the pre-save defaults while setPrefs is
    // still writing the file, i.e. after the new value is in memory and before setPrefs returns.
    // The save must stand, in the value it returns and in what the service holds afterwards.
    const realRead = fs.readFile.bind(fs) as (...a: unknown[]) => Promise<unknown>
    const realMkdir = fs.mkdir.bind(fs) as (...a: unknown[]) => Promise<unknown>
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    vi.spyOn(fs, 'readFile').mockImplementationOnce((async (...a: unknown[]) => {
      await gate
      return realRead(...a)
    }) as unknown as typeof fs.readFile)
    const { svc } = service()
    const started = svc.start()
    vi.spyOn(fs, 'mkdir').mockImplementationOnce((async (...a: unknown[]) => {
      release()
      await started
      return realMkdir(...a)
    }) as unknown as typeof fs.mkdir)
    const saved = await svc.setPrefs({
      ...defaultPrefs(),
      intervalMs: 7_200_000,
      zombieAfterDays: 5
    })
    expect(saved).toMatchObject({ intervalMs: 7_200_000, zombieAfterDays: 5 })
    expect(await svc.prefs()).toMatchObject({ intervalMs: 7_200_000, zombieAfterDays: 5 })
    // A second save is judged against the saved value, not the stale default the read produced.
    const again = await svc.setPrefs({ ...saved, zombieAfterDays: 6 })
    expect(again.zombieAfterDays).toBe(6)
  })

  describe('background scan (PRD §6)', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    })

    it('scans every intervalMs after the initial delay, pushing each snapshot', async () => {
      await writePrefs(prefsFile(h.userDataDir), { ...defaultPrefs(), intervalMs: 1_800_000 })
      const { svc, pushes } = service()
      await svc.start()
      expect(vi.getTimerCount()).toBe(1)

      await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS - 1)
      expect(h.scan).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      await vi.waitFor(() => expect(pushes).toHaveLength(1))
      expect(h.scan).toHaveBeenCalledWith({ zombieAfterDays: 2, journal: [], now: NOW })

      await vi.advanceTimersByTimeAsync(1_800_000)
      await vi.waitFor(() => expect(pushes).toHaveLength(2))
      await vi.advanceTimersByTimeAsync(1_800_000)
      await vi.waitFor(() => expect(pushes).toHaveLength(3))
      expect(svc.snapshot()).toBe(SNAPSHOT)

      svc.stop()
      expect(vi.getTimerCount()).toBe(0)
    })

    it('arms nothing when autoScan is off', async () => {
      await writePrefs(prefsFile(h.userDataDir), { ...defaultPrefs(), autoScan: false })
      const { svc } = service()
      await svc.start()
      expect(vi.getTimerCount()).toBe(0)
    })

    it('setPrefs re-arms or disarms the schedule', async () => {
      const { svc } = service()
      await svc.start()
      expect(vi.getTimerCount()).toBe(1)
      await svc.setPrefs({ ...defaultPrefs(), autoScan: false })
      expect(vi.getTimerCount()).toBe(0)
      await svc.setPrefs({ ...defaultPrefs(), autoScan: true })
      expect(vi.getTimerCount()).toBe(1)
    })
  })

  it('an unexpected scan failure reads as docker unavailable, never as no stacks', async () => {
    h.scan.mockImplementation(async () => {
      throw new Error('spawn EACCES')
    })
    const { svc, pushes } = service()
    const snap = await svc.scan()
    expect(snap).toMatchObject({ dockerAvailable: false, dockerError: 'spawn EACCES' })
    expect('stacks' in snap).toBe(false)
    expect(pushes).toEqual([snap])
  })

  it('a new zombie threshold recomputes the verdicts right away', async () => {
    const { svc } = service()
    await svc.scan()
    await svc.setPrefs({ ...defaultPrefs(), zombieAfterDays: 7 })
    await vi.waitFor(() => expect(h.scan).toHaveBeenCalledTimes(2))
    expect(h.scan).toHaveBeenLastCalledWith(expect.objectContaining({ zombieAfterDays: 7 }))
  })

  it('judges every action on a scan started after the request', async () => {
    const { svc } = service()
    await svc.scan()
    h.scan.mockClear()
    await svc.act({ verb: 'stop', stacks: ['z-run'] }, 'agent')
    // One scan to judge the tiers, one to refresh the view afterwards.
    expect(h.scan).toHaveBeenCalledTimes(2)
  })

  it('runs actions one at a time', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const order: string[] = []
    h.docker.stop.mockImplementation(async (ids: string[]) => {
      order.push('stop:begin')
      await gate
      order.push('stop:end')
      return { done: ids, error: null }
    })
    h.docker.start.mockImplementation(async (ids: string[]) => {
      order.push('start')
      return { done: ids, error: null }
    })
    const { svc } = service()
    const first = svc.act({ verb: 'stop', stacks: ['z-run'] }, 'operator')
    const second = svc.act({ verb: 'start', stacks: ['z-off'] }, 'agent')
    await vi.waitFor(() => expect(order).toEqual(['stop:begin']))
    release()
    const [a, b] = await Promise.all([first, second])
    expect(order).toEqual(['stop:begin', 'stop:end', 'start'])
    expect([a.ok, b.ok]).toEqual([true, true])
    const journal = await svc.journal()
    expect(journal.map((t) => [t.verb, t.actor])).toEqual(
      expect.arrayContaining([
        ['stop', 'operator'],
        ['start', 'agent']
      ])
    )
  })
})
