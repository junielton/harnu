import { describe, it, expect } from 'vitest'
import {
  parseVoicePrefs,
  loadVoicePrefs,
  DEFAULT_VOICE_PREFS,
  SPEECH_MAX_CHARS_CEILING
} from '../src/renderer/src/lib/speech-prefs'

describe('voice defaults', () => {
  it('leaves the engine opt-in — speech never starts without the operator saying so', () => {
    expect(DEFAULT_VOICE_PREFS.enabled).toBe(false)
  })

  it('does not carry the TTS command — main owns that, not the renderer', () => {
    expect(DEFAULT_VOICE_PREFS).not.toHaveProperty('command')
  })
})

describe('parseVoicePrefs', () => {
  it('falls back to defaults for missing, corrupt or non-object input', () => {
    expect(parseVoicePrefs(null)).toEqual(DEFAULT_VOICE_PREFS)
    expect(parseVoicePrefs('')).toEqual(DEFAULT_VOICE_PREFS)
    expect(parseVoicePrefs('{not json')).toEqual(DEFAULT_VOICE_PREFS)
    expect(parseVoicePrefs('"a string"')).toEqual(DEFAULT_VOICE_PREFS)
    expect(parseVoicePrefs('null')).toEqual(DEFAULT_VOICE_PREFS)
  })

  it('fills a partial blob from the defaults', () => {
    expect(parseVoicePrefs(JSON.stringify({ enabled: true }))).toEqual({
      ...DEFAULT_VOICE_PREFS,
      enabled: true
    })
  })

  it('coerces truthy/falsy values to real booleans', () => {
    const prefs = parseVoicePrefs(JSON.stringify({ enabled: 1, muted: 0 }))
    expect(prefs.enabled).toBe(true)
    expect(prefs.muted).toBe(false)
  })

  it('rejects an unknown backend id', () => {
    expect(parseVoicePrefs(JSON.stringify({ backend: 'bundled-kokoro' })).backend).toBe(
      'system-command'
    )
  })

  it('drops a `command` smuggled into the stored blob', () => {
    const prefs = parseVoicePrefs(JSON.stringify({ command: '/usr/bin/attacker-payload' }))
    expect(prefs).not.toHaveProperty('command')
  })

  it('clamps maxChars into a runnable range', () => {
    expect(parseVoicePrefs(JSON.stringify({ maxChars: 0 })).maxChars).toBe(1)
    expect(parseVoicePrefs(JSON.stringify({ maxChars: -5 })).maxChars).toBe(1)
    expect(parseVoicePrefs(JSON.stringify({ maxChars: 1e9 })).maxChars).toBe(
      SPEECH_MAX_CHARS_CEILING
    )
    expect(parseVoicePrefs(JSON.stringify({ maxChars: 120.7 })).maxChars).toBe(120)
    expect(parseVoicePrefs(JSON.stringify({ maxChars: 'lots' })).maxChars).toBe(
      DEFAULT_VOICE_PREFS.maxChars
    )
  })
})

describe('loadVoicePrefs', () => {
  it('returns defaults outside a browser instead of throwing', () => {
    expect(typeof localStorage).toBe('undefined')
    expect(loadVoicePrefs()).toEqual(DEFAULT_VOICE_PREFS)
  })
})
