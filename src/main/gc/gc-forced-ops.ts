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
// What stays refused: a main checkout, a neverClean path, an in-use bundle and a worktree with a
// rebase or bisect in progress are turned away before these ops are even built or at the reprobe
// (autopilot-core `refusalFor`, gc-shell). A detached worktree is NOT one of them any more: with no
// branch to name its refs it is archived by its HEAD sha first (`refs/archive/detached/…`), with the
// commits only its reflog holds, and only on the operator's confirm.

import type { WorktreeBundle } from './bundle-core'
import { createGcOps, type GcShellDeps } from './gc-shell'
import type { GcOps } from './pipeline-core'
import { planArchive, type ArchivePlan, type ArchiveRefPlan } from '../reaper/archive-core'

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

/** What would be archived, read-only: throws (so refuses) when nothing could preserve the worktree. */
async function planPreserve(
  b: WorktreeBundle,
  deps: GcShellDeps,
  at: number
): Promise<{ plan: ArchivePlan; tip: ArchiveRefPlan; wip: ArchiveRefPlan; sha: string }> {
  const plan = planArchive(b.item, at)
  // A folder that would be removed with nothing preserving it is never removed.
  if (!plan.tip || !plan.wip) throw new Error('nothing would preserve this worktree')
  const sha = await deps.executor.resolveSha(b.item.repoPath, plan.tip.rev!)
  if (!sha) throw new Error(`could not resolve '${plan.tip.rev}' before removal`)
  return { plan, tip: plan.tip, wip: plan.wip, sha }
}

/**
 * Writes `refs/archive/<branch>/<stamp>/{tip,wip}`, or `refs/archive/detached/<folder>-<sha>/{tip,wip,reflog/*}`
 * for a detached worktree; throws, and so refuses, if it cannot.
 */
async function preserve(b: WorktreeBundle, deps: GcShellDeps, at: number): Promise<void> {
  const { plan, tip, wip, sha } = await planPreserve(b, deps, at)
  const { executor } = deps
  // Commits only a detached HEAD's reflog reaches go with the folder: keep them reachable too. First,
  // because it is the one step that can refuse for size, and a refusal leaves no tip or wip behind.
  if (b.item.kind === 'detached-worktree' && plan.namespace && b.item.path) {
    await executor.archiveReflog(b.item.repoPath, `${plan.namespace}/reflog`, b.item.path)
  }
  await executor.archiveTip(b.item.repoPath, tip.ref, sha)
  await executor.archiveWip(b.item.repoPath, wip.ref, wip.worktreePath!)
}

/** The shell deps the force path runs on: the executor's dirty / unpushed / merged guards waived. */
function forcedShellDeps(deps: GcShellDeps, at: number): GcShellDeps {
  return {
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
}

/**
 * The reprobe a guided action's DRY RUN uses: the very one the confirmed remove will run (the review
 * path with its guards waived, or the ordinary one), but read-only, so it never writes the archive refs
 * the real reprobe writes. A dry run that judged by stricter rules would refuse what the remove accepts.
 */
export function createDryReprobe(
  deps: GcShellDeps,
  forced: boolean
): (b: WorktreeBundle) => ReturnType<GcOps['reprobe']> {
  if (!forced) {
    const ops = createGcOps(deps)
    return (b) => ops.reprobe(b)
  }
  const at = deps.executor.now()
  const base = createGcOps(forcedShellDeps(deps, at))
  return async (b) => {
    const verdict = await base.reprobe(asExecutable(b))
    if (!verdict.ok) return verdict
    // The real reprobe archives before anything destructive; if that would fail, say so NOW, before a
    // guided action has parked a session it cannot un-park.
    try {
      await planPreserve(b, deps, at)
    } catch (err) {
      return { ok: false, reason: `archive-failed: ${messageOf(err)}` }
    }
    return verdict
  }
}

export function createForcedGcOps(deps: GcShellDeps): GcOps {
  // One stamp for the whole run: the archive step inside cleanItem then writes the very refs
  // written here instead of a second set.
  const at = deps.executor.now()
  const forcedDeps = forcedShellDeps(deps, at)
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
