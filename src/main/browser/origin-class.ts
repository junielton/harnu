/**
 * Origin class of a browser pane (T564 U1, spec §1.2 and §7.2): `page` (our own `harnu-page://`),
 * `local` (a literal trusted dev host), `external`, `blank`.
 *
 * Classification looks at the URL's host STRING only. A hostname that merely resolves to loopback is
 * `external` (DNS rebinding cannot upgrade a site), and Harnu's own listening ports always classify as
 * `external`, so a page can never pass for the MCP server or the dev renderer. Pure (ADR-0001): no electron.
 */

export type OriginClass = 'page' | 'local' | 'external' | 'blank'

export interface OriginClassOptions {
  /**
   * Extra per-folder trusted dev hosts the operator added (spec §7.2): exact hosts (`app.test`) or a
   * `*.` wildcard (`*.test`). No verb edits this list.
   */
  extraTrustedHosts?: readonly string[]
  /** Ports Harnu itself listens on (MCP server, dev CDP port, dev renderer server): always `external`. */
  harnuPorts?: readonly number[]
}

/** A literal IPv4 address in 127.0.0.0/8. */
function isLoopbackV4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return false
  const octets = m.slice(1).map(Number)
  if (octets.some((n) => n > 255)) return false
  return octets[0] === 127
}

/** The built-in trusted dev hosts: `localhost`, `*.localhost`, 127.0.0.0/8, `[::1]`. */
function isBuiltInLocalHost(host: string): boolean {
  return (
    host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || isLoopbackV4(host)
  )
}

function matchesExtra(host: string, patterns: readonly string[]): boolean {
  return patterns.some((raw) => {
    const p = raw.trim().toLowerCase()
    if (p.length === 0) return false
    if (p.startsWith('*.')) return host.endsWith(p.slice(1)) && host.length > p.length - 1
    return host === p
  })
}

/** Whether `host` (no port) is a loopback host, used by the certificate-error rule (spec §3.2, Q14). */
export function isLoopbackHost(host: string): boolean {
  return isBuiltInLocalHost(host.toLowerCase())
}

/** Classify the URL of a pane's top frame. An unparseable URL is `blank`. */
export function classifyOrigin(rawUrl: string, opts: OriginClassOptions = {}): OriginClass {
  if (rawUrl === '' || rawUrl === 'about:blank') return 'blank'
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return 'blank'
  }
  if (url.protocol === 'harnu-page:') return 'page'
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'external'
  const host = url.hostname.toLowerCase()
  const port = url.port !== '' ? Number(url.port) : url.protocol === 'https:' ? 443 : 80
  if (opts.harnuPorts?.includes(port) && isBuiltInLocalHost(host)) return 'external'
  if (isBuiltInLocalHost(host)) return 'local'
  if (matchesExtra(host, opts.extraTrustedHosts ?? [])) {
    return opts.harnuPorts?.includes(port) ? 'external' : 'local'
  }
  return 'external'
}

/** Scheme, host and path of a URL with the query string and fragment removed (spec §6: ACK `url`). */
export function scrubUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl)
    if (u.protocol === 'about:') return rawUrl
    return `${u.protocol}//${u.host}${u.pathname}`
  } catch {
    return ''
  }
}

/** The host of a URL for audit lines and the "opened by agent" flag (never the query string). */
export function hostOf(rawUrl: string): string {
  try {
    return new URL(rawUrl).host
  } catch {
    return ''
  }
}
