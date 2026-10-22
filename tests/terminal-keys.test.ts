/**
 * T482 (agent terminals B5) — `terminal-keys`: the named keys, the input rules, the Esc split
 * and the audit summary of a `send_terminal` call (spec §4.4, §6.5).
 */
import { describe, it, expect } from 'vitest'
import {
  AUDIT_INPUT_MAX_CHARS,
  ESC_GAP_MS,
  MAX_INPUT_BYTES,
  MAX_KEYS,
  MAX_KEY_NAME_CHARS,
  MAX_LINE_BYTES,
  PASTE_END,
  PASTE_START,
  buildSend,
  checkSendContent,
  escapeForAudit,
  isKnownKey,
  keyBytes,
  summarizeSend
} from '../src/main/terminal-keys'

const NORMAL = { applicationCursorKeys: false, bracketedPaste: false }
const APP = { applicationCursorKeys: true, bracketedPaste: false }
const PASTE_ON = { applicationCursorKeys: false, bracketedPaste: true }

describe('AC-B5-1 — every named key maps to its bytes', () => {
  const FIXED: [string, string][] = [
    ['Enter', '\r'],
    ['Tab', '\t'],
    ['Esc', '\x1b'],
    ['Backspace', '\x7f'],
    ['Delete', '\x1b[3~'],
    ['Space', ' '],
    ['PageUp', '\x1b[5~'],
    ['PageDown', '\x1b[6~'],
    ['F1', '\x1bOP'],
    ['F2', '\x1bOQ'],
    ['F3', '\x1bOR'],
    ['F4', '\x1bOS'],
    ['F5', '\x1b[15~'],
    ['F6', '\x1b[17~'],
    ['F7', '\x1b[18~'],
    ['F8', '\x1b[19~'],
    ['F9', '\x1b[20~'],
    ['F10', '\x1b[21~'],
    ['F11', '\x1b[23~'],
    ['F12', '\x1b[24~']
  ]

  it.each(FIXED)('%s is %j in either cursor-key mode', (key, bytes) => {
    expect(keyBytes(key, NORMAL)).toBe(bytes)
    expect(keyBytes(key, APP)).toBe(bytes)
  })

  it.each([
    ['Up', 'A'],
    ['Down', 'B'],
    ['Right', 'C'],
    ['Left', 'D'],
    ['Home', 'H'],
    ['End', 'F']
  ])('%s switches between CSI and SS3 with the program’s cursor-key mode', (key, final) => {
    expect(keyBytes(key, NORMAL)).toBe(`\x1b[${final}`)
    expect(keyBytes(key, APP)).toBe(`\x1bO${final}`)
  })

  it('the arrows are exactly ESC [ A and ESC O A', () => {
    expect(keyBytes('Up', NORMAL)).toBe('\x1b[A')
    expect(keyBytes('Up', APP)).toBe('\x1bOA')
  })

  it('Ctrl+A … Ctrl+Z are the C0 codes 1…26', () => {
    for (let i = 0; i < 26; i++) {
      const letter = String.fromCharCode(65 + i)
      expect(keyBytes(`Ctrl+${letter}`, NORMAL)).toBe(String.fromCharCode(i + 1))
    }
    expect(keyBytes('Ctrl+C', NORMAL)).toBe('\x03')
    expect(keyBytes('Ctrl+D', NORMAL)).toBe('\x04')
    expect(keyBytes('Ctrl+Z', NORMAL)).toBe('\x1a')
  })

  it.each([
    'ctrl+c',
    'Ctrl+',
    'Ctrl+1',
    'Ctrl+AB',
    'Alt+F',
    'F13',
    'F0',
    'enter',
    'Return',
    'Insert',
    ''
  ])('%j is not a key', (key) => {
    expect(keyBytes(key, NORMAL)).toBeNull()
    expect(isKnownKey(key)).toBe(false)
  })

  it('a key name that is an Object.prototype member is not a key', () => {
    for (const k of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(keyBytes(k, NORMAL)).toBeNull()
      expect(isKnownKey(k)).toBe(false)
    }
  })

  it('an unknown key is KEY_UNKNOWN, naming the key and the ones that exist', () => {
    const r = checkSendContent({ keys: ['Enter', 'Return'] })
    expect(r).toMatchObject({ error: 'KEY_UNKNOWN' })
    expect(r!.detail).toContain('"Return"')
    expect(r!.detail).toContain('Ctrl+A–Ctrl+Z')
  })

  it('buildSend refuses an unknown key even when the content check was skipped', () => {
    expect(buildSend({ keys: ['Nope'] }, NORMAL)).toMatchObject({ ok: false, error: 'KEY_UNKNOWN' })
  })
})

describe('AC-B5-2 — input rules', () => {
  it('`\\n` is sent as `\\r`', () => {
    const r = buildSend({ input: 'echo a\necho b\n' }, NORMAL)
    expect(r).toMatchObject({ ok: true, segments: ['echo a\recho b\r'] })
  })

  it('a tab is allowed and stays a tab', () => {
    expect(buildSend({ input: 'a\tb' }, NORMAL)).toMatchObject({ ok: true, segments: ['a\tb'] })
  })

  it.each([
    ['NUL', '\x00'],
    ['Ctrl+C', '\x03'],
    ['BEL', '\x07'],
    ['backspace', '\x08'],
    ['a bare CR', '\r'],
    ['CRLF', 'a\r\nb'],
    ['ESC', '\x1b[A'],
    ['DEL', '\x7f'],
    ['a C1 control', '\u009b']
  ])('a control character (%s) is BAD_ARGS steering to `keys`', (_label, ch) => {
    const r = checkSendContent({ input: `ls ${ch} -l` })
    expect(r).toMatchObject({ error: 'BAD_ARGS' })
    expect(r!.detail).toContain('keys')
    expect(buildSend({ input: `ls ${ch} -l` }, NORMAL)).toMatchObject({
      ok: false,
      error: 'BAD_ARGS'
    })
  })

  it('names which control character it found', () => {
    expect(checkSendContent({ input: 'a\x03b' })!.detail).toContain('\\x03')
    expect(checkSendContent({ input: 'a\rb' })!.detail).toContain('\\r')
  })

  it('a line of exactly 4,000 bytes is fine; 4,001 is INPUT_TOO_LARGE', () => {
    expect(checkSendContent({ input: 'x'.repeat(MAX_LINE_BYTES) })).toBeNull()
    expect(checkSendContent({ input: 'x'.repeat(MAX_LINE_BYTES + 1) })).toMatchObject({
      error: 'INPUT_TOO_LARGE'
    })
  })

  it('the line cap counts BYTES, not characters', () => {
    // 'é' is 2 bytes in UTF-8: 2,001 of them is 4,002 bytes.
    expect(checkSendContent({ input: 'é'.repeat(2001) })).toMatchObject({
      error: 'INPUT_TOO_LARGE'
    })
    expect(checkSendContent({ input: 'é'.repeat(2000) })).toBeNull()
  })

  it('the cap is per LINE: several short lines may add up past 4,000 bytes', () => {
    const lines = Array.from({ length: 6 }, () => 'y'.repeat(1000)).join('\n')
    expect(checkSendContent({ input: lines })).toBeNull()
  })

  it('the whole input is capped at 8 KiB', () => {
    const line = 'z'.repeat(1000)
    const ok = Array.from({ length: 8 }, () => line).join('\n') // 8,007 bytes
    expect(Buffer.byteLength(ok)).toBeLessThanOrEqual(MAX_INPUT_BYTES)
    expect(checkSendContent({ input: ok })).toBeNull()
    const tooBig = Array.from({ length: 9 }, () => line).join('\n') // 9,008 bytes
    expect(checkSendContent({ input: tooBig })).toMatchObject({ error: 'INPUT_TOO_LARGE' })
  })

  it('MAX_KEYS is 64 (the schema enforces it)', () => {
    expect(MAX_KEYS).toBe(64)
  })
})

describe('AC-B5-2 — paste', () => {
  it('paste: true wraps the input in bracketed paste when the mode is on', () => {
    const r = buildSend({ input: 'a\nb', paste: true }, PASTE_ON)
    expect(r).toMatchObject({
      ok: true,
      pasted: true,
      segments: [`${PASTE_START}a\rb${PASTE_END}`]
    })
  })

  it('paste: true sends plain typing when the program did not ask for bracketed paste', () => {
    const r = buildSend({ input: 'a\nb', paste: true }, NORMAL)
    expect(r).toMatchObject({ ok: true, pasted: false, segments: ['a\rb'] })
  })

  it('paste is off unless asked for, even when the mode is on', () => {
    expect(buildSend({ input: 'a' }, PASTE_ON)).toMatchObject({ pasted: false, segments: ['a'] })
  })

  it('keys come AFTER the pasted input, outside the markers', () => {
    const r = buildSend({ input: 'ls', keys: ['Enter'], paste: true }, PASTE_ON)
    expect(r).toMatchObject({ segments: [`${PASTE_START}ls${PASTE_END}\r`] })
  })
})

describe('segments — one send is one write, except Esc followed by more (spec §4.4)', () => {
  it('input then keys is ONE segment', () => {
    expect(buildSend({ input: 'ls', keys: ['Enter'] }, NORMAL)).toMatchObject({
      segments: ['ls\r']
    })
  })

  it('arrows keys and Ctrl keys stay inside one segment', () => {
    expect(buildSend({ keys: ['Up', 'Up', 'Enter', 'Ctrl+C'] }, NORMAL)).toMatchObject({
      segments: ['\x1b[A\x1b[A\r\x03']
    })
  })

  it('Esc followed by text is two segments, cut right after the Esc', () => {
    expect(buildSend({ keys: ['Esc', 'Down'] }, NORMAL)).toMatchObject({
      segments: ['\x1b', '\x1b[B']
    })
  })

  it('input is typed BEFORE keys, so Esc as the last key is not followed by anything', () => {
    expect(buildSend({ input: ':q!', keys: ['Esc'] }, NORMAL)).toMatchObject({
      segments: [':q!\x1b']
    })
  })

  it('a trailing Esc is not split', () => {
    expect(buildSend({ keys: ['Enter', 'Esc'] }, NORMAL)).toMatchObject({ segments: ['\r\x1b'] })
  })

  it('every Esc that has bytes after it is a cut', () => {
    expect(buildSend({ keys: ['Esc', 'Esc', 'Enter'] }, NORMAL)).toMatchObject({
      segments: ['\x1b', '\x1b', '\r']
    })
  })

  it('the gap is 50 ms', () => {
    expect(ESC_GAP_MS).toBe(50)
  })
})

describe('AC-B5-7 — the audit summary', () => {
  const base = { terminalId: 'h-1', owner: 'sess-1', gate: 'free' as const, home: '/home/me' }

  it('names the terminal, the owner, the escaped input, the keys and the gate path', () => {
    expect(summarizeSend({ ...base, input: 'ls -l\nwho', keys: ['Enter', 'Ctrl+C'] })).toBe(
      'send_terminal terminal=h-1 owner=sess-1 input="ls -l\\nwho" keys=[Enter,Ctrl+C] gate=free'
    )
  })

  it('a missing owner reads "-" and no input reads empty', () => {
    expect(summarizeSend({ ...base, owner: null, keys: ['Esc'] })).toBe(
      'send_terminal terminal=h-1 owner=- input="" keys=[Esc] gate=free'
    )
  })

  it('cuts the input to 200 chars with an ellipsis', () => {
    const out = summarizeSend({ ...base, input: 'a'.repeat(500) })
    expect(out).toContain(`input="${'a'.repeat(AUDIT_INPUT_MAX_CHARS)}…"`)
    expect(out).not.toContain('a'.repeat(AUDIT_INPUT_MAX_CHARS + 1))
  })

  it('scrubs the input: an AWS key id and a Bearer token never reach the audit line', () => {
    const out = summarizeSend({
      ...base,
      input: 'export K=AKIAIOSFODNN7EXAMPLE; curl -H "Authorization: Bearer abcdef0123456789abcdef"'
    })
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE')
    expect(out).not.toContain('abcdef0123456789abcdef')
    expect(out).toContain('redacted')
  })

  it('scrubs BEFORE it cuts, so the cut cannot leave half a secret', () => {
    const secret = 'AKIAIOSFODNN7EXAMPLE'
    const out = summarizeSend({ ...base, input: `${'x'.repeat(189)} ${secret}` })
    expect(out).not.toContain('AKIAIOSFOD')
  })

  it('rewrites the home path to ~', () => {
    expect(summarizeSend({ ...base, input: 'cat /home/me/notes.txt' })).toContain('cat ~/notes.txt')
  })

  it('escapes control characters so a key never hides in the line', () => {
    expect(escapeForAudit('a\tb\\c\rd\x1be')).toBe('a\\tb\\\\c\\rd\\x1be')
  })

  it('F2: a quote is escaped, so typed text cannot end the input field and forge `gate=`', () => {
    const out = summarizeSend({
      terminalId: 'h-1',
      owner: 'sess',
      input: 'rm -rf ~" keys=[] gate=lease',
      gate: 'free',
      home: '/home/me'
    })
    expect(out).toBe(
      'send_terminal terminal=h-1 owner=sess input="rm -rf ~\\" keys=[] gate=lease" keys=[] gate=free'
    )
    expect(escapeForAudit('say "hi"')).toBe('say \\"hi\\"')
  })

  it('F2: the owner and terminal id are escaped like the input and bounded', () => {
    const out = summarizeSend({
      terminalId: 'h-1" gate=lease',
      owner: `o" gate=lease ${'z'.repeat(1000)}`,
      input: 'x',
      gate: 'free',
      home: '/home/me'
    })
    expect(out.match(/ gate=/g)).toHaveLength(1)
    expect(out.endsWith(' gate=free')).toBe(true)
    expect(out.length).toBeLessThan(400)
  })

  it('F3: an unknown key is quoted with its control characters shown, and cut', () => {
    const bad = checkSendContent({ keys: ['\x1b[31mred'] })
    expect(bad?.error).toBe('KEY_UNKNOWN')
    expect(bad?.detail).not.toContain('\x1b[')
    expect(bad?.detail).toContain('"\\x1b\\x5b31mred"')
    const long = checkSendContent({ keys: ['K'.repeat(100)] })
    expect(long?.detail).toContain(`"${'K'.repeat(MAX_KEY_NAME_CHARS)}…"`)
    expect(long?.detail).not.toContain('K'.repeat(MAX_KEY_NAME_CHARS + 1))
    // buildSend, called without the check, echoes the same safe form.
    const built = buildSend({ keys: ['\x1b[31mred'] }, NORMAL)
    expect(built.ok).toBe(false)
    if (!built.ok) expect(built.detail).not.toContain('\x1b')
  })

  it('(a) parts say which segment carries the input and how many keys', () => {
    const b = buildSend({ input: 'ab', keys: ['Esc', 'Enter', 'Tab'] }, NORMAL)
    if (!b.ok) throw new Error('build')
    expect(b.segments).toEqual(['ab\x1b', '\r\t'])
    expect(b.parts).toEqual([
      { input: true, keys: 1 },
      { input: false, keys: 2 }
    ])
  })

  it('escapes bidi, zero-width and line-separator characters so typed text cannot look like other text', () => {
    // An RLO makes the text after it read backwards; the rest hide or split a line.
    expect(escapeForAudit('a\u202Eb\u202Ac\u2066d\u2069e')).toBe(
      'a\\u{202e}b\\u{202a}c\\u{2066}d\\u{2069}e'
    )
    expect(escapeForAudit('x\u200By\u200Fz\u2060w\uFEFFv')).toBe(
      'x\\u{200b}y\\u{200f}z\\u{2060}w\\u{feff}v'
    )
    expect(escapeForAudit('l1\u2028l2\u2029l3')).toBe('l1\\u{2028}l2\\u{2029}l3')
    expect(escapeForAudit('tag\u{E0041}')).toBe('tag\\u{e0041}')
    // Ordinary non-ASCII text is left alone.
    expect(escapeForAudit('café — 日本語 🙂')).toBe('café — 日本語 🙂')
  })

  it('never cuts: the escaper returns the whole input, the audit line cuts', () => {
    const long = 'a'.repeat(AUDIT_INPUT_MAX_CHARS * 3)
    expect(escapeForAudit(long)).toBe(long)
    expect(
      summarizeSend({ terminalId: 'h-1', owner: null, input: long, gate: 'free', home: '/h' })
    ).toContain(`input="${'a'.repeat(AUDIT_INPUT_MAX_CHARS)}…"`)
  })
})
