/**
 * Navigation and protocol policy of the browser pane guest (T564 U1, spec §3.2). Pure rules; the electron
 * shell (`view-host.ts`) wires them to `will-navigate`, `setWindowOpenHandler`, `onBeforeRequest` and the
 * permission handlers, so each layer asks the same question.
 */

/** The code a blocked top-level navigation refuses with on the verb path (spec §6.2). */
export const URL_SCHEME_BLOCKED = 'URL_SCHEME_BLOCKED'

/** Schemes a top-level navigation may use. `harnu-page:` is further restricted by who asks (U2). */
const ALLOWED_TOP_LEVEL = new Set(['http:', 'https:', 'harnu-page:', 'about:'])

/** Subresource schemes: the top-level set plus `blob:`, `data:`, `ws:`, `wss:`. */
const ALLOWED_SUBRESOURCE = new Set([...ALLOWED_TOP_LEVEL, 'blob:', 'data:', 'ws:', 'wss:'])

/** Who asks for the navigation: a verb, the operator at the address bar, or a link inside the page. */
export type NavInitiator = 'verb' | 'operator' | 'page'

export type NavVerdict =
  { ok: true; url: string } | { ok: false; code: typeof URL_SCHEME_BLOCKED; scheme: string }

/** `about:blank` is the only `about:` URL a pane may show. */
function isAllowedAbout(url: URL): boolean {
  return url.protocol === 'about:' && url.href === 'about:blank'
}

/**
 * Judge a top-level navigation target. `harnu-page:` is reachable only from a verb or the operator, never
 * from a link inside an `external`/`local` page (spec §3.2). An unparseable target refuses as a blocked
 * scheme with an empty scheme name.
 */
export function checkTopLevelNavigation(rawUrl: string, initiator: NavInitiator): NavVerdict {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { ok: false, code: URL_SCHEME_BLOCKED, scheme: '' }
  }
  const scheme = url.protocol.replace(/:$/, '')
  if (!ALLOWED_TOP_LEVEL.has(url.protocol)) return { ok: false, code: URL_SCHEME_BLOCKED, scheme }
  if (url.protocol === 'about:' && !isAllowedAbout(url)) {
    return { ok: false, code: URL_SCHEME_BLOCKED, scheme }
  }
  if (url.protocol === 'harnu-page:' && initiator === 'page') {
    return { ok: false, code: URL_SCHEME_BLOCKED, scheme }
  }
  return { ok: true, url: url.href }
}

/** Whether a subresource request (script, image, fetch, frame, websocket) may use this scheme. */
export function isSubresourceSchemeAllowed(rawUrl: string): boolean {
  try {
    return ALLOWED_SUBRESOURCE.has(new URL(rawUrl).protocol)
  } catch {
    return false
  }
}

export type PopupDecision =
  | { action: 'open-pane'; url: string }
  | { action: 'deny'; reason: 'no-activation' | 'scheme-blocked' }

/**
 * `window.open` and `_blank` links (spec §3.2): denied as popups. With a real user activation and an
 * allowed scheme the target opens as a NEW operator-class pane that inherits the opener's partition
 * (the caller does that), with no `opener` link. Without activation it is denied.
 */
export function decidePopup(rawUrl: string, hasUserActivation: boolean): PopupDecision {
  if (!hasUserActivation) return { action: 'deny', reason: 'no-activation' }
  const verdict = checkTopLevelNavigation(rawUrl, 'page')
  if (!verdict.ok) return { action: 'deny', reason: 'scheme-blocked' }
  return { action: 'open-pane', url: verdict.url }
}

/** Permissions the guest is ever granted: only `clipboard-sanitized-write` (spec §3.2). Everything else is denied. */
export function isPermissionGranted(permission: string): boolean {
  return permission === 'clipboard-sanitized-write'
}

/**
 * Certificate errors (spec §3.2, Q14): denied, except for a loopback host (self-signed local dev HTTPS),
 * which is accepted and flagged in the header.
 */
export function certificateDecision(host: string, isLoopback: boolean): 'accept-flagged' | 'deny' {
  return host !== '' && isLoopback ? 'accept-flagged' : 'deny'
}

/**
 * The "opened by agent" flag (spec §3.2, decision 21): a verb navigated the pane to a host it has not shown
 * before. `seenHosts` is the set of hosts this pane's history already held.
 */
export function shouldFlagNavigation(
  initiator: NavInitiator,
  host: string,
  seenHosts: ReadonlySet<string>
): boolean {
  return initiator === 'verb' && host !== '' && !seenHosts.has(host)
}
