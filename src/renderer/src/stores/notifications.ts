import { defineStore } from 'pinia'
import { computed } from 'vue'
import { persistedRef } from './persisted'
import type { NavigableViewId, NavTargetParams } from './ui'

const STORAGE_KEY = 'om2tab.notifications'

/** Ring-buffer caps (PRD T83 §4.4): count first, then age. Whichever trims more wins. */
export const NOTIFICATIONS_MAX_COUNT = 200
export const NOTIFICATIONS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

/**
 * Governs grouping/filter/icon (T83 S3). `'agent'` (T116) is distinct from
 * `'session'` — the latter is a Harnu-authored notice ABOUT a session (e.g. a
 * hook edge); `'agent'` is a notice a session's own MCP `notify` call AUTHORED
 * itself, rendered as "Session says" in the Activity bell (Topbar).
 */
export type NotificationSource =
  'session' | 'status' | 'changelog' | 'approval' | 'push' | 'app' | 'agent'

/** Mirrors `Toast['kind']` (`stores/ui.ts`) — same four semantics, same border-color map. */
export type NotificationKind = 'info' | 'success' | 'warning' | 'danger'

/**
 * A re-offered toast action, label only. Unlike `ToastAction` (`stores/ui.ts`) this
 * carries no `handler` — a `NotificationRecord` is a plain, `localStorage`-persisted
 * value, and S1 is read-only display (no click-to-fire); wiring the action back up
 * is S2+ scope.
 */
export interface NotificationAction {
  label: string
}

/**
 * Where a row's click should navigate when there's no `sessionId` (T163) — a
 * view-targeted destination instead of a session-targeted one. Kept as a
 * plain, serializable descriptor (an id + optional params), never a stored
 * callback, for the same `localStorage`-persistence reason `NotificationAction`
 * is label-only. Resolved by `useUiStore().openNavigableView()`.
 */
export type NotificationTarget = { view: NavigableViewId } & NavTargetParams

/**
 * One subject row of a grouped entry (BUG-173) — e.g. one owed mission inside
 * the single `'mission-cue'` record. Optional on `NotificationRecord`, so every
 * record persisted before this type existed stays valid. `title`/`description`
 * are already localized at the call-site, same discipline as the record itself.
 */
export interface NotificationItem {
  /** Stable subject id — the mission id for mission rows. */
  id: string
  title: string
  description?: string
  /** Owner session, when known — the row opens it. */
  sessionId?: string
  /** View-targeted twin of `sessionId` (T163); for a mission row `{ view: 'mission', missionId }`. */
  target?: NotificationTarget
}

/**
 * A single entry in the notification history (T83 S1, PRD §4.1). `title`/
 * `description` are already localized at the call-site — this store never
 * interprets them, same discipline as `Toast` (`stores/ui.ts`).
 */
export interface NotificationRecord {
  id: string
  ts: number
  source: NotificationSource
  kind: NotificationKind
  title: string
  description?: string
  sessionId?: string
  folderPath?: string
  notificationType?: string
  action?: NotificationAction
  /** View-targeted twin of `sessionId` (T163) — see `NotificationTarget`. */
  target?: NotificationTarget
  /** Upsert key: at most one record per group (BUG-173) — see `notify()`. */
  group?: string
  /** Per-subject rows for a grouped entry; absent on every pre-existing record. */
  items?: NotificationItem[]
}

/** What a caller supplies to `notify()` — `id` is assigned by the store. A
 *  persisted buffer from before T152 may still carry a stale `read` field on
 *  disk; it's simply ignored on load since `NotificationRecord` no longer
 *  declares it. */
export type NewNotification = Omit<NotificationRecord, 'id'>

/**
 * Notification history store (T83 S1) — the passive sink `stores/ui.ts` `pushToast`
 * funnels every durable toast through, so a toast that auto-dismisses in 6s still
 * leaves a row here. Persisted to `localStorage` (same pattern as `theme`/`layout`)
 * as a ring buffer capped by both count and age (PRD §4.4); a main-side store is
 * deferred (v2) unless cross-reload/cross-window durability proves necessary.
 *
 * `notify()` only records — it never plays a sound, requests OS attention, or
 * pushes a toast itself. Those already fire at their own emit sites; this store
 * is strictly the history sink the PRD's §2 "one source, many sinks" describes.
 */
export const useNotificationsStore = defineStore('notifications', () => {
  const records = persistedRef<NotificationRecord[]>(STORAGE_KEY, [])

  /**
   * Drop entries past the age cap, then keep only the `NOTIFICATIONS_MAX_COUNT`
   * most recent by `ts` — sorted explicitly rather than trusting insertion
   * order, since `notify()` always unshifts regardless of the `ts` it's given.
   */
  function prune(list: NotificationRecord[]): NotificationRecord[] {
    const cutoff = Date.now() - NOTIFICATIONS_MAX_AGE_MS
    return list
      .filter((r) => r.ts >= cutoff)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, NOTIFICATIONS_MAX_COUNT)
  }

  // Prune a stale buffer once at load — a 7-day-old row shouldn't linger just
  // because nothing has notified since the window was last open. Only reassign
  // (and thus persist) when pruning actually changed something.
  const loadedPruned = prune(records.value)
  if (loadedPruned.length !== records.value.length) records.value = loadedPruned

  /** Most-recent-first — the Activity bell's display order (PRD §4.5). */
  const list = computed(() => [...records.value].sort((a, b) => b.ts - a.ts))

  /**
   * Record a notification, pruning to the count/age caps. Without a `group` it
   * always appends, unconditionally — a future pause (S4) may suppress emit-time
   * sound/toast, never this write. With a `group` it is an upsert (BUG-173): the
   * first call appends; later calls replace `ts/kind/title/description/sessionId/
   * target/items` of the record holding that group in place, keeping its `id`
   * (so the bell's row state survives) and not growing the list. A dismissed
   * group entry is simply gone, so the next call appends a fresh one.
   */
  function notify(entry: NewNotification): NotificationRecord {
    const existing = entry.group ? records.value.find((r) => r.group === entry.group) : undefined
    if (existing) {
      const updated: NotificationRecord = {
        ...existing,
        ts: entry.ts,
        kind: entry.kind,
        title: entry.title,
        description: entry.description,
        sessionId: entry.sessionId,
        target: entry.target,
        items: entry.items
      }
      records.value = prune(records.value.map((r) => (r === existing ? updated : r)))
      return updated
    }
    const record: NotificationRecord = { id: crypto.randomUUID(), ...entry }
    records.value = prune([record, ...records.value])
    return record
  }

  /**
   * Remove one record (T152) — replaces `markRead`. The Activity bell has no
   * read/unread state: being in the list IS the "not yet handled" signal, so
   * the only two actions are dismissing a single row or clearing the lot.
   */
  function dismiss(id: string): void {
    records.value = records.value.filter((r) => r.id !== id)
  }

  /**
   * Quietly rewrite the record holding `group` (BUG-173 quiet sync): applies
   * `patch` in place, keeping `id` and `ts` — no new "news", no resurrection.
   * Returns `null` and writes nothing when no record holds the group (it was
   * dismissed, aged out or never posted), so a sync can never bring back an
   * entry the operator removed.
   */
  function updateGroup(
    group: string,
    patch: Partial<
      Pick<NotificationRecord, 'kind' | 'title' | 'description' | 'sessionId' | 'target' | 'items'>
    >
  ): NotificationRecord | null {
    const existing = records.value.find((r) => r.group === group)
    if (!existing) return null
    const updated: NotificationRecord = { ...existing, ...patch, id: existing.id, ts: existing.ts }
    records.value = records.value.map((r) => (r === existing ? updated : r))
    return updated
  }

  /** Remove the record holding `group`; `true` when one was removed. */
  function removeGroup(group: string): boolean {
    const had = records.value.some((r) => r.group === group)
    if (had) records.value = records.value.filter((r) => r.group !== group)
    return had
  }

  /** Remove every record (T152) — the popover's "Clear all". */
  function clearAll(): void {
    records.value = []
  }

  return { records, list, notify, updateGroup, removeGroup, dismiss, clearAll }
})
