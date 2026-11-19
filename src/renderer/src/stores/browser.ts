import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { isMac } from '../lib/platform'
import { actionForChord, boundChordsFrom } from '../lib/browser-chords'
import { startNativeOverlayWatcher } from '../lib/native-overlay'
import { dispatchForwardedChord } from '../composables/useShortcuts'
import { i18n } from '../i18n'
import { useUiStore } from './ui'
import { browserPayload, useHelpersStore } from './helpers'
import { useKeybindingsStore } from './keybindings'
import { payloadPatchFromPersist, payloadPatchFromState } from '../lib/browser-persist'
import {
  MAX_AGENT_PANES,
  chooseBrowserTarget,
  runTabMenuAction,
  type TabMenuAction,
  type TabPaneCandidate
} from '../lib/browser-tabs-view'
import { scrubUrl } from '../../../shared/browser-comment'
import {
  MAX_TABS_PER_PANE,
  tabsPatchFromState,
  type BrowserTabCloseResult,
  type BrowserTabMoveResult,
  type BrowserTabNewOptions,
  type BrowserTabResult
} from '../../../shared/browser-tabs'
import type {
  BrowserActivityWord,
  BrowserEmulatePatch,
  BrowserPaneState,
  CommentPaneState,
  CommentSubmitResult
} from '../../../preload'

/**
 * Browser pane store (T564 U1): the live state main pushes for each pane (`browser:state`), the chip's live
 * word, the frozen-frame images, and the forwarded chords. Main owns the guest views and every decision about
 * them; this store only holds what the chrome needs to draw, and relays the operator's gestures.
 *
 * `start()` is idempotent and runs once, from `App.vue`: it subscribes to main's events, starts the native
 * overlay watcher (spec §2.4) and keeps main told which chords Harnu binds (spec §2.5).
 */
/** The start page reads its lists when it shows, then at most this often while it stays shown (browser-tabs S-5). */
export const START_REFRESH_MS = 5000

export const useBrowserStore = defineStore('browser', () => {
  const helpers = useHelpersStore()
  const keybindings = useKeybindingsStore()

  const states = ref<Record<string, BrowserPaneState>>({})
  const words = ref<Record<string, BrowserActivityWord>>({})
  /** paneId → the frozen frame's data URL (`null` = a blank rect of the pane background). Present = frozen. */
  const frozen = ref<Record<string, string | null>>({})
  /** The pane a forwarded chord came from: the target of `browser.back`, `browser.reload`, ... */
  const chordPaneId = ref<string | null>(null)
  /** The pane whose header or address bar holds the keyboard focus, or `null` (Ctrl+W then closes its tab). */
  const chromeFocusPaneId = ref<string | null>(null)
  /** Bumped per `browser.focusAddress`, per pane, so a repeat re-fires the pane's watcher. */
  const focusAddressNonce = ref<Record<string, number>>({})
  const focusAddressPending = ref<Record<string, boolean>>({})
  /** paneId → the point-and-comment state main pushes (pins, whether picking, the open composer pin). */
  const comments = ref<Record<string, CommentPaneState>>({})
  /** paneId → the session the operator picked in the composer ("remembered per pane", spec §8.7). */
  const destinations = ref<Record<string, string>>({})
  /** Ticks each second while some pane is paused or recording network, so the countdowns move; otherwise static. */
  const clock = ref(Date.now())

  let started = false
  const disposers: Array<() => void> = []

  function applyState(state: BrowserPaneState): void {
    states.value = { ...states.value, [state.paneId]: state }
    // Keep what a restart restores on the pane in `helpers.json` (T574, spec §10.3): the page the pane shows, and
    // its tabs in order with each one's address, title and `hostView` (browser tabs).
    helpers.patchBrowserPayload(state.paneId, (saved) => {
      const page = payloadPatchFromState(saved, state)
      const tabs = tabsPatchFromState(saved, state, scrubUrl)
      return page || tabs ? { ...page, ...tabs } : null
    })
  }

  async function refresh(paneId: string): Promise<void> {
    const state = await window.api.browserState(paneId)
    if (state) applyState(state)
  }

  /** "Paused to save memory — click to reload" (T574, spec §10.1): bring the pane's page back. */
  async function revive(paneId: string): Promise<boolean> {
    return window.api.browserRevive(paneId)
  }

  /** Forget everything held for a pane that is gone. */
  function forget(paneId: string): void {
    const { [paneId]: _s, ...rest } = states.value
    states.value = rest
    const { [paneId]: _w, ...restWords } = words.value
    words.value = restWords
    const { [paneId]: _f, ...restFrozen } = frozen.value
    frozen.value = restFrozen
    const { [paneId]: _c, ...restComments } = comments.value
    comments.value = restComments
    const { [paneId]: _d, ...restDest } = destinations.value
    destinations.value = restDest
  }

  function onChord(paneId: string, chord: string): void {
    const hit = actionForChord(keybindings.resolved.list, chord, isMac)
    if (!hit) return
    chordPaneId.value = paneId
    dispatchForwardedChord(hit.id)
  }

  function start(): void {
    if (started || typeof window === 'undefined' || !window.api?.onBrowserState) return
    started = true
    disposers.push(
      window.api.onBrowserState(applyState),
      window.api.onBrowserActivity(({ paneId, word }) => {
        words.value = { ...words.value, [paneId]: word }
      }),
      window.api.onBrowserFreeze(({ paneId, dataUrl }) => {
        frozen.value = { ...frozen.value, [paneId]: dataUrl }
      }),
      window.api.onBrowserUnfreeze(({ paneId }) => {
        // Main already showed the view again: drop the still image on the NEXT frame, so there is no flash.
        requestAnimationFrame(() => {
          const { [paneId]: _f, ...rest } = frozen.value
          frozen.value = rest
        })
      }),
      window.api.onBrowserChord(({ paneId, chord }) => onChord(paneId, chord)),
      window.api.onBrowserPersist((event) =>
        helpers.patchBrowserPayload(event.paneId, (saved) => payloadPatchFromPersist(saved, event))
      ),
      window.api.onBrowserCommentState((state) => {
        comments.value = { ...comments.value, [state.paneId]: state }
      }),
      window.api.onBrowserPopup(
        ({ paneId, worktreePath, url, partition, openedBy, ownerSessionId, name }) => {
          // A pane main made: a popup the operator clicked open (an operator-class pane that inherits the opener's
          // partition) or a tab moved to a new pane (which keeps who opened the pane it came from).
          helpers.addBrowserHelper(worktreePath, {
            paneId,
            name: name ?? '',
            url,
            openedBy: openedBy ?? 'operator',
            partition,
            ownerSessionId: ownerSessionId ?? null
          })
        }
      ),
      startNativeOverlayWatcher((overlays) => window.api.browserOverlays(overlays))
    )
    // Main swallows a guest key only if Harnu binds that chord, so keep main's set current.
    const stopChords = watch(
      () => keybindings.resolved,
      (resolved) => window.api.browserSetChords(boundChordsFrom(resolved.list, isMac)),
      { immediate: true }
    )
    disposers.push(stopChords)
    // Splitter, pane-resize and sidebar drags freeze every visible view (spec §2.4): once the pointer enters a
    // native view the renderer stops receiving `pointermove` and the drag would die. Every drag handle in the
    // app announces itself with a resize cursor, so one capture listener covers them all, present and future.
    let dragFrozen = false
    const onPointerDown = (ev: MouseEvent): void => {
      const target = ev.target
      if (!(target instanceof Element)) return
      const cursor = getComputedStyle(target).cursor
      if (cursor !== 'col-resize' && cursor !== 'row-resize') return
      dragFrozen = true
      window.api.browserDrag(true)
    }
    const onPointerUp = (): void => {
      if (!dragFrozen) return
      dragFrozen = false
      window.api.browserDrag(false)
    }
    window.addEventListener('mousedown', onPointerDown, true)
    window.addEventListener('mouseup', onPointerUp, true)
    window.addEventListener('blur', onPointerUp)
    disposers.push(() => {
      window.removeEventListener('mousedown', onPointerDown, true)
      window.removeEventListener('mouseup', onPointerUp, true)
      window.removeEventListener('blur', onPointerUp)
    })
    const timer = setInterval(() => {
      if (
        Object.values(states.value).some((s) => s.pausedUntil !== null || s.networkUntil !== null)
      ) {
        clock.value = Date.now()
      }
    }, 1000)
    disposers.push(() => clearInterval(timer))
  }

  function stop(): void {
    for (const dispose of disposers.splice(0)) dispose()
    started = false
  }

  /* ---- The operator's gestures, relayed to main ---------------------------------------------- */

  function navigate(
    paneId: string,
    target: { url: string } | { action: 'back' | 'forward' | 'reload' | 'stop' }
  ): Promise<{ ok: true } | { ok: false; scheme: string }> {
    return window.api.browserNavigate({ paneId, ...target })
  }

  /* ---- The start page's lists (S-5): main builds them, the page only asks ------------------------- */

  // `async` so a missing bridge (an old preload) is a rejection the page absorbs, never a throw in its timer.
  async function startServers(
    folder: string
  ): Promise<Array<{ name: string; url: string; source: string }>> {
    return window.api.browserStartServers(folder)
  }
  async function startRecent(
    folder: string
  ): Promise<Array<{ title: string; url: string; host: string }>> {
    return window.api.browserStartRecent(folder)
  }

  /* ---- Tabs: main owns every tab; these relay the operator's gestures (the strip is S-4) ---------- */

  function tabNew(paneId: string, opts?: BrowserTabNewOptions): Promise<BrowserTabResult> {
    return window.api.browserTabNew(paneId, opts)
  }
  /**
   * A new tab with no address (the start page) right of `afterTabId`, and the cursor in its address field: what `+`,
   * "New tab to the right", Ctrl+T and the Topbar's Browser button all do (spec D-1, AC-38).
   */
  async function tabNewStart(paneId: string, afterTabId?: string): Promise<BrowserTabResult> {
    const res = await tabNew(paneId, {
      hostView: 'start',
      ...(afterTabId ? { afterTabId } : {})
    })
    if (res.ok) requestFocusAddress(paneId)
    return res
  }
  /** Close a tab; closing the pane's last tab closes the pane, so its place in the stack goes too. */
  async function tabClose(paneId: string, tabId: string): Promise<BrowserTabCloseResult> {
    const res = await window.api.browserTabClose(paneId, tabId)
    if (res.ok && res.paneClosed) {
      for (const [worktreePath, stack] of helpers.byWorktree) {
        if (stack.panes.some((p) => p.id === paneId)) helpers.removeHelper(worktreePath, paneId)
      }
      forget(paneId)
    }
    return res
  }
  async function tabActivate(paneId: string, tabId: string): Promise<boolean> {
    return (await window.api.browserTabActivate(paneId, tabId)).ok
  }
  function tabDuplicate(paneId: string, tabId: string): Promise<BrowserTabResult> {
    return window.api.browserTabDuplicate(paneId, tabId)
  }
  function tabMoveToPane(paneId: string, tabId: string): Promise<BrowserTabMoveResult> {
    return window.api.browserTabMoveToPane(paneId, tabId)
  }
  async function tabReload(paneId: string, tabId: string): Promise<boolean> {
    return (await window.api.browserTabReload(paneId, tabId)).ok
  }
  /** "Reload when it is up" on an error tab: `on` starts main's TCP poll of its local origin, `false` cancels it. */
  async function tabReloadWhenUp(paneId: string, tabId: string, on: boolean): Promise<boolean> {
    return (await window.api.browserTabReloadWhenUp(paneId, tabId, on)).ok
  }
  /** One row of a tab's context menu (design.md "Tab menu"). */
  async function tabMenu(paneId: string, tabId: string, action: TabMenuAction): Promise<boolean> {
    const tabIds = states.value[paneId]?.tabs?.map((t) => t.tabId) ?? []
    const res = await runTabMenuAction(
      { tabNew, tabClose, tabDuplicate, tabMoveToPane, tabReload },
      { paneId, tabId, tabIds },
      action
    )
    if (res.focusAddress) requestFocusAddress(paneId)
    return res.ok
  }
  /** Step to the next or previous tab of a pane, wrapping around (Ctrl+Tab, Ctrl+Shift+Tab). */
  async function tabStep(paneId: string, delta: 1 | -1): Promise<boolean> {
    const st = states.value[paneId]
    const tabs = st?.tabs ?? []
    if (!st || tabs.length < 2) return false
    const at = tabs.findIndex((t) => t.tabId === st.activeTabId)
    const next = tabs[(at + delta + tabs.length) % tabs.length]
    return next ? tabActivate(paneId, next.tabId) : false
  }
  /** Close the pane's active tab (Ctrl+W while a browser pane has the focus). */
  async function tabCloseActive(paneId: string): Promise<boolean> {
    const id = states.value[paneId]?.activeTabId
    return id ? (await tabClose(paneId, id)).ok : false
  }
  /** A new start tab right of the pane's active tab (Ctrl+T while a browser pane has the focus). */
  async function tabNewActive(paneId: string): Promise<boolean> {
    const st = states.value[paneId]
    if (!st || (st.tabs?.length ?? 0) >= MAX_TABS_PER_PANE) return false
    return (await tabNewStart(paneId, st.activeTabId)).ok
  }
  /** Whether "Move to a new pane" is off for an agent pane: the folder already holds the most agent panes. */
  function agentPaneAtCap(paneId: string): boolean {
    const st = states.value[paneId]
    if (!st || st.openedBy !== 'agent' || st.disconnected) return false
    for (const stack of helpers.byWorktree.values()) {
      if (!stack.panes.some((p) => p.id === paneId)) continue
      const live = stack.panes.filter((p) => {
        if (p.type !== 'browser') return false
        const other = states.value[p.id]
        return browserPayload(p).openedBy === 'agent' && !(other?.disconnected ?? false)
      })
      return live.length >= MAX_AGENT_PANES
    }
    return false
  }
  /** The operator focused a pane's header or address bar: main stamps it as the last used one (AC-39). */
  function paneFocused(paneId: string): void {
    void window.api.browserPaneFocused(paneId)
  }

  /** The folder's browser panes, as the Topbar's choice sees them (creation order = stack order). */
  function topbarCandidates(folder: string): TabPaneCandidate[] {
    const panes = helpers.byWorktree.get(folder)?.panes ?? []
    const out: TabPaneCandidate[] = []
    panes.forEach((pane, order) => {
      if (pane.type !== 'browser') return
      const payload = pane.payload as {
        tabs?: unknown[]
        activeTabId?: string
        lastFocusedAt?: number | null
      }
      const st = states.value[pane.id]
      out.push({
        paneId: pane.id,
        openedBy: st?.openedBy ?? browserPayload(pane).openedBy,
        page: st ? st.origin === 'page' || !!st.pagePath : !!browserPayload(pane).pagePath,
        lastFocusedAt: st?.lastFocusedAt ?? payload?.lastFocusedAt ?? null,
        order,
        tabCount: st?.tabs?.length ?? payload?.tabs?.length ?? 1,
        activeTabId: st?.activeTabId ?? payload?.activeTabId ?? ''
      })
    })
    return out
  }

  /**
   * The Topbar Browser button (spec D-1): a start tab in the folder's last-used operator pane with the cursor in its
   * address field; `openPane` (a new pane, as before) when the folder has none, that pane is at the tab limit, or the
   * operator Shift+clicked. @returns what happened.
   */
  async function openFromTopbar(
    folder: string,
    opts: { shift: boolean },
    openPane: () => Promise<void>
  ): Promise<'tab' | 'pane'> {
    const target = chooseBrowserTarget(topbarCandidates(folder), opts.shift)
    if (target.kind === 'tab') {
      // A refusal (`TAB_LIMIT`, a pane main no longer knows) or a failed call falls back to a pane, as with no pane.
      const res = await tabNewStart(target.paneId, target.afterTabId).catch(() => null)
      if (res?.ok) {
        // The pane may be in a collapsed helper panel: ask the app to show it.
        if (folder === helpers.currentWorktreePath) helpers.paneRevealTick++
        return 'tab'
      }
    }
    await openPane()
    return 'pane'
  }

  async function pause(paneId: string): Promise<void> {
    const until = await window.api.browserPause(paneId)
    if (until !== null) clock.value = Date.now()
    await refresh(paneId)
  }

  async function resume(paneId: string): Promise<void> {
    await window.api.browserResume(paneId)
    await refresh(paneId)
  }

  /** @returns whether main confirmed: only then may the UI say the agent lost access. */
  async function disconnect(paneId: string): Promise<boolean> {
    const ok = await window.api.browserDisconnect(paneId)
    await refresh(paneId)
    return ok
  }

  /** Zoom the pane one ladder step, or back to 100% (main refuses in device mode and answers 1). */
  async function zoom(paneId: string, action: 'in' | 'out' | 'reset'): Promise<number | null> {
    const factor = await window.api.browserZoom({ paneId, action })
    await refresh(paneId)
    return factor
  }

  /** The device picker: the same patch shape `browser_emulate` takes (plus `rotate`). */
  async function emulate(
    paneId: string,
    patch: BrowserEmulatePatch
  ): Promise<{ ok: true } | { ok: false; detail: string }> {
    const res = await window.api.browserEmulate({ paneId, patch })
    await refresh(paneId)
    return res
  }

  /** Answer the "Save to .harnu/out/downloads/?" prompt. */
  async function answerDownload(paneId: string, allow: boolean): Promise<void> {
    await window.api.browserDownloadDecision({ paneId, allow })
    await refresh(paneId)
  }

  /**
   * Ask a pane to focus its address field. Also recorded as PENDING, because the pane may not be mounted yet
   * (a pane that was just created mounts a tick later): the pane takes the pending request when it mounts.
   */
  function requestFocusAddress(paneId: string): void {
    focusAddressNonce.value = {
      ...focusAddressNonce.value,
      [paneId]: (focusAddressNonce.value[paneId] ?? 0) + 1
    }
    focusAddressPending.value = { ...focusAddressPending.value, [paneId]: true }
  }

  /** @returns whether a focus request was waiting for this pane, and clears it. */
  function takeFocusAddressPending(paneId: string): boolean {
    if (!focusAddressPending.value[paneId]) return false
    const { [paneId]: _p, ...rest } = focusAddressPending.value
    focusAddressPending.value = rest
    return true
  }

  /* ---- Point-and-comment (T573) ---------------------------------------------------------------- */

  /** The app theme's two overlay colours, read live so the page layers match the theme. */
  function overlayTheme(): { accent: string; accentInk: string } {
    const css = getComputedStyle(document.documentElement)
    return {
      accent: css.getPropertyValue('--color-accent').trim() || '#7aa2f7',
      accentInk: css.getPropertyValue('--color-accent-ink').trim() || '#0b0e1a'
    }
  }

  function overlayActive(paneId: string): boolean {
    return comments.value[paneId]?.overlayActive === true
  }

  function setOverlay(paneId: string, active: boolean): Promise<boolean> {
    return window.api.browserOverlaySet({
      paneId,
      active,
      hint: i18n.global.t('browserPane.comment.hint'),
      exitHint: i18n.global.t('browserPane.comment.hintExit'),
      theme: overlayTheme()
    })
  }

  function toggleOverlay(paneId: string): Promise<boolean> {
    return setOverlay(paneId, !overlayActive(paneId))
  }

  /** Close the docked composer (the pane host grows back). */
  function closeComposer(paneId: string): Promise<boolean> {
    return window.api.browserCommentOpen({ paneId, pinId: null })
  }

  function rememberDestination(paneId: string, sessionId: string | null): void {
    if (sessionId === null) {
      const { [paneId]: _d, ...rest } = destinations.value
      destinations.value = rest
    } else {
      destinations.value = { ...destinations.value, [paneId]: sessionId }
    }
  }

  /**
   * Send pins to a session and say what happened. A delivered comment needs no toast of its own (the Activity
   * row "Comment sent to the session" is the record); the other outcomes the operator has to hear.
   */
  async function submitComments(
    paneId: string,
    which: string[] | 'drafts',
    sessionId: string | null
  ): Promise<CommentSubmitResult> {
    const t = i18n.global.t
    const ui = useUiStore()
    const result = await window.api.browserCommentSubmit({ paneId, which, sessionId })
    if (!result.ok) {
      ui.pushToast({
        kind: 'warning',
        title: t('browserPane.comment.refusedTitle'),
        description: t(`browserPane.comment.refused.${result.error}`)
      })
    } else if (!result.delivered) {
      ui.pushToast({
        kind: 'warning',
        title: t('browserPane.comment.noSessionTitle'),
        description: result.copied
          ? t('browserPane.comment.noSessionBody')
          : t('browserPane.comment.noSessionLost')
      })
    }
    return result
  }

  return {
    states,
    words,
    comments,
    destinations,
    overlayActive,
    setOverlay,
    toggleOverlay,
    closeComposer,
    rememberDestination,
    submitComments,
    frozen,
    chordPaneId,
    chromeFocusPaneId,
    focusAddressNonce,
    clock,
    start,
    stop,
    refresh,
    revive,
    forget,
    navigate,
    startServers,
    startRecent,
    tabNew,
    tabNewStart,
    tabClose,
    tabActivate,
    tabDuplicate,
    tabMoveToPane,
    tabReload,
    tabReloadWhenUp,
    tabMenu,
    tabStep,
    tabCloseActive,
    tabNewActive,
    agentPaneAtCap,
    paneFocused,
    openFromTopbar,
    pause,
    resume,
    disconnect,
    zoom,
    emulate,
    answerDownload,
    requestFocusAddress,
    takeFocusAddressPending
  }
})
