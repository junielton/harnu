import { describe, it, expect } from 'vitest'
import { getStashedApproval, stashApproval } from '../src/main/mcp/approval-stash'

describe('approval-stash', () => {
  it('an unknown id is not stashed', () => {
    expect(getStashedApproval('never-seen')).toBeUndefined()
  })

  it('stashApproval then getStashedApproval round-trips the record', () => {
    const id = `test-${Math.random()}`
    stashApproval(id, { status: 'pending', tool: 'create_session', folder: '/repo', ts: 1 })
    expect(getStashedApproval(id)).toEqual({
      status: 'pending',
      tool: 'create_session',
      folder: '/repo',
      ts: 1
    })
  })

  it('a later stashApproval for the same id overwrites the record (settle transition)', () => {
    const id = `test-${Math.random()}`
    stashApproval(id, { status: 'pending', tool: 'create_session', folder: '/repo', ts: 1 })
    stashApproval(id, {
      status: 'allowed',
      result: { ok: true },
      tool: 'create_session',
      folder: '/repo',
      ts: 2
    })
    expect(getStashedApproval(id)).toEqual({
      status: 'allowed',
      result: { ok: true },
      tool: 'create_session',
      folder: '/repo',
      ts: 2
    })
  })

  it('evicts old entries once the cap is reached (bounded, not unbounded growth)', () => {
    // Cap is 64 and the stash is a shared module-level map, so don't assume an
    // empty starting size — insert well past the cap (70 fresh ids) so the FIRST
    // is guaranteed evicted (≥64 insertions happened after it in this test alone)
    // and the LAST is guaranteed to survive.
    const ids = Array.from({ length: 70 }, (_, i) => `cap-test-${Math.random()}-${i}`)
    for (const id of ids) {
      stashApproval(id, { status: 'pending', tool: 't', folder: 'f', ts: 0 })
    }
    expect(getStashedApproval(ids[0])).toBeUndefined()
    expect(getStashedApproval(ids[ids.length - 1])).toBeDefined()
  })
})
