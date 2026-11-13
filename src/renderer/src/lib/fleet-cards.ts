import type { Session } from '../stores/sessions'
import type { BoardBucket, BoardState } from '../components/fleet-board'

/** One card of the fleet rail: the session, its folder alias, and the board bucket it sits in. */
export interface FleetCard {
  session: Session
  folderAlias: string
  state: BoardState
}

/**
 * Flatten the board into the rail's cards (`InboxRail.vue`): `idle` is dropped, everything else keeps its
 * bucket order and per-bucket sort. Pure over the store's `boardBuckets`; the session behind each slice is
 * found through `store.sessionIndex`, so the cost follows the number of cards, not the size of the fleet.
 */
export function buildFleetCards(
  buckets: readonly BoardBucket[],
  store: { sessionIndex: ReadonlyMap<string, { session: Session }> }
): FleetCard[] {
  const cards: FleetCard[] = []
  for (const bucket of buckets) {
    if (bucket.state === 'idle') continue
    for (const slice of bucket.sessions) {
      // The store's id index is rebuilt once per change of membership, not once per evaluation (BUG-265).
      const session = store.sessionIndex.get(slice.sessionId)?.session
      if (session) cards.push({ session, folderAlias: slice.folderAlias, state: bucket.state })
    }
  }
  return cards
}
