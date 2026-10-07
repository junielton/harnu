/**
 * T389 P4W1 part B, P4W1-S5 / MOD-3: the companion's `plugin.register` hook is a pure observer
 * and there is exactly one of it. A static read of the shipped mod source (comments stripped,
 * tests excluded): no `refuse` property anywhere, and no `plugin.register` registration other than
 * the `sense.mods` step. The hook may never be turned into a gate on someone else's mod.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '..', '..', 'resources', 'companion')

function sources(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'tests' || e.name === 'node_modules' || e.name === 'types') continue
      if (e.name === '.claude-plugin') continue
      out.push(...sources(p))
    } else if (/\.(ts|tsx|json)$/.test(e.name)) out.push(p)
  }
  return out
}

const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')

const files = sources(ROOT).map((p) => ({ p, text: stripComments(readFileSync(p, 'utf8')) }))

describe('the companion never gates another mod', () => {
  it('reads at least the hooks module', () => {
    expect(files.some((f) => f.p.endsWith(join('hooks', 'register.ts')))).toBe(true)
  })

  it('has no `refuse` property or call anywhere in the shipped source', () => {
    const hits = files.filter((f) =>
      /\brefuse\s*[:(]|\.refuse\b|\[\s*['"]refuse['"]\s*\]/.test(f.text)
    )
    expect(hits.map((h) => h.p)).toEqual([])
  })

  it('registers plugin.register exactly once, in the hooks module', () => {
    const regs = files.flatMap((f) =>
      [...f.text.matchAll(/\bon\(\s*['"]plugin\.register['"]/g)].map(() => f.p)
    )
    expect(regs.length).toBe(1)
    expect(regs[0]).toMatch(/hooks[\\/]register\.ts$/)
  })

  it('the one hook answers with what next(e) returned', () => {
    const src = files.find((f) => f.p.endsWith(join('hooks', 'register.ts')))!.text
    const start = src.indexOf("on('plugin.register'")
    const body = src.slice(start, src.indexOf('registered.mods = true', start))
    expect(body).toMatch(/const result = await next\(e\)/)
    expect(body).toMatch(/return result\b/)
    expect(body.match(/\breturn\b/g)?.length).toBe(1) // one return, and it is `result`
  })
})
