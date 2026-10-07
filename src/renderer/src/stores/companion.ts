import { defineStore } from 'pinia'
import { nextTick, ref } from 'vue'
import { i18n } from '../i18n'
import { unloadedNotices } from '../lib/companion-view'
import { sessionTitle } from '../lib/session-label'
import { useSessionsStore } from './sessions'
import { useUiStore } from './ui'
import type { CompanionStatus } from '../../../main/companion/companion-status'
import type { CompanionState } from '../../../main/companion/companion-state-core'

/**
 * The Harnu mod state the surfaces read (T389 P1W4 §7.6). Main derives everything (the state of
 * each row, who owns each family, the kill switch); this store only mirrors the last
 * `companionStatus()` and re-reads it when main says something changed. It also owns the two
 * toasts of §10: the one-time disclosure and the "unloaded" notice.
 *
 * Every `window.api` call is optional-chained: an older preload (and every test double of
 * `window.api`) has none of these channels, and the surfaces simply show no line.
 */
export const useCompanionStore = defineStore('companion', () => {
  const status = ref<CompanionStatus | null>(null)
  const notified = new Set<string>()
  let off: (() => void) | null = null
  let started = false
  let disclosed = false

  function t(key: string, params?: Record<string, unknown>): string {
    return i18n.global.t(key, params ?? {}) as string
  }

  /** The state line of a row, or null: the hover preview and the System Monitor read this. */
  function stateFor(sessionKey: string | null | undefined): CompanionState | null {
    if (!sessionKey) return null
    return status.value?.sessions[sessionKey]?.state ?? null
  }

  async function refresh(): Promise<void> {
    const next = (await window.api.companionStatus?.().catch(() => null)) ?? null
    if (!next) return
    const prev = status.value
    status.value = next
    maybeDisclose(next)
    for (const key of unloadedNotices(prev, next, notified)) {
      notified.add(key)
      const sessions = useSessionsStore()
      const s = sessions.allSessions.find((x) => x.sessionId === key)
      useUiStore().pushToast({
        kind: 'warning',
        title: t('harnuMod.toast.unloaded', {
          session: s ? sessionTitle(s, sessions.allSessions, i18n.global.t) : key
        }),
        sessionId: key
      })
    }
  }

  /**
   * The one-time notice (§10): a sticky `info` toast with an action, pushed while the kill switch
   * is on and the notice was never shown. Mounting it stamps it as shown, and sessions spawned
   * after that carry the mod. Nobody is asked to click: it is a notice, not a prompt (ARB-6e).
   */
  function maybeDisclose(s: CompanionStatus): void {
    if (disclosed || !s.enabled || s.disclosureShownAt !== null) return
    disclosed = true
    const ui = useUiStore()
    ui.pushToast({
      kind: 'info',
      title: t('harnuMod.toast.disclosure.title'),
      description: t('harnuMod.toast.disclosure.body'),
      timeoutMs: 0,
      action: {
        label: t('harnuMod.toast.openSettings'),
        handler: () => {
          ui.openSettings('general')
          void nextTick(() =>
            requestAnimationFrame(() =>
              document.getElementById('set-companion')?.scrollIntoView({ block: 'nearest' })
            )
          )
        }
      }
    })
    void window.api.companionDisclosureShown?.()
  }

  async function init(): Promise<void> {
    if (started) return
    started = true
    off = window.api.onCompanionUpdated?.(() => void refresh()) ?? null
    await refresh()
  }

  async function setEnabled(on: boolean): Promise<void> {
    await window.api.companionSetEnabled?.(on)
    await refresh()
  }

  function reveal(): void {
    void window.api.companionReveal?.()
  }

  function dispose(): void {
    off?.()
    off = null
    started = false
  }

  return { status, stateFor, refresh, init, setEnabled, reveal, dispose }
})
