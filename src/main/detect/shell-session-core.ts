/**
 * Shell-session fleet registry core (A2 — W6.2, MCP fleet cross-agent).
 *
 * Folder terminals (`isShellTerminal`) are renderer-only, ephemeral sessions —
 * they never hit `~/.claude/projects/`, so `scanFolders` (the MCP fleet's
 * session source) doesn't see them. To make the fleet snapshot cross-agent (a
 * `codex`/`aider` pane shows up with its screen-derived `taskState`), the
 * renderer REPORTS its live shell terminals to main, which holds them and feeds
 * them into the fleet alongside the on-disk Claude sessions.
 *
 * This pure core is the validation boundary: the report arrives over IPC as
 * UNTRUSTED data, so {@link sanitizeShellSessions} narrows it to well-formed
 * {@link ShellSessionInfo} before the shell stores it. No transcript or last
 * line is ever carried — only id/folder/timestamp, exactly the redacted shape
 * the fleet projects.
 */

/** The minimal, redaction-safe slice of a folder terminal the fleet needs. */
export interface ShellSessionInfo {
  /** The renderer's `shellterm-<uuid>` session id. */
  sessionId: string
  /** Absolute owning-folder path (`projectPath`); redacted to an alias by the fleet. */
  folderPath: string
  /** ISO timestamp for fleet ordering; `''` when absent. */
  modified: string
}

/**
 * Narrow an untrusted reported list to well-formed {@link ShellSessionInfo}s.
 * Drops anything missing a non-empty `sessionId` or a string `folderPath`; never
 * throws. Pure.
 */
export function sanitizeShellSessions(raw: unknown): ShellSessionInfo[] {
  if (!Array.isArray(raw)) return []
  const out: ShellSessionInfo[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const r = item as Record<string, unknown>
    if (typeof r.sessionId !== 'string' || r.sessionId.length === 0) continue
    if (typeof r.folderPath !== 'string') continue
    out.push({
      sessionId: r.sessionId,
      folderPath: r.folderPath,
      modified: typeof r.modified === 'string' ? r.modified : ''
    })
  }
  return out
}
