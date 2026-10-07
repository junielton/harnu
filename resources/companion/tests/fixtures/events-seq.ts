/**
 * Golden fixture for the sequence rule (contract §6, conformance row 5): three batches whose
 * acknowledgements, duplicates and resync flags both sides must agree on.
 */
import type { WireEvent } from '../../hooks/contract'

/** The only event type the fixture uses; a test registers it as known. */
export const SEQ_EVENT_TYPE = 'subagent.started' as const

function ev(seq: number): WireEvent<typeof SEQ_EVENT_TYPE> {
  return { seq, t: SEQ_EVENT_TYPE, ts: 1_790_000_000_000 + seq, d: { agentType: 'general' } }
}

export interface SeqStep {
  events: WireEvent[]
  dropped?: number
  expect: { ackSeq: number; accepted: number[]; duplicates: number; resync: boolean }
}

export const eventsSeqSteps: SeqStep[] = [
  // in order: nothing special
  {
    events: [ev(1), ev(2), ev(3)],
    expect: { ackSeq: 3, accepted: [1, 2, 3], duplicates: 0, resync: false }
  },
  // a re-send overlapping the previous batch: 2 and 3 are duplicates, 4 is new
  {
    events: [ev(2), ev(3), ev(4)],
    expect: { ackSeq: 4, accepted: [4], duplicates: 2, resync: false }
  },
  // a gap (5 and 6 were dropped by the mod): accepted, resync, ackSeq jumps to the highest seq
  { events: [ev(7)], expect: { ackSeq: 7, accepted: [7], duplicates: 0, resync: true } }
]
