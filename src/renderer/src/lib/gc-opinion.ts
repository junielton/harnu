// Renderer-side bookkeeping of "Ask for an opinion" (design.md "Workspace GC — unified Cleanup /
// Opinion chip"): which opinions are still about the item the operator sees, and which items are
// marked safe. Pure — no DOM, no Vue, no IPC; unit-tested in tests/gc-opinion-model.test.ts.
//
// An opinion is advice about one moment of one item. Main already drops its own cache entry when
// the item's fate, head or dirty files change; this side drops a chip as soon as a snapshot shows
// a different head, reason or bucket, so a stale "safe" never feeds "Remove the ones marked safe".

import type { GcOpinion } from '../../../main/gc/gc-wire'
import { isRemovable, type GcBlock, type GcModel } from './gc-model'

export interface StoredOpinion {
  opinion: GcOpinion
  /** What the block looked like when the opinion was ASKED for. */
  fingerprint: string
  /**
   * Main cached this answer, so a later peek can confirm it. An advisor that could not answer reads
   * `unsure` and is not durable: there is nothing in main to confirm it against.
   */
  durable: boolean
}

export type OpinionMap = ReadonlyMap<string, StoredOpinion>

/**
 * The facts an opinion depends on that the snapshot carries: the head, the reason, the bucket, the
 * branch fate and merge signal, and the untracked files. Disk use is left out: it only drifts. The
 * snapshot does not carry the tracked dirty files or the pull request state, so main's own key
 * (checked through `gc:opinion:cached`) is what covers those.
 */
export function fingerprintOf(b: GcBlock): string {
  if (b.kind === 'volume') return `volume|${b.project ?? ''}|${b.volume?.sizeBytes ?? ''}`
  const fate = b.bundle ? `${b.bundle.fate.fate}/${b.bundle.fate.signal ?? ''}` : ''
  const untracked = [...(b.bundle?.item.untracked ?? [])].sort().join('\n')
  return `${b.bundle?.localTip ?? ''}|${b.reasonCode ?? ''}|${b.bucket}|${fate}|${untracked}`
}

const isAskable = (b: GcBlock | undefined): b is GcBlock => !!b && b.bucket === 'review'

/**
 * Stores an opinion for a Needs review block of the model; an unknown or non-review id is ignored.
 * `askedFingerprint` is the block's fingerprint when the question was asked: a result for an item
 * that has since changed is about a state that no longer exists and is dropped, not shown. Without
 * it (a peek, which main already checked) the current fingerprint is used.
 */
export function recordOpinion(
  map: OpinionMap,
  opinion: GcOpinion,
  model: GcModel,
  opts: { askedFingerprint?: string; durable?: boolean } = {}
): OpinionMap {
  const block = model.byId.get(opinion.id)
  if (!isAskable(block)) return map
  const current = fingerprintOf(block)
  if (opts.askedFingerprint !== undefined && opts.askedFingerprint !== current) return map
  const next = new Map(map)
  next.set(opinion.id, {
    opinion,
    fingerprint: opts.askedFingerprint ?? current,
    durable: opts.durable ?? true
  })
  return next
}

/**
 * After main was asked to confirm `requested` ids: the durable opinions among them that main did not
 * return are no longer about the item (its pull request state, dirty files or head moved), so they
 * go. Opinions outside `requested`, and ones main never cached, are left alone. The same map when
 * nothing dropped.
 */
export function dropUnconfirmed(
  map: OpinionMap,
  requested: readonly string[],
  confirmed: ReadonlySet<string>
): OpinionMap {
  const asked = new Set(requested)
  let dropped = false
  const next = new Map<string, StoredOpinion>()
  for (const [id, stored] of map) {
    if (stored.durable && asked.has(id) && !confirmed.has(id)) dropped = true
    else next.set(id, stored)
  }
  return dropped ? next : map
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
      // An opinion on an item main refuses is still shown, but never material for the shortcut: it
      // would only pre-select a removal that ends in "0 cleaned".
      if (!isRemovable(b)) return false
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
