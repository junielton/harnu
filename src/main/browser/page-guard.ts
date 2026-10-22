/**
 * The `harnu-page:` origin check of `session.webRequest.onBeforeRequest` (T564 U2, spec §3.2): a `local` or
 * `external` page cannot load our script, frame, image or fetch our files.
 *
 * It is load-bearing, not belt-and-braces: the `protocol.handle` request carries no `Origin` or `Sec-Fetch-*`
 * header, so the handler cannot enforce this, and U0 showed an external page loading `harnu-page://f1/data.json`
 * as a `<script>` and framing `harnu-page://f1/frame.html` without it (only `fetch` was stopped, by CORS).
 *
 * Electron 39's `details` has no `initiator`; the issuing page is `details.frame` (a `WebFrameMain`): its
 * `origin` for scripts, images and `fetch`/XHR, and its PARENT's `origin` for a `subFrame` navigation.
 * Pure (ADR-0001): the shell hands in the facts it read off `details`.
 */
import { PAGE_SCHEME } from './page-url'

/** What `onBeforeRequest` reports about the requesting frame, reduced to what the rule needs. */
export interface RequestingFrame {
  origin: string
  parent: { origin: string } | null
}

export interface PageRequestFacts {
  url: string
  /** Electron's `details.resourceType` (`mainFrame`, `subFrame`, `script`, `image`, `xhr`, ...). */
  resourceType: string
  /** `details.frame`, or `null` when the request has none (a worker, a prefetch). */
  frame: RequestingFrame | null
}

export type PageRequestVerdict = { allow: true } | { allow: false; reason: string }

/** The origin string of the page that issued the request, or `null` when it cannot be named. */
export function issuerOriginOf(
  facts: Pick<PageRequestFacts, 'resourceType' | 'frame'>
): string | null {
  const { frame, resourceType } = facts
  if (!frame) return null
  return resourceType === 'subFrame' ? (frame.parent?.origin ?? null) : frame.origin
}

function hostOfOrigin(origin: string): string | null {
  try {
    const u = new URL(origin)
    return u.protocol === `${PAGE_SCHEME}:` ? u.host : null
  } catch {
    return null
  }
}

/**
 * Decide one request. Anything that is not a `harnu-page:` URL passes (the other layers judge schemes). A
 * `harnu-page:` request passes only from a `harnu-page://` origin of the SAME folder host, or as the main frame
 * itself (a top-level navigation, judged by `will-navigate`/`will-redirect`). A request with no requesting frame
 * and no way to name its issuer (a worker) FAILS CLOSED: an external page must not reach our files through one.
 */
export function decidePageRequest(facts: PageRequestFacts): PageRequestVerdict {
  let target: URL
  try {
    target = new URL(facts.url)
  } catch {
    return { allow: true }
  }
  if (target.protocol !== `${PAGE_SCHEME}:`) return { allow: true }
  if (facts.resourceType === 'mainFrame') return { allow: true }
  const issuer = issuerOriginOf(facts)
  if (issuer === null) return { allow: false, reason: 'no-issuer' }
  const issuerHost = hostOfOrigin(issuer)
  if (issuerHost === null) return { allow: false, reason: 'foreign-origin' }
  if (issuerHost !== target.host) return { allow: false, reason: 'other-folder' }
  return { allow: true }
}
