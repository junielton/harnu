import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { inUseReason, reasonKey } from '../src/renderer/src/components/cleanup-gc-copy'

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
  'check-failed',
  'locked',
  'no-known-worktree'
] as const

describe('reasonKey — every review code has a sentence in both locales', () => {
  for (const code of CODES) {
    it(code, () => {
      const key = reasonKey(code)
      // A code must have its own key, not fall through to the unknown-fate fallback.
      if (code !== 'unknown-fate') expect(key).not.toBe('cleanup.gc.reason.unknownFate')
      for (const locale of ['en', 'pt-BR']) {
        expect(typeof at(load(locale), key), `${locale} ${key}`).toBe('string')
      }
    })
  }
  it('names the nested worktree problem', () => {
    expect(at(load('en'), reasonKey('nested-worktree'))).toMatch(/inside/)
  })
  it('a probe that failed reads differently from a worktree that was found inside', () => {
    for (const locale of ['en', 'pt-BR']) {
      const failed = at(load(locale), reasonKey('check-failed'))
      expect(failed, locale).not.toBe(at(load(locale), reasonKey('nested-worktree')))
    }
    expect(at(load('en'), reasonKey('check-failed'))).toMatch(/could not look inside/)
  })
})

describe('inUseReason — why an In use block is In use, in bucketOf order', () => {
  const NOW = 1_800_000_000_000
  const DAY = 86_400_000
  const base = {
    isMainCheckout: false,
    neverClean: false,
    session: 'none' as const,
    fate: { fate: 'merged' as const, signal: 'ancestor' as const, strong: true },
    lastSignOfLifeAt: NOW - 3_600_000,
    keep: false,
    graceDays: 2
  }
  const key = (over: object): string => inUseReason({ ...base, ...over }, NOW).key

  it('names the main checkout and the never-clean list first', () => {
    expect(key({ isMainCheckout: true, session: 'working' })).toBe(
      'cleanup.gc.reason.inUse.mainCheckout'
    )
    expect(key({ neverClean: true })).toBe('cleanup.gc.reason.inUse.neverClean')
  })

  it('then a working or waiting session, then an open pull request', () => {
    expect(key({ session: 'working' })).toBe('cleanup.gc.reason.inUse.sessionWorking')
    expect(key({ session: 'needs-input' })).toBe('cleanup.gc.reason.inUse.sessionWorking')
    expect(key({ fate: { fate: 'open', signal: null, strong: false } })).toBe(
      'cleanup.gc.reason.inUse.openPr'
    )
  })

  it('an unknown or invalid last activity is "no sign", never "old enough"', () => {
    expect(key({ lastSignOfLifeAt: null })).toBe('cleanup.gc.reason.inUse.unknownAge')
    expect(key({ lastSignOfLifeAt: -1 })).toBe('cleanup.gc.reason.inUse.unknownAge')
  })

  it('recent activity is the grace period, and carries the time it happened', () => {
    const r = inUseReason(base, NOW)
    expect(r).toEqual({
      key: 'cleanup.gc.reason.inUse.withinGrace',
      lastSignOfLifeAt: NOW - 3_600_000
    })
  })

  it('a kept worktree past its grace period is "Keep"; inside it, the grace period wins (as bucketOf does)', () => {
    expect(key({ keep: true, lastSignOfLifeAt: NOW - 10 * DAY })).toBe(
      'cleanup.gc.reason.inUse.kept'
    )
    expect(key({ keep: true })).toBe('cleanup.gc.reason.inUse.withinGrace')
  })

  it('every sentence exists in both locales', () => {
    for (const suffix of [
      'mainCheckout',
      'neverClean',
      'sessionWorking',
      'openPr',
      'unknownAge',
      'withinGrace',
      'kept'
    ]) {
      for (const locale of ['en', 'pt-BR']) {
        expect(
          typeof at(load(locale), `cleanup.gc.reason.inUse.${suffix}`),
          `${locale} ${suffix}`
        ).toBe('string')
      }
    }
  })
})
