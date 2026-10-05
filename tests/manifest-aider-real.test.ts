import { describe, it, expect } from 'vitest'
import { buildRegistry } from '../src/main/detect/manifest-registry'
import { matchManifest, paneMatchesManifest } from '../src/main/detect/screen-detect-core'
import { reduceDetect, INITIAL_DETECT_STATE } from '../src/main/detect/detect-orchestrate-core'
import type { CompiledManifest } from '../src/main/detect/screen-detect-core'

/**
 * T11 — the SHIPPED aider manifest validated against REAL captured output
 * (aider 0.86.2 driving an ollama model, 2026-06-29). These bottom-buffer
 * fixtures are copied verbatim from the PTY capture, so a regression in the
 * manifest regexes (or the classifier) fails here against ground truth — not a
 * guessed approximation.
 */

const aider = (): CompiledManifest => {
  const m = buildRegistry().find((x) => x.agent === 'aider')
  if (!m) throw new Error('aider builtin missing')
  return m
}

// Real startup screen that ends on a yes/no prompt (BLOCKED).
const BLOCKED_SCREEN = [
  'Aider v0.86.2',
  'Model: ollama_chat/deepseek-r1:7b with diff edit format',
  'Git repo: .git with 1 files',
  'Repo-map: disabled',
  '',
  "Would you like to see what's new in this version? (Y)es/(N)o [Yes]:"
]

// Real reprompt after an unrecognized answer (BLOCKED).
const BLOCKED_REPROMPT = ['Please answer with one of: yes, no, skip, all']

// Real in-turn screen while the model runs (WORKING).
const WORKING_SCREEN = [
  '> summarize the readme',
  '░█         Waiting for ollama_chat/deepseek-r1:7b'
]

// Real idle screen at the prompt (IDLE = fallback).
const IDLE_SCREEN = [
  'Aider v0.86.2',
  'Model: ollama_chat/deepseek-r1:7b with diff edit format',
  'Git repo: .git with 1 files',
  '>'
]

describe('aider manifest — classification on real output', () => {
  it('claims the pane by the banner (no OSC title — content only)', () => {
    expect(paneMatchesManifest(null, BLOCKED_SCREEN, aider())).toBe(true)
    expect(paneMatchesManifest(null, IDLE_SCREEN, aider())).toBe(true)
  })

  it('claims the pane mid-turn by the "Waiting for" marker', () => {
    expect(paneMatchesManifest(null, WORKING_SCREEN, aider())).toBe(true)
  })

  it('does NOT claim a plain bash screen', () => {
    expect(paneMatchesManifest(null, ['user@host:~/proj$ ls', 'README.md  src'], aider())).toBe(
      false
    )
  })

  it('stays claimed by the aider PROCESS after the banner scrolls off (W6.1)', () => {
    // A neutral mid-session screen with no banner / no "Waiting for" — content
    // alone would drop it, but the foreground process "aider" keeps it claimed.
    const scrolled = ['  the readme describes a demo project.', '', '> ']
    expect(paneMatchesManifest(null, scrolled, aider())).toBe(false) // content: no claim
    expect(paneMatchesManifest(null, scrolled, aider(), 'aider')).toBe(true) // process: claims
  })
})

describe('aider manifest — state on real output', () => {
  it('a yes/no prompt → blocked', () => {
    expect(matchManifest(BLOCKED_SCREEN, aider())).toBe('blocked')
    expect(matchManifest(BLOCKED_REPROMPT, aider())).toBe('blocked')
  })

  it('the "Waiting for <model>" screen → working', () => {
    expect(matchManifest(WORKING_SCREEN, aider())).toBe('working')
  })

  it('a bare prompt → idle (fallback)', () => {
    expect(matchManifest(IDLE_SCREEN, aider())).toBe('idle')
  })
})

describe('aider end-to-end through the real registry (reduceDetect)', () => {
  const REG = buildRegistry()

  it('a blocked screen emits needs-input', () => {
    const out = reduceDetect(INITIAL_DETECT_STATE, { lines: BLOCKED_SCREEN, title: null }, REG, 0)
    expect(out.state.agent).toBe('aider')
    expect(out.emit).toBe('needs-input')
  })

  it('a working screen emits working', () => {
    const out = reduceDetect(INITIAL_DETECT_STATE, { lines: WORKING_SCREEN, title: null }, REG, 0)
    expect(out.emit).toBe('working')
  })
})
