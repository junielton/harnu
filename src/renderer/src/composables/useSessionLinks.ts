import {
  ref,
  computed,
  watch,
  onScopeDispose,
  getCurrentScope,
  type Ref,
  type ComputedRef
} from 'vue'
import type { FolderLinkGroup, SessionLink } from '../../../preload'

/** How often the pill re-reads the active session's links while visible. */
const POLL_MS = 2000

/** Which list the popover shows: the active session's links, or every session of its folder. */
export type LinksScope = 'session' | 'folder'

// ── Pure helpers (unit-tested in tests/footer-links.test.ts) ─────────────────

/**
 * Write `url` into a session's composer — the Reference action. Goes through the same writer bus the
 * Pasted-images Re-attach uses, with the two differences a URL needs: it is written **as is** (a path
 * is shell-escaped, which would turn a `?` or `&` into `\?` / `\&`), and there is **no newline** (the
 * operator reviews the line and submits it; one trailing space separates back-to-back references).
 * Returns false — writing nothing — when there is no session or it has no live PTY.
 */
export function referenceLink(
  deps: {
    sessionId: string | null
    isLive: (sessionId: string) => boolean
    write: (sessionId: string, data: string) => boolean
  },
  url: string
): boolean {
  const { sessionId } = deps
  if (!sessionId || !deps.isLive(sessionId)) return false
  return deps.write(sessionId, url + ' ')
}

/** `HH:MM` for a link from today, a short date (`Nov 3`) for an older one; '' for a bad timestamp. */
export function formatLinkTime(iso: string, now: Date = new Date()): string {
  const d = new Date(iso)
  if (!iso || Number.isNaN(d.getTime())) return ''
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

/** The host of a link, for the mono secondary text of PR / issue / task rows ('' when unparseable). */
export function linkHost(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

/** Kinds whose label is a raw `host/path` — rendered in mono, with the kind name as the detail line. */
export function isRawLabel(kind: SessionLink['kind']): boolean {
  return kind === 'web' || kind === 'doc'
}

// ── Composable ───────────────────────────────────────────────────────────────

export interface UseSessionLinksOptions {
  /** When provided, the background poll only runs while this is true (a live session). */
  active?: Ref<boolean>
  /** The folder path the Folder scope reads (a lookup key into the sessions main knows). */
  folderPath?: Ref<string | null>
  /** True while the popover shows the Folder scope — only then does the poll also re-read the folder. */
  folderWanted?: Ref<boolean>
  /**
   * Sessions the sidebar hides (archived) — their groups are left out of the Folder scope, like in every
   * other session view. The active session's own group is never hidden.
   */
  isHidden?: (sessionId: string) => boolean
}

/** The Folder scope's groups minus the hidden sessions; `activeId` is always kept. */
export function visibleLinkGroups(
  groups: FolderLinkGroup[],
  isHidden: ((sessionId: string) => boolean) | undefined,
  activeId: string | null
): FolderLinkGroup[] {
  if (!isHidden) return groups
  return groups.filter((g) => g.sessionId === activeId || !isHidden(g.sessionId))
}

/**
 * Reads the links of one session (and, on demand, of its whole folder) from main.
 *
 * The transcript is the only source, so nothing is cached across sessions: every read is fresh, and main
 * keeps a warm incremental fold per transcript (an unchanged one costs a `stat`, a grown one only the
 * appended bytes). A light visibility-gated poll — only for a session that is running, the only kind
 * that can receive a new URL — keeps the count following the transcript, so a URL pasted into the
 * active session shows up within a few seconds, without switching away and back.
 *
 * `uuid` is null when not resolvable (nothing selected, or a synthetic session) → count 0, no IPC.
 */
export function useSessionLinks(
  uuid: Ref<string | null>,
  options: UseSessionLinksOptions = {}
): {
  count: ComputedRef<number>
  entries: Ref<SessionLink[]>
  /** The Folder scope's groups; `null` until the first read for the current folder lands. */
  folderGroups: Ref<FolderLinkGroup[] | null>
  folderCount: ComputedRef<number>
  refresh: () => Promise<void>
  refreshFolder: () => Promise<void>
} {
  const entries = ref<SessionLink[]>([])
  const folderGroups = ref<FolderLinkGroup[] | null>(null)
  const count = computed(() => entries.value.length)
  const folderCount = computed(() => (folderGroups.value ?? []).reduce((n, g) => n + g.count, 0))

  /** Re-read the session's links. Never throws → []; a slow read for a session no longer on screen is dropped. */
  async function refresh(): Promise<void> {
    const id = uuid.value
    if (!id) {
      entries.value = []
      return
    }
    let next: SessionLink[]
    try {
      next = await window.api.sessionLinksList(id)
    } catch {
      if (uuid.value === id) entries.value = []
      return
    }
    if (uuid.value !== id) return
    entries.value = Array.isArray(next) ? next : []
  }

  /** Re-read the Folder scope. Same guards as {@link refresh}, keyed by the folder path. */
  async function refreshFolder(): Promise<void> {
    const path = options.folderPath?.value ?? null
    if (!path) {
      folderGroups.value = null
      return
    }
    let next: FolderLinkGroup[]
    try {
      next = await window.api.sessionLinksFolder(path)
    } catch {
      if (options.folderPath?.value === path) folderGroups.value = []
      return
    }
    if (options.folderPath?.value !== path) return
    folderGroups.value = Array.isArray(next)
      ? visibleLinkGroups(next, options.isHidden, uuid.value)
      : []
  }

  let debounce: ReturnType<typeof setTimeout> | null = null
  function scheduleRefresh(ms: number): void {
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(() => {
      void refresh()
      if (options.folderWanted?.value) void refreshFolder()
    }, ms)
  }

  // A different session (or none) → re-read after a beat, so a fast tab flip doesn't thrash the IPC.
  watch(uuid, () => scheduleRefresh(80), { immediate: true })
  // A different folder invalidates the Folder scope; it is re-read lazily when that scope is shown.
  watch(
    () => options.folderPath?.value ?? null,
    () => {
      folderGroups.value = null
    }
  )

  const poll = setInterval(() => {
    const visible = typeof document === 'undefined' || document.visibilityState === 'visible'
    if (!uuid.value || !visible || (options.active && !options.active.value)) return
    void refresh()
    if (options.folderWanted?.value) void refreshFolder()
  }, POLL_MS)

  if (getCurrentScope()) {
    onScopeDispose(() => {
      if (debounce) clearTimeout(debounce)
      clearInterval(poll)
    })
  }

  return { count, entries, folderGroups, folderCount, refresh, refreshFolder }
}
