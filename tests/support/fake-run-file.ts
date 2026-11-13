/**
 * BUG-266: call sites run children through the spawn runner's `runFile`. Many older tests drive a fake
 * `execFile(file, args, opts, cb)` that hands back a child with a `kill`; this adapts such a fake to the
 * runner's promise shape (resolve `{ stdout, stderr }`, reject with `stdout`/`stderr` on the error, `kill()`
 * forwarded to the fake child) so those tests keep exercising the call site, not the process boundary.
 */
type ExecFileLike = (
  file: string,
  args: string[],
  opts: unknown,
  cb: (err: Error | null, stdout?: unknown, stderr?: unknown) => void
) => { kill?: (signal?: string) => unknown } | undefined

export function runFileFromExecFile(execFile: ExecFileLike) {
  return (file: string, args: readonly string[], opts: unknown = {}) => {
    let child: { kill?: (signal?: string) => unknown } | undefined
    const promise = new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      child = execFile(file, [...args], opts, (err, stdout, stderr) => {
        const out = { stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }
        if (err) reject(Object.assign(err, out))
        else resolve(out)
      })
    })
    return Object.assign(promise, {
      kill: (signal?: string): boolean => {
        child?.kill?.(signal)
        return true
      }
    })
  }
}
