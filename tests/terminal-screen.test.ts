/* eslint-disable no-control-regex -- the assertions match terminal escape replies (ESC [ …) */
/**
 * T480 (agent terminals B3) — the headless screen model, without any PTY or electron.
 * AC-B3-2 (tail), AC-B3-3 (screen / alt screen), AC-B3-4 (since + cursors), AC-B3-5 (caps),
 * AC-B3-6 (read barrier), the model half of AC-B3-7 (single answerer) and AC-B3-9's watermarks.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { Terminal } from '@xterm/headless'
import {
  ScreenModel,
  BACKLOG_HIGH_BYTES,
  BACKLOG_LOW_BYTES,
  CURSOR_TTL_MS,
  MAX_CURSORS,
  SCROLLBACK_LINES,
  type ScreenModelOptions,
  type ScreenRead
} from '../src/main/terminal-screen'

type Held = { term: Terminal; stall: { on: boolean } }

function make(
  over: Partial<ScreenModelOptions> = {},
  size = { cols: 40, rows: 6 }
): {
  model: ScreenModel
  replies: string[]
  backlog: boolean[]
  held: Held
} {
  const replies: string[] = []
  const backlog: boolean[] = []
  const held = { stall: { on: false } } as Held
  const model = new ScreenModel({
    ...size,
    onReply: (d) => replies.push(d),
    onBacklog: (o) => backlog.push(o),
    createTerminal: (o) => {
      const term = new Terminal({ ...o, allowProposedApi: true })
      const write = term.write.bind(term)
      // A parser that never gets to its queue: the callback of a write never fires.
      term.write = ((d: string | Uint8Array, cb?: () => void) =>
        held.stall.on ? undefined : write(d, cb)) as typeof term.write
      held.term = term
      return term
    },
    ...over
  })
  return { model, replies, backlog, held }
}

const ok = (r: Awaited<ReturnType<ScreenModel['read']>>): ScreenRead => {
  if (!r.ok) throw new Error(`read failed: ${r.error}`)
  return r
}

afterEach(() => {
  vi.useRealTimers()
})

describe('AC-B3-2: tail returns resolved text', () => {
  it('a \\r progress overwrite yields only the final line', async () => {
    const { model } = make()
    model.write('progress 10%\rprogress 55%\rprogress 100%\r\ndone\r\n', false)
    const r = ok(await model.read({ mode: 'tail' }))
    expect(r.text).toBe('progress 100%\ndone')
    expect(r.text).not.toContain('\r')
  })

  it('an SGR-coloured line yields plain text', async () => {
    const { model } = make()
    model.write('\x1b[31mred\x1b[0m and \x1b[1;32mbold green\x1b[0m\r\n', false)
    expect(ok(await model.read({ mode: 'tail' })).text).toBe('red and bold green')
  })

  it('a soft-wrapped line is ONE line, and its in-line blanks survive the wrap', async () => {
    const { model } = make({}, { cols: 10, rows: 4 })
    model.write('0123456789 abcdefghij tail\r\nnext\r\n', false)
    const r = ok(await model.read({ mode: 'tail' }))
    expect(r.text).toBe('0123456789 abcdefghij tail\nnext')
    expect(r.lines).toBe(2)
  })

  it('trims trailing blank lines and reports size and cursor', async () => {
    const { model } = make()
    model.write('hello\r\n\r\n\r\n', false)
    const r = ok(await model.read({ mode: 'tail' }))
    expect(r.text).toBe('hello')
    expect(r.size).toEqual({ cols: 40, rows: 6 })
    expect(r.altScreen).toBe(false)
  })

  it('reads scrollback, not just the viewport', async () => {
    const { model } = make()
    for (let i = 0; i < 30; i++) model.write(`row ${i}\r\n`, false)
    const r = ok(await model.read({ mode: 'tail', lines: 100 }))
    expect(r.text.split('\n')[0]).toBe('row 0')
    expect(r.lines).toBe(30)
  })
})

describe('AC-B3-3: screen returns the viewport', () => {
  it('returns only the visible rows', async () => {
    const { model } = make()
    for (let i = 0; i < 30; i++) model.write(`row ${i}\r\n`, false)
    const r = ok(await model.read({ mode: 'screen' }))
    expect(r.text).toContain('row 29')
    expect(r.text).not.toContain('row 0\n')
    expect(r.lines).toBeLessThanOrEqual(6)
  })

  it('on the alternate screen: altScreen is true and cursorPos is correct', async () => {
    const { model } = make()
    model.write('normal buffer text\r\n', false)
    model.write('\x1b[?1049h\x1b[2J\x1b[3;5Hmenu> ', false)
    const r = ok(await model.read({ mode: 'screen' }))
    expect(r.altScreen).toBe(true)
    expect(r.text).toBe('\n\n    menu> ') // a typed trailing blank is real content
    expect(r.cursorPos).toEqual({ row: 2, col: 10 })
    expect(r.cursor).toBeNull()
  })

  it('leaving the alternate screen brings the normal buffer back', async () => {
    const { model } = make()
    model.write('keep me\r\n\x1b[?1049h\x1b[2Jfull screen\x1b[?1049l', false)
    const r = ok(await model.read({ mode: 'tail' }))
    expect(r.altScreen).toBe(false)
    expect(r.text).toContain('keep me')
    expect(r.text).not.toContain('full screen')
  })
})

describe('AC-B3-4: since', () => {
  it('returns from the cursor line inclusive, including a line completed after the cursor', async () => {
    const { model } = make()
    model.write('before\r\n$ npm te', false)
    const first = ok(await model.read({ mode: 'tail' }))
    expect(first.text).toBe('before\n$ npm te')
    expect(first.cursor).toMatch(/^m\d+$/)
    // The line the cursor sat on is finished, and more output follows.
    model.write('st\r\nall green\r\n$ ', false)
    const since = ok(await model.read({ mode: 'since', since: first.cursor! }))
    expect(since.text).toBe('$ npm test\nall green\n$ ')
    expect(since.text).not.toContain('before')
  })

  it('a cursor taken on a continuation row starts at the logical line above it', async () => {
    const { model } = make({}, { cols: 10, rows: 4 })
    model.write('0123456789abcde', false) // wraps; cursor is on the continuation row
    const first = ok(await model.read({ mode: 'tail' }))
    model.write('fghij\r\n', false)
    const since = ok(await model.read({ mode: 'since', since: first.cursor! }))
    expect(since.text).toBe('0123456789abcdefghij')
  })

  it('an unknown cursor → CURSOR_EXPIRED', async () => {
    const { model } = make()
    expect(await model.read({ mode: 'since', since: 'm99' })).toEqual({
      ok: false,
      error: 'CURSOR_EXPIRED'
    })
    expect(await model.read({ mode: 'since' })).toEqual({ ok: false, error: 'CURSOR_EXPIRED' })
  })

  it('a cursor whose line left the scrollback → CURSOR_EXPIRED', async () => {
    const { model } = make()
    model.write('mark me', false)
    const first = ok(await model.read({ mode: 'tail' }))
    for (let i = 0; i < SCROLLBACK_LINES + 50; i++) model.write(`flood ${i}\r\n`, false)
    expect(await model.read({ mode: 'since', since: first.cursor! })).toEqual({
      ok: false,
      error: 'CURSOR_EXPIRED'
    })
  })

  it('an unused cursor expires after 10 minutes; using it keeps it alive', async () => {
    let t = 1_000_000
    const { model } = make({ now: () => t })
    model.write('a', false)
    const idle = ok(await model.read({ mode: 'tail' })).cursor!
    t += CURSOR_TTL_MS - 1
    const used = ok(await model.read({ mode: 'since', since: idle }))
    expect(used.text).toBe('a')
    t += CURSOR_TTL_MS - 1
    expect((await model.read({ mode: 'since', since: idle })).ok).toBe(true)
    t += CURSOR_TTL_MS + 1
    expect(await model.read({ mode: 'since', since: idle })).toEqual({
      ok: false,
      error: 'CURSOR_EXPIRED'
    })
  })

  it('keeps at most 32 cursors, evicting the oldest', async () => {
    const { model } = make()
    const ids: string[] = []
    for (let i = 0; i < MAX_CURSORS + 3; i++) {
      model.write(`line ${i}\r\n`, false) // a new cursor row each time
      ids.push(ok(await model.read({ mode: 'tail' })).cursor!)
    }
    expect((await model.read({ mode: 'since', since: ids[0]! })).ok).toBe(false)
    expect((await model.read({ mode: 'since', since: ids[ids.length - 1]! })).ok).toBe(true)
  })

  it('on the alternate screen, since returns the screen', async () => {
    const { model } = make()
    model.write('shell\r\n', false)
    const cur = ok(await model.read({ mode: 'tail' })).cursor!
    model.write('\x1b[?1049h\x1b[2J\x1b[1;1Hvim', false)
    const r = ok(await model.read({ mode: 'since', since: cur }))
    expect(r.altScreen).toBe(true)
    expect(r.text).toBe('vim')
  })

  it('a resize keeps the cursor pointing at its line', async () => {
    const { model } = make({}, { cols: 20, rows: 5 })
    model.write('0123456789abcdefghijKLMN\r\nprompt$', false)
    const cur = ok(await model.read({ mode: 'tail' })).cursor!
    model.resize(8, 5)
    model.write('x\r\n', false)
    const r = ok(await model.read({ mode: 'since', since: cur }))
    expect(r.text).toBe('prompt$x')
  })
})

describe('AC-B3-5: caps keep the tail', () => {
  it('`lines` keeps the last lines and counts the dropped ones', async () => {
    const { model } = make()
    for (let i = 0; i < 20; i++) model.write(`n${i}\r\n`, false)
    const r = ok(await model.read({ mode: 'tail', lines: 5 }))
    expect(r.text).toBe('n15\nn16\nn17\nn18\nn19')
    expect(r.lines).toBe(5)
    expect(r.truncated).toBe(true)
    expect(r.droppedLines).toBe(15)
  })

  it('`maxChars` keeps the tail, whole lines first', async () => {
    const { model } = make()
    for (let i = 0; i < 10; i++) model.write(`line-${i}\r\n`, false)
    const r = ok(await model.read({ mode: 'tail', maxChars: 19 }))
    expect(r.text).toBe('line-8\nline-9')
    expect(r.truncated).toBe(true)
    expect(r.droppedLines).toBe(8)
  })

  it('a single line over the budget keeps its end', async () => {
    const { model } = make({}, { cols: 200, rows: 4 })
    model.write(`${'x'.repeat(100)}END\r\n`, false)
    const r = ok(await model.read({ mode: 'tail', maxChars: 10 }))
    expect(r.text).toBe('xxxxxxxEND')
    expect(r.truncated).toBe(true)
    expect(r.droppedLines).toBe(0)
  })

  it('nothing is truncated when everything fits', async () => {
    const { model } = make()
    model.write('small\r\n', false)
    expect(ok(await model.read({ mode: 'tail' }))).toMatchObject({
      truncated: false,
      droppedLines: 0
    })
  })

  it('the model never holds more than 2,000 lines of scrollback', async () => {
    const { model, held } = make()
    for (let i = 0; i < SCROLLBACK_LINES + 500; i++) model.write(`l${i}\r\n`, false)
    await model.barrier()
    const buf = held.term.buffer.active
    expect(buf.length - held.term.rows).toBeLessThanOrEqual(SCROLLBACK_LINES)
    const r = ok(await model.read({ mode: 'tail', lines: 500 }))
    expect(r.text).toContain(`l${SCROLLBACK_LINES + 499}`)
  })
})

describe('AC-B3-6: the read barrier', () => {
  it('a read awaits pending writes: feed a chunk, read at once, never stale', async () => {
    const { model } = make()
    model.write('fresh output\r\n', false)
    expect(model.backlogBytes).toBeGreaterThan(0)
    const r = ok(await model.read({ mode: 'tail' }))
    expect(r.text).toBe('fresh output')
    expect(r.approximate).toBe(false)
  })

  it('times out at 2 s and answers approximate', async () => {
    vi.useFakeTimers()
    const { model, held } = make()
    held.stall.on = true
    model.write('never parsed\r\n', false)
    const p = model.read({ mode: 'tail' })
    await vi.advanceTimersByTimeAsync(1999)
    let settled = false
    void p.then(() => (settled = true))
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(2)
    const r = ok(await p)
    expect(r.approximate).toBe(true)
    expect(r.text).toBe('')
  })

  it('with nothing pending the barrier is free', async () => {
    const { model } = make()
    await model.barrier()
    expect(await model.barrier()).toBe(false)
  })
})

describe('AC-B3-7 (model half): one answerer', () => {
  it('answers a DSR/DA query only for chunks stamped `answer`', async () => {
    const { model, replies } = make()
    model.write('x\x1b[6n\x1b[c', true)
    await model.barrier()
    expect(replies.filter((r) => /^\x1b\[\d+;\d+R$/.test(r))).toHaveLength(1)
    expect(replies.filter((r) => /^\x1b\[\?[\d;]+c$/.test(r))).toHaveLength(1)

    replies.length = 0
    model.write('y\x1b[6n\x1b[c', false) // a renderer xterm answers this one
    await model.barrier()
    expect(replies).toEqual([])
  })

  it('the stamp is taken at feed time, not when the parse reaches the chunk', async () => {
    const { model, replies } = make()
    // Both chunks sit in the parse queue together; the second was fed after a pane took over.
    model.write('a\x1b[5n', true)
    model.write('b\x1b[5n', false)
    await model.barrier()
    expect(replies).toEqual(['\x1b[0n'])
  })
})

describe('AC-B3-9: backpressure watermarks', () => {
  it('reports over above 4 MiB of unparsed bytes and back under 1 MiB', async () => {
    const { model, backlog } = make()
    const chunk = 'a'.repeat(64 * 1024)
    while (model.backlogBytes <= BACKLOG_HIGH_BYTES) model.write(chunk, false)
    expect(backlog).toEqual([true])
    await model.barrier()
    expect(model.backlogBytes).toBeLessThan(BACKLOG_LOW_BYTES)
    expect(backlog).toEqual([true, false])
  })

  it('does not flap between the marks', async () => {
    const { model, backlog } = make()
    model.write('a'.repeat(512 * 1024), false)
    expect(backlog).toEqual([])
    await model.barrier()
    expect(backlog).toEqual([])
  })

  it('disposing a model that was holding the PTY resumes it', () => {
    const { model, backlog } = make()
    while (model.backlogBytes <= BACKLOG_HIGH_BYTES) model.write('a'.repeat(64 * 1024), false)
    model.dispose()
    expect(backlog).toEqual([true, false])
  })
})

describe('tombstone text', () => {
  it('is the resolved tail, at most 200 lines', async () => {
    const { model } = make()
    for (let i = 0; i < 300; i++) model.write(`t${i}\r\n`, false)
    const text = await model.tombstoneText()
    const lines = text.split('\n')
    expect(lines).toHaveLength(200)
    expect(lines[lines.length - 1]).toBe('t299')
  })
})
