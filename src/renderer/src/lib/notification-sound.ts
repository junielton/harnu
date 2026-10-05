import notifyUrl from '../assets/notify.wav?url'

/**
 * Play the bundled OS-notification sound (notification-sound spec §4.2).
 *
 * A lazy singleton `HTMLAudioElement` decodes the bundled `notify.wav` once and
 * is replayed on each call (`currentTime = 0`). Callers own the decision to play
 * (pref gating lives at the call sites — `sessions.maybeNotify` and the
 * `claudeChangelog` new-version handler); this only emits the sound.
 *
 * Never throws: a rejected `play()` (browser autoplay policy, or a headless /
 * no-audio environment such as CI) is swallowed.
 */
let el: HTMLAudioElement | null = null

export function playNotificationSound(): void {
  try {
    if (!el) el = new Audio(notifyUrl)
    el.currentTime = 0
    void el.play().catch(() => {})
  } catch {
    /* no Audio constructor / no output device — nothing to do */
  }
}
