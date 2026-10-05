import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { MemoryPaneData } from '../../../preload'

/**
 * Project-memory data cache (T79 S3). A thin shared cache over the confined
 * `memory:read` IPC so BOTH the folder-hover cue (`FolderPreview`) and the
 * Memory pane (`MemoryPane`) read a repo's memory without re-probing on every
 * hover — keeping the read OFF the sidebar hot path (the T52 precedent: probe on
 * open, cache, degrade to nothing on failure).
 *
 * Keyed by the folder path the UI addresses (main resolves it to the repo's
 * shared `.harnu/memory/`). A short TTL means a pane that stays open picks up a
 * hand-edited memory on its next explicit reload / re-hover; the pane's reload
 * button forces a bypass.
 */

/** How long a cached read stays fresh before the next `load` re-probes. */
const TTL_MS = 15_000

export const useMemoryStore = defineStore('memory', () => {
  /**
   * Folder path → last-read bundle. Replace the ref (`cache.value = new Map(...)`)
   * on write so Vue reactivity fires for template consumers (same discipline as
   * `byWorktree` in the helpers store).
   */
  const cache = ref<Map<string, MemoryPaneData>>(new Map())

  // Non-reactive bookkeeping (freshness stamps + in-flight dedup) — never drives
  // a template, so it stays off the reactive graph.
  const stamps = new Map<string, number>()
  const inflight = new Map<string, Promise<MemoryPaneData | null>>()

  /** Synchronous cache peek — the value already loaded for `folder`, or `null`. */
  function peek(folder: string): MemoryPaneData | null {
    return cache.value.get(folder) ?? null
  }

  /**
   * Load (or return the cached) memory bundle for `folder`. A fresh cache hit
   * (within {@link TTL_MS}) returns immediately; concurrent callers share one
   * in-flight request. `force` bypasses both — the pane's reload button uses it
   * to pick up hand-edits. A denied/failed read resolves to `null` (the UI shows
   * an empty/steer state) and is NOT cached, so the next attempt retries.
   */
  async function load(folder: string, opts?: { force?: boolean }): Promise<MemoryPaneData | null> {
    if (!folder) return null
    if (!opts?.force) {
      const cached = cache.value.get(folder)
      const at = stamps.get(folder) ?? 0
      if (cached && Date.now() - at < TTL_MS) return cached
      const pending = inflight.get(folder)
      if (pending) return pending
    }

    const req = (async (): Promise<MemoryPaneData | null> => {
      try {
        const res = await window.api.memoryRead(folder)
        if (res.ok) {
          const next = new Map(cache.value)
          next.set(folder, res.data)
          cache.value = next
          stamps.set(folder, Date.now())
          return res.data
        }
        return null
      } catch {
        return null
      } finally {
        inflight.delete(folder)
      }
    })()

    inflight.set(folder, req)
    return req
  }

  /** Drop a folder's cached bundle so the next `load` re-probes (e.g. on write). */
  function invalidate(folder: string): void {
    stamps.delete(folder)
    inflight.delete(folder)
    if (!cache.value.has(folder)) return
    const next = new Map(cache.value)
    next.delete(folder)
    cache.value = next
  }

  return { cache, peek, load, invalidate }
})
