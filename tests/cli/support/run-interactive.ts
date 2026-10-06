import { execFile, spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { renderCoords } from '../../../scripts/ci/render-coords.mjs'

const run = promisify(execFile)

/**
 * Hermetic launcher for an INTERACTIVE `claude` in tmux (T389 P4W3 L4 and live-verify): a temp
 * HOME, a temp CLAUDE_CONFIG_DIR, a temp cwd, a temp copy of the companion, a seeded
 * `.claude.json` that skips the onboarding and accepts the temp folder's trust, `--debug-file`,
 * and a stripped environment (`env -i`). No credential is ever copied in: the session starts
 * "Not logged in", which is enough for `session.start` to fire and for a mod to say hello.
 *
 * SAFETY (P4W3 writes a user's Claude settings): `assertThrowaway` aborts before anything is
 * written when a resolved settings path is under the real home's `.claude`.
 */

const REPO = resolve(import.meta.dirname, '..', '..', '..')
const COMPANION_SRC = join(REPO, 'resources', 'companion')
const EXCLUDE = ['.claude-plugin/types', 'hooks/coords.gen.ts', '.dev-lock']
const filter = (src: string) => (p: string) =>
  !EXCLUDE.some((x) => p.replace(/\\/g, '/').endsWith(`/${x}`) || p === join(src, x))

/** Throws when `path` is the operator's real Claude configuration. Called before every write. */
export function assertThrowaway(path: string): void {
  const real = join(homedir(), '.claude')
  const realJson = join(homedir(), '.claude.json')
  const abs = resolve(path)
  if (abs === realJson || abs === real || abs.startsWith(real + '/')) {
    throw new Error(`refusing to touch the real Claude configuration: ${abs}`)
  }
}

export async function hasTmux(): Promise<boolean> {
  try {
    await run('tmux', ['-V'])
    return true
  } catch {
    return false
  }
}

export interface InteractiveOptions {
  /** Absolute rendezvous path baked into the companion's coordinates. */
  rendezvous: string
  /** `env.CLAUDE_CODE_PLUGIN_DIRS` of the temp settings.json: the companion copy is added. */
  viaSettingsEnv?: boolean
  /** Also name the companion with `--plugin-dir` (a Harnu-spawned session). */
  viaFlag?: boolean
  /** Extra process env (e.g. `HARNU_SPAWN_TOKEN`). `CLAUDE*`, `ANTHROPIC_*`, `HARNU_*` are never inherited. */
  env?: Record<string, string>
  /** The PATH to find `claude` on; default: the current PATH. */
  claudePath?: string
  /** Other `settings.json` content merged under `env`. */
  settings?: Record<string, unknown>
  /** Runs after the temp dirs exist and before `claude` starts. */
  prepare?(ctx: InteractiveCtx): Promise<void>
  /**
   * A second session in the SAME temp HOME as an earlier one (`Interactive.work`, stopped with
   * `stop({ keep: true })`): nothing is re-created or re-written, the settings are whatever the
   * first session's life left behind.
   */
  reuseWork?: string
}

export interface InteractiveCtx {
  work: string
  home: string
  configDir: string
  settingsPath: string
  cwd: string
  companionDir: string
}

export interface Interactive extends InteractiveCtx {
  debugFile: string
  session: string
  debug(): Promise<string>
  pane(): Promise<string>
  /** Resolves when `re` shows in the debug file; rejects after `ms`. */
  waitDebug(re: RegExp, ms?: number): Promise<string>
  waitPane(re: RegExp, ms?: number): Promise<string>
  type(text: string): Promise<void>
  press(key: string): Promise<void>
  stop(opts?: { keep?: boolean }): Promise<void>
}

let counter = 0
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export async function startInteractive(opts: InteractiveOptions): Promise<Interactive> {
  const work = opts.reuseWork ?? (await mkdtemp(join(tmpdir(), 'harnu-lv-')))
  const home = join(work, 'home')
  const configDir = join(home, '.claude')
  const cwd = join(work, 'cwd')
  const settingsPath = join(configDir, 'settings.json')
  const companionDir = join(work, 'harnu-companion')
  for (const p of [home, configDir, settingsPath, cwd, companionDir]) assertThrowaway(p)
  if (!opts.reuseWork) {
    await mkdir(configDir, { recursive: true })
    await mkdir(cwd, { recursive: true })
    await cp(COMPANION_SRC, companionDir, { recursive: true, filter: filter(COMPANION_SRC) })
    await writeFile(
      join(companionDir, 'hooks', 'coords.gen.ts'),
      renderCoords({
        RENDEZVOUS_PATH: opts.rendezvous,
        MOD_VERSION: JSON.parse(
          await readFile(join(companionDir, '.claude-plugin', 'plugin.json'), 'utf8')
        ).version,
        STAGED_AT: 0
      })
    )
    const settings: Record<string, unknown> = { ...(opts.settings ?? {}) }
    if (opts.viaSettingsEnv) {
      settings.env = {
        ...((settings.env as Record<string, string> | undefined) ?? {}),
        CLAUDE_CODE_PLUGIN_DIRS: companionDir
      }
    }
    if (Object.keys(settings).length > 0) {
      await writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n')
    }
    // Skip the onboarding and accept the trust of the temp folder (a fresh HOME stops at both).
    await writeFile(
      join(configDir, '.claude.json'),
      JSON.stringify({
        hasCompletedOnboarding: true,
        theme: 'dark',
        numStartups: 5,
        projects: { [cwd]: { hasTrustDialogAccepted: true, allowedTools: [] } }
      })
    )
  }
  const ctx: InteractiveCtx = { work, home, configDir, settingsPath, cwd, companionDir }
  if (opts.prepare) await opts.prepare(ctx)

  const debugFile = join(work, opts.reuseWork ? `debug-${++counter}.log` : 'debug.log')
  const session = `harnu-lv-${process.pid}-${++counter}`
  const envPairs: Record<string, string> = {
    PATH: opts.claudePath ?? process.env.PATH ?? '',
    HOME: home,
    CLAUDE_CONFIG_DIR: configDir,
    TERM: 'xterm-256color',
    DISABLE_AUTOUPDATER: '1',
    ...opts.env
  }
  const args = ['--debug-file', debugFile]
  if (opts.viaFlag) args.push('--plugin-dir', companionDir)
  const cmd = [
    'env -i',
    ...Object.entries(envPairs).map(([k, v]) => `${k}='${v.replace(/'/g, `'\\''`)}'`),
    'claude',
    ...args.map((a) => `'${a}'`)
  ].join(' ')
  // The window is wide enough that a path is never wrapped inside an assertion.
  await run('tmux', ['new-session', '-d', '-s', session, '-x', '200', '-y', '50', '-c', cwd, cmd])

  const debug = (): Promise<string> => readFile(debugFile, 'utf8').catch(() => '')
  const pane = async (): Promise<string> =>
    (await run('tmux', ['capture-pane', '-t', session, '-p'])).stdout
  const waitFor = async (get: () => Promise<string>, re: RegExp, ms: number): Promise<string> => {
    const end = Date.now() + ms
    for (;;) {
      const text = await get()
      if (re.test(text)) return text
      if (Date.now() > end)
        throw new Error(`timed out waiting for ${re}\n--- tail ---\n${text.slice(-1500)}`)
      await sleep(150)
    }
  }
  return {
    ...ctx,
    debugFile,
    session,
    debug,
    pane,
    waitDebug: (re, ms = 20_000) => waitFor(debug, re, ms),
    waitPane: (re, ms = 20_000) => waitFor(pane, re, ms),
    async type(text) {
      await run('tmux', ['send-keys', '-t', session, '-l', text])
    },
    async press(key) {
      await run('tmux', ['send-keys', '-t', session, key])
    },
    async stop(stopOpts) {
      await run('tmux', ['kill-session', '-t', session]).catch(() => undefined)
      if (!stopOpts?.keep) await rm(work, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

/** `claude --version` of the PATH the suite uses. */
export function claudeVersionOn(path: string): Promise<string> {
  return new Promise((res) => {
    const c = spawn('claude', ['--version'], {
      env: { PATH: path },
      stdio: ['ignore', 'pipe', 'ignore']
    })
    let out = ''
    c.stdout.on('data', (d: Buffer) => (out += d))
    c.on('error', () => res('unavailable'))
    c.on('close', () => res(out.trim() || 'unavailable'))
  })
}
