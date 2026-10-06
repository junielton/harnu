import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { renderCoords } from '../../../scripts/ci/render-coords.mjs'
import surface from '../../../resources/companion/api-surface.json'
import type { WireEvent } from '../../../src/main/companion/contract'
import {
  rolloutView,
  setCompanionCliGate,
  setCompanionPrefsPath,
  setPrefsKey
} from '../../../src/main/companion/companion-prefs'
import {
  createEnablePolicy,
  registerP1FeaturePolicies,
  resetFeaturePoliciesForTests
} from '../../../src/main/companion/feature-policy'
import { createCompanionHost } from '../../../src/main/companion/host-core'
import { registerModsObserved, type ModsObserved } from '../../../src/main/companion/mods-observed'
import type { BindingView } from '../../../src/main/companion/session-table'
import { fakeMode, shortTmp } from '../../companion/support/host-rig'

/**
 * Helpers of the P4W1 part B real-CLI suite (`tests/cli/mods-live.cli.test.ts`). Hermetic like
 * `run-claude.ts`: a temp HOME and config dir, no inherited `CLAUDE_*`/`ANTHROPIC_*`/`HARNU_*`
 * variable, no credential read or copied, zero model turns (slash commands answered by mods).
 */

const REPO = resolve(import.meta.dirname, '..', '..', '..')
const COMPANION_SRC = join(REPO, 'resources', 'companion')

/** The environment of every `claude` this suite starts: nothing inherited but `PATH`. */
export function hermeticEnv(
  home: string,
  extra: Record<string, string> = {}
): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    HOME: home,
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    ...extra
  }
}

export function claudeCli(
  args: string[],
  env: Record<string, string>,
  cwd: string
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((res) => {
    execFile(
      'claude',
      args,
      { env, cwd, timeout: 60_000, maxBuffer: 1 << 22 },
      (err, stdout, stderr) => {
        const code = err
          ? typeof (err as { code?: unknown }).code === 'number'
            ? (err as { code: number }).code
            : 1
          : 0
        res({ code, stdout: String(stdout), stderr: String(stderr) })
      }
    )
  })
}

// ---- a world: temp HOME, cwd and a copy of the companion with generated coordinates -----------

export interface World {
  work: string
  home: string
  cwd: string
  companionDir: string
  debugFile: string
  cleanup(): Promise<void>
}

/** `transform` rewrites the copied `hooks/register.ts` (the baseline strips the sense.mods block). */
export async function stageWorld(opts: {
  rendezvous: string
  transform?: (registerSource: string) => string
}): Promise<World> {
  const work = await mkdtemp(join(tmpdir(), 'harnu-live-'))
  const home = join(work, 'home')
  const cwd = join(work, 'cwd')
  await mkdir(join(home, '.claude'), { recursive: true })
  await mkdir(cwd, { recursive: true })
  const companionDir = join(work, 'harnu-companion')
  const skip = ['.claude-plugin/types', 'hooks/coords.gen.ts', '.dev-lock']
  await cp(COMPANION_SRC, companionDir, {
    recursive: true,
    filter: (p) => !skip.some((x) => p.replace(/\\/g, '/').endsWith(`/${x}`))
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
  if (opts.transform) {
    const f = join(companionDir, 'hooks', 'register.ts')
    await writeFile(f, opts.transform(await readFile(f, 'utf8')))
  }
  return {
    work,
    home,
    cwd,
    companionDir,
    debugFile: join(work, 'debug.log'),
    cleanup: () => rm(work, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** The shipped hooks module without its `sense.mods` block: the baseline of AC-P4W1-16. */
export function stripSenseMods(source: string): string {
  const a = source.indexOf('// sense.mods:begin')
  const b = source.indexOf('// sense.mods:end')
  if (a < 0 || b < a) throw new Error('the sense.mods markers are missing from register.ts')
  return source.slice(0, a) + source.slice(b + '// sense.mods:end'.length)
}

// ---- small mods ------------------------------------------------------------------------------

/** A plain user mod: a command that answers with no model turn. No `plugin.register` hook. */
export async function writeMod(
  dir: string,
  name: string
): Promise<{ dir: string; source: string }> {
  await mkdir(join(dir, '.claude-plugin'), { recursive: true })
  await mkdir(join(dir, 'hooks'), { recursive: true })
  await writeFile(
    join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name, version: '0.1.0', description: 'test-only mod of the P4W1 suite' })
  )
  await writeFile(join(dir, 'hooks', 'hooks.json'), '{ "modules": ["./register.ts"] }\n')
  const source = join(dir, 'hooks', 'register.ts')
  await writeFile(
    source,
    `import type { Register } from 'claude-code'

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'ping-${name}', description: 'answers with no model turn' })
    return next(e)
  })
  on('command.run', { command: 'ping-${name}' }, async () => ({ text: 'pong-${name}' }))
}
`
  )
  return { dir, source }
}

// ---- a real host with the live observation wired ----------------------------------------------

export interface ModsHost {
  endpoint: string
  observed: ModsObserved
  seen: {
    events: { t: string; d: unknown; at: number; sid: string }[]
    hellos: { kind: string; sid: string; at: number }[]
  }
  mint(): string
  bindingForSid(sid: string): BindingView | null
  close(): Promise<void>
}

/**
 * The real host core and server, the real feature policies, the key `modsLive` turned ON in a
 * throwaway prefs file. The CLI gate of the module is `ok`: the installed `claude` may be above
 * the tested ceiling, and that cap is covered by its own unit test.
 */
export async function startModsHost(): Promise<ModsHost> {
  const prefsDir = shortTmp('hc-ml-p-')
  setCompanionPrefsPath(join(prefsDir, 'companion-prefs.json'))
  setCompanionCliGate('ok')
  resetFeaturePoliciesForTests()
  registerP1FeaturePolicies()
  const dir = join(shortTmp('hc-ml-'), 'companion')
  mkdirSync(dir, { recursive: true })
  const m = fakeMode('shadow')
  const host = createCompanionHost({
    dir,
    mode: m.mode,
    log: () => undefined,
    sessionKeyOf: (o) => (o.kind === 'pty' ? `row:${o.ptyId}` : null)
  })
  await host.register()
  host.facade.setEnablePolicy(
    createEnablePolicy({ rollout: rolloutView, ceiling: surface.lastVerifiedCli })
  )
  const observed = registerModsObserved({ host: host.facade })
  setPrefsKey('modsLive', true)
  const seen: ModsHost['seen'] = { events: [], hellos: [] }
  host.facade.bus.on('event', (b, ev: WireEvent) =>
    seen.events.push({ t: ev.t, d: ev.d, at: Date.now(), sid: b.sid })
  )
  host.facade.bus.on('hello', (b, kind) => seen.hellos.push({ kind, sid: b.sid, at: Date.now() }))
  return {
    endpoint: join(dir, 'endpoint.json'),
    observed,
    seen,
    mint() {
      const token = host.facade.mintSpawnToken({
        owner: { kind: 'pty', ptyId: 'pty-1' },
        trust: 'operator',
        cwd: '/tmp/example-project'
      })
      if (!token) throw new Error('no token minted: the listener is not up')
      return token
    },
    bindingForSid: (sid) => host.facade.bindingForSid(sid),
    async close() {
      observed.dispose()
      await host.close()
      setCompanionPrefsPath(null)
      rmSync(join(dir, '..'), { recursive: true, force: true })
      rmSync(prefsDir, { recursive: true, force: true })
    }
  }
}

// ---- a long-lived headless session ------------------------------------------------------------

export interface LiveSession {
  /** Sends one user message; resolves with the `result` event it produced. */
  send(
    text: string,
    timeoutMs?: number
  ): Promise<{ total_cost_usd?: number; num_turns?: number; result?: string }>
  /** Resolves when `pred` holds for the debug file, or rejects after `timeoutMs`. */
  waitDebug(pred: (debug: string) => boolean, timeoutMs: number): Promise<string>
  debug(): Promise<string>
  stop(): Promise<void>
}

/**
 * `claude -p --input-format stream-json`: one process, several zero-model turns. The watch flag
 * `CLAUDE_CODE_PLUGIN_DIR_WATCH=1` makes it reload a saved `--plugin-dir` folder, as a terminal
 * session does (plugin-authoring reference).
 */
export function startLiveSession(
  world: World,
  opts: {
    pluginDirs: string[]
    env?: Record<string, string>
  }
): LiveSession {
  const args = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose'
  ]
  for (const d of opts.pluginDirs) args.push('--plugin-dir', d)
  args.push('--debug-file', world.debugFile)
  const child: ChildProcessWithoutNullStreams = spawn('claude', args, {
    cwd: world.cwd,
    env: hermeticEnv(world.home, { CLAUDE_CODE_PLUGIN_DIR_WATCH: '1', ...opts.env }),
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let buffer = ''
  const waiting: ((r: Record<string, unknown>) => void)[] = []
  child.stdout.on('data', (d: Buffer) => {
    buffer += d.toString('utf8')
    let nl: number
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      try {
        const ev = JSON.parse(line) as Record<string, unknown>
        if (ev.type === 'result') waiting.shift()?.(ev)
      } catch {
        // not a JSON line: ignore
      }
    }
  })
  child.stderr.resume()
  const read = (): Promise<string> => readFile(world.debugFile, 'utf8').catch(() => '')
  return {
    send(text, timeoutMs = 20_000) {
      return new Promise((res, rej) => {
        const timer = setTimeout(
          () => rej(new Error(`no result for ${JSON.stringify(text)}`)),
          timeoutMs
        )
        waiting.push((ev) => {
          clearTimeout(timer)
          res(ev as never)
        })
        child.stdin.write(
          `${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`
        )
      })
    },
    async waitDebug(pred, timeoutMs) {
      const until = Date.now() + timeoutMs
      for (;;) {
        const d = await read()
        if (pred(d)) return d
        if (Date.now() > until) throw new Error('the debug file never showed the expected line')
        await new Promise((r) => setTimeout(r, 200))
      }
    },
    debug: read,
    async stop() {
      child.stdin.end()
      await new Promise<void>((res) => {
        const kill = setTimeout(() => child.kill('SIGKILL'), 4_000)
        child.on('close', () => {
          clearTimeout(kill)
          res()
        })
        if (child.exitCode !== null) res()
      })
    }
  }
}

// ---- reading the CLI's debug file -----------------------------------------------------------

export interface DebugLine {
  at: number
  text: string
}

export function debugLines(debug: string): DebugLine[] {
  const out: DebugLine[] = []
  for (const l of debug.split('\n')) {
    const m = /^(\d{4}-\d\d-\d\dT[\d:.]+Z) \[\w+\] (.*)$/.exec(l)
    if (m) out.push({ at: Date.parse(m[1]!), text: m[2]! })
  }
  return out
}

/** `plugin.register: <name> (<tier>, <provenance>), judged by …: admitted`, in the CLI's own order. */
export function admissionOrder(
  debug: string
): { name: string; tier: string; provenance: string }[] {
  const out: { name: string; tier: string; provenance: string }[] = []
  for (const l of debugLines(debug)) {
    const m = /^plugin\.register: (\S+) \((\w+), ([^)]+)\), judged by .*: admitted$/.exec(l.text)
    if (m) out.push({ name: m[1]!, tier: m[2]!, provenance: m[3]! })
  }
  return out
}

/** The provenance's source kind: what follows the `@` (`inline`, `skills-dir`, `builtin`, a marketplace). */
export const provenanceKind = (provenance: string): string => {
  const at = provenance.lastIndexOf('@')
  const tail = at < 0 ? provenance : provenance.slice(at + 1)
  return tail === 'inline' || tail === 'skills-dir' || tail === 'builtin' ? tail : 'installed'
}

export { mkdtempSync }
