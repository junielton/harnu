import { describe, it, expect } from 'vitest'
import {
  CUSTOM_EDITOR_ID,
  DEFAULT_EDITOR_SETTING,
  EDITOR_PRESETS,
  editorDisplayName,
  effectiveEditorSetting,
  fillPath,
  findPreset,
  parseCommandTemplate,
  pickAttempt,
  planEditorLaunch,
  presetCandidates,
  sanitizeEditorSetting
} from '../src/main/editor-launch'

/**
 * T581 — the pure half of "Open in editor": the command-template parser (AC-4,
 * AC-7), preset candidate resolution per platform (AC-1, AC-2, AC-7), terminal
 * candidate picking (AC-3) and the settings sanitizer.
 */

describe('parseCommandTemplate', () => {
  it('splits bare words on whitespace', () => {
    expect(parseCommandTemplate('foo --bar {path}')).toEqual({
      ok: true,
      tokens: ['foo', '--bar', '{path}']
    })
  })

  it('keeps quoted segments together', () => {
    expect(parseCommandTemplate(`"/opt/My Editor/ed" --flag 'a b' {path}`)).toEqual({
      ok: true,
      tokens: ['/opt/My Editor/ed', '--flag', 'a b', '{path}']
    })
  })

  it('honours \\" and \\\\ inside double quotes, but not a bare backslash', () => {
    expect(parseCommandTemplate('"a\\"b" "c\\\\d"')).toEqual({ ok: true, tokens: ['a"b', 'c\\d'] })
    expect(parseCommandTemplate('C:\\tools\\nvim.exe {path}')).toEqual({
      ok: true,
      tokens: ['C:\\tools\\nvim.exe', '{path}']
    })
  })

  it('treats shell operators and expansions as ordinary characters', () => {
    expect(parseCommandTemplate('ed ; rm -rf $HOME `id` | cat && x {path}')).toEqual({
      ok: true,
      tokens: ['ed', ';', 'rm', '-rf', '$HOME', '`id`', '|', 'cat', '&&', 'x', '{path}']
    })
  })

  it('keeps an empty quoted argument as a token', () => {
    expect(parseCommandTemplate(`ed "" {path}`)).toEqual({ ok: true, tokens: ['ed', '', '{path}'] })
  })

  it('rejects empty and unterminated input', () => {
    expect(parseCommandTemplate('')).toEqual({ ok: false, reason: 'empty' })
    expect(parseCommandTemplate('   \t ')).toEqual({ ok: false, reason: 'empty' })
    expect(parseCommandTemplate('ed "oops {path}')).toEqual({
      ok: false,
      reason: 'unterminated-quote'
    })
  })
})

describe('fillPath', () => {
  it('puts the path in one argv entry even with spaces and quotes', () => {
    const p = `/tmp/my "odd" folder/it's`
    expect(fillPath(['--bar', '{path}'], p)).toEqual(['--bar', p])
  })

  it('splices into a token that merely contains the placeholder', () => {
    expect(fillPath(['--folder={path}'], '/a b')).toEqual(['--folder=/a b'])
  })

  it('appends the path when the template has no placeholder', () => {
    expect(fillPath(['--wait'], '/a')).toEqual(['--wait', '/a'])
  })

  it('never lets a leading "-" read as a flag', () => {
    expect(fillPath(['{path}'], '-rf')).toEqual(['./-rf'])
    expect(fillPath(['{path}'], '/abs/-rf')).toEqual(['/abs/-rf'])
  })

  it('keeps replacement patterns in the path literal', () => {
    expect(fillPath(['{path}'], '/a/$&/b')).toEqual(['/a/$&/b'])
  })
})

describe('presets', () => {
  it('declares every preset the card lists, with a unique id', () => {
    const ids = EDITOR_PRESETS.map((p) => p.id)
    expect(ids).toEqual(['vscode', 'cursor', 'zed', 'sublime', 'jetbrains', 'neovim', 'helix'])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('marks Neovim and Helix as terminal editors and the rest as GUI', () => {
    expect(EDITOR_PRESETS.filter((p) => p.mode === 'terminal').map((p) => p.id)).toEqual([
      'neovim',
      'helix'
    ])
  })

  it('every preset has candidates on every platform and one {path} in its args', () => {
    for (const p of EDITOR_PRESETS) {
      for (const platform of ['linux', 'darwin', 'win32'] as const) {
        expect(presetCandidates(p, platform).length).toBeGreaterThan(0)
      }
      expect(p.args.filter((a) => a.includes('{path}'))).toHaveLength(1)
    }
  })

  it('VS Code: plain `code` off darwin, absolute fallbacks on darwin (as before T581)', () => {
    const vscode = findPreset('vscode')!
    expect(presetCandidates(vscode, 'linux')).toEqual(['code'])
    expect(presetCandidates(vscode, 'win32')).toEqual(['code'])
    expect(presetCandidates(vscode, 'darwin')).toEqual([
      'code',
      '/usr/local/bin/code',
      '/opt/homebrew/bin/code',
      '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
      '/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code'
    ])
  })

  it('platform-specific lists win over the default list', () => {
    const zed = findPreset('zed')!
    expect(presetCandidates(zed, 'linux')).toContain('zeditor')
    expect(presetCandidates(zed, 'win32')).toEqual(['zed'])
    expect(presetCandidates(findPreset('helix')!, 'linux')).toEqual(['hx', 'helix'])
  })
})

describe('planEditorLaunch', () => {
  it('default setting launches `code -- <path>` exactly like the old button (AC-1)', () => {
    const r = planEditorLaunch(DEFAULT_EDITOR_SETTING, 'linux', '/w/proj')
    expect(r).toEqual({
      ok: true,
      plan: {
        editorId: 'vscode',
        name: 'VS Code',
        mode: 'gui',
        attempts: [{ cmd: 'code', args: ['--', '/w/proj'] }]
      }
    })
  })

  it('a GUI preset changes the launched binary (AC-2)', () => {
    const r = planEditorLaunch({ id: 'cursor' }, 'linux', '/w/proj')
    expect(r.ok && r.plan.attempts[0]).toEqual({ cmd: 'cursor', args: ['--', '/w/proj'] })
    const z = planEditorLaunch({ id: 'zed' }, 'linux', '/w/proj')
    expect(z.ok && z.plan.attempts.map((a) => a.cmd)).toEqual(['zed', 'zeditor', 'zed-editor'])
  })

  it('Neovim plans a terminal launch (AC-3)', () => {
    const r = planEditorLaunch({ id: 'neovim' }, 'linux', '/w/proj')
    expect(r.ok && r.plan.mode).toBe('terminal')
    expect(r.ok && r.plan.attempts).toEqual([{ cmd: 'nvim', args: ['/w/proj'] }])
  })

  it('custom `foo --bar {path}` launches foo with argv [--bar, <path>] (AC-4)', () => {
    const r = planEditorLaunch(
      { id: CUSTOM_EDITOR_ID, customCommand: 'foo --bar {path}' },
      'linux',
      '/w/my proj'
    )
    expect(r.ok && r.plan.attempts).toEqual([{ cmd: 'foo', args: ['--bar', '/w/my proj'] }])
    expect(r.ok && r.plan.mode).toBe('gui')
  })

  it('custom: a path with spaces or a leading "-" stays one safe argv entry (AC-4)', () => {
    const spaced = planEditorLaunch(
      { id: CUSTOM_EDITOR_ID, customCommand: 'foo --bar {path}' },
      'linux',
      '/w/a b  c'
    )
    expect(spaced.ok && spaced.plan.attempts[0].args).toEqual(['--bar', '/w/a b  c'])
    const dashed = planEditorLaunch(
      { id: CUSTOM_EDITOR_ID, customCommand: 'foo {path}' },
      'linux',
      '-x'
    )
    expect(dashed.ok && dashed.plan.attempts[0].args).toEqual(['./-x'])
  })

  it('custom with the terminal toggle plans a terminal launch', () => {
    const r = planEditorLaunch(
      { id: CUSTOM_EDITOR_ID, customCommand: 'nvim {path}', customTerminal: true },
      'linux',
      '/w'
    )
    expect(r.ok && r.plan.mode).toBe('terminal')
  })

  it('custom with no {path} appends the path', () => {
    const r = planEditorLaunch({ id: CUSTOM_EDITOR_ID, customCommand: 'foo --wait' }, 'linux', '/w')
    expect(r.ok && r.plan.attempts[0].args).toEqual(['--wait', '/w'])
  })

  it('custom: empty, unterminated, or placeholder-as-executable commands are bad-command', () => {
    for (const customCommand of ['', '   ', '"foo {path}', '{path} --x']) {
      expect(planEditorLaunch({ id: CUSTOM_EDITOR_ID, customCommand }, 'linux', '/w')).toEqual({
        ok: false,
        error: 'bad-command'
      })
    }
  })
})

describe('pickAttempt', () => {
  const attempts = [
    { cmd: 'hx', args: ['/w'] },
    { cmd: 'helix', args: ['/w'] }
  ]
  it('returns the first executable candidate', () => {
    expect(pickAttempt(attempts, (c) => c === 'helix')).toEqual(attempts[1])
    expect(pickAttempt(attempts, () => true)).toEqual(attempts[0])
  })
  it('returns null when none is found', () => {
    expect(pickAttempt(attempts, () => false)).toBeNull()
  })
})

describe('sanitizeEditorSetting / effectiveEditorSetting', () => {
  it('accepts a known preset and drops stray custom fields', () => {
    expect(sanitizeEditorSetting({ id: 'zed', customCommand: 'x' })).toEqual({ id: 'zed' })
  })

  it('accepts custom, trimming the command and coercing the toggle', () => {
    expect(
      sanitizeEditorSetting({ id: 'custom', customCommand: '  nvim {path} ', customTerminal: true })
    ).toEqual({ id: 'custom', customCommand: 'nvim {path}', customTerminal: true })
    expect(sanitizeEditorSetting({ id: 'custom', customTerminal: 'yes' })).toEqual({
      id: 'custom',
      customCommand: '',
      customTerminal: false
    })
  })

  it('rejects unknown ids, non-objects and absurdly long commands', () => {
    expect(sanitizeEditorSetting({ id: 'emacs' })).toBeNull()
    expect(sanitizeEditorSetting(null)).toBeNull()
    expect(sanitizeEditorSetting('vscode')).toBeNull()
    expect(sanitizeEditorSetting({ id: 7 })).toBeNull()
    expect(sanitizeEditorSetting({ id: 'custom', customCommand: 'x'.repeat(2000) })).toBeNull()
  })

  it('falls back to VS Code for anything invalid', () => {
    expect(effectiveEditorSetting(undefined)).toEqual({ id: 'vscode' })
    expect(effectiveEditorSetting({ id: 'nope' })).toEqual({ id: 'vscode' })
  })
})

describe('editorDisplayName', () => {
  it('names presets and returns null for custom', () => {
    expect(editorDisplayName({ id: 'cursor' })).toBe('Cursor')
    expect(editorDisplayName({ id: 'jetbrains' })).toBe('JetBrains')
    expect(editorDisplayName({ id: 'custom', customCommand: 'x' })).toBeNull()
  })
})
