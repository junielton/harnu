import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { ClaudeChangelogState, ClaudeRelease } from '../../../preload'
import { playNotificationSound } from '../lib/notification-sound'
import { useSessionsStore } from './sessions'

/**
 * Claude Code changelog watcher (spec 2026-06-18). Holds the release list the
 * main process fetches from GitHub, derives the unread state that lights the
 * Settings-gear dot, and exposes the mark-read / refresh / open-external bridges.
 *
 * The unread formula mirrors the canonical `unreadCount` in
 * `src/main/claude-changelog-state.ts` (count of releases above `lastReadVersion`).
 */
export const useClaudeChangelogStore = defineStore('claudeChangelog', () => {
  const releases = ref<ClaudeRelease[]>([])
  const lastReadVersion = ref('')
  const lastFetchedAt = ref(0)

  const unreadCount = computed(() => {
    const idx = releases.value.findIndex((r) => r.version === lastReadVersion.value)
    return idx === -1 ? releases.value.length : idx
  })
  const hasUnread = computed(() => unreadCount.value > 0)

  function apply(s: ClaudeChangelogState): void {
    releases.value = s.releases
    lastReadVersion.value = s.lastReadVersion
    lastFetchedAt.value = s.lastFetchedAt
  }

  let unsubscribe: (() => void) | null = null
  let unsubscribeNewVersion: (() => void) | null = null
  function dispose(): void {
    unsubscribe?.()
    unsubscribe = null
    unsubscribeNewVersion?.()
    unsubscribeNewVersion = null
  }
  async function init(): Promise<void> {
    // Subscribe first so the post-load push from main isn't missed, then pull
    // the current cached state for an instant first paint.
    dispose() // clean up any prior subscription before resubscribing (remount/HMR safe)
    unsubscribe = window.api.onClaudeChangelogUpdated(apply)
    // A newly detected version plays the notification sound (if enabled),
    // mirroring the session path. The sound pref lives in the sessions store;
    // read it lazily at event time.
    unsubscribeNewVersion = window.api.onClaudeChangelogNewVersion(() => {
      if (useSessionsStore().notifyPrefs.sound) playNotificationSound()
    })
    apply(await window.api.claudeChangelogGet())
  }

  async function markRead(): Promise<void> {
    // Optimistic: advance the marker locally so the dot clears immediately.
    lastReadVersion.value = releases.value[0]?.version ?? lastReadVersion.value
    await window.api.claudeChangelogMarkRead()
  }
  function refresh(): Promise<void> {
    return window.api.claudeChangelogRefresh()
  }
  function openExternal(): Promise<void> {
    return window.api.claudeChangelogOpenExternal()
  }

  return {
    releases,
    lastReadVersion,
    lastFetchedAt,
    unreadCount,
    hasUnread,
    apply,
    init,
    dispose,
    markRead,
    refresh,
    openExternal
  }
})
