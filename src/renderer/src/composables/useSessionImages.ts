import {
  ref,
  computed,
  watch,
  onScopeDispose,
  getCurrentScope,
  type Ref,
  type ComputedRef
} from 'vue'
import type { ImageEntry } from '../../../preload'

/** An image-cache entry with its base64 data-URL filled in lazily on open. */
export type SessionImage = ImageEntry & { dataUrl?: string }

/** How often the pill re-lists the active session's images while visible. */
const POLL_MS = 2000

/**
 * Orchestrates the Pasted-images list/read for one session's UUID.
 *
 * Ephemeral by design (lesson reactivity/001): always re-lists from disk and
 * never caches across sessions — `image-cache` is a live cache Claude Code
 * prunes, not an archive. `loadThumbs` is lazy (on popover open) since the count
 * comes from the cheap `list` alone.
 *
 * Reactivity: Claude writes a pasted PNG into `image-cache/<uuid>/` at paste
 * time — there's no transcript event we already watch for it — so a light,
 * visibility-gated poll keeps the pill live without a switch-away/back. The poll
 * does a cheap readdir only; `refresh` PRESERVES already-loaded data-URLs by
 * name, so a re-list never reloads or flickers thumbnails in an open popover.
 *
 * `uuid` is null when not resolvable (no selection, or a synthetic session
 * without a real UUID yet) → count 0, no IPC.
 */
export function useSessionImages(
  uuid: Ref<string | null>,
  /** When provided, the background poll only runs while this is true (e.g. the
   *  session has a live PTY — only a running session can receive a new paste). */
  active?: Ref<boolean>
): {
  count: ComputedRef<number>
  entries: Ref<SessionImage[]>
  refresh: () => Promise<void>
  loadThumbs: () => Promise<void>
  clearThumbs: () => void
} {
  const entries = ref<SessionImage[]>([])
  // Which uuid `entries` currently holds — data-URLs may ONLY be carried over a
  // re-list within the SAME session (filenames are session-local, e.g. every
  // session has its own `1.png`, so names collide across sessions).
  let entriesUuid: string | null = null
  const count = computed(() => entries.value.length)

  /**
   * Re-list the session's images (count + metadata). Never throws → []. Carries
   * over any data-URL already loaded for a still-present name so a poll doesn't
   * reload thumbnails; a newly-appeared image gets no data-URL (shimmer) until
   * the next `loadThumbs`.
   */
  async function refresh(): Promise<void> {
    const id = uuid.value
    if (!id) {
      entries.value = []
      entriesUuid = null
      return
    }
    let next: ImageEntry[]
    try {
      next = await window.api.imageCacheList(id)
    } catch {
      // Only clear if we're still on the session we listed for.
      if (uuid.value === id) {
        entries.value = []
        entriesUuid = id
      }
      return
    }
    // Stale guard: the session changed during the await — drop this result so a
    // slow list for the old session can't clobber the newly-selected one.
    if (uuid.value !== id) return
    // Carry over already-loaded data-URLs ONLY within the same session (avoids
    // showing session A's `1.png` thumbnail under session B's `1.png`).
    const loaded =
      entriesUuid === id ? new Map(entries.value.map((e) => [e.name, e.dataUrl])) : null
    entries.value = next.map((e) => ({ ...e, dataUrl: loaded?.get(e.name) }))
    entriesUuid = id
  }

  /**
   * Drop loaded base64 data-URLs (free memory) while keeping the metadata/count.
   * Called when the popover closes — a big gallery holds tens of MB of base64,
   * and there's no reason to keep it resident when nothing is showing it.
   * `loadThumbs` re-reads on the next open.
   */
  function clearThumbs(): void {
    if (entries.value.some((e) => e.dataUrl)) {
      entries.value = entries.value.map((e) => ({ ...e, dataUrl: undefined }))
    }
  }

  /** Fill the base64 data-URL for each entry that doesn't have one yet. */
  async function loadThumbs(): Promise<void> {
    const id = uuid.value
    if (!id) return
    await Promise.all(
      entries.value.map(async (e) => {
        if (e.dataUrl) return
        try {
          e.dataUrl = await window.api.imageCacheRead(id, e.name)
        } catch {
          // A file pruned between list and read just stays a shimmer — never throws.
        }
      })
    )
  }

  // Light debounce on the UUID watcher: readdir is cheap, but a fast tab flip
  // shouldn't thrash the IPC. `refresh` stays directly awaitable (popover open).
  let debounce: ReturnType<typeof setTimeout> | null = null
  watch(
    uuid,
    () => {
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => void refresh(), 80)
    },
    { immediate: true }
  )

  // Visibility-gated poll so a paste into the CURRENT session updates the pill
  // without a switch-away/back. Follows `uuid.value` each tick (one interval),
  // and — when an `active` gate is given — only runs for a session that can
  // actually receive a paste (a live PTY), so dormant sessions don't poll.
  const poll = setInterval(() => {
    const visible = typeof document === 'undefined' || document.visibilityState === 'visible'
    if (uuid.value && visible && (!active || active.value)) {
      void refresh()
    }
  }, POLL_MS)

  if (getCurrentScope()) {
    onScopeDispose(() => {
      if (debounce) clearTimeout(debounce)
      clearInterval(poll)
    })
  }

  return { count, entries, refresh, loadThumbs, clearThumbs }
}
