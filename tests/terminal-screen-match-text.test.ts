/**
 * T489 (agent terminals B8) — the screen model's half of `waitFor`: where the cursor stood when
 * the send was made (`cursorOffset`), what the pattern may match (`matchText`), the alternate-screen
 * rule (rows that differ from the pre-write snapshot), and the barrier budget a call can pass.
 */
import { describe, it, expect } from 'vitest'
import { Terminal } from '@xterm/headless'
import { ScreenModel } from '../src/main/terminal-screen'
import { matchSurface } from '../src/main/terminal-wait'

function make(size = { cols: 20, rows: 5 }): ScreenModel {
  return new ScreenModel({ ...size, onReply: () => {}, onBacklog: () => {} })
}

/** Feed and wait until the model has parsed it. */
async function feed(m: ScreenModel, data: string): Promise<void> {
  m.write(data, false)
  await m.barrier()
}

describe('prepareSend — where the cursor stood', () => {
  it('reports the prompt in front of the cursor as the offset into the cursor line', async () => {
    const m = make()
    await feed(m, 'old\r\n$ ')
    const prep = await m.prepareSend()
    expect(prep.cursorOffset).toBe(2)
    expect(prep.altRows).toBeNull()
  })

  it('counts the continuation rows above the cursor when the prompt line wrapped', async () => {
    const m = make({ cols: 10, rows: 5 })
    await feed(m, 'a-long-prompt-> ') // 16 chars: wraps after 10
    const prep = await m.prepareSend()
    expect(prep.cursorOffset).toBe(16)
    await feed(m, 'ls\r\nout\r\n')
    const r = await m.matchText({ since: prep.cursor, altRows: null })
    expect(r.ok && r.text).toBe('a-long-prompt-> ls\nout')
  })

  it('is 0 on a fresh screen, and on the alternate screen', async () => {
    const m = make()
    expect((await m.prepareSend()).cursorOffset).toBe(0)
    await feed(m, '\x1b[?1049hvim')
    const prep = await m.prepareSend()
    expect(prep).toMatchObject({ altScreen: true, cursor: null, cursorOffset: 0 })
    expect(prep.altRows).toHaveLength(5)
  })
})

describe('matchText — what a pattern may match', () => {
  it('is the output from the cursor line on, unscrubbed, with the echo still in it', async () => {
    const m = make()
    await feed(m, 'earlier\r\n$ ')
    const prep = await m.prepareSend()
    await feed(m, 'grep failed log\r\nbuild failed: x\r\n$ ')
    const r = await m.matchText({ since: prep.cursor, altRows: prep.altRows })
    expect(r).toMatchObject({ ok: true, altScreen: false })
    if (!r.ok) return
    expect(r.text).not.toContain('earlier')
    // The shell's echo is in the text; the SURFACE strips it (terminal-wait).
    expect(r.text).toContain('grep failed log')
    const surface = matchSurface(r.text, prep.cursorOffset, 'grep failed log')
    expect(surface).toBe('build failed: x\n$ ')
  })

  it('takes no cursor, so polling it never evicts the send cursor', async () => {
    const m = make()
    const prep = await m.prepareSend()
    for (let i = 0; i < 80; i++) {
      await feed(m, `line ${i}\r\n`)
      await m.matchText({ since: prep.cursor, altRows: null })
    }
    const r = await m.read({ mode: 'since', since: prep.cursor! })
    expect(r.ok).toBe(true)
  })

  it('an expired cursor says so (the caller falls back to the tail)', async () => {
    const m = make()
    const r = await m.matchText({ since: 'm999', altRows: null })
    expect(r).toEqual({ ok: false })
    expect(await m.matchText({ since: null, altRows: null })).toEqual({ ok: false })
  })

  it('does not choke on the screen scrolling past the cursor line', async () => {
    const m = make()
    await feed(m, '$ ')
    const prep = await m.prepareSend()
    await feed(m, `${Array.from({ length: 30 }, (_, i) => `row ${i}`).join('\r\n')}\r\nneedle\r\n`)
    const r = await m.matchText({ since: prep.cursor, altRows: null })
    expect(r.ok && r.text).toContain('needle')
  })
})

describe('alternate screen — the rows the program changed', () => {
  it('matches only rows that differ from the pre-write snapshot', async () => {
    const m = make()
    await feed(m, '\x1b[?1049h\x1b[Hmenu: [y/N]\x1b[2;1Hstatus: ready')
    const prep = await m.prepareSend()
    expect(prep.altScreen).toBe(true)
    // The program repaints row 2 only.
    await feed(m, '\x1b[2;1H\x1b[Kstatus: 3 passed')
    const r = await m.matchText({ since: null, altRows: prep.altRows })
    expect(r).toMatchObject({ ok: true, altScreen: true, text: 'status: 3 passed' })
  })

  it('text that was already on the screen before the write is not a match', async () => {
    const m = make()
    await feed(m, '\x1b[?1049h\x1b[Hdone: 3 passed')
    const prep = await m.prepareSend()
    const r = await m.matchText({ since: null, altRows: prep.altRows })
    expect(r).toMatchObject({ ok: true, text: '' })
  })

  it('a program that entered the alternate screen after the send: the whole screen', async () => {
    const m = make()
    await feed(m, '$ ')
    const prep = await m.prepareSend()
    await feed(m, 'vim\r\n\x1b[?1049h\x1b[Hwelcome to vim')
    const r = await m.matchText({ since: prep.cursor, altRows: prep.altRows })
    expect(r).toMatchObject({ ok: true, altScreen: true, text: 'welcome to vim' })
  })
})

describe('barrier budget — a stalled model cannot hold a call past its deadline', () => {
  it('read() honours barrierMs and answers approximate', async () => {
    const stall = { on: false }
    const stalled = new ScreenModel({
      cols: 20,
      rows: 5,
      onReply: () => {},
      onBacklog: () => {},
      createTerminal: (o) => {
        const t = new Terminal({ ...o, allowProposedApi: true })
        const write = t.write.bind(t)
        t.write = ((d: string | Uint8Array, cb?: () => void) =>
          stall.on ? undefined : write(d, cb)) as typeof t.write
        return t
      }
    })
    stalled.write('hello\r\n', false)
    stall.on = true
    stalled.write('more\r\n', false) // never parsed: the barrier cannot clear
    const t0 = Date.now()
    const r = await stalled.read({ mode: 'tail', barrierMs: 60 })
    expect(Date.now() - t0).toBeLessThan(500)
    expect(r.ok && r.approximate).toBe(true)
  })
})

describe('a prompt that erases itself on Enter (powerlevel10k transient prompt, fish)', () => {
  /** The bytes a real zsh+p10k sent for `echo hello`: up two rows, erase to the end, redraw. */
  const ENTER_ERASES =
    '\r\r\x1b[A\x1b[A\x1b[J❯ echo hello\x1b[K\r\r\nhello\r\n\r\n  ~/proj  main\r\n❯ '

  it('the echo moves ABOVE the cursor row and the send mark still finds it', async () => {
    const m = make({ cols: 60, rows: 12 })
    await feed(m, 'earlier output\r\n\r\n  ~/proj  main\r\n❯ ')
    const prep = await m.prepareSend()
    expect(prep.cursor).not.toBeNull()
    await feed(m, 'echo hello')
    await feed(m, ENTER_ERASES)
    const r = await m.read({ mode: 'since', since: prep.cursor! })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // From the row the erased block began on: the echo is in, the earlier output is not.
    expect(r.text).toContain('❯ echo hello')
    expect(r.text).toContain('hello\n')
    expect(r.text).not.toContain('earlier output')
    const t = await m.matchText({ since: prep.cursor, altRows: null })
    expect(t).toMatchObject({ ok: true, onCursorRow: false })
    if (!t.ok) return
    expect(matchSurface(t.text, 0, 'echo hello').startsWith('hello')).toBe(true)
  })

  it('an ordinary prompt keeps the mark on the cursor row', async () => {
    const m = make({ cols: 60, rows: 12 })
    await feed(m, '$ ')
    const prep = await m.prepareSend()
    await feed(m, 'echo hi\r\nhi\r\n$ ')
    const t = await m.matchText({ since: prep.cursor, altRows: null })
    expect(t).toMatchObject({ ok: true, onCursorRow: true })
  })

  it("a mark whose rows all scrolled away is gone: CURSOR_EXPIRED, not somebody else's output", async () => {
    const m = make({ cols: 20, rows: 5 })
    await feed(m, '$ ')
    const prep = await m.prepareSend()
    await feed(m, `${'x\r\n'.repeat(2600)}`) // far past the 2,000-line scrollback
    expect(await m.matchText({ since: prep.cursor, altRows: null })).toEqual({ ok: false })
    expect(await m.read({ mode: 'since', since: prep.cursor! })).toEqual({
      ok: false,
      error: 'CURSOR_EXPIRED'
    })
  })
})
