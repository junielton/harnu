/**
 * T316 — the `update_worker` / `delete_worker` handlers, against a real
 * filesystem (`scheduler-shell.ts` / `scheduler-store.ts` are env-bound
 * shells, e2e-only per ADR-0001 — the security GATE decision for the
 * `forceConfirmFor` narrowing is pinned separately, purely, in
 * mcp-plan-tool-call.test.ts; this file pins what the verbs actually DO once
 * dispatched).
 *
 * Mirrors tests/mcp-create-worker-handler.test.ts's fixture/boot conventions.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const h = vi.hoisted(() => ({ userDataDir: '', appPath: '' }))

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: (): string => h.userDataDir,
    getAppPath: (): string => h.appPath
  },
  dialog: {},
  shell: {},
  BrowserWindow: class {},
  ipcMain: { handle: (): void => {}, on: (): void => {} }
}))

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

async function seedPluginManifest(appPath: string): Promise<void> {
  const base = path.join(appPath, 'resources', 'skills')
  await fs.mkdir(path.join(base, '.claude-plugin'), { recursive: true })
  await fs.writeFile(
    path.join(base, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'harnu', version: '1.0.0', description: 'test' }),
    'utf8'
  )
}

interface Payload {
  [key: string]: unknown
}

function payloadOf(res: { content: Array<{ type: string; text?: string }> }): Payload {
  const first = res.content[0]
  if (!first || first.type !== 'text' || !first.text) throw new Error('expected text content')
  return JSON.parse(first.text)
}

function errText(res: {
  isError?: boolean
  content: Array<{ type: string; text?: string }>
}): string {
  expect(res.isError).toBe(true)
  const first = res.content[0]
  if (!first || first.type !== 'text') throw new Error('expected text content')
  return first.text
}

async function loadHandlers(): Promise<typeof import('../src/main/mcp/tool-handlers')> {
  vi.resetModules()
  const handlers = await import('../src/main/mcp/tool-handlers')
  const shell = await import('../src/main/scheduler-shell')
  shell.registerScheduler(
    () => null,
    {} as unknown as Parameters<typeof shell.registerScheduler>[1]
  )
  stopTicker = shell.stopSchedulerTicker
  return handlers
}

let stopTicker: (() => void) | null = null

const baseCtx = { folders: [], denyFolders: [], bridge: undefined }

describe('update_worker / delete_worker handlers (T316)', () => {
  let folder: string

  beforeEach(async () => {
    h.userDataDir = await tmpDir('harnu-worker-ud-')
    h.appPath = await tmpDir('harnu-worker-app-')
    await seedPluginManifest(h.appPath)
    folder = await tmpDir('harnu-worker-repo-')
  })

  afterEach(() => {
    stopTicker?.()
    stopTicker = null
  })

  it("AC-1/AC-2: edits an existing worker's prompt, merged through the store, and the new prompt is what persists", async () => {
    const { WIRED_TOOLS } = await loadHandlers()
    const createWorker = WIRED_TOOLS.find((t) => t.op === 'create_worker')!.handler!
    const updateWorker = WIRED_TOOLS.find((t) => t.op === 'update_worker')!.handler!

    const created = payloadOf(
      await createWorker(
        {
          folder,
          name: 'PR Review Watch',
          prompt: 'Report candidates. Do not modify anything — read-only.',
          everyMinutes: 30,
          mode: 'act'
        },
        { ...baseCtx, folder }
      )
    )

    const res = await updateWorker(
      { id: created.id, set: { prompt: 'Dispatch /dispatch-pr-review for each candidate.' } },
      { ...baseCtx, folder }
    )
    const payload = payloadOf(res)
    expect(payload.ok).toBe(true)
    expect(payload.id).toBe(created.id)

    const stored = JSON.parse(
      await fs.readFile(path.join(h.userDataDir, 'schedulers.json'), 'utf8')
    ) as { workers: Array<{ id: string; prompt: string; mode: string; everyMinutes: number }> }
    const found = stored.workers.find((w) => w.id === created.id)
    expect(found?.prompt).toBe('Dispatch /dispatch-pr-review for each candidate.')
    // Untouched fields survive the merge.
    expect(found?.mode).toBe('act')
    expect(found?.everyMinutes).toBe(30)
  })

  // BUG-166 — the handler writes `allowNetwork` through the same store, and the ACK reports the
  // resulting value so the agent reads what actually took effect.
  it('BUG-166: create_worker and update_worker carry allowNetwork, default it to false, and report it', async () => {
    const { WIRED_TOOLS } = await loadHandlers()
    const createWorker = WIRED_TOOLS.find((t) => t.op === 'create_worker')!.handler!
    const updateWorker = WIRED_TOOLS.find((t) => t.op === 'update_worker')!.handler!

    const plain = payloadOf(
      await createWorker(
        { folder, name: 'w', prompt: 'p', everyMinutes: 20 },
        { ...baseCtx, folder }
      )
    )
    expect(plain.allowNetwork).toBe(false)

    const online = payloadOf(
      await createWorker(
        { folder, name: 'w2', prompt: 'p', everyMinutes: 20, allowNetwork: true },
        { ...baseCtx, folder }
      )
    )
    expect(online.allowNetwork).toBe(true)

    const on = payloadOf(
      await updateWorker({ id: plain.id, set: { allowNetwork: true } }, { ...baseCtx, folder })
    )
    expect(on.allowNetwork).toBe(true)
    const off = payloadOf(
      await updateWorker({ id: plain.id, set: { allowNetwork: false } }, { ...baseCtx, folder })
    )
    expect(off.allowNetwork).toBe(false)

    const stored = JSON.parse(
      await fs.readFile(path.join(h.userDataDir, 'schedulers.json'), 'utf8')
    ) as { workers: Array<{ id: string; allowNetwork: boolean }> }
    expect(stored.workers.find((w) => w.id === plain.id)?.allowNetwork).toBe(false)
    expect(stored.workers.find((w) => w.id === online.id)?.allowNetwork).toBe(true)
  })

  it('merges a subset of fields, leaving everything else exactly as it was', async () => {
    const { WIRED_TOOLS } = await loadHandlers()
    const createWorker = WIRED_TOOLS.find((t) => t.op === 'create_worker')!.handler!
    const updateWorker = WIRED_TOOLS.find((t) => t.op === 'update_worker')!.handler!

    const created = payloadOf(
      await createWorker(
        { folder, name: 'w', prompt: 'p', everyMinutes: 20, mode: 'observe' },
        { ...baseCtx, folder }
      )
    )
    const res = await updateWorker(
      { id: created.id, set: { everyMinutes: 60 } },
      { ...baseCtx, folder }
    )
    const payload = payloadOf(res)
    expect(payload.everyMinutes).toBe(60)
    expect(payload.name).toBe('w')
    expect(payload.mode).toBe('observe')
  })

  it('AC-6: warns when the new prompt names a skill mention that resolves to nothing', async () => {
    const { WIRED_TOOLS } = await loadHandlers()
    const createWorker = WIRED_TOOLS.find((t) => t.op === 'create_worker')!.handler!
    const updateWorker = WIRED_TOOLS.find((t) => t.op === 'update_worker')!.handler!

    const created = payloadOf(
      await createWorker(
        { folder, name: 'w', prompt: 'p', everyMinutes: 20 },
        { ...baseCtx, folder }
      )
    )
    const res = await updateWorker(
      { id: created.id, set: { prompt: 'Use /definitely-not-a-real-skill for this.' } },
      { ...baseCtx, folder }
    )
    const payload = payloadOf(res)
    expect(payload.ok).toBe(true)
    expect(payload.warning as string).toMatch(/definitely-not-a-real-skill/)
  })

  it('does NOT recompute missingSkills when the prompt is untouched', async () => {
    const { WIRED_TOOLS } = await loadHandlers()
    const createWorker = WIRED_TOOLS.find((t) => t.op === 'create_worker')!.handler!
    const updateWorker = WIRED_TOOLS.find((t) => t.op === 'update_worker')!.handler!

    const created = payloadOf(
      await createWorker(
        {
          folder,
          name: 'w',
          prompt: 'Use /definitely-not-a-real-skill for this.',
          everyMinutes: 20
        },
        { ...baseCtx, folder }
      )
    )
    const res = await updateWorker(
      { id: created.id, set: { everyMinutes: 25 } },
      { ...baseCtx, folder }
    )
    expect(payloadOf(res).warning).toBeUndefined()
  })

  it('WORKER_NOT_FOUND for an id that does not exist', async () => {
    const { WIRED_TOOLS } = await loadHandlers()
    const updateWorker = WIRED_TOOLS.find((t) => t.op === 'update_worker')!.handler!
    const res = await updateWorker(
      { id: 'does-not-exist', set: { everyMinutes: 10 } },
      { ...baseCtx, folder }
    )
    expect(errText(res)).toMatch(/WORKER_NOT_FOUND/)
  })

  it('rejects a missing id, an empty set, or an out-of-range field', async () => {
    const { WIRED_TOOLS } = await loadHandlers()
    const createWorker = WIRED_TOOLS.find((t) => t.op === 'create_worker')!.handler!
    const updateWorker = WIRED_TOOLS.find((t) => t.op === 'update_worker')!.handler!
    const created = payloadOf(
      await createWorker(
        { folder, name: 'w', prompt: 'p', everyMinutes: 20 },
        { ...baseCtx, folder }
      )
    )

    expect(
      errText(await updateWorker({ set: { everyMinutes: 10 } }, { ...baseCtx, folder }))
    ).toMatch(/BAD_ARGS/)
    expect(
      errText(await updateWorker({ id: created.id, set: {} }, { ...baseCtx, folder }))
    ).toMatch(/BAD_ARGS/)
    expect(
      errText(
        await updateWorker({ id: created.id, set: { everyMinutes: 0 } }, { ...baseCtx, folder })
      )
    ).toMatch(/BAD_ARGS/)
    expect(
      errText(
        await updateWorker({ id: created.id, set: { mode: 'bogus' } }, { ...baseCtx, folder })
      )
    ).toMatch(/BAD_ARGS/)
  })

  it('reports tickInFlight:false when no tick is running', async () => {
    const { WIRED_TOOLS } = await loadHandlers()
    const createWorker = WIRED_TOOLS.find((t) => t.op === 'create_worker')!.handler!
    const updateWorker = WIRED_TOOLS.find((t) => t.op === 'update_worker')!.handler!
    const created = payloadOf(
      await createWorker(
        { folder, name: 'w', prompt: 'p', everyMinutes: 20 },
        { ...baseCtx, folder }
      )
    )
    const res = await updateWorker(
      { id: created.id, set: { everyMinutes: 25 } },
      { ...baseCtx, folder }
    )
    expect(payloadOf(res).tickInFlight).toBe(false)
  })

  it('SCHEDULER_NOT_READY before the scheduler has booted', async () => {
    vi.resetModules()
    const { WIRED_TOOLS } = await import('../src/main/mcp/tool-handlers')
    const updateWorker = WIRED_TOOLS.find((t) => t.op === 'update_worker')!.handler!
    const res = await updateWorker(
      { id: 'anything', set: { everyMinutes: 10 } },
      { ...baseCtx, folder }
    )
    expect(errText(res)).toMatch(/SCHEDULER_NOT_READY/)
  })

  it('AC-4: delete_worker removes the worker AND its run history', async () => {
    const { WIRED_TOOLS } = await loadHandlers()
    const createWorker = WIRED_TOOLS.find((t) => t.op === 'create_worker')!.handler!
    const listWorkers = WIRED_TOOLS.find((t) => t.op === 'list_workers')!.handler!
    const deleteWorker = WIRED_TOOLS.find((t) => t.op === 'delete_worker')!.handler!

    const created = payloadOf(
      await createWorker(
        { folder, name: 'w', prompt: 'p', everyMinutes: 20 },
        { ...baseCtx, folder }
      )
    )
    const runsDir = path.join(h.userDataDir, 'scheduler-runs')
    await fs.mkdir(runsDir, { recursive: true })
    const runFile = path.join(runsDir, `${created.id}.jsonl`)
    await fs.writeFile(runFile, '', 'utf8')

    const res = await deleteWorker({ id: created.id }, { ...baseCtx, folder })
    const payload = payloadOf(res)
    expect(payload.ok).toBe(true)
    expect(payload.wasRunning).toBe(false)

    const list = payloadOf(await listWorkers({ folder }, { ...baseCtx, folder }))
    expect(list.workers).toEqual([])

    const stored = JSON.parse(
      await fs.readFile(path.join(h.userDataDir, 'schedulers.json'), 'utf8')
    ) as { workers: unknown[] }
    expect(stored.workers.find((w) => (w as { id: string }).id === created.id)).toBeUndefined()
    await expect(fs.access(runFile)).rejects.toThrow()
  })

  it('WORKER_NOT_FOUND deleting an id that does not exist', async () => {
    const { WIRED_TOOLS } = await loadHandlers()
    const deleteWorker = WIRED_TOOLS.find((t) => t.op === 'delete_worker')!.handler!
    const res = await deleteWorker({ id: 'does-not-exist' }, { ...baseCtx, folder })
    expect(errText(res)).toMatch(/WORKER_NOT_FOUND/)
  })

  it('rejects a missing id', async () => {
    const { WIRED_TOOLS } = await loadHandlers()
    const deleteWorker = WIRED_TOOLS.find((t) => t.op === 'delete_worker')!.handler!
    expect(errText(await deleteWorker({}, { ...baseCtx, folder }))).toMatch(/BAD_ARGS/)
  })

  it('SCHEDULER_NOT_READY before the scheduler has booted', async () => {
    vi.resetModules()
    const { WIRED_TOOLS } = await import('../src/main/mcp/tool-handlers')
    const deleteWorker = WIRED_TOOLS.find((t) => t.op === 'delete_worker')!.handler!
    const res = await deleteWorker({ id: 'anything' }, { ...baseCtx, folder })
    expect(errText(res)).toMatch(/SCHEDULER_NOT_READY/)
  })
})

describe('create_worker accepts timeoutSeconds (T316 AC-5)', () => {
  let folder: string

  beforeEach(async () => {
    h.userDataDir = await tmpDir('harnu-worker-ud-')
    h.appPath = await tmpDir('harnu-worker-app-')
    await seedPluginManifest(h.appPath)
    folder = await tmpDir('harnu-worker-repo-')
  })

  afterEach(() => {
    stopTicker?.()
    stopTicker = null
  })

  it('honors an explicit timeoutSeconds, overriding the 300s default', async () => {
    const { WIRED_TOOLS } = await loadHandlers()
    const createWorker = WIRED_TOOLS.find((t) => t.op === 'create_worker')!.handler!
    const res = await createWorker(
      { folder, name: 'w', prompt: 'p', everyMinutes: 10, timeoutSeconds: 900 },
      { ...baseCtx, folder }
    )
    payloadOf(res)

    const stored = JSON.parse(
      await fs.readFile(path.join(h.userDataDir, 'schedulers.json'), 'utf8')
    ) as { workers: Array<{ timeoutSeconds: number }> }
    expect(stored.workers[0].timeoutSeconds).toBe(900)
  })

  it('defaults to 300 when omitted', async () => {
    const { WIRED_TOOLS } = await loadHandlers()
    const createWorker = WIRED_TOOLS.find((t) => t.op === 'create_worker')!.handler!
    await createWorker({ folder, name: 'w', prompt: 'p', everyMinutes: 10 }, { ...baseCtx, folder })
    const stored = JSON.parse(
      await fs.readFile(path.join(h.userDataDir, 'schedulers.json'), 'utf8')
    ) as { workers: Array<{ timeoutSeconds: number }> }
    expect(stored.workers[0].timeoutSeconds).toBe(300)
  })

  it('rejects a fractional or non-positive timeoutSeconds', async () => {
    const { WIRED_TOOLS } = await loadHandlers()
    const createWorker = WIRED_TOOLS.find((t) => t.op === 'create_worker')!.handler!
    for (const timeoutSeconds of [0, -5, 1.5]) {
      const res = await createWorker(
        { folder, name: 'w', prompt: 'p', everyMinutes: 10, timeoutSeconds },
        { ...baseCtx, folder }
      )
      expect(errText(res)).toMatch(/BAD_ARGS/)
    }
  })
})
