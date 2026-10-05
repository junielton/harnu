import { describe, it, expect } from 'vitest'

import {
  OPTIONS_END,
  buildClaudeArgs,
  insertOptionArgs,
  splitOptionArgs,
  withOptionArgs
} from '../src/main/claude-args'
import { insertPluginDirArg } from '../src/main/bundled-skills-core'
import { buildHookSettingsBlobJson, injectHookSettings } from '../src/main/hook-settings-blob'

/**
 * BUG-86 — every option flag must be emitted BEFORE the bare `--` separator.
 *
 * Everything after `--` is a POSITIONAL argument to the `claude` CLI, so a flag
 * appended past it is read as prompt text and never parsed. The old shape ended
 * `resolveClaudeBootArgs` with `-- <pre-prompt>` and then appended `--settings`
 * (T92 hook bridge) and `--plugin-dir` (T217 bundled skills) after it, so a
 * FRESHLY spawned session silently got neither — while a resumed session (no
 * pre-prompt, hence no separator) worked, which is why it hid for a release.
 *
 * These tests assert flag POSITION RELATIVE TO THE SEPARATOR, never mere
 * presence — presence is exactly what the pre-existing tests already asserted
 * while the bug was live.
 */

const BLOB = buildHookSettingsBlobJson(41999, 'tok')
const STAGED = '/staged/harnu'
const PRE_PROMPT = 'do the thing'

/** Mirrors `pty.ts`'s spawn composition: build the argv, then run every injector
 *  inside `withOptionArgs`. Kept in lockstep with the real call site by hand — the
 *  invariant asserted below holds for any injector added to that callback. */
async function composeFreshSpawnArgv(extra: Record<string, unknown> = {}): Promise<string[]> {
  const args = buildClaudeArgs(
    [],
    { model: 'opus', prePrompt: PRE_PROMPT, ...extra },
    'harnu preamble'
  )
  return withOptionArgs(args, async (options) =>
    insertPluginDirArg(injectHookSettings(options, BLOB), STAGED, ['mission'])
  )
}

/** Index of the bare `--`, or -1. */
const sepAt = (args: readonly string[]): number => args.indexOf(OPTIONS_END)

/** The pre-fix `injectHookSettings`: appends to the END of a complete argv. Kept
 *  only so the regression test can show the invariant is falsifiable. */
const injectHookSettingsNaively = (args: readonly string[], blob: string): string[] => [
  ...args,
  '--settings',
  blob
]

describe('splitOptionArgs', () => {
  it('splits at the FIRST bare -- and keeps the separator with the tail', () => {
    expect(splitOptionArgs(['--model', 'opus', '--', 'go', '--', 'x'])).toEqual({
      options: ['--model', 'opus'],
      promptTail: ['--', 'go', '--', 'x']
    })
  })

  it('yields an empty tail when there is no separator', () => {
    expect(splitOptionArgs(['--resume', 'u1'])).toEqual({
      options: ['--resume', 'u1'],
      promptTail: []
    })
  })

  it('round-trips: [...options, ...promptTail] reconstructs the input', () => {
    const argv = ['--model', 'opus', '--', 'go']
    const { options, promptTail } = splitOptionArgs(argv)
    expect([...options, ...promptTail]).toEqual(argv)
  })

  it('does not treat --settings=x (an = form) or a lone -x as the separator', () => {
    expect(splitOptionArgs(['--settings=--', '-p']).promptTail).toEqual([])
  })
})

describe('insertOptionArgs', () => {
  it('splices BEFORE the separator, not after it', () => {
    expect(insertOptionArgs(['--model', 'opus', '--', 'go'], ['--plugin-dir', '/d'])).toEqual([
      '--model',
      'opus',
      '--plugin-dir',
      '/d',
      '--',
      'go'
    ])
  })

  it('plain-appends when the argv carries no separator (the resume shape)', () => {
    expect(insertOptionArgs(['--resume', 'u1'], ['--plugin-dir', '/d'])).toEqual([
      '--resume',
      'u1',
      '--plugin-dir',
      '/d'
    ])
  })

  it('is a no-op for an empty insert, and never mutates the input', () => {
    const argv = ['--', 'go']
    expect(insertOptionArgs(argv, [])).toEqual(argv)
    insertOptionArgs(argv, ['--x'])
    expect(argv).toEqual(['--', 'go'])
  })
})

describe('withOptionArgs', () => {
  it('hands the callback ONLY the option portion and re-appends the tail last', async () => {
    const seen: string[][] = []
    const out = await withOptionArgs(['--model', 'opus', '--', 'go'], (options) => {
      seen.push([...options])
      // A naive injector that appends — the exact shape that caused BUG-86.
      return [...options, '--plugin-dir', '/d']
    })
    expect(seen[0]).toEqual(['--model', 'opus'])
    expect(out).toEqual(['--model', 'opus', '--plugin-dir', '/d', '--', 'go'])
    // The appended flag is BEFORE the separator despite the injector appending.
    expect(out.indexOf('--plugin-dir')).toBeLessThan(sepAt(out))
  })

  it('awaits an async injector', async () => {
    const out = await withOptionArgs(['--', 'go'], async (o) => [...o, '--verbose'])
    expect(out).toEqual(['--verbose', '--', 'go'])
  })
})

describe('injectHookSettings — separator awareness (AC-2, the --settings half)', () => {
  it('emits --settings BEFORE the separator on a fresh-spawn argv', () => {
    const out = injectHookSettings(['--model', 'opus', '--', PRE_PROMPT], BLOB)
    expect(out.indexOf('--settings')).toBeGreaterThanOrEqual(0)
    expect(out.indexOf('--settings')).toBeLessThan(sepAt(out))
    expect(out.slice(sepAt(out))).toEqual(['--', PRE_PROMPT])
  })

  it('keeps composing with a user --settings, still before the separator', () => {
    const out = injectHookSettings(['--settings', '{"hooks":{}}', '--', PRE_PROMPT], BLOB)
    expect(out.filter((t) => t === '--settings')).toHaveLength(1)
    expect(out.indexOf('--settings')).toBeLessThan(sepAt(out))
    expect(out.slice(sepAt(out))).toEqual(['--', PRE_PROMPT])
  })

  it('never mistakes a --settings inside the POSITIONAL prompt for a user value', () => {
    const out = injectHookSettings(['--', 'tell me about --settings'], BLOB)
    // The prompt survives verbatim…
    expect(out.slice(sepAt(out))).toEqual(['--', 'tell me about --settings'])
    // …and ours is still emitted, in the option portion.
    expect(out.indexOf('--settings')).toBeLessThan(sepAt(out))
  })
})

describe('insertPluginDirArg — separator awareness (AC-2, the --plugin-dir half)', () => {
  it('emits --plugin-dir BEFORE the separator on a fresh-spawn argv', () => {
    const out = insertPluginDirArg(['--model', 'opus', '--', PRE_PROMPT], STAGED, ['mission'])
    expect(out.indexOf('--plugin-dir')).toBeLessThan(sepAt(out))
    expect(out.slice(sepAt(out))).toEqual(['--', PRE_PROMPT])
  })

  it('stays idempotent across the separator (no double flag on re-injection)', () => {
    const once = insertPluginDirArg(['--', PRE_PROMPT], STAGED, ['mission'])
    expect(insertPluginDirArg(once, STAGED, ['mission'])).toEqual(once)
  })

  it('does NOT let a --plugin-dir quoted in the prompt suppress the real flag', () => {
    const out = insertPluginDirArg(['--', `run --plugin-dir ${STAGED}`], STAGED, ['mission'])
    expect(out.indexOf('--plugin-dir')).toBeLessThan(sepAt(out))
  })
})

describe('fresh-spawn argv (the BUG-86 regression)', () => {
  it('puts EVERY option flag before the separator — no flag is left in the tail', async () => {
    const argv = await composeFreshSpawnArgv()
    const sep = sepAt(argv)
    expect(sep).toBeGreaterThanOrEqual(0)
    // Generic guard: the tail is the separator plus the positional prompt, and
    // NOTHING else. A future injector that appends past the separator trips here.
    expect(argv.slice(sep)).toEqual([OPTIONS_END, PRE_PROMPT])
    const strayFlags = argv.slice(sep + 1).filter((t) => t.startsWith('--'))
    expect(strayFlags).toEqual([])
  })

  it('parses --settings and --plugin-dir as FLAGS, not as prompt text', async () => {
    const argv = await composeFreshSpawnArgv()
    const sep = sepAt(argv)
    for (const flag of ['--settings', '--plugin-dir']) {
      const at = argv.indexOf(flag)
      expect(at, `${flag} must be present`).toBeGreaterThanOrEqual(0)
      expect(at, `${flag} must precede the -- separator`).toBeLessThan(sep)
    }
    expect(argv[argv.indexOf('--plugin-dir') + 1]).toBe(STAGED)
  })

  it("keeps a user's own --settings composed and still ahead of the separator", async () => {
    const argv = await composeFreshSpawnArgv({ settings: '{"env":{"A":"1"}}' })
    const sep = sepAt(argv)
    expect(argv.filter((t) => t === '--settings')).toHaveLength(1)
    expect(argv.indexOf('--settings')).toBeLessThan(sep)
    const merged = JSON.parse(argv[argv.indexOf('--settings') + 1])
    expect(merged.env).toEqual({ A: '1' }) // user's value survives
    expect(Object.keys(merged.hooks)).toContain('SessionStart') // ours merged in
  })

  /**
   * Guard on the guard: the assertions above must be able to FAIL. This
   * reproduces the pre-fix composition verbatim — build the full argv (tail and
   * all), then append each flag to the end — and shows it violates the exact
   * invariant the tests above assert. Without this, a future refactor could make
   * those assertions vacuous and nobody would notice.
   */
  it('would FAIL under the old append-after-the-argv composition', () => {
    const built = buildClaudeArgs([], { model: 'opus', prePrompt: PRE_PROMPT }, 'harnu preamble')
    const oldShape = [...injectHookSettingsNaively(built, BLOB), '--plugin-dir', STAGED]
    const sep = sepAt(oldShape)
    // Both flags land in the POSITIONAL tail — the CLI reads them as prompt text.
    expect(oldShape.indexOf('--settings')).toBeGreaterThan(sep)
    expect(oldShape.indexOf('--plugin-dir')).toBeGreaterThan(sep)
    expect(oldShape.slice(sep)).not.toEqual([OPTIONS_END, PRE_PROMPT])
  })

  it('AC-3 — the RESUME shape (no pre-prompt, no separator) still gets both flags', async () => {
    const args = buildClaudeArgs(['--resume', 'u1'], { model: 'opus' }, 'harnu preamble')
    const argv = await withOptionArgs(args, async (options) =>
      insertPluginDirArg(injectHookSettings(options, BLOB), STAGED, ['mission'])
    )
    expect(sepAt(argv)).toBe(-1)
    expect(argv.indexOf('--settings')).toBeGreaterThanOrEqual(0)
    expect(argv.indexOf('--plugin-dir')).toBeGreaterThanOrEqual(0)
    expect(argv.slice(0, 2)).toEqual(['--resume', 'u1'])
  })
})
