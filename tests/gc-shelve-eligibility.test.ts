// One test per eligibility rule (U2.2 AC-2): a worktree is shelved only when its branch is not
// proven merged AND nothing says someone could be using it.

import { describe, expect, it } from 'vitest'
import { defaultGcPrefs, type GcPrefs } from '../src/main/gc/gc-prefs'
import {
  shelveCandidate,
  shelveVerdict,
  type ShelveProbe,
  type ShelveRefusal
} from '../src/main/gc/shelve-eligibility-core'
import type { BundleFacts, WorktreeBundle } from '../src/main/gc/bundle-core'
import { reapItem, bundle, DAY, NOW } from './gc-fixtures'

const WT = '/ws/org/proj/www-trees/feat-x'

const prefs = (over: Partial<GcPrefs> = {}): GcPrefs => {
  const p = defaultGcPrefs()
  return { ...p, shelve: { ...p.shelve, enabled: true }, ...over }
}

/** An unproven, idle, otherwise unremarkable worktree. */
const unproven = (over: Partial<BundleFacts> = {}): WorktreeBundle =>
  bundle(WT, 'review', {
    item: reapItem(WT, { branch: 'feat/x' }),
    fate: { fate: 'closed-unmerged', signal: null, strong: false },
    lastSignOfLifeAt: NOW - 10 * DAY,
    ...over
  })

const probe = (over: Partial<ShelveProbe> = {}): ShelveProbe => ({
  headSha: 'a'.repeat(40),
  workStamp: null,
  newestMtime: null,
  lastCommitAt: NOW - 10 * DAY,
  manifestDelegates: false,
  ...over
})

const ctx = (over: { prefs?: GcPrefs; driftedCwds?: string[] } = {}) => ({
  prefs: over.prefs ?? prefs(),
  now: NOW,
  driftedCwds: over.driftedCwds ?? []
})

const refusal = (b: WorktreeBundle, p: ShelveProbe = probe(), c = ctx()): ShelveRefusal | null => {
  const v = shelveVerdict(b, p, c)
  return v.eligible ? null : v.reason
}

describe('shelveVerdict — eligible', () => {
  it('an unproven, idle, plain worktree is eligible, with how long it was idle', () => {
    const v = shelveVerdict(unproven(), probe(), ctx())
    expect(v).toEqual({ eligible: true, idleMs: 10 * DAY, since: NOW - 10 * DAY })
  })

  it('a weak merge signal is not a proof: still eligible', () => {
    expect(
      refusal(unproven({ fate: { fate: 'merged', signal: 'gh-merged', strong: false } }))
    ).toBe(null)
  })

  it('an open PR is the normal state of waiting work: eligible once idle', () => {
    expect(refusal(unproven({ fate: { fate: 'open', signal: null, strong: false } }))).toBe(null)
  })

  it('a detached worktree is eligible (its HEAD is archived)', () => {
    const b = unproven({
      item: reapItem(WT, { kind: 'detached-worktree', branch: undefined, headSha: 'b'.repeat(40) }),
      fate: { fate: 'detached', signal: null, strong: false }
    })
    expect(refusal(b)).toBe(null)
  })
})

describe('shelveVerdict — one case per rule (AC-2)', () => {
  it('a strongly merged branch keeps today’s removal path (D-A)', () => {
    expect(refusal(unproven({ fate: { fate: 'merged', signal: 'ancestor', strong: true } }))).toBe(
      'merged'
    )
  })

  it.each(['working', 'needs-input', 'open-idle'] as const)(
    'a session that is %s blocks it',
    (session) => {
      expect(refusal(unproven({ session }))).toBe('session')
    }
  )

  it('a keep mark blocks it', () => {
    expect(refusal(unproven({ keep: true }))).toBe('protected')
  })

  it('a STALE keep mark (fate changed, mark not yet cleared) still blocks it, never makes it eligible', () => {
    const b = unproven({ keep: false })
    const p = prefs({ keep: { [b.item.id]: 'merged' } })
    expect(refusal(b, probe(), ctx({ prefs: p }))).toBe('protected')
  })

  it('neverClean blocks it', () => {
    expect(refusal(unproven({ neverClean: true }))).toBe('protected')
  })

  it('a neverClean path in the prefs blocks it', () => {
    expect(refusal(unproven(), probe(), ctx({ prefs: prefs({ neverClean: [WT] }) }))).toBe(
      'protected'
    )
  })

  it('the main checkout is never shelved', () => {
    expect(refusal(unproven({ isMainCheckout: true }))).toBe('protected')
  })

  it.each(['rebase', 'bisect', 'am'] as const)('a %s in progress blocks it', (operation) => {
    expect(refusal(unproven({ operation }))).toBe('operation')
  })

  it('a locked worktree blocks it', () => {
    expect(refusal(unproven({ locked: true }))).toBe('locked')
  })

  it('a worktree nested inside it blocks it (deleting would take it along)', () => {
    expect(refusal(unproven({ nestedWorktrees: ['/ws/org/proj/www-trees/feat-x/inner'] }))).toBe(
      'nested'
    )
  })

  it('a foreign checkout inside it blocks it, and so does one that was never walked', () => {
    expect(refusal(unproven({ foreignCheckouts: ['/x/.git'] }))).toBe('nested')
    expect(refusal(unproven({ foreignCheckouts: undefined as unknown as string[] }))).toBe('nested')
  })

  it('a path that did not resolve to its real location blocks it', () => {
    expect(refusal(unproven({ pathsResolved: false }))).toBe('unresolved')
  })

  it('a stack that runs from it, or shares it, blocks it', () => {
    expect(refusal(unproven({ stackIds: ['s1'] }))).toBe('stack')
    expect(refusal(unproven({ sharedStackIds: ['s2'] }))).toBe('stack')
  })

  it('a scan that could not see Docker blocks it', () => {
    expect(refusal(unproven({ dockerBlind: true }))).toBe('blind')
  })

  it('a session that drifted into it (C4) blocks it; one elsewhere does not', () => {
    expect(refusal(unproven(), probe(), ctx({ driftedCwds: [`${WT}/api`] }))).toBe('drifted')
    expect(refusal(unproven(), probe(), ctx({ driftedCwds: [WT] }))).toBe('drifted')
    expect(refusal(unproven(), probe(), ctx({ driftedCwds: [`${WT}-other`, '/ws/else'] }))).toBe(
      null
    )
  })

  it('a repo whose WORKTREE.md delegates create:/remove: is not shelved (C10)', () => {
    expect(refusal(unproven(), probe({ manifestDelegates: true }))).toBe('delegated-manifest')
  })

  it('a worktree kind that is not a checkout is not a candidate', () => {
    const b = unproven({ item: reapItem(WT, { kind: 'local-branch' }) })
    expect(shelveCandidate(b, ctx())).toBe('not-a-worktree')
  })
})

describe('shelveVerdict — idle for at least the threshold', () => {
  it('2 days idle with a 3-day threshold is too recent', () => {
    expect(
      refusal(
        unproven({ lastSignOfLifeAt: NOW - 2 * DAY }),
        probe({ lastCommitAt: NOW - 20 * DAY })
      )
    ).toBe('too-recent')
  })

  it('the newest of transcript, commit and file edit counts: a fresh commit', () => {
    expect(refusal(unproven(), probe({ lastCommitAt: NOW - DAY }))).toBe('too-recent')
  })

  it('a recently edited file counts as a sign of life', () => {
    expect(refusal(unproven(), probe({ newestMtime: NOW - DAY / 2 }))).toBe('too-recent')
  })

  it('exactly the threshold is idle enough', () => {
    const v = shelveVerdict(
      unproven({ lastSignOfLifeAt: NOW - 3 * DAY }),
      probe({ lastCommitAt: NOW - 3 * DAY }),
      ctx()
    )
    expect(v.eligible).toBe(true)
  })

  it('the threshold is the operator’s', () => {
    const p = prefs()
    p.shelve.thresholdDays = 14
    expect(refusal(unproven(), probe(), ctx({ prefs: p }))).toBe('too-recent')
  })

  it('no sign of life at all is unknown age, not old enough', () => {
    expect(refusal(unproven({ lastSignOfLifeAt: null }))).toBe('unknown-age')
  })

  it('a probe that could not read HEAD or the last commit is unreadable', () => {
    expect(refusal(unproven(), probe({ headSha: null }))).toBe('unreadable')
    expect(refusal(unproven(), probe({ lastCommitAt: null }))).toBe('unreadable')
  })
})
