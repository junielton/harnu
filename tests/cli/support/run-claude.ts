import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { renderCoords } from '../../../scripts/ci/render-coords.mjs'

/**
 * Hermetic launcher for the real-CLI suites (P1W2 §7.9, QA-8): temp HOME, temp
 * CLAUDE_CONFIG_DIR, temp cwd, temp copies of the plugins, `--debug-file`, stdin from /dev/null
 * and a 20 s wall cap. Nothing under the developer's own HOME is read or written, and no
 * credential is ever copied in: with no credentials a model request cannot succeed, and the
 * run's JSON result must say `num_turns: 0` anyway.
 */

const REPO = resolve(import.meta.dirname, '..', '..', '..')
const COMPANION_SRC = join(REPO, 'resources', 'companion')
const PROBE_SRC = join(REPO, 'tests', 'cli', 'fixtures', 'probe-mod')

export const WITH_CLI = Boolean(process.env.HARNU_WITH_CLI)

export type PluginKey = 'companion' | 'probe'

export interface RunOptions {
  /** The prompt; `/harnu-probe` by default (answered by the probe with no model turn). */
  prompt?: string
  /** `--plugin-dir` order. Default: the companion first, then the probe. */
  order?: PluginKey[]
  /** Tick-shaped argv: `--setting-sources ''`, `--strict-mcp-config`, `--no-session-persistence`. */
  tick?: boolean
  extraArgs?: string[]
  env?: Record<string, string>
  /** Absolute rendezvous path baked into the companion's coordinates. */
  rendezvous?: string
  timeoutMs?: number
  /** Runs after the temp HOME, config dir and cwd exist and before `claude` starts (P1W3). */
  prepare?(ctx: { work: string; home: string; configDir: string; cwd: string }): Promise<void>
}

export interface ProbeReport {
  sessionId: string
  pluginsRegisteredAfterProbe: string[]
  tokenReadable: boolean
}

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
  /** The CLI's `--debug-file` contents. */
  debug: string
  json: { num_turns?: number; total_cost_usd?: number; result?: string } | null
  probe: ProbeReport | null
  claudeVersion: string
  work: string
  companionDir: string
  cleanup(): Promise<void>
}

const EXCLUDE = ['.claude-plugin/types', 'hooks/coords.gen.ts', '.dev-lock']

function copyFilter(src: string): (p: string) => boolean {
  return (p) => !EXCLUDE.some((x) => p.replace(/\\/g, '/').endsWith(`/${x}`) || p === join(src, x))
}

export async function claudeVersion(): Promise<string> {
  return new Promise((res) => {
    const c = spawn('claude', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    c.stdout.on('data', (d: Buffer) => (out += d))
    c.on('error', () => res('unavailable'))
    c.on('close', () => res(out.trim() || 'unavailable'))
  })
}

/** Fails the test when the companion did not load cleanly; carries the debug file on failure. */
export function assertCleanLoad(debug: string): void {
  const bad = debug
    .split('\n')
    .filter((l) => /hook skipped|did not load/i.test(l) && /harnu-companion/.test(l))
  if (bad.length > 0) {
    throw new Error(
      `the companion did not load cleanly:\n${bad.join('\n')}\n--- debug file ---\n${debug}`
    )
  }
}

export async function runClaude(opts: RunOptions = {}): Promise<RunResult> {
  const work = await mkdtemp(join(tmpdir(), 'harnu-cli-'))
  const home = join(work, 'home')
  const cwd = join(work, 'cwd')
  await mkdir(home, { recursive: true })
  await mkdir(cwd, { recursive: true })

  if (opts.prepare) {
    await opts.prepare({ work, home, configDir: join(home, '.claude'), cwd })
  }

  const companionDir = join(work, 'harnu-companion')
  await cp(COMPANION_SRC, companionDir, { recursive: true, filter: copyFilter(COMPANION_SRC) })
  await writeFile(
    join(companionDir, 'hooks', 'coords.gen.ts'),
    renderCoords({
      RENDEZVOUS_PATH: opts.rendezvous ?? join(work, 'endpoint.json'),
      MOD_VERSION: JSON.parse(
        await readFile(join(companionDir, '.claude-plugin', 'plugin.json'), 'utf8')
      ).version,
      STAGED_AT: 0
    })
  )
  const probeDir = join(work, 'harnu-probe')
  await cp(PROBE_SRC, probeDir, { recursive: true, filter: copyFilter(PROBE_SRC) })

  const dirs: Record<PluginKey, string> = { companion: companionDir, probe: probeDir }
  const debugFile = join(work, 'debug.log')
  const args = ['-p']
  if (opts.tick)
    args.push('--setting-sources', '', '--strict-mcp-config', '--no-session-persistence')
  for (const k of opts.order ?? ['companion', 'probe']) args.push('--plugin-dir', dirs[k])
  args.push('--output-format', 'json', '--debug-file', debugFile, ...(opts.extraArgs ?? []))
  args.push('--', opts.prompt ?? '/harnu-probe')

  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith('HARNU_') && !k.startsWith('ANTHROPIC_')) env[k] = v
  }
  Object.assign(env, { HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), ...opts.env })

  const { code, stdout, stderr } = await new Promise<{
    code: number | null
    stdout: string
    stderr: string
  }>((res) => {
    const child = spawn('claude', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (d: Buffer) => (out += d))
    child.stderr.on('data', (d: Buffer) => (err += d))
    const cap = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 20_000)
    child.on('close', (c) => {
      clearTimeout(cap)
      res({ code: c, stdout: out, stderr: err })
    })
    child.on('error', (e) => {
      clearTimeout(cap)
      res({ code: null, stdout: out, stderr: `${err}${e.message}` })
    })
  })

  const debug = await readFile(debugFile, 'utf8').catch(() => '')
  let json: RunResult['json'] = null
  try {
    json = JSON.parse(stdout.trim().split('\n').pop() ?? '')
  } catch {
    json = null
  }
  let probe: ProbeReport | null = null
  const m = /harnu-probe: (\{.*\})/s.exec(json?.result ?? '')
  if (m) {
    try {
      probe = JSON.parse(m[1]) as ProbeReport
    } catch {
      probe = null
    }
  }

  return {
    code,
    stdout,
    stderr,
    debug,
    json,
    probe,
    claudeVersion: await claudeVersion(),
    work,
    companionDir,
    cleanup: () => rm(work, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * OQ-5: a run that needed a sign-in before `session.start` is `blocked-by-auth`, a FAILURE under
 * `--with-cli`, never a skip. No credential file is ever copied by this harness; the zero-model
 * driver needs none (verified on claude 2.1.289 with an empty HOME).
 */
export function assertNotBlockedByAuth(r: RunResult): void {
  if (
    r.probe === null &&
    /not logged in|please run \/login|invalid api key|authenticat/i.test(`${r.stdout}\n${r.stderr}`)
  ) {
    throw new Error(`blocked-by-auth: the run needed a sign-in\n${r.stdout}\n${r.stderr}`)
  }
}

export const COMPANION_LOADED =
  /hooks module harnu-companion@inline loaded \(worker, [^)]*tier user\)/
