/**
 * Per-platform shell resolution (BUG-29 / ADR-0005). Two independent seams:
 *
 *  - {@link defaultShell} — the interactive shell for a plain `'shell'` PTY
 *    (split terminal): `$SHELL` on POSIX, PowerShell (honoring `%ComSpec%`) on
 *    Windows. Moved here from `pty.ts` so it has one home (D5) rather than a
 *    private copy.
 *  - {@link resolvePosixShell} — a REAL POSIX shell for running `WORKTREE.md`
 *    manifest commands on Windows, where none ships by default. ADR-0005 D1
 *    decided manifest commands are POSIX-shell strings on every platform, never
 *    translated — so Windows needs Git Bash, not PowerShell. Resolution order:
 *    `%HARNU_POSIX_SHELL%` / legacy `%CAPY_POSIX_SHELL%` (escape hatch) → `where.exe bash` → the standard
 *    Git-for-Windows install paths. Cached per process (one probe per app run).
 *
 * env-bound (`child_process` + `node:fs`) ⇒ exercised via mocked seams in
 * `tests/worktree-shell-resolve.test.ts`, not real subprocess/filesystem I/O.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { access } from 'node:fs/promises'

const runFile = promisify(execFile)

/**
 * The default interactive shell for a plain `'shell'` PTY (split terminal),
 * per platform. POSIX uses `$SHELL` (falling back to bash); Windows has no
 * `$SHELL`, so `/bin/bash` would fail with `File not found` — use PowerShell
 * (always present on Win10/11), honoring `%ComSpec%` if the user set it.
 */
export function defaultShell(): string {
  if (process.platform === 'win32') {
    return process.env.ComSpec ?? 'powershell.exe'
  }
  return process.env.SHELL ?? '/bin/bash'
}

/** Standard Git-for-Windows install locations, in probe order (D2). */
function gitBashCandidatePaths(): string[] {
  const candidates: string[] = []
  if (process.env['ProgramFiles']) {
    candidates.push(`${process.env['ProgramFiles']}\\Git\\bin\\bash.exe`)
  }
  if (process.env['ProgramFiles(x86)']) {
    candidates.push(`${process.env['ProgramFiles(x86)']}\\Git\\bin\\bash.exe`)
  }
  if (process.env['LocalAppData']) {
    candidates.push(`${process.env['LocalAppData']}\\Programs\\Git\\bin\\bash.exe`)
  }
  return candidates
}

/** Per-process cache for {@link resolvePosixShell} — `undefined` = not yet resolved. */
let cachedPosixShell: string | null | undefined

async function probePosixShell(): Promise<string | null> {
  const override = process.env.HARNU_POSIX_SHELL || process.env.CAPY_POSIX_SHELL
  if (override) return override

  try {
    const { stdout } = await runFile('where.exe', ['bash'], { windowsHide: true, timeout: 5_000 })
    const hit = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean)
    if (hit) return hit
  } catch {
    // `where.exe` found nothing, or isn't itself on PATH — fall through to the
    // well-known Git-for-Windows install paths.
  }

  for (const candidate of gitBashCandidatePaths()) {
    try {
      await access(candidate)
      return candidate
    } catch {
      // Not installed at this candidate — try the next.
    }
  }
  return null
}

/**
 * Resolve a real POSIX shell (Git Bash) on Windows for running `WORKTREE.md`
 * manifest commands (ADR-0005 D2). Result is cached per process. Returns
 * `null` when nothing resolves — the caller is then expected to fail loudly
 * via {@link posixShellRequirementError} rather than spawn a nonexistent `sh`.
 */
export async function resolvePosixShell(): Promise<string | null> {
  if (cachedPosixShell === undefined) {
    cachedPosixShell = await probePosixShell()
  }
  return cachedPosixShell
}

/** Test-only: clear the {@link resolvePosixShell} per-process cache. */
export function resetPosixShellCacheForTests(): void {
  cachedPosixShell = undefined
}

/**
 * ADR-0005 D3 — the loud, actionable error when a Windows machine has no
 * resolvable POSIX shell for a `WORKTREE.md` manifest command. Named as the
 * requirement (Git Bash) and the escape hatch (`HARNU_POSIX_SHELL`) — never a
 * bare `spawn sh ENOENT`.
 */
export function posixShellRequirementError(): Error {
  return new Error(
    "This repo's WORKTREE.md needs a POSIX shell to run its setup/create commands, " +
      'but none was found on this Windows machine. Install Git for Windows ' +
      '(https://git-for-windows.github.io/) so Git Bash is available, or set the ' +
      'HARNU_POSIX_SHELL environment variable to the full path of a bash-compatible shell.'
  )
}
