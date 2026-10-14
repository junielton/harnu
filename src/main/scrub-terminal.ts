/**
 * Scrubbing for everything an agent receives from a terminal (T474 B4, spec §4.5, D-scrub).
 *
 * A thin seam over `redactTranscript` — the same best-effort scrubber `get_session` uses (home
 * path → `~`, AWS key ids, `Bearer`/`Authorization` values, secret-looking `KEY=VALUE`, PEM
 * blocks) — applied to `read_terminal.text`, `list_terminals.title` and (B8) `send_terminal`'s
 * `output` and `wait.match`, on BOTH agent-spawned and operator-opened terminals.
 *
 * Not a security boundary (see `transcript-redact.ts`): a secret in a shape it does not know
 * passes through, and a value that merely looks like one comes back as `<redacted>` even when the
 * agent produced it. A `waitFor` pattern is matched against the unscrubbed screen, so scrubbing
 * never changes what matches.
 *
 * Pure (ADR-0001).
 */
import { redactTranscript } from './mcp/transcript-redact'

/** Scrub one piece of terminal text for disclosure to an agent. */
export function scrubTerminalText(text: string, home: string): string {
  return redactTranscript(text, { home }).text
}
