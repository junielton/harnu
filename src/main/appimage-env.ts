import { execFile } from 'node:child_process'

/**
 * Sanitize the AppImage-runtime pollution out of an environment before it is
 * handed to a spawned child process (no electron imports — unit-testable).
 *
 * When Harnu runs from an AppImage, the AppImage runtime mutates the process
 * environment: it prepends the squashfs mount (`$APPDIR`, e.g.
 * `/tmp/.mount_Claudexxxx`) onto `PATH`, `LD_LIBRARY_PATH`, `XDG_DATA_DIRS`,
 * `GSETTINGS_SCHEMA_DIR`, … and exports the markers `APPDIR` / `APPIMAGE` /
 * `ARGV0` / `OWD`. Harnu is a TERMINAL MANAGER — it spawns the user's shell
 * via node-pty — so spreading this polluted env into every child breaks the
 * user's tooling: `mise` reports the `APPIMAGE` path as "not a valid shim",
 * and worse, system binaries can pick up the bundled glibc/libs through the
 * leaked `LD_LIBRARY_PATH`.
 *
 * This strips every entry rooted in the squashfs mount from the colon-list
 * vars (deleting a var that becomes empty) and removes the marker vars,
 * yielding the environment the child would have seen if launched from a
 * normal terminal. `APPDIR` is not trusted blindly as the mount — under
 * AppImageLauncher it points at the launcher's own dir, not the squashfs
 * mount — so the mount is also detected from `process.execPath` (pass it via
 * `opts.execPath`) and from any `/tmp/.mount_*`-shaped PATH/LD_LIBRARY_PATH
 * segment; `APPDIR` is still stripped as an additional prefix.
 *
 * No-op when no mount is detected and `APPDIR` is absent (dev run, `.deb`
 * install, or any non-AppImage context), so it is always safe to call.
 */

/** Marker vars the AppImage runtime sets that should never reach a child. */
const APPIMAGE_MARKER_VARS = ['APPDIR', 'APPIMAGE', 'ARGV0', 'OWD'] as const

/** Colon-list vars scanned for a `/tmp/.mount_*` shape when detecting the mount. */
const MOUNT_SCAN_VARS = ['PATH', 'LD_LIBRARY_PATH'] as const

/** Matches a squashfs mount root: the first path component under `/tmp` whose
 *  basename starts with `.mount_` (the AppImage runtime's naming convention). */
const MOUNT_ROOT_RE = /^(\/tmp\/\.mount_[^/]+)(?:\/|$)/

function mountRootOf(path: string): string | null {
  return MOUNT_ROOT_RE.exec(path)?.[1] ?? null
}

/**
 * Detect every squashfs mount + pollution prefix we have reason to distrust:
 * `APPDIR` (belt-and-suspenders — under AppImageLauncher it is itself
 * pollution, and under a plain AppImage run it IS the mount) plus any
 * `/tmp/.mount_*` root found in `execPath` or in a `PATH`/`LD_LIBRARY_PATH`
 * segment. `execPath` is authoritative (the Electron binary runs from the
 * mount); scanning the colon-lists catches a mount that heuristic misses —
 * which is exactly what an AppImageLauncher-relayed env looks like, since
 * `APPDIR` there points at the launcher's own dir, not the squashfs mount.
 */
function detectMountPrefixes(
  env: Record<string, string>,
  execPath: string | undefined
): Set<string> {
  const prefixes = new Set<string>()

  const execMount = execPath ? mountRootOf(execPath) : null
  if (execMount) prefixes.add(execMount)

  for (const varName of MOUNT_SCAN_VARS) {
    const value = env[varName]
    if (!value) continue
    for (const seg of value.split(':')) {
      const mount = mountRootOf(seg)
      if (mount) prefixes.add(mount)
    }
  }

  if (env.APPDIR) prefixes.add(env.APPDIR)

  return prefixes
}

/** Path-boundary-aware prefix match — `/tmp/.mount_X` must not chew a sibling
 *  `/tmp/.mount_XX` just because it shares a character prefix. */
function isRootedIn(seg: string, prefixes: Set<string>): boolean {
  for (const prefix of prefixes) {
    if (seg === prefix || seg.startsWith(`${prefix}/`)) return true
  }
  return false
}

export function sanitizeSpawnEnv(
  input: Record<string, string | undefined>,
  opts: { execPath?: string } = {}
): Record<string, string> {
  // Drop undefined values up front so the return type is clean.
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(input)) {
    if (v !== undefined) out[k] = v
  }

  const prefixes = detectMountPrefixes(out, opts.execPath)
  // No detected mount and no APPDIR — not running from an AppImage, nothing to strip.
  if (prefixes.size === 0) return out

  for (const marker of APPIMAGE_MARKER_VARS) delete out[marker]

  for (const [key, value] of Object.entries(out)) {
    let hit = false
    for (const prefix of prefixes) {
      if (value.includes(prefix)) {
        hit = true
        break
      }
    }
    if (!hit) continue
    // Treat the value as a colon-list, drop any segment rooted in a detected
    // prefix (and any empty segment — an empty entry means "current dir",
    // which the AppImage's trailing colon introduced). Delete the var if
    // nothing remains.
    const kept = value.split(':').filter((seg) => seg !== '' && !isRootedIn(seg, prefixes))
    if (kept.length === 0) delete out[key]
    else out[key] = kept.join(':')
  }

  return out
}

/**
 * Sanitizing the AppImage pollution is necessary but not sufficient. A
 * GUI-launched AppImage never sources the user's interactive shell config
 * (`.zshrc` + `mise activate`), so its inherited PATH lacks the user's real
 * toolchain — `node` (mise shims at `~/.local/share/mise/...`) and `rtk`
 * (`~/.local/bin`). The `claude` sessions Harnu spawns then fail their
 * `command` hooks with `node: not found` / `rtk: not found`. We recover the
 * login PATH by running the user's login+interactive shell once, then fold it
 * into the child env (below).
 */
const PATH_BEGIN = '__OM2TAB_PATH_BEGIN__'
const PATH_END = '__OM2TAB_PATH_END__'

/** Extract the PATH a login shell printed between our markers, ignoring any
 *  rc-file stdout noise. Returns null if the markers/PATH are absent. */
export function parseLoginPathOutput(stdout: string): string | null {
  const start = stdout.indexOf(PATH_BEGIN)
  const end = stdout.indexOf(PATH_END)
  if (start === -1 || end === -1 || end < start) return null
  const path = stdout.slice(start + PATH_BEGIN.length, end)
  return path.length > 0 ? path : null
}

/**
 * Run the user's login+interactive shell once to capture the PATH a normal
 * terminal launch would give (so `mise activate` and `~/.local/bin` are
 * applied). Best-effort: resolves null on a missing `$SHELL`, a shell error, or
 * a timeout — the caller then leaves the (sanitized) base PATH untouched.
 */
export function captureLoginPath(
  opts: { shell?: string; timeoutMs?: number } = {}
): Promise<string | null> {
  const shell = opts.shell ?? process.env.SHELL
  if (!shell) return Promise.resolve(null)
  // `-l -i` so both .zprofile and .zshrc/mise-activate run; printf with literal
  // markers around $PATH so we can recover it cleanly from any rc-file output.
  const script = `printf '${PATH_BEGIN}%s${PATH_END}' "$PATH"`
  return new Promise((resolve) => {
    execFile(
      shell,
      ['-lic', script],
      { timeout: opts.timeoutMs ?? 5000, encoding: 'utf8' },
      (_err, stdout) => resolve(stdout ? parseLoginPathOutput(stdout) : null)
    )
  })
}

/**
 * The user's login-shell PATH, captured once and cached for the app's lifetime
 * (it cannot change mid-run). Shared by EVERY spawn seam — the PTY sessions and
 * the `WORKTREE.md` `setup`/`create` commands — so the capture's `$SHELL -lic`
 * subprocess runs at most once per app run, no matter who asks first.
 */
let loginPathPromise: Promise<string | null> | null = null
export function loginPathOnce(): Promise<string | null> {
  if (!loginPathPromise) loginPathPromise = captureLoginPath()
  return loginPathPromise
}

/**
 * Build the environment for a spawned child: strip the AppImage pollution, then
 * fold the login-shell PATH ahead of what remains. This is the ONE composition
 * every spawn seam must use — {@link sanitizeSpawnEnv} and {@link mergeLoginPath}
 * are only ever correct together.
 *
 * BUG-27 was exactly the cost of them being applied separately: the PTY path
 * composed them by hand and worked, while `worktree-ipc` spawned `sh -c` with a
 * raw `process.env` and therefore had NO user toolchain on PATH — `npm ci` died
 * with `npm: not found` and the worktree create rolled back. This is not an
 * AppImage/Linux quirk: a GUI-launched app on macOS inherits launchd's minimal
 * PATH (no Homebrew, no mise/nvm/asdf shims) and fails identically.
 *
 * Pure: the caller supplies `loginPath` (from {@link loginPathOnce}), so this is
 * unit-testable and both seams provably agree. Degrades to the sanitized base
 * when the capture failed (`null`) — never worse than before.
 */
export function buildSpawnEnv(
  baseEnv: Record<string, string | undefined>,
  loginPath: string | null | undefined,
  opts: { execPath?: string } = {}
): Record<string, string> {
  const env = sanitizeSpawnEnv(baseEnv, opts)
  const merged = mergeLoginPath(env.PATH, loginPath)
  if (merged) env.PATH = merged
  return env
}

/**
 * Fold a captured login-shell PATH ahead of the current (sanitized) PATH,
 * de-duplicated and login-entries-first, so a spawned child sees the user's
 * real toolchain. No-op when `loginPath` is empty/unavailable — the current
 * PATH is returned unchanged (no regression outside an AppImage / on failure).
 */
export function mergeLoginPath(
  currentPath: string | undefined,
  loginPath: string | null | undefined
): string | undefined {
  if (!loginPath) return currentPath
  const seen = new Set<string>()
  const merged: string[] = []
  for (const seg of [...loginPath.split(':'), ...(currentPath?.split(':') ?? [])]) {
    if (seg === '' || seen.has(seg)) continue
    seen.add(seg)
    merged.push(seg)
  }
  return merged.length > 0 ? merged.join(':') : currentPath
}

/**
 * {@link buildSpawnEnv} bound to THIS process — the env any main-process
 * subprocess should be spawned with. Every seam that shells out to a tool the
 * user installed (`claude`, `npm`, `git`, `gh`, `du`) must use this, or it
 * resolves the binary against whatever PATH the app was launched with.
 *
 * BUG-34 was the cost of skipping it: the four `gh` seams (PR Stack, Review,
 * the Reaper scan, viewed-state) spawned bare `gh` with the inherited env, so
 * on a Dock-launched macOS build — launchd hands the app
 * `/usr/bin:/bin:/usr/sbin:/sbin`, with no `/opt/homebrew/bin` — every call
 * failed `ENOENT` and the UI reported "GitHub CLI is unavailable here" to
 * users whose `gh auth status` was perfectly healthy in their terminal.
 *
 * Cheap to call repeatedly: the login-shell capture behind it is memoized by
 * {@link loginPathOnce}, so only the (pure) composition is re-done.
 */
export function spawnEnvOnce(): Promise<Record<string, string>> {
  return loginPathOnce().then((loginPath) =>
    buildSpawnEnv(process.env as Record<string, string | undefined>, loginPath, {
      execPath: process.execPath
    })
  )
}
