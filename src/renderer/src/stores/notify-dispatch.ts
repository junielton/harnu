import type { NotifyChannel } from './session-notify'
import { useUiStore } from './ui'
import { playNotificationSound } from '../lib/notification-sound'

/**
 * Everything one fired notification needs, independent of what raised it
 * (a session task-state edge, a usage-limit reset, …).
 */
export interface NotifyDispatchOptions {
  title: string
  body: string
  channel: NotifyChannel
  /** Play the packaged chime? */
  sound: boolean
  /**
   * Correlates an OS-notification click back to a session (`notify:activate`).
   * Pass '' for a notification with no owning session — the click still
   * focuses the window, but `activateSession('')` is a safe no-op select.
   */
  sessionId: string
  toastKind: 'info' | 'success' | 'warning' | 'danger'
  toastAction?: { label: string; handler: () => void }
}

/**
 * Render a notify decision on its channel: native OS notification or in-app
 * toast, with an optional chime. Shared by every notification source so the
 * focus-aware routing lives in exactly one place.
 *
 * Returns false if delivering the notification threw and was swallowed —
 * callers that have a dependent side effect, like remote push, should skip
 * it in that case.
 */
export function dispatchNotification(opts: NotifyDispatchOptions): boolean {
  try {
    if (opts.channel === 'os') {
      window.api.notify({ title: opts.title, body: opts.body, sessionId: opts.sessionId })
    } else {
      useUiStore().pushToast({
        title: opts.title,
        description: opts.body,
        kind: opts.toastKind,
        action: opts.toastAction,
        // BUG-49: without this, every persisted "Session completed" /
        // "Needs your input" row loses its sessionId and the Activity bell
        // can't navigate — clicking it just dismisses, having done nothing.
        sessionId: opts.sessionId
      })
    }
    if (opts.sound) playNotificationSound()
    return true
  } catch {
    // A transient IPC failure (bridge torn down mid-reload) must never
    // escape the caller — swallow, consistent with the rest of the notify
    // pipeline.
    return false
  }
}
