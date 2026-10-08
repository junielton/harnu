import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runFromResult } from '../src/main/scheduler-shell'
import { RUN_RESULT_LIMIT, type Worker } from '../src/main/scheduler-core'

const OK = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'PR 292 opened',
  terminal_reason: 'completed',
  num_turns: 4,
  total_cost_usd: 0.0213,
  usage: {
    input_tokens: 10,
    output_tokens: 240,
    cache_read_input_tokens: 13699,
    cache_creation_input_tokens: 24501
  },
  permission_denials: [
    { tool_name: 'Edit' },
    { tool_name: 'Edit' },
    { tool_name: 'Bash', tool_input: { command: 'git commit -m x' } }
  ]
})

describe('runFromResult', () => {
  it('reads a successful tick', () => {
    const r = runFromResult('w1', 1000, 2000, OK, 0)
    expect(r.status).toBe('ok')
    expect(r.result).toBe('PR 292 opened')
    expect(r.numTurns).toBe(4)
    expect(r.costUsd).toBeCloseTo(0.0213)
    expect(r.durationMs).toBe(1000)
    expect(r.tokens).toEqual({ in: 10, out: 240, cacheRead: 13699, cacheWrite: 24501 })
  })

  it('rolls denials up by tool with a count', () => {
    expect(runFromResult('w1', 1, 2, OK, 0).denials).toEqual(['Edit ×2', 'Bash ×1'])
  })

  it('is an error when the process said so', () => {
    const text = JSON.stringify({ type: 'result', is_error: true, result: 'boom' })
    expect(runFromResult('w1', 1, 2, text, 0).status).toBe('error')
  })

  it('is an error when the output is not JSON at all', () => {
    const r = runFromResult('w1', 1, 2, 'command not found: claude', 127)
    expect(r.status).toBe('error')
    expect(r.result).toContain('command not found')
  })

  it('is an error on a non-zero exit even with parseable output', () => {
    expect(runFromResult('w1', 1, 2, OK, 1).status).toBe('error')
  })

  // T303: the error path always capped what it stored (`stdout.slice(0, 4000)`)
  // and the success path did not — `result` comes straight off the model, and a
  // chatty worker writes an unbounded string into an append-only file, 200
  // records deep, every cadence. Both paths, one limit.
  it('caps a chatty success at the same limit the error path uses', () => {
    const long = JSON.stringify({ type: 'result', is_error: false, result: 'x'.repeat(9000) })
    expect(runFromResult('w1', 1, 2, long, 0).result).toHaveLength(RUN_RESULT_LIMIT)
  })

  it('caps unparseable output at that same limit', () => {
    expect(runFromResult('w1', 1, 2, 'y'.repeat(9000), 1).result).toHaveLength(RUN_RESULT_LIMIT)
  })

  it('records zeros rather than NaN when usage is absent', () => {
    const r = runFromResult('w1', 1, 2, JSON.stringify({ type: 'result', result: 'x' }), 0)
    expect(r.tokens).toEqual({ in: 0, out: 0, cacheRead: 0, cacheWrite: 0 })
    expect(r.costUsd).toBe(0)
  })
})

/**
 * AC-6 / AC-7 — the runner's live-process behaviors: kill-at-timeout,
 * stop()-kill, and the vanished-folder disable-and-never-spawn rule. These
 * are env-bound (electron IPC, `node:child_process.spawn`), so `electron`
 * and `node:child_process` are mocked; `node:fs` and `scheduler-store.ts`
 * stay REAL, pointed at a throwaway `userData` dir, so a worker's disable
 * and its recorded run genuinely round-trip through disk — the same
 * integration-over-mocking posture `usage-poller.test.ts` uses for the
 * other `claude -p` spawn path in this codebase.
 */
describe('registerScheduler — the runner (mocked spawn)', () => {
  class FakeChild extends EventEmitter {
    stdout = new EventEmitter()
    stderr = new EventEmitter()
    kill = vi.fn()
  }

  const h = vi.hoisted(() => ({
    spawn: vi.fn(),
    ipcHandlers: new Map<string, (e: unknown, ...args: never[]) => Promise<unknown>>(),
    userDataDir: '',
    hookBlob: null as string | null,
    // BUG-169: what the (mocked) skill stager reports for the tick being run.
    stageRejected: [] as Array<{ mention: string; reason: 'hooks' }>,
    stageModes: [] as string[]
  }))

  vi.mock('node:child_process', () => ({ spawn: h.spawn }))
  // BUG-111 — the runner asks the Hook Bridge for Harnu's inline hook settings.
  // Mocked at the module seam (like `claude-cli` below) rather than by widening
  // the `node:child_process` mock: importing the real bridge drags in
  // `git-probe.ts`, which needs an `execFile` this suite deliberately does not
  // provide.
  vi.mock('../src/main/hook-bridge', () => ({
    hookSettingsBlobJson: () => h.hookBlob
  }))
  vi.mock('electron', () => ({
    ipcMain: {
      handle: (ch: string, cb: (e: unknown, ...args: never[]) => Promise<unknown>) =>
        h.ipcHandlers.set(ch, cb)
    },
    app: { getPath: () => h.userDataDir },
    BrowserWindow: class {}
  }))
  vi.mock('../src/main/claude-cli', () => ({
    resolveClaudePath: vi.fn(async () => '/usr/bin/claude')
  }))
  vi.mock('../src/main/bundled-skills', () => ({
    stageSkillsForFolder: vi.fn(async () => null),
    stageSkillsForTick: vi.fn(async (_folder: string, _mentions: string[], mode: string) => {
      h.stageModes.push(mode)
      return { staged: null, rejected: h.stageRejected }
    })
  }))

  const bridge = { dispatch: vi.fn(async () => undefined) }

  function baseDraft(folder: string, over: Partial<Worker> = {}): Partial<Worker> {
    return {
      name: 'Test worker',
      enabled: true,
      prompt: 'do the thing',
      folder,
      everyMinutes: 5,
      runOnBoot: false,
      model: 'haiku',
      effort: 'low',
      mode: 'observe',
      timeoutSeconds: 300,
      carryLastResult: false,
      failureStreak: 0,
      ...over
    }
  }

  beforeEach(async () => {
    vi.resetModules()
    h.ipcHandlers.clear()
    h.spawn.mockReset()
    h.hookBlob = null
    h.stageRejected = []
    h.stageModes = []
    bridge.dispatch.mockClear()
    h.userDataDir = mkdtempSync(join(tmpdir(), 'harnu-scheduler-test-'))
    const mod = await import('../src/main/scheduler-shell')
    mod.registerScheduler(() => null, bridge as never)
  })

  afterEach(() => {
    rmSync(h.userDataDir, { recursive: true, force: true })
  })

  async function save(draft: Partial<Worker>): Promise<Worker[]> {
    const handler = h.ipcHandlers.get('scheduler:save')
    if (!handler) throw new Error('scheduler:save not registered')
    return handler(null, draft) as Promise<Worker[]>
  }

  async function runNow(id: string): Promise<void> {
    const handler = h.ipcHandlers.get('scheduler:runNow')
    if (!handler) throw new Error('scheduler:runNow not registered')
    await handler(null, id)
  }

  async function runsFor(id: string): Promise<Array<{ status: string }>> {
    const handler = h.ipcHandlers.get('scheduler:runs')
    if (!handler) throw new Error('scheduler:runs not registered')
    return handler(null, id) as Promise<Array<{ status: string }>>
  }

  it('never spawns into a vanished folder — disables and notifies naming it', async () => {
    const ghostFolder = join(h.userDataDir, 'ghost-folder-that-does-not-exist')
    const [worker] = await save(baseDraft(ghostFolder))
    await runNow(worker.id)

    await vi.waitFor(() => {
      if (bridge.dispatch.mock.calls.length === 0) throw new Error('notify not sent yet')
    })

    expect(h.spawn).not.toHaveBeenCalled()
    const [command, payload] = bridge.dispatch.mock.calls[0] as [string, Record<string, unknown>]
    expect(command).toBe('notify.push')
    expect(payload.folderPath).toBe(ghostFolder)
    expect(String(payload.description)).toContain(ghostFolder)

    const handler = h.ipcHandlers.get('scheduler:list')
    const list = (await handler?.(null)) as Worker[]
    expect(list.find((w) => w.id === worker.id)?.enabled).toBe(false)
  })

  it('kills a tick at its timeout and records `timeout`', async () => {
    const child = new FakeChild()
    h.spawn.mockReturnValue(child)
    const [worker] = await save(baseDraft(h.userDataDir, { timeoutSeconds: 0 }))
    await runNow(worker.id)

    await vi.waitFor(() => {
      if (child.kill.mock.calls.length === 0) throw new Error('not killed yet')
    })
    expect(child.kill.mock.calls[0][0]).toBe('SIGTERM')

    child.emit('exit', null)
    await vi.waitFor(async () => {
      const runs = await runsFor(worker.id)
      if (runs.length === 0) throw new Error('run not recorded yet')
    })
    const runs = await runsFor(worker.id)
    expect(runs[0].status).toBe('timeout')
  })

  it('stop() kills a live tick and records `stopped`', async () => {
    const child = new FakeChild()
    h.spawn.mockReturnValue(child)
    const [worker] = await save(baseDraft(h.userDataDir))
    await runNow(worker.id)

    await vi.waitFor(() => {
      if (h.spawn.mock.calls.length === 0) throw new Error('not spawned yet')
    })

    const stopHandler = h.ipcHandlers.get('scheduler:stop')
    await stopHandler?.(null, worker.id)
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')

    child.emit('exit', null)
    await vi.waitFor(async () => {
      const runs = await runsFor(worker.id)
      if (runs.length === 0) throw new Error('run not recorded yet')
    })
    const runs = await runsFor(worker.id)
    expect(runs[0].status).toBe('stopped')
  })

  // AC-1 (BUG-111) — a tick used to spawn with no Harnu hooks at all, in either
  // mode: `--setting-sources ''` drops the global install, and nothing put them
  // back. The blob has to reach the actual argv, not just `tickArgv`'s tests.
  it('spawns an act tick with the hook settings the bridge handed it', async () => {
    h.hookBlob = '{"hooks":{"Stop":[]}}'
    h.spawn.mockReturnValue(new FakeChild())
    const [worker] = await save(baseDraft(h.userDataDir, { mode: 'act' }))
    await runNow(worker.id)

    await vi.waitFor(() => {
      if (h.spawn.mock.calls.length === 0) throw new Error('not spawned yet')
    })
    const argv = h.spawn.mock.calls[0][1] as string[]
    expect(argv).toContain('--settings')
    expect(argv[argv.indexOf('--settings') + 1]).toBe('{"hooks":{"Stop":[]}}')
  })

  it('spawns without --settings when the bridge is down', async () => {
    h.hookBlob = null
    h.spawn.mockReturnValue(new FakeChild())
    const [worker] = await save(baseDraft(h.userDataDir, { mode: 'act' }))
    await runNow(worker.id)

    await vi.waitFor(() => {
      if (h.spawn.mock.calls.length === 0) throw new Error('not spawned yet')
    })
    expect(h.spawn.mock.calls[0][1] as string[]).not.toContain('--settings')
  })

  // BUG-169 — a mention the stager refused (the skill declares hooks) is recorded where the operator
  // already looks for what a tick could not do, and the tick still runs.
  it('records a rejected skill mention in the run denials, observe mode only', async () => {
    h.stageRejected = [{ mention: 'hooky', reason: 'hooks' }]
    const child = new FakeChild()
    h.spawn.mockReturnValue(child)
    const [worker] = await save(baseDraft(h.userDataDir, { mode: 'observe', prompt: 'run /hooky' }))
    await runNow(worker.id)
    await vi.waitFor(() => {
      if (h.spawn.mock.calls.length === 0) throw new Error('not spawned yet')
    })
    child.stdout.emit('data', JSON.stringify({ type: 'result', result: 'ok' }))
    child.emit('exit', 0)
    await vi.waitFor(async () => {
      if ((await runsFor(worker.id)).length === 0) throw new Error('run not recorded yet')
    })
    const runs = (await runsFor(worker.id)) as Array<{ status: string; denials: string[] }>
    expect(runs[0].status).toBe('ok')
    expect(runs[0].denials).toContain('rejected skill: /hooky (declares hooks)')
    expect(h.stageModes).toEqual(['observe'])
  })

  it('stages an act worker in act mode and records no rejection', async () => {
    const child = new FakeChild()
    h.spawn.mockReturnValue(child)
    const [worker] = await save(baseDraft(h.userDataDir, { mode: 'act' }))
    await runNow(worker.id)
    await vi.waitFor(() => {
      if (h.spawn.mock.calls.length === 0) throw new Error('not spawned yet')
    })
    child.stdout.emit('data', JSON.stringify({ type: 'result', result: 'ok' }))
    child.emit('exit', 0)
    await vi.waitFor(async () => {
      if ((await runsFor(worker.id)).length === 0) throw new Error('run not recorded yet')
    })
    const runs = (await runsFor(worker.id)) as Array<{ denials: string[] }>
    expect(h.stageModes).toEqual(['act'])
    expect(runs[0].denials.join(' ')).not.toContain('rejected skill')
  })

  // BUG-108 / BUG-164 — an extra read command is never honored (observe has no
  // shell), and the refusal is recorded where the operator already looks for what a
  // tick could not do, instead of vanishing.
  it('records every extra read command as rejected in the run denials', async () => {
    const child = new FakeChild()
    h.spawn.mockReturnValue(child)
    const [worker] = await save(
      baseDraft(h.userDataDir, {
        mode: 'observe',
        extraReadCommands: ['Bash(git status)', 'Bash(rm -rf /)']
      })
    )
    await runNow(worker.id)
    await vi.waitFor(() => {
      if (h.spawn.mock.calls.length === 0) throw new Error('not spawned yet')
    })
    child.stdout.emit('data', JSON.stringify({ type: 'result', result: 'ok' }))
    child.emit('exit', 0)

    await vi.waitFor(async () => {
      const runs = await runsFor(worker.id)
      if (runs.length === 0) throw new Error('run not recorded yet')
    })
    const runs = await runsFor(worker.id)
    expect(runs[0].denials).toContain('rejected rule: Bash(rm -rf /)')
    expect(runs[0].denials).toContain('rejected rule: Bash(git status)')
  })

  /**
   * T306 — the per-run notification WIRING, not the decision.
   *
   * `resolveNotifyOn` / `shouldNotifyRun` / `runNotificationText` are covered
   * exhaustively as pure functions in `scheduler-core.test.ts`, and every one
   * of those cases passed while `completeTick` — the single place that calls
   * them — had no coverage at all. A pure function that returns `true` and a
   * notification the operator actually receives are two different claims; this
   * block asserts the second one, through the same mocked `spawn` +
   * `bridge.dispatch` harness the vanished-folder rule already uses.
   */
  describe('per-run notifications (T304 wiring)', () => {
    /** Drive one tick to completion and hand back what it dispatched. */
    async function tickTo(
      draft: Partial<Worker>,
      finish: (child: FakeChild) => void
    ): Promise<{ workerId: string }> {
      const child = new FakeChild()
      const spawnsBefore = h.spawn.mock.calls.length
      h.spawn.mockReturnValue(child)
      const [worker] = await save(draft)
      await runNow(worker.id)
      // Wait for THIS tick's spawn, not for any spawn: emitting on a child the
      // runner has not yet wired its listeners to drops the events silently.
      await vi.waitFor(() => {
        if (h.spawn.mock.calls.length === spawnsBefore) throw new Error('not spawned yet')
      })
      finish(child)
      await vi.waitFor(async () => {
        const runs = await runsFor(worker.id)
        if (runs.length === 0) throw new Error('run not recorded yet')
      })
      return { workerId: worker.id }
    }

    /** A tick that failed: the CLI printed nothing parseable and exited non-zero. */
    const failWith =
      (text: string, code: number) =>
      (child: FakeChild): void => {
        child.stdout.emit('data', Buffer.from(text))
        child.emit('exit', code)
      }

    /** A tick that succeeded, with something to say. */
    const succeed =
      (result: string) =>
      (child: FakeChild): void => {
        child.stdout.emit(
          'data',
          Buffer.from(JSON.stringify({ type: 'result', is_error: false, result }))
        )
        child.emit('exit', 0)
      }

    function notifyCalls(): Array<Record<string, unknown>> {
      return bridge.dispatch.mock.calls
        .filter((c) => (c as unknown as [string])[0] === 'notify.push')
        .map((c) => (c as unknown as [string, Record<string, unknown>])[1])
    }

    it('an `error` tick under `failure` actually reaches notify.push', async () => {
      await tickTo(
        baseDraft(h.userDataDir, { notifyOn: 'failure' }),
        failWith('command not found: claude', 127)
      )
      await vi.waitFor(() => {
        if (notifyCalls().length === 0) throw new Error('notify not dispatched yet')
      })
      const [payload] = notifyCalls()
      expect(payload.folderPath).toBe(h.userDataDir)
      expect(String(payload.title)).toContain('Test worker')
      expect(String(payload.description)).toContain('error')
      expect(String(payload.description)).toContain('command not found')
    })

    it('a `timeout` tick under `failure` reaches notify.push too', async () => {
      const child = new FakeChild()
      h.spawn.mockReturnValue(child)
      const [worker] = await save(
        baseDraft(h.userDataDir, { notifyOn: 'failure', timeoutSeconds: 0 })
      )
      await runNow(worker.id)

      await vi.waitFor(() => {
        if (child.kill.mock.calls.length === 0) throw new Error('not killed yet')
      })
      child.emit('exit', null)

      await vi.waitFor(() => {
        if (notifyCalls().length === 0) throw new Error('notify not dispatched yet')
      })
      expect((await runsFor(worker.id))[0].status).toBe('timeout')
      expect(String(notifyCalls()[0].description)).toContain('timeout')
    })

    it('an `ok` tick stays silent under `failure`', async () => {
      await tickTo(baseDraft(h.userDataDir, { notifyOn: 'failure' }), succeed('nothing new'))
      expect(notifyCalls()).toEqual([])
    })

    it('an `ok` tick under `every` reaches notify.push, carrying what the worker said', async () => {
      await tickTo(baseDraft(h.userDataDir, { notifyOn: 'every' }), succeed('PR 292 opened'))
      await vi.waitFor(() => {
        if (notifyCalls().length === 0) throw new Error('notify not dispatched yet')
      })
      expect(String(notifyCalls()[0].description)).toBe('PR 292 opened')
    })

    it('an `ok` tick under `silent` dispatches nothing at all', async () => {
      await tickTo(baseDraft(h.userDataDir, { notifyOn: 'silent' }), succeed('PR 292 opened'))
      expect(notifyCalls()).toEqual([])
    })

    it('a failed tick under `silent` dispatches nothing either', async () => {
      await tickTo(baseDraft(h.userDataDir, { notifyOn: 'silent' }), failWith('boom', 1))
      expect(notifyCalls()).toEqual([])
    })

    // The severity is the difference between a notification you can ignore and
    // one you cannot, and it is chosen at the call site — not by `shouldNotifyRun`.
    it('a successful run is dispatched as `info`', async () => {
      await tickTo(baseDraft(h.userDataDir, { notifyOn: 'every' }), succeed('all good'))
      await vi.waitFor(() => {
        if (notifyCalls().length === 0) throw new Error('notify not dispatched yet')
      })
      expect(notifyCalls()[0].kind).toBe('info')
    })

    it('a failed run is dispatched as `warning`', async () => {
      await tickTo(baseDraft(h.userDataDir, { notifyOn: 'every' }), failWith('boom', 1))
      await vi.waitFor(() => {
        if (notifyCalls().length === 0) throw new Error('notify not dispatched yet')
      })
      expect(notifyCalls()[0].kind).toBe('warning')
    })

    /**
     * The `!disable &&` guard in `completeTick`. A tick that pushes the worker
     * over the failure limit already fires the auto-disable notice, and that
     * notice reports this very run with more consequence attached — a second
     * line about the same tick is exactly the double-notification the setting
     * exists to prevent.
     */
    it('a tick that auto-disables fires the disable notice and NOT the per-run one', async () => {
      await tickTo(
        baseDraft(h.userDataDir, { notifyOn: 'failure', failureStreak: 2 }),
        failWith('boom', 1)
      )
      await vi.waitFor(() => {
        if (notifyCalls().length === 0) throw new Error('notify not dispatched yet')
      })
      const calls = notifyCalls()
      expect(calls).toHaveLength(1)
      expect(String(calls[0].description)).toBe('Disabled after 3 consecutive failures.')

      const listHandler = h.ipcHandlers.get('scheduler:list')
      const list = (await listHandler?.(null)) as Worker[]
      expect(list[0].enabled).toBe(false)
    })

    // The same tick one failure earlier: no disable, so the per-run line is the
    // only thing that fires — which is what proves the guard above is a guard
    // and not simply "this worker never notifies".
    it('one failure short of the limit, the per-run line is the one that fires', async () => {
      await tickTo(
        baseDraft(h.userDataDir, { notifyOn: 'failure', failureStreak: 1 }),
        failWith('boom', 1)
      )
      await vi.waitFor(() => {
        if (notifyCalls().length === 0) throw new Error('notify not dispatched yet')
      })
      const calls = notifyCalls()
      expect(calls).toHaveLength(1)
      expect(String(calls[0].description)).not.toContain('Disabled after')
      expect(String(calls[0].description)).toContain('error')
    })
  })
})
