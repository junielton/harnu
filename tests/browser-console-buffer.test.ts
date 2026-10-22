/**
 * T570 (browser pane U3, AC-3) — the cursor ring and the console buffer: CDP events folded into entries,
 * `tail` / `since` with cursors, level filters, `clear`, the 500-entry / 256 KiB bounds and `CURSOR_EXPIRED`.
 */
import { describe, it, expect } from 'vitest'
import { createCursorRing, decodeCursor, encodeCursor } from '../src/main/browser/cursor-ring'
import {
  CONSOLE_MAX_ENTRIES,
  createConsoleBuffer,
  entryFromConsoleCall,
  entryFromException,
  entryFromLog,
  levelOfConsoleType
} from '../src/main/browser/console-buffer'

describe('cursor ring', () => {
  const ring = (maxEntries = 3, maxBytes = 1000) =>
    createCursorRing<string>({ maxEntries, maxBytes }, (v) => v.length)

  it('round-trips cursors and rejects anything else', () => {
    expect(decodeCursor(encodeCursor(42))).toBe(42)
    expect(decodeCursor('42')).toBeNull()
    expect(decodeCursor('k-1')).toBeNull()
  })

  it('tails the newest entries and continues from the cursor', () => {
    const r = ring(10)
    for (const v of ['a', 'b', 'c']) r.push(v)
    const first = r.tail(2)
    if (!first.ok) throw new Error('unexpected')
    expect(first.entries.map((e) => e.value)).toEqual(['b', 'c'])
    r.push('d')
    const next = r.since(first.cursor, 10)
    if (!next.ok) throw new Error('unexpected')
    expect(next.entries.map((e) => e.value)).toEqual(['d'])
  })

  it('expires a cursor once entries it had not seen were evicted, and counts the drops', () => {
    const r = ring(3)
    r.push('a')
    const t = r.tail(10)
    if (!t.ok) throw new Error('unexpected')
    for (const v of ['b', 'c', 'd', 'e']) r.push(v)
    expect(r.since(t.cursor, 10)).toEqual({ ok: false, error: 'CURSOR_EXPIRED' })
    expect(r.droppedEntries).toBe(2)
  })

  it('keeps a cursor valid when the entries after it are all still held', () => {
    const r = ring(3)
    for (const v of ['a', 'b', 'c']) r.push(v)
    const mid = encodeCursor(1) // saw "a"
    r.push('d') // evicts "a" only
    const res = r.since(mid, 10)
    expect(res.ok).toBe(true)
  })

  it('refuses an unknown or future cursor', () => {
    const r = ring()
    r.push('a')
    expect(r.since('nope', 5)).toEqual({ ok: false, error: 'CURSOR_EXPIRED' })
    expect(r.since(encodeCursor(99), 5)).toEqual({ ok: false, error: 'CURSOR_EXPIRED' })
  })

  it('evicts by bytes as well as by count', () => {
    const r = ring(100, 10)
    r.push('aaaaaa')
    r.push('bbbbbb')
    expect(r.size).toBe(1)
    expect(r.droppedEntries).toBe(1)
  })

  it('clear drops the entries but never expires a cursor', () => {
    const r = ring(10)
    r.push('a')
    const t = r.tail(5)
    if (!t.ok) throw new Error('unexpected')
    r.clear()
    r.push('b')
    const res = r.since(t.cursor, 5)
    if (!res.ok) throw new Error('cursor should still be valid')
    expect(res.entries.map((e) => e.value)).toEqual(['b'])
    expect(r.droppedEntries).toBe(0)
  })

  it('pages a since read by limit and moves the cursor only as far as it returned', () => {
    const r = ring(10)
    for (const v of ['a', 'b', 'c', 'd']) r.push(v)
    const start = encodeCursor(0)
    const p1 = r.since(start, 2)
    if (!p1.ok) throw new Error('unexpected')
    expect(p1.entries.map((e) => e.value)).toEqual(['a', 'b'])
    const p2 = r.since(p1.cursor, 2)
    if (!p2.ok) throw new Error('unexpected')
    expect(p2.entries.map((e) => e.value)).toEqual(['c', 'd'])
  })
})

describe('console entries from CDP', () => {
  it('folds CDP console types onto five levels', () => {
    expect(levelOfConsoleType('warning')).toBe('warn')
    expect(levelOfConsoleType('assert')).toBe('error')
    expect(levelOfConsoleType('dir')).toBe('log')
    expect(levelOfConsoleType('debug')).toBe('debug')
  })

  it('renders arguments and keeps the stack on errors only', () => {
    const stack = {
      callFrames: [
        { functionName: 'go', url: 'http://localhost/app.js', lineNumber: 9, columnNumber: 4 }
      ]
    }
    const err = entryFromConsoleCall(
      {
        type: 'error',
        args: [
          { type: 'string', value: 'boom' },
          { type: 'number', value: 7 }
        ],
        timestamp: 5,
        stackTrace: stack
      },
      0
    )
    expect(err).toMatchObject({
      level: 'error',
      text: 'boom 7',
      url: 'http://localhost/app.js',
      line: 10
    })
    expect(err?.stack).toBe('at go (http://localhost/app.js:10:5)')
    const log = entryFromConsoleCall(
      { type: 'log', args: [{ type: 'string', value: 'hi' }], stackTrace: stack },
      0
    )
    expect(log?.stack).toBeUndefined()
  })

  it('describes objects and null, and skips console.clear', () => {
    const e = entryFromConsoleCall(
      {
        type: 'log',
        args: [
          { type: 'object', description: 'Array(3)' },
          { type: 'object', subtype: 'null' }
        ]
      },
      0
    )
    expect(e?.text).toBe('Array(3) null')
    expect(entryFromConsoleCall({ type: 'clear' }, 0)).toBeNull()
  })

  it('turns an uncaught exception into an error entry with its stack', () => {
    const e = entryFromException(
      {
        timestamp: 9,
        exceptionDetails: {
          url: 'http://localhost/x.js',
          lineNumber: 2,
          exception: { description: 'TypeError: x is undefined\n    at run (x.js:3:1)' }
        }
      },
      0
    )
    expect(e).toMatchObject({
      level: 'error',
      source: 'exception',
      text: 'TypeError: x is undefined',
      line: 3
    })
    expect(e.stack).toContain('at run')
  })

  it('maps the browser log levels', () => {
    expect(
      entryFromLog({ entry: { level: 'warning', text: 'deprecated', timestamp: 1 } }, 0)
    ).toMatchObject({
      level: 'warn',
      source: 'browser'
    })
    expect(entryFromLog({}, 0)).toBeNull()
  })

  it('caps a single huge argument', () => {
    const e = entryFromConsoleCall(
      { type: 'log', args: [{ type: 'string', value: 'x'.repeat(50_000) }] },
      0
    )
    expect(e!.text.length).toBeLessThanOrEqual(2_001)
  })
})

describe('console buffer', () => {
  const call = (type: string, text: string) => ({
    type,
    args: [{ type: 'string', value: text }],
    timestamp: 1
  })

  it('ingests events, tails, filters by level and clears', () => {
    const b = createConsoleBuffer(() => 0)
    b.ingest('Runtime.consoleAPICalled', call('log', 'one'))
    b.ingest('Runtime.consoleAPICalled', call('warning', 'two'))
    b.ingest('Runtime.consoleAPICalled', call('error', 'three'))
    b.ingest('Page.frameNavigated', {})
    const all = b.read({ mode: 'tail', lines: 10 })
    if (!all.ok) throw new Error('unexpected')
    expect(all.entries.map((e) => e.text)).toEqual(['one', 'two', 'three'])
    const errs = b.read({ mode: 'tail', lines: 10, levels: ['error', 'warn'], clear: true })
    if (!errs.ok) throw new Error('unexpected')
    expect(errs.entries.map((e) => e.text)).toEqual(['two', 'three'])
    const after = b.read({ mode: 'tail', lines: 10 })
    if (!after.ok) throw new Error('unexpected')
    expect(after.entries).toEqual([])
  })

  it('reads since a cursor and refuses a since read without one', () => {
    const b = createConsoleBuffer(() => 0)
    b.ingest('Runtime.consoleAPICalled', call('log', 'one'))
    const first = b.read({ mode: 'tail', lines: 5 })
    if (!first.ok) throw new Error('unexpected')
    b.ingest('Runtime.consoleAPICalled', call('log', 'two'))
    const next = b.read({ mode: 'since', lines: 5, since: first.cursor })
    if (!next.ok) throw new Error('unexpected')
    expect(next.entries.map((e) => e.text)).toEqual(['two'])
    expect(b.read({ mode: 'since', lines: 5 })).toEqual({ ok: false, error: 'BAD_ARGS' })
  })

  it('holds at most 500 entries, reports droppedEntries, and expires the stale cursor', () => {
    const b = createConsoleBuffer(() => 0)
    b.ingest('Runtime.consoleAPICalled', call('log', 'first'))
    const start = b.read({ mode: 'tail', lines: 1 })
    if (!start.ok) throw new Error('unexpected')
    for (let i = 0; i < CONSOLE_MAX_ENTRIES + 10; i++)
      b.ingest('Runtime.consoleAPICalled', call('log', `n${i}`))
    const tail = b.read({ mode: 'tail', lines: 500 })
    if (!tail.ok) throw new Error('unexpected')
    expect(tail.entries).toHaveLength(500)
    expect(tail.droppedEntries).toBe(11)
    expect(b.read({ mode: 'since', lines: 5, since: encodeCursor(0) })).toEqual({
      ok: false,
      error: 'CURSOR_EXPIRED'
    })
  })

  it('bounds the ring by bytes (256 KiB)', () => {
    const b = createConsoleBuffer(() => 0)
    for (let i = 0; i < 200; i++)
      b.ingest('Runtime.consoleAPICalled', call('log', 'x'.repeat(3_900)))
    const tail = b.read({ mode: 'tail', lines: 500 })
    if (!tail.ok) throw new Error('unexpected')
    expect(tail.entries.length).toBeLessThan(200)
    expect(tail.droppedEntries).toBeGreaterThan(0)
  })
})
