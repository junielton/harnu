// The operator's explicit force path for review worktrees (design: workspace-gc §3.3, Needs review →
// Remove). Only `gc-manual.ts` builds these ops, and only for a bundle the operator confirmed;
// the autopilot has no import path to this file.
//
// A review bundle is one the cleanup executor would refuse: it is dirty, unpushed or not
// proven merged. Forcing it is safe only because everything it could lose is written to git
// first, so the order here is the whole contract:
//
//   1. the reprobe still refuses a live session, a changed stack set or a HEAD that moved;
//   2. the tip and the working state (tracked and untracked) are archived to `refs/archive/…`
//      BEFORE any container is stopped or any directory is removed; if that fails, nothing ran;
//   3. only then does the normal pipeline run, with the executor's own dirty/unpushed/merged
//      guards waived, because step 2 is what makes waiving them recoverable.
//
// What stays refused: a main checkout, a neverClean path, an in-use bundle and a detached
// worktree are turned away before these ops are even built (autopilot-core `refusalFor`).

import type { WorktreeBundle } from './bundle-core'
import { createGcOps, type GcShellDeps } from './gc-shell'
import type { GcOps } from './pipeline-core'
import { planArchive } from '../reaper/archive-core'

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * The bundle as the executor should see it: harvestable, with the blockers the operator
 * confirmed removed. Only a copy used inside these ops; the bundle the queue holds, and the
 * one reported back, still says Needs review.
 */
export function asExecutable(b: WorktreeBundle): WorktreeBundle {
  return {
    ...b,
    item: {
      ...b.item,
      verdict: 'harvestable',
      blockers: b.item.blockers.filter((x) => x !== 'dirty' && x !== 'unpushed')
    }
  }
}

/** Writes `refs/archive/<branch>/<stamp>/{tip,wip}`; throws, and so refuses, if it cannot. */
async function preserve(b: WorktreeBundle, deps: GcShellDeps, at: number): Promise<void> {
  const { executor } = deps
  const plan = planArchive(b.item, at)
  // A folder that would be removed with nothing preserving it is never removed.
  if (!plan.tip || !plan.wip) throw new Error('nothing would preserve this worktree')
  const sha = await executor.resolveSha(b.item.repoPath, plan.tip.rev!)
  if (!sha) throw new Error(`could not resolve '${plan.tip.rev}' before removal`)
  await executor.archiveTip(b.item.repoPath, plan.tip.ref, sha)
  await executor.archiveWip(b.item.repoPath, plan.wip.ref, plan.wip.worktreePath!)
}

export function createForcedGcOps(deps: GcShellDeps): GcOps {
  // One stamp for the whole run: the archive step inside cleanItem then writes the very refs
  // written here instead of a second set.
  const at = deps.executor.now()
  const forcedDeps: GcShellDeps = {
    ...deps,
    executor: {
      ...deps.executor,
      now: () => at,
      // The executor's guards would refuse exactly what the operator confirmed removing. The
      // working state and the tip are already archived by `reprobe` below.
      probeStatus: async (path) => ({
        ...(await deps.executor.probeStatus(path)),
        trackedDirty: false
      }),
      hasUnpushed: async () => false,
      // `git branch -d` refuses an unmerged branch; its tip is archived, so -D loses nothing.
      git: (repo, args) =>
        deps.executor.git(
          repo,
          args[0] === 'branch' && args[1] === '-d' ? ['branch', '-D', ...args.slice(2)] : args
        )
    }
  }
  const base = createGcOps(forcedDeps)
  return {
    ...base,
    async reprobe(b) {
      const verdict = await base.reprobe(asExecutable(b))
      if (!verdict.ok) return verdict
      try {
        await preserve(b, deps, at)
      } catch (err) {
        // Nothing destructive has run: report it as a refusal, with the reason.
        return { ok: false, reason: `archive-failed: ${messageOf(err)}` }
      }
      return verdict
    },
    dropDeps: (b) => base.dropDeps(asExecutable(b)),
    cleanGit: (b) => base.cleanGit(asExecutable(b))
  }
}
