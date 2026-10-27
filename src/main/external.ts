import { ipcMain, shell } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { accessSync, constants as fsConstants, statSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { delimiter, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { spawnEnvOnce } from './appimage-env'
import { pickAttempt, planEditorLaunch } from './editor-launch'
import { githubPullsUrlFromRemote } from './github-remote'
import { readEditorSetting } from './settings'

const execFileAsync = promisify(execFile)

/**
 * What `external:openInEditor` resolves with. `terminal` is a launch the
 * renderer finishes: main only resolves WHICH executable exists; the renderer
 * opens the shell pane that runs it (the PTY machinery lives behind the pane).
 * Mirrored inline in `src/preload/index.ts`.
 */
export type OpenInEditorResult =
  | { ok: true; mode: 'gui' }
  | { ok: true; mode: 'terminal'; name: string; cmd: string; args: string[] }
  | {
      ok: false
      code: 'invalid-path' | 'bad-command' | 'not-found'
      /** The configured editor's display name ("VS Code", "editor" for custom). */
      name?: string
      editorId?: string
      /** `not-found` only: the executable that was looked for first. */
      command?: string
      /** English fallback; the renderer localizes from `code`. */
      error: string
    }

/**
 * Open-in-external-app channels (Topbar "Open folder" / "Open in {editor}").
 *
 * - `external:openPath` reveals/opens a path with the OS-default handler via
 *   `shell.openPath`. For a directory this opens the system file manager.
 *   `shell.openPath` resolves with an error *string* (empty when it succeeded),
 *   never rejects.
 * - `external:openInEditor` launches the editor configured in Settings (T581;
 *   VS Code by default, read from `settings.json` at call time). A GUI editor is
 *   spawned detached so it outlives the spawning turn. Plain PATH lookup alone
 *   silently fails on macOS: an app launched from Finder/Dock/Spotlight doesn't
 *   inherit PATH additions a user made in `.zshrc`/`.zprofile` (only a login
 *   shell sources those), and even a working `code` in an interactive terminal
 *   is sometimes just a shell alias (invisible to `spawn`, which never goes
 *   through a shell). So presets carry the well-known absolute install
 *   locations (`editor-launch.ts`) and we try them in order before giving up. A
 *   missing binary surfaces as an async `'error'` (ENOENT) on the child; we
 *   listen for it and fall through to the next candidate. A terminal editor is
 *   not spawned here: we probe PATH for the first candidate that exists and hand
 *   `{ cmd, args }` back for the renderer to run in a shell pane. Never through
 *   a shell, and the folder path is always one argv entry.
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

  ipcMain.handle('external:openInEditor', async (_e, p: string): Promise<OpenInEditorResult> => {
    // Require an absolute path: it can then never start with `-` and be read as a flag.
    if (typeof p !== 'string' || p.length === 0 || !isAbsolute(p)) {
      return { ok: false, code: 'invalid-path', error: 'invalid path' }
    }
    const planned = planEditorLaunch(await readEditorSetting(), process.platform, p)
    if (!planned.ok) {
      return {
        ok: false,
        code: 'bad-command',
        name: 'editor',
        editorId: 'custom',
        error: 'The custom editor command is empty or malformed. Check Settings → General → Editor.'
      }
    }
    const { plan } = planned
    const notFound = (): OpenInEditorResult => ({
      ok: false,
      code: 'not-found',
      name: plan.name,
      editorId: plan.editorId,
      command: plan.attempts[0].cmd,
      error: notFoundMessage(plan.editorId, plan.attempts[0].cmd)
    })

    if (plan.mode === 'terminal') {
      const env = await spawnEnvOnce()
      const hit = pickAttempt(plan.attempts, (cmd) =>
        findExecutable(cmd, env.PATH ?? env.Path ?? '', process.platform)
      )
      if (!hit) return notFound()
      return { ok: true, mode: 'terminal', name: plan.name, cmd: hit.cmd, args: hit.args }
    }

    for (const attempt of plan.attempts) {
      if (await trySpawnDetached(attempt.cmd, attempt.args)) return { ok: true, mode: 'gui' }
    }
    return notFound()
  })
}

/** The English "binary missing" line (VS Code keeps its install hint). */
function notFoundMessage(editorId: string, command: string): string {
  if (editorId === 'vscode') {
    return (
      "Couldn't launch VS Code CLI (`code`). In VS Code, open the Command Palette and run " +
      '"Shell Command: Install \'code\' command in PATH", then try again.'
    )
  }
  return `\`${command}\` not found on PATH. Check Settings → General → Editor.`
}

/**
 * True when `cmd` resolves to an executable file: an absolute path is checked
 * as given, a bare name is searched through `pathEnv` (with `PATHEXT` on
 * Windows). Synchronous fs calls — a handful of stat/access checks per click.
 */
export function findExecutable(cmd: string, pathEnv: string, platform: NodeJS.Platform): boolean {
  const isFile = (f: string): boolean => {
    try {
      if (!statSync(f).isFile()) return false
      accessSync(f, platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK)
      return true
    } catch {
      return false
    }
  }
  if (isAbsolute(cmd)) return isFile(cmd)
  const exts =
    platform === 'win32'
      ? ['', ...(process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean)]
      : ['']
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue
    for (const ext of exts) if (isFile(join(dir, cmd + ext))) return true
  }
  return false
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
