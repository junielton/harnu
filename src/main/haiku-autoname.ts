/**
 * Pure logic for Haiku auto-naming of synthetic sessions.
 *
 * Mirrors the `usage-parse.ts` (pure) / `usage.ts` (shell) split: zero electron/fs
 * deps, so it's unit-testable in the `node` vitest env (`tests/haiku-autoname.test.ts`).
 * All the risk (prompt building, parsing the model output, the fire/no-fire guard)
 * lives here; the imperative shell that spawns `claude` lives in `haiku.ts`.
 */

const TITLE_MAX = 60
const SUMMARY_MAX = 120

/** System prompt: instructs Haiku to return a strict JSON title + summary. */
export const AUTONAME_SYSTEM =
  'You name coding sessions. Given the first user message, reply with ONLY a JSON ' +
  'object {"title": "...", "summary": "..."}. title: at most 6 words, lowercase, no ' +
  'trailing period, no quotes, keep technical nouns (worktree, branch, etc.) intact. ' +
  'summary: one complete sentence ending in a period. No emoji, no exclamation marks.'

/** Wrap the (already cleaned) first user message into the auto-name prompt. */
export function deriveAutonamePrompt(firstUserText: string): string {
  const text = firstUserText.trim()
  if (!text) return ''
  return `First user message of a coding session:\n\n${text}`
}

/**
 * The exact `claude` argv for a Haiku call. `--model haiku` is the (non-overridable)
 * cost cap; the system prompt always rides `--append-system-prompt`; never `--bare`
 * (that would force API-key auth and ignore subscription OAuth — see usage.ts).
 */
export function buildHaikuArgs(prompt: string, system?: string): string[] {
  const args = ['-p', prompt, '--model', 'haiku']
  if (system) args.push('--append-system-prompt', system)
  return args
}

export interface AutonameResult {
  title: string
  summary: string
}

/** Sanitize a title: strip wrapping quotes + trailing period, collapse whitespace, cap length. */
export function clampTitle(raw: string): string {
  let t = raw.trim()
  t = t
    .replace(/^["'`]+/, '')
    .replace(/["'`]+$/, '')
    .trim()
  t = t.replace(/\s+/g, ' ')
  t = t.replace(/[.。…]+$/, '').trim()
  if (t.length > TITLE_MAX) t = t.slice(0, TITLE_MAX).trim()
  return t
}

/** Sanitize a summary: flatten to one line, collapse whitespace, cap length. */
export function clampSummary(raw: string): string {
  let s = raw.replace(/\s+/g, ' ').trim()
  if (s.length > SUMMARY_MAX) s = s.slice(0, SUMMARY_MAX).trim()
  return s
}

/**
 * Parse the Haiku stdout into `{ title, summary }`. Tries an embedded JSON object
 * first, then loose `title:` / `summary:` lines. Never throws — illegible output
 * yields empty fields and the consumer keeps `firstPrompt`.
 */
export function parseAutonameResult(stdout: string): AutonameResult {
  const block = stdout.match(/\{[\s\S]*\}/)
  if (block) {
    try {
      const o = JSON.parse(block[0]) as { title?: unknown; summary?: unknown }
      return {
        title: clampTitle(typeof o.title === 'string' ? o.title : ''),
        summary: clampSummary(typeof o.summary === 'string' ? o.summary : '')
      }
    } catch {
      /* fall through to loose parsing */
    }
  }
  const tm = stdout.match(/title\s*[:=]\s*(.+)/i)
  const sm = stdout.match(/summary\s*[:=]\s*(.+)/i)
  return { title: clampTitle(tm?.[1] ?? ''), summary: clampSummary(sm?.[1] ?? '') }
}

/**
 * Decide whether a session should be auto-named right now. Pure — no `Date.now()`
 * / age input (lesson 001): naming depends only on state, never on how old the
 * session is.
 */
export function shouldAutoname(input: {
  enabled: boolean
  synthetic: boolean
  hasCustomOrAiTitle: boolean
  alreadyNamed: boolean
  firstUserText: string
}): boolean {
  return (
    input.enabled &&
    input.synthetic &&
    !input.hasCustomOrAiTitle &&
    !input.alreadyNamed &&
    input.firstUserText.trim() !== ''
  )
}
