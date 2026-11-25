import { describe, expect, it } from 'vitest'
import { buildFleetCards } from '../src/renderer/src/lib/fleet-cards'
import type { BoardBucket, BoardSession } from '../src/renderer/src/components/fleet-board'
import type { Session } from '../src/renderer/src/stores/sessions'

const slice = (sessionId: string, folderAlias: string): BoardSession => ({
  sessionId,
  status: 'idle',
  isSidechain: false,
  modified: '',
  activity: 'idle',
  folderAlias
})
const row = (sessionId: string): { session: Session } => ({ session: { sessionId } as Session })

describe('buildFleetCards (BUG-265)', () => {
  const buckets: BoardBucket[] = [
    { state: 'needs-input', sessions: [slice('a', 'api'), slice('ghost', 'api')] },
    { state: 'working', sessions: [slice('b', 'web')] },
    { state: 'idle', sessions: [slice('c', 'web')] },
    { state: 'done', sessions: [slice('d', 'docs')] }
  ]
  const index = new Map(
    [row('a'), row('b'), row('c'), row('d')].map((r) => [r.session.sessionId, r])
  )

  it('flattens the buckets in order, drops idle, and skips a slice the model no longer holds', () => {
    const cards = buildFleetCards(buckets, { sessionIndex: index })

    expect(cards.map((c) => [c.session.sessionId, c.state, c.folderAlias])).toEqual([
      ['a', 'needs-input', 'api'],
      ['b', 'working', 'web'],
      ['d', 'done', 'docs']
    ])
  })

  it('returns the very session objects of the index (identity, not copies)', () => {
    const cards = buildFleetCards(buckets, { sessionIndex: index })

    expect(cards[0].session).toBe(index.get('a')!.session)
  })
})
