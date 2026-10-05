import { ipcMain, shell } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { promisify } from 'node:util'
import { spawnEnvOnce } from './appimage-env'
import { githubPullsUrlFromRemote } from './github-remote'

const execFileAsync = promisify(execFile)

/**
 * Open-in-external-app channels (Topbar "Open folder" / "Open in VS Code").
 *
 * - `external:openPath` reveals/opens a path with the OS-default handler via
 *   `shell.openPath`. For a directory this opens the system file manager.
 *   `shell.openPath` resolves with an error *string* (empty when it succeeded),
 *   never rejects.
 * - `external:openInVSCode` spawns the `code` CLI detached so VS Code outlives
 *   the spawning turn. Plain PATH lookup alone silently fails on macOS: an app
 *   launched from Finder/Dock/Spotlight doesn't inherit PATH additions a user
 *   made in `.zshrc`/`.zprofile` (only a login shell sources those), and even a
 *   working `code` in an interactive terminal is sometimes just a shell alias
 *   (invisible to `spawn`, which never goes through a shell). So on darwin we
 *   also try the well-known absolute install locations `code` normally lands
 *   at, in order, before giving up. A missing binary surfaces as an async
 *   `'error'` (ENOENT) on the child; we listen for it and fall through to the
 *   next candidate. Returns `{ ok, error? }` so the renderer can toast.
 */
export function registerExternal(): void {
  ipcMain.handle('external:openPath', async (_e, p: string): Promise<string> => {
    if (typeof p !== 'string' || p.length === 0) return 'invalid path'
    if (!isAbsolute(p)) return 'invalid path'
    // Confine to real directories: the only caller is "Open folder" (a worktree
    // dir), so refusing files keeps this from being a generic OS-file launcher.
    try {
      const st = await stat(p)
      if (!st.isDirectory()) return 'not a directory'
    } catch {
      return 'no such directory'
    }
    // Resolves with '' on success, or an error message string on failure.
    return shell.openPath(p)
  })

  // Reveal a FILE (or dir) highlighted in the OS file manager — used by the
  // Pasted-images gallery "Reveal in folder" (T46). Unlike `openPath`, this
  // reveals rather than opens/executes, so allowing files is safe. Returns ''
  // on success or a short error string (never rejects).
  ipcMain.handle('external:showItemInFolder', async (_e, p: string): Promise<string> => {
    if (typeof p !== 'string' || p.length === 0 || !isAbsolute(p)) return 'invalid path'
    try {
      await stat(p) // must exist — showItemInFolder reveals the item in its parent
    } catch {
      return 'no such path'
    }
    shell.showItemInFolder(p)
    return ''
  })

  // Topbar "Pull requests on GitHub": the folder's `origin` mapped to its
  // github.com `/pulls` page, or `null` (no git, no origin, not GitHub) — the
  // renderer hides the button on `null`. Never rejects. Opening goes through
  // the existing `shell:openExternal` allowlist.
  ipcMain.handle('external:githubPullsUrl', async (_e, p: string): Promise<string | null> => {
    if (typeof p !== 'string' || p.length === 0 || !isAbsolute(p)) return null
    try {
      const { stdout } = await execFileAsync('git', ['-C', p, 'remote', 'get-url', 'origin'], {
        windowsHide: true,
        timeout: 5_000,
        encoding: 'utf8',
        env: await spawnEnvOnce()
      })
      return githubPullsUrlFromRemote(stdout)
    } catch {
      return null
    }
  })

  ipcMain.handle(
    'external:openInVSCode',
    async (_e, p: string): Promise<{ ok: boolean; error?: string }> => {
      if (typeof p !== 'string' || p.length === 0) {
        return { ok: false, error: 'invalid path' }
      }
      // Require an absolute path and pass it after `--` so a path beginning with
      // `-` can never be parsed by `code` as a flag.
      if (!isAbsolute(p)) {
        return { ok: false, error: 'invalid path' }
      }
      for (const cmd of vscodeCliCandidates()) {
        if (await trySpawnDetached(cmd, ['--', p])) return { ok: true }
      }
      return {
        ok: false,
        error:
          "Couldn't launch VS Code CLI (`code`). In VS Code, open the Command Palette and run " +
          '"Shell Command: Install \'code\' command in PATH", then try again.'
      }
    }
  )
}

/**
 * Attempts one candidate. Resolves `true` on a confirmed spawn, `false` on
 * `'error'` (ENOENT for a missing binary) so the caller can fall through to
 * the next candidate. Never rejects.
 */
function trySpawnDetached(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
    } catch {
      resolve(false)
      return
    }
    child.once('error', () => {
      if (settled) return
      settled = true
      resolve(false)
    })
    child.once('spawn', () => {
      if (settled) return
      settled = true
      child.unref()
      resolve(true)
    })
  })
}

/**
 * `code` on plain PATH first (works on Linux/Windows, and on macOS when
 * launched from a terminal that really exports it). On darwin, fall back to
 * the well-known absolute locations the VS Code installer / Homebrew use —
 * see the `registerExternal` doc comment above for why PATH alone isn't
 * enough there.
 */
function vscodeCliCandidates(): string[] {
  if (process.platform !== 'darwin') return ['code']
  return [
    'code',
    '/usr/local/bin/code',
    '/opt/homebrew/bin/code',
    '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
    '/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code'
  ]
}
