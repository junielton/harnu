/**
 * When mouse and key events sent over CDP reach a pane's document (T564 U4, Delta 2). The rule is EMPIRICAL: it was
 * measured on the real app (second isolated instance, a real MCP client, a fixture page whose Count button
 * increments `window.n`), and the root cause is not understood. Pure (ADR-0001): the view host feeds it every
 * main-frame commit.
 *
 * Measured (each row on a fresh pane; "delivers" = the click incremented `n`):
 *
 *   E1  the first document a pane loads                                  DROPPED
 *   E2  about:blank first, then Harnu navigates to the site              DROPPED
 *   E3b a cross-site second navigation (localhost → 127.0.0.1)           DROPPED
 *   E3c a same-site second navigation (another path)                     delivers
 *   E4  first document is a script's `location.replace` to the site      DROPPED
 *   E6  `history.pushState` on the first document                        DROPPED
 *   E7  first document, then Harnu navigates to the same URL             delivers
 *   E8  cross-site 2nd navigation (DROPPED), then a reload               delivers
 *   E9  A → B → A (two cross-site navigations)                           DROPPED
 *   E10 about:blank → site (DROPPED), then a reload                      delivers
 *
 * and, on the build with the parking metrics override switched off: EVERYTHING dropped, even after a reload; with the
 * override re-sent on every load: no change. `insertText` (`fill`, a plain `type`), `eval` and `snapshot` were
 * delivered in every row.
 *
 * The rule that fits every row: the pane is READY once HARNU navigates it (the navigate verb, the address bar, back,
 * forward, reload) to the SAME host as the commit before it; a commit on another host (or from about:blank, or the
 * first one) makes it not ready; a navigation the page started itself on the same host changes nothing.
 */

export interface InputReadyState {
  /** Mouse and key events reach the current document. */
  ready: boolean
  /** The host (with port) of the last main-frame commit, `null` before the first. */
  lastHost: string | null
}

export function initialInputReadyState(): InputReadyState {
  return { ready: false, lastHost: null }
}

export function nextInputReadyState(
  prev: InputReadyState,
  commit: { host: string; initiatedByHarnu: boolean }
): InputReadyState {
  const sameHost = prev.lastHost !== null && prev.lastHost !== '' && commit.host === prev.lastHost
  if (!sameHost) return { ready: false, lastHost: commit.host }
  if (commit.initiatedByHarnu) return { ready: true, lastHost: commit.host }
  return { ready: prev.ready, lastHost: commit.host }
}
