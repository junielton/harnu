/**
 * The browser pane's view model (T564 U1, design.md §6 "Browser pane"): address-bar input, the connection
 * chip's states, the pause countdown, the title fallback. Pure — `BrowserPane.vue` renders the answer and owns
 * no logic of its own.
 */
import {
  DEVICE_PRESET_NAMES,
  DEVICE_PRESETS,
  DEVICE_MAX_DPR,
  DEVICE_MAX_SIZE,
  DEVICE_MIN_DPR,
  DEVICE_MIN_SIZE,
  deviceCaption,
  deviceKind,
  fitScale,
  type DeviceKind
} from '../../../shared/browser-emulation'
import { ZOOM_MAX, ZOOM_MIN, zoomPercent } from '../../../shared/browser-zoom'
import type { BrowserDeviceState, BrowserNotice, BrowserPaneState } from '../../../preload'

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

/* ---- Zoom (T572 U5, design.md "Zoom controls") ---------------------------------------------------- */

export interface ZoomView {
  /** `110` for 1.1; always 100 in device mode, where zoom is off. */
  percent: number
  /** Device mode: the group shows but nothing in it works (Q15). */
  disabled: boolean
  canZoomIn: boolean
  canZoomOut: boolean
  canReset: boolean
}

export function zoomView(
  state: Pick<BrowserPaneState, 'zoom' | 'emulation'> | { zoom?: number; emulation?: undefined }
): ZoomView {
  const inDevice = state.emulation?.device !== undefined
  const factor = inDevice ? 1 : (state.zoom ?? 1)
  return {
    percent: zoomPercent(factor),
    disabled: inDevice,
    canZoomIn: !inDevice && factor < ZOOM_MAX - 1e-6,
    canZoomOut: !inDevice && factor > ZOOM_MIN + 1e-6,
    canReset: !inDevice && Math.abs(factor - 1) > 1e-6
  }
}

/* ---- Device mode (T572 U5, design.md "Device picker", "Device bar", "Device frame") --------------- */

/** The frame around the screen: an 8px bezel inside a 1px ring, on every side (design.md "Device frame"). */
export const FRAME_BEZEL_PX = 8
export const FRAME_RING_PX = 1
/** The backdrop's padding, and the caption's height plus its gap. */
export const BACKDROP_PAD_PX = 12
export const CAPTION_BLOCK_PX = 24

export interface DeviceLayout {
  /** The fit scale: the largest ≤ 1 at which the frame and the caption fit the backdrop. */
  fit: number
  /** The screen (the host the native view is bounded to), in CSS px: device size times the fit. */
  screenWidth: number
  screenHeight: number
}

/**
 * The device frame's size inside a backdrop of `backdrop` CSS px. The screen is the device size times a fit scale;
 * the frame, the padding and the caption take their share first. Whole pixels, so the native view's integer bounds
 * and the page scale never disagree by a fraction.
 */
export function deviceLayout(
  device: Pick<BrowserDeviceState, 'width' | 'height'>,
  backdrop: { width: number; height: number }
): DeviceLayout {
  const chromeW = 2 * (BACKDROP_PAD_PX + FRAME_BEZEL_PX + FRAME_RING_PX)
  const chromeH = chromeW + CAPTION_BLOCK_PX
  const fit = fitScale(device, {
    width: backdrop.width - chromeW,
    height: backdrop.height - chromeH
  })
  return {
    fit,
    screenWidth: Math.max(1, Math.round(device.width * fit)),
    screenHeight: Math.max(1, Math.round(device.height * fit))
  }
}

/** The icon of the device chip and button (`smartphone`, `tablet`, `laptop`, `monitor`). */
export function deviceIconName(
  device: Pick<BrowserDeviceState, 'preset' | 'width' | 'height' | 'mobile' | 'dpr' | 'rotated'>
): 'smartphone' | 'tablet' | 'laptop' | 'monitor' {
  const kind: DeviceKind = deviceKind(device as Parameters<typeof deviceKind>[0])
  return kind === 'phone' ? 'smartphone' : kind === 'desktop' ? 'monitor' : kind
}

/** `phone-m · 390×844 @3`, the chip's text. A rotated preset says so, a free size is `custom`. */
export function deviceChipText(device: BrowserDeviceState): string {
  const name = device.preset ?? 'custom'
  return `${name}${device.rotated ? ' ↻' : ''} · ${device.width}×${device.height} @${device.dpr}`
}

/** One row of the preset list: the class name, then its size. */
export interface PresetRow {
  name: string
  size: string
  active: boolean
}

export function presetRows(active: BrowserDeviceState | undefined): PresetRow[] {
  return DEVICE_PRESET_NAMES.map((name) => {
    const p = DEVICE_PRESETS[name]
    return {
      name,
      size: `${p.width}×${p.height} @${p.dpr}`,
      active: active?.preset === name && !active.rotated
    }
  })
}

/** The caption under the frame (`fit 66% · touch on · …`). */
export function frameCaption(state: Pick<BrowserPaneState, 'emulation'>, fit: number): string {
  return deviceCaption(state.emulation, fit)
}

export interface FreeSizeInput {
  width: string
  height: string
  dpr: string
}

/** The free-size editor's inputs as an emulate patch, or `null` when a value is out of range. */
export function freeSizePatch(
  input: FreeSizeInput,
  mobile: boolean
): { width: number; height: number; dpr: number; mobile: boolean } | null {
  const width = Number(input.width)
  const height = Number(input.height)
  const dpr = Number(input.dpr === '' ? '1' : input.dpr.replace(',', '.'))
  const ok =
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    Number.isFinite(dpr) &&
    width >= DEVICE_MIN_SIZE &&
    width <= DEVICE_MAX_SIZE &&
    height >= DEVICE_MIN_SIZE &&
    height <= DEVICE_MAX_SIZE &&
    dpr >= DEVICE_MIN_DPR &&
    dpr <= DEVICE_MAX_DPR
  return ok ? { width: Math.round(width), height: Math.round(height), dpr, mobile } : null
}

/* ---- Notices (downloads) ------------------------------------------------------------------------ */

/** Whether a notice is good news or a neutral report (the strip is then not drawn as a warning). */
export function noticeTone(notice: BrowserNotice): 'warning' | 'info' {
  return notice.kind === 'downloaded' || notice.kind === 'download-cancelled' ? 'info' : 'warning'
}
