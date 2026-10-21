import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { RoadmapDrainEvent } from '../../../preload'
import { i18n } from '../i18n'
import { useUiStore } from './ui'
import { wipPauseNotice, type WipPauseInfo, type WipPauseMemory } from '../lib/wip-pause'

/**
 * T113 — renderer-side VIEW of the background manifest drain. The drain DRIVER
 * lives in main (`manifest-drain.ts`); this store only mirrors its
 * `roadmap:drainEvent` progress ticks so (a) the Roadmap board's batch strip
 * renders live counts for its folder, and (b) the confirm-needed summary toast
 * fires app-wide — with or without the board open (the whole point of T113).
 */
export const useRoadmapDrainStore = defineStore('roadmap-drain', () => {
  /** Latest ACTIVE pass per folder; entries clear on the terminal tick. */
  const batches = ref<Record<string, RoadmapDrainEvent>>({})
  /**
   * BUG-197: the pause the drain last reported per folder (the ceiling, the live
   * count, the live cards holding the slots) — the board's WIP chip reads it for its
   * "paused" state. Cleared when a tick reports no pause or a slot frees.
   */
  const wipPauses = ref<Record<string, WipPauseInfo>>({})
  /** BUG-197: which pause the operator was already told about, per folder (no repeats). */
  let pauseMemory: WipPauseMemory = {}

  /** The slots freed or nothing waits: forget the pause so the next one notifies again. */
  function clearWipPause(folder: string): void {
    if (folder in wipPauses.value) {
      const next = { ...wipPauses.value }
      delete next[folder]
      wipPauses.value = next
    }
    pauseMemory = wipPauseNotice(pauseMemory, folder, undefined).memory
  }

  function handleEvent(e: RoadmapDrainEvent): void {
    if (!e || typeof e.folder !== 'string') return
    if (!Array.isArray(e.confirmCards)) e = { ...e, confirmCards: [], wipBlocked: 0 }
    if (!Array.isArray(e.failedCards)) e = { ...e, failedCards: [], failed: 0 }
    if (e.active) {
      batches.value = { ...batches.value, [e.folder]: e }
      return
    }
    // Terminal tick: drop the strip; surface WHAT fell back and WHY (BUG-43 —
    // a fallback must be attributable, never a context-free count), plus a
    // visible WIP pause so a full ceiling is never silent.
    const next = { ...batches.value }
    delete next[e.folder]
    batches.value = next
    const folderName = e.folder.split('/').filter(Boolean).pop() ?? e.folder
    // T163: clicking the persisted row opens this drain's roadmap board — the
    // whole reason each toast tells the operator to "click Dispatch".
    const target = { view: 'roadmap' as const, folderPath: e.folder }
    if (e.confirmNeeded > 0) {
      const reasons = [...new Set(e.confirmCards.map((c) => c.reason))].join(', ')
      const cards = e.confirmCards.map((c) => c.slug).join(', ')
      useUiStore().pushToast({
        kind: 'warning',
        title: i18n.global.t('roadmap.manifest.needsConfirm', {
          folder: folderName,
          cards,
          reasons
        }),
        target
      })
    }
    // BUG-62: a stamped card whose dispatch fails (worktree already rolled
    // back by the drain itself) must be just as visible as a confirm fallback
    // — distinct wording since there is nothing to "click Dispatch" on: the
    // operator has to fix the cause and resubmit the manifest.
    if (e.failed > 0) {
      const reasons = [...new Set(e.failedCards.map((c) => c.reason))].join(', ')
      const cards = e.failedCards.map((c) => c.slug).join(', ')
      useUiStore().pushToast({
        kind: 'danger',
        title: i18n.global.t('roadmap.manifest.spawnFailed', {
          folder: folderName,
          cards,
          reasons
        }),
        target
      })
    }
    // BUG-197: ONE notice per pause — naming the ceiling, the live count and the
    // cards holding the slots — and the board chip's paused state. The same pause
    // (same ceiling, same holders) never notifies twice, however many passes re-hit it.
    const pause = e.wipBlocked > 0 ? e.wipPause : undefined
    const folded = wipPauseNotice(pauseMemory, e.folder, pause)
    pauseMemory = folded.memory
    if (pause) {
      wipPauses.value = { ...wipPauses.value, [e.folder]: pause }
    } else {
      const rest = { ...wipPauses.value }
      delete rest[e.folder]
      wipPauses.value = rest
    }
    if (folded.notify && pause) {
      useUiStore().pushToast({
        kind: 'warning',
        title: i18n.global.t('roadmap.manifest.wipPaused', {
          folder: folderName,
          live: pause.live,
          limit: pause.limit,
          cards: pause.holders.map((h) => h.id).join(', ')
        }),
        target
      })
    }
  }

  /** Subscribe to main's drain events; returns the unsubscribe disposer. */
  function wire(): () => void {
    const sub = window.api?.onRoadmapDrainEvent
    if (typeof sub !== 'function') return () => {}
    return sub((payload) => handleEvent(payload))
  }

  return { batches, wipPauses, clearWipPause, handleEvent, wire }
})
