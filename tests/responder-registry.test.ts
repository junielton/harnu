import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Registry + prefs + shadow-ring tests (spec §5.2). `electron` is mocked so
 * `app.getPath('userData')` points at a fresh tmpdir per test, mirroring the
 * usage poller / haiku-service approach.
 */

let userDataDir = ''
vi.mock('electron', () => ({ app: { getPath: () => userDataDir } }))

import {
  ResolverRegistry,
  responderRegistry,
  echoNoopResolver,
  readMode,
  writeMode,
  pushShadowEntry,
  getShadowLog,
  clearShadowLog,
  _resetResponderState,
  SHADOW_LOG_MAX
} from '../src/main/responder-registry'
import type { Resolver } from '../src/main/responder-dispatch'

const r = (id: string, priority: number): Resolver => ({ id, priority, resolve: () => null })

beforeEach(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'responder-'))
  _resetResponderState()
})

describe('ResolverRegistry', () => {
  it('lists resolvers ordered by priority asc, stable by id on ties', () => {
    const reg = new ResolverRegistry()
    reg.register(r('b', 20))
    reg.register(r('c', 10))
    reg.register(r('a', 10))
    expect(reg.list().map((x) => x.id)).toEqual(['a', 'c', 'b'])
    expect(reg.list().map((x) => x.priority)).toEqual([10, 10, 20])
  })

  it('register returns an unregister that removes exactly that resolver', () => {
    const reg = new ResolverRegistry()
    reg.register(r('keep', 10))
    const off = reg.register(r('drop', 20))
    off()
    expect(reg.list().map((x) => x.id)).toEqual(['keep'])
  })

  it('unregister(id) removes by id; unknown id is a no-op', () => {
    const reg = new ResolverRegistry()
    reg.register(r('x', 10))
    reg.unregister('nope')
    expect(reg.list().map((x) => x.id)).toEqual(['x'])
    reg.unregister('x')
    expect(reg.list()).toHaveLength(0)
  })

  it('exposes the shared responderRegistry singleton', () => {
    expect(responderRegistry).toBeInstanceOf(ResolverRegistry)
  })
})

describe('echoNoopResolver', () => {
  it('always abstains, priority 1000, id noop', () => {
    expect(echoNoopResolver.id).toBe('noop')
    expect(echoNoopResolver.priority).toBe(1000)
    const ctrl = new AbortController()
    expect(
      echoNoopResolver.resolve({ sessionId: 'S', event: 'PreToolUse', raw: {} }, ctrl.signal)
    ).toBeNull()
  })
})

describe('readMode / writeMode', () => {
  it('defaults to shadow when there is no file', async () => {
    expect(await readMode()).toBe('shadow')
  })

  it('round-trips off / shadow / active', async () => {
    for (const mode of ['off', 'active', 'shadow'] as const) {
      await writeMode(mode)
      expect(await readMode()).toBe(mode)
    }
  })

  it('falls back to shadow on invalid JSON (never throws)', async () => {
    const { writeFile, mkdir } = await import('node:fs/promises')
    await mkdir(userDataDir, { recursive: true })
    await writeFile(join(userDataDir, 'responder-prefs.json'), '{not json', 'utf8')
    expect(await readMode()).toBe('shadow')
  })

  it('falls back to shadow on an out-of-enum value', async () => {
    const { writeFile, mkdir } = await import('node:fs/promises')
    await mkdir(userDataDir, { recursive: true })
    await writeFile(
      join(userDataDir, 'responder-prefs.json'),
      JSON.stringify({ mode: 'banana' }),
      'utf8'
    )
    expect(await readMode()).toBe('shadow')
  })
})

describe('shadow ring', () => {
  const entry = (i: number): Parameters<typeof pushShadowEntry>[0] => ({
    sessionId: `S${i}`,
    event: 'PreToolUse',
    by: 'r',
    summary: `PreToolUse→deny (r) #${i}`,
    ts: i
  })

  it('returns a copy (mutating the result does not affect the ring)', () => {
    pushShadowEntry(entry(1))
    const log = getShadowLog()
    log.push(entry(99) as never)
    expect(getShadowLog()).toHaveLength(1)
  })

  it('keeps insertion order (most recent last)', () => {
    pushShadowEntry(entry(1))
    pushShadowEntry(entry(2))
    expect(getShadowLog().map((e) => e.sessionId)).toEqual(['S1', 'S2'])
  })

  it('caps at SHADOW_LOG_MAX, discarding the oldest', () => {
    for (let i = 0; i < SHADOW_LOG_MAX + 5; i++) pushShadowEntry(entry(i))
    const log = getShadowLog()
    expect(log).toHaveLength(SHADOW_LOG_MAX)
    // The first 5 pushed (0..4) were dropped; oldest survivor is #5.
    expect(log[0].sessionId).toBe('S5')
    expect(log[log.length - 1].sessionId).toBe(`S${SHADOW_LOG_MAX + 4}`)
  })

  it('clearShadowLog empties the ring', () => {
    pushShadowEntry(entry(1))
    clearShadowLog()
    expect(getShadowLog()).toHaveLength(0)
  })
})
