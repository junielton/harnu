/**
 * Pure, best-effort transcript scrubber for the Harnu MCP `get_session` tool (T8).
 *
 * Before a session transcript is disclosed over MCP it passes through
 * {@link redactTranscript}, which (1) rewrites the caller's absolute home path to
 * a `~` alias so the OS username never leaks, and (2) redacts a handful of common
 * secret shapes to a literal `<redacted>` marker:
 *   - AWS access key ids (`AKIA…` / `ASIA…`),
 *   - `Bearer <token>` credentials and `Authorization:` header values,
 *   - sensitive `KEY=VALUE` env dumps (key name looks like a secret),
 *   - PEM `PRIVATE KEY` blocks.
 *
 * IMPORTANT — this is **best-effort**, not a security boundary. It is a regex /
 * heuristic pass: novel secret encodings, secrets split across lines, or values
 * with no recognizable key/shape will pass through. Treat it as defense-in-depth
 * (reduce accidental disclosure), never as a guarantee that the output is
 * secret-free.
 *
 * The module is intentionally PURE (no `fs`/`electron`/`child_process` import):
 * deterministic given its inputs, so it lands in the pure-core coverage surface
 * (ADR-0001) and is trivially unit-testable. It is also IDEMPOTENT — every
 * replacement marker is chosen so that a second pass matches nothing
 * (`redactTranscript(redactTranscript(t).text).redactionCount === 0`), which
 * makes re-scrubbing always safe.
 */

/** Options for {@link redactTranscript}. */
export interface RedactOptions {
  /**
   * Absolute home directory of the current user. Any occurrence is rewritten to
   * the `~` alias. Pass `''` or `'/'` to disable aliasing (guards against nuking
   * every absolute path).
   */
  home: string
}

/** Result of a scrub pass. */
export interface RedactResult {
  /** The scrubbed text. */
  text: string
  /** How many substitutions were made (home aliases + secret redactions). */
  redactionCount: number
}

/** The marker substituted in for every redacted secret. */
const REDACTED = '<redacted>'

/** Escape a literal string for safe interpolation into a `RegExp`. */
function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Sensitive `KEY=VALUE` key-name fragments. A key qualifies if its name contains
 * any of these (case-insensitive). `PWD` is deliberately absent so the common
 * `PWD=` working-directory env var is not clobbered.
 */
const SENSITIVE_KEY =
  'SECRET|TOKEN|PASSWORD|PASSWD|PASSPHRASE|API[_-]?KEY|APIKEY|ACCESS[_-]?KEY|SECRET[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIALS?|AUTH'

/**
 * Best-effort scrub of a session transcript: alias the home path and redact
 * common secret shapes. See the module doc for the threat model — this is
 * defense-in-depth, not a guarantee.
 *
 * @param text - the raw transcript text.
 * @param options - {@link RedactOptions} (the home dir to alias).
 * @returns the `{ text, redactionCount }` result; `redactionCount` is the total
 *   number of substitutions performed. Idempotent: re-running over the output
 *   yields the same text and a `redactionCount` of `0`.
 */
export function redactTranscript(text: string, { home }: RedactOptions): RedactResult {
  let count = 0
  let out = text

  // 1. PEM private-key blocks (multiline) — redact the whole block first so its
  //    base64 body cannot trip the other heuristics.
  out = out.replace(
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    () => {
      count++
      return REDACTED
    }
  )

  // 2. AWS access key ids (AKIA/ASIA prefix + 16 base32-ish chars).
  out = out.replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, () => {
    count++
    return REDACTED
  })

  // 3. `Authorization:` header — redact the entire value (covers Bearer, Basic,
  //    etc.). The negative lookahead keeps a second pass from re-redacting.
  out = out.replace(
    /(\bAuthorization\b[ \t]*:[ \t]*)(?!<redacted>)\S[^\r\n]*/gi,
    (_m, prefix: string) => {
      count++
      return `${prefix}${REDACTED}`
    }
  )

  // 4. Bare `Bearer <token>` — keep the scheme keyword, redact the credential.
  //    The token charset excludes `<`/`>`, so the marker never re-matches.
  out = out.replace(/\bBearer[ \t]+[A-Za-z0-9\-._~+/]+=*/g, () => {
    count++
    return `Bearer ${REDACTED}`
  })

  // 5. Sensitive KEY=VALUE env dumps — redact the value, keep the key name. The
  //    value charset excludes `<`/`>` so the `<redacted>` marker never re-matches.
  const kvRe = new RegExp(
    `(\\b(?:export[ \\t]+)?[A-Za-z0-9_.-]*(?:${SENSITIVE_KEY})[A-Za-z0-9_.-]*)[ \\t]*=[ \\t]*[^\\s<>]+`,
    'gi'
  )
  out = out.replace(kvRe, (_m, key: string) => {
    count++
    return `${key}=${REDACTED}`
  })

  // 6. Home-dir aliasing — last, so any secret value containing the home path was
  //    already redacted above. Skipped when home is empty or root.
  if (home && home !== '/' && home.length > 1) {
    const homeRe = new RegExp(escapeRegExp(home), 'g')
    out = out.replace(homeRe, () => {
      count++
      return '~'
    })
  }

  return { text: out, redactionCount: count }
}
