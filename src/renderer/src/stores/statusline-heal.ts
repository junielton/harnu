import { defineStore } from 'pinia'
import { i18n } from '../i18n'
import { sessionTitle } from '../lib/session-label'
import { formatHealNotice, HEAL_NOTICE_GROUP } from '../lib/statusline-heal-notice'
import { useNotificationsStore } from './notifications'
import { useSessionsStore } from './sessions'

/**
 * Posts the Activity notice for a statusLine self-heal (BUG-196 AC-4). Main decides when — once per
 * heal, de-duplicated in `statusline-heal-core.ts` — and sends the keys of the sessions whose
 * `claude` started before the heal; this resolves their titles and words the entry. It is one
 * grouped entry, so a later heal updates it in place instead of piling up in the bell.
 */
export const useStatuslineHealStore = defineStore('statuslineHeal', () => {
  let unsubscribe: (() => void) | null = null

  function init(): void {
    if (unsubscribe) return
    unsubscribe = window.api.onStatuslineHealed(({ atMs, sessionKeys }) => {
      const { t } = i18n.global
      const sessions = useSessionsStore()
      const titles = sessionKeys.map((key) => {
        const s = sessions.allSessions.find((x) => x.sessionId === key)
        return (s && sessionTitle(s, sessions.allSessions, t)) || key.slice(0, 8)
      })
      const time = new Date(atMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      const { title, description } = formatHealNotice({ time, titles }, (key, params) =>
        t(key, params ?? {})
      )
      useNotificationsStore().notify({
        ts: Date.now(),
        source: 'app',
        kind: 'warning',
        title,
        description,
        group: HEAL_NOTICE_GROUP
      })
    })
  }

  function dispose(): void {
    unsubscribe?.()
    unsubscribe = null
  }

  return { init, dispose }
})
