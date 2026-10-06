import { createRequire } from 'node:module'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { renderCoords } from '../../../scripts/ci/render-coords.mjs'

/**
 * A real interactive `claude` on a pseudo-terminal, hermetic like `runClaude` (P2W1 §7.9, QA-8):
 * temp HOME and CLAUDE_CONFIG_DIR, a temp cwd that is already trusted, onboarding marked done, a
 * temp copy of the companion, `CLAUDE*`/`HARNU_*`/`ANTHROPIC_*` stripped from the environment,
 * `--debug-file`. No credential is copied in: the session needs no sign-in to load its mods, poll,
 * `/clear` or reload, which is everything the channel's L4 asks of it. A model turn cannot run.
 *
 * Interactive is the one profile that polls; `claude -p` never does (contract §16).
 */

const REPO = resolve(import.meta.dirname, '..', '..', '..')
const COMPANION_SRC = join(REPO, 'resources', 'companion')
const requireHere = createRequire(import.meta.url)

interface Pty {
  onData(cb: (d: string) => void): void
  onExit(cb: (e: { exitCode: number }) => void): void
  write(data: string): void
  kill(signal?: string): void
  pid: number
}

export interface InteractiveOptions {
  /** Absolute rendezvous path baked into the companion's coordinates. */
  rendezvous: string
  spawnToken: string
  cols?: number
  rows?: number
}

export interface Interactive {
  pid: number
  work: string
  companionDir: string
  /** The terminal's text so far, escape sequences stripped. */
  screen(): string
  /** The CLI's `--debug-file`. */
  debug(): Promise<string>
  type(text: string): void
  /** Appends a comment to the mod's source: the plugin-dir watch reloads it. */
  touchMod(): Promise<void>
  /** Resolves when `test` is true, polling; rejects with the screen and the debug on timeout. */
  until(what: string, test: () => boolean | Promise<boolean>, timeoutMs?: number): Promise<void>
  stop(): Promise<void>
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g

export async function startInteractive(opts: InteractiveOptions): Promise<Interactive> {
  const pty = requireHere('node-pty') as {
    spawn(
      file: string,
      args: string[],
      o: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }
    ): Pty
  }
  const work = await mkdtemp(join(tmpdir(), 'harnu-ix-'))
  const home = join(work, 'home')
  const cwd = join(work, 'cwd')
  await mkdir(join(home, '.claude'), { recursive: true })
  await mkdir(cwd, { recursive: true })
  await writeFile(
    join(home, '.claude', '.claude.json'),
    JSON.stringify({
      hasCompletedOnboarding: true,
      theme: 'dark',
      numStartups: 5,
      projects: { [cwd]: { hasTrustDialogAccepted: true, allowedTools: [] } }
    })
  )
  const companionDir = join(work, 'harnu-companion')
  await cp(COMPANION_SRC, companionDir, {
    recursive: true,
    filter: (p) =>
      !p.replace(/\\/g, '/').includes('.claude-plugin/types') && !p.endsWith('coords.gen.ts')
  })
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
  const debugFile = join(work, 'debug.log')

  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (
      v !== undefined &&
      !k.startsWith('HARNU_') &&
      !k.startsWith('ANTHROPIC_') &&
      !k.startsWith('CLAUDE')
    ) {
      env[k] = v
    }
  }
  Object.assign(env, {
    HOME: home,
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    HARNU_SPAWN_TOKEN: opts.spawnToken,
    TERM: 'xterm-256color'
  })

  const term = pty.spawn('claude', ['--plugin-dir', companionDir, '--debug-file', debugFile], {
    name: 'xterm-256color',
    cols: opts.cols ?? 160,
    rows: opts.rows ?? 50,
    cwd,
    env
  })
  let raw = ''
  let exited = false
  term.onData((d) => (raw += d))
  term.onExit(() => (exited = true))
  const readDebug = (): Promise<string> => readFile(debugFile, 'utf8').catch(() => '')

  const self: Interactive = {
    pid: term.pid,
    work,
    companionDir,
    screen: () => raw.replace(ANSI, ''),
    debug: readDebug,
    type: (text) => term.write(text),
    async touchMod() {
      const file = join(companionDir, 'hooks', 'register.ts')
      await writeFile(file, `${await readFile(file, 'utf8')}\n// touched ${Date.now()}\n`)
    },
    async until(what, test, timeoutMs = 20_000) {
      const end = Date.now() + timeoutMs
      while (Date.now() < end) {
        if (await test()) return
        if (exited) break
        await new Promise((r) => setTimeout(r, 100))
      }
      throw new Error(
        `timed out waiting for ${what}\n--- screen ---\n${self.screen().slice(-1500)}\n--- debug ---\n${(await readDebug()).split('\n').slice(-40).join('\n')}`
      )
    },
    async stop() {
      // Only the process this call started, by its recorded pid.
      if (!exited) term.kill()
      await new Promise((r) => setTimeout(r, 300))
      await rm(work, { recursive: true, force: true }).catch(() => undefined)
    }
  }
  return self
}
