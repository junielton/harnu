/**
 * BUG-266 — the messages between the main process and the spawn helper (`spawn-helper.ts`).
 *
 * Types only, on purpose: the helper imports this with `import type`, so the helper file stays one
 * self-contained script that any Node can run. Every payload is plain data that survives both
 * structured clone (Electron `utilityProcess`) and Node's `advanced` IPC serialization.
 */

/** An `Error` flattened for the wire; `rebuildError` in `spawn-runner.ts` turns it back into an `Error`. */
export interface WireError {
  name: string
  message: string
  /** Exit code (number) for a child that ran and failed, or `'ENOENT'` etc. for one that never started. */
  code?: string | number | null
  killed?: boolean
  signal?: string | null
  cmd?: string
  stdout?: string
  stderr?: string
  errno?: number
  syscall?: string
  path?: string
  spawnargs?: string[]
}

/** What `execFile` takes that the runner supports, minus anything that cannot cross a process boundary. */
export interface WireExecOptions {
  cwd?: string
  env?: Record<string, string | undefined>
  timeout?: number
  maxBuffer?: number
  windowsHide?: boolean
  killSignal?: string
  /** Written to the child's stdin, then closed (a review body must not travel as an argument). */
  stdin?: string
}

export type WireStdio = 'pipe' | 'ignore' | 'inherit'

export interface WireSpawnOptions {
  cwd?: string
  env?: Record<string, string | undefined>
  windowsHide?: boolean
  /** `[stdin, stdout, stderr]`. Default: all `pipe`. */
  stdio?: [WireStdio, WireStdio, WireStdio]
  /** `os.setPriority` for the child, applied inside the helper right after the spawn. */
  priority?: number
}

export type ToHelper =
  | { t: 'exec'; id: number; file: string; args: string[]; o: WireExecOptions }
  | { t: 'spawn'; id: number; file: string; args: string[]; o: WireSpawnOptions }
  | { t: 'stdin'; id: number; data: Uint8Array }
  | { t: 'stdin-end'; id: number }
  | { t: 'kill'; id: number; signal?: string }

export type FromHelper =
  | { t: 'ready'; pid: number }
  | { t: 'exec-done'; id: number; stdout: string; stderr: string }
  | { t: 'exec-fail'; id: number; error: WireError }
  /** The child of a `spawn` request is running (`pid` is undefined when the spawn failed: see `spawn-error`). */
  | { t: 'spawned'; id: number; pid?: number }
  | { t: 'data'; id: number; stream: 'stdout' | 'stderr'; data: Uint8Array }
  | { t: 'exit'; id: number; code: number | null; signal: string | null }
  | { t: 'close'; id: number; code: number | null; signal: string | null }
  | { t: 'spawn-error'; id: number; error: WireError }
