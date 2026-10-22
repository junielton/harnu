/**
 * Restart restore, pure (T564 U7, spec §10.3): turn the browser panes `helpers.json` kept into registry records that
 * start DISCARDED (no webContents until the pane is shown or driven), plus the pins to hand back.
 *
 * `helpers.json` is a file anyone can edit and an older or newer build may have written, so every field is
 * validated and bounded here; a pane that cannot be made sense of is dropped, never loaded. What does NOT come back
 * is by construction: the lease, network capture, the `flagged` state and the pause timer live only in memory.
 */
import {
  COMMENT_MAX_CHARS,
  COMPONENT_MAX_CHARS,
  HTML_MAX_CHARS,
  MAX_PINS_PER_PANE,
  MAX_STYLES,
  SELECTOR_MAX_CHARS,
  STYLE_VALUE_MAX_CHARS,
  TAG_MAX_CHARS,
  URL_MAX_CHARS
} from '../../shared/browser-comment'
import {
  DEVICE_MAX_DPR,
  DEVICE_MAX_SIZE,
  DEVICE_MIN_DPR,
  DEVICE_MIN_SIZE,
  MAX_USER_AGENT_CHARS,
  isPresetName,
  type DeviceSpec,
  type EmulationRecord
} from '../../shared/browser-emulation'
import { ZOOM_MAX, ZOOM_MIN } from '../../shared/browser-zoom'
import { checkTopLevelNavigation } from './nav-policy'
import type { PinRecord } from './comment-pins'
import { buildDiscardState, sanitizeScroll } from './lifecycle'
import type { BrowserPaneRecord } from './registry'

/** One pane as `helpers.json` holds it (`HelperPane` of `helpers-store.ts`), with the stack it was in. */
export interface PersistedPaneInput {
  id: unknown
  type?: unknown
  /** The worktree path the stack belongs to: the pane's folder. */
  worktreePath: string
  payload?: unknown
}

export interface RestoredPane {
  rec: BrowserPaneRecord
  pins: PinRecord[]
  /** The operator disconnected the agent from this pane before the restart: it comes back disconnected (spec §7.4). */
  disconnected: boolean
}

const PANE_ID = /^[A-Za-z0-9_-]{1,80}$/
const MAX_NAME_CHARS = 200
const MAX_URL_CHARS = 4096
/** Crops live under this folder-relative directory (spec §8.3); a pin pointing anywhere else loses its crop. */
const CROP_DIR = '.harnu/out/browser/comments/'

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
const str = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' && v.length <= max ? v : undefined
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/* ---- Pins ----------------------------------------------------------------------------------------- */

function sanitizeStyles(raw: unknown): Record<string, string> {
  if (!isRecord(raw)) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (Object.keys(out).length >= MAX_STYLES) break
    if (k.length <= 60 && typeof v === 'string' && v.length <= STYLE_VALUE_MAX_CHARS) out[k] = v
  }
  return out
}

/** One pin from untrusted input, or `null`. A pin is the operator's own draft, so a bad optional field is repaired. */
export function sanitizePin(raw: unknown): PinRecord | null {
  if (!isRecord(raw)) return null
  const id = str(raw.id, 40)
  const selector = str(raw.selector, SELECTOR_MAX_CHARS)
  if (!id || id === '' || selector === undefined) return null
  if (!Number.isInteger(raw.n) || (raw.n as number) < 1) return null
  if (raw.state !== 'draft' && raw.state !== 'sent') return null
  const rect = isRecord(raw.rect) ? raw.rect : null
  if (!rect || !finite(rect.x) || !finite(rect.y) || !finite(rect.width) || !finite(rect.height)) {
    return null
  }
  const crop = typeof raw.cropPath === 'string' ? raw.cropPath : null
  const cropOk =
    crop !== null &&
    crop.length <= 300 &&
    crop.startsWith(CROP_DIR) &&
    !crop.split('/').includes('..')
  return {
    id,
    n: raw.n as number,
    state: raw.state,
    origin: str(raw.origin, URL_MAX_CHARS) ?? '',
    url: str(raw.url, URL_MAX_CHARS) ?? '',
    selector,
    tag: str(raw.tag, TAG_MAX_CHARS) ?? '',
    html: str(raw.html, HTML_MAX_CHARS) ?? '',
    component: str(raw.component, COMPONENT_MAX_CHARS) ?? null,
    styles: sanitizeStyles(raw.styles),
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    cropPath: cropOk ? crop : null,
    comment: str(raw.comment, COMMENT_MAX_CHARS) ?? '',
    batchId: str(raw.batchId, 40) ?? '',
    createdAt: finite(raw.createdAt) ? raw.createdAt : 0
  }
}

/** The pins of a pane from untrusted input: valid ones only, unique ids, at most {@link MAX_PINS_PER_PANE}. */
export function sanitizePins(raw: unknown): PinRecord[] {
  if (!Array.isArray(raw)) return []
  const out: PinRecord[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (out.length >= MAX_PINS_PER_PANE) break
    const pin = sanitizePin(item)
    if (!pin || seen.has(pin.id)) continue
    seen.add(pin.id)
    out.push(pin)
  }
  return out
}

/* ---- Emulation ------------------------------------------------------------------------------------- */

function sanitizeDevice(raw: unknown): DeviceSpec | undefined {
  if (!isRecord(raw)) return undefined
  const { width, height, dpr } = raw
  if (!finite(width) || !finite(height) || !finite(dpr)) return undefined
  if (width < DEVICE_MIN_SIZE || width > DEVICE_MAX_SIZE) return undefined
  if (height < DEVICE_MIN_SIZE || height > DEVICE_MAX_SIZE) return undefined
  if (dpr < DEVICE_MIN_DPR || dpr > DEVICE_MAX_DPR) return undefined
  return {
    preset: isPresetName(raw.preset) ? raw.preset : null,
    width: Math.round(width),
    height: Math.round(height),
    dpr,
    mobile: raw.mobile === true,
    rotated: raw.rotated === true
  }
}

/** An emulation record from untrusted input; an unusable part is dropped, the rest kept. */
export function sanitizeEmulation(raw: unknown): EmulationRecord {
  if (!isRecord(raw)) return {}
  const out: EmulationRecord = {}
  const device = sanitizeDevice(raw.device)
  if (device) out.device = device
  if (typeof raw.touch === 'boolean') out.touch = raw.touch
  const ua = str(raw.userAgent, MAX_USER_AGENT_CHARS)
  if (ua !== undefined && ua !== '') out.userAgent = ua
  if (raw.colorScheme === 'light' || raw.colorScheme === 'dark') out.colorScheme = raw.colorScheme
  if (typeof raw.reducedMotion === 'boolean') out.reducedMotion = raw.reducedMotion
  return out
}

/* ---- The pane ---------------------------------------------------------------------------------------- */

/**
 * One persisted pane as a discarded registry record and its pins, or `null` when it cannot be restored: not a
 * browser pane, a bad id, or an address a pane may not load.
 */
export function restorePane(input: PersistedPaneInput, now: number): RestoredPane | null {
  if (input.type !== 'browser') return null
  const paneId = typeof input.id === 'string' && PANE_ID.test(input.id) ? input.id : null
  if (!paneId || typeof input.worktreePath !== 'string' || input.worktreePath === '') return null
  const p = isRecord(input.payload) ? input.payload : {}

  const pagePath = str(p.pagePath, 1024) || null
  const rawUrl = str(p.url, MAX_URL_CHARS) ?? ''
  // The address is judged as an operator navigation would be: http(s), `about:blank`, or our own page scheme.
  // A `harnu-page:` address only comes back for a pane that was showing a page file.
  let url = 'about:blank'
  if (rawUrl !== '') {
    const verdict = checkTopLevelNavigation(rawUrl, 'operator')
    const isPageUrl = rawUrl.startsWith('harnu-page:')
    if (verdict.ok && (!isPageUrl || pagePath !== null)) url = verdict.url
  }

  const openedBy = p.openedBy === 'agent' ? 'agent' : 'operator'
  const partition = p.partition === 'agent' ? 'agent' : 'operator'
  const zoom = finite(p.zoom) ? Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, p.zoom)) : 1
  const emulation = sanitizeEmulation(p.emulation)
  const rec: BrowserPaneRecord = {
    paneId,
    folder: input.worktreePath,
    name: str(p.name, MAX_NAME_CHARS) ?? '',
    openedBy,
    partition,
    ownerSessionId: str(p.ownerSessionId, 80) || null,
    createdAt: now,
    lastActiveAt: now,
    // `flagged` does not survive a restart (spec §10.3): the badge is for what an agent opened THIS run.
    seenHosts: new Set<string>(),
    flagged: null,
    pagePath,
    allowNetwork: pagePath !== null && p.allowNetwork === true,
    ...(Object.keys(emulation).length > 0 ? { emulation } : {}),
    discarded: buildDiscardState({
      reason: 'restored',
      url,
      title: '',
      scroll: sanitizeScroll(p.scroll),
      zoom,
      now,
      hiddenSince: null
    })
  }
  return { rec, pins: sanitizePins(p.pins), disconnected: p.disconnected === true }
}

/** Every browser pane of every stack, restored; a duplicate pane id keeps its first. */
export function planRestore(panes: readonly PersistedPaneInput[], now: number): RestoredPane[] {
  const out: RestoredPane[] = []
  const seen = new Set<string>()
  for (const pane of panes) {
    const restored = restorePane(pane, now)
    if (!restored || seen.has(restored.rec.paneId)) continue
    seen.add(restored.rec.paneId)
    out.push(restored)
  }
  return out
}
