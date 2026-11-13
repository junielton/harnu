/**
 * BUG-266 — the spawn helper: the small process that does the forking.
 *
 * `child_process.spawn()` is a `fork()` of the calling process, and the main process maps hundreds of
 * megabytes, so each spawn held the thread that carries keystrokes for 10-370 ms (docs/dev/spawn-runner.md).
 * This script runs in its own tiny process (an Electron `utilityProcess`, or a plain `child_process.fork` where
 * there is no Electron: tests and tooling). The main process posts it a request, it forks, and the result
 * comes back as another message, so the main thread never forks.
 *
 * One self-contained file on purpose (no local runtime imports): electron-vite builds it as its own entry,
 * and the perf suite bundles it with esbuild. {@link createHelperCore} is exported so unit tests can run the
 * protocol in-process; the entry code at the bottom runs only inside a real helper process.
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import * as os from 'node:os'
import type { FromHelper, ToHelper, WireError } from './spawn-protocol'

function toWireError(e: unknown): WireError {
  const err = (e ?? {}) as Record<string, unknown>
  const out: WireError = {
    name: typeof err.name === 'string' ? err.name : 'Error',
    message: typeof err.message === 'string' ? err.message : String(e)
  }
  if (typeof err.code === 'string' || typeof err.code === 'number' || err.code === null)
    out.code = err.code
  if (typeof err.killed === 'boolean') out.killed = err.killed
  if (typeof err.signal === 'string' || err.signal === null) out.signal = err.signal
  if (typeof err.cmd === 'string') out.cmd = err.cmd
  if (typeof err.stdout === 'string') out.stdout = err.stdout
  else if (err.stdout instanceof Uint8Array) out.stdout = Buffer.from(err.stdout).toString('utf8')
  if (typeof err.stderr === 'string') out.stderr = err.stderr
  else if (err.stderr instanceof Uint8Array) out.stderr = Buffer.from(err.stderr).toString('utf8')
  if (typeof err.errno === 'number') out.errno = err.errno
  if (typeof err.syscall === 'string') out.syscall = err.syscall
  if (typeof err.path === 'string') out.path = err.path
  if (Array.isArray(err.spawnargs)) out.spawnargs = err.spawnargs.map(String)
  return out
}

export interface HelperCore {
  onMessage(m: ToHelper): void
  /** Kill every child still running (the helper is going away). */
  killAll(): void
  /** Children currently alive, for tests. */
  size(): number
}

export function createHelperCore(post: (m: FromHelper) => void): HelperCore {
  const children = new Map<number, ChildProcess>()

  function runExec(m: Extract<ToHelper, { t: 'exec' }>): void {
    const { id, file, args, o } = m
    let child: ChildProcess
    try {
      child = execFile(
        file,
        args,
        {
          cwd: o.cwd,
          env: o.env as NodeJS.ProcessEnv | undefined,
          timeout: o.timeout,
          maxBuffer: o.maxBuffer,
          windowsHide: o.windowsHide ?? true,
          killSignal: o.killSignal as NodeJS.Signals | undefined,
          encoding: 'utf8'
        },
        (err, stdout, stderr) => {
          children.delete(id)
          if (err) {
            const wire = toWireError(err)
            wire.stdout = String(stdout ?? '')
            wire.stderr = String(stderr ?? '')
            post({ t: 'exec-fail', id, error: wire })
          } else {
            post({ t: 'exec-done', id, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
          }
        }
      )
    } catch (e) {
      post({ t: 'exec-fail', id, error: toWireError(e) })
      return
    }
    children.set(id, child)
    // The child may exit before the body is written (bad auth, no such PR): the callback above has the real reason.
    child.stdin?.on('error', () => {})
    if (o.stdin !== undefined) child.stdin?.end(o.stdin)
  }

  function runSpawn(m: Extract<ToHelper, { t: 'spawn' }>): void {
    const { id, file, args, o } = m
    let child: ChildProcess
    try {
      child = spawn(file, args, {
        cwd: o.cwd,
        env: o.env as NodeJS.ProcessEnv | undefined,
        windowsHide: o.windowsHide ?? true,
        stdio: o.stdio ?? ['pipe', 'pipe', 'pipe']
      })
    } catch (e) {
      post({ t: 'spawn-error', id, error: toWireError(e) })
      return
    }
    children.set(id, child)
    child.once('spawn', () => {
      if (o.priority !== undefined && child.pid !== undefined) {
        try {
          os.setPriority(child.pid, o.priority)
        } catch {
          /* a priority is a courtesy, never a failure */
        }
      }
      post({ t: 'spawned', id, pid: child.pid })
    })
    child.stdout?.on('data', (d: Buffer) => post({ t: 'data', id, stream: 'stdout', data: d }))
    child.stderr?.on('data', (d: Buffer) => post({ t: 'data', id, stream: 'stderr', data: d }))
    child.stdin?.on('error', () => {})
    child.on('error', (e) => {
      children.delete(id)
      post({ t: 'spawn-error', id, error: toWireError(e) })
    })
    child.on('exit', (code, signal) => post({ t: 'exit', id, code, signal }))
    child.on('close', (code, signal) => {
      children.delete(id)
      post({ t: 'close', id, code, signal })
    })
  }

  return {
    onMessage(m) {
      switch (m.t) {
        case 'exec':
          return runExec(m)
        case 'spawn':
          return runSpawn(m)
        case 'stdin':
          children.get(m.id)?.stdin?.write(m.data)
          return
        case 'stdin-end':
          children.get(m.id)?.stdin?.end()
          return
        case 'kill':
          children.get(m.id)?.kill((m.signal as NodeJS.Signals | undefined) ?? 'SIGTERM')
          return
      }
    },
    killAll() {
      for (const c of children.values()) {
        try {
          c.kill('SIGTERM')
        } catch {
          /* already gone */
        }
      }
    },
    size: () => children.size
  }
}

// --- entry: only inside a real helper process --------------------------------------------------------------

interface ParentPort {
  postMessage(m: unknown): void
  on(event: 'message', cb: (e: { data: ToHelper }) => void): void
}

function runAsHelperProcess(): void {
  const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort
  let core: HelperCore | undefined
  if (parentPort) {
    // Electron utilityProcess.
    core = createHelperCore((m) => parentPort.postMessage(m))
    parentPort.on('message', (e) => core!.onMessage(e.data))
    parentPort.postMessage({ t: 'ready', pid: process.pid } satisfies FromHelper)
  } else if (process.env.HARNU_SPAWN_HELPER === '1' && typeof process.send === 'function') {
    // Plain `child_process.fork` (advanced serialization), where there is no Electron.
    core = createHelperCore((m) => process.send!(m))
    process.on('message', (m) => core!.onMessage(m as ToHelper))
    process.on('disconnect', () => {
      core!.killAll()
      process.exit(0)
    })
    process.send({ t: 'ready', pid: process.pid } satisfies FromHelper)
  }
  if (core) {
    const bye = (): void => {
      core!.killAll()
      process.exit(0)
    }
    process.on('SIGTERM', bye)
    process.on('SIGINT', bye)
  }
}

runAsHelperProcess()
