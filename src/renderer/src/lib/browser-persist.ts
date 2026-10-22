/**
 * What a browser pane keeps in `helpers.json` so a restart can restore it (T564 U7, spec §10.3), pure.
 *
 * Main owns the pane; the renderer owns `helpers.json`. Main tells the renderer what changed (`browser:state` for the
 * address, zoom, emulation and network switch, `browser:persist` for the pins and the scroll position) and these
 * functions turn that into a minimal patch of the pane's `payload` bag, or `null` when nothing changed, so a state push
 * that changes nothing never schedules a write.
 */
import type { BrowserEmulationState } from '../../../preload'

/** The slice of {@link BrowserPaneState} that is persisted. */
export interface PersistableState {
  url: string
  pagePath: string | null
  zoom: number
  emulation: BrowserEmulationState
  allowNetwork: boolean
}

/** The persisted fields of a pane payload that main pushes (the rest of the payload is set at creation). */
export interface PersistedPayloadFields {
  url?: string
  pagePath?: string | null
  zoom?: number
  emulation?: BrowserEmulationState
  allowNetwork?: boolean
  scroll?: { x: number; y: number } | null
  pins?: unknown[]
}

/** The same-or-not test for a JSON-shaped value (key order must not matter for an emulation record). */
function sameJson(a: unknown, b: unknown): boolean {
  return stable(a) === stable(b)
}

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  if (typeof v === 'object' && v !== null) {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(v) ?? 'null'
}

function isEmpty(e: BrowserEmulationState | undefined): boolean {
  return (
    !e || Object.keys(e).filter((k) => (e as Record<string, unknown>)[k] !== undefined).length === 0
  )
}

/**
 * The patch a pushed state makes to the saved payload, or `null`. An empty address (a pane that has not committed
 * anything yet) never replaces a saved one, and `1` is the zoom of a pane with no zoom saved.
 */
export function payloadPatchFromState(
  saved: PersistedPayloadFields,
  state: PersistableState
): PersistedPayloadFields | null {
  const patch: PersistedPayloadFields = {}
  if (state.url !== '' && state.url !== saved.url) patch.url = state.url
  if ((state.pagePath ?? null) !== (saved.pagePath ?? null)) patch.pagePath = state.pagePath
  if (Number.isFinite(state.zoom) && state.zoom !== (saved.zoom ?? 1)) patch.zoom = state.zoom
  if (
    !sameJson(
      isEmpty(state.emulation) ? {} : state.emulation,
      isEmpty(saved.emulation) ? {} : saved.emulation
    )
  ) {
    patch.emulation = state.emulation
  }
  if (state.allowNetwork !== (saved.allowNetwork === true)) patch.allowNetwork = state.allowNetwork
  return Object.keys(patch).length > 0 ? patch : null
}

/** The patch a `browser:persist` push makes (the pins, the scroll position), or `null`. */
export function payloadPatchFromPersist(
  saved: PersistedPayloadFields,
  event: { pins?: unknown[]; scroll?: { x: number; y: number } | null }
): PersistedPayloadFields | null {
  const patch: PersistedPayloadFields = {}
  if (event.pins !== undefined && !sameJson(event.pins, saved.pins ?? [])) patch.pins = event.pins
  if (event.scroll !== undefined && !sameJson(event.scroll, saved.scroll ?? null)) {
    patch.scroll = event.scroll
  }
  return Object.keys(patch).length > 0 ? patch : null
}
