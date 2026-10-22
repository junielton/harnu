/**
 * One-shot tickets for `harnu-page:` requests (T569 delta 1, F1). Pure (ADR-0001): clock injected.
 *
 * The origin check (`page-guard.ts`) lives in `session.webRequest.onBeforeRequest`, and a request from a dedicated
 * worker (or any other loader that bypasses `webRequest`) never reaches it, while `protocol.handle` receives no
 * `Origin`, `Referer` or `Sec-Fetch-*` to judge by. So the check cannot be the only gate: when `onBeforeRequest`
 * ALLOWS a `harnu-page:` request it issues a ticket for that URL, and the handler serves only a request it can
 * redeem a ticket for. Whatever never passed the check has no ticket and gets one identical refusal before the
 * handler touches the disk, so a worker can neither read a file nor tell by timing whether one exists.
 *
 * Consequence, accepted: a worker created INSIDE one of our own pages cannot load our files either.
 */

/**
 * A ticket outlives its request only if the request was cancelled after the check; the handler normally redeems
 * it within milliseconds. Short on purpose: a leftover ticket is the one thing a hostile request could spend.
 */
export const TICKET_TTL_MS = 5000
export const MAX_TICKETS = 2000

/** The key both sides use: the parsed URL without its fragment (a fragment is never sent). */
export function normalizePageRequestUrl(raw: string): string | null {
  try {
    const u = new URL(raw)
    u.hash = ''
    return u.href
  } catch {
    return null
  }
}

export interface PageTickets {
  /** `onBeforeRequest` allowed this request: let the handler serve it once. */
  issue(url: string): void
  /** The handler asks before doing anything else. `true` spends one ticket; `false` means refuse. */
  redeem(url: string): boolean
  /** Test and diagnostic hook. */
  size(): number
}

export function createPageTickets(
  now: () => number,
  ttlMs: number = TICKET_TTL_MS,
  max: number = MAX_TICKETS
): PageTickets {
  /** Per normalized URL: the expiry times of its unspent tickets, oldest first. */
  const tickets = new Map<string, number[]>()
  let total = 0

  const purgeUrl = (key: string, list: number[]): void => {
    const t = now()
    let drop = 0
    while (drop < list.length && list[drop]! <= t) drop++
    if (drop > 0) {
      list.splice(0, drop)
      total -= drop
    }
    if (list.length === 0) tickets.delete(key)
  }
  const purgeAll = (): void => {
    for (const [key, list] of [...tickets]) purgeUrl(key, list)
  }

  return {
    issue(url) {
      const key = normalizePageRequestUrl(url)
      if (key === null) return
      if (total >= max) {
        purgeAll()
        // Still full: issue nothing. The request then fails visibly, which is the safe direction.
        if (total >= max) return
      }
      const list = tickets.get(key) ?? []
      list.push(now() + ttlMs)
      tickets.set(key, list)
      total++
    },
    redeem(url) {
      const key = normalizePageRequestUrl(url)
      if (key === null) return false
      const list = tickets.get(key)
      if (!list) return false
      purgeUrl(key, list)
      if (list.length === 0) return false
      list.shift()
      total--
      if (list.length === 0) tickets.delete(key)
      return true
    },
    size: () => total
  }
}

/**
 * The ONE response every unticketed request gets, whatever the URL names: the same status, headers and body
 * for a file that exists, one that does not, and one that is jailed out, produced without any I/O.
 */
export const UNTICKETED_STATUS = 404
export const UNTICKETED_BODY = 'harnu-page: not available'
export function unticketedHeaders(csp: string): Record<string, string> {
  return {
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': csp,
    'Cache-Control': 'no-store'
  }
}
