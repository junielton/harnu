import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { persistedRef } from './persisted'
import type { ClaudeStatusSnapshot, Severity } from '../../../preload'

/**
 * Claude service-status store (issue #17). Thin reactive mirror of the main
 * poller's {@link ClaudeStatusSnapshot} (parsing/folding/transition decisions
 * all live in main — `claude-status-parse.ts`, unit-tested). Backs the footer
 * health dot + the incident panel, and owns the local notification mute.
 */

/** localStorage key for the service-status notification mute. Default ON. */
const NOTIFY_KEY = 'om2tab.claudeStatusNotify'

export const useClaudeStatusStore = defineStore('claudeStatus', () => {
  const snapshot = ref<ClaudeStatusSnapshot | null>(null)
  // Default ON: only an explicit 'false' disables (the inverted-default case).
  const notifyEnabled = persistedRef(NOTIFY_KEY, true, {
    serialize: String,
    deserialize: (raw) => raw !== 'false'
  })
  /** Bumped when a clicked OS alert asks the footer to open the panel. */
  const openSignal = ref(0)

  let started = false
  let unsubscribeUpdated: (() => void) | null = null
  let unsubscribeActivate: (() => void) | null = null

  /** Headline severity (drives the footer dot color); `unknown` until first fetch. */
  const severity = computed<Severity>(() => snapshot.value?.severity ?? 'unknown')
  const description = computed<string>(() => snapshot.value?.description ?? '')
  const components = computed(() => snapshot.value?.components ?? [])
  const incidents = computed(() => snapshot.value?.incidents ?? [])
  const maintenances = computed(() => snapshot.value?.maintenances ?? [])
  const hasIncidents = computed(() => incidents.value.length > 0)
  const stale = computed<boolean>(() => snapshot.value?.stale ?? false)

  async function init(): Promise<void> {
    if (started) return
    started = true
    // Push the current mute to main before the first poll can fire an alert.
    void window.api.claudeStatusSetNotify(notifyEnabled.value)
    // Subscribe first so the post-load push isn't missed, then seed.
    unsubscribeUpdated = window.api.onClaudeStatusUpdated((s) => {
      snapshot.value = s
    })
    unsubscribeActivate = window.api.onClaudeStatusActivate(() => {
      openSignal.value++
    })
    snapshot.value = await window.api.claudeStatusGet()
  }

  function refresh(): Promise<ClaudeStatusSnapshot> {
    return window.api.claudeStatusRefresh()
  }

  function openHistory(): void {
    void window.api.claudeStatusHistoryUrl().then((url) => {
      if (url) window.open(url, '_blank')
    })
  }

  function setNotifyEnabled(enabled: boolean): void {
    // persistedRef's watch mirrors this to localStorage; still push to main.
    notifyEnabled.value = enabled
    void window.api.claudeStatusSetNotify(enabled)
  }

  function dispose(): void {
    unsubscribeUpdated?.()
    unsubscribeActivate?.()
    unsubscribeUpdated = null
    unsubscribeActivate = null
    started = false
  }

  return {
    snapshot,
    notifyEnabled,
    openSignal,
    severity,
    description,
    components,
    incidents,
    maintenances,
    hasIncidents,
    stale,
    init,
    refresh,
    openHistory,
    setNotifyEnabled,
    dispose
  }
})
