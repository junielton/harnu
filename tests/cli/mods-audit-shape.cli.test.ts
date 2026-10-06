/**
 * T389 P4W1 — AC-P4W1-7 (contract). The Mods pane parses free text the CLI prints
 * (`claude plugin validate --json`) and a JSON list (`claude plugin list --json`).
 * This file runs the INSTALLED CLI and holds both outputs to the checked-in shape
 * snapshots, so a release that renames a note label or a key fails here instead of
 * silently emptying the pane (R16 mitigation: `unparsed` is shown, a miss is visible).
 *
 * Opt-in: needs a real `claude` binary, so it runs only with HARNU_WITH_CLI=1
 * (`HARNU_WITH_CLI=1 npx vitest run tests/cli/mods-audit-shape.cli.test.ts`).
 * Re-record the snapshots with HARNU_RECORD_SHAPES=1 after a deliberate change.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { parseValidateReport } from '../../src/main/mods-audit-core'
import { classifyPolicyProbe } from '../../src/main/claude-policy-probe-core'

const WITH_CLI = process.env['HARNU_WITH_CLI'] === '1'
const RECORD = process.env['HARNU_RECORD_SHAPES'] === '1'
const SNAPSHOTS = path.join(__dirname, '..', 'fixtures', 'mods-audit')

function run(args: string[], cwd: string): { stdout: string; code: number } {
  try {
    return {
      stdout: execFileSync('claude', args, { cwd, encoding: 'utf8', timeout: 30_000 }),
      code: 0
    }
  } catch (e) {
    const err = e as { stdout?: string; status?: number }
    return { stdout: err.stdout ?? '', code: err.status ?? -1 }
  }
}

const keysOf = (o: unknown): string[] =>
  o && typeof o === 'object' ? Object.keys(o as object).sort() : []

/** The key structure of a validate report: what the parser depends on. */
function validateShape(report: Record<string, unknown>): unknown {
  const contents = (report['contents'] as Record<string, unknown>[]) ?? []
  const labels = new Set<string>()
  for (const c of contents) {
    for (const n of (c['notes'] as string[]) ?? []) {
      const m =
        /^\S+ (hooks|calls|env reads|env writes|state reads|state writes|state of other plugins, not checked)\b/.exec(
          n
        )
      if (m) labels.add(m[1] as string)
    }
  }
  return {
    top: keysOf(report),
    manifest: keysOf(report['manifest']),
    content: keysOf(contents[0]),
    noteLabels: [...labels].sort()
  }
}

function listShape(rows: Record<string, unknown>[]): unknown {
  const keys = new Set<string>()
  for (const r of rows) for (const k of Object.keys(r)) keys.add(k)
  return { rowKeys: [...keys].sort(), scopes: [...new Set(rows.map((r) => r['scope']))].sort() }
}

function snapshot(name: string, actual: unknown): unknown {
  const file = path.join(SNAPSHOTS, name)
  if (RECORD) writeFileSync(file, JSON.stringify(actual, null, 2) + '\n')
  return JSON.parse(readFileSync(file, 'utf8'))
}

describe.skipIf(!WITH_CLI)('mods-audit CLI shapes', () => {
  let dir: string
  let mod: string

  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'mods-audit-shape-'))
    mod = path.join(dir, 'shape-mod')
    mkdirSync(path.join(mod, '.claude-plugin'), { recursive: true })
    mkdirSync(path.join(mod, 'hooks'))
    writeFileSync(
      path.join(mod, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'shape-mod', version: '0.1.0', description: 'fixture' })
    )
    writeFileSync(
      path.join(mod, 'hooks', 'hooks.json'),
      JSON.stringify({ modules: ['./register.ts'] })
    )
    writeFileSync(
      path.join(mod, 'hooks', 'register.ts'),
      [
        "import type { Register } from 'claude-code'",
        'export const register: Register = on => {',
        "  on('tool.call', { tool: 'Edit' }, ($, e, next) => next(e))",
        "  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {",
        '    const ran = await next({ ...e, command: e.command.trim() })',
        '    $.ui.status(ran.isError === true ? `failed: ${e.command.slice(0, 40)}` : undefined)',
        '    return ran',
        '  })',
        '}',
        ''
      ].join('\n')
    )
  })

  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('validate and list keep their shape', () => {
    const v = run(['plugin', 'validate', mod, '--json'], dir)
    expect(v.code).toBeLessThanOrEqual(1)
    const report = JSON.parse(v.stdout) as Record<string, unknown>
    expect(validateShape(report)).toEqual(snapshot('shape-validate.json', validateShape(report)))

    // and the parser still reads every note of it
    const parsed = parseValidateReport(report)
    expect(parsed.ok).toBe(true)
    expect(parsed.unparsed).toEqual([])
    expect(parsed.hasModule).toBe(true)
    expect(parsed.hooks.map((h) => `${h.event}{${h.matcher}}`)).toEqual([
      'tool.call{tool=Edit}',
      'tool.call{tool=Bash}'
    ])
    expect(parsed.calls.map((c) => c.op)).toEqual(['ui.status'])

    const l = run(['plugin', 'list', '--json'], dir)
    expect(l.code).toBe(0)
    const rows = JSON.parse(l.stdout) as Record<string, unknown>[]
    expect(Array.isArray(rows)).toBe(true)
    if (rows.length > 0) {
      // optional keys (`projectPath`, `mcpServers`) depend on what is installed:
      // the required ones must exist, and nothing outside the known set may appear
      const required = ['id', 'version', 'scope', 'enabled', 'installPath']
      for (const r of rows) for (const k of required) expect(r, k).toHaveProperty(k)
      const known = snapshot('shape-list.json', listShape(rows)) as {
        rowKeys: string[]
        scopes: string[]
      }
      const seen = listShape(rows) as { rowKeys: string[]; scopes: string[] }
      expect(known.rowKeys).toEqual(expect.arrayContaining(required))
      for (const k of seen.rowKeys) expect(known.rowKeys, `new key ${k}`).toContain(k)
      for (const s of seen.scopes) expect(known.scopes, `new scope ${s}`).toContain(s)
    }
  })
})

/** `claude plugin test` in an empty directory under a given HOME; no inherited CLAUDE_* variables. */
function probeOutput(home: string): string {
  const empty = mkdtempSync(path.join(os.tmpdir(), 'mods-audit-probe-'))
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE_'))
  )
  try {
    return execFileSync('claude', ['plugin', 'test'], {
      cwd: empty,
      env: { ...env, HOME: home },
      encoding: 'utf8',
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string }
    return `${err.stdout ?? ''}${err.stderr ?? ''}`
  } finally {
    rmSync(empty, { recursive: true, force: true })
  }
}

describe.skipIf(!WITH_CLI)('mods-audit policy probe (AC-P4W1-9)', () => {
  it('policy probe message is recognised', () => {
    // A throwaway HOME with no settings: mods are on, unless the machine's own managed policy
    // says otherwise, so any known class is accepted; `unknown` is the failure (it shows no banner).
    const clean = mkdtempSync(path.join(os.tmpdir(), 'mods-audit-home-'))
    const off = mkdtempSync(path.join(os.tmpdir(), 'mods-audit-home-'))
    try {
      mkdirSync(path.join(off, '.claude'), { recursive: true })
      writeFileSync(path.join(off, '.claude', 'settings.json'), '{"disableAllHooks":true}')
      expect(['loads', 'off-here', 'off-remote']).toContain(classifyPolicyProbe(probeOutput(clean)))
      expect(classifyPolicyProbe(probeOutput(off))).toBe('off-here')
    } finally {
      rmSync(clean, { recursive: true, force: true })
      rmSync(off, { recursive: true, force: true })
    }
  })
})
