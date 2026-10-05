import { describe, it, expect } from 'vitest'
import {
  CARD_SUBSTRATES,
  isCardSubstrate,
  planCardDispatch,
  resolveCardSubstrate,
  worktreeDispatchBranch
} from '../src/renderer/src/stores/dispatch-substrate'
import { slugFromBranch } from '../src/main/worktree-core'

const baseCard = {
  slug: 'card-1',
  provenance: { author: 'human' as const, assumed: false }
}

describe('resolveCardSubstrate (renderer mirror, T102)', () => {
  it('defaults to session when substrate is absent', () => {
    expect(resolveCardSubstrate({ substrate: undefined })).toBe('session')
  })

  it('returns every declared substrate unchanged when set', () => {
    for (const substrate of CARD_SUBSTRATES) {
      expect(resolveCardSubstrate({ substrate })).toBe(substrate)
    }
  })
})

describe('isCardSubstrate (renderer mirror, T102)', () => {
  it('accepts every declared substrate', () => {
    for (const substrate of CARD_SUBSTRATES) expect(isCardSubstrate(substrate)).toBe(true)
  })

  it('rejects an unrecognized value', () => {
    expect(isCardSubstrate('cloud')).toBe(false)
    expect(isCardSubstrate('')).toBe(false)
  })
})

describe('planCardDispatch (T102 — four dispatch modes)', () => {
  it('session (default, no substrate set) spawns in the same folder', () => {
    expect(planCardDispatch(baseCard, '/repo')).toEqual({
      kind: 'same-folder',
      substrate: 'session',
      folder: '/repo'
    })
  })

  it('session (explicit) spawns in the same folder', () => {
    expect(planCardDispatch({ ...baseCard, substrate: 'session' }, '/repo')).toEqual({
      kind: 'same-folder',
      substrate: 'session',
      folder: '/repo'
    })
  })

  it('worktree names the repo + a per-card branch, never the same folder', () => {
    expect(planCardDispatch({ ...baseCard, substrate: 'worktree' }, '/repo')).toEqual({
      kind: 'worktree',
      substrate: 'worktree',
      repoPath: '/repo',
      branch: 'card/card-1'
    })
  })

  it('worktree branch names are stable + one per slug', () => {
    expect(worktreeDispatchBranch('t102-substrate')).toBe('card/t102-substrate')
    expect(worktreeDispatchBranch('t102-substrate')).not.toBe(worktreeDispatchBranch('other'))
  })

  it('teammate spawns in the same folder and carries the authoring session id', () => {
    const card = {
      ...baseCard,
      substrate: 'teammate' as const,
      provenance: { author: 'agent' as const, assumed: false, sessionId: 'orch-123' }
    }
    expect(planCardDispatch(card, '/repo')).toEqual({
      kind: 'same-folder',
      substrate: 'teammate',
      folder: '/repo',
      teammateOf: 'orch-123'
    })
  })

  it('teammate with no known authoring session omits teammateOf (still spawns)', () => {
    expect(planCardDispatch({ ...baseCard, substrate: 'teammate' }, '/repo')).toEqual({
      kind: 'same-folder',
      substrate: 'teammate',
      folder: '/repo'
    })
  })

  it('internal never spawns — the caller must skip dispatchCardSession entirely', () => {
    expect(planCardDispatch({ ...baseCard, substrate: 'internal' }, '/repo')).toEqual({
      kind: 'skip-internal',
      substrate: 'internal'
    })
  })

  it('an explicit substrateOverride wins over the card frontmatter value', () => {
    expect(planCardDispatch({ ...baseCard, substrate: 'session' }, '/repo', 'worktree')).toEqual({
      kind: 'worktree',
      substrate: 'worktree',
      repoPath: '/repo',
      branch: 'card/card-1'
    })
  })

  it('an unrecognized substrateOverride is ignored — falls back to the card value', () => {
    expect(planCardDispatch({ ...baseCard, substrate: 'worktree' }, '/repo', 'cloud')).toEqual({
      kind: 'worktree',
      substrate: 'worktree',
      repoPath: '/repo',
      branch: 'card/card-1'
    })
  })
})

/**
 * AC5 parity oracle (BUG-40 spec §6, test 5): board-UI dispatch must produce the
 * same end state as the known-good MCP path (`create_worktree` + `create_session`).
 * The board only ever cuts a card's worktree via `worktreeDispatchBranch` (here);
 * the MCP-side collision warning (BUG-40 §3.5 / BUG-50, `findExistingWorkForSlug`
 * in `worktree-core.ts`) recovers the slug via `slugFromBranch`. If the two ever
 * drifted, `existingWork` would silently stop firing for every board-dispatched
 * card — the primary real-world case the warning exists for.
 */
describe('AC5 parity — the board-UI branch convention agrees with the MCP-side slug matcher', () => {
  it('slugFromBranch inverts worktreeDispatchBranch for every card slug', () => {
    for (const slug of ['t102-substrate', 'BUG-40-dispatch-race', 'card-1']) {
      expect(slugFromBranch(worktreeDispatchBranch(slug))).toBe(slug)
    }
  })
})
