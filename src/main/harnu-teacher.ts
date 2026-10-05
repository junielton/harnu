/**
 * "Teacher contract" doc (T123) — the pedagogical contract injected as the
 * append-system-prompt preamble when a session is born in `Modes ▸ Learning`. Mirrors
 * `harnu-orchestrator.ts` (the same pattern: a versioned doc embedded via `?raw`).
 *
 * This is what takes the pedagogy out of the personal `/teach` skill and makes it part of
 * the product: it reaches any machine, for any user, with nothing to install.
 *
 * Zero electron/node deps ⇒ directly unit-testable, with no environment mock.
 */

import rawDoc from '../../docs/harnu-teacher.md?raw'

/** The contract, trimmed. Injected verbatim by `session-modes` at spawn. */
export const HARNU_TEACHER_DOC = rawDoc.trim()

/** Parse a `<!-- harnu-teacher vN ... -->` marker (the pre-rename `capy-` prefix is accepted too). */
export function parseTeacherVersion(doc: string): string {
  const m = /<!--\s*(?:harnu|capy)-teacher\s+(v\d+)/i.exec(doc)
  return m ? m[1] : 'v0'
}

/** Parsed version marker for staleness/debugging. */
export const HARNU_TEACHER_VERSION = parseTeacherVersion(rawDoc)
