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
export function withoutStaleKeeps(
  prefs: GcPrefs,
  stale: readonly StaleKeep[],
  /** Ids this verdict must not touch: see {@link protectedFromGather}. */
  protect: ReadonlySet<string> = new Set()
): GcPrefs {
  const keep = { ...prefs.keep }
  for (const { id, marked } of stale) if (keep[id] === marked && !protect.has(id)) delete keep[id]
  return { ...prefs, keep }
}

/**
 * The marks a gather's verdict must leave alone. It judged the prefs as they were when it
 * started, so a mark written at or after that moment is newer than the verdict, and a
 * provisional mark (written at once on a click, its fate still to be confirmed by a fresh
 * gather) is not yet a mark that could be stale.
 */
export function protectedFromGather(
  writtenAt: ReadonlyMap<string, number>,
  provisional: ReadonlySet<string>,
  startedAt: number
): Set<string> {
  const out = new Set(provisional)
  for (const [id, at] of writtenAt) if (at >= startedAt) out.add(id)
  return out
}

/**
 * The prefs with a Keep written NOW, before any gather has finished: the cached fate when the
 * item is known, a placeholder when it is not. Any mark protects through `isProtectedNow`, so
 * a cycle that already holds this item as ready is refused at its reprobe; the fate is
 * rewritten once a fresh gather has confirmed it.
 */
export function withProvisionalKeep(
  prefs: GcPrefs,
  cached: readonly WorktreeBundle[],
  id: string
): GcPrefs {
  if (prefs.keep[id] !== undefined) return prefs
  const fate = cached.find((b) => b.item.id === id)?.fate.fate ?? 'pending'
  return { ...prefs, keep: { ...prefs.keep, [id]: fate } }
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
