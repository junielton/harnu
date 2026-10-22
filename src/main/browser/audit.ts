/**
 * The audit line of a browser verb (T564 U1, spec §3.2 and §7.5): the pane id, the origin class and the HOST
 * only. Never the path, the query string, the fragment or the userinfo, and never page content. Pure.
 */
import { classifyOrigin, type OriginClass } from './origin-class'

/** Keep an id to a safe, short alphabet so a hostile value cannot pass for another field of the record. */
function field(value: unknown): string {
  return typeof value === 'string' ? value.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80) : ''
}

/** `host[:port]` of an http(s) URL, or `''`. The host string is the URL parser's, so it holds no userinfo. */
function hostOnly(url: unknown): string {
  if (typeof url !== 'string') return ''
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.host : ''
  } catch {
    return ''
  }
}

export function summarizeBrowserCall(
  op: string,
  args: Record<string, unknown>,
  current: { originClass: OriginClass } | undefined
): string {
  if (op === 'browser_list') return 'browser_list'
  const url = args.url
  const origin: OriginClass =
    typeof url === 'string' ? classifyOrigin(url) : (current?.originClass ?? 'blank')
  const parts = [op]
  if (op !== 'browser_open') parts.push(`pane=${field(args.paneId)}`)
  parts.push(`origin=${origin}`)
  const host = hostOnly(url)
  if (host !== '') parts.push(`host=${host}`)
  return parts.join(' ')
}
