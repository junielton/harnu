import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'

const execFileP = promisify(execFile)

/**
 * Best-effort lookup for the `claude` CLI on disk.
 *
 * macOS Dock-launched Electron strips the shell's PATH down to /usr/bin and /bin,
 * which is rarely where `claude` lives. We probe a small set of well-known
 * install locations after asking the OS via `which` (POSIX) or `where.exe`
 * (Windows). Returns the absolute path when found, or `null` so callers can
 * surface a clear error to the user.
 *
 * Cached for the lifetime of the process — the user is unlikely to install /
 * uninstall Claude between app launches.
 */

let cached: string | null | undefined

const COMMON_PATHS_POSIX = ['/usr/local/bin/claude', '/opt/homebrew/bin/claude', '/usr/bin/claude']

function userScopedPosix(home: string): string[] {
  return [
    join(home, '.local', 'bin', 'claude'),
    join(home, '.bun', 'bin', 'claude'),
    join(home, '.deno', 'bin', 'claude'),
    join(home, '.npm-global', 'bin', 'claude')
  ]
}

function userScopedWindows(home: string): string[] {
  // The npm package ships a real `claude.exe` nested in the package's `bin/`;
  // the global `claude.cmd`/`claude` on PATH are only shims around it. ConPTY can
  // only CreateProcess a real executable — launching the .cmd shim drops the user
  // into an interactive cmd.exe instead of Claude — so we target the .exe.
  const npmExe = join('node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
  return [
    join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'npm', npmExe),
    join(home, '.local', 'bin', 'claude.exe'), // native installer
    'C:\\Program Files\\Claude\\claude.exe',
    'C:\\Program Files (x86)\\Claude\\claude.exe'
  ]
}

/**
 * Given a `where.exe claude` hit (which is typically the npm `claude.cmd`/`claude`
 * shim, not a real executable), resolve the real `claude.exe` shipped inside the
 * package's `bin/`. ConPTY can only CreateProcess a real executable. Falls back
 * to the hit itself when it is already an `.exe` or no sibling exe is found.
 */
function resolveWindowsExe(hit: string): string {
  if (/\.exe$/i.test(hit)) return hit
  const sibling = join(
    dirname(hit),
    'node_modules',
    '@anthropic-ai',
    'claude-code',
    'bin',
    'claude.exe'
  )
  if (existsSync(sibling)) return sibling
  return hit
}

async function tryWhich(): Promise<string | null> {
  const isWin = process.platform === 'win32'
  const cmd = isWin ? 'where.exe' : 'which'
  try {
    const { stdout } = await execFileP(cmd, ['claude'])
    const lines = stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && existsSync(l))
    if (isWin) {
      // Prefer a real .exe: a direct .exe hit, then the real exe resolved from a
      // shim hit. Never hand node-pty the .cmd/extension-less shim (lands in
      // cmd.exe instead of Claude — sessions render but can't take input).
      const directExe = lines.find((l) => /\.exe$/i.test(l))
      if (directExe) return directExe
      for (const l of lines) {
        const exe = resolveWindowsExe(l)
        if (/\.exe$/i.test(exe)) return exe
      }
      if (lines.length > 0) return lines[0]
    }
    if (lines.length > 0) return lines[0]
  } catch {
    // not on PATH
  }
  return null
}

function tryCommonPaths(): string | null {
  const isWin = process.platform === 'win32'
  const candidates = isWin
    ? userScopedWindows(homedir())
    : [...userScopedPosix(homedir()), ...COMMON_PATHS_POSIX]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return null
}

export async function resolveClaudePath(): Promise<string | null> {
  if (cached !== undefined) return cached
  const fromWhich = await tryWhich()
  if (fromWhich) {
    cached = fromWhich
    return fromWhich
  }
  const fromCommon = tryCommonPaths()
  cached = fromCommon
  return fromCommon
}

export function clearClaudePathCache(): void {
  cached = undefined
}
