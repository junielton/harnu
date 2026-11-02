/**
 * Campaign ch.6 part 2 (T610, AC-6.4) — the `verifier` gate reads the evidence bundle.
 * A verifier-level step whose proof is `verified` reads `green` only while a `worktree`
 * link points at `.harnu/evidence/<missionId>/<stepId>/`; with no such link, or with a
 * link whose directory is gone, it reads `running`. Pure: the caller says whether the
 * bundle is on disk.
 */
import { describe, it, expect } from 'vitest'
import {
  computeStepGates,
  evidenceBundleDir,
  hasEvidenceBundle,
  type GateInput
} from '../src/main/mission-gates'

const MISSION = 'mnt-4ba02726'
/** A verification recorded after T610: `mission_verify_step` stamps `evidenceRequired`. */
const verifiedBy = {
  sessionId: 's',
  at: 'x',
  verdict: 'met' as const,
  evidenceRequired: true as const
}
/** One recorded before: no marker, so the gate never asks it for a bundle. */
const legacyVerifiedBy = { sessionId: 's', at: 'x', verdict: 'met' as const }

function input(over: Partial<GateInput['step']> = {}, rest: Partial<GateInput> = {}): GateInput {
  return {
    missionId: MISSION,
    step: {
      id: 'stp-16',
      verification: 'verifier',
      proof: 'verified',
      verifiedBy,
      links: [],
      ...over
    },
    pr: null,
    mainCi: null,
    ...rest
  }
}

const bundleLink = { kind: 'worktree' as const, ref: `.harnu/evidence/${MISSION}/stp-16` }

describe('evidenceBundleDir', () => {
  it('names the directory the verifier stores the bundle in', () => {
    expect(evidenceBundleDir(MISSION, 'stp-16')).toBe('.harnu/evidence/mnt-4ba02726/stp-16')
  })
})

describe('hasEvidenceBundle', () => {
  it('accepts a repo-relative, absolute or trailing-slash ref to the bundle directory', () => {
    for (const ref of [
      '.harnu/evidence/mnt-4ba02726/stp-16',
      '.harnu/evidence/mnt-4ba02726/stp-16/',
      '/home/x/repo/.harnu/evidence/mnt-4ba02726/stp-16',
      '/home/x/repo/.harnu/evidence/mnt-4ba02726/stp-16/'
    ]) {
      expect(hasEvidenceBundle([{ kind: 'worktree', ref }], MISSION, 'stp-16')).toBe(true)
    }
  })

  it('rejects another step, another mission, a prefix collision and a non-worktree link', () => {
    for (const link of [
      { kind: 'worktree' as const, ref: `.harnu/evidence/${MISSION}/stp-1` },
      { kind: 'worktree' as const, ref: '.harnu/evidence/mnt-00000000/stp-16' },
      { kind: 'worktree' as const, ref: `.harnu/evidence/${MISSION}/stp-160` },
      { kind: 'worktree' as const, ref: `.harnu/evidence/${MISSION}` },
      { kind: 'pr' as const, ref: `.harnu/evidence/${MISSION}/stp-16` },
      { kind: 'worktree' as const, ref: '/home/x/repo' }
    ]) {
      expect(hasEvidenceBundle([link], MISSION, 'stp-16')).toBe(false)
    }
  })
})

describe('grandfathering — only a verification that carries the marker needs a bundle', () => {
  it('a legacy verified step with no bundle still reads green', () => {
    expect(computeStepGates(input({ verifiedBy: legacyVerifiedBy })).verifier).toBe('green')
  })

  it('a legacy needs-human verification with no bundle still reads green', () => {
    const g = computeStepGates(
      input({ verifiedBy: { ...legacyVerifiedBy, verdict: 'needs-human' } })
    )
    expect(g.verifier).toBe('green')
  })

  it('a new verification (marker present) with no bundle reads running', () => {
    expect(computeStepGates(input({ verifiedBy })).verifier).toBe('running')
  })

  it('the marker with a bundle on disk reads green; with the folder gone, running', () => {
    expect(computeStepGates(input({ links: [bundleLink] })).verifier).toBe('green')
    expect(computeStepGates(input({ links: [bundleLink] }, { bundleOnDisk: false })).verifier).toBe(
      'running'
    )
  })
})

describe('the verifier gate reads the evidence bundle (AC-6.4)', () => {
  it('a verified proof with no bundle link reads running, not green', () => {
    expect(computeStepGates(input()).verifier).toBe('running')
  })

  it('a verified proof with a bundle link on disk reads green', () => {
    expect(computeStepGates(input({ links: [bundleLink] })).verifier).toBe('green')
  })

  it('a bundle link whose directory is gone reads running (a link alone proves nothing)', () => {
    expect(computeStepGates(input({ links: [bundleLink] }, { bundleOnDisk: false })).verifier).toBe(
      'running'
    )
  })

  it('a needs-human verdict is still green once the bundle is linked', () => {
    const g = computeStepGates(
      input({ verifiedBy: { ...verifiedBy, verdict: 'needs-human' }, links: [bundleLink] })
    )
    expect(g.verifier).toBe('green')
  })

  it('a red verdict stays red whatever the bundle says', () => {
    const g = computeStepGates(
      input({ proof: 'unproven', verifiedBy: { ...verifiedBy, verdict: 'unmet' } })
    )
    expect(g.verifier).toBe('red')
  })

  it('does not touch an unverified step: unproven is still off, claimed still running', () => {
    expect(computeStepGates(input({ proof: 'unproven', verifiedBy: undefined })).verifier).toBe(
      'off'
    )
    expect(computeStepGates(input({ proof: 'claimed', verifiedBy: undefined })).verifier).toBe(
      'running'
    )
  })

  it('does not apply to a human step the operator ticked, nor to an existence step', () => {
    expect(computeStepGates(input({ verification: 'human' })).verifier).toBe('green')
    expect(computeStepGates(input({ verification: 'existence' })).verifier).toBe('na')
  })
})
