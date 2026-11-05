/**
 * The pause executor behind the Containers service (U3.4): `service.pause` is serialized with the
 * other actions, judged on a fresh scan, journals through the real journal file, and refreshes the
 * view. Electron and the docker shell are mocked; userData is a throwaway temp dir.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const h = vi.hoisted(() => ({ userDataDir: '', runDocker: vi.fn() }))

vi.mock('electron', () => ({
  app: { getPath: (): string => h.userDataDir },
  ipcMain: { handle: vi.fn() }
}))
vi.mock('../src/main/containers/containers-shell', () => ({
  scanContainers: vi.fn(),
  dockerActions: {},
  runDocker: h.runDocker
}))

import { createContainersService } from '../src/main/containers/containers-ipc'
import { journalFile, readJournal } from '../src/main/containers/containers-journal'
import { pauseRun, readRestoreFacts } from '../src/main/containers/park-shell'
import type { ContainersSnapshot } from '../src/main/containers/containers-wire'
import { NOW, WT, available, containerRow, stackRow } from './containers-fixtures'

const STACK = stackRow({
  id: 'proj-82',
  verdict: 'zombie',
  containers: [containerRow({ service: 'app', ports: [8082] })],
  compose: { configFiles: [`${WT}/compose.yml`], envFile: null }
})
const decision = {
  stack: 'proj-82',
  containerIds: STACK.containers.map((c) => c.id),
  verdict: 'zombie' as const
}

function dockerFake(order: string[]) {
  return vi.fn(async (args: readonly string[]) => {
    if (args[0] === 'ps') {
      order.push('ps')
      return { stdout: STACK.containers.map((c) => c.id).join('\n') }
    }
    if (args[0] === 'inspect') {
      order.push('inspect')
      return {
        stdout: JSON.stringify(
          args.slice(1).map((id) => ({
            Id: id,
            Name: '/x',
            State: { Status: 'running' },
            Config: { Image: 'busybox' }
          }))
        )
      }
    }
    if (args.includes('config')) {
      order.push('config')
      return { stdout: JSON.stringify({ services: { app: { image: 'busybox' } } }) }
    }
    order.push('down')
    return { stdout: '' }
  })
}

beforeEach(async () => {
  h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-park-service-'))
  h.runDocker.mockReset()
})
afterEach(async () => {
  await fs.rm(h.userDataDir, { recursive: true, force: true })
})

describe('service.pause', () => {
  it('pauses on a fresh scan, journals as the given actor, and pushes a refreshed snapshot', async () => {
    const order: string[] = []
    const pushed: ContainersSnapshot[] = []
    const scan = vi.fn(async () => available([STACK]))
    const svc = createContainersService({
      scan,
      docker: { stop: vi.fn(), start: vi.fn(), removeContainers: vi.fn(), removeVolumes: vi.fn() },
      run: dockerFake(order),
      userDataDir: h.userDataDir,
      push: (s) => pushed.push(s),
      now: () => NOW
    })
    const out = await svc.pause(decision, 'autopilot')
    expect(out).toMatchObject({ ok: true, outcome: 'paused' })
    expect(order).toEqual(['ps', 'inspect', 'config', 'down'])
    const journal = await readJournal(journalFile(h.userDataDir))
    expect(journal).toHaveLength(1)
    expect(journal[0]).toMatchObject({ actor: 'autopilot', verb: 'stop' })
    expect(journal[0]!.stacks[0]!.paused?.restoreCommand).toContain('up -d')
    // one scan to judge the pause, one to refresh the view
    expect(scan).toHaveBeenCalledTimes(2)
    expect(pushed).toHaveLength(1)
  })

  it('waits for an action already in flight', async () => {
    const order: string[] = []
    let releaseStop: () => void = () => undefined
    const stop = vi.fn(
      () =>
        new Promise<{ done: string[]; error: null }>((resolve) => {
          releaseStop = () => resolve({ done: [], error: null })
          order.push('stop-started')
        })
    )
    const svc = createContainersService({
      scan: async () => available([STACK, stackRow({ id: 'other', verdict: 'zombie' })]),
      docker: { stop, start: vi.fn(), removeContainers: vi.fn(), removeVolumes: vi.fn() },
      run: dockerFake(order),
      userDataDir: h.userDataDir,
      push: () => undefined,
      now: () => NOW
    })
    const acting = svc.act({ verb: 'stop', stacks: ['other'] }, 'operator')
    await vi.waitFor(() => expect(order).toContain('stop-started'))
    const pausing = svc.pause(decision, 'autopilot')
    await new Promise((r) => setTimeout(r, 20))
    expect(order).toEqual(['stop-started']) // the pause has not touched docker yet
    releaseStop()
    await acting
    await pausing
    expect(order).toEqual(['stop-started', 'ps', 'inspect', 'config', 'down'])
  })

  it('a refused pause writes no journal line and still reports why', async () => {
    const svc = createContainersService({
      scan: async () => available([STACK]),
      docker: { stop: vi.fn(), start: vi.fn(), removeContainers: vi.fn(), removeVolumes: vi.fn() },
      run: dockerFake([]),
      userDataDir: h.userDataDir,
      push: () => undefined,
      now: () => NOW
    })
    const out = await svc.pause({ ...decision, containerIds: [] }, 'autopilot')
    expect(out).toMatchObject({ ok: false, code: 'CHANGED_SINCE_DECIDED' })
    expect(await readJournal(journalFile(h.userDataDir))).toEqual([])
  })

  it('an operator stop journals the compose command, with the profiles the probe found', async () => {
    const svc = createContainersService({
      scan: async () => available([STACK]),
      docker: {
        stop: async (ids) => ({ done: ids, error: null }),
        start: vi.fn(),
        removeContainers: vi.fn(),
        removeVolumes: vi.fn(),
        restoreFacts: async () => ({ configFiles: [], profiles: ['web'], hasBuild: true })
      },
      userDataDir: h.userDataDir,
      push: () => undefined,
      now: () => NOW
    })
    await svc.act({ verb: 'stop', stacks: ['proj-82'] }, 'operator')
    const [t] = await readJournal(journalFile(h.userDataDir))
    expect(t!.restoreHint).toBe(
      `docker compose -p proj-82 --project-directory ${WT} --profile web up -d --build`
    )
  })
})

describe('park-shell', () => {
  it('pauseRun gives docker a generous timeout (a down waits out grace periods)', async () => {
    h.runDocker.mockResolvedValue({ stdout: 'ok' })
    await pauseRun(['compose', 'down'])
    expect(h.runDocker).toHaveBeenCalledWith(
      ['compose', 'down'],
      expect.objectContaining({ timeout: 180_000 })
    )
  })

  it('readRestoreFacts reads profiles and build from compose config for the running services', async () => {
    h.runDocker.mockResolvedValue({
      stdout: JSON.stringify({
        services: {
          app: { image: 'x', build: { context: '.' } },
          web: { image: 'y', profiles: ['web'] }
        }
      })
    })
    const stack = stackRow({
      id: 'proj-82',
      verdict: 'zombie',
      containers: [containerRow({ service: 'app' }), containerRow({ service: 'web' })],
      compose: { configFiles: [`${WT}/compose.yml`], envFile: `${WT}/.env` }
    })
    expect(await readRestoreFacts(stack)).toEqual({
      configFiles: [`${WT}/compose.yml`],
      profiles: ['web'],
      envFile: `${WT}/.env`,
      hasBuild: true
    })
    expect(h.runDocker.mock.calls[0]![0]).toEqual([
      'compose',
      '-p',
      'proj-82',
      '--project-directory',
      WT,
      '-f',
      `${WT}/compose.yml`,
      '--env-file',
      `${WT}/.env`,
      '--profile',
      '*',
      'config',
      '--format',
      'json'
    ])
  })

  it('readRestoreFacts is null when compose cannot read the config, and for a standalone container', async () => {
    h.runDocker.mockRejectedValue(new Error('boom'))
    expect(await readRestoreFacts(stackRow({ id: 'p', verdict: 'zombie' }))).toBeNull()
    expect(
      await readRestoreFacts(
        stackRow({ id: 's', kind: 'container', project: null, verdict: 'zombie' })
      )
    ).toBeNull()
  })
})
