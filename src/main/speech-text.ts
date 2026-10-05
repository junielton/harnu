/**
 * T238 — how an agent's utterance is normalised and capped, and nothing else.
 *
 * Split out from `speech-gate-core.ts` so the two modules that only need the CAP
 * — `mcp/validate.ts` and `mcp/plan-input.ts`, both of which document a
 * deliberately tiny import surface — do not transitively pull in the cascade and
 * its `node:crypto` dependency to read one number and one string function.
 *
 * Zero imports, by design: this is the leaf.
 */

/**
 * The hard per-call cap for an AGENT utterance — roughly 20 seconds of speech.
 *
 * Deliberately far below the engine's own `maxChars` (800, `speech-prefs.ts`):
 * that ceiling is the operator's, for text THEY asked to be read; this one is the
 * agent's, and an agent reading a paragraph at the room is the failure mode the
 * cap exists to prevent. Over-cap text is TRUNCATED, never rejected — a refusal
 * would teach the agent to retry with a re-summarised string, which costs a turn
 * to achieve exactly what truncation already did.
 */
export const SPEAK_MAX_CHARS = 300

/**
 * The normalisation half of {@link clampSpokenText}, with no cap: collapse
 * whitespace (a multi-line blob is one breath, not one line per newline) and drop
 * leading dashes, so the text can never be read as a flag by the spawned command.
 *
 * Split out so a caller can measure what the UNCAPPED utterance would have been
 * and report truncation honestly, instead of comparing against the raw string —
 * whitespace collapse alone shortens most text and would make every call look
 * truncated.
 */
export function normalizeSpokenText(text: unknown): string {
  if (typeof text !== 'string') return ''
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[-\s]+/, '')
}

/**
 * Normalise an utterance for the ear and cap it at a word boundary.
 *
 * MIRRORS `clampSpeechText` in `src/renderer/src/lib/speech.ts` — same collapse,
 * same leading-dash strip, same word-boundary rule. It is duplicated rather than
 * imported because main must not pull a renderer module into its build; the two
 * are pinned to identical behaviour by an agreement test that runs both over the
 * same table (`tests/speech-gate-core.test.ts`).
 */
export function clampSpokenText(text: unknown, maxChars: number = SPEAK_MAX_CHARS): string {
  const flat = normalizeSpokenText(text)
  const limit = Math.max(1, Math.floor(maxChars))
  if (flat.length <= limit) return flat
  const head = flat.slice(0, limit)
  const lastSpace = head.lastIndexOf(' ')
  return (lastSpace > limit * 0.5 ? head.slice(0, lastSpace) : head).trimEnd()
}
