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
