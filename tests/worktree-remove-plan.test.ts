import { describe, it, expect } from 'vitest'
import { resolveWorktreeRemovalPlan } from '../src/main/worktree-core'

/**
 * BUG-38 (folded into BUG-56) — `removeWorktree` used to throw a raw git error
 * when the worktree directory was already gone (e.g. deleted by Reaper, or by
 * `rm -rf` outside Harnu), because its pre-flight `isWorktreeDirty` probe runs
 * `git status --porcelain` against a path that no longer exists. Pure decision
 * logic extracted per ADR-0001 (thin `*-ipc.ts` shells stay untested; the
 * branching lives here instead).
 */
describe('resolveWorktreeRemovalPlan (BUG-38 — gone-directory removal)', () => {
  it('runs the normal dirty/unpushed pre-flight when the directory exists and force is off', () => {
    expect(resolveWorktreeRemovalPlan({ dirExists: true, force: false })).toEqual({
      runPreflight: true,
      effectiveForce: false,
      readBranch: true
    })
  })

  it('skips the pre-flight and forces removal when the directory is already gone', () => {
    expect(resolveWorktreeRemovalPlan({ dirExists: false, force: false })).toEqual({
      runPreflight: false,
      effectiveForce: true,
      readBranch: false
    })
  })

  it('skips the pre-flight when the caller already passed force, directory present', () => {
    expect(resolveWorktreeRemovalPlan({ dirExists: true, force: true })).toEqual({
      runPreflight: false,
      effectiveForce: true,
      readBranch: true
    })
  })

  it('a gone directory stays forced and branch-less even when force was already true', () => {
    expect(resolveWorktreeRemovalPlan({ dirExists: false, force: true })).toEqual({
      runPreflight: false,
      effectiveForce: true,
      readBranch: false
    })
  })
})
