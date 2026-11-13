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
 * looked up in `store`.
 */
export function buildFleetCards(
  buckets: readonly BoardBucket[],
  store: { allSessions: readonly Session[] }
): FleetCard[] {
  const byId = new Map(store.allSessions.map((s) => [s.sessionId, s]))
  const cards: FleetCard[] = []
  for (const bucket of buckets) {
    if (bucket.state === 'idle') continue
    for (const slice of bucket.sessions) {
      const session = byId.get(slice.sessionId)
      if (session) cards.push({ session, folderAlias: slice.folderAlias, state: bucket.state })
    }
  }
  return cards
}
