import { describe, it, expect } from 'vitest'
import {
  buildClaudeArgs,
  composeAppendSystemPrompt,
  mergeBootConfig,
  tokenizeArgs,
  filterDenylistedArgs,
  type ClaudeBootConfig
} from '../src/main/claude-args'

/**
 * The argv builder is the security + correctness boundary for "Claude Boot":
 * the app-managed base args always lead, session-breaking flags never survive
 * the escape hatch, and the per-folder merge inherits/overrides predictably.
 */
describe('buildClaudeArgs', () => {
  it('returns the bare base when config is empty', () => {
    expect(buildClaudeArgs([], {})).toEqual([])
    expect(buildClaudeArgs(['--resume', 'abc'], {})).toEqual(['--resume', 'abc'])
  })

  it('appends structured flags after the base', () => {
    const cfg: ClaudeBootConfig = { model: 'opus', effort: 'high', permissionMode: 'plan' }
    expect(buildClaudeArgs(['--resume', 'u1'], cfg)).toEqual([
      '--resume',
      'u1',
      '--model',
      'opus',
      '--effort',
      'high',
      '--permission-mode',
      'plan'
    ])
  })

  it('maps chrome tri-state to --chrome / --no-chrome / nothing', () => {
    expect(buildClaudeArgs([], { chrome: true })).toEqual(['--chrome'])
    expect(buildClaudeArgs([], { chrome: false })).toEqual(['--no-chrome'])
    expect(buildClaudeArgs([], {})).toEqual([])
  })

  it('emits boolean flags only when true', () => {
    expect(buildClaudeArgs([], { verbose: true, bare: false })).toEqual(['--verbose'])
  })

  it('emits list flags once with all (trimmed, non-empty) values', () => {
    expect(buildClaudeArgs([], { addDirs: [' /a ', '', '/b'] })).toEqual(['--add-dir', '/a', '/b'])
  })

  it('emits the pre-prompt as a positional after a -- separator (last)', () => {
    expect(buildClaudeArgs(['--resume', 'u1'], { addDirs: ['/a'], prePrompt: 'go' })).toEqual([
      '--resume',
      'u1',
      '--add-dir',
      '/a',
      '--',
      'go'
    ])
  })

  it('strips denylisted flags from extraArgs but keeps safe ones', () => {
    const cfg: ClaudeBootConfig = { extraArgs: '--print --resume xyz --betas a,b' }
    expect(buildClaudeArgs([], cfg)).toEqual(['--betas', 'a,b'])
  })

  it('emits --remote-control bare when remoteControl is true', () => {
    expect(buildClaudeArgs([], { remoteControl: true })).toEqual(['--remote-control'])
  })

  it('emits --remote-control <name> when remoteControl is a string', () => {
    expect(buildClaudeArgs([], { remoteControl: 'phone' })).toEqual(['--remote-control', 'phone'])
    // value is trimmed like every other string flag
    expect(buildClaudeArgs([], { remoteControl: '  desk  ' })).toEqual(['--remote-control', 'desk'])
  })

  it('emits nothing for remoteControl false / absent / blank string', () => {
    expect(buildClaudeArgs([], { remoteControl: false })).toEqual([])
    expect(buildClaudeArgs([], {})).toEqual([])
    expect(buildClaudeArgs([], { remoteControl: '   ' })).toEqual([])
  })
})

// ── T55: Harnu self-awareness preamble composition ────────────────────────────
describe('composeAppendSystemPrompt', () => {
  it('preamble first, user append after, joined by the separator', () => {
    expect(composeAppendSystemPrompt('DOC', 'USER')).toBe('DOC\n\n---\n\nUSER')
  })
  it('preamble only → just the preamble (no separator)', () => {
    expect(composeAppendSystemPrompt('DOC', undefined)).toBe('DOC')
    expect(composeAppendSystemPrompt('DOC', '   ')).toBe('DOC')
  })
  it('user only (no preamble) → exactly the user value, byte-identical', () => {
    expect(composeAppendSystemPrompt(undefined, 'USER')).toBe('USER')
    expect(composeAppendSystemPrompt('', 'USER')).toBe('USER')
  })
  it('neither → empty string', () => {
    expect(composeAppendSystemPrompt(undefined, undefined)).toBe('')
  })
})

describe('buildClaudeArgs with a Harnu preamble (T55)', () => {
  it('prepends the preamble to the user append in a single flag', () => {
    expect(buildClaudeArgs([], { appendSystemPrompt: 'U' }, 'DOC')).toEqual([
      '--append-system-prompt',
      'DOC\n\n---\n\nU'
    ])
  })
  it('emits --append-system-prompt with just the preamble when the user has none', () => {
    expect(buildClaudeArgs([], {}, 'DOC')).toEqual(['--append-system-prompt', 'DOC'])
  })
  it('never writes --system-prompt for the preamble (append only)', () => {
    const args = buildClaudeArgs([], { systemPrompt: 'REPLACE' }, 'DOC')
    expect(args).toContain('--system-prompt')
    expect(args).toContain('--append-system-prompt')
    // the doc rode the append, the user's --system-prompt is untouched
    expect(args[args.indexOf('--system-prompt') + 1]).toBe('REPLACE')
    expect(args[args.indexOf('--append-system-prompt') + 1]).toBe('DOC')
  })
  it('no preamble (undefined) reproduces the pre-feature argv byte-for-byte', () => {
    expect(buildClaudeArgs([], { appendSystemPrompt: 'U' })).toEqual([
      '--append-system-prompt',
      'U'
    ])
    expect(buildClaudeArgs([], {})).toEqual([])
  })
})

describe('tokenizeArgs', () => {
  it('splits on whitespace', () => {
    expect(tokenizeArgs('--a b  --c')).toEqual(['--a', 'b', '--c'])
  })
  it('keeps quoted runs as one token', () => {
    expect(tokenizeArgs('--append "be very terse" x')).toEqual(['--append', 'be very terse', 'x'])
    expect(tokenizeArgs("--x 'a b'")).toEqual(['--x', 'a b'])
  })
  it('returns empty for blank input', () => {
    expect(tokenizeArgs('   ')).toEqual([])
  })
})

describe('filterDenylistedArgs', () => {
  it('drops a value-taking denylisted flag together with its value', () => {
    const { args, dropped } = filterDenylistedArgs(['--resume', 'uuid', '--model', 'opus'])
    expect(args).toEqual(['--model', 'opus'])
    expect(dropped).toEqual(['--resume', 'uuid'])
  })
  it('drops --flag=value form', () => {
    const { args } = filterDenylistedArgs(['--output-format=json', '--keep'])
    expect(args).toEqual(['--keep'])
  })
  it('drops boolean denylisted flags', () => {
    const { args } = filterDenylistedArgs(['--print', '-p', '--fork-session', '--ok'])
    expect(args).toEqual(['--ok'])
  })
})

describe('mergeBootConfig', () => {
  it('folder values override global', () => {
    expect(mergeBootConfig({ model: 'opus', effort: 'low' }, { effort: 'max' })).toEqual({
      model: 'opus',
      effort: 'max'
    })
  })
  it('empty folder strings/arrays inherit global', () => {
    expect(mergeBootConfig({ model: 'opus', addDirs: ['/a'] }, { model: '', addDirs: [] })).toEqual(
      {
        model: 'opus',
        addDirs: ['/a']
      }
    )
  })
  it('a folder false overrides a global true (turn a flag off)', () => {
    expect(mergeBootConfig({ chrome: true }, { chrome: false })).toEqual({ chrome: false })
  })
  it('undefined folder values inherit global', () => {
    expect(mergeBootConfig({ verbose: true }, { verbose: undefined })).toEqual({ verbose: true })
  })

  // ── T57 #1: additive (accumulate) semantics ────────────────────────────────
  it('concatenates appendSystemPrompt across scopes (global kept, folder added)', () => {
    expect(
      mergeBootConfig({ appendSystemPrompt: 'G' }, { appendSystemPrompt: 'F' }).appendSystemPrompt
    ).toBe('G\n\n---\n\nF')
  })

  it('concatenates prePrompt across scopes', () => {
    expect(mergeBootConfig({ prePrompt: 'A' }, { prePrompt: 'B' }).prePrompt).toBe('A\n\n---\n\nB')
  })

  it('only one scope set for an accumulate text field → no separator', () => {
    expect(mergeBootConfig({ appendSystemPrompt: 'G' }, {}).appendSystemPrompt).toBe('G')
    expect(mergeBootConfig({}, { appendSystemPrompt: 'F' }).appendSystemPrompt).toBe('F')
  })

  it('accumulates across the full global→folder→session chain (single sep per hop)', () => {
    const gf = mergeBootConfig({ appendSystemPrompt: 'G' }, { appendSystemPrompt: 'F' })
    expect(mergeBootConfig(gf, { appendSystemPrompt: 'S' }).appendSystemPrompt).toBe(
      'G\n\n---\n\nF\n\n---\n\nS'
    )
  })

  it('unions list fields (dedup, order-preserving) instead of replacing', () => {
    expect(mergeBootConfig({ addDirs: ['/a', '/b'] }, { addDirs: ['/b', '/c'] }).addDirs).toEqual([
      '/a',
      '/b',
      '/c'
    ])
    expect(
      mergeBootConfig({ allowedTools: ['Edit'] }, { allowedTools: ['Bash(git *)'] }).allowedTools
    ).toEqual(['Edit', 'Bash(git *)'])
  })

  it('scalar text (systemPrompt) still REPLACES, not accumulates', () => {
    expect(mergeBootConfig({ systemPrompt: 'G' }, { systemPrompt: 'F' }).systemPrompt).toBe('F')
  })

  it('scalars (model/effort) still replace under accumulation', () => {
    expect(mergeBootConfig({ model: 'opus' }, { model: 'sonnet' }).model).toBe('sonnet')
  })

  it('a single --append-system-prompt carries the concatenated value into argv', () => {
    const merged = mergeBootConfig({ appendSystemPrompt: 'G' }, { appendSystemPrompt: 'F' })
    expect(buildClaudeArgs([], merged)).toEqual(['--append-system-prompt', 'G\n\n---\n\nF'])
  })
})
