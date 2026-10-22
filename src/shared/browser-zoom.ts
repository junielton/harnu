/**
 * Browser pane zoom, pure core (T572 U5, spec §9.1): the clamp, the ladder the operator's `Ctrl +` / `Ctrl −` walk,
 * the origin a zoom is remembered for, and the `zoomByOrigin` preference map. The view host applies the factor with
 * `webContents.setZoomFactor`; the prefs store (`browser-prefs.ts`) reads and writes the file this map lives in.
 *
 * Import-free and in `src/shared` so the pane chrome can share the ladder and the percentage label. No electron, no clock.
 */

export const ZOOM_MIN = 0.25
export const ZOOM_MAX = 5

/** The browser ladder (design.md "Zoom controls"). */
export const ZOOM_STEPS: readonly number[] = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5
]

/** Remembered origins kept in the file; the oldest are dropped past this (a bound, not a feature). */
export const MAX_ZOOM_ORIGINS = 500

/** Clamp a factor into 0.25–5. A non-finite or non-positive value is 1. */
export function clampZoom(factor: number): number {
  if (!Number.isFinite(factor) || factor <= 0) return 1
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, factor))
}

const EPS = 1e-6

/** The next ladder step above (`in`) or below (`out`) `current`; at the end of the ladder it stays put. */
export function stepZoom(current: number, direction: 'in' | 'out'): number {
  const cur = clampZoom(current)
  if (direction === 'in') {
    const next = ZOOM_STEPS.find((s) => s > cur + EPS)
    return next ?? ZOOM_MAX
  }
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) {
    if (ZOOM_STEPS[i]! < cur - EPS) return ZOOM_STEPS[i]!
  }
  return ZOOM_MIN
}

/** The percentage the header shows (`1.1` → `110`). */
export function zoomPercent(factor: number): number {
  return Math.round(clampZoom(factor) * 100)
}

/**
 * The origin a zoom belongs to: `scheme://host[:port]` of an http(s) or `harnu-page:` URL, else `null` (a blank
 * page or an error page has no origin worth remembering a zoom for).
 */
export function zoomOriginKey(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.origin
    if (u.protocol === 'harnu-page:' && u.host !== '') return `harnu-page://${u.host}`
    return null
  } catch {
    return null
  }
}

export type ZoomByOrigin = Readonly<Record<string, number>>

/** The remembered factor for `url`, or 1. */
export function zoomFor(map: ZoomByOrigin, url: string): number {
  const key = zoomOriginKey(url)
  if (key === null) return 1
  const v = map[key]
  return v === undefined ? 1 : clampZoom(v)
}

/**
 * The map with `factor` remembered for `url`'s origin. A factor of 1 forgets the origin (the default is not worth a
 * line), and a URL with no origin changes nothing. Returns the SAME object when nothing changed.
 */
export function withZoom(map: ZoomByOrigin, url: string, factor: number): ZoomByOrigin {
  const key = zoomOriginKey(url)
  if (key === null) return map
  const f = clampZoom(factor)
  const had = map[key]
  if (Math.abs(f - 1) < EPS) {
    if (had === undefined) return map
    const rest = { ...map }
    delete rest[key]
    return rest
  }
  if (had !== undefined && Math.abs(had - f) < EPS) return map
  // Re-inserting moves the key to the end, so the oldest-first trim below drops the least recently set.
  const rest = { ...map }
  delete rest[key]
  const next: Record<string, number> = { ...rest, [key]: f }
  const keys = Object.keys(next)
  if (keys.length > MAX_ZOOM_ORIGINS) {
    for (const k of keys.slice(0, keys.length - MAX_ZOOM_ORIGINS)) delete next[k]
  }
  return next
}

/** `browser-prefs.json`: a versioned object so a later pref can sit beside the zoom map. */
export interface BrowserPrefsFile {
  version: 1
  zoomByOrigin: ZoomByOrigin
}

export const EMPTY_BROWSER_PREFS: BrowserPrefsFile = { version: 1, zoomByOrigin: {} }

/** Parse the file's text; anything unreadable is the empty prefs, and a bad entry is dropped, never thrown on. */
export function parseBrowserPrefs(text: string): BrowserPrefsFile {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return EMPTY_BROWSER_PREFS
  }
  if (typeof raw !== 'object' || raw === null) return EMPTY_BROWSER_PREFS
  const zoom = (raw as { zoomByOrigin?: unknown }).zoomByOrigin
  const out: Record<string, number> = {}
  if (typeof zoom === 'object' && zoom !== null && !Array.isArray(zoom)) {
    for (const [k, v] of Object.entries(zoom as Record<string, unknown>)) {
      if (typeof v !== 'number' || !Number.isFinite(v)) continue
      const key = zoomOriginKey(k)
      if (key === null || Math.abs(v - 1) < EPS) continue
      out[key] = clampZoom(v)
    }
  }
  return { version: 1, zoomByOrigin: out }
}

export function serializeBrowserPrefs(prefs: BrowserPrefsFile): string {
  return `${JSON.stringify(prefs, null, 2)}\n`
}
