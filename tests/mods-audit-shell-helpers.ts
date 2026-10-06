/**
 * Shared harness for the Mods audit shell tests: real temp directories, a fake
 * `claude` runner that serves checked-in validate fixtures, and an inspectable call log.
 */
import { promises as fs } from 'node:fs'
import { readFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { vi } from 'vitest'
import type { CliResult, ModsAuditDeps } from '../src/main/mods-audit'
import type { ModRow } from '../src/main/mods-audit-core'

export function fixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'mods-audit', name), 'utf8'))
}

export const ok = (stdout: string, code = 0): CliResult => ({
  stdout,
  stderr: '',
  code,
  timedOut: false,
  spawnError: false
})

export interface Env {
  home: string
  cachePath: string
  /** Create `<home>/.claude/skills/<name>/` as a plugin with one source file. */
  addSkillsDirMod: (name: string, source?: string) => Promise<string>
  cleanup: () => Promise<void>
}

export async function makeEnv(): Promise<Env> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mods-audit-'))
  return {
    home,
    cachePath: path.join(home, 'mods-audit-cache.json'),
    async addSkillsDirMod(name, source = 'export function register() {}\n') {
      const root = path.join(home, '.claude', 'skills', name)
      await fs.mkdir(path.join(root, '.claude-plugin'), { recursive: true })
      await fs.mkdir(path.join(root, 'hooks'), { recursive: true })
      await fs.writeFile(
        path.join(root, '.claude-plugin', 'plugin.json'),
        JSON.stringify({ name, version: '0.1.0' })
      )
      await fs.writeFile(path.join(root, 'hooks', 'register.ts'), source)
      return await fs.realpath(root)
    },
    cleanup: () => fs.rm(home, { recursive: true, force: true })
  }
}

export interface FakeCli {
  run: ReturnType<typeof vi.fn>
  validateCalls: () => string[][]
  rowsOf: (key: string) => unknown
}

/** `validate` answers by plugin name: `slow-*` times out, `plain-*` has no hooks module. */
export function fakeCli(opts: { listJson?: string; listFails?: boolean } = {}): FakeCli {
  const run = vi.fn(async (_bin: string, args: string[]): Promise<CliResult> => {
    if (args[0] === '--version') return ok('2.1.289 (Claude Code)\n')
    if (args[0] === 'plugin' && args[1] === 'list') {
      if (opts.listFails) return { ...ok('', 1), stderr: 'boom' }
      return ok(opts.listJson ?? '[]')
    }
    if (args[0] === 'plugin' && args[1] === 'validate') {
      const target = args[2] as string
      const base = path.basename(
        target.endsWith('plugin.json') ? path.dirname(path.dirname(target)) : target
      )
      if (base.startsWith('slow-')) {
        return { stdout: '', stderr: '', code: null, timedOut: true, spawnError: false }
      }
      if (base.startsWith('market-') && !target.endsWith('plugin.json')) {
        return ok(JSON.stringify(fixture('validate-marketplace.json')), 0)
      }
      if (base.startsWith('plain-')) {
        return ok(
          JSON.stringify({
            success: true,
            manifest: { type: 'plugin', errors: [], warnings: [], notes: [] },
            contents: [{ file: 'x', type: 'skills', errors: [], warnings: [], notes: ['x'] }]
          })
        )
      }
      return ok(JSON.stringify(fixture('validate-tool-call.json')), 0)
    }
    return ok('')
  })
  return {
    run,
    validateCalls: () =>
      run.mock.calls.map((c) => c[1] as string[]).filter((a) => a[1] === 'validate'),
    rowsOf: () => undefined
  }
}

export function baseDeps(
  env: Env,
  cli: FakeCli,
  over: Partial<ModsAuditDeps> = {}
): {
  deps: ModsAuditDeps
  emitted: ModRow[]
  clock: { t: number }
} {
  const emitted: ModRow[] = []
  const clock = { t: 1_000 }
  const deps: ModsAuditDeps = {
    resolveClaude: async () => '/fake/bin/claude',
    runCli: cli.run as unknown as ModsAuditDeps['runCli'],
    now: () => (clock.t += 10),
    home: () => env.home,
    cachePath: env.cachePath,
    companionDir: async () => null,
    harnuSkillsDir: async () => null,
    readBoot: async () => ({}),
    settingsPluginDirs: async () => undefined,
    policy: async () => 'unknown',
    emitRow: (row) => {
      emitted.push(row)
    },
    ...over
  }
  return { deps, emitted, clock }
}
