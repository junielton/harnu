import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { isMac } from '../lib/platform'
import { actionForChord, boundChordsFrom } from '../lib/browser-chords'
import { startNativeOverlayWatcher } from '../lib/native-overlay'
import { dispatchForwardedChord } from '../composables/useShortcuts'
import { useHelpersStore } from './helpers'
import { useKeybindingsStore } from './keybindings'
import type { BrowserActivityWord, BrowserPaneState } from '../../../preload'

/**
 * Browser pane store (T564 U1): the live state main pushes for each pane (`browser:state`), the chip's live
 * word, the frozen-frame images, and the forwarded chords. Main owns the guest views and every decision about
 * them; this store only holds what the chrome needs to draw, and relays the operator's gestures.
 *
 * `start()` is idempotent and runs once, from `App.vue`: it subscribes to main's events, starts the native
 * overlay watcher (spec §2.4) and keeps main told which chords Harnu binds (spec §2.5).
 */
export const useBrowserStore = defineStore('browser', () => {
  const helpers = useHelpersStore()
  const keybindings = useKeybindingsStore()

  const states = ref<Record<string, BrowserPaneState>>({})
  const words = ref<Record<string, BrowserActivityWord>>({})
  /** paneId → the frozen frame's data URL (`null` = a blank rect of the pane background). Present = frozen. */
  const frozen = ref<Record<string, string | null>>({})
  /** The pane a forwarded chord came from: the target of `browser.back`, `browser.reload`, ... */
  const chordPaneId = ref<string | null>(null)
  /** Bumped per `browser.focusAddress`, per pane, so a repeat re-fires the pane's watcher. */
  const focusAddressNonce = ref<Record<string, number>>({})
  const focusAddressPending = ref<Record<string, boolean>>({})
  /** Ticks each second while some pane is paused or recording network, so the countdowns move; otherwise static. */
  const clock = ref(Date.now())

  let started = false
  const disposers: Array<() => void> = []

  function applyState(state: BrowserPaneState): void {
    states.value = { ...states.value, [state.paneId]: state }
  }

  async function refresh(paneId: string): Promise<void> {
    const state = await window.api.browserState(paneId)
    if (state) applyState(state)
  }

  /** Forget everything held for a pane that is gone. */
  function forget(paneId: string): void {
    const { [paneId]: _s, ...rest } = states.value
    states.value = rest
    const { [paneId]: _w, ...restWords } = words.value
    words.value = restWords
    const { [paneId]: _f, ...restFrozen } = frozen.value
    frozen.value = restFrozen
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
      window.api.onBrowserPopup(({ paneId, worktreePath, url, partition }) => {
        // A popup the operator clicked open: an operator-class pane that inherits the opener's partition.
        helpers.addBrowserHelper(worktreePath, {
          paneId,
          name: '',
          url,
          openedBy: 'operator',
          partition,
          ownerSessionId: null
        })
      }),
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

  return {
    states,
    words,
    frozen,
    chordPaneId,
    focusAddressNonce,
    clock,
    start,
    stop,
    refresh,
    forget,
    navigate,
    pause,
    resume,
    disconnect,
    requestFocusAddress,
    takeFocusAddressPending
  }
})
