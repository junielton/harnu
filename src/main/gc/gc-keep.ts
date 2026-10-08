// Keep marks (design: workspace-gc §3.3): "leave this alone until its fate changes". Pure, so
// the two ways a mark can be lost by accident are unit-tested: recording it against a stale
// cache, and a gather clearing a mark the operator set after that gather began.

import type { WorktreeBundle } from './bundle-core'
import type { GcPrefs } from './gc-prefs'

/** A mark whose branch fate is no longer the one it was made under. */
export interface StaleKeep {
  id: string
  /** The fate stored with the mark, so a newer mark for the same id is never confused with it. */
  marked: string
}

/**
 * Which marks still hold against this gather, and which went stale. A mark for an item the
 * gather does not list is left alone: absence is not a change of fate.
 */
export function judgeKeeps(
  bundles: readonly WorktreeBundle[],
  marks: Readonly<Record<string, string>>
): { keep: Set<string>; stale: StaleKeep[] } {
  const keep = new Set<string>()
  const stale: StaleKeep[] = []
  for (const b of bundles) {
    const marked = marks[b.item.id]
    if (marked === undefined) continue
    if (marked === b.fate.fate) keep.add(b.item.id)
    else stale.push({ id: b.item.id, marked })
  }
  return { keep, stale }
}

/**
 * Drops the stale marks, but only where the mark is still the one that was judged. A gather
 * takes time: if the operator pressed Keep again meanwhile, that newer mark carries the
 * current fate and must survive this gather's verdict on the old one.
 */
export function withoutStaleKeeps(prefs: GcPrefs, stale: readonly StaleKeep[]): GcPrefs {
  const keep = { ...prefs.keep }
  for (const { id, marked } of stale) if (keep[id] === marked) delete keep[id]
  return { ...prefs, keep }
}

/**
 * The prefs with a Keep recorded against the fate in a FRESH gather. The caller must pass
 * bundles gathered after the click: a fate recorded from an older cache would be judged stale
 * by the very next gather and the mark dropped. Null when the item is not in the gather.
 */
export function keepFromFresh(
  prefs: GcPrefs,
  fresh: readonly WorktreeBundle[],
  id: string
): GcPrefs | null {
  const bundle = fresh.find((b) => b.item.id === id)
  return bundle ? { ...prefs, keep: { ...prefs.keep, [id]: bundle.fate.fate } } : null
}
