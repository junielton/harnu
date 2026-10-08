// The seam between the MCP verbs and the GC service (design: workspace-gc §10). The agent only
// ever gets this narrow interface: read the snapshot, mark a bundle released. There is no
// clean, keep or prefs method on it, so no verb built on it can remove anything (T445).
// Type-only imports, no electron: the MCP handlers import this, never `gc-ipc`.

import type { GcSnapshot } from './gc-wire'

export interface GcAgentService {
  /** The last gather, or a fresh one with `refresh`. */
  snapshot(opts?: { refresh?: boolean }): Promise<GcSnapshot>
  /**
   * Records that an agent is done with the bundle, and where the worktree is so a later gather
   * can tell it was cleaned. Deletes nothing.
   */
  release(
    bundleId: string,
    atMs: number,
    from: { repoPath: string; path: string; localTip: string }
  ): Promise<void>
}

let service: GcAgentService | null = null

/** The registered service, or null before the GC handlers start. */
export function getGcService(): GcAgentService | null {
  return service
}

export function setGcService(next: GcAgentService | null): void {
  service = next
}
