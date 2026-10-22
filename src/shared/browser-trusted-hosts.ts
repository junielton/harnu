/**
 * The per-folder list of trusted dev hosts (T564 U4, spec §7.2): hosts the operator says are THEIR dev servers,
 * so a page on them classifies as `local` and an agent can drive it without a lease. Only the operator edits the
 * list (the folder menu); no verb does. This module is the rule for what an entry may be, so a typo or a sweeping
 * wildcard can never make the internet "local". Pure (ADR-0001).
 *
 * An entry is an exact host (`app.test`, a docker service name like `web`, an IP literal) or a `*.` wildcard over a
 * suffix (`*.test`). Hosts only: no scheme, port, path or userinfo. Classification still looks at the host STRING
 * (a name that merely resolves to loopback is never trusted by itself), and Harnu's own ports stay `external`.
 */

/** Most entries one folder may hold. */
export const MAX_TRUSTED_HOSTS = 32

/** Longest entry, in characters. */
export const MAX_TRUSTED_HOST_CHARS = 253

/**
 * Top-level names a wildcard may end in: names reserved for private use (RFC 2606, 6761, 8375) that the
 * public internet cannot serve. `*.com` or `*.dev` would make a whole public TLD "local", so any other
 * wildcard must have at least three labels under the `*.` (`*.dev.example.org`).
 */
const RESERVED_WILDCARD_TLDS: ReadonlySet<string> = new Set([
  'test',
  'localhost',
  'local',
  'internal',
  'lan',
  'example',
  'invalid'
])

export type TrustedHostError =
  | 'EMPTY'
  | 'TOO_LONG'
  | 'HAS_SCHEME_OR_PATH'
  | 'HAS_PORT'
  | 'BAD_CHARACTERS'
  | 'WILDCARD_TOO_BROAD'
  | 'WILDCARD_POSITION'
  | 'DUPLICATE'
  | 'LIST_FULL'

const LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

/** Normalise and validate ONE entry: lower case, trimmed, a trailing dot dropped. */
export function parseTrustedHost(
  raw: string
): { ok: true; host: string } | { ok: false; error: TrustedHostError } {
  const host = raw.trim().toLowerCase().replace(/\.$/, '')
  if (host === '') return { ok: false, error: 'EMPTY' }
  if ([...host].length > MAX_TRUSTED_HOST_CHARS) return { ok: false, error: 'TOO_LONG' }
  if (/[/\\?#@]|:\/\//.test(host)) return { ok: false, error: 'HAS_SCHEME_OR_PATH' }
  // A bracketed IPv6 literal keeps its colons; anything else with a colon carries a port.
  const v6 = /^\[[0-9a-f:.]+\]$/.test(host)
  if (!v6 && host.includes(':')) return { ok: false, error: 'HAS_PORT' }
  if (v6) return { ok: true, host }
  const wildcard = host.startsWith('*.')
  if (host.slice(wildcard ? 2 : 0).includes('*')) return { ok: false, error: 'WILDCARD_POSITION' }
  const labels = (wildcard ? host.slice(2) : host).split('.')
  if (labels.some((l) => !LABEL.test(l))) return { ok: false, error: 'BAD_CHARACTERS' }
  if (wildcard) {
    // A wildcard over a public suffix (`*.com`, `*.co.uk`, `*.github.io`) would make the internet "local".
    // Without a public-suffix list the rule is conservative: the base must be a reserved dev TLD (`*.test`,
    // `*.app.test`), or have at least three labels (`*.dev.example.org`). An all-numeric base (`*.1.1`) looks
    // like an address and never is a name. Exact hosts are always fine.
    if (labels.every((l) => /^[0-9]+$/.test(l))) return { ok: false, error: 'WILDCARD_TOO_BROAD' }
    const reservedBase = RESERVED_WILDCARD_TLDS.has(labels[labels.length - 1]!)
    if (!reservedBase && labels.length < 3) return { ok: false, error: 'WILDCARD_TOO_BROAD' }
  }
  return { ok: true, host }
}

/** Add `raw` to `list`, or say why not. The list is returned sorted so the editor shows a stable order. */
export function addTrustedHost(
  list: readonly string[],
  raw: string
): { ok: true; hosts: string[] } | { ok: false; error: TrustedHostError } {
  const parsed = parseTrustedHost(raw)
  if (!parsed.ok) return parsed
  if (list.includes(parsed.host)) return { ok: false, error: 'DUPLICATE' }
  if (list.length >= MAX_TRUSTED_HOSTS) return { ok: false, error: 'LIST_FULL' }
  return { ok: true, hosts: [...list, parsed.host].sort() }
}

export function removeTrustedHost(list: readonly string[], host: string): string[] {
  return list.filter((h) => h !== host)
}

/**
 * Clean a list read from disk: keep only valid, unique entries (a hand-edited file must never smuggle in a
 * wildcard the editor would have refused), capped at {@link MAX_TRUSTED_HOSTS}.
 */
export function sanitizeTrustedHosts(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const parsed = parseTrustedHost(item)
    if (parsed.ok && !out.includes(parsed.host)) out.push(parsed.host)
    if (out.length >= MAX_TRUSTED_HOSTS) break
  }
  return out.sort()
}

/** The built-in set, for the editor's read-only rows (`origin-class.ts` is the rule that applies them). */
export const BUILT_IN_TRUSTED_HOSTS: readonly string[] = [
  'localhost',
  '*.localhost',
  '127.0.0.0/8',
  '[::1]'
]
