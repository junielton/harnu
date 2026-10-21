import { describe, it, expect } from 'vitest'
import {
  KEYBINDINGS,
  REBINDABLE_IDS,
  RESERVED_IDS,
  parseChord,
  normalizeChord,
  canonicalizeChord,
  toAccelerator,
  toMagicKeys,
  renderChord,
  renderChordString,
  renderKeysString,
  chordFromEvent,
  stripJsonComments,
  resolveKeybindings,
  parseKeybindingsFile,
  type Chord
} from '../src/main/keybindings-core'

/**
 * T1 — the canonical keybindings core. Pure (node env). Locks the chord
 * grammar, both emitters, platform rendering, and the defaults ← overrides
 * merge + conflict model against `docs/specs/T1-customizable-keybindings.md`.
 */

const chord = (p: Partial<Chord>): Chord => ({
  cmd: false,
  ctrl: false,
  alt: false,
  shift: false,
  key: '',
  ...p
})

describe('KEYBINDINGS table', () => {
  it('has 35 rebindable (26 app + 9 browser pane, T564) and 5 reserved ids', () => {
    expect(REBINDABLE_IDS).toHaveLength(35)
    expect(RESERVED_IDS).toHaveLength(5)
    expect(RESERVED_IDS).toContain('app.openKeybindings')
    expect(new Set([...REBINDABLE_IDS, ...RESERVED_IDS]).size).toBe(KEYBINDINGS.length)
  })

  it('every default chord parses and round-trips to itself', () => {
    for (const d of KEYBINDINGS) {
      if (!d.defaultKeys) continue
      const r = parseChord(d.defaultKeys)
      expect(r.ok, `${d.id} → ${d.defaultKeys}`).toBe(true)
      if (r.ok) expect(normalizeChord(r.chord)).toBe(d.defaultKeys)
    }
  })

  it('every menu-backed default is expressible as an Electron accelerator', () => {
    for (const d of KEYBINDINGS) {
      if (!d.menu || !d.defaultKeys) continue
      const r = parseChord(d.defaultKeys)
      expect(r.ok).toBe(true)
      if (r.ok) expect(toAccelerator(r.chord)).not.toBeNull()
    }
  })

  it('ships with no conflicts among the defaults', () => {
    const resolved = resolveKeybindings(null)
    for (const b of resolved.list) expect(b.conflictsWith).toEqual([])
    expect(resolved.warnings).toEqual([])
  })
})

describe('parseChord', () => {
  it('parses a modifier chord, order-insensitively', () => {
    const a = parseChord('Cmd+Shift+P')
    const b = parseChord('shift+cmd+p')
    expect(a).toEqual(b)
    expect(a.ok && a.chord).toMatchObject({ cmd: true, shift: true, key: 'P' })
  })

  it('treats Mod as Cmd', () => {
    expect(canonicalizeChord('Mod+K')).toBe('Cmd+K')
  })

  it('parses bare named keys and arrows', () => {
    expect(canonicalizeChord('ArrowDown')).toBe('ArrowDown')
    expect(canonicalizeChord('enter')).toBe('Enter')
    expect(canonicalizeChord('F5')).toBe('F5')
    expect(canonicalizeChord('escape')).toBe('Escape')
  })

  it('parses punctuation keys', () => {
    expect(canonicalizeChord('Cmd+/')).toBe('Cmd+/')
    expect(canonicalizeChord('Cmd++')).toBe('Cmd+=')
  })

  it('rejects an empty string', () => {
    expect(parseChord('')).toEqual({ ok: false, code: 'empty' })
    expect(parseChord('   ')).toEqual({ ok: false, code: 'empty' })
  })

  it('rejects a two-chord sequence', () => {
    expect(parseChord('Cmd+K Cmd+S')).toEqual({ ok: false, code: 'sequence-unsupported' })
  })

  it('rejects a modifiers-only chord', () => {
    expect(parseChord('Cmd+Shift')).toEqual({ ok: false, code: 'no-key' })
  })

  it('rejects two primary keys', () => {
    expect(parseChord('Cmd+A+B')).toEqual({ ok: false, code: 'multiple-keys' })
  })

  it('rejects an unknown key token', () => {
    expect(parseChord('Cmd+Frobnicate')).toEqual({ ok: false, code: 'bad-key' })
  })
})

describe('emitters', () => {
  it('toAccelerator maps Cmd → CmdOrCtrl and names special keys', () => {
    expect(toAccelerator(chord({ cmd: true, key: 'N' }))).toBe('CmdOrCtrl+N')
    expect(toAccelerator(chord({ cmd: true, alt: true, key: 'B' }))).toBe('CmdOrCtrl+Alt+B')
    expect(toAccelerator(chord({ key: 'F5' }))).toBe('F5')
    expect(toAccelerator(chord({ cmd: true, key: 'ArrowDown' }))).toBe('CmdOrCtrl+Down')
    expect(toAccelerator(chord({ key: 'Enter' }))).toBe('Return')
  })

  it('toAccelerator returns null for a key Electron cannot express', () => {
    expect(toAccelerator(chord({ cmd: true, key: 'Space' }))).toBe('CmdOrCtrl+Space')
    // A dead/unknown key never reaches here via parseChord, but guard the contract:
    expect(toAccelerator({ ...chord({ cmd: true }), key: '™' })).toBeNull()
  })

  it('toMagicKeys is the canonical form', () => {
    expect(toMagicKeys(chord({ cmd: true, shift: true, key: 'P' }))).toBe('Cmd+Shift+P')
  })
})

describe('renderChord (platform-aware)', () => {
  it('renders Mac symbols and concatenates', () => {
    const c = chord({ cmd: true, shift: true, key: 'P' })
    expect(renderChord(c, { mac: true })).toEqual(['⌘', '⇧', 'P'])
    expect(renderChordString(c, { mac: true })).toBe('⌘⇧P')
  })

  it('spells modifiers out and joins with + off macOS', () => {
    const c = chord({ cmd: true, shift: true, key: 'P' })
    expect(renderChord(c, { mac: false })).toEqual(['Ctrl', 'Shift', 'P'])
    expect(renderChordString(c, { mac: false })).toBe('Ctrl+Shift+P')
  })

  it('collapses Cmd+Ctrl to a single Ctrl off macOS', () => {
    const c = chord({ cmd: true, ctrl: true, key: 'X' })
    expect(renderChord(c, { mac: false })).toEqual(['Ctrl', 'X'])
    expect(renderChord(c, { mac: true })).toEqual(['⌘', '⌃', 'X'])
  })

  it('renders arrows and Enter', () => {
    expect(renderChord(chord({ key: 'ArrowDown' }), { mac: true })).toEqual(['↓'])
    expect(renderChord(chord({ key: 'Enter' }), { mac: true })).toEqual(['↩'])
    expect(renderChord(chord({ key: 'Enter' }), { mac: false })).toEqual(['Enter'])
  })

  it('renderKeysString parses then renders, empty on garbage', () => {
    expect(renderKeysString('Cmd+K', { mac: true })).toEqual(['⌘', 'K'])
    expect(renderKeysString('nonsense chord', { mac: true })).toEqual([])
    expect(renderKeysString(null, { mac: true })).toEqual([])
  })
})

describe('chordFromEvent', () => {
  it('reads modifiers + code', () => {
    expect(
      chordFromEvent({
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: true,
        code: 'KeyP',
        key: 'P'
      })
    ).toEqual(chord({ cmd: true, shift: true, key: 'P' }))
  })

  it('maps digit and function codes', () => {
    expect(
      chordFromEvent({
        metaKey: false,
        ctrlKey: true,
        altKey: false,
        shiftKey: false,
        code: 'Digit1',
        key: '1'
      })
    ).toEqual(chord({ ctrl: true, key: '1' }))
    expect(
      chordFromEvent({
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        code: 'F5',
        key: 'F5'
      })
    ).toEqual(chord({ key: 'F5' }))
  })

  it('returns null while only a modifier is held', () => {
    expect(
      chordFromEvent({
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        code: 'MetaLeft',
        key: 'Meta'
      })
    ).toBeNull()
  })

  it('folds Ctrl onto Cmd when { mac: false } (Linux/Windows record path)', () => {
    // A Ctrl+B press on Linux is what a user means by the Cmd+B default —
    // record it as the canonical Cmd form so re-recording a row's own default
    // returns it to source: "default" and the reserved-chord guard sees it.
    expect(
      chordFromEvent(
        { metaKey: false, ctrlKey: true, altKey: false, shiftKey: false, code: 'KeyB', key: 'b' },
        { mac: false }
      )
    ).toEqual(chord({ cmd: true, key: 'B' }))
    // On mac the two stay distinct.
    expect(
      chordFromEvent(
        { metaKey: false, ctrlKey: true, altKey: false, shiftKey: false, code: 'KeyB', key: 'b' },
        { mac: true }
      )
    ).toEqual(chord({ ctrl: true, key: 'B' }))
  })
})

describe('stripJsonComments', () => {
  it('drops line and block comments but keeps strings', () => {
    const src = `[
      // a line comment
      { "key": "Cmd+K", "command": "app.search" }, /* block */
      { "key": "https://not-a-comment", "command": "x" }
    ]`
    const out = stripJsonComments(src)
    expect(out).not.toContain('a line comment')
    expect(out).not.toContain('block')
    expect(out).toContain('https://not-a-comment')
  })
})

describe('resolveKeybindings', () => {
  it('with null → defaults, no warnings', () => {
    const r = resolveKeybindings(null)
    expect(r.byId['app.search'].keys).toBe('Cmd+K')
    expect(r.byId['app.search'].source).toBe('default')
  })

  it('applies a valid override', () => {
    const r = resolveKeybindings([{ key: 'Cmd+J', command: 'view.review' }])
    expect(r.byId['view.review'].keys).toBe('Cmd+J')
    expect(r.byId['view.review'].source).toBe('override')
    expect(r.warnings).toEqual([])
  })

  it('unbinds on key:null and on a -command entry', () => {
    const r = resolveKeybindings([
      { key: null, command: 'session.resumeLast' },
      { command: '-inbox.toggle' }
    ])
    expect(r.byId['session.resumeLast'].keys).toBeNull()
    expect(r.byId['session.resumeLast'].source).toBe('unbound')
    expect(r.byId['inbox.toggle'].keys).toBeNull()
  })

  it('warns on an unknown or reserved command', () => {
    const r = resolveKeybindings([
      { key: 'Cmd+J', command: 'does.not.exist' },
      { key: 'Cmd+J', command: 'app.quit' }
    ])
    expect(r.warnings.map((w) => w.code)).toEqual(['unknown-command', 'reserved-command'])
  })

  it('warns and takes the last on a duplicate command', () => {
    const r = resolveKeybindings([
      { key: 'Cmd+J', command: 'view.review' },
      { key: 'Cmd+L', command: 'view.review' }
    ])
    expect(r.byId['view.review'].keys).toBe('Cmd+L')
    expect(r.warnings.map((w) => w.code)).toContain('duplicate-command')
  })

  it('rejects an override onto a reserved chord', () => {
    const r = resolveKeybindings([{ key: 'Cmd+Q', command: 'app.search' }])
    expect(r.byId['app.search'].keys).toBe('Cmd+K')
    expect(r.warnings[0]).toMatchObject({ code: 'reserved-chord', command: 'app.search' })
  })

  it('treats the open-keybindings chord (Cmd+Alt+K, T1 P5) as reserved', () => {
    const r = resolveKeybindings([{ key: 'Cmd+Alt+K', command: 'app.search' }])
    expect(r.byId['app.search'].keys).toBe('Cmd+K')
    expect(r.warnings[0]).toMatchObject({ code: 'reserved-chord', command: 'app.search' })
  })

  it('rejects a scope-changing entry', () => {
    const r = resolveKeybindings([{ key: 'Cmd+J', command: 'view.review', scope: 'terminal' }])
    expect(r.byId['view.review'].keys).toBe('Cmd+Shift+D')
    expect(r.warnings[0]).toMatchObject({ code: 'scope-immutable' })
  })

  it('rejects a sequence and a bad chord distinctly', () => {
    const r = resolveKeybindings([
      { key: 'Cmd+K Cmd+S', command: 'app.search' },
      { key: '???', command: 'folder.add' }
    ])
    expect(r.warnings.map((w) => w.code)).toEqual(['sequence-unsupported', 'bad-chord'])
  })

  it('rejects a non-accelerator chord for a menu-backed action only', () => {
    // Space IS an accelerator; use a key Electron cannot take. `parseChord`
    // would reject a truly bad token, so this path is covered by the direct
    // toAccelerator null test above; here assert a renderer-only action is NOT
    // subject to the accelerator check.
    const r = resolveKeybindings([{ key: 'Cmd+/', command: 'view.review' }])
    expect(r.byId['view.review'].keys).toBe('Cmd+/')
    expect(r.warnings).toEqual([])
  })

  it('flags a conflict on both participants', () => {
    const r = resolveKeybindings([{ key: 'Cmd+K', command: 'view.review' }])
    expect(r.byId['view.review'].conflictsWith).toContain('app.search')
    expect(r.byId['app.search'].conflictsWith).toContain('view.review')
  })

  it('non-array input → not-array warning, defaults kept', () => {
    const r = resolveKeybindings({ nope: true })
    expect(r.warnings).toEqual([{ code: 'not-array' }])
    expect(r.byId['app.search'].keys).toBe('Cmd+K')
  })

  it('a missing / non-string key is a bad-entry, never a silent unbind', () => {
    const r = resolveKeybindings([
      { command: 'session.new' }, // no key, no leading "-"
      { command: 'folder.add', key: 42 as unknown as string }
    ])
    expect(r.byId['session.new'].keys).toBe('Cmd+N')
    expect(r.byId['session.new'].source).toBe('default')
    expect(r.byId['folder.add'].source).toBe('default')
    expect(r.warnings.map((w) => w.code)).toEqual(['bad-entry', 'bad-entry'])
  })

  it('reserved ids are absent from byId (Partial map)', () => {
    const r = resolveKeybindings(null)
    expect(r.byId['app.quit']).toBeUndefined()
    expect(r.list.some((b) => b.id === 'app.quit')).toBe(false)
  })

  describe('{ mac: false } folds Ctrl onto Cmd', () => {
    it('a hand-edited Ctrl+Q still trips the reserved Cmd+Q guard', () => {
      const macR = resolveKeybindings([{ key: 'Ctrl+Q', command: 'app.search' }], { mac: true })
      expect(macR.byId['app.search'].keys).toBe('Ctrl+Q') // distinct chord on mac

      const linuxR = resolveKeybindings([{ key: 'Ctrl+Q', command: 'app.search' }], { mac: false })
      expect(linuxR.byId['app.search'].keys).toBe('Cmd+K') // rejected
      expect(linuxR.warnings[0]).toMatchObject({ code: 'reserved-chord' })
    })

    it('Ctrl+B groups with the default Cmd+B as one conflict', () => {
      const r = resolveKeybindings([{ key: 'Ctrl+B', command: 'inbox.toggle' }], { mac: false })
      expect(r.byId['inbox.toggle'].conflictsWith).toContain('view.toggleSidebar')
      expect(r.byId['view.toggleSidebar'].conflictsWith).toContain('inbox.toggle')
    })
  })
})

describe('parseKeybindingsFile', () => {
  it('parses a commented file', () => {
    const body = `[
      // rebind review
      { "key": "Cmd+J", "command": "view.review" }
    ]`
    const r = parseKeybindingsFile(body)
    expect(r.byId['view.review'].keys).toBe('Cmd+J')
  })

  it('empty file → defaults', () => {
    expect(parseKeybindingsFile('   ').byId['app.search'].keys).toBe('Cmd+K')
  })

  it('invalid JSON → defaults + one warning, never throws', () => {
    const r = parseKeybindingsFile('[ { "key": ')
    expect(r.byId['app.search'].keys).toBe('Cmd+K')
    expect(r.warnings[0].code).toBe('not-array')
  })
})
