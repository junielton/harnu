/**
 * Where a session's live terminal is found, without importing the terminal component (T569 U2).
 *
 * `TerminalPane.vue` owns the cache of live terminals and pulls in xterm, which cannot load outside a browser.
 * Stores that must deliver text to a session (`command-dispatch`'s `session.userTurn`) therefore ask this
 * module, and `TerminalPane` registers its own lookup when it loads.
 */
type Resolver = (sessionKey: string) => string | null

let resolver: Resolver = () => null

export function registerLivePtyResolver(fn: Resolver): void {
  resolver = fn
}

/** The PTY id of a session's live terminal, or `null` (never opened, parked, or closed). */
export function livePtyIdOf(sessionKey: string): string | null {
  return resolver(sessionKey)
}

/**
 * The PTY a session's cached terminal can be written to. An entry flagged `dead` (its process exited on its own;
 * the terminal stays cached so its scrollback stays viewable) is no one to talk to: a paste into it is lost, so it
 * answers `null` and the caller treats the session as not live (the way a parked one is), instead of reporting a
 * turn delivered that nothing read.
 */
export function liveTerminalPtyId(
  entry: { ptyId: string; dead: boolean } | null | undefined
): string | null {
  return entry && !entry.dead ? entry.ptyId : null
}
