/**
 * Pure naming + path helpers for the JSONL fallback reader (spec Phase 3,
 * N1/N2/G1). No fs/electron deps so they are unit-testable in isolation.
 */

const MAX_PROMPT_LEN = 120
const WORKTREE_MARKER = '/.claude/worktrees/'

/** Pull the command id out of a `<command-name>…</command-name>` wrapper, or ''. */
export function extractCommandName(raw: string): string {
  const m = raw.match(/<command-name>([\s\S]*?)<\/command-name>/)
  return m ? m[1].trim() : ''
}

/**
 * Remove meta-content wrappers Claude Code injects into user turns
 * (`<system-reminder>`, `<command-message>`, `<command-name>`, `<command-args>`,
 * `<local-command-stdout>`, `<local-command-caveat>`), then collapse whitespace
 * and trim. A defensively unclosed trailing `<system-reminder>` (truncated head
 * scan) is also dropped.
 */
export function stripMetaWrappers(raw: string): string {
  return (
    raw
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
      .replace(/<command-message>[\s\S]*?<\/command-message>/g, ' ')
      .replace(/<command-name>[\s\S]*?<\/command-name>/g, ' ')
      .replace(/<command-args>[\s\S]*?<\/command-args>/g, ' ')
      .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, ' ')
      // BUG-77: the caveat Claude Code prepends to a slash-command turn. Left
      // unstripped, a session whose first turn was a local command took the
      // caveat sentence itself as its sidebar label.
      .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, ' ')
      // Defensive: an unclosed wrapper opened by a truncated head scan.
      .replace(/<system-reminder>[\s\S]*$/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  )
}

/**
 * The first meaningful user prompt across an ordered list of user-turn texts
 * (N1/N2). A slash-command turn resolves to its command name; otherwise the
 * turn's text minus meta wrappers is used. Skips turns that are pure meta.
 * Result is truncated to MAX_PROMPT_LEN. Returns '' if nothing real is found.
 */
export function firstRealPrompt(userTexts: string[]): string {
  for (const raw of userTexts) {
    const cmd = extractCommandName(raw)
    if (cmd) return cmd.slice(0, MAX_PROMPT_LEN)
    const stripped = stripMetaWrappers(raw)
    if (stripped) return stripped.slice(0, MAX_PROMPT_LEN)
  }
  return ''
}

/**
 * The root repo path for a session cwd (G1): everything before a Claude
 * worktree marker, or the cwd unchanged when it is not under a worktree.
 */
export function rootRepoPath(cwd: string): string {
  const i = cwd.indexOf(WORKTREE_MARKER)
  return i >= 0 ? cwd.slice(0, i) : cwd
}
