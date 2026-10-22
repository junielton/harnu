/**
 * The browser pane's view model (T564 U1, design.md §6 "Browser pane"): address-bar input, the connection
 * chip's states, the pause countdown, the title fallback. Pure — `BrowserPane.vue` renders the answer and owns
 * no logic of its own.
 */
import type { BrowserPaneState } from '../../../preload'

/**
 * Turn what the operator typed in the address bar into a URL. A bare word with a dot or a host:port gets a
 * scheme (`http://` for localhost and IP literals, `https://` for the rest). Anything else that already has a
 * scheme is passed through for main to judge (it refuses the blocked ones). Text with spaces is not an address.
 */
export function normalizeAddressInput(raw: string): string | null {
  const text = raw.trim()
  if (text === '' || /\s/.test(text)) return null
  // `host:port` and `host:port/path` look like a scheme to a regex but are addresses.
  const hostPort = /^([A-Za-z0-9.-]+|\[[0-9a-fA-F:]+\]):\d+([/?#].*)?$/.test(text)
  if (!hostPort && /^[A-Za-z][A-Za-z0-9+.-]*:/.test(text)) return text
  const host = text.replace(/^\/\//, '').split(/[/:?#]/)[0] ?? ''
  const isLocal =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    /^[\d.]+$/.test(host) ||
    host.startsWith('[')
  if (!isLocal && !host.includes('.')) return null
  return `${isLocal ? 'http' : 'https'}://${text.replace(/^\/\//, '')}`
}

/** `mm:ss` for a remaining duration in ms; never negative. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/** The text of the pane header: the page title, else the host, else nothing (the component adds the fallback). */
export function headerTitle(state: Pick<BrowserPaneState, 'title' | 'url'>): string {
  if (state.title.trim() !== '') return state.title.trim()
  try {
    const u = new URL(state.url)
    return u.host
  } catch {
    return ''
  }
}

export type ChipKind =
  'connected' | 'connectedAgent' | 'paused' | 'disconnected' | 'operatorRead' | 'operatorLease'

export interface BrowserChipView {
  kind: ChipKind
  /** The session whose title the label names (`connected` only). */
  ownerSessionId: string | null
  /** Remaining pause in ms (`paused` only). */
  pausedMs: number
  /** The live word on a connected chip. */
  word: 'reading' | 'driving' | null
  /** Disconnect is offered (a connected or paused chip, never a disconnected one). */
  disconnectable: boolean
}

/**
 * The chip to show, or `null` for none (design.md "Connection chip"). An operator-opened pane has no chip until
 * its folder lets agents read it: then "An agent can read here" (no Disconnect: the reader is unidentifiable),
 * and "An agent can drive here" with Disconnect while the operator's lease is active (a lease records no
 * grantee). Disconnected outranks paused, which outranks connected.
 */
export function chipFor(
  state: Pick<BrowserPaneState, 'openedBy' | 'disconnected' | 'pausedUntil' | 'ownerSessionId'> &
    Partial<Pick<BrowserPaneState, 'agentReads' | 'leaseActive'>>,
  word: 'reading' | 'driving' | null,
  now: number
): BrowserChipView | null {
  if (state.disconnected) {
    return {
      kind: 'disconnected',
      ownerSessionId: null,
      pausedMs: 0,
      word: null,
      disconnectable: false
    }
  }
  if (state.openedBy !== 'agent') {
    if (state.agentReads !== true) return null
    const driving = state.leaseActive === true
    return {
      kind: driving ? 'operatorLease' : 'operatorRead',
      ownerSessionId: null,
      pausedMs: 0,
      word,
      disconnectable: driving
    }
  }
  if (state.pausedUntil !== null && state.pausedUntil > now) {
    return {
      kind: 'paused',
      ownerSessionId: state.ownerSessionId,
      pausedMs: state.pausedUntil - now,
      word: null,
      disconnectable: true
    }
  }
  return {
    kind: state.ownerSessionId !== null ? 'connected' : 'connectedAgent',
    ownerSessionId: state.ownerSessionId,
    pausedMs: 0,
    word,
    disconnectable: true
  }
}

/** The origin badge key under `browserPane.origin.*`, or `null` for `blank` (no badge). */
export function originBadgeKey(
  origin: BrowserPaneState['origin']
): 'local' | 'external' | 'page' | null {
  return origin === 'blank' ? null : origin
}

/** A URL cut into the three runs the address field styles differently (design.md "Address bar"). */
export interface AddressParts {
  scheme: string
  host: string
  rest: string
}

/**
 * Split a URL for display: `https://` and the path in the dimmer tone, the host (and port) in the brighter
 * one, so the part that says WHERE you are stands out. Anything that is not `scheme://host…` (`about:blank`,
 * a half-typed word) is all `rest`.
 */
export function splitAddress(url: string): AddressParts {
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/?#]*)(.*)$/s.exec(url)
  if (!m) return { scheme: '', host: '', rest: url }
  return { scheme: m[1]!, host: m[2]!, rest: m[3]! }
}

/**
 * Milliseconds of network capture left (the red "Network m:ss" counter, design.md "Network counter"), or
 * `null` when no capture is running or it has already ended.
 */
export function networkRemainingMs(
  state: Pick<BrowserPaneState, 'networkUntil'>,
  now: number
): number | null {
  if (state.networkUntil === null || state.networkUntil <= now) return null
  return state.networkUntil - now
}
