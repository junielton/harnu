/**
 * BUG-266 — the ONE place Harnu starts a child process for git, gh, docker and `claude -p`.
 *
 * `child_process.spawn()` is a `fork()` of the calling process. The main process maps hundreds of
 * megabytes, so a single spawn held the thread that carries keystrokes for 10-370 ms
 * (docs/dev/spawn-runner.md has the measurement). So the main process does not fork: it posts a request to a
 * small helper process (`spawn-helper.ts`, an Electron `utilityProcess`) and gets the result back as a message.
 * Posting costs ~0.1 ms.
 *
 * What lives here:
 *  - {@link runFile}: `execFile` as a promise (same result and same rejection: `code`, `killed`, `signal`,
 *    `stdout`, `stderr`), with a `kill()` for the callers that abort work.
 *  - {@link spawnChild}: a streaming child (`stdout`/`stderr` streams, `stdin`, `kill`, `exit`/`close`).
 *  - Concurrency lanes (BUG-262): at most {@link GH_SPAWN_LIMIT} `gh` children and
 *    {@link GIT_PROBE_CONCURRENCY} git probes in flight, with a yield to the event loop before each start.
 *  - Failure behaviour: a helper that dies is restarted on the next request, every request that was waiting on
 *    it rejects with {@link SpawnHelperExitedError} (never hangs), and a helper that cannot start rejects with
 *    {@link SpawnHelperUnavailableError}.
 *
 * Until {@link startSpawnRunner} is called (unit tests, tooling) the runner runs the same code in-process with
 * `child_process`, so existing tests and scripts behave exactly as before.
 *
 * `tests/spawn-runner-no-direct-spawn.test.ts` fails on any other `child_process` import in `src/main`.
 * node-pty (the PTY path) is not a child process of this kind and does not come through here.
 */

import { EventEmitter } from 'node:events'
import { execFile, fork, spawn, type ChildProcess } from 'node:child_process'
import { PassThrough, Writable, type Readable } from 'node:stream'
import { setImmediate as yieldToLoop } from 'node:timers/promises'
import type {
  FromHelper,
  ToHelper,
  WireError,
  WireExecOptions,
  WireSpawnOptions,
  WireStdio
} from './spawn-protocol'

// --- public types --------------------------------------------------------------------------------------------

export interface RunFileOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeout?: number
  maxBuffer?: number
  windowsHide?: boolean
  killSignal?: NodeJS.Signals
  /** Written to the child's stdin, then closed. */
  stdin?: string
  /** Concurrency lane. Defaults to the binary's own lane (`gh`), else the shared one. */
  lane?: string
}

export interface RunResult {
  stdout: string
  stderr: string
}

/** The promise {@link runFile} returns; `kill()` stops the child (or drops it from the queue). */
export type RunFilePromise = Promise<RunResult> & { kill(signal?: NodeJS.Signals): boolean }

export interface SpawnChildOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  windowsHide?: boolean
  stdio?: [WireStdio, WireStdio, WireStdio]
  /** `os.setPriority` for the child, applied by whoever forks it (the helper). */
  priority?: number
}

/** What every caller needs of a streaming child; a real `ChildProcess` satisfies it too. */
export interface SpawnedChild extends EventEmitter {
  readonly pid: number | undefined
  readonly stdin: Writable | null
  readonly stdout: Readable | null
  readonly stderr: Readable | null
  kill(signal?: NodeJS.Signals | number): boolean
  unref(): void
}

export class SpawnHelperExitedError extends Error {
  readonly code = 'SPAWN_HELPER_EXITED'
  constructor(detail: string) {
    super(`The spawn helper process exited before the child finished (${detail}).`)
    this.name = 'SpawnHelperExitedError'
  }
}

export class SpawnHelperUnavailableError extends Error {
  readonly code = 'SPAWN_HELPER_UNAVAILABLE'
  constructor(detail: string) {
    super(`The spawn helper process could not be started (${detail}).`)
    this.name = 'SpawnHelperUnavailableError'
  }
}

// --- lanes (BUG-262) -----------------------------------------------------------------------------------------

/**
 * BUG-262: a burst of `gh` calls in one task froze typing, and every call also spends the operator's GitHub
 * budget. At most this many `gh` children are in flight.
 */
export const GH_SPAWN_LIMIT = 4
/** BUG-262: `isWorktreeDirty` ran one git child per worktree in a loop; at most this many probes run at once. */
export const GIT_PROBE_CONCURRENCY = 4
/** Everything else shares this many slots, a safety valve rather than a policy. */
export const DEFAULT_LANE_LIMIT = 16

const LANE_LIMITS: Record<string, number> = {
  gh: GH_SPAWN_LIMIT,
  'git-probe': GIT_PROBE_CONCURRENCY
}

interface Lane {
  inFlight: number
  waiters: Array<() => void>
}
const lanes = new Map<string, Lane>()

function laneFor(file: string, requested: string | undefined): string {
  if (requested) return requested
  return file === 'gh' ? 'gh' : 'default'
}

/** Resolves once a slot in `name` is ours; call the returned function to hand it on. */
async function takeSlot(name: string): Promise<() => void> {
  let lane = lanes.get(name)
  if (!lane) lanes.set(name, (lane = { inFlight: 0, waiters: [] }))
  const limit = LANE_LIMITS[name] ?? DEFAULT_LANE_LIMIT
  if (lane.inFlight >= limit) await new Promise<void>((resolve) => lane!.waiters.push(resolve))
  else lane.inFlight++
  const held = lane
  let released = false
  return () => {
    if (released) return
    released = true
    const next = held.waiters.shift()
    if (next) next()
    else held.inFlight--
  }
}

// --- the helper process --------------------------------------------------------------------------------------

/** What the runner needs of the helper process, whether it is a `utilityProcess` or a Node `fork`. */
export interface HelperProcess {
  post(m: ToHelper): void
  onMessage(cb: (m: FromHelper) => void): void
  onExit(cb: (detail: string) => void): void
  kill(): void
}

export type HelperFactory = () => HelperProcess

/** Adapt an Electron `UtilityProcess` (structured clone, `postMessage`). */
export function fromUtilityProcess(up: {
  postMessage(m: unknown): void
  on(event: 'message', cb: (m: unknown) => void): unknown
  on(event: 'exit', cb: (code: number) => void): unknown
  kill(): boolean
}): HelperProcess {
  return {
    post: (m) => up.postMessage(m),
    onMessage: (cb) => up.on('message', (m) => cb(m as FromHelper)),
    onExit: (cb) => up.on('exit', (code) => cb(`exit code ${code}`)),
    kill: () => void up.kill()
  }
}

/** Adapt a `child_process.fork` of the helper (advanced serialization). Where there is no Electron. */
export function fromForkedHelper(path: string, execArgv: string[] = []): HelperFactory {
  return () => {
    const cp = forkHelperProcess(path, execArgv)
    return {
      post: (m) => void cp.send(m),
      onMessage: (cb) => cp.on('message', (m) => cb(m as FromHelper)),
      onExit: (cb) => cp.on('exit', (code, signal) => cb(`exit code ${code} signal ${signal}`)),
      // SIGTERM: the helper's handler kills its own children before it exits.
      kill: () => void cp.kill('SIGTERM')
    }
  }
}

function forkHelperProcess(path: string, execArgv: string[]): ChildProcess {
  return fork(path, [], {
    serialization: 'advanced',
    execArgv,
    env: { ...process.env, HARNU_SPAWN_HELPER: '1' }
  })
}

interface Live {
  proc: HelperProcess
  generation: number
}

let factory: HelperFactory | null = null
let live: Live | null = null
let generation = 0
let nextId = 1
/** Consecutive starts that died before saying `ready`; reset by every `ready`. */
let failedStarts = 0
let lastFailAt = 0
const MAX_FAILED_STARTS = 3
const FAIL_WINDOW_MS = 30_000

const pendingExec = new Map<number, { resolve(v: RunResult): void; reject(e: unknown): void }>()
const helperChildren = new Map<number, HelperChild>()

/**
 * Route every spawn through a helper process from now on. Called once at boot with a factory for the
 * helper (index.ts passes `utilityProcess.fork`). The helper starts here, while the main process is still small.
 */
export function startSpawnRunner(f: HelperFactory): void {
  factory = f
  failedStarts = 0
  try {
    ensureHelper()
  } catch {
    /* surfaces on the first request as SpawnHelperUnavailableError */
  }
}

/** Stop the helper and go back to in-process spawning (tests, app quit). */
export function stopSpawnRunner(): void {
  const l = live
  factory = null
  live = null
  failHelper(l, 'stopped')
  l?.proc.kill()
}

/** True while spawns are handed to the helper. */
export function spawnRunnerActive(): boolean {
  return factory !== null
}

/** The helper's `pid` is not exposed; this is for tests that need to prove a helper died and came back. */
export function currentHelperGeneration(): number {
  return live?.generation ?? 0
}

function ensureHelper(): Live {
  if (live) return live
  if (!factory) throw new SpawnHelperUnavailableError('the runner was not started')
  if (failedStarts >= MAX_FAILED_STARTS && Date.now() - lastFailAt < FAIL_WINDOW_MS) {
    throw new SpawnHelperUnavailableError(
      `${failedStarts} starts in a row died before they were ready`
    )
  }
  let proc: HelperProcess
  try {
    proc = factory()
  } catch (e) {
    failedStarts++
    lastFailAt = Date.now()
    throw new SpawnHelperUnavailableError(e instanceof Error ? e.message : String(e))
  }
  const gen = ++generation
  const l: Live = { proc, generation: gen }
  live = l
  let ready = false
  proc.onMessage((m) => {
    if (live !== l) return
    if (m.t === 'ready') {
      ready = true
      failedStarts = 0
      return
    }
    dispatch(m)
  })
  proc.onExit((detail) => {
    if (live !== l) return
    live = null
    if (!ready) {
      failedStarts++
      lastFailAt = Date.now()
    }
    failHelper(l, detail)
  })
  return l
}

/** The helper is gone: everything that was waiting on it rejects now, instead of never. */
function failHelper(l: Live | null, detail: string): void {
  if (!l) return
  for (const [id, p] of [...pendingExec]) {
    pendingExec.delete(id)
    p.reject(new SpawnHelperExitedError(detail))
  }
  for (const [id, c] of [...helperChildren]) {
    helperChildren.delete(id)
    c.helperGone(new SpawnHelperExitedError(detail))
  }
}

function dispatch(m: Exclude<FromHelper, { t: 'ready' }>): void {
  switch (m.t) {
    case 'exec-done': {
      const p = pendingExec.get(m.id)
      if (!p) return
      pendingExec.delete(m.id)
      p.resolve({ stdout: m.stdout, stderr: m.stderr })
      return
    }
    case 'exec-fail': {
      const p = pendingExec.get(m.id)
      if (!p) return
      pendingExec.delete(m.id)
      p.reject(rebuildError(m.error))
      return
    }
    default: {
      const c = helperChildren.get(m.id)
      if (!c) return
      if (m.t === 'close' || m.t === 'spawn-error') helperChildren.delete(m.id)
      c.fromHelper(m)
    }
  }
}

/** The `Error` `execFile` would have produced, rebuilt from its wire form. */
export function rebuildError(w: WireError): Error {
  const e = new Error(w.message)
  e.name = w.name
  const { name: _n, message: _m, ...rest } = w
  void _n
  void _m
  return Object.assign(e, rest)
}

function post(m: ToHelper): void {
  ensureHelper().proc.post(m)
}

// --- runFile -------------------------------------------------------------------------------------------------

function wireExec(o: RunFileOptions): WireExecOptions {
  return {
    cwd: o.cwd,
    // Same as the in-process default: a child that is given no env inherits ours.
    env: o.env ?? process.env,
    timeout: o.timeout,
    maxBuffer: o.maxBuffer,
    windowsHide: o.windowsHide ?? true,
    killSignal: o.killSignal,
    stdin: o.stdin
  }
}

/**
 * `execFile` as a promise. Resolves `{ stdout, stderr }` (utf8) and rejects like `execFile` does: the error
 * carries `code`, `killed`, `signal`, `stdout` and `stderr`. The returned promise has a `kill()`.
 */
export function runFile(
  file: string,
  args: readonly string[],
  opts: RunFileOptions = {}
): RunFilePromise {
  let killed = false
  let killer: ((signal?: NodeJS.Signals) => boolean) | null = null
  const promise = (async (): Promise<RunResult> => {
    const release = await takeSlot(laneFor(file, opts.lane))
    try {
      // BUG-262: give input and timers a turn between two starts.
      await yieldToLoop()
      if (killed)
        throw Object.assign(new Error('killed before it started'), {
          killed: true,
          code: null,
          signal: 'SIGTERM',
          stdout: '',
          stderr: ''
        })
      return await (factory
        ? execViaHelper(file, args, opts, (k) => (killer = k))
        : execInProcess(file, args, opts, (k) => (killer = k)))
    } finally {
      release()
    }
  })() as RunFilePromise
  promise.kill = (signal) => {
    killed = true
    return killer ? killer(signal) : true
  }
  return promise
}

function execViaHelper(
  file: string,
  args: readonly string[],
  opts: RunFileOptions,
  setKiller: (k: (signal?: NodeJS.Signals) => boolean) => void
): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    const id = nextId++
    pendingExec.set(id, { resolve, reject })
    setKiller((signal) => {
      if (!pendingExec.has(id)) return false
      try {
        post({ t: 'kill', id, signal })
      } catch {
        return false
      }
      return true
    })
    try {
      post({ t: 'exec', id, file, args: [...args], o: wireExec(opts) })
    } catch (e) {
      pendingExec.delete(id)
      reject(e)
    }
  })
}

function execInProcess(
  file: string,
  args: readonly string[],
  opts: RunFileOptions,
  setKiller: (k: (signal?: NodeJS.Signals) => boolean) => void
): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    const child = execFile(
      file,
      [...args],
      {
        cwd: opts.cwd,
        env: opts.env,
        timeout: opts.timeout,
        maxBuffer: opts.maxBuffer,
        windowsHide: opts.windowsHide ?? true,
        killSignal: opts.killSignal,
        encoding: 'utf8'
      },
      (err, stdout, stderr) => {
        if (err)
          reject(Object.assign(err, { stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }))
        else resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      }
    )
    setKiller((signal) => child.kill(signal))
    // `gh` can exit before the body is written (bad auth, no such PR): EPIPE on this stream is not the story,
    // the callback above carries the real reason.
    child.stdin?.on('error', () => {})
    if (opts.stdin !== undefined) child.stdin?.end(opts.stdin)
  })
}

// --- spawnChild ----------------------------------------------------------------------------------------------

/**
 * Start a streaming child. In the helper this returns at once with `pid` still unset; it is filled in (and
 * `spawn` is emitted) when the helper reports the child running. A spawn that fails (`ENOENT`) is an `error`
 * event followed by `close`, as with `child_process.spawn`. Not subject to the lanes: these are long-lived.
 */
export function spawnChild(
  file: string,
  args: readonly string[],
  opts: SpawnChildOptions = {}
): SpawnedChild {
  if (!factory) {
    return spawn(file, [...args], {
      cwd: opts.cwd,
      env: opts.env,
      windowsHide: opts.windowsHide ?? true,
      stdio: opts.stdio ?? ['pipe', 'pipe', 'pipe']
    }) as unknown as SpawnedChild
  }
  const id = nextId++
  const child = new HelperChild(id, opts.stdio)
  const wire: WireSpawnOptions = {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    windowsHide: opts.windowsHide ?? true,
    stdio: opts.stdio,
    priority: opts.priority
  }
  try {
    helperChildren.set(id, child)
    post({ t: 'spawn', id, file, args: [...args], o: wire })
  } catch (e) {
    helperChildren.delete(id)
    // Same shape as a failed `child_process.spawn`: the error arrives as an event, after the caller attached.
    queueMicrotask(() => child.helperGone(e))
  }
  return child
}

class HelperChild extends EventEmitter implements SpawnedChild {
  pid: number | undefined
  readonly stdout: PassThrough | null
  readonly stderr: PassThrough | null
  readonly stdin: Writable | null
  private done = false

  constructor(
    private readonly id: number,
    stdio: [WireStdio, WireStdio, WireStdio] = ['pipe', 'pipe', 'pipe']
  ) {
    super()
    this.stdout = stdio[1] === 'pipe' ? new PassThrough() : null
    this.stderr = stdio[2] === 'pipe' ? new PassThrough() : null
    this.stdin =
      stdio[0] === 'pipe'
        ? new Writable({
            write: (chunk: Buffer | string, enc, cb) => {
              try {
                post({
                  t: 'stdin',
                  id: this.id,
                  data:
                    typeof chunk === 'string' ? Buffer.from(chunk, enc as BufferEncoding) : chunk
                })
                cb()
              } catch (e) {
                cb(e as Error)
              }
            },
            final: (cb) => {
              try {
                post({ t: 'stdin-end', id: this.id })
              } catch {
                /* the helper is gone; the close event says so */
              }
              cb()
            }
          })
        : null
  }

  kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    if (this.done) return false
    try {
      post({ t: 'kill', id: this.id, signal: typeof signal === 'number' ? undefined : signal })
      return true
    } catch {
      return false
    }
  }

  unref(): void {
    /* the helper owns the process; nothing in the main process keeps it alive */
  }

  fromHelper(m: Exclude<FromHelper, { t: 'ready' | 'exec-done' | 'exec-fail' }>): void {
    switch (m.t) {
      case 'spawned':
        this.pid = m.pid
        this.emit('spawn')
        return
      case 'data':
        ;(m.stream === 'stdout' ? this.stdout : this.stderr)?.write(Buffer.from(m.data))
        return
      case 'exit':
        this.emit('exit', m.code, m.signal)
        return
      case 'spawn-error':
        this.finish(rebuildError(m.error), null, null)
        return
      case 'close':
        this.finish(null, m.code, m.signal)
        return
    }
  }

  /** The helper died (or could not be reached) while this child was ours. */
  helperGone(err: unknown): void {
    this.finish(err instanceof Error ? err : new Error(String(err)), null, null)
  }

  private finish(err: Error | null, code: number | null, signal: string | null): void {
    if (this.done) return
    this.done = true
    // Like Node: streams that nobody reads are drained so `close` can fire.
    for (const s of [this.stdout, this.stderr]) {
      if (!s) continue
      s.end()
      if (s.readableFlowing === null) s.resume()
    }
    const closeAfterStreams = (): void => {
      if (err) this.emit('error', err)
      this.emit('close', code, signal)
    }
    const pending = [this.stdout, this.stderr].filter(
      (s): s is PassThrough => !!s && !s.readableEnded
    )
    if (pending.length === 0) {
      closeAfterStreams()
      return
    }
    let left = pending.length
    for (const s of pending) {
      s.once('end', () => {
        if (--left === 0) closeAfterStreams()
      })
    }
  }
}
