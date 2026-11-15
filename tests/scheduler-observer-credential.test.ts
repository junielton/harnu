/**
 * Missions v4 S-25 (delta 1) — the Scheduler's observe tick presents the OBSERVER credential, bound to
 * its worker's folder. An `act` worker and a steward keep the config they had.
 *
 * `tickMcpConfigFor` is where a tick's `--mcp-config` is chosen; the real control server is up so the
 * file it points at is the real one, and what is read back is what `claude` would read.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
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
vi.mock('../src/main/claude-reader', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  scanFolders: async (): Promise<unknown[]> => []
}))

import { registerMcpServer, closeMcpServer, writeScopedMcpConfig } from '../src/main/mcp/server'
import { createConfirmCore } from '../src/main/mcp/confirm-core'
import { setObserverMcpConfigWriter, tickMcpConfigFor } from '../src/main/scheduler-shell'
import { verifyScopedBearer } from '../src/main/mcp/scope'
import { verifyStewardBearer } from '../src/main/steward-core'
import type { Worker } from '../src/main/scheduler-core'

let serverToken = ''
const FOLDER = '/work/repo'

const worker = (over: Partial<Worker> = {}): Worker => ({
  id: 'w-1',
  name: 'watch',
  enabled: true,
  prompt: 'look',
  folder: FOLDER,
  everyMinutes: 5,
  runOnBoot: false,
  model: 'haiku',
  effort: 'low',
  mode: 'observe',
  timeoutSeconds: 300,
  carryLastResult: false,
  failureStreak: 0,
  ...over
})

const bearerIn = async (file: string): Promise<string> => {
  const doc = JSON.parse(await fs.readFile(file, 'utf8')) as {
    mcpServers: { harnu: { headers: { Authorization: string } } }
  }
  return doc.mcpServers.harnu.headers.Authorization.replace(/^Bearer /, '')
}

beforeAll(async () => {
  h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-observer-ud-'))
  await registerMcpServer(() => null, {
    bridge: { dispatch: async () => ({}) } as never,
    confirm: createConfirmCore({
      send: () => true,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      now: () => Date.now()
    })
  })
  serverToken = await bearerIn(path.join(h.userDataDir, 'harnu.mcp.json'))
})

afterAll(async () => {
  await closeMcpServer()
})

describe("an observe worker's tick is on the observer credential", () => {
  it('writes a config whose bearer proves the observer role for the worker folder, not the server secret', async () => {
    const file = await tickMcpConfigFor(worker())
    expect(file).toBeTruthy()
    expect(path.dirname(file as string)).toBe(path.join(h.userDataDir, 'scoped-mcp'))
    expect((await fs.stat(file as string)).mode & 0o777).toBe(0o600)
    const bearer = await bearerIn(file as string)
    expect(bearer).not.toBe(serverToken)
    expect(verifyScopedBearer(serverToken, bearer)).toEqual({ role: 'observer', folder: FOLDER })
  })

  it('two observe workers in two folders hold two different credentials', async () => {
    const a = await bearerIn((await tickMcpConfigFor(worker({ folder: '/work/a' }))) as string)
    const b = await bearerIn((await tickMcpConfigFor(worker({ folder: '/work/b' }))) as string)
    expect(verifyScopedBearer(serverToken, a)).toMatchObject({ folder: '/work/a' })
    expect(verifyScopedBearer(serverToken, b)).toMatchObject({ folder: '/work/b' })
  })

  it('an act worker keeps the main config, and a steward keeps its own bearer', async () => {
    const act = await tickMcpConfigFor(worker({ mode: 'act' }))
    expect(act).toBe(path.join(h.userDataDir, 'harnu.mcp.json'))
    const steward = await tickMcpConfigFor(
      worker({ mode: 'steward', category: 'steward', missionId: 'mnt-aaaaaaaa' })
    )
    expect(steward).toBe(path.join(h.userDataDir, 'steward-mcp', 'w-1.json'))
    expect(verifyStewardBearer(serverToken, await bearerIn(steward as string))).toBe('w-1')
  })

  it('when no credential can be written an observe tick gets no config, even with the main one on disk', async () => {
    setObserverMcpConfigWriter(async () => undefined)
    try {
      expect(await fs.stat(path.join(h.userDataDir, 'harnu.mcp.json'))).toBeTruthy()
      expect(await tickMcpConfigFor(worker())).toBeUndefined()
    } finally {
      setObserverMcpConfigWriter(writeScopedMcpConfig)
    }
  })

  it('before the credential writer is wired (boot) an observe tick gets no config, even with the main one on disk', async () => {
    setObserverMcpConfigWriter(null)
    try {
      expect(await fs.stat(path.join(h.userDataDir, 'harnu.mcp.json'))).toBeTruthy()
      expect(await tickMcpConfigFor(worker())).toBeUndefined()
      // An act worker is not affected by the writer: it keeps the main config.
      expect(await tickMcpConfigFor(worker({ mode: 'act' }))).toBe(
        path.join(h.userDataDir, 'harnu.mcp.json')
      )
    } finally {
      setObserverMcpConfigWriter(writeScopedMcpConfig)
    }
  })

  it('with the control server down an observe tick gets no config at all, never the main one', async () => {
    await closeMcpServer()
    expect(await tickMcpConfigFor(worker())).toBeUndefined()
  })
})
