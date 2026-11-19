/**
 * Browser tabs, wire types and pure helpers shared by main and the renderer (browser-tabs spec S-2, ADR-0026).
 *
 * A browser pane holds an ordered list of tabs (at most {@link MAX_TABS_PER_PANE}). A tab is one page of the pane's
 * partition: main mints its id, persists it with the pane and keeps it across a restart and a move. This module is
 * import-free so the preload can re-export its types to the renderer project.
 */

/** A pane holds at most this many tabs (`TAB_LIMIT`, spec D-3). */
export const MAX_TABS_PER_PANE = 8

/**
 * What the pane's host div shows for a tab: the page itself, the start page (a tab with no address) or the load error
 * page. S-2 owns the value, S-3 reacts to it.
 */
export type BrowserTabHostView = 'page' | 'start' | 'error'

/** A main-frame load failure while `hostView` is `error` (S-3 fills it). */
export interface BrowserTabLoadError {
  code: string
  url: string
  host: string
  port: number | null
  local: boolean
}

/** The per-tab record main sends the renderer. */
export interface BrowserTabState {
  tabId: string
  url: string
  title: string
  favicon: string | null
  loading: boolean
  hostView: BrowserTabHostView
  loadError?: BrowserTabLoadError
  /** "Reload when it is up" is polling for this tab (S-3). */
  waitingForUp: boolean
  /** The tab's page is gone to save memory and reloads its address when shown. */
  discarded: boolean
  active: boolean
  /** An agent's verb is running on this tab (the activity word is live). */
  agentActive: boolean
}

/** One tab as `helpers.json` keeps it, so a restart brings the tabs back in order. */
export interface BrowserPersistedTab {
  tabId: string
  url: string
  title: string
  hostView: BrowserTabHostView
}

/** Refusals of the tab operations. */
export type BrowserTabError =
  'TAB_LIMIT' | 'TAB_NOT_FOUND' | 'PANE_LIMIT' | 'PANE_NOT_FOUND' | 'BAD_ARGS'

/** What `browser:tab:new` and `browser:tab:duplicate` accept and answer. */
export interface BrowserTabNewOptions {
  url?: string
  hostView?: 'page' | 'start'
  afterTabId?: string
  background?: boolean
}

export type BrowserTabResult = { ok: true; tabId: string } | { ok: false; error: BrowserTabError }

export type BrowserTabCloseResult =
  { ok: true; paneClosed: boolean } | { ok: false; error: BrowserTabError }

export type BrowserTabMoveResult =
  { ok: true; paneId: string } | { ok: false; error: BrowserTabError }

const TAB_ID = /^tab-[0-9a-f]{8}$/

/** Whether `v` has the shape of a tab id (`tab-<8 hex>`). */
export function isTabId(v: unknown): v is string {
  return typeof v === 'string' && TAB_ID.test(v)
}

const MAX_PERSISTED_URL = 4096
const MAX_PERSISTED_TITLE = 300

/**
 * The tabs a pane state asks `helpers.json` to keep. `url` is whatever the tab is at; the renderer scrubs it the way
 * it scrubs the pane's own address before it writes.
 */
export function persistedTabsOf(
  tabs: readonly BrowserTabState[],
  scrub: (url: string) => string = (u) => u
): BrowserPersistedTab[] {
  return tabs.slice(0, MAX_TABS_PER_PANE).map((t) => ({
    tabId: t.tabId,
    url: scrub(t.url).slice(0, MAX_PERSISTED_URL),
    title: t.title.slice(0, MAX_PERSISTED_TITLE),
    hostView: t.hostView
  }))
}

/** The tab fields a browser pane keeps in its `helpers.json` payload (beside the pane's own address). */
export interface BrowserTabPayloadFields {
  tabs?: BrowserPersistedTab[]
  activeTabId?: string
  /** Epoch ms the operator last focused the pane; `null` = never. */
  lastFocusedAt?: number | null
}

/**
 * The patch a pushed pane state makes to the saved tab fields, or `null` when nothing changed (so a state push that
 * changes nothing never schedules a write). A state with no tab yet never replaces saved tabs.
 */
export function tabsPatchFromState(
  saved: BrowserTabPayloadFields,
  state: {
    tabs?: readonly BrowserTabState[]
    activeTabId?: string
    lastFocusedAt?: number | null
  },
  scrub: (url: string) => string = (u) => u
): BrowserTabPayloadFields | null {
  if (!state.tabs || state.tabs.length === 0 || !state.activeTabId) return null
  const patch: BrowserTabPayloadFields = {}
  const tabs = persistedTabsOf(state.tabs, scrub)
  if (JSON.stringify(tabs) !== JSON.stringify(saved.tabs ?? [])) patch.tabs = tabs
  if (state.activeTabId !== saved.activeTabId) patch.activeTabId = state.activeTabId
  const focused = state.lastFocusedAt ?? null
  if (focused !== (saved.lastFocusedAt ?? null)) patch.lastFocusedAt = focused
  return Object.keys(patch).length > 0 ? patch : null
}
