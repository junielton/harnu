import type { CommandArgs, ParkQueryData } from '../../hooks/contract'

/**
 * T456 W2 contract fixtures for `park.query` (contract §9): the shapes both halves agree on. The
 * host's tests feed these through its parser (`tests/park-query.test.ts`), so a change to the wire
 * shape on either side fails a test on the other.
 */

export const PARK_QUERY_ARGS: CommandArgs['park.query'] = { cause: 'sweep' }

/** Every reason kind, as the mod builds them. */
export const PARK_BUSY_DATA: ParkQueryData = {
  busy: [
    { kind: 'turn' },
    { kind: 'permission', count: 1 },
    { kind: 'background-task', count: 2, types: ['shell', 'monitor'] },
    { kind: 'background-subagent', count: 1 },
    { kind: 'scheduled-wakeup', count: 1, recurring: 1 },
    { kind: 'remote-surface', surfaces: ['mobile'] }
  ],
  retryAfterMs: 120_000
}

/** "Park me". */
export const PARK_FREE_DATA: ParkQueryData = { busy: [] }

/** Shapes the host must read as `silent`: the mod's answer is untrusted input (SEC-3b). */
export const PARK_MALFORMED_DATA: unknown[] = [
  null,
  'busy',
  {},
  { busy: 'turn' },
  { busy: [{ kind: 'turn' }, 42] },
  { busy: Array.from({ length: 64 }, () => ({ kind: 'turn' })) }
]

/**
 * A reason kind the host does not know (a newer mod): dropped, as receivers ignore what they do
 * not know (contract §14). With nothing else the answer is "free", today's park.
 */
export const PARK_UNKNOWN_KIND_DATA: unknown = { busy: [{ kind: 'quantum-entanglement' }] }
