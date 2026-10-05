/**
 * Writer registry — decouples the footer's Re-attach (Pasted-images gallery)
 * from `TerminalPane.vue`'s module-private `liveTerminals` map.
 *
 * `TerminalPane` registers a `write` for each live session (wireLiveTerminal)
 * and unregisters it on dispose. The footer can then inject a path into the
 * focused session's PTY without reaching into the terminal internals or
 * duplicating `ptyId` into the store. Pure module — no electron, leaf-level.
 */

const writers = new Map<string, (data: string) => void>()

/** Register the live PTY writer for a session (called when its terminal wires up). */
export function registerWriter(sessionId: string, write: (data: string) => void): void {
  writers.set(sessionId, write)
}

/** Drop a session's writer (called on terminal dispose). No-op if absent. */
export function unregisterWriter(sessionId: string): void {
  writers.delete(sessionId)
}

/**
 * Write to a session's live PTY. Returns false (safe no-op) when the session
 * has no live terminal — e.g. a dormant session without a PTY.
 */
export function writeToSession(sessionId: string, data: string): boolean {
  const write = writers.get(sessionId)
  if (!write) return false
  write(data)
  return true
}
