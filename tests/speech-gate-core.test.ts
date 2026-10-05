import { describe, it, expect, beforeEach } from 'vitest'

import {
  checkSpeakRate,
  EMPTY_AGENT_SPEECH_PREFS,
  parseAgentSpeechPrefs,
  resolveAgentSpeechEnabled,
  resolveSpeakGate,
  setFolderAgentSpeech,
  setGlobalAgentSpeech,
  speakUnspokenHint,
  SPEAK_GATE_ERRORS,
  SPEAK_RATE_LIMIT,
  SPEAK_RATE_WINDOW_MS,
  type AgentSpeechPrefs
} from '../src/main/speech-gate-core'
import { resolveSkillEnabled } from '../src/main/bundled-skills-core'
import {
  recordSpeakAttempt,
  __resetSpeakRateForTests,
  __speakRateKeyCountForTests
} from '../src/main/mcp/speak-rate-registry'

/**
 * T238 — the `speak` verb's gate, tested where every rule actually lives.
 *
 * The four cascade rows and the three "pleasant or infuriating" rules from the
 * card are each pinned here, plus the two bounds (length cap, rate limit) that
 * keep one agent from holding the speakers.
 */

const REPO = '/home/u/repo'
const OTHER = '/home/u/other'

/** Build prefs without going through the setters, so a test can state a state. */
function prefs(
  global: boolean | undefined,
  folders: Record<string, boolean> = {}
): AgentSpeechPrefs {
  const out: AgentSpeechPrefs = { version: 1, folders: { ...folders } }
  if (global !== undefined) out.global = global
  return out
}

describe('AC-3a — resolution is folder ?? global ?? false', () => {
  it('global ON + folder unset ⇒ SPEAKS (this is how "every future folder" works)', () => {
    expect(resolveAgentSpeechEnabled(prefs(true), REPO)).toBe(true)
  })

  it('global ON + folder explicitly OFF ⇒ SILENT (a deliberate mute survives the global)', () => {
    expect(resolveAgentSpeechEnabled(prefs(true, { [REPO]: false }), REPO)).toBe(false)
  })

  it('global OFF + folder unset ⇒ SILENT (the per-folder opt-in mode)', () => {
    expect(resolveAgentSpeechEnabled(prefs(false), REPO)).toBe(false)
  })

  it('global OFF + folder explicitly ON ⇒ speaks THERE and nowhere else', () => {
    const p = prefs(false, { [REPO]: true })
    expect(resolveAgentSpeechEnabled(p, REPO)).toBe(true)
    expect(resolveAgentSpeechEnabled(p, OTHER)).toBe(false)
  })

  it('neither set ⇒ SILENT — a fresh install never speaks', () => {
    expect(resolveAgentSpeechEnabled(EMPTY_AGENT_SPEECH_PREFS, REPO)).toBe(false)
  })

  it('is literally resolveSkillEnabled — not a second implementation of the cascade', () => {
    // The card's "do not invent a second resolution rule", asserted rather than
    // trusted: for every tri-state combination the voice answer equals what the
    // bundled-skills cascade would give for the same shape.
    const tri = [undefined, true, false] as const
    for (const g of tri) {
      for (const f of tri) {
        const p = prefs(g, f === undefined ? {} : { [REPO]: f })
        expect(resolveAgentSpeechEnabled(p, REPO)).toBe(
          resolveSkillEnabled({ speak: g }, { speak: f }, 'speak')
        )
      }
    }
  })
})

describe('AC-3b — a global flip writes NO per-folder value', () => {
  it('setGlobalAgentSpeech carries the folders map over untouched', () => {
    const before = prefs(false, { [REPO]: false, [OTHER]: true })
    const after = setGlobalAgentSpeech(before, true)
    expect(after.global).toBe(true)
    expect(after.folders).toEqual({ [REPO]: false, [OTHER]: true })
  })

  it('a folder muted BEFORE the global went on stays silent afterwards', () => {
    // The whole failure mode this rule exists to prevent: the naive materialising
    // implementation would have written `true` into REPO here.
    const muted = setFolderAgentSpeech(EMPTY_AGENT_SPEECH_PREFS, REPO, false)
    const after = setGlobalAgentSpeech(muted, true)
    expect(resolveAgentSpeechEnabled(after, REPO)).toBe(false)
    expect(resolveAgentSpeechEnabled(after, OTHER)).toBe(true)
  })

  it('a folder that never had a value inherits the new global with no write of its own', () => {
    const after = setGlobalAgentSpeech(EMPTY_AGENT_SPEECH_PREFS, true)
    expect(after.folders).toEqual({})
    expect(resolveAgentSpeechEnabled(after, '/a/folder/that/did/not/exist/yet')).toBe(true)
  })

  it('setFolderAgentSpeech(null) clears an override back to inheritance', () => {
    const on = prefs(true, { [REPO]: false })
    const cleared = setFolderAgentSpeech(on, REPO, null)
    expect(REPO in cleared.folders).toBe(false)
    expect(resolveAgentSpeechEnabled(cleared, REPO)).toBe(true)
  })

  it('setFolderAgentSpeech preserves the global and never mutates its input', () => {
    const before = prefs(true, { [OTHER]: true })
    const after = setFolderAgentSpeech(before, REPO, false)
    expect(after.global).toBe(true)
    expect(after.folders).toEqual({ [OTHER]: true, [REPO]: false })
    expect(before.folders).toEqual({ [OTHER]: true })
  })
})

describe('AC-3c/3d — the gate, and which refusal it names', () => {
  it('a BLOCKED folder is silent regardless of global or per-folder value', () => {
    for (const p of [prefs(true), prefs(true, { [REPO]: true }), prefs(false, { [REPO]: true })]) {
      expect(resolveSpeakGate(p, REPO, true)).toBe('folder-blocked')
    }
  })

  it('an explicit per-folder OFF reports folder-muted, not global-off', () => {
    // The two are told apart on purpose: "ask for the global switch" is the wrong
    // advice for a folder someone deliberately silenced.
    expect(resolveSpeakGate(prefs(true, { [REPO]: false }), REPO, false)).toBe('folder-muted')
  })

  it('an unset folder under an off/unset global reports global-off', () => {
    expect(resolveSpeakGate(prefs(false), REPO, false)).toBe('global-off')
    expect(resolveSpeakGate(EMPTY_AGENT_SPEECH_PREFS, REPO, false)).toBe('global-off')
  })

  it('an allowed folder reports allowed', () => {
    expect(resolveSpeakGate(prefs(true), REPO, false)).toBe('allowed')
  })

  it('every silent gate maps to its own refusal code', () => {
    expect(SPEAK_GATE_ERRORS).toEqual({
      'folder-blocked': 'FOLDER_NOT_ALLOWED',
      'folder-muted': 'VOICE_MUTED_FOR_FOLDER',
      'global-off': 'VOICE_DISABLED'
    })
  })
})

describe('parseAgentSpeechPrefs — total, and never fails toward speech', () => {
  it.each([null, undefined, 42, 'nope', [], { folders: 'nope' }])(
    'degrades %p to the empty (silent) prefs',
    (raw) => {
      expect(parseAgentSpeechPrefs(raw)).toEqual({ version: 1, folders: {} })
    }
  )

  it('keeps booleans and DROPS non-boolean folder values rather than coercing them', () => {
    // Coercing `"false"` would turn a mute into speech — the one direction this
    // parser must never fail in.
    const parsed = parseAgentSpeechPrefs({
      global: true,
      folders: { [REPO]: false, [OTHER]: 'false', '/x': 1, '': true }
    })
    expect(parsed).toEqual({ version: 1, global: true, folders: { [REPO]: false } })
  })

  it('a non-boolean global is dropped, leaving it unset (⇒ silent)', () => {
    expect(parseAgentSpeechPrefs({ global: 'yes' }).global).toBeUndefined()
  })

  it('round-trips what the setters produce', () => {
    const built = setFolderAgentSpeech(
      setGlobalAgentSpeech(EMPTY_AGENT_SPEECH_PREFS, true),
      REPO,
      false
    )
    expect(parseAgentSpeechPrefs(JSON.parse(JSON.stringify(built)))).toEqual(built)
  })
})

describe('the rate limit — one looping agent cannot hold the speakers', () => {
  const T0 = 1_700_000_000_000

  it('allows up to the limit inside one window, then refuses', () => {
    let hits: number[] = []
    for (let i = 0; i < SPEAK_RATE_LIMIT; i++) {
      const v = checkSpeakRate(hits, T0 + i)
      expect(v.allowed).toBe(true)
      hits = v.hits
    }
    const refused = checkSpeakRate(hits, T0 + SPEAK_RATE_LIMIT)
    expect(refused.allowed).toBe(false)
    expect(refused.retryAfterMs).toBeGreaterThan(0)
  })

  it('a refused attempt is NOT counted — retrying cannot push recovery further away', () => {
    const full = Array.from({ length: SPEAK_RATE_LIMIT }, (_, i) => T0 + i)
    const first = checkSpeakRate(full, T0 + 10)
    const second = checkSpeakRate(first.hits, T0 + 20)
    expect(first.hits).toEqual(full)
    expect(second.hits).toEqual(full)
    // The window still ages out on wall-clock time, not on how often it was asked.
    expect(second.retryAfterMs).toBeLessThan(first.retryAfterMs)
  })

  it('hits older than the window are pruned and the caller is allowed again', () => {
    const old = Array.from({ length: SPEAK_RATE_LIMIT }, (_, i) => T0 + i)
    const later = T0 + SPEAK_RATE_WINDOW_MS + SPEAK_RATE_LIMIT
    const v = checkSpeakRate(old, later)
    expect(v.allowed).toBe(true)
    expect(v.hits).toEqual([later])
  })

  it('retryAfterMs points at the moment the OLDEST hit ages out', () => {
    const hits = Array.from({ length: SPEAK_RATE_LIMIT }, (_, i) => T0 + i * 1000)
    const v = checkSpeakRate(hits, T0 + 2000)
    expect(v.allowed).toBe(false)
    expect(v.retryAfterMs).toBe(SPEAK_RATE_WINDOW_MS - 2000)
  })
})

describe('the rate-limit registry — bounded, and per key', () => {
  const T0 = 1_800_000_000_000

  beforeEach(() => {
    __resetSpeakRateForTests()
  })

  it('keeps separate windows per key', () => {
    for (let i = 0; i < SPEAK_RATE_LIMIT; i++) recordSpeakAttempt('a', T0 + i)
    expect(recordSpeakAttempt('a', T0 + 100).allowed).toBe(false)
    expect(recordSpeakAttempt('b', T0 + 100).allowed).toBe(true)
  })

  it('reports the remaining allowance and a retry hint', () => {
    expect(recordSpeakAttempt('c', T0).remaining).toBe(SPEAK_RATE_LIMIT - 1)
    for (let i = 1; i < SPEAK_RATE_LIMIT; i++) recordSpeakAttempt('c', T0 + i)
    const refused = recordSpeakAttempt('c', T0 + 50)
    expect(refused.remaining).toBe(0)
    expect(refused.retryAfterMs).toBeGreaterThan(0)
  })

  it('sweeps aged-out windows once it holds more keys than the threshold', () => {
    // Without the sweep the map keeps one entry per session that EVER spoke, for
    // the life of the app.
    for (let i = 0; i < 300; i++) recordSpeakAttempt(`old-${i}`, T0)
    expect(__speakRateKeyCountForTests()).toBe(300)
    // One call a full window later: every old key has aged out and is dropped.
    recordSpeakAttempt('fresh', T0 + SPEAK_RATE_WINDOW_MS + 1)
    expect(__speakRateKeyCountForTests()).toBe(1)
  })
})

describe('the "not spoken" hints — a success the agent must not misread', () => {
  it('names the SECOND switch for engine-off, and points at notify', () => {
    const hint = speakUnspokenHint('engine-off')!
    expect(hint).toMatch(/SECOND switch/)
    expect(hint).toMatch(/notify/)
  })

  it('tells the agent not to retry a mute or a focused suppression', () => {
    expect(speakUnspokenHint('muted')).toMatch(/[Dd]o not retry/)
    expect(speakUnspokenHint('focused')).toMatch(/do not retry/)
  })

  it('invents nothing for an unknown or absent reason', () => {
    expect(speakUnspokenHint('something-new')).toBeUndefined()
    expect(speakUnspokenHint(undefined)).toBeUndefined()
  })
})
