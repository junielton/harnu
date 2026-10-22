/**
 * Whether a pane's CURRENT document has booted its guest preload (T569 delta 1, F3). Pure.
 *
 * `browser_set_data` pushes the new state to the page, and the old rule ("skip a pane that is still loading")
 * lost a `set_data` made right after `browser_open`: the document had already read the sidecar in its preload but
 * `isLoading()` was still true, so the push was skipped and the page stayed stale until a reload. The preload is
 * the thing that must be listening, so: booted from the moment the preload asks for its data until the next
 * main-frame navigation starts. A push to a document that has NOT booted is harmless: when it does boot it reads
 * the sidecar, which the verb wrote first.
 */
export interface BootTracker {
  /** The preload of the pane's current document asked for its data (so it listens for pushes). */
  markBooted(paneId: string): void
  /** A main-frame navigation started: the previous document is going away, the next has not booted. */
  markNavigating(paneId: string): void
  isBooted(paneId: string): boolean
  forget(paneId: string): void
}

export function createBootTracker(): BootTracker {
  const booted = new Set<string>()
  return {
    markBooted: (id) => void booted.add(id),
    markNavigating: (id) => void booted.delete(id),
    isBooted: (id) => booted.has(id),
    forget: (id) => void booted.delete(id)
  }
}
