import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { RoadmapDrainEvent } from '../../../preload'
import { i18n } from '../i18n'
import { useUiStore } from './ui'

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
    if (e.wipBlocked > 0) {
      useUiStore().pushToast({
        kind: 'info',
        title: i18n.global.t('roadmap.manifest.wipPaused', {
          folder: folderName,
          count: e.wipBlocked
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

  return { batches, handleEvent, wire }
})
