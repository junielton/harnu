/**
 * The browser pane's tab strip, pure (browser-tabs spec S-4, design.md §6 "Browser pane"): how many tabs fit and at
 * what width, which tabs go behind `+N`, what the tab menu offers and does, and which pane the Topbar's Browser
 * button adds its tab to. No Vue, no electron: the components and the store feed these functions plain values.
 */
import {
  MAX_TABS_PER_PANE,
  type BrowserTabCloseResult,
  type BrowserTabMoveResult,
  type BrowserTabNewOptions,
  type BrowserTabResult
} from '../../../shared/browser-tabs'

/* ---- Layout (design.md "Overflow") --------------------------------------------------------------------- */

/** The widths the strip is drawn with (CSS px). */
export const TAB_FULL_PX = 168
export const TAB_SHORT_PX = 112
export const TAB_MIN_SHRINK_PX = 80
export const TAB_ICON_PX = 28
/**
 * Room kept for the `+N` button when some tabs do not fit: the button is about 35px wide (`+5`, a 10px chevron,
 * 5px padding each side) and the approved 8-tab mockup, at its 314px strip, keeps the active tab and 2 icons, which
 * 40 reproduces (the spec's earlier 36 gave 3).
 */
export const TAB_MORE_PX = 40
/** `+` and its 4px side margins: the part of the strip the layout's width leaves out. */
export const TAB_PLUS_PX = 26
/** "short" needs a strip wider than this. */
const SHORT_MIN_STRIP_PX = 480

export type TabStripMode = 'full' | 'short' | 'shrink' | 'icons'

export interface TabStripLayout {
  mode: TabStripMode
  /** Width of the active tab, px. */
  activeWidth: number
  /** Width of every other drawn tab, px. */
  inactiveWidth: number
  /** The tabs drawn in the strip, in order (the active tab is always among them). */
  visible: string[]
  /** The tabs behind `+N`, in order. */
  overflow: string[]
}

/**
 * The first mode that fits strip width `width` for `tabIds` (spec "Overflow"). When none fits, `icons` applies with
 * {@link TAB_MORE_PX} reserved for `+N`: the active tab and the first k inactive tabs stay, the rest move behind
 * `+N`; the active tab is never moved.
 */
export function layoutTabStrip(
  width: number,
  tabIds: readonly string[],
  activeId: string
): TabStripLayout {
  const n = tabIds.length
  const all = [...tabIds]
  const fits = (mode: TabStripMode, active: number, inactive: number): TabStripLayout => ({
    mode,
    activeWidth: active,
    inactiveWidth: inactive,
    visible: all,
    overflow: []
  })
  if (n === 0) return fits('full', TAB_FULL_PX, TAB_FULL_PX)
  if (n * TAB_FULL_PX <= width) return fits('full', TAB_FULL_PX, TAB_FULL_PX)
  if (width > SHORT_MIN_STRIP_PX && TAB_FULL_PX + (n - 1) * TAB_SHORT_PX <= width) {
    return fits('short', TAB_FULL_PX, TAB_SHORT_PX)
  }
  if (n * TAB_MIN_SHRINK_PX <= width) {
    const each = Math.floor(width / n)
    return fits('shrink', each, each)
  }
  if (TAB_FULL_PX + (n - 1) * TAB_ICON_PX <= width) {
    return fits('icons', TAB_FULL_PX, TAB_ICON_PX)
  }
  const k = Math.max(0, Math.floor((width - TAB_MORE_PX - TAB_FULL_PX) / TAB_ICON_PX))
  const keep = new Set<string>([activeId])
  let room = k
  for (const id of all) {
    if (room === 0) break
    if (id === activeId) continue
    keep.add(id)
    room -= 1
  }
  return {
    mode: 'icons',
    activeWidth: TAB_FULL_PX,
    inactiveWidth: TAB_ICON_PX,
    visible: all.filter((id) => keep.has(id)),
    overflow: all.filter((id) => !keep.has(id))
  }
}

/**
 * Where the `+N` list's left edge sits in the strip: its right edge is {@link TAB_PLUS_PX} short of the strip's right
 * edge (the approved mockup's anchor), and the list never leaves the strip, 4px from either side.
 */
export function moreListLeft(rootWidth: number, listWidth: number): number {
  const wanted = rootWidth - TAB_PLUS_PX - listWidth
  return Math.max(4, Math.min(wanted, rootWidth - listWidth - 4))
}

/* ---- Tab menu (design.md "Tab menu") ------------------------------------------------------------------- */

export const TAB_MENU_ACTIONS = [
  'newRight',
  'reload',
  'duplicate',
  'move',
  'closeOthers',
  'close'
] as const
export type TabMenuAction = (typeof TAB_MENU_ACTIONS)[number]

/** How many agent panes a folder may hold (`MAX_AGENT_PANES_PER_FOLDER` in main's registry). */
export const MAX_AGENT_PANES = 4

export interface TabMenuContext {
  /** The pane's tab count. */
  tabCount: number
  /** The pane is an agent pane (not disconnected) and its folder already holds the most agent panes. */
  agentPaneAtCap: boolean
}

/**
 * Which menu rows are off. Move to a new pane is refused on a pane's only tab (main answers `BAD_ARGS`) and for an
 * agent pane at the agent-pane cap (main answers `PANE_LIMIT`).
 */
export function tabMenuState(ctx: TabMenuContext): { move: { disabled: boolean } } {
  return { move: { disabled: ctx.tabCount < 2 || ctx.agentPaneAtCap } }
}

/** The tab operations the menu needs (`window.api` of the preload; the store passes its own). */
export interface TabMenuApi {
  tabNew(paneId: string, opts?: BrowserTabNewOptions): Promise<BrowserTabResult>
  tabClose(paneId: string, tabId: string): Promise<BrowserTabCloseResult>
  tabDuplicate(paneId: string, tabId: string): Promise<BrowserTabResult>
  tabMoveToPane(paneId: string, tabId: string): Promise<BrowserTabMoveResult>
  tabReload(paneId: string, tabId: string): Promise<boolean>
}

export interface TabMenuTarget {
  paneId: string
  tabId: string
  /** Every tab of the pane, in order. */
  tabIds: readonly string[]
}

/**
 * Run one row of the tab menu on `target`. **New tab to the right** makes a `start` tab right of it (the caller then
 * puts the cursor in its address field: `focusAddress`); **Duplicate** asks main for a copy that loads the same URL
 * without history or scroll; **Move to a new pane** is main's, which announces the new pane on `browser:popup`;
 * **Close other tabs** closes every tab but this one, one by one.
 */
export async function runTabMenuAction(
  api: TabMenuApi,
  target: TabMenuTarget,
  action: TabMenuAction
): Promise<{ ok: boolean; focusAddress: boolean }> {
  const { paneId, tabId } = target
  switch (action) {
    case 'newRight': {
      const res = await api.tabNew(paneId, { hostView: 'start', afterTabId: tabId })
      return { ok: res.ok, focusAddress: res.ok }
    }
    case 'reload':
      return { ok: await api.tabReload(paneId, tabId), focusAddress: false }
    case 'duplicate':
      return { ok: (await api.tabDuplicate(paneId, tabId)).ok, focusAddress: false }
    case 'move':
      return { ok: (await api.tabMoveToPane(paneId, tabId)).ok, focusAddress: false }
    case 'closeOthers': {
      let ok = true
      for (const other of target.tabIds) {
        if (other === tabId) continue
        ok = (await api.tabClose(paneId, other)).ok && ok
      }
      return { ok, focusAddress: false }
    }
    case 'close':
      return { ok: (await api.tabClose(paneId, tabId)).ok, focusAddress: false }
  }
}

/* ---- Which pane the Topbar's Browser button targets (design.md "Topbar Browser button") ------------------ */

/** A browser pane of the folder, as the Topbar's choice sees it. */
export interface TabPaneCandidate {
  paneId: string
  openedBy: 'agent' | 'operator'
  /** A live panel (`page` pane): it keeps one tab. */
  page: boolean
  /** When the operator last focused the pane, or `null` (never stamped). */
  lastFocusedAt: number | null
  /** Creation order in the folder's stack, larger = newer: ranks the panes nothing has stamped. */
  order: number
  tabCount: number
  activeTabId: string
}

/**
 * The operator pane the operator used last: the latest `lastFocusedAt`; a pane with no stamp ranks below every
 * stamped one, by creation time, newest first. Agent panes and live panels are never candidates.
 */
export function lastUsedOperatorPane(panes: readonly TabPaneCandidate[]): TabPaneCandidate | null {
  const eligible = panes.filter((p) => p.openedBy === 'operator' && !p.page)
  if (eligible.length === 0) return null
  const stamped = eligible.filter((p) => p.lastFocusedAt !== null)
  if (stamped.length > 0) {
    return stamped.reduce((best, p) => (p.lastFocusedAt! > best.lastFocusedAt! ? p : best))
  }
  return eligible.reduce((best, p) => (p.order > best.order ? p : best))
}

export type BrowserTarget = { kind: 'tab'; paneId: string; afterTabId: string } | { kind: 'pane' }

/**
 * What the Topbar Browser button does (spec D-1): a `start` tab right of the active tab of the last-used operator
 * pane; a new pane when the folder has none, when that pane is at the tab limit, or on Shift+click.
 */
export function chooseBrowserTarget(
  panes: readonly TabPaneCandidate[],
  shift: boolean
): BrowserTarget {
  if (shift) return { kind: 'pane' }
  const target = lastUsedOperatorPane(panes)
  if (!target || target.tabCount >= MAX_TABS_PER_PANE) return { kind: 'pane' }
  return { kind: 'tab', paneId: target.paneId, afterTabId: target.activeTabId }
}

/* ---- A tab's favicon fallback (design.md "Tab strip") --------------------------------------------------- */

export type TabOriginClass = 'local' | 'external' | 'page'

/**
 * The host of a tab's address and the origin class its fallback icon takes its colours from. The renderer does not
 * know the operator's trusted dev hosts, so `local` here is loopback, `*.localhost` and `*.test`; the address bar's
 * badge (main's classification) stays the authority for the active tab.
 */
export function tabFaviconView(tab: { url: string }): { host: string; origin: TabOriginClass } {
  let url: URL
  try {
    url = new URL(tab.url)
  } catch {
    return { host: '', origin: 'external' }
  }
  if (url.protocol === 'harnu-page:') return { host: url.host, origin: 'page' }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const loopback = host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host)
  const dev = host.endsWith('.localhost') || host.endsWith('.test')
  return { host: url.host, origin: loopback || dev ? 'local' : 'external' }
}
