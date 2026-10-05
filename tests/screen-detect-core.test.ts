import { describe, it, expect } from 'vitest'
import {
  matchManifest,
  evaluateManifest,
  paneMatchesManifest,
  SCREEN_STATE_PRECEDENCE,
  type CompiledManifest,
  type CompiledMatch,
  type CompiledRule,
  type ScreenState
} from '../src/main/detect/screen-detect-core'

/** An empty classifier — claims nothing; fine for the matching-only tests. */
const NO_MATCH: CompiledMatch = { titleRegex: null, contentAny: [], process: [] }

/**
 * T1 — `matchManifest` is the PURE screen-scrape matcher: bottom lines + a
 * compiled manifest → a `ScreenState`. The invariants pinned here:
 *
 *   - PRECEDENCE is by state (blocked > working > idle), NOT by rule order — a
 *     blocked rule wins even when listed after a working rule that also matches.
 *   - the `fallback` applies only when nothing matches.
 *   - a rule fires when ANY of its `any` patterns matches ANY scanned line.
 *   - `scan.lines` clips to the bottom-N before matching, so an old prompt
 *     scrolled above the window cannot trigger.
 *
 * Manifests here are hand-compiled (real `RegExp`s) — compilation/validation is
 * `manifest-load-core`'s job and is tested separately.
 */

/** Build a compiled rule from a state + pattern strings (flag-free, like prod). */
const rule = (state: ScreenState, ...patterns: string[]): CompiledRule => ({
  state,
  any: patterns.map((p) => new RegExp(p))
})

/** A codex-shaped manifest modelled on design.md's example. */
const codex = (scanLines = 30): CompiledManifest => ({
  agent: 'codex',
  match: NO_MATCH,
  scanLines,
  rules: [
    rule('blocked', 'Allow this tool\\?', '\\(y/N\\)', 'Do you want to proceed'),
    rule('working', 'Esc to interrupt', 'esc to stop', 'Thinking', '⠋|⠙|⠹|⠸|⠼'),
    rule('idle', '^›\\s*$', 'Type your message')
  ],
  fallback: 'idle'
})

describe('matchManifest — precedence blocked > working > idle', () => {
  it('blocked wins over a simultaneously-matching working line', () => {
    // Both a spinner (working) and an approval prompt (blocked) are on screen.
    const lines = ['⠹ Thinking…', 'Allow this tool? (y/N)']
    expect(matchManifest(lines, codex())).toBe('blocked')
  })

  it('working wins over a simultaneously-matching idle line', () => {
    const lines = ['Esc to interrupt', '› ']
    expect(matchManifest(lines, codex())).toBe('working')
  })

  it('precedence is by state, not by rule array order', () => {
    // Manifest lists idle FIRST, then working, then blocked — matching must
    // still resolve blocked. A mutant that returns the first array hit dies.
    const reordered: CompiledManifest = {
      agent: 'codex',
      match: NO_MATCH,
      scanLines: 30,
      rules: [
        rule('idle', 'Type your message'),
        rule('working', 'Thinking'),
        rule('blocked', '\\(y/N\\)')
      ],
      fallback: 'idle'
    }
    const lines = ['Type your message', 'Thinking', 'proceed? (y/N)']
    expect(matchManifest(lines, reordered)).toBe('blocked')
  })

  it('the documented precedence constant is blocked > working > idle', () => {
    expect([...SCREEN_STATE_PRECEDENCE]).toEqual(['blocked', 'working', 'idle'])
  })
})

describe('matchManifest — individual state triggers', () => {
  it('a spinner glyph alone → working', () => {
    expect(matchManifest(['⠼ working on it'], codex())).toBe('working')
  })

  it('an empty prompt line `›` → idle', () => {
    expect(matchManifest(['some output', '› '], codex())).toBe('idle')
  })

  it('a (y/N) prompt → blocked', () => {
    expect(matchManifest(['Run rm -rf? (y/N)'], codex())).toBe('blocked')
  })

  it('matches when ANY alternative pattern in a rule hits', () => {
    // "esc to stop" is the 2nd working alternative.
    expect(matchManifest(['press esc to stop'], codex())).toBe('working')
  })
})

describe('matchManifest — fallback', () => {
  it('falls back to the manifest fallback when nothing matches', () => {
    expect(matchManifest(['just some neutral text', 'no markers here'], codex())).toBe('idle')
  })

  it('honors a non-idle fallback', () => {
    const m: CompiledManifest = { ...codex(), fallback: 'working' }
    expect(matchManifest(['nothing relevant'], m)).toBe('working')
  })

  it('an empty grid falls back', () => {
    expect(matchManifest([], codex())).toBe('idle')
  })
})

describe('matchManifest — scan.lines clips to the bottom window', () => {
  it('a blocked marker ABOVE the scan window does not trigger', () => {
    // scanLines=2 → only the last two lines are scanned; the (y/N) up top is
    // out of window, so the visible idle prompt wins.
    const m = codex(2)
    const lines = ['old: proceed? (y/N)', 'neutral line', '› ']
    expect(matchManifest(lines, m)).toBe('idle')
  })

  it('a marker INSIDE the scan window still triggers', () => {
    const m = codex(2)
    const lines = ['neutral', 'Allow this tool? (y/N)', '› ']
    // last 2 = ['Allow this tool? (y/N)', '› '] → blocked beats idle by precedence
    expect(matchManifest(lines, m)).toBe('blocked')
  })

  it('scanLines >= grid height scans everything', () => {
    const m = codex(100)
    expect(matchManifest(['Thinking'], m)).toBe('working')
  })
})

describe('evaluateManifest — explain detail', () => {
  it('returns the FIRST rule/pattern/line that fired (declared order within a state)', () => {
    // The line matches both blocked alternatives; explain reports the first one.
    const match = evaluateManifest(['⠹ Thinking…', 'Allow this tool? (y/N)'], codex())
    expect(match).not.toBeNull()
    expect(match?.state).toBe('blocked')
    expect(match?.pattern).toBe('Allow this tool\\?')
    expect(match?.line).toBe('Allow this tool? (y/N)')
  })

  it('returns null when only the fallback applies', () => {
    expect(evaluateManifest(['neutral'], codex())).toBeNull()
  })
})

describe('paneMatchesManifest — classifier (is this pane this agent?)', () => {
  const withMatch = (match: Partial<CompiledMatch>): CompiledManifest => ({
    ...codex(),
    match: { titleRegex: null, contentAny: [], process: [], ...match }
  })

  it('claims on a titleRegex hit against the OSC title', () => {
    const m = withMatch({ titleRegex: /Codex/, contentAny: [] })
    expect(paneMatchesManifest('Codex — repo', [], m)).toBe(true)
  })

  it('claims on a contentAny hit against a scanned line', () => {
    const m = withMatch({ titleRegex: null, contentAny: [/codex>/] })
    expect(paneMatchesManifest(null, ['codex> ready'], m)).toBe(true)
  })

  it('either signal is sufficient (OR semantics)', () => {
    const m = withMatch({ titleRegex: /Codex/, contentAny: [/codex>/] })
    expect(paneMatchesManifest('Codex', ['nothing'], m)).toBe(true)
    expect(paneMatchesManifest('bash', ['codex> '], m)).toBe(true)
  })

  it('does NOT claim a plain shell that matches neither signal', () => {
    const m = withMatch({ titleRegex: /Codex/, contentAny: [/codex>/] })
    expect(paneMatchesManifest('bash', ['user@host:~$ ls'], m)).toBe(false)
  })

  it('a manifest with NO positive signal claims nothing', () => {
    const m = withMatch({ titleRegex: null, contentAny: [] })
    expect(paneMatchesManifest('Codex', ['codex> '], m)).toBe(false)
  })

  it('a null title never throws and just skips the title signal', () => {
    const m = withMatch({ titleRegex: /Codex/, contentAny: [/codex>/] })
    expect(paneMatchesManifest(null, ['codex> '], m)).toBe(true) // content still claims
    expect(paneMatchesManifest(null, ['neutral'], m)).toBe(false)
  })
})

describe('paneMatchesManifest — process classifier (scroll-proof, W6.1)', () => {
  const withMatch = (match: Partial<CompiledMatch>): CompiledManifest => ({
    ...codex(),
    match: { titleRegex: null, contentAny: [], process: [], ...match }
  })

  it('claims on a foreground-process-name hit, regardless of title/content', () => {
    const m = withMatch({ process: [/^aider$/] })
    // No title, neutral content — the process alone claims (banner scrolled off).
    expect(paneMatchesManifest(null, ['just some output', '> '], m, 'aider')).toBe(true)
  })

  it('does not claim when the process differs (e.g. plain shell at its prompt)', () => {
    const m = withMatch({ process: [/^aider$/] })
    expect(paneMatchesManifest(null, ['> '], m, 'zsh')).toBe(false)
    expect(paneMatchesManifest(null, ['> '], m, 'bash')).toBe(false)
  })

  it('a null process (non-Linux / unresolved) just skips the process signal', () => {
    const m = withMatch({ process: [/^aider$/], contentAny: [/codex>/] })
    expect(paneMatchesManifest(null, ['codex> '], m, null)).toBe(true) // content still claims
    expect(paneMatchesManifest(null, ['neutral'], m, null)).toBe(false)
  })

  it('process default is null when the arg is omitted', () => {
    const m = withMatch({ process: [/^aider$/] })
    expect(paneMatchesManifest(null, ['neutral'], m)).toBe(false)
  })
})
