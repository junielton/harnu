/**
 * The audit line of a browser verb (T564 U1, spec §3.2 and §7.5): the pane id, the origin class and the HOST
 * only. Never the path, the query string, the fragment or the userinfo, and never page content. Pure.
 */
import { auditField, escapeForAudit, AUDIT_INPUT_MAX_CHARS } from '../terminal-keys'
import { scrubTerminalText } from '../scrub-terminal'
import { classifyOrigin, type OriginClass, type OriginClassOptions } from './origin-class'

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

/** Page text typed or run by an agent, scrubbed FIRST (so the cut cannot leave half a secret), escaped and cut. */
function auditText(value: unknown, home: string): string {
  const text = typeof value === 'string' ? value : ''
  const scrubbed = text === '' ? '' : scrubTerminalText(text, home)
  const escaped = escapeForAudit(scrubbed)
  return escaped.length > AUDIT_INPUT_MAX_CHARS
    ? `${escaped.slice(0, AUDIT_INPUT_MAX_CHARS)}…`
    : escaped
}

export function summarizeBrowserCall(
  op: string,
  args: Record<string, unknown>,
  current: { originClass: OriginClass } | undefined,
  opts: {
    home?: string
    gate?: 'free' | 'lease' | 'confirm'
    /**
     * The SAME classification inputs the gate uses (Harnu's own ports, the folder's trusted hosts), so the audit
     * row and the gate never disagree about a URL such as `localhost:9222`.
     */
    classify?: OriginClassOptions
  } = {}
): string {
  if (op === 'browser_list') return 'browser_list'
  const url = args.url
  const origin: OriginClass =
    typeof url === 'string' ? classifyOrigin(url, opts.classify ?? {}) : (current?.originClass ?? 'blank')
  const parts = [op]
  if (op !== 'browser_open') parts.push(`pane=${field(args.paneId)}`)
  parts.push(`origin=${origin}`)
  const host = hostOnly(url)
  if (host !== '') parts.push(`host=${host}`)
  const home = opts.home ?? ''
  // spec §7.5: `eval` and `type`/`fill` text are scrubbed and cut to 200 characters; page content is never stored.
  if (op === 'browser_eval') parts.push(`expression="${auditText(args.expression, home)}"`)
  else if (op === 'browser_type') {
    parts.push(`ref=${auditField(typeof args.ref === 'string' ? args.ref : '-')}`)
    parts.push(`text="${auditText(args.text, home)}"`)
  } else if (op === 'browser_fill') {
    const fields = Array.isArray(args.fields) ? (args.fields as Array<Record<string, unknown>>) : []
    parts.push(`fields=${fields.length}`)
    parts.push(`values="${auditText(fields.map((f) => String(f.value ?? '')).join(' | '), home)}"`)
  } else if (op === 'browser_click')
    parts.push(`ref=${auditField(typeof args.ref === 'string' ? args.ref : '-')}`)
  else if (op === 'browser_press') {
    const keys = Array.isArray(args.keys) ? (args.keys as unknown[]) : []
    parts.push(
      `keys=[${keys
        .slice(0, 64)
        .map((k) => auditField(String(k)))
        .join(',')}]`
    )
  }
  return parts.join(' ')
}
