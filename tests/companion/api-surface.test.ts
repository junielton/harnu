import { readFile, readdir } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  checkForbidden,
  checkImports,
  scanSurface,
  scanStateKeys,
  stripCommentsAndStrings
} from '../../scripts/ci/api-surface-scan.mjs'

const ROOT = resolve(import.meta.dirname, '..', '..', 'resources', 'companion')
const HOOKS = join(ROOT, 'hooks')

async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...(await walk(p)))
    else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p)
  }
  return out.sort()
}

async function realSources(): Promise<{ rel: string; text: string }[]> {
  const files = (await walk(HOOKS)).filter((f) => !f.endsWith('coords.gen.ts'))
  return Promise.all(
    files.map(async (f) => ({
      rel: relative(ROOT, f).split('\\').join('/'),
      text: await readFile(f, 'utf8')
    }))
  )
}

const manifest = JSON.parse(await readFile(join(ROOT, 'api-surface.json'), 'utf8'))

describe('drift way 1: source equals the manifest', () => {
  it('source equals the manifest (drift way 1)', async () => {
    const sources = await realSources()
    const surface = scanSurface(sources.map((s) => s.text))
    expect(surface.hooks).toEqual([...manifest.hooks].sort())
    expect(surface.calls).toEqual([...manifest.calls].sort())
    expect(surface.envReads).toEqual([...manifest.envReads].sort())
    const dts = await readFile(join(ROOT, 'types', 'index.d.ts'), 'utf8')
    expect(scanStateKeys(dts, manifest.plugin)).toEqual([...manifest.stateKeys].sort())
  })

  it('reads hooks, $-calls and literal env reads, ignoring comments and strings', () => {
    const src = `
      // on('session.end', ...) and $.process.run() live in a comment
      export const register = (on) => {
        on('session.start', async ($, e, next) => {
          await $.http.fetch('https://x', {})
          const t = await $.env.get('HARNU_SPAWN_TOKEN')
          const msg = "on('turn.step') in a string, $.mcp.call too"
          return next(e)
        })
        on("command.run", { command: 'x' }, async ($) => $.session.id())
      }`
    expect(scanSurface([src])).toEqual({
      hooks: ['command.run', 'session.start'],
      calls: ['$.env.get', '$.http.fetch', '$.session.id'],
      envReads: ['HARNU_SPAWN_TOKEN']
    })
  })

  it('flags an env read whose name is not a literal', () => {
    expect(checkForbidden([{ rel: 'hooks/register.ts', text: 'await $.env.get(name)' }])).toEqual([
      expect.stringContaining('$.env.get')
    ])
  })
})

describe('forbidden constructions', () => {
  it('the real source has none', async () => {
    expect(checkForbidden(await realSources())).toEqual([])
  })

  const flags = (text: string): string[] => checkForbidden([{ rel: 'hooks/register.ts', text }])

  it('no tool.call matcher that can match Bash', () => {
    expect(flags(`on('tool.call', async ($, e, next) => next(e))`)).not.toEqual([]) // no matcher
    expect(flags(`on('tool.call', { tool: 'Bash' }, h)`)).not.toEqual([])
    expect(flags(`on("tool.call", { tool: /^B/ }, h)`)).not.toEqual([])
    expect(flags(`on('tool.call', { tool: /.*/ }, h)`)).not.toEqual([])
    expect(flags(`on('tool.call', { tool: name }, h)`)).not.toEqual([]) // cannot be proven
    expect(flags(`on('tool.call', matcher, h)`)).not.toEqual([])
  })

  it('allows a tool.call matcher that provably cannot match Bash', () => {
    expect(flags(`on('tool.call', { tool: /^mcp__(harnu|capy)__/ }, h)`)).toEqual([])
    expect(flags(`on('tool.call', { tool: 'Edit' }, h)`)).toEqual([])
  })

  it('no star event, no turn.step, no $.process, no $.mcp.call', () => {
    expect(flags(`on('*', h)`)).not.toEqual([])
    expect(flags(`on('turn.step', h)`)).not.toEqual([])
    expect(flags(`await $.process.run('x')`)).not.toEqual([])
    expect(flags(`await $.mcp.call('x')`)).not.toEqual([])
    expect(flags(`await $.mcp.list()`)).toEqual([])
  })

  it('no function outside register.ts takes a parameter named $', () => {
    const lib = (text: string): string[] => checkForbidden([{ rel: 'hooks/lib/ring.ts', text }])
    expect(lib('export function push($: unknown, x: number) {}')).not.toEqual([])
    expect(lib('export const f = ($) => 1')).not.toEqual([])
    expect(lib('export function push(buf: number[], x: number) { return `${x}` }')).toEqual([])
    // the same signature is fine in register.ts, where validate enforces the declaration site
    expect(flags('const f = ($) => 1')).toEqual([])
  })
})

describe('import discipline (MOD-1)', () => {
  it('hooks/contract.ts has zero imports and every import stays in the plugin', async () => {
    expect(checkImports(await realSources())).toEqual([])
    const contract = (await realSources()).find((s) => s.rel === 'hooks/contract.ts')!
    expect(stripCommentsAndStrings(contract.text)).not.toMatch(/\bimport\b|\brequire\s*\(/)
  })

  it('flags a contract import, a bare package, an escaping path and a dynamic import', () => {
    const f = (rel: string, text: string): string[] => checkImports([{ rel, text }])
    expect(f('hooks/contract.ts', `import type { X } from './other'`)).not.toEqual([])
    expect(f('hooks/register.ts', `import x from 'lodash'`)).not.toEqual([])
    expect(f('hooks/register.ts', `import x from '../../outside'`)).not.toEqual([])
    expect(f('hooks/register.ts', `const m = await import('./late')`)).not.toEqual([])
    expect(f('hooks/register.ts', `const m = require('./late')`)).not.toEqual([])
  })

  it('accepts relative imports inside the plugin and the engine\u2019s own module', () => {
    const f = (rel: string, text: string): string[] => checkImports([{ rel, text }])
    expect(f('hooks/register.ts', `import type { Register } from 'claude-code'`)).toEqual([])
    expect(
      f('hooks/register.ts', `import { A } from './lib/ring'\nimport * as c from './contract'`)
    ).toEqual([])
    expect(f('hooks/lib/ring.ts', `import type { Ev } from '../contract'`)).toEqual([])
    expect(f('hooks/register.ts', `import { MOD_VERSION } from './coords.gen'`)).toEqual([])
    // the plugin's own contract directory is staged; tests and fixtures are not
    expect(f('hooks/register.ts', `import type { S } from '../types'`)).toEqual([])
    expect(f('hooks/register.ts', `import type { S } from '../types/index'`)).toEqual([])
    expect(f('hooks/register.ts', `import { x } from '../tests/fixtures/hello'`)).not.toEqual([])
  })
})
