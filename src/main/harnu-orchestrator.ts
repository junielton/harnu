/**
 * "Orchestrator contract" doc (T108) — the promoted-session contract that will be
 * injected as an append-system-prompt preamble once T98 wires the promote/demote
 * toggle (mirroring `harnu-features.ts`'s `HARNU_FEATURES_DOC`/`HARNU_FEATURES_VERSION`
 * pattern exactly). This PR only lands the doc + its version parser — no injection
 * wiring, no IPC, no toggle: T98 is the one that calls `arm()`/`disarm()`
 * (`orchestrator-guard.ts`) and prepends `HARNU_ORCHESTRATOR_DOC` at spawn.
 *
 * Zero electron/node deps (unlike `harnu-features.ts`, which also owns an
 * enabled-flag file + IPC) — just the versioned raw doc, so this is directly
 * unit-testable with no environment mocking.
 */

import rawDoc from '../../docs/harnu-orchestrator.md?raw'

/** The contract doc, trimmed. Will be injected verbatim once T98 wires promote/demote. */
export const HARNU_ORCHESTRATOR_DOC = rawDoc.trim()

/** Parse a `<!-- harnu-orchestrator vN ... -->` marker (the pre-rename `capy-` prefix is accepted too). */
export function parseOrchestratorVersion(doc: string): string {
  const m = /<!--\s*(?:harnu|capy)-orchestrator\s+(v\d+)/i.exec(doc)
  return m ? m[1] : 'v0'
}

/** Parsed version marker for staleness/debugging. */
export const HARNU_ORCHESTRATOR_VERSION = parseOrchestratorVersion(rawDoc)
