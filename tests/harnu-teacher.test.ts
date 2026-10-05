import { describe, expect, it } from 'vitest'
import {
  HARNU_TEACHER_DOC,
  HARNU_TEACHER_VERSION,
  parseTeacherVersion
} from '../src/main/harnu-teacher'

describe('harnu-teacher doc', () => {
  it('parses the version marker', () => {
    expect(HARNU_TEACHER_VERSION).toBe('v7')
  })

  it('accepts both the harnu- and the pre-rename capy- marker prefix', () => {
    expect(parseTeacherVersion('<!-- harnu-teacher v9 (2026-10-03) -->')).toBe('v9')
    expect(parseTeacherVersion('<!-- capy-teacher v5 (2026-07-14) -->')).toBe('v5')
    expect(parseTeacherVersion('no marker')).toBe('v0')
  })

  // Lessons delivered before the rename report as `[capy-lesson]`: the contract
  // must keep grading them, while new lessons report as `[harnu-lesson]`.
  it('recognizes both the [harnu-lesson] and the legacy [capy-lesson] result prefix', () => {
    expect(HARNU_TEACHER_DOC).toContain('[harnu-lesson]')
    expect(HARNU_TEACHER_DOC).toContain('[capy-lesson]')
  })

  it('is non-empty and trimmed', () => {
    expect(HARNU_TEACHER_DOC.length).toBeGreaterThan(500)
    expect(HARNU_TEACHER_DOC).toBe(HARNU_TEACHER_DOC.trim())
  })

  it('carries the non-negotiable rules of the contract', () => {
    // If someone deletes one of these from the doc, the cycle stops existing; this test is the guard.
    expect(HARNU_TEACHER_DOC).toMatch(/learning\/mission/)
    expect(HARNU_TEACHER_DOC).toMatch(/learning\/path/)
    expect(HARNU_TEACHER_DOC).toMatch(/records/)
    expect(HARNU_TEACHER_DOC).toMatch(/Read the records BEFORE authoring the next lesson/i)
    expect(HARNU_TEACHER_DOC).toMatch(/Fluency is not retention/i)
    expect(HARNU_TEACHER_DOC).toMatch(/Declare the limits/i)
    expect(HARNU_TEACHER_DOC).toMatch(/mode: check/)
  })

  // CRITICAL fix (T123): the contract used to prescribe page ids the
  // memory_append gate rejected outright (`learning/mission.md` as a literal
  // filesystem path, `learning/records/NNNN-*` as a 3-segment page). The doc
  // must now use verb-addressed, flat page ids and never hardcode `.capy/memory/`.
  it('addresses memory through verbs + flat learning/<slug> page ids, never a literal path', () => {
    expect(HARNU_TEACHER_DOC).not.toMatch(/\.(capy|harnu)\/memory/)
    expect(HARNU_TEACHER_DOC).not.toMatch(/learning\/records\//) // no 3-segment record path
    expect(HARNU_TEACHER_DOC).toMatch(/learning\/resources/)
    expect(HARNU_TEACHER_DOC).toMatch(/learning\/record-NNNN/)
  })
})
