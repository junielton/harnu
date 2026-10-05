import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

/**
 * T329 — `stop_containers` / `start_containers` / `remove_containers` driven
 * through the REAL wired handlers AND the REAL Containers service (T330):
 * `createContainersService` with U1's own action function, journal and
 * serialization. Only docker is faked — the scan returns fixture stacks and the
 * docker commands record what they were asked to do — so these tests pin the
 * tiers, the removal order and the journal exactly as an agent meets them.
 */

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: (): string => '/tmp',
    getAppPath: (): string => process.cwd()
  },
  dialog: {},
  shell: {},
  BrowserWindow: class {},
  ipcMain: { handle: (): void => {}, on: (): void => {} }
}))

const h = vi.hoisted(() => ({ service: null as unknown }))

vi.mock('../src/main/containers/containers-ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/containers/containers-ipc')>()
  return { ...actual, getContainersService: () => h.service }
})

import { WIRED_TOOLS } from '../src/main/mcp/tool-handlers'
import { createContainersService } from '../src/main/containers/containers-ipc'
import type { StackRow } from '../src/main/containers/containers-wire'
import { available, containerRow, MAIN, NOW, stackRow, WT } from './containers-fixtures'

const OTHER = '/home/dev/org/api-gateway'

function handlerFor(op: string) {
  return WIRED_TOOLS.find((t) => t.op === op)!.handler!
}
const stop = handlerFor('stop_containers')
const start = handlerFor('start_containers')
const remove = handlerFor('remove_containers')
const list = handlerFor('list_containers')

interface DockerCall {
  op: 'stop' | 'start' | 'rm' | 'volume rm'
  args: string[]
}

let calls: DockerCall[]
let stacks: StackRow[]
let dockerDown: string | null
let userData: string

function makeService(): unknown {
  const record =
    (op: DockerCall['op']) =>
    async (args: string[]): Promise<{ done: string[]; error: null }> => {
      calls.push({ op, args })
      return { done: args, error: null }
    }
  return createContainersService({
    scan: async (req) =>
      dockerDown
        ? {
            scannedAt: NOW,
            dockerAvailable: false,
            dockerError: dockerDown,
            zombieAfterDays: 2,
            recent: req.journal
          }
        : { ...available(stacks), recent: req.journal },
    docker: {
      stop: record('stop'),
      start: record('start'),
      removeContainers: record('rm'),
      removeVolumes: record('volume rm')
    },
    userDataDir: userData,
    push: () => {},
    now: () => NOW
  })
}

// Handlers are typed against the full ctx; these tests only need the fields the
// Containers handlers read.
function ctx(denyFolders: string[] = []): never {
  return { folder: '', folders: [], denyFolders, bridge: undefined } as never
}

function textOf(res: CallToolResult): string {
  const first = res.content[0]
  if (!first || first.type !== 'text') throw new Error('expected text content')
  return first.text
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function payloadOf(res: CallToolResult): any {
  return JSON.parse(textOf(res))
}

let zombie: StackRow
let stopped: StackRow

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'harnu-t329-'))
  calls = []
  dockerDown = null
  zombie = stackRow({ id: 'wave-1', verdict: 'zombie' })
  stopped = stackRow({
    id: 'wave-3',
    verdict: 'zombie',
    containers: [containerRow({ running: false, volumes: ['wave-3_data', 'shared_cache'] })],
    volumes: [
      { name: 'wave-3_data', sizeBytes: 5_000, shared: false },
      { name: 'shared_cache', sizeBytes: 1_000, shared: true }
    ]
  })
  stacks = [
    zombie,
    stopped,
    stackRow({ id: 'busy', verdict: 'active' }),
    stackRow({
      id: 'www',
      verdict: 'protected',
      attribution: {
        rung: 'compose-label',
        path: MAIN,
        folderPath: MAIN,
        folderKind: 'main-checkout'
      }
    }),
    stackRow({ id: 'stray', verdict: 'unknown' }),
    stackRow({ id: 'wave-0', verdict: 'orphan', running: false }),
    stackRow({ id: 'wave-2', verdict: 'pending', running: false })
  ]
  h.service = makeService()
})

afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true })
})

type Row = { stack: string; ok: boolean; error?: string }
const summary = (rows: Row[]): Array<[string, boolean, string | null]> =>
  rows.map((r) => [r.stack, r.ok, r.error ?? null])

describe('stop_containers (T329 AC-1)', () => {
  it('stops a zombie and reports the RAM and ports it freed', async () => {
    const res = await stop({ stacks: ['wave-1'] }, ctx())
    expect(res.isError).toBeFalsy()
    expect(payloadOf(res)).toEqual({
      ok: true,
      results: [{ stack: 'wave-1', ok: true, freedBytes: 100_000_000, portsReleased: [8080] }]
    })
    expect(calls).toEqual([{ op: 'stop', args: [zombie.containers[0]!.id] }])
  })

  it('refuses an unknown stack STACK_NOT_ATTRIBUTABLE — even with force', async () => {
    for (const force of [false, true]) {
      const res = await stop({ stacks: ['stray'], force }, ctx())
      expect(res.isError).toBe(true)
      expect(payloadOf(res).results).toEqual([
        {
          stack: 'stray',
          ok: false,
          freedBytes: 0,
          portsReleased: [],
          error: 'STACK_NOT_ATTRIBUTABLE',
          message: expect.any(String)
        }
      ])
    }
    expect(calls).toEqual([])
  })

  it('refuses active STACK_IN_USE and protected STACK_PROTECTED unless force', async () => {
    const res = await stop({ stacks: ['busy', 'www'] }, ctx())
    expect(res.isError).toBe(true)
    expect(summary(payloadOf(res).results)).toEqual([
      ['busy', false, 'STACK_IN_USE'],
      ['www', false, 'STACK_PROTECTED']
    ])
    expect(calls).toEqual([])

    const forced = await stop({ stacks: ['busy', 'www'], force: true }, ctx())
    expect(payloadOf(forced).ok).toBe(true)
    expect(calls.map((c) => c.op)).toEqual(['stop', 'stop'])
  })

  it('reports a partial failure per stack, never swallowed', async () => {
    const res = await stop({ stacks: ['wave-1', 'busy', 'nope'] }, ctx())
    expect(res.isError).toBe(true)
    const p = payloadOf(res)
    expect(p.ok).toBe(false)
    expect(summary(p.results)).toEqual([
      ['wave-1', true, null],
      ['busy', false, 'STACK_IN_USE'],
      ['nope', false, 'STACK_NOT_FOUND']
    ])
  })
})

describe('start_containers (T329 AC-2)', () => {
  it('refuses an orphan WORKTREE_GONE and an unknown stack STACK_NOT_ATTRIBUTABLE', async () => {
    const res = await start({ stacks: ['wave-0', 'stray'] }, ctx())
    expect(res.isError).toBe(true)
    expect(summary(payloadOf(res).results)).toEqual([
      ['wave-0', false, 'WORKTREE_GONE'],
      ['stray', false, 'STACK_NOT_ATTRIBUTABLE']
    ])
    expect(calls).toEqual([])
  })

  it('starts a stopped stack', async () => {
    const res = await start({ stacks: ['wave-3'] }, ctx())
    expect(payloadOf(res)).toEqual({ ok: true, results: [{ stack: 'wave-3', ok: true }] })
    expect(calls).toEqual([{ op: 'start', args: [stopped.containers[0]!.id] }])
  })
})

describe('remove_containers (T329 AC-3)', () => {
  it.each([
    ['wave-1', 'STACK_RUNNING'],
    ['busy', 'STACK_IN_USE'],
    ['www', 'STACK_PROTECTED'],
    ['wave-2', 'STACK_PENDING'],
    ['stray', 'STACK_NOT_ATTRIBUTABLE'],
    ['nope', 'STACK_NOT_FOUND']
  ])('refuses %s with %s and touches nothing', async (stack, code) => {
    const res = await remove({ stack, removeVolumes: true }, ctx())
    expect(res.isError).toBe(true)
    expect(payloadOf(res)).toMatchObject({
      ok: false,
      stack,
      error: code,
      removedContainers: [],
      removedVolumes: []
    })
    expect(calls).toEqual([])
  })

  it('removes containers before volumes, keeps a shared volume, and redacts the restore hint', async () => {
    const res = await remove({ stack: 'wave-3', removeVolumes: true }, ctx())
    expect(res.isError).toBeFalsy()
    expect(payloadOf(res)).toEqual({
      ok: true,
      stack: 'wave-3',
      removedContainers: [stopped.containers[0]!.id],
      removedVolumes: ['wave-3_data'],
      keptVolumes: ['shared_cache'],
      restoreHint: 'docker compose -p wave-3 --project-directory <PROJ-231-wave-1> up -d'
    })
    expect(calls).toEqual([
      { op: 'rm', args: [stopped.containers[0]!.id] },
      { op: 'volume rm', args: ['wave-3_data'] }
    ])
    expect(textOf(res)).not.toContain(MAIN)
  })

  it('keeps every volume when removeVolumes is not set', async () => {
    const p = payloadOf(await remove({ stack: 'wave-3' }, ctx()))
    expect(p).toMatchObject({ ok: true, removedVolumes: [] })
    expect(p.keptVolumes).toEqual(['wave-3_data', 'shared_cache'])
    expect(calls.map((c) => c.op)).toEqual(['rm'])
  })

  it('AC-9: a directory with a single quote never leaks, in the ACK or in list_containers.recent', async () => {
    const quoted = "/tmp/it's-a-worktree"
    stacks.push(
      stackRow({
        id: 'quoted',
        verdict: 'zombie',
        running: false,
        attribution: {
          rung: 'compose-label',
          path: quoted,
          folderPath: quoted,
          folderKind: 'worktree'
        }
      })
    )
    const hint = "docker compose -p quoted --project-directory <it's-a-worktree> up -d"
    const res = await remove({ stack: 'quoted' }, ctx())
    expect(payloadOf(res)).toMatchObject({ ok: true, restoreHint: hint })
    expect(textOf(res)).not.toContain('/tmp/it')

    const listed = await list({}, ctx())
    expect(payloadOf(listed).recent[0].restoreHint).toBe(hint)
    expect(textOf(listed)).not.toContain('/tmp/it')
  })

  it('takes one stack: a stacks list is refused by the action function too', async () => {
    const res = await remove({ stack: 'wave-3', stacks: ['wave-3', 'wave-1'] }, ctx())
    expect(res.isError).toBe(true)
    expect(payloadOf(res)).toMatchObject({ ok: false, error: 'BAD_REQUEST' })
    expect(calls).toEqual([])
  })
})

describe('the journal: one tombstone per call, actor agent (T329 AC-4)', () => {
  async function recent(): Promise<Array<{ actor: string; verb: string; stacks: Row[] }>> {
    return payloadOf(await list({}, ctx())).recent
  }

  it('a two-stack stop writes ONE tombstone naming both, and list_containers shows it', async () => {
    stacks.push(stackRow({ id: 'wave-4', verdict: 'zombie' }))
    await stop({ stacks: ['wave-1', 'wave-4'] }, ctx())
    const entries = await recent()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ actor: 'agent', verb: 'stop' })
    expect(entries[0]!.stacks.map((s) => s.stack)).toEqual(['wave-1', 'wave-4'])
  })

  it('start and remove each write one agent tombstone', async () => {
    await start({ stacks: ['wave-3'] }, ctx())
    await remove({ stack: 'wave-3', removeVolumes: true }, ctx())
    const entries = await recent()
    expect(entries.map((t) => [t.actor, t.verb])).toEqual(
      expect.arrayContaining([
        ['agent', 'start'],
        ['agent', 'remove']
      ])
    )
    expect(entries).toHaveLength(2)
  })

  it('a call refused outright writes nothing', async () => {
    await stop({ stacks: ['stray', 'busy'] }, ctx())
    await remove({ stack: 'wave-1' }, ctx())
    expect(await recent()).toEqual([])
  })
})

describe('blocked folders, docker down, not ready', () => {
  it('refuses a blocked folder’s stack FOLDER_NOT_ALLOWED and still acts on the rest', async () => {
    stacks.push(
      stackRow({
        id: 'gw',
        verdict: 'zombie',
        attribution: {
          rung: 'compose-label',
          path: OTHER,
          folderPath: OTHER,
          folderKind: 'worktree'
        }
      })
    )
    const p = payloadOf(await stop({ stacks: ['gw', 'wave-1'] }, ctx([OTHER])))
    expect(summary(p.results)).toEqual([
      ['gw', false, 'FOLDER_NOT_ALLOWED'],
      ['wave-1', true, null]
    ])
    expect(calls).toEqual([{ op: 'stop', args: [zombie.containers[0]!.id] }])
  })

  it('a remove in a blocked folder never reaches the action', async () => {
    const res = await remove({ stack: 'wave-3' }, ctx([WT]))
    expect(payloadOf(res)).toMatchObject({ ok: false, error: 'FOLDER_NOT_ALLOWED' })
    expect(calls).toEqual([])
    expect(payloadOf(await list({}, ctx())).recent).toEqual([])
  })

  it('DOCKER_UNAVAILABLE is a refusal carrying docker’s line, with no results', async () => {
    dockerDown = 'Cannot connect to the Docker daemon'
    const res = await stop({ stacks: ['wave-1'] }, ctx())
    expect(res.isError).toBe(true)
    const p = payloadOf(res)
    expect(p).toMatchObject({
      ok: false,
      error: 'DOCKER_UNAVAILABLE',
      dockerError: 'Cannot connect to the Docker daemon'
    })
    expect(p).not.toHaveProperty('results')
  })

  it('fails closed: docker down on the block check refuses before a later scan can let a blocked stack through', async () => {
    const act = vi.fn()
    let scans = 0
    h.service = {
      // Down for the block check, back up by the time the action would scan.
      scan: async () =>
        scans++ === 0
          ? {
              scannedAt: NOW,
              dockerAvailable: false,
              dockerError: 'Cannot connect to the Docker daemon',
              zombieAfterDays: 2,
              recent: []
            }
          : available(stacks),
      act
    }
    const res = await stop({ stacks: ['wave-1'] }, ctx([WT]))
    expect(res.isError).toBe(true)
    expect(payloadOf(res)).toMatchObject({ ok: false, error: 'DOCKER_UNAVAILABLE' })
    expect(act).not.toHaveBeenCalled()
    expect(scans).toBe(1)
  })

  it('refuses CONTAINERS_NOT_READY before the service is registered', async () => {
    h.service = null
    for (const [handler, args] of [
      [stop, { stacks: ['wave-1'] }],
      [start, { stacks: ['wave-1'] }],
      [remove, { stack: 'wave-1' }]
    ] as const) {
      const res = await handler(args as Record<string, unknown>, ctx())
      expect(res.isError).toBe(true)
      expect(textOf(res)).toMatch(/^CONTAINERS_NOT_READY/)
    }
  })
})

describe('each verb calls the one action function with its own verb (T329 AC-6)', () => {
  it.each([
    ['stop_containers', 'stop', { stacks: ['a'] }],
    ['start_containers', 'start', { stacks: ['a'] }],
    ['remove_containers', 'remove', { stack: 'a' }]
  ] as const)('%s → act({ verb: %s }, "agent")', async (op, verb, args) => {
    const act = vi.fn(async () => ({ ok: true, verb, results: [], tombstone: null }))
    h.service = { scan: async () => available([]), act }
    await handlerFor(op)({ ...args }, ctx())
    expect(act).toHaveBeenCalledTimes(1)
    expect(act.mock.calls[0]).toEqual([expect.objectContaining({ verb }), 'agent'])
  })
})
