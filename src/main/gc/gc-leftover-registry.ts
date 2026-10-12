// The one place a removal that did not go through the cleanup engine tells it what it left in
// Docker. The engine keeps its remembered compose projects in memory and in `gc-left-volumes.json`
// (gc-ipc); a second writer to that file would be overwritten by the engine's copy, so the sidebar's
// own Remove hands its entries to the same writer through this seam. A no-op until the GC service is
// registered, and in tests.

import type { Leftover } from './gc-leftovers'

type Rememberer = (entries: Leftover[]) => void

let remember: Rememberer | null = null

/** gc-ipc registers its writer; pass null to unregister (tests). */
export function setLeftoverRememberer(fn: Rememberer | null): void {
  remember = fn
}

/** Remembers these compose projects as left by a removed folder. A no-op when nobody is listening. */
export function rememberLeftovers(entries: Leftover[]): void {
  if (entries.length > 0) remember?.(entries)
}
