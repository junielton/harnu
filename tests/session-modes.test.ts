import { describe, expect, it } from 'vitest'
import { HARNU_TEACHER_DOC } from '../src/main/harnu-teacher'
import { SESSION_MODES, isSessionModeId, modeContract } from '../src/main/session-modes'

describe('session modes registry', () => {
  it('ships exactly one mode in v1: learning', () => {
    expect(SESSION_MODES.map((m) => m.id)).toEqual(['learning'])
  })

  it('every mode carries a non-empty contract + an i18n label key', () => {
    for (const m of SESSION_MODES) {
      expect(m.doc.length).toBeGreaterThan(0)
      expect(m.labelKey).toMatch(/^folderMenu\.modes\./)
      expect(m.icon.length).toBeGreaterThan(0)
    }
  })
})

describe('isSessionModeId', () => {
  it('accepts a known id', () => {
    expect(isSessionModeId('learning')).toBe(true)
  })
  it('rejects anything else (untrusted input from the renderer/IPC)', () => {
    for (const bad of ['orchestrator', '', 'LEARNING', null, undefined, 42, {}]) {
      expect(isSessionModeId(bad)).toBe(false)
    }
  })
})

describe('modeContract', () => {
  it('resolves the learning contract', () => {
    expect(modeContract('learning')).toBe(HARNU_TEACHER_DOC)
  })
  it('returns an EMPTY string for undefined / unknown — a normal session gets no contract', () => {
    expect(modeContract(undefined)).toBe('')
    expect(modeContract('nope')).toBe('')
  })
})
