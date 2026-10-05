/**
 * BUG-121 — `create_worker` must not be able to silently destroy the operator's
 * persisted Scheduler workers.
 *
 * The hazard was three individually reasonable facts chained together:
 *
 *  1. `scheduler-shell.ts`'s module-level `ready` was initialised to an
 *     ALREADY-RESOLVED promise, so `await ready` waited for nothing until
 *     `registerScheduler` assigned the real one;
 *  2. `createWorkerForAgent` awaited it and then did
 *     `workersCache = [...workersCache, worker]` — on an empty cache;
 *  3. `persistWorkers()` → `saveWorkers()` is a WHOLE-FILE overwrite.
 *
 * An `await` that does not wait → an empty cache → a total rewrite. Every
 * worker the operator owned, gone, with no error and nothing to restore from.
 * It was unreachable in production only because `index.ts` happens to call
 * `registerScheduler` fifteen lines before `registerMcpServer`, and nothing at
 * either site said that ordering was load-bearing.
 *
 * These are e2e-shaped tests against a real filesystem: `scheduler-shell.ts` and
 * `scheduler-store.ts` are env-bound shells (ADR-0001), and the defect lives in
 * exactly the env-bound half — the boot load and the file write. Electron's
 * `app` is mocked so every test owns the userData dir it writes into.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { resolve } from 'node:path'
import type { Worker } from '../src/main/scheduler-core'

const REPO_ROOT = resolve(__dirname, '..')

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

function workerFixture(id: string, name: string): Worker {
  return {
    id,
    name,
    enabled: true,
    prompt: `prompt for ${name}`,
    folder: '/tmp/some-repo',
    everyMinutes: 30,
    runOnBoot: false,
    model: 'haiku',
    effort: 'low',
    mode: 'observe',
    timeoutSeconds: 300,
    carryLastResult: false,
    notifyOn: 'silent',
    failureStreak: 0
  }
}

function workersPath(): string {
  return path.join(h.userDataDir, 'schedulers.json')
}

/** Write `schedulers.json` the way a previous run of the app left it. */
async function seedOnDisk(workers: Worker[]): Promise<void> {
  await fs.mkdir(h.userDataDir, { recursive: true })
  await fs.writeFile(workersPath(), JSON.stringify({ version: 1, workers }, null, 2), 'utf8')
}

async function readOnDisk(): Promise<Array<{ id: string; name: string }>> {
  const raw = await fs.readFile(workersPath(), 'utf8')
  return (JSON.parse(raw) as { workers: Array<{ id: string; name: string }> }).workers
}

/** Fresh module registry — `scheduler-shell.ts` keeps module-level state. */
async function freshShell(): Promise<typeof import('../src/main/scheduler-shell')> {
  vi.resetModules()
  h.ipc.clear()
  return import('../src/main/scheduler-shell')
}

/** …plus the boot `index.ts` performs: `registerScheduler` reads the store. */
async function bootedShell(): Promise<typeof import('../src/main/scheduler-shell')> {
  const shell = await freshShell()
  shell.registerScheduler(
    () => null,
    // The scheduler only reaches for the bridge to push its own self-disable
    // notices; no tick runs here, so a never-called stub is enough.
    {} as unknown as Parameters<typeof shell.registerScheduler>[1]
  )
  stopTicker = shell.stopSchedulerTicker
  return shell
}

let stopTicker: (() => void) | null = null

const CREATE_INPUT = {
  folder: '/tmp/some-repo',
  name: 'newcomer',
  prompt: 'check something',
  everyMinutes: 30,
  mode: 'observe' as const
}

describe('BUG-121 — the scheduler store refuses writes before it has loaded', () => {
  beforeEach(async () => {
    h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-bug121-'))
  })

  afterEach(() => {
    stopTicker?.()
    stopTicker = null
  })

  // ── AC-2: the reproduction ────────────────────────────────────────────────
  //
  // The point of this card. A guard nobody proved would fire is the same defect
  // one layer up, so the destruction is demonstrated here permanently rather
  // than asserted away — and it is demonstrated by driving the REAL
  // `createWorkerForAgent`, end to end, through `persistWorkers` →
  // `saveWorkers` → `atomicWriteFile`, onto a real file.
  //
  // How the pre-fix state is staged, since the sentinel cannot be switched off
  // from outside the module: the hazard is not "the flag is false", it is
  // **`workersCache` not reflecting what is on disk while `persistWorkers`
  // whole-file overwrites**. Before the fix that divergence was reached by
  // writing before the load had run. Here it is reached by booting against an
  // empty userData dir — a real load, `storeLoaded` genuinely true, cache
  // genuinely `[]` — and only THEN putting the operator's workers on disk. Same
  // divergence, same verb, same write path, no source edit and no test-only
  // seam bored through the guard.
  //
  // This test can go red for the thing it names: if `createWorkerForAgent` ever
  // stopped reaching `persistWorkers`, the seeded file would survive and the
  // final assertions would fail.
  it('AC-2 (reproduction): the real createWorkerForAgent erases every worker on disk when its cache does not reflect the file', async () => {
    // A real boot against an empty store: cache `[]`, loaded flag true.
    const shell = await bootedShell()
    expect(await shell.listWorkersForAgent()).toEqual([])

    // The operator's workers, now on disk and NOT in the cache — the exact
    // divergence the un-loaded cache used to produce.
    await seedOnDisk([workerFixture('w-1', 'nightly PR sweep'), workerFixture('w-2', 'CI watcher')])
    // FIXTURE PRECONDITION, not a check on the code under test: no production
    // code runs between the seed and this read, so it only proves the seed
    // landed. It is kept because without it this test could pass vacuously — a
    // `seedOnDisk` that silently wrote nothing would leave the closing
    // `toEqual(['newcomer'])` green while proving no destruction at all. The
    // work is done by the two assertions after the verb call.
    expect((await readOnDisk()).map((w) => w.name)).toEqual(['nightly PR sweep', 'CI watcher'])

    // The real verb. It resolves — no error is raised anywhere.
    const { worker } = await shell.createWorkerForAgent(CREATE_INPUT)
    expect(worker.name).toBe('newcomer')

    // …and both of the operator's workers are gone, replaced by the one new
    // row, in well-formed JSON that nothing downstream would flag.
    const after = await readOnDisk()
    expect(after.map((w) => w.name)).toEqual(['newcomer'])
    expect(after).toHaveLength(1)
  })

  // ── AC-1 + AC-2 (the guard closing it) ────────────────────────────────────
  it('AC-1/AC-2: the same call through createWorkerForAgent now refuses, visibly, and leaves the file untouched', async () => {
    await seedOnDisk([workerFixture('w-1', 'nightly PR sweep'), workerFixture('w-2', 'CI watcher')])
    const before = await fs.readFile(workersPath(), 'utf8')

    // No registerScheduler: the store has not loaded. This is exactly the state
    // a reordered `index.ts` would put the verb in.
    const shell = await freshShell()

    await expect(shell.createWorkerForAgent(CREATE_INPUT)).rejects.toThrow(/SCHEDULER_NOT_READY/)
    await expect(shell.createWorkerForAgent(CREATE_INPUT)).rejects.toBeInstanceOf(
      shell.SchedulerNotReadyError
    )

    // Byte-identical: not merely "still two workers", but not rewritten at all.
    expect(await fs.readFile(workersPath(), 'utf8')).toBe(before)
  })

  // The refusal has to survive crossing a module boundary, which is exactly
  // where `instanceof` stops working: a second instance of this module is a
  // different class object, so `instanceof` answers false and the MCP handler
  // would let the throw escape instead of returning a tool error. The `code`
  // string does not care. `tool-handlers.ts` discriminates on the code for this
  // reason, and this test is what would notice if it went back to `instanceof`.
  it('AC-1: the refusal is recognised by its `code`, so it survives a duplicated module instance', async () => {
    const first = await freshShell()
    const err = await first.createWorkerForAgent(CREATE_INPUT).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(first.SchedulerNotReadyError)

    const second = await freshShell() // a SECOND instance of the same module
    // The premise, in its discriminating form: the two instances really do hold
    // separate class objects. This reddens if the registry ever stops
    // duplicating the module, or if the error class moves somewhere shared —
    // either of which would leave the rest of this test proving nothing about a
    // duplication. `err instanceof second.SchedulerNotReadyError` is false as a
    // CONSEQUENCE of that and is deliberately NOT asserted: it is also false
    // when the guard is broken and `err` is the resolved `{ worker,
    // missingSkills }` object, so it cannot tell a working guard from a broken
    // one. The predicate on the next line is what flips.
    expect(second.SchedulerNotReadyError).not.toBe(first.SchedulerNotReadyError)
    expect(second.isSchedulerNotReady(err)).toBe(true)
  })

  it('AC-1: a refused create does not even mutate the in-memory cache, so a later boot is clean', async () => {
    await seedOnDisk([workerFixture('w-1', 'nightly PR sweep')])
    const shell = await freshShell()
    await expect(shell.createWorkerForAgent(CREATE_INPUT)).rejects.toThrow(/SCHEDULER_NOT_READY/)

    // Boot now, on the same module instance, and the cache reflects DISK —
    // no ghost worker survived the refusal.
    shell.registerScheduler(
      () => null,
      {} as unknown as Parameters<typeof shell.registerScheduler>[1]
    )
    stopTicker = shell.stopSchedulerTicker
    const rows = await shell.listWorkersForAgent()
    expect(rows.map((w) => w.name)).toEqual(['nightly PR sweep'])
  })

  // ── AC-3: existing workers survive a legitimate create ────────────────────
  it('AC-3: a create against a loaded store holding existing workers preserves ALL of them', async () => {
    await seedOnDisk([
      workerFixture('w-1', 'nightly PR sweep'),
      workerFixture('w-2', 'CI watcher'),
      workerFixture('w-3', 'inbox triage')
    ])
    const shell = await bootedShell()

    const { worker } = await shell.createWorkerForAgent(CREATE_INPUT)

    const after = await readOnDisk()
    expect(after.map((w) => w.name)).toEqual([
      'nightly PR sweep',
      'CI watcher',
      'inbox triage',
      'newcomer'
    ])
    expect(after.map((w) => w.id)).toContain(worker.id)
  })

  // ── AC-4: first boot must still work ──────────────────────────────────────
  //
  // The over-broad-fix trap: a guard keyed on "the cache is empty" instead of
  // "the store has not loaded" would break a genuinely fresh install.
  it('AC-4: a first-boot install with NO schedulers.json at all can still create its first worker', async () => {
    // FIXTURE PRECONDITION: `beforeEach` mkdtemp'd an empty dir, so this only
    // states the scenario's starting point — there is no schedulers.json yet.
    // Kept as the readable statement of "first-boot install"; the guard is
    // exercised by the create below and verified on disk after it.
    await expect(fs.readFile(workersPath(), 'utf8')).rejects.toThrow()
    const shell = await bootedShell()

    // `worker.enabled` is deliberately not asserted here: `createWorkerForAgent`
    // sets it unconditionally, so it holds whether the sentinel is right,
    // absent or over-broad. Born-enabled is pinned in
    // tests/mcp-create-worker-handler.test.ts ("creates an ENABLED observe
    // worker"), where it is the point.
    await shell.createWorkerForAgent(CREATE_INPUT)

    const after = await readOnDisk()
    expect(after).toHaveLength(1)
    expect(after[0].name).toBe('newcomer')
  })

  it('AC-4: an existing but EMPTY schedulers.json is treated as loaded-and-empty, not as not-loaded', async () => {
    await seedOnDisk([])
    const shell = await bootedShell()

    // That this call RESOLVES is the assertion — an over-broad guard keyed on
    // "the cache is empty" instead of "the store has not loaded" would reject
    // here and fail the test. Its return value is not inspected: it is always a
    // populated object, so a truthiness check on it would add nothing. What was
    // actually written is verified on disk on the next line.
    await shell.createWorkerForAgent(CREATE_INPUT)
    expect((await readOnDisk()).map((w) => w.name)).toEqual(['newcomer'])
  })

  // ── AC-5: deletion still shrinks the store ────────────────────────────────
  //
  // The other over-broad-fix trap, and why the guard is a load sentinel and NOT
  // a "refuse a write that shrinks the store" size check: `scheduler:delete`
  // legitimately shrinks it.
  it('AC-5: scheduler:delete still removes a worker and persists the smaller list', async () => {
    await seedOnDisk([
      workerFixture('w-1', 'nightly PR sweep'),
      workerFixture('w-2', 'CI watcher'),
      workerFixture('w-3', 'inbox triage')
    ])
    await bootedShell()

    const del = h.ipc.get('scheduler:delete')
    expect(del, 'registerScheduler must register scheduler:delete').toBeTruthy()
    const remaining = (await del!(null, 'w-2' as never)) as Worker[]

    expect(remaining.map((w) => w.name)).toEqual(['nightly PR sweep', 'inbox triage'])
    expect((await readOnDisk()).map((w) => w.name)).toEqual(['nightly PR sweep', 'inbox triage'])
  })

  it('AC-5: deleting every worker in turn is allowed, and empties the store', async () => {
    await seedOnDisk([workerFixture('w-1', 'a'), workerFixture('w-2', 'b')])
    await bootedShell()
    const del = h.ipc.get('scheduler:delete')!

    await del(null, 'w-1' as never)
    await del(null, 'w-2' as never)

    expect(await readOnDisk()).toEqual([])
  })

  it('AC-5: scheduler:save still adds and updates through the same guarded persist path', async () => {
    await seedOnDisk([workerFixture('w-1', 'nightly PR sweep')])
    await bootedShell()
    const save = h.ipc.get('scheduler:save')!

    await save(null, { id: 'w-1', name: 'renamed' } as never)
    await save(null, { name: 'brand new', folder: '/tmp/some-repo' } as never)

    expect((await readOnDisk()).map((w) => w.name)).toEqual(['renamed', 'brand new'])
  })

  // ── AC-6: the ordering dependency, pinned ─────────────────────────────────
  //
  // The guard converts the hazard from silent data loss into a visible refusal,
  // but it cannot make a reordered boot WORK — `create_worker` would simply be
  // dead until the scheduler registers. So the ordering itself is pinned here:
  // this test fails the moment `registerScheduler` stops preceding
  // `registerMcpServer` in `index.ts`, which is the change nothing used to catch.
  it('AC-6: index.ts still calls registerScheduler before registerMcpServer', async () => {
    const source = await fs.readFile(path.join(REPO_ROOT, 'src', 'main', 'index.ts'), 'utf8')
    const scheduler = source.indexOf('registerScheduler(() => mainWindow')
    const mcp = source.indexOf('registerMcpServer(() => mainWindow')

    expect(scheduler, 'registerScheduler call site not found in index.ts').toBeGreaterThan(-1)
    expect(mcp, 'registerMcpServer call site not found in index.ts').toBeGreaterThan(-1)
    expect(
      scheduler,
      'registerScheduler must run BEFORE registerMcpServer: the MCP surface exposes ' +
        'create_worker, which cannot write until the scheduler store has loaded (BUG-121)'
    ).toBeLessThan(mcp)
  })
})
