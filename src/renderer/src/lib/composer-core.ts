/**
 * Pure Composer send-sequence core (T40). The load-bearing correctness behind a
 * multi-line draft that gets injected into a running Claude/shell PTY: multi-line
 * text written RAW makes every newline submit a line in the TUI prompt
 * (premature/mangled sends). The fix is **bracketed paste** — fence the body in
 * `ESC[200~ … ESC[201~` so the TUI inserts it as one atomic block, then send a
 * separate `\r` to submit. Modern TUIs (Claude Code, readline shells) honor it
 * (DECSET 2004); the app already relies on it for `⌘V` (`lib/terminalKeymap.ts`).
 *
 * Framework-free (no Vue/electron/DOM) so it's unit-tested in isolation
 * (`tests/composer-core.test.ts`), matching the repo's pure-core discipline
 * (`context-digest` / `closure-core` / `sentinel-core`). The env-bound send (the
 * `writeToSession` bus + the two-phase timing) lands with the Composer UI (slice 2).
 */

/** Bracketed-paste fence sequences + the submit byte. */
export const PASTE_START = '\x1b[200~'
export const PASTE_END = '\x1b[201~'
export const SUBMIT = '\r'

/**
 * Normalize a draft for injection: collapse `\r\n` and lone `\n` to `\r` (matching
 * xterm's own `prepareTextForTerminal`, so our hand-rolled wrap is byte-compatible
 * with the `term.paste()` path already in the app).
 */
export function normalizeDraft(text: string): string {
  return text.replace(/\r\n/g, '\r').replace(/\n/g, '\r')
}

/**
 * Wrap a draft in a bracketed paste, safe to write into a 2004-enabled TUI. Strips
 * any embedded `ESC[201~` first: without this, a crafted/pasted draft containing
 * the paste terminator could close the fence early and let the bytes after it
 * execute as real input (a paste-injection escape).
 */
export function buildBracketedPaste(text: string): string {
  const normalized = normalizeDraft(text)
  const safe = normalized.split(PASTE_END).join('')
  return `${PASTE_START}${safe}${PASTE_END}`
}

/**
 * The two-phase send sequence for a draft: `[pasteBytes, submitBytes]`. The caller
 * writes the paste, waits one render frame (~50ms — the TUI needs a tick to
 * register the block, mirroring the existing agent-prompt injector), then writes
 * the `\r`. Returns `null` for an empty/whitespace-only draft (nothing to send).
 */
export function composeSubmitSequence(text: string): [string, string] | null {
  if (text.trim().length === 0) return null
  return [buildBracketedPaste(text), SUBMIT]
}
