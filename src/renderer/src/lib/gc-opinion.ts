// Renderer-side bookkeeping of "Ask for an opinion" (design.md "Workspace GC — unified Cleanup /
// Opinion chip"): which opinions are still about the item the operator sees, and which items are
// marked safe. Pure — no DOM, no Vue, no IPC; unit-tested in tests/gc-opinion-model.test.ts.
//
// An opinion is advice about one moment of one item. Main already drops its own cache entry when
// the item's fate, head or dirty files change; this side drops a chip as soon as a snapshot shows
// a different head, reason or bucket, so a stale "safe" never feeds "Remove the ones marked safe".

import type { GcOpinion } from '../../../main/gc/gc-wire'
import type { GcBlock, GcModel } from './gc-model'

export interface StoredOpinion {
  opinion: GcOpinion
  /** What the block looked like when the opinion arrived. */
  fingerprint: string
}

export type OpinionMap = ReadonlyMap<string, StoredOpinion>

/** The facts an opinion depends on that the snapshot carries. Disk use is left out: it only drifts. */
export function fingerprintOf(b: GcBlock): string {
  if (b.kind === 'volume') return `volume|${b.project ?? ''}|${b.volume?.sizeBytes ?? ''}`
  return `${b.bundle?.localTip ?? ''}|${b.reasonCode ?? ''}|${b.bucket}`
}

const isAskable = (b: GcBlock | undefined): b is GcBlock => !!b && b.bucket === 'review'

/** Stores an opinion for a Needs review block of the model; an unknown or non-review id is ignored. */
export function recordOpinion(map: OpinionMap, opinion: GcOpinion, model: GcModel): OpinionMap {
  const block = model.byId.get(opinion.id)
  if (!isAskable(block)) return map
  const next = new Map(map)
  next.set(opinion.id, { opinion, fingerprint: fingerprintOf(block) })
  return next
}

/** Keeps the opinions whose item is still Needs review and unchanged; the same map when none dropped. */
export function pruneOpinions(map: OpinionMap, model: GcModel): OpinionMap {
  let dropped = false
  const next = new Map<string, StoredOpinion>()
  for (const [id, stored] of map) {
    const block = model.byId.get(id)
    if (isAskable(block) && fingerprintOf(block) === stored.fingerprint) next.set(id, stored)
    else dropped = true
  }
  return dropped ? next : map
}

export const opinionOf = (map: OpinionMap, id: string): GcOpinion | null =>
  map.get(id)?.opinion ?? null

/**
 * The items "Remove the ones marked safe" pre-selects: current Needs review items whose opinion
 * is `safe` and still matches, in the list's order (biggest first). Orphan volumes can be marked
 * safe like any other item; the confirm dialog still asks about each one.
 */
export function safeIds(map: OpinionMap, model: GcModel): string[] {
  return model.review
    .filter((b) => {
      const stored = map.get(b.id)
      return stored?.opinion.verdict === 'safe' && stored.fingerprint === fingerprintOf(b)
    })
    .map((b) => b.id)
}

export function markPending(pending: ReadonlySet<string>, ids: readonly string[]): Set<string> {
  return new Set([...pending, ...ids])
}

/** The set without `ids`; the same set when none of them was in it. */
export function clearPending(
  pending: ReadonlySet<string>,
  ids: readonly string[]
): ReadonlySet<string> {
  if (!ids.some((id) => pending.has(id))) return pending
  const next = new Set(pending)
  for (const id of ids) next.delete(id)
  return next
}
