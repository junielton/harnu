/**
 * The tab model of a browser pane, pure (browser-tabs spec S-2, ADR-0026): the ordered list of tabs a pane record
 * holds, adding, closing, activating and moving them. No electron, no clock of its own (ADR-0001): the view host feeds
 * these functions the records and does the work they name.
 *
 * A pane is the unit of partition, access and layout; a tab is the unit of page. The pane record keeps one
 * {@link TabRecord} per tab. The live page facts (address, title, history) stay with the view the host owns.
 */
import { randomBytes } from 'node:crypto'
import {
  MAX_TABS_PER_PANE,
  isTabId,
  type BrowserTabError,
  type BrowserTabHostView,
  type BrowserTabMoveResult
} from '../../shared/browser-tabs'
import type { BrowserAccess } from './access'
import type { DiscardState } from './lifecycle'
import type { BrowserPaneRecord, BrowserRegistry, TabbedPaneRecord } from './registry'
import type { BrowserLeases } from './lease'
import type { BrowserPartition } from './guest-prefs'

export { MAX_TABS_PER_PANE }

/** One tab of a pane, as the registry keeps it. */
export interface TabRecord {
  /** `tab-<8 hex>`, minted by main; stable across a restore and a move. */
  tabId: string
  /** What the host div shows for this tab: the page, the start page or the load error page (S-3 reacts). */
  hostView: BrowserTabHostView
  /** Set while the tab's page is discarded: the address and state it comes back to. `null` = live. */
  discarded: DiscardState | null
}

/** The part of a pane record the tab functions read and write. */
export type TabbedPane = Pick<TabbedPaneRecord, 'tabs' | 'activeTabId' | 'discarded'>

/** A fresh tab id that is not in `taken`. */
export function mintTabId(
  taken: ReadonlySet<string> = new Set(),
  random: () => string = () => randomBytes(4).toString('hex')
): string {
  for (;;) {
    const id = `tab-${random()}`
    if (isTabId(id) && !taken.has(id)) return id
  }
}

/**
 * Give a record written before tabs existed (or built by a caller that does not know about them) one tab. A record
 * that already has tabs is only made consistent: its active id must name one of them.
 */
export function ensureTabs(rec: BrowserPaneRecord): asserts rec is TabbedPaneRecord {
  const tabs = Array.isArray(rec.tabs) ? rec.tabs : []
  rec.tabs = tabs
  if (tabs.length === 0) {
    const tabId = mintTabId()
    tabs.push({ tabId, hostView: 'page', discarded: rec.discarded ?? null })
    rec.activeTabId = tabId
    return
  }
  if (!tabs.some((t) => t.tabId === rec.activeTabId)) rec.activeTabId = tabs[0]!.tabId
  rec.discarded = findTab({ tabs, activeTabId: rec.activeTabId! })?.discarded ?? null
}

/** The tab named `tabId`, or the active tab without one. */
export function findTab(
  rec: Pick<TabbedPane, 'tabs' | 'activeTabId'>,
  tabId?: string
): TabRecord | undefined {
  const id = tabId ?? rec.activeTabId
  return rec.tabs.find((t) => t.tabId === id)
}

/**
 * `rec.discarded` mirrors the ACTIVE tab's discard state, for the callers (and records) that think of a pane as one
 * page. Every write goes through {@link setTabDiscarded} and {@link activateTab}, so the mirror cannot drift.
 */
function mirrorDiscard(rec: TabbedPane): void {
  rec.discarded = findTab(rec)?.discarded ?? null
}

/** Record that a tab's page is gone (`state`) or live again (`null`). */
export function setTabDiscarded(
  rec: TabbedPane,
  tabId: string,
  state: DiscardState | null
): boolean {
  const tab = findTab(rec, tabId)
  if (!tab) return false
  tab.discarded = state
  mirrorDiscard(rec)
  return true
}

export type AddTabResult =
  { ok: true; tab: TabRecord } | { ok: false; error: 'TAB_LIMIT' | 'TAB_NOT_FOUND' }

/**
 * Add a tab right of `afterTabId` (default: the end), without changing which tab is active. A ninth tab is refused
 * `TAB_LIMIT`; an unknown `afterTabId` is `TAB_NOT_FOUND`.
 */
export function addTab(
  rec: TabbedPane,
  opts: {
    tabId?: string
    hostView?: 'page' | 'start'
    afterTabId?: string
    discarded?: DiscardState | null
  }
): AddTabResult {
  if (rec.tabs.length >= MAX_TABS_PER_PANE) return { ok: false, error: 'TAB_LIMIT' }
  let at = rec.tabs.length
  if (opts.afterTabId !== undefined) {
    const i = rec.tabs.findIndex((t) => t.tabId === opts.afterTabId)
    if (i < 0) return { ok: false, error: 'TAB_NOT_FOUND' }
    at = i + 1
  }
  const taken = new Set(rec.tabs.map((t) => t.tabId))
  const tab: TabRecord = {
    tabId: opts.tabId !== undefined && !taken.has(opts.tabId) ? opts.tabId : mintTabId(taken),
    hostView: opts.hostView ?? 'page',
    discarded: opts.discarded ?? null
  }
  rec.tabs.splice(at, 0, tab)
  return { ok: true, tab }
}

/** Make `tabId` the active tab. @returns whether the tab exists. */
export function activateTab(rec: TabbedPane, tabId: string): boolean {
  if (!rec.tabs.some((t) => t.tabId === tabId)) return false
  rec.activeTabId = tabId
  mirrorDiscard(rec)
  return true
}

export type RemoveTabResult =
  | { ok: false; error: 'TAB_NOT_FOUND' }
  | { ok: true; paneEmpty: boolean; wasActive: boolean; activeTabId: string | null }

/**
 * Take a tab out of the list. When it was the active tab its right neighbour takes over (else its left one); the last
 * tab leaving makes the pane empty, which closes the pane.
 */
export function removeTab(rec: TabbedPane, tabId: string): RemoveTabResult {
  const i = rec.tabs.findIndex((t) => t.tabId === tabId)
  if (i < 0) return { ok: false, error: 'TAB_NOT_FOUND' }
  const wasActive = rec.activeTabId === tabId
  rec.tabs.splice(i, 1)
  if (rec.tabs.length === 0) {
    rec.activeTabId = ''
    rec.discarded = null
    return { ok: true, paneEmpty: true, wasActive, activeTabId: null }
  }
  if (wasActive) rec.activeTabId = (rec.tabs[i] ?? rec.tabs[i - 1])!.tabId
  mirrorDiscard(rec)
  return { ok: true, paneEmpty: false, wasActive, activeTabId: rec.activeTabId }
}

/* ---- Move to a new pane ---------------------------------------------------------------------------- */

/** What the move needs from the host: re-parent one live (or discarded) tab from one pane to another. */
export interface TabMoveHost {
  moveTab(fromPaneId: string, toPaneId: string, tabId: string): boolean
  viewToken(paneId: string, tabId?: string): string | undefined
  info(paneId: string, tabId?: string): { url: string } | undefined
}

export interface TabMoveDeps {
  registry: BrowserRegistry
  access: Pick<BrowserAccess, 'isDisconnected' | 'disconnect'>
  leases: Pick<BrowserLeases, 'rekey'>
  host: TabMoveHost
  newPaneId(): string
  now(): number
  /** Tell the renderer to place the new pane below the current one (the `browser:popup` event). */
  notifyPopup(payload: {
    paneId: string
    worktreePath: string
    url: string
    partition: BrowserPartition
    /** Who opened the pane the tab came from: a moved agent tab stays an agent pane. */
    openedBy: 'agent' | 'operator'
    ownerSessionId: string | null
    name: string
  }): void
}

/**
 * "Move to a new pane" (spec): a new pane record copies the old one's partition, `openedBy`, owner, Disconnect,
 * emulation and name; the tab keeps its id, page and history; an active lease follows it (same view token, new pane
 * id). Pause and capture stay behind. An agent pane at the cap is refused `PANE_LIMIT`, a disconnected one does not
 * count (as today); a pane's only tab does not move.
 */
export function moveTabToNewPane(
  deps: TabMoveDeps,
  paneId: string,
  tabId: string
): BrowserTabMoveResult {
  const old = deps.registry.get(paneId)
  if (!old) return fail('PANE_NOT_FOUND')
  const tab = findTab(old, tabId)
  if (!tab) return fail('TAB_NOT_FOUND')
  if (old.tabs.length < 2) return fail('BAD_ARGS')
  const disconnected = deps.access.isDisconnected(paneId)
  if (
    old.openedBy === 'agent' &&
    !disconnected &&
    deps.registry.agentPanesIn(old.folder).length >= deps.registry.maxAgentPanes
  ) {
    return fail('PANE_LIMIT')
  }

  const newPaneId = deps.newPaneId()
  const token = deps.host.viewToken(paneId, tabId)
  const now = deps.now()
  // The tab leaves the old record; the new record starts with it as its only (active) tab.
  const index = old.tabs.findIndex((t) => t.tabId === tabId)
  const wasActive = old.activeTabId === tabId
  removeTab(old, tabId)
  const fresh: TabbedPaneRecord = {
    paneId: newPaneId,
    folder: old.folder,
    name: old.name,
    openedBy: old.openedBy,
    partition: old.partition,
    ownerSessionId: old.ownerSessionId,
    createdAt: now,
    lastActiveAt: now,
    seenHosts: new Set(old.seenHosts),
    flagged: null,
    pagePath: null,
    allowNetwork: false,
    tabs: [tab],
    activeTabId: tab.tabId,
    discarded: tab.discarded,
    ...(old.emulation ? { emulation: structuredClone(old.emulation) } : {})
  }
  deps.registry.add(fresh)
  if (disconnected) deps.access.disconnect(newPaneId)
  // The lease follows the tab BEFORE the host republishes either pane: the chip's display call re-reads the lease and
  // would drop it as stale while it still sat under the old pane id.
  const leaseMoved = token !== undefined && deps.leases.rekey(paneId, newPaneId, token)
  const moved = deps.host.moveTab(paneId, newPaneId, tabId)
  if (!moved) {
    // The host could not move the view: put everything back as it was.
    if (leaseMoved && token !== undefined) deps.leases.rekey(newPaneId, paneId, token)
    deps.registry.remove(newPaneId)
    old.tabs.splice(index, 0, tab)
    if (wasActive) activateTab(old, tabId)
    return fail('TAB_NOT_FOUND')
  }
  deps.notifyPopup({
    paneId: newPaneId,
    worktreePath: old.folder,
    url: deps.host.info(newPaneId)?.url ?? '',
    partition: old.partition,
    openedBy: old.openedBy,
    ownerSessionId: old.ownerSessionId,
    name: old.name
  })
  return { ok: true, paneId: newPaneId }
}

function fail(error: BrowserTabError): { ok: false; error: BrowserTabError } {
  return { ok: false, error }
}
