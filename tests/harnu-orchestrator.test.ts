import { describe, it, expect } from 'vitest'
import {
  HARNU_ORCHESTRATOR_DOC,
  HARNU_ORCHESTRATOR_VERSION,
  parseOrchestratorVersion
} from '../src/main/harnu-orchestrator'

/**
 * T108 — the orchestrator contract doc's version-marker parser, mirroring
 * `harnu-features.ts`'s `HARNU_FEATURES_VERSION` pattern. Injection into a live
 * session's boot preamble is wired in `pty.ts` (T98); this only proves the
 * doc loads and the marker parses.
 */

describe('harnu-orchestrator doc', () => {
  it('loads the trimmed doc with the DRAFT marker stripped', () => {
    expect(HARNU_ORCHESTRATOR_DOC.startsWith('<!-- harnu-orchestrator v')).toBe(true)
    expect(HARNU_ORCHESTRATOR_DOC).not.toContain('DRAFT for operator review')
    expect(HARNU_ORCHESTRATOR_DOC).toContain('# You are the Orchestrator')
  })

  it('parses the version marker', () => {
    expect(HARNU_ORCHESTRATOR_VERSION).toBe('v5')
  })

  it('accepts both the harnu- and the pre-rename capy- marker prefix', () => {
    expect(parseOrchestratorVersion('<!-- harnu-orchestrator v9 (2026-10-03) -->')).toBe('v9')
    expect(parseOrchestratorVersion('<!-- capy-orchestrator v3 (2026-07-13) -->')).toBe('v3')
    expect(parseOrchestratorVersion('no marker')).toBe('v0')
  })
})
