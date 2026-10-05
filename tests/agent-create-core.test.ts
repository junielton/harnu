import { describe, it, expect } from 'vitest'

/**
 * Agent-created sessions (MCP fleet) must NOT ride the user "+ New session"
 * dedupe path, and must NOT be migrated by the "newest synthetic in the folder
 * wins" recency heuristic in `reconcileSessionAdded`. Two agents — or an agent
 * and a human — can ask for a session in the SAME folder concurrently, so:
 *   - `makeAgentSession` always mints a FRESH, non-deduped synthetic carrying an
 *     opaque correlation token (never reuses a folder's existing user synthetic);
 *   - `bindMigration` binds the agent's OWN synthetic via that token (not by
 *     recency), errors when nothing correlates, and leaves every coexisting
 *     synthetic untouched.
 */

import {
  makeAgentSession,
  bindMigration,
  type SyntheticCandidate
} from '../src/renderer/src/stores/agent-create-core'

/** Deterministic, injectable id generator: 'u1', 'u2', 'u3', … */
const counter = (): (() => string) => {
  let n = 0
  return () => `u${++n}`
}

describe('makeAgentSession (fresh, non-deduped mint + correlation token)', () => {
  it('mints a synthetic-<uuid> id plus a non-empty correlation token', () => {
    const out = makeAgentSession('/repo/app', counter())
    expect(out.syntheticId).toMatch(/^synthetic-/)
    expect(out.syntheticId).toBe('synthetic-u1')
    expect(out.correlationId).toBe('agent-corr-u2')
    expect(out.correlationId.length).toBeGreaterThan(0)
    expect(out.folderPath).toBe('/repo/app')
  })

  it('is deterministic under an injected id generator', () => {
    const out = makeAgentSession('/x', counter())
    expect(out).toEqual({
      syntheticId: 'synthetic-u1',
      correlationId: 'agent-corr-u2',
      folderPath: '/x'
    })
  })

  it('NEVER dedupes: two calls for the SAME folder mint distinct ids + tokens', () => {
    const gen = counter()
    const a = makeAgentSession('/repo/app', gen)
    const b = makeAgentSession('/repo/app', gen)
    expect(a.syntheticId).not.toBe(b.syntheticId)
    expect(a.correlationId).not.toBe(b.correlationId)
  })

  it('does NOT reuse an existing folder user synthetic — always a brand-new id', () => {
    // A pre-existing user "+ New session" synthetic lives in this folder.
    const existingUserSynthetic = 'synthetic-USER-EXISTING'
    const minted = makeAgentSession('/repo/app', counter())
    expect(minted.syntheticId).not.toBe(existingUserSynthetic)
    expect(minted.syntheticId).toBe('synthetic-u1')
  })

  it('uses crypto.randomUUID by default (real uuid shape, unique per call)', () => {
    const a = makeAgentSession('/repo/app')
    const b = makeAgentSession('/repo/app')
    expect(a.syntheticId).toMatch(
      /^synthetic-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    )
    expect(a.syntheticId).not.toBe(b.syntheticId)
    expect(a.correlationId).not.toBe(b.correlationId)
  })
})

describe('bindMigration (deterministic correlation bind, not recency)', () => {
  it('binds the agent OWN synthetic — not the most-recent-in-folder synthetic', () => {
    const agent = makeAgentSession('/repo/app', counter())
    // Candidates ordered so the user synthetic is the "newest" (last) — the
    // recency heuristic would pick IT. Correlation must pick the agent's own.
    const candidates: SyntheticCandidate[] = [
      { syntheticId: agent.syntheticId, correlationId: agent.correlationId },
      { syntheticId: 'synthetic-USER-NEWER' } // user synthetic: no correlation
    ]
    const res = bindMigration(agent.correlationId, candidates, 'real-uuid-1')
    expect(res).toEqual({ boundSyntheticId: agent.syntheticId, realUuid: 'real-uuid-1' })
  })

  it('returns an error when no candidate carries the correlation token', () => {
    const candidates: SyntheticCandidate[] = [
      { syntheticId: 'synthetic-USER', correlationId: undefined }
    ]
    const res = bindMigration('agent-corr-missing', candidates, 'real-uuid-1')
    expect('error' in res).toBe(true)
    expect('boundSyntheticId' in res).toBe(false)
  })

  it('errors (does not bind) on empty correlationId or empty realUuid', () => {
    const candidates: SyntheticCandidate[] = [
      { syntheticId: 'synthetic-A', correlationId: 'agent-corr-1' }
    ]
    expect('error' in bindMigration('', candidates, 'real-uuid')).toBe(true)
    expect('error' in bindMigration('agent-corr-1', candidates, '')).toBe(true)
  })

  it('leaves a coexisting user synthetic untouched (pure, no mutation)', () => {
    const agent = makeAgentSession('/repo/app', counter())
    const userSynthetic: SyntheticCandidate = {
      syntheticId: 'synthetic-USER',
      correlationId: undefined
    }
    const snapshot = JSON.parse(JSON.stringify(userSynthetic))
    const candidates: SyntheticCandidate[] = [
      { syntheticId: agent.syntheticId, correlationId: agent.correlationId },
      userSynthetic
    ]
    const before = JSON.parse(JSON.stringify(candidates))
    const res = bindMigration(agent.correlationId, candidates, 'real-uuid-1')

    // The bound id is the agent's own — never the coexisting user synthetic.
    expect(res).toEqual({ boundSyntheticId: agent.syntheticId, realUuid: 'real-uuid-1' })
    expect('boundSyntheticId' in res && res.boundSyntheticId).not.toBe('synthetic-USER')
    // Inputs are not mutated.
    expect(userSynthetic).toEqual(snapshot)
    expect(candidates).toEqual(before)
  })

  it('binds the correct agent when two agents coexist in one folder', () => {
    const gen = counter()
    const a1 = makeAgentSession('/repo/app', gen)
    const a2 = makeAgentSession('/repo/app', gen)
    const candidates: SyntheticCandidate[] = [
      { syntheticId: a1.syntheticId, correlationId: a1.correlationId },
      { syntheticId: a2.syntheticId, correlationId: a2.correlationId }
    ]
    expect(bindMigration(a2.correlationId, candidates, 'r2')).toEqual({
      boundSyntheticId: a2.syntheticId,
      realUuid: 'r2'
    })
    expect(bindMigration(a1.correlationId, candidates, 'r1')).toEqual({
      boundSyntheticId: a1.syntheticId,
      realUuid: 'r1'
    })
  })
})
