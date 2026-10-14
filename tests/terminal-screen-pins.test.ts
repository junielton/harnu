/* eslint-disable no-control-regex -- the assertions match terminal escape replies (ESC [ …) */
// AC-B3-1 — pins the five `@xterm/headless@6.0.0` behaviours that spec §5.3
// builds the screen model on. These tests talk to the library alone (no Harnu
// code): if one fails, the spec is wrong and must be amended before any verb
// code lands.
import { describe, it, expect } from 'vitest'
import { Terminal } from '@xterm/headless'

/** `Terminal.write` is async; resolve once the chunk has been parsed. */
function write(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve))
}

function mk(opts: { cols?: number; rows?: number; scrollback?: number } = {}): Terminal {
  return new Terminal({
    cols: opts.cols ?? 20,
    rows: opts.rows ?? 5,
    scrollback: opts.scrollback ?? 10,
    allowProposedApi: true
  })
}

describe('@xterm/headless pins (spec §5.3)', () => {
  it('1. registerMarker tracks a live line and flips isDisposed when the line is trimmed', async () => {
    const term = mk({ rows: 3, scrollback: 3 })
    await write(term, 'first\r\n')
    const marker = term.registerMarker(0)
    expect(marker).toBeDefined()
    expect(marker!.isDisposed).toBe(false)
    const startLine = marker!.line
    // The line scrolls into scrollback but the marker follows it.
    await write(term, 'a\r\nb\r\nc\r\n')
    expect(marker!.isDisposed).toBe(false)
    // The marker sat on the (then blank) line after `first`; `a` is written there.
    expect(term.buffer.active.getLine(marker!.line)?.translateToString(true)).toBe('a')
    expect(marker!.line).toBe(startLine) // absolute line index is stable until trimmed
    // Flood past the scrollback cap: the line is trimmed and the marker reports it.
    for (let i = 0; i < 20; i++) await write(term, `flood ${i}\r\n`)
    expect(marker!.isDisposed).toBe(true)
    expect(marker!.line).toBe(-1)
    term.dispose()
  })

  it('1b. registerMarker is unavailable on the alternate screen', async () => {
    const term = mk()
    await write(term, '\x1b[?1049h')
    expect(term.buffer.active.type).toBe('alternate')
    expect(term.registerMarker(0)).toBeUndefined()
    term.dispose()
  })

  it('2. buffer.active exposes isWrapped per line and translateToString(true)', async () => {
    const term = mk({ cols: 10, rows: 5 })
    await write(term, 'abcdefghijklmnopqrstuvwxyz\r\nshort')
    const buf = term.buffer.active
    expect(buf.getLine(0)!.isWrapped).toBe(false)
    expect(buf.getLine(1)!.isWrapped).toBe(true)
    expect(buf.getLine(2)!.isWrapped).toBe(true)
    expect(buf.getLine(3)!.isWrapped).toBe(false)
    // trimRight = true drops the blank cell padding.
    expect(buf.getLine(3)!.translateToString(true)).toBe('short')
    expect(buf.getLine(3)!.translateToString(false)).toBe('short     ')
    term.dispose()
  })

  it('3. modes.applicationCursorKeysMode and modes.bracketedPasteMode are readable', async () => {
    const term = mk()
    expect(term.modes.applicationCursorKeysMode).toBe(false)
    expect(term.modes.bracketedPasteMode).toBe(false)
    await write(term, '\x1b[?1h\x1b[?2004h')
    expect(term.modes.applicationCursorKeysMode).toBe(true)
    expect(term.modes.bracketedPasteMode).toBe(true)
    await write(term, '\x1b[?1l\x1b[?2004l')
    expect(term.modes.applicationCursorKeysMode).toBe(false)
    expect(term.modes.bracketedPasteMode).toBe(false)
    term.dispose()
  })

  it('4. resize() reflows without losing markers: they keep following their line', async () => {
    const term = mk({ cols: 20, rows: 5, scrollback: 50 })
    await write(term, '0123456789ABCDEFGHIJKLMNO\r\nline two\r\n') // first line wraps at 20 cols
    const marker = term.registerMarker(-1)! // sits on "line two"
    const lineAt = (m: { line: number }): string | undefined =>
      term.buffer.active.getLine(m.line)?.translateToString(true)
    expect(lineAt(marker)).toBe('line two')
    term.resize(10, 5) // reflow: the first line now wraps to three rows
    expect(marker.isDisposed).toBe(false)
    expect(lineAt(marker)).toBe('line two')
    term.resize(40, 5) // reflow back: the wrapped line re-joins, marker shifts up
    expect(marker.isDisposed).toBe(false)
    expect(lineAt(marker)).toBe('line two')
    term.dispose()
  })

  it('5. the model emits terminal-query replies through onData', async () => {
    const term = mk()
    const replies: string[] = []
    term.onData((d) => replies.push(d))
    // DSR 5n (status), DSR 6n (cursor position), DA1.
    await write(term, 'hi\x1b[5n\x1b[6n\x1b[c')
    expect(replies).toContain('\x1b[0n')
    expect(replies.some((r) => /^\x1b\[\d+;\d+R$/.test(r))).toBe(true)
    expect(replies.some((r) => /^\x1b\[\?[\d;]+c$/.test(r))).toBe(true)
    term.dispose()
  })
})
