/**
 * BUG-197 (AC-3) — one Activity notice per paused-drain, not one per pass.
 *
 * The manifest drain re-runs on every card write and every session change, and
 * every pass that ends at the WIP ceiling used to toast again. Pure so the
 * "same pause ⇒ no repeat" rule is unit-tested without Pinia or the toast store.
 */

/** What a paused terminal drain tick reports (mirror of `RoadmapDrainEvent.wipPause`). */
export interface WipPauseInfo {
  limit: number
  live: number
  holders: Array<{ slug: string; id: string }>
}

/** Per folder: the signature of the pause the operator was already told about. */
export type WipPauseMemory = Record<string, string>

/** Identity of a pause: the ceiling and WHO holds the slots (order-independent). */
export function wipPauseSignature(p: Pick<WipPauseInfo, 'limit' | 'holders'>): string {
  return `${p.limit}|${p.holders
    .map((h) => h.slug)
    .sort()
    .join(',')}`
}

/**
 * Fold one terminal drain tick into the memory. `pause` is the tick's `wipPause`
 * (absent when nothing was held back). Notify only when the pause is new or its
 * holders changed; forget the folder as soon as a tick reports no pause.
 */
export function wipPauseNotice(
  memory: WipPauseMemory,
  folder: string,
  pause: WipPauseInfo | undefined
): { notify: boolean; memory: WipPauseMemory } {
  if (!pause) {
    if (!(folder in memory)) return { notify: false, memory }
    const next = { ...memory }
    delete next[folder]
    return { notify: false, memory: next }
  }
  const sig = wipPauseSignature(pause)
  if (memory[folder] === sig) return { notify: false, memory }
  return { notify: true, memory: { ...memory, [folder]: sig } }
}
