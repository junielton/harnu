import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { reasonKey } from '../src/renderer/src/components/cleanup-gc-copy'

const load = (locale: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(process.cwd(), `src/renderer/src/i18n/${locale}.json`), 'utf8'))
const at = (o: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((a, k) => (a as Record<string, unknown> | undefined)?.[k], o)

// Every review code S2 can emit, as of delta 6 (nested-worktree included).
const CODES = [
  'dirty',
  'unpushed',
  'open-idle-session',
  'closed-unmerged',
  'remote-gone',
  'detached',
  'unknown-fate',
  'weak-merge-signal',
  'shared-stack',
  'cleanup-failed',
  'path-unresolved',
  'nested-worktree',
  'no-known-worktree'
] as const

describe('reasonKey — every review code has a sentence in both locales', () => {
  for (const code of CODES) {
    it(code, () => {
      const key = reasonKey(code)
      expect(key).not.toBe('cleanup.gc.reason.unknownFate')
      for (const locale of ['en', 'pt-BR']) {
        expect(typeof at(load(locale), key), `${locale} ${key}`).toBe('string')
      }
    })
  }
  it('names the nested worktree problem', () => {
    expect(at(load('en'), reasonKey('nested-worktree'))).toMatch(/inside/)
  })
})
