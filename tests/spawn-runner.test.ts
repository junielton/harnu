import { afterEach, describe, expect, it } from 'vitest'
import {
  SpawnHelperExitedError,
  SpawnHelperUnavailableError,
  currentHelperGeneration,
  runFile,
  spawnChild,
  spawnRunnerActive,
  startSpawnRunner,
  stopSpawnRunner,
  type HelperFactory,
  type HelperProcess,
  type RunFileOptions
} from '../src/main/spawn-runner'
import { forkedHelperFactory } from './support/spawn-helper-fork'

/**
 * BUG-266 AC-2 / AC-4 — the one spawn runner. Everything runs against the REAL helper script as a forked
 * Node process, and the same calls run in-process, so a difference between the two is a failing test.
 */

const NODE = process.execPath
const js = (code: string): string[] => ['-e', code]

afterEach(() => stopSpawnRunner())

async function settle<T>(
  p: Promise<T>
): Promise<{ ok: true; value: T } | { ok: false; err: Record<string, unknown> }> {
  try {
    return { ok: true, value: await p }
  } catch (e) {
    return { ok: false, err: e as Record<string, unknown> }
  }
}

type Mode = 'in-process' | 'helper'
async function inMode<T>(mode: Mode, fn: () => Promise<T>): Promise<T> {
  stopSpawnRunner()
  if (mode === 'helper') startSpawnRunner(forkedHelperFactory)
  expect(spawnRunnerActive()).toBe(mode === 'helper')
  return await fn()
}

describe.each<Mode>(['in-process', 'helper'])('runFile (%s)', (mode) => {
  const run = (args: string[], o: RunFileOptions = {}) =>
    inMode(mode, () => settle(runFile(NODE, args, o)))

  it('resolves stdout and stderr unchanged', async () => {
    const r = await run(js("process.stdout.write('out\\u00e9\\n'); process.stderr.write('err\\n')"))
    expect(r).toEqual({ ok: true, value: { stdout: 'outé\n', stderr: 'err\n' } })
  })

  it('carries a 1 MiB stdout through whole', async () => {
    const r = await run(js("process.stdout.write('x'.repeat(1 << 20))"), { maxBuffer: 4 << 20 })
    expect(r.ok && r.value.stdout.length).toBe(1 << 20)
  })

  it('rejects like execFile: exit code, stdout and stderr survive', async () => {
    const r = await run(
      js("process.stdout.write('partial'); process.stderr.write('boom'); process.exit(3)")
    )
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.err.code).toBe(3)
      expect(r.err.stdout).toBe('partial')
      expect(r.err.stderr).toBe('boom')
      expect(r.err.killed).toBe(false)
      expect(String(r.err.message)).toContain('boom')
    }
  })

  it('rejects with ENOENT for a binary that does not exist', async () => {
    const r = await inMode(mode, () => settle(runFile('harnu-no-such-binary', [])))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.err.code).toBe('ENOENT')
  })

  it('a timeout kills the child and says so', async () => {
    const r = await run(js('setTimeout(()=>{}, 30000)'), { timeout: 150 })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.err.killed).toBe(true)
      expect(r.err.signal).toBe('SIGTERM')
    }
  })

  it('maxBuffer overflow rejects', async () => {
    const r = await run(js("process.stdout.write('x'.repeat(5000))"), { maxBuffer: 100 })
    expect(r.ok).toBe(false)
  })

  it('passes cwd, env and stdin', async () => {
    const r = await run(
      js(
        "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(process.cwd()+'|'+process.env.HARNU_T+'|'+s))"
      ),
      { cwd: '/tmp', env: { ...process.env, HARNU_T: 'yes' }, stdin: 'body' }
    )
    expect(r.ok && r.value.stdout).toBe('/tmp|yes|body')
  })

  it('a child that is given no env inherits the main process env', async () => {
    process.env.HARNU_SPAWN_INHERIT = 'inherited'
    try {
      const r = await run(js('process.stdout.write(process.env.HARNU_SPAWN_INHERIT ?? "")'))
      expect(r.ok && r.value.stdout).toBe('inherited')
    } finally {
      delete process.env.HARNU_SPAWN_INHERIT
    }
  })

  it('kill() stops a running child and the promise rejects as killed', async () => {
    const r = await inMode(mode, async () => {
      const p = runFile(NODE, js('setTimeout(()=>{}, 30000)'))
      setTimeout(() => p.kill(), 150)
      return await settle(p)
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.err.killed).toBe(true)
  })
})

describe.each<Mode>(['in-process', 'helper'])('spawnChild (%s)', (mode) => {
  function collect(
    child: ReturnType<typeof spawnChild>
  ): Promise<{ out: string; err: string; code: number | null; signal: unknown; error?: Error }> {
    return new Promise((resolve) => {
      let out = ''
      let err = ''
      let error: Error | undefined
      child.stdout?.on('data', (d: Buffer) => (out += d.toString('utf8')))
      child.stderr?.on('data', (d: Buffer) => (err += d.toString('utf8')))
      child.on('error', (e: Error) => (error = e))
      child.on('close', (code: number | null, signal: unknown) =>
        resolve({ out, err, code, signal, error })
      )
    })
  }

  it('streams stdout and stderr and reports the exit code on close', async () => {
    const r = await inMode(mode, () =>
      collect(spawnChild(NODE, js("console.log('a'); console.error('b'); process.exit(4)")))
    )
    expect(r).toMatchObject({ out: 'a\n', err: 'b\n', code: 4 })
  })

  it('writes to stdin and closes it', async () => {
    const r = await inMode(mode, async () => {
      const c = spawnChild(NODE, js('process.stdin.pipe(process.stdout)'))
      c.stdin?.end('hello stdin')
      return await collect(c)
    })
    expect(r.out).toBe('hello stdin')
    expect(r.code).toBe(0)
  })

  it('delivers every chunk to the data handlers before exit is emitted', async () => {
    const seen = await inMode(mode, async () => {
      const results: string[] = []
      for (let i = 0; i < 15; i++) {
        const c = spawnChild(
          NODE,
          js("process.stdout.write('tail-' + process.pid.toString().length)")
        )
        let out = ''
        c.stdout?.on('data', (d: Buffer) => (out += d.toString('utf8')))
        const atExit = new Promise<string>((resolve) => c.on('exit', () => resolve(out)))
        const closed = new Promise((r) => c.on('close', r))
        results.push(await atExit)
        await closed
      }
      return results
    })
    expect(seen.every((o) => o.startsWith('tail-'))).toBe(true)
  })

  it('reports the pid on spawn', async () => {
    const pid = await inMode(mode, async () => {
      const c = spawnChild(NODE, js('setTimeout(()=>{},50)'))
      const closed = new Promise((resolve) => c.once('close', resolve))
      const pid = await new Promise<number | undefined>((resolve) =>
        c.once('spawn', () => resolve(c.pid))
      )
      await closed
      return pid
    })
    expect(pid).toBeGreaterThan(0)
  })

  it('a binary that does not exist is an error event, then close', async () => {
    const r = await inMode(mode, () => collect(spawnChild('harnu-no-such-binary', [])))
    expect((r.error as NodeJS.ErrnoException | undefined)?.code).toBe('ENOENT')
  })

  it('kill() ends a running child with a signal', async () => {
    const r = await inMode(mode, async () => {
      const c = spawnChild(NODE, js('setTimeout(()=>{}, 30000)'))
      const done = collect(c)
      c.once('spawn', () => c.kill('SIGKILL'))
      return await done
    })
    expect(r.signal).toBe('SIGKILL')
  })

  it('stdio ignore leaves no stream to read', async () => {
    const c = await inMode(mode, async () => {
      const child = spawnChild(NODE, js('0'), { stdio: ['ignore', 'ignore', 'ignore'] })
      await new Promise((r) => child.on('close', r))
      return child
    })
    expect(c.stdout).toBeNull()
    expect(c.stdin).toBeNull()
  })
})

describe('failure behaviour (AC-4)', () => {
  /** A factory that remembers its helpers so a test can kill one the way a crash would. */
  function trackedFactory(): { factory: HelperFactory; helpers: HelperProcess[] } {
    const helpers: HelperProcess[] = []
    return {
      helpers,
      factory: () => {
        const h = forkedHelperFactory()
        helpers.push(h)
        return h
      }
    }
  }

  it('a helper that dies rejects every pending request, none hangs', async () => {
    const { factory, helpers } = trackedFactory()
    startSpawnRunner(factory)
    const pending = [1, 2, 3].map(() => settle(runFile(NODE, js('setTimeout(()=>{}, 30000)'))))
    await new Promise((r) => setTimeout(r, 400)) // all three are inside the helper by now
    const started = Date.now()
    helpers[0].kill()
    const results = await Promise.all(pending)
    expect(Date.now() - started).toBeLessThan(3000)
    for (const r of results) {
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.err).toBeInstanceOf(SpawnHelperExitedError)
        expect(r.err.code).toBe('SPAWN_HELPER_EXITED')
      }
    }
  })

  it('a helper that dies ends its streaming children with an error and a close', async () => {
    const { factory, helpers } = trackedFactory()
    startSpawnRunner(factory)
    const child = spawnChild(NODE, js('setTimeout(()=>{}, 30000)'))
    const events: string[] = []
    child.on('error', (e: Error) => events.push(`error:${(e as { code?: string }).code}`))
    child.on('close', () => events.push('close'))
    await new Promise((r) => child.once('spawn', r))
    helpers[0].kill()
    await new Promise((r) => child.once('close', r))
    expect(events).toEqual(['error:SPAWN_HELPER_EXITED', 'close'])
  })

  it('the next request restarts the helper and works', async () => {
    const { factory, helpers } = trackedFactory()
    startSpawnRunner(factory)
    const before = currentHelperGeneration()
    expect((await settle(runFile(NODE, js("process.stdout.write('one')")))).ok).toBe(true)
    helpers[0].kill()
    await new Promise((r) => setTimeout(r, 300))
    const again = await settle(runFile(NODE, js("process.stdout.write('two')")))
    expect(again).toEqual({ ok: true, value: { stdout: 'two', stderr: '' } })
    expect(helpers.length).toBe(2)
    expect(currentHelperGeneration()).toBeGreaterThan(before)
  })

  it('a helper that cannot be created rejects, naming why', async () => {
    startSpawnRunner(() => {
      throw new Error('no such script')
    })
    const r = await settle(runFile(NODE, js('0')))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.err).toBeInstanceOf(SpawnHelperUnavailableError)
  })

  it('a helper that keeps dying before it is ready stops being restarted, instead of looping', async () => {
    let starts = 0
    const dying: HelperFactory = () => {
      starts++
      let onExit: (d: string) => void = () => {}
      queueMicrotask(() => setTimeout(() => onExit('exit code 1'), 5))
      return { post: () => {}, onMessage: () => {}, onExit: (cb) => (onExit = cb), kill: () => {} }
    }
    startSpawnRunner(dying)
    const errs: unknown[] = []
    for (let i = 0; i < 8; i++) {
      const r = await settle(runFile('x', []))
      if (!r.ok) errs.push(r.err)
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(errs).toHaveLength(8)
    expect(
      errs.every(
        (e) => e instanceof SpawnHelperExitedError || e instanceof SpawnHelperUnavailableError
      )
    ).toBe(true)
    expect(errs.some((e) => e instanceof SpawnHelperUnavailableError)).toBe(true)
    expect(starts).toBeLessThanOrEqual(3)
  })
})
