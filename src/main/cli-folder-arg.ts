import { isAbsolute, resolve } from 'node:path'

/**
 * Pure resolver for the `harnu .` / `harnu <path>` CLI folder argument (T45), like
 * `code .`. Scans argv from `startIndex` for the first positional (non-flag)
 * token and resolves it against `cwd`: `.` → cwd, a relative path → cwd/rel, an
 * absolute path verbatim. Returns null when there's no positional arg.
 *
 * `startIndex` accounts for Electron's argv shape: a PACKAGED app is
 * `[execPath, ...userArgs]` (start at 1); `electron .` in dev is
 * `[electron, appPath, ...userArgs]` (start at 2). The caller derives it from
 * `app.isPackaged`. Framework-free → unit-tested in isolation. It does NOT stat
 * the path; the caller (`adoptExistingFolder`) validates it's a real directory.
 */
export function resolveCliFolderArg(
  argv: readonly string[],
  cwd: string,
  startIndex: number
): string | null {
  for (let i = Math.max(0, startIndex); i < argv.length; i++) {
    const a = argv[i]
    if (!a || a.startsWith('-')) continue // skip flags (--remote-debugging-port, etc.)
    return isAbsolute(a) ? a : resolve(cwd, a)
  }
  return null
}
