import { describe, it, expect } from 'vitest'
import {
  sanitizeSpawnEnv,
  mergeLoginPath,
  parseLoginPathOutput,
  buildSpawnEnv
} from '../src/main/appimage-env'

/**
 * When Harnu runs as an AppImage, its own `process.env` is polluted by the
 * AppImage runtime: `PATH`/`LD_LIBRARY_PATH`/`XDG_DATA_DIRS`/… are prefixed
 * with the squashfs mount (`$APPDIR`, e.g. `/tmp/.mount_Claudexxxx`), and
 * marker vars `APPDIR`/`APPIMAGE`/`ARGV0`/`OWD` are set. Spreading that into a
 * spawned shell (Harnu is a terminal manager!) breaks the user's tooling —
 * mise reports the `APPIMAGE` path as "not a valid shim", and system binaries
 * can load the bundled glibc via the leaked `LD_LIBRARY_PATH`.
 *
 * `sanitizeSpawnEnv` strips the mount-rooted entries and the marker vars so the
 * child gets a clean environment, as if launched from a normal terminal.
 */
const MOUNT = '/tmp/.mount_Claude4yRRnG'

function appImageEnv(over: Record<string, string | undefined> = {}): Record<string, string> {
  return {
    APPDIR: MOUNT,
    APPIMAGE: '/home/u/Applications/Harnu-1.0.0_0daa2242.AppImage',
    ARGV0: '/home/u/Applications/Harnu-1.0.0_0daa2242.AppImage',
    OWD: '/home/u',
    PATH: `${MOUNT}:${MOUNT}/usr/sbin:/usr/local/bin:/usr/bin:/bin`,
    LD_LIBRARY_PATH: `${MOUNT}/usr/lib:`,
    XDG_DATA_DIRS: `${MOUNT}/usr/share/:/usr/share:/usr/local/share`,
    HOME: '/home/u',
    SHELL: '/usr/bin/zsh',
    ...over
  } as Record<string, string>
}

describe('sanitizeSpawnEnv — non-AppImage passthrough', () => {
  it('returns the env unchanged when APPDIR is absent (dev / .deb / normal)', () => {
    const clean = { PATH: '/usr/bin:/bin', HOME: '/home/u', SHELL: '/usr/bin/zsh' }
    expect(sanitizeSpawnEnv(clean)).toEqual(clean)
  })
})

describe('sanitizeSpawnEnv — AppImage cleanup', () => {
  it('deletes the AppImage marker vars', () => {
    const out = sanitizeSpawnEnv(appImageEnv())
    expect(out.APPDIR).toBeUndefined()
    expect(out.APPIMAGE).toBeUndefined()
    expect(out.ARGV0).toBeUndefined()
    expect(out.OWD).toBeUndefined()
  })

  it('strips mount-rooted entries from PATH, keeping the system entries', () => {
    const out = sanitizeSpawnEnv(appImageEnv())
    expect(out.PATH).toBe('/usr/local/bin:/usr/bin:/bin')
  })

  it('deletes LD_LIBRARY_PATH entirely when it was only the mount (+ empty CWD entry)', () => {
    const out = sanitizeSpawnEnv(appImageEnv())
    expect('LD_LIBRARY_PATH' in out).toBe(false)
  })

  it('strips the mount entry from XDG_DATA_DIRS, keeping the rest', () => {
    const out = sanitizeSpawnEnv(appImageEnv())
    expect(out.XDG_DATA_DIRS).toBe('/usr/share:/usr/local/share')
  })

  it('leaves vars that do not reference the mount untouched', () => {
    const out = sanitizeSpawnEnv(appImageEnv())
    expect(out.HOME).toBe('/home/u')
    expect(out.SHELL).toBe('/usr/bin/zsh')
  })

  it('preserves a real LD_LIBRARY_PATH entry that lives outside the mount', () => {
    const out = sanitizeSpawnEnv(
      appImageEnv({ LD_LIBRARY_PATH: `${MOUNT}/usr/lib:/opt/cuda/lib64` })
    )
    expect(out.LD_LIBRARY_PATH).toBe('/opt/cuda/lib64')
  })
})

/**
 * BUG-30. Under AppImageLauncher, `APPDIR` points at the launcher's own dir
 * (`/opt/appimagelauncher.AppDir`), not the squashfs mount — captured live
 * while verifying the BUG-27 fix. `sanitizeSpawnEnv` used to trust `APPDIR` as
 * the mount unconditionally, so no PATH segment matched it and nothing was
 * stripped: the function silently no-op'd exactly where it was supposed to
 * work. This fixture reproduces that env exactly; it must fail against the
 * pre-fix implementation (no `execPath`/PATH-scan mount detection) and pass
 * against the fix.
 */
const REAL_MOUNT = '/tmp/.mount_Harnu-0lrvEDd'

function appImageLauncherEnv(
  over: Record<string, string | undefined> = {}
): Record<string, string> {
  return {
    APPDIR: '/opt/appimagelauncher.AppDir',
    PATH: `${REAL_MOUNT}:${REAL_MOUNT}/usr/sbin:/usr/local/bin:/usr/bin:/bin`,
    LD_LIBRARY_PATH: `${REAL_MOUNT}/usr/lib:/opt/cuda/lib64`,
    HOME: '/home/u',
    SHELL: '/usr/bin/zsh',
    ...over
  } as Record<string, string>
}

describe('sanitizeSpawnEnv — AppImageLauncher (BUG-30: APPDIR ≠ mount)', () => {
  it('strips the real mount from PATH even though APPDIR points elsewhere', () => {
    const out = sanitizeSpawnEnv(appImageLauncherEnv())
    expect(out.PATH).toBe('/usr/local/bin:/usr/bin:/bin')
  })

  it('also strips a foreign APPDIR (belt-and-suspenders)', () => {
    const out = sanitizeSpawnEnv(
      appImageLauncherEnv({
        PATH: `/opt/appimagelauncher.AppDir/bin:${REAL_MOUNT}:/usr/bin`
      })
    )
    expect(out.PATH).toBe('/usr/bin')
    expect(out.APPDIR).toBeUndefined()
  })

  it('strips a mount-rooted LD_LIBRARY_PATH, keeping a real out-of-mount entry', () => {
    const out = sanitizeSpawnEnv(appImageLauncherEnv())
    expect(out.LD_LIBRARY_PATH).toBe('/opt/cuda/lib64')
  })

  it('detects the mount from process.execPath alone when no colon-list references it', () => {
    const env = appImageLauncherEnv({
      PATH: '/usr/local/bin:/usr/bin:/bin',
      LD_LIBRARY_PATH: undefined,
      // Mount-rooted pollution living in a var the detector doesn't scan for
      // new mounts, so this only strips if `execPath` alone found the mount.
      XDG_DATA_DIRS: `${REAL_MOUNT}/usr/share:/usr/share`
    })
    const out = sanitizeSpawnEnv(env, { execPath: `${REAL_MOUNT}/usr/bin/harnu` })
    expect(out.XDG_DATA_DIRS).toBe('/usr/share')
  })

  it('is boundary-aware: a sibling mount name is not chewed by a shorter detected prefix', () => {
    const env = appImageLauncherEnv({
      PATH: '/usr/local/bin:/usr/bin:/bin',
      LD_LIBRARY_PATH: undefined,
      // Not scanned for new-mount detection, so this segment is only at risk
      // from a boundary-blind `startsWith` on the execPath-detected prefix.
      XDG_DATA_DIRS: `${REAL_MOUNT}XX/usr/share:/usr/share`
    })
    const out = sanitizeSpawnEnv(env, { execPath: `${REAL_MOUNT}/usr/bin/harnu` })
    expect(out.XDG_DATA_DIRS).toBe(`${REAL_MOUNT}XX/usr/share:/usr/share`)
  })
})

/**
 * Stripping the AppImage pollution is necessary but not sufficient: a
 * GUI-launched AppImage never sourced the user's interactive shell config
 * (`.zshrc`/`mise activate`), so the inherited PATH lacks the user's real
 * toolchain — `node` (mise shims) and `rtk` (`~/.local/bin`). Spawned `claude`
 * sessions then fail their `command` hooks with `node: not found` /
 * `rtk: not found`. `mergeLoginPath` folds the captured login-shell PATH ahead
 * of the sanitized base so children see the same PATH a terminal launch gives.
 */
describe('mergeLoginPath — restore the login-shell PATH for spawned children', () => {
  it('returns the current PATH unchanged when there is no login PATH', () => {
    expect(mergeLoginPath('/usr/bin:/bin', null)).toBe('/usr/bin:/bin')
    expect(mergeLoginPath('/usr/bin:/bin', undefined)).toBe('/usr/bin:/bin')
    expect(mergeLoginPath('/usr/bin:/bin', '')).toBe('/usr/bin:/bin')
  })

  it('prepends login entries (mise/node, ~/.local/bin) ahead of the sanitized base', () => {
    const base = '/home/u/.cargo/bin:/usr/local/bin:/usr/bin:/bin'
    const login = '/home/u/.local/share/mise/installs/node/22/bin:/home/u/.local/bin:/usr/bin:/bin'
    expect(mergeLoginPath(base, login)).toBe(
      '/home/u/.local/share/mise/installs/node/22/bin:/home/u/.local/bin:/usr/bin:/bin:/home/u/.cargo/bin:/usr/local/bin'
    )
  })

  it('dedups entries present in both, keeping the login-first occurrence', () => {
    expect(mergeLoginPath('/usr/bin:/bin', '/opt/x:/usr/bin')).toBe('/opt/x:/usr/bin:/bin')
  })

  it('drops empty segments', () => {
    expect(mergeLoginPath('/usr/bin:', ':/opt/x:')).toBe('/opt/x:/usr/bin')
  })

  it('uses the login PATH when the base is undefined', () => {
    expect(mergeLoginPath(undefined, '/opt/x:/usr/bin')).toBe('/opt/x:/usr/bin')
  })
})

describe('parseLoginPathOutput — extract PATH from login-shell stdout', () => {
  it('extracts the PATH between markers, ignoring rc-file noise', () => {
    const out = 'some rc noise\n__OM2TAB_PATH_BEGIN__/opt/x:/usr/bin__OM2TAB_PATH_END__'
    expect(parseLoginPathOutput(out)).toBe('/opt/x:/usr/bin')
  })

  it('returns null when markers are absent (capture failed / shell error)', () => {
    expect(parseLoginPathOutput('zsh: command not found\n')).toBeNull()
  })

  it('returns null on an empty PATH between markers', () => {
    expect(parseLoginPathOutput('__OM2TAB_PATH_BEGIN____OM2TAB_PATH_END__')).toBeNull()
  })
})

/**
 * BUG-27. `sanitizeSpawnEnv` + `mergeLoginPath` were wired into the PTY path
 * only, so `WORKTREE.md` `setup:` commands (run via `sh -c` in `worktree-ipc`)
 * inherited the raw Electron env: no mise/nvm/Homebrew node, and — inside an
 * AppImage — a mount-rooted `LD_LIBRARY_PATH`. `npm ci` therefore died with
 * `sh: 1: npm: not found` and the create rolled back. `buildSpawnEnv` is the one
 * composition BOTH spawn seams share, so a child can never again be handed the
 * unsanitized env by omission.
 */
describe('buildSpawnEnv — the env every spawned child gets (BUG-27)', () => {
  const LOGIN = '/home/u/.local/share/mise/installs/node/22/bin:/home/u/.local/bin:/usr/bin:/bin'

  it('makes the user toolchain (mise node) reachable from an AppImage env', () => {
    const env = buildSpawnEnv(appImageEnv(), LOGIN)
    expect(env.PATH.split(':')).toContain('/home/u/.local/share/mise/installs/node/22/bin')
  })

  it('puts the login entries FIRST — the user toolchain wins over a system node', () => {
    const env = buildSpawnEnv(appImageEnv(), LOGIN)
    expect(env.PATH.startsWith('/home/u/.local/share/mise/installs/node/22/bin:')).toBe(true)
  })

  it('still strips the AppImage pollution (markers + mount-rooted vars)', () => {
    const env = buildSpawnEnv(appImageEnv(), LOGIN)
    expect(env.APPDIR).toBeUndefined()
    expect('LD_LIBRARY_PATH' in env).toBe(false)
    expect(env.PATH.includes(MOUNT)).toBe(false)
  })

  it('leaves PATH on the sanitized base when the capture failed (no regression)', () => {
    const env = buildSpawnEnv(appImageEnv(), null)
    expect(env.PATH).toBe('/usr/local/bin:/usr/bin:/bin')
  })

  it('is a pure passthrough outside an AppImage with no login PATH (dev / .deb)', () => {
    const clean = { PATH: '/usr/bin:/bin', HOME: '/home/u' }
    expect(buildSpawnEnv(clean, null)).toEqual(clean)
  })

  it('threads execPath through to detect an AppImageLauncher mount (BUG-30)', () => {
    const env = buildSpawnEnv(
      {
        APPDIR: '/opt/appimagelauncher.AppDir',
        PATH: `${MOUNT}:${MOUNT}/usr/sbin:/usr/local/bin:/usr/bin:/bin`,
        HOME: '/home/u'
      },
      null,
      { execPath: `${MOUNT}/usr/bin/harnu` }
    )
    expect(env.PATH).toBe('/usr/local/bin:/usr/bin:/bin')
    expect(env.APPDIR).toBeUndefined()
  })
})

/**
 * BUG-34 — the same omission as BUG-27, one platform over. The four `gh` seams
 * (PR Stack, Review, the Reaper scan, viewed-state) spawned bare `gh` with the
 * inherited env. On macOS an app opened from the Dock/Finder inherits launchd's
 * minimal PATH, which has no `/opt/homebrew/bin`, so every call failed ENOENT
 * and the UI reported "GitHub CLI is unavailable here" to users whose `gh` was
 * installed and authenticated. Nothing is stripped here (there is no AppImage
 * mount to strip) — the whole fix is the login PATH being folded in at all.
 */
describe('buildSpawnEnv — Dock-launched macOS (BUG-34)', () => {
  /** What launchd hands a GUI-launched app: no Homebrew, no mise/nvm/asdf. */
  const LAUNCHD = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: '/Users/u' }
  const LOGIN = '/opt/homebrew/bin:/opt/homebrew/sbin:/usr/bin:/bin:/usr/sbin:/sbin'

  it('makes Homebrew `gh` reachable from the launchd-minimal PATH', () => {
    const env = buildSpawnEnv(LAUNCHD, LOGIN)
    expect(env.PATH.split(':')).toContain('/opt/homebrew/bin')
  })

  it('puts Homebrew FIRST, so a brew tool wins over a system one', () => {
    const env = buildSpawnEnv(LAUNCHD, LOGIN)
    expect(env.PATH.startsWith('/opt/homebrew/bin:')).toBe(true)
  })

  it('keeps the system entries — folding in never drops what launchd gave', () => {
    const env = buildSpawnEnv(LAUNCHD, LOGIN)
    for (const seg of LAUNCHD.PATH.split(':')) expect(env.PATH.split(':')).toContain(seg)
  })

  it('leaves the launchd PATH untouched when the capture failed', () => {
    expect(buildSpawnEnv(LAUNCHD, null)).toEqual(LAUNCHD)
  })
})
