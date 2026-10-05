/**
 * T308 — the `create_worker` / `list_workers` handlers, against a real
 * filesystem (`scheduler-shell.ts` / `scheduler-store.ts` / `bundled-skills.ts`
 * are all env-bound shells, e2e-only per ADR-0001 — the security GATE decision
 * for `mode: 'act'` is pinned separately, purely, in mcp-plan-tool-call.test.ts;
 * this file pins what the verb actually DOES once dispatched).
 *
 * Electron's `app` is mocked so the test owns both the userData dir it writes
 * `schedulers.json`/runs into AND the `resources/skills` root bundled-skills.ts
 * stages from — it never touches the real machine's `~/.claude` or this repo's
 * own `resources/`.
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
    // A fresh app root every test — readBundledCatalog degrades to `[]` (its
    // own documented behaviour for an empty resources/skills/skills dir), so a
    // skill mention is missing unless THIS test seeds it under the worker's
    // own folder (project-level skills root). `stageSkillsForFolder` still
    // needs a `.claude-plugin/plugin.json` to copy for ANY resolved mention —
    // seeded in beforeEach below, mirroring bundled-skills-staging.test.ts.
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

/** Just enough of `resources/skills/` for `stageSkillsForFolder` to copy a
 *  resolved mention — no bundled skills, so the catalog itself stays empty. */
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

/**
 * Fresh module registry per test — `scheduler-shell.ts` keeps module-level state
 * — then BOOT the scheduler exactly as `index.ts` does.
 *
 * BUG-121: booting is not optional set-up any more. `create_worker` refuses to
 * write until `registerScheduler` has read `schedulers.json` into the module's
 * cache, because a write before that would whole-file overwrite the operator's
 * workers with just the new one. These tests used to skip `registerScheduler`
 * entirely and pass only because the un-loaded cache happened to be empty —
 * i.e. they exercised the very state that destroys data. They now wire the same
 * order production does. See tests/scheduler-store-load-guard.test.ts for the
 * refusal itself.
 */
async function loadHandlers(): Promise<typeof import('../src/main/mcp/tool-handlers')> {
  vi.resetModules()
  const handlers = await import('../src/main/mcp/tool-handlers')
  const shell = await import('../src/main/scheduler-shell')
  shell.registerScheduler(
    () => null,
    // The scheduler only ever uses the bridge to push its OWN self-disable
    // notices; no tick runs in these tests, so a never-called stub is enough.
    {} as unknown as Parameters<typeof shell.registerScheduler>[1]
  )
  stopTicker = shell.stopSchedulerTicker
  return handlers
}

/** Set by {@link loadHandlers}; cleared after each test so no 30s interval leaks. */
let stopTicker: (() => void) | null = null

const baseCtx = { folders: [], denyFolders: [], bridge: undefined }

describe('create_worker / list_workers handlers (T308)', () => {
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

  it('AC-1: creates an ENABLED observe worker and returns its id', async () => {
    const { WIRED_TOOLS } = await loadHandlers()
    const createWorker = WIRED_TOOLS.find((t) => t.op === 'create_worker')!.handler!

    const res = await createWorker(
      {
        folder,
        name: 'PR watcher',
        prompt: 'Check gh pr list.',
        everyMinutes: 30,
        mode: 'observe'
      },
      { ...baseCtx, folder }
    )
    const payload = payloadOf(res)
    expect(payload.ok).toBe(true)
    expect(typeof payload.id).toBe('string')
    expect(payload.name).toBe('PR watcher')
    expect(payload.folder).toBe(folder)
    expect(payload.mode).toBe('observe')
    expect(payload.enabled).toBe(true)
    expect(payload.warning).toBeUndefined()

    // AC-1 (persistence half): it is really written to schedulers.json, the
    // exact file the Scheduler UI's `scheduler:list` IPC handler reads.
    const stored = JSON.parse(
      await fs.readFile(path.join(h.userDataDir, 'schedulers.json'), 'utf8')
    ) as { workers: Array<{ id: string; enabled: boolean; everyMinutes: number }> }
    const found = stored.workers.find((w) => w.id === payload.id)
    expect(found?.enabled).toBe(true)
    expect(found?.everyMinutes).toBe(30)
  })

  // T313 (merging `main` into this branch): `create_worker` builds its Worker by
  // spreading `newWorker()`, so it silently inherits whatever the CURRENT Worker
  // shape is. Two fields were deleted from that shape on `main` while this branch
  // was in flight — `keepTranscript` (BUG-115) and `provider` (BUG-114) — and one
  // was added (`notifyOn`, T304). A merge resolution that kept "both sides" would
  // resurrect the two removed controls, and nothing else in the suite would
  // notice: the verb never names them, so only the shape it actually persists
  // can catch it.
  it('AC-5: the persisted worker matches the current Worker shape and round-trips through the store', async () => {
    const { WIRED_TOOLS } = await loadHandlers()
    const createWorker = WIRED_TOOLS.find((t) => t.op === 'create_worker')!.handler!
    const res = await createWorker(
      { folder, name: 'shape', prompt: 'p', everyMinutes: 20, mode: 'observe' },
      { ...baseCtx, folder }
    )
    const id = payloadOf(res).id as string

    const raw = await fs.readFile(path.join(h.userDataDir, 'schedulers.json'), 'utf8')
    const stored = (JSON.parse(raw) as { workers: Array<Record<string, unknown>> }).workers.find(
      (w) => w.id === id
    )!

    // The field T304 added: present, at its documented default.
    expect(stored.notifyOn).toBe('silent')
    // The two fields BUG-114/BUG-115 deleted: absent as KEYS, not merely undefined.
    expect(Object.keys(stored)).not.toContain('keepTranscript')
    expect(Object.keys(stored)).not.toContain('provider')

    // And the row survives the store's own normalize-on-load unchanged, so the
    // worker the Scheduler reads back is the worker the verb wrote.
    const { parseWorkers, serializeWorkers } = await import('../src/main/scheduler-store')
    const reloaded = parseWorkers(raw).find((w) => w.id === id)!
    expect(reloaded).toEqual(stored)
    expect(parseWorkers(serializeWorkers([reloaded]))[0]).toEqual(reloaded)
  })

  it('defaults mode to observe when omitted', async () => {
    const { WIRED_TOOLS } = await loadHandlers()
    const createWorker = WIRED_TOOLS.find((t) => t.op === 'create_worker')!.handler!
    const res = await createWorker(
      { folder, name: 'w', prompt: 'p', everyMinutes: 10 },
      { ...baseCtx, folder }
    )
    expect(payloadOf(res).mode).toBe('observe')
  })

  it('creates an act worker too (the confirm gate is enforced upstream, not by this handler)', async () => {
    const { WIRED_TOOLS } = await loadHandlers()
    const createWorker = WIRED_TOOLS.find((t) => t.op === 'create_worker')!.handler!
    const res = await createWorker(
      { folder, name: 'auto-fixer', prompt: 'fix and push', everyMinutes: 15, mode: 'act' },
      { ...baseCtx, folder }
    )
    const payload = payloadOf(res)
    expect(payload.ok).toBe(true)
    expect(payload.mode).toBe('act')
  })

  it('rejects a missing name/prompt or a non-positive everyMinutes', async () => {
    const { WIRED_TOOLS } = await loadHandlers()
    const createWorker = WIRED_TOOLS.find((t) => t.op === 'create_worker')!.handler!
    const errText = (res: Awaited<ReturnType<typeof createWorker>>): string => {
      expect(res.isError).toBe(true)
      const first = res.content[0]
      if (!first || first.type !== 'text') throw new Error('expected text content')
      return first.text
    }
    expect(
      errText(await createWorker({ folder, prompt: 'p', everyMinutes: 5 }, { ...baseCtx, folder }))
    ).toMatch(/BAD_ARGS/)
    expect(
      errText(await createWorker({ folder, name: 'w', everyMinutes: 5 }, { ...baseCtx, folder }))
    ).toMatch(/BAD_ARGS/)
    expect(
      errText(
        await createWorker(
          { folder, name: 'w', prompt: 'p', everyMinutes: 0 },
          { ...baseCtx, folder }
        )
      )
    ).toMatch(/BAD_ARGS/)
  })

  // BUG-121 AC-7. The handler re-derives `everyMinutes` from the RAW args as
  // its own second line of defence, but used to accept any positive NUMBER
  // while `CreateWorkerSchema` upstream enforces `z.number().int().positive()`.
  // A second line of defence weaker than the first is not defence in depth.
  // Unreachable through the live gate (validation runs before dispatch), so
  // this test calls the handler directly — the only way to reach the raw check.
  it('BUG-121 AC-7: rejects a fractional everyMinutes, exactly as CreateWorkerSchema does', async () => {
    const { WIRED_TOOLS } = await loadHandlers()
    const createWorker = WIRED_TOOLS.find((t) => t.op === 'create_worker')!.handler!
    for (const everyMinutes of [0.5, 1.5, -0.5, 30.000001]) {
      const res = await createWorker(
        { folder, name: 'w', prompt: 'p', everyMinutes },
        { ...baseCtx, folder }
      )
      expect(res.isError, `everyMinutes=${everyMinutes} must be rejected`).toBe(true)
      const first = res.content[0]
      if (!first || first.type !== 'text') throw new Error('expected text content')
      expect(first.text).toMatch(/BAD_ARGS/)
    }
    // …and an integer still gets through, so the tightening did not overreach.
    const ok = await createWorker(
      { folder, name: 'w', prompt: 'p', everyMinutes: 1 },
      { ...baseCtx, folder }
    )
    expect(payloadOf(ok).ok).toBe(true)
  })

  // BUG-121 AC-1, at the surface the agent actually sees: the shell's throw must
  // arrive as an ordinary tool error, not escape the handler.
  it('BUG-121 AC-1: create_worker before the scheduler has booted returns a visible SCHEDULER_NOT_READY error and writes nothing', async () => {
    vi.resetModules()
    // Deliberately NO registerScheduler — this is `registerMcpServer` running
    // first, the reordering that used to erase schedulers.json.
    const { WIRED_TOOLS } = await import('../src/main/mcp/tool-handlers')
    const createWorker = WIRED_TOOLS.find((t) => t.op === 'create_worker')!.handler!

    const res = await createWorker(
      { folder, name: 'early', prompt: 'p', everyMinutes: 30 },
      { ...baseCtx, folder }
    )
    expect(res.isError).toBe(true)
    const first = res.content[0]
    if (!first || first.type !== 'text') throw new Error('expected text content')
    expect(first.text).toMatch(/SCHEDULER_NOT_READY/)

    await expect(fs.readFile(path.join(h.userDataDir, 'schedulers.json'), 'utf8')).rejects.toThrow()
  })

  // BUG-121, review follow-up. The catch below discriminates on the error's
  // `code` (`isSchedulerNotReady`) instead of `instanceof
  // SchedulerNotReadyError`, and the stated reason — a duplicated module
  // instance gives a different class object, so `instanceof` silently answers
  // false and a handled refusal becomes an unhandled throw — has to be pinned
  // at THIS boundary, not only inside scheduler-shell's own suite. So the
  // refusal here is raised by a SECOND, separately-resolved instance of
  // `scheduler-shell` while the handler keeps the real predicate. Reverting the
  // catch to `instanceof` makes this case red (the throw escapes the handler)
  // and leaves every other test in the repo green.
  it('BUG-121: the handler recognises a refusal raised by a DIFFERENT module instance', async () => {
    vi.resetModules()
    // Instance B — the error's origin. Nothing else uses it.
    const foreign = await import('../src/main/scheduler-shell')
    const foreignError = new foreign.SchedulerNotReadyError()

    // Instance A — what the handler resolves. Only the write path is replaced;
    // `isSchedulerNotReady` stays the REAL one, so the predicate is exercised
    // rather than stubbed.
    vi.resetModules()
    vi.doMock('../src/main/scheduler-shell', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../src/main/scheduler-shell')>()
      return {
        ...actual,
        createWorkerForAgent: async (): Promise<never> => {
          throw foreignError
        }
      }
    })
    try {
      // The duplication has to be real, or this case would pass vacuously.
      const seenByHandler = await import('../src/main/scheduler-shell')
      expect(seenByHandler.SchedulerNotReadyError).not.toBe(foreign.SchedulerNotReadyError)
      expect(foreignError instanceof seenByHandler.SchedulerNotReadyError).toBe(false)
      expect(seenByHandler.isSchedulerNotReady(foreignError)).toBe(true)

      const { WIRED_TOOLS } = await import('../src/main/mcp/tool-handlers')
      const createWorker = WIRED_TOOLS.find((t) => t.op === 'create_worker')!.handler!
      const res = await createWorker(
        { folder, name: 'cross-instance', prompt: 'p', everyMinutes: 30 },
        { ...baseCtx, folder }
      )
      expect(res.isError).toBe(true)
      const first = res.content[0]
      if (!first || first.type !== 'text') throw new Error('expected text content')
      expect(first.text).toMatch(/SCHEDULER_NOT_READY/)
    } finally {
      vi.doUnmock('../src/main/scheduler-shell')
      vi.resetModules()
    }
  })

  it('AC-6: warns in the ACK when the prompt names a skill mention that resolves to nothing on this machine, but still creates the worker', async () => {
    const { WIRED_TOOLS } = await loadHandlers()
    const createWorker = WIRED_TOOLS.find((t) => t.op === 'create_worker')!.handler!
    const res = await createWorker(
      {
        folder,
        name: 'skill-user',
        prompt: 'Use /definitely-not-a-real-skill to do the thing.',
        everyMinutes: 20
      },
      { ...baseCtx, folder }
    )
    const payload = payloadOf(res)
    expect(payload.ok).toBe(true)
    expect(typeof payload.warning).toBe('string')
    expect(payload.warning as string).toMatch(/definitely-not-a-real-skill/)
  })

  it('no warning when the mentioned skill DOES resolve (a project-level skill under the folder)', async () => {
    const skillDir = path.join(folder, '.claude', 'skills', 'mock-skill')
    await fs.mkdir(skillDir, { recursive: true })
    await fs.writeFile(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: mock-skill\ndescription: a fixture skill\n---\n\nbody\n',
      'utf8'
    )

    const { WIRED_TOOLS } = await loadHandlers()
    const createWorker = WIRED_TOOLS.find((t) => t.op === 'create_worker')!.handler!
    const res = await createWorker(
      { folder, name: 'skill-user', prompt: 'Use /mock-skill for this.', everyMinutes: 20 },
      { ...baseCtx, folder }
    )
    const payload = payloadOf(res)
    expect(payload.ok).toBe(true)
    expect(payload.warning).toBeUndefined()
  })

  it('AC-4: list_workers returns id/name/folderAlias/mode/everyMinutes/enabled, redacted like other fleet reads', async () => {
    const { WIRED_TOOLS } = await loadHandlers()
    const createWorker = WIRED_TOOLS.find((t) => t.op === 'create_worker')!.handler!
    const listWorkers = WIRED_TOOLS.find((t) => t.op === 'list_workers')!.handler!

    await createWorker(
      { folder, name: 'PR watcher', prompt: 'p', everyMinutes: 30, mode: 'observe' },
      { ...baseCtx, folder }
    )
    const res = await listWorkers({ folder }, { ...baseCtx, folder })
    const payload = payloadOf(res)
    const workers = payload.workers as Array<Record<string, unknown>>
    expect(workers).toHaveLength(1)
    const row = workers[0]
    expect(row.name).toBe('PR watcher')
    expect(row.folderAlias).toBe(path.basename(folder))
    expect(row).not.toHaveProperty('folder') // the raw absolute path never leaves the process
    expect(row.mode).toBe('observe')
    expect(row.everyMinutes).toBe(30)
    expect(row.enabled).toBe(true)
    expect(row.agentControllable).toBe(true)
  })

  it('list_workers scoped by folder excludes workers from another folder', async () => {
    const otherFolder = await tmpDir('harnu-worker-other-')
    const { WIRED_TOOLS } = await loadHandlers()
    const createWorker = WIRED_TOOLS.find((t) => t.op === 'create_worker')!.handler!
    const listWorkers = WIRED_TOOLS.find((t) => t.op === 'list_workers')!.handler!

    await createWorker(
      { folder, name: 'mine', prompt: 'p', everyMinutes: 30 },
      { ...baseCtx, folder }
    )
    await createWorker(
      { folder: otherFolder, name: 'not-mine', prompt: 'p', everyMinutes: 30 },
      { ...baseCtx, folder: otherFolder }
    )
    const res = await listWorkers({ folder }, { ...baseCtx, folder })
    const workers = payloadOf(res).workers as Array<Record<string, unknown>>
    expect(workers.map((w) => w.name)).toEqual(['mine'])
  })

  it('agentControllable is false when the worker folder is on the operator BLOCK list', async () => {
    const { WIRED_TOOLS } = await loadHandlers()
    const createWorker = WIRED_TOOLS.find((t) => t.op === 'create_worker')!.handler!
    const listWorkers = WIRED_TOOLS.find((t) => t.op === 'list_workers')!.handler!

    await createWorker(
      { folder, name: 'PR watcher', prompt: 'p', everyMinutes: 30 },
      { ...baseCtx, folder }
    )
    const res = await listWorkers({ folder }, { ...baseCtx, folder, denyFolders: [folder] })
    const workers = payloadOf(res).workers as Array<Record<string, unknown>>
    expect(workers[0].agentControllable).toBe(false)
  })
})
