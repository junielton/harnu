import { describe, it, expect } from 'vitest'
import {
  buildRegistry,
  BUILTIN_AGENTS,
  loadBuiltinManifests
} from '../src/main/detect/manifest-registry'
import { paneMatchesManifest, matchManifest } from '../src/main/detect/screen-detect-core'
import type { RawManifest } from '../src/main/detect/manifest-load-core'

/**
 * T9 (pure half) — `buildRegistry` folds the bundled builtins with per-agent
 * `~/.claude/detectors/<agent>.json` overrides into the compiled registry. The
 * invariants pinned:
 *
 *   - with no overrides it is exactly the builtins, in classify-precedence order;
 *   - an override for a builtin agent shallow-merges OVER it (per-key);
 *   - an override for a NEW agent (no builtin) is compiled standalone + appended;
 *   - a broken override never takes down the rest of the registry.
 */

describe('buildRegistry — builtins', () => {
  it('with no overrides yields the builtins in order', () => {
    const reg = buildRegistry()
    expect(reg.map((m) => m.agent)).toEqual([...BUILTIN_AGENTS])
    expect(BUILTIN_AGENTS).toContain('codex')
  })

  it('loadBuiltinManifests == buildRegistry() with no overrides', () => {
    expect(loadBuiltinManifests().map((m) => m.agent)).toEqual(buildRegistry().map((m) => m.agent))
  })

  it('the codex builtin claims a "Codex"-titled pane', () => {
    const codex = buildRegistry().find((m) => m.agent === 'codex')!
    expect(paneMatchesManifest('Codex', [], codex)).toBe(true)
    expect(matchManifest(['Allow this tool? (y/N)'], codex)).toBe('blocked')
  })
})

describe('buildRegistry — overrides', () => {
  it('an override for a builtin agent wins per-key (keeps other fields)', () => {
    const overrides = new Map<string, RawManifest>([
      ['codex', { agent: 'codex', fallback: 'working' }]
    ])
    const codex = buildRegistry(overrides).find((m) => m.agent === 'codex')!
    expect(codex.fallback).toBe('working')
    // The builtin's rules are inherited (the override didn't set `rules`).
    expect(matchManifest(['Allow this tool? (y/N)'], codex)).toBe('blocked')
  })

  it('an override can retune the classifier (titleRegex)', () => {
    const overrides = new Map<string, RawManifest>([
      ['codex', { agent: 'codex', match: { titleRegex: 'OpenAI Codex' } }]
    ])
    const codex = buildRegistry(overrides).find((m) => m.agent === 'codex')!
    expect(paneMatchesManifest('OpenAI Codex 0.2', [], codex)).toBe(true)
    // The override replaced the whole match block → bare "Codex" no longer claims.
    expect(paneMatchesManifest('Codex', [], codex)).toBe(false)
  })

  it('an override-only agent (no builtin) is compiled + appended', () => {
    const overrides = new Map<string, RawManifest>([
      [
        'myagent',
        {
          agent: 'myagent',
          match: { contentAny: ['myagent>'] },
          rules: [{ state: 'working', any: ['busy'] }],
          fallback: 'idle'
        }
      ]
    ])
    const reg = buildRegistry(overrides)
    const mine = reg.find((m) => m.agent === 'myagent')
    expect(mine).toBeDefined()
    // Builtins still come first; the new agent is appended.
    expect(reg.map((m) => m.agent)).toEqual([...BUILTIN_AGENTS, 'myagent'])
    expect(paneMatchesManifest(null, ['myagent> '], mine!)).toBe(true)
  })

  it('a broken override is skipped, the registry still builds', () => {
    // `rules` not an array → parseManifest rejects this override; builtins survive.
    const overrides = new Map<string, RawManifest>([
      ['broken', { agent: 'broken', rules: 'nope' as unknown as [] }]
    ])
    const reg = buildRegistry(overrides)
    expect(reg.map((m) => m.agent)).toEqual([...BUILTIN_AGENTS])
  })
})
