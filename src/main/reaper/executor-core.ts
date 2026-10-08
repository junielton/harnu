// Pure executor core for the Reaper cleanup engine: the guarded, idempotent
// per-item deletion pipeline, run over injected I/O dependencies.

import { overridesAncestryCheck, type ReapItem } from './reaper-core'
import type { WorktreeStatus } from '../worktree-core'
import { isAbsolute, resolve } from 'node:path'
import { planArchive } from './archive-core'
import { restoreHintFor, type Tombstone } from './journal'

export type CleanStepId =
  | 'guard'
  | 'archive'
  | 'trash-folder'
  | 'worktree-prune'
  | 'branch-delete'
  | 'remote-delete'
  | 'sidebar-detach'
  | 'journal'

export interface CleanStepResult {
  id: CleanStepId
  ok: boolean
  skipped: boolean
  error?: string
}

export interface CleanResult {
  itemId: string
  ok: boolean
  steps: CleanStepResult[]
}

export interface ExecutorDeps {
  /**
   * Re-probes the worktree's status at sweep time, split into tracked
   * modifications and untracked paths (BUG-75). Deliberately NOT a boolean
   * `isDirty`: the guard below refuses on `trackedDirty` only, and a dep typed
   * as a bare boolean is exactly how the classifier fix would have been
   * cancelled out here — every row the classifier newly frees would have failed
   * at "dirty on re-probe" instead.
   */
  probeStatus(path: string): Promise<WorktreeStatus>
  hasUnpushed(path: string): Promise<boolean>
  trash(path: string): Promise<void>
  git(repoPath: string, args: string[]): Promise<string>
  resolveSha(repoPath: string, rev: string): Promise<string | null>
  /** Points an archive ref at an already-resolved commit sha. */
  archiveTip(repoPath: string, ref: string, sha: string): Promise<string>
  /** Captures a worktree's tracked + untracked working state and points `ref` at it. */
  archiveWip(repoPath: string, ref: string, worktreePath: string): Promise<string>
  detachSidebar(path: string): Promise<void>
  /**
   * Unregisters exactly this worktree from git: removes its own admin directory, found by the
   * `gitdir` file that points at `worktreePath`. Never a repo-wide `git worktree prune`, which
   * also drops the registration of every unlocked worktree whose folder is merely missing, an
   * unmounted drive for instance, and so can lose a live worktree's metadata unattended.
   */
  removeWorktreeAdmin(repoPath: string, worktreePath: string): Promise<boolean>
  /**
   * Whether {@link removeWorktreeAdmin} can find this worktree's own admin directory: exactly
   * one unlocked match. Asked BEFORE the folder is trashed, while git can still be asked to do
   * it instead; false means the unregistration would otherwise be skipped.
   */
  canUnregister(repoPath: string, worktreePath: string): Promise<boolean>
  appendTombstone(t: Tombstone): Promise<void>
  now(): number
}

const slashes = (p: string): string =>
  p
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '')

/**
 * The admin directory of the worktree at `worktreePath`, from the entries of
 * `<common>/worktrees/*`: the one whose `gitdir` file points at `<worktreePath>/.git`. Null
 * when none does, or when more than one does: an ambiguous match is left alone.
 */
export function matchAdminDir(
  entries: ReadonlyArray<{ dir: string; gitdir: string }>,
  worktreePath: string
): string | null {
  const target = `${slashes(worktreePath)}/.git`
  // A gitdir can be written relative to its admin dir (git 2.48 `worktree.useRelativePaths`).
  const absolute = (e: { dir: string; gitdir: string }): string => {
    const g = e.gitdir.trim()
    return isAbsolute(g) || /^[A-Za-z]:[\\/]/.test(g) ? g : resolve(e.dir, g)
  }
  const hits = entries.filter((e) => slashes(absolute(e)) === target)
  return hits.length === 1 ? hits[0]!.dir : null
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export async function cleanItem(
  item: ReapItem,
  opts: { deleteRemote: boolean },
  deps: ExecutorDeps
): Promise<CleanResult> {
  const steps: CleanStepResult[] = []
  const hasFolder = item.kind === 'worktree' || item.kind === 'hidden-folder'
  const hasLocalBranch = item.kind !== 'remote-branch' && !!item.branch

  if (item.verdict !== 'harvestable') {
    steps.push({
      id: 'guard',
      ok: false,
      skipped: false,
      error: `verdict is '${item.verdict}', not harvestable`
    })
    return { itemId: item.id, ok: false, steps }
  }

  if (hasFolder && item.path) {
    // Re-probes hit Git and can fail (error/timeout); a throw here would escape
    // and abort the whole sweep. Contain it as a failed guard for this item.
    let status: WorktreeStatus
    try {
      status = await deps.probeStatus(item.path)
    } catch (err) {
      steps.push({
        id: 'guard',
        ok: false,
        skipped: false,
        error: `dirty re-probe failed: ${errorMessage(err)}`
      })
      return { itemId: item.id, ok: false, steps }
    }
    // Untracked paths present at the last scan were disclosed in the confirm
    // dialog; any created since were not — the view rescans only when it holds
    // no cached snapshot, so on a stale one that disclosure can name none of
    // them. Either way the archive step preserves them to the wip ref, which is
    // what makes not-refusing safe here. Closing the window means a new refusal
    // path in this executor — carded as BUG-123, deliberately not done here.
    if (status.trackedDirty) {
      steps.push({ id: 'guard', ok: false, skipped: false, error: 'dirty on re-probe' })
      return { itemId: item.id, ok: false, steps }
    }
    // A merged signal waives the unpushed re-probe — the commits are provably
    // in the default branch even if the upstream was deleted in the meantime.
    if (item.justifiedBy === null) {
      let unpushed: boolean
      try {
        unpushed = await deps.hasUnpushed(item.path)
      } catch (err) {
        steps.push({
          id: 'guard',
          ok: false,
          skipped: false,
          error: `unpushed re-probe failed: ${errorMessage(err)}`
        })
        return { itemId: item.id, ok: false, steps }
      }
      if (unpushed) {
        steps.push({ id: 'guard', ok: false, skipped: false, error: 'unpushed on re-probe' })
        return { itemId: item.id, ok: false, steps }
      }
    }
  }
  steps.push({ id: 'guard', ok: true, skipped: false })

  let sha: string | null = null
  // A holder, not two `let`s: these are assigned inside the archive step's
  // closure, and only a ref that was actually written may reach the tombstone.
  const archived: { tip: string | null; wip: string | null } = { tip: null, wip: null }
  let halted = false

  const run = async (
    id: CleanStepId,
    applies: boolean,
    action: () => Promise<void>
  ): Promise<void> => {
    if (halted) return
    if (!applies) {
      steps.push({ id, ok: true, skipped: true })
      return
    }
    try {
      await action()
      steps.push({ id, ok: true, skipped: false })
    } catch (err) {
      steps.push({ id, ok: false, skipped: false, error: errorMessage(err) })
      halted = true
    }
  }

  // T254 — preserve before sweeping. What gets archived is decided purely
  // (`planArchive`); the git that writes it lives in `archive-shell.ts`.
  const plan = planArchive(item, deps.now())

  // Fail-closed backstop for AC-1: an item that would delete something but for
  // which the planner preserves nothing must abort, not sweep unarchived. No
  // item shape reaches this today (every folder item carries a branch); a
  // future one — a detached worktree, say — has to fail loudly here rather than
  // slip past the archive because it did not fit the plan.
  const unpreserved: string[] = []
  if (hasFolder && !plan.wip) unpreserved.push('working state')
  if ((hasLocalBranch || item.kind === 'remote-branch') && !plan.tip) {
    unpreserved.push('branch tip')
  }
  if (unpreserved.length > 0) {
    steps.push({
      id: 'archive',
      ok: false,
      skipped: false,
      error: `nothing would preserve this item's ${unpreserved.join(' or ')}`
    })
    halted = true
  }

  // Resolve and REQUIRE the tip's commit SHA before deleting anything. The
  // tombstone's restore hint must never be recorded with sha:null — a
  // `branch -d` (or trashed worktree) would otherwise be unrecoverable — and
  // the tip ref cannot be written without it either. A `remote-branch` item
  // resolves its remote-tracking ref here: if the objects were never fetched,
  // the item aborts instead of dropping a branch it cannot preserve.
  if (!halted && plan.tip?.rev) {
    let resolveError: string | null = null
    try {
      sha = await deps.resolveSha(item.repoPath, plan.tip.rev)
    } catch (err) {
      resolveError = errorMessage(err)
    }
    if (resolveError !== null || !sha) {
      sha = null
      steps.push({
        id: 'archive',
        ok: false,
        skipped: false,
        error:
          resolveError !== null
            ? `resolve sha failed: ${resolveError}`
            : `could not resolve '${plan.tip.rev}' before deletion`
      })
      halted = true
    }
  }

  // The archive step gates every destructive step below it: `run` sets `halted`
  // on any throw, and a halted pipeline never trashes a folder or deletes a
  // branch. A ref name is recorded only after its write returned, so a
  // tombstone never claims a ref that does not exist.
  await run('archive', plan.refs.length > 0, async () => {
    if (plan.tip) {
      await deps.archiveTip(item.repoPath, plan.tip.ref, sha!)
      archived.tip = plan.tip.ref
    }
    if (plan.wip) {
      await deps.archiveWip(item.repoPath, plan.wip.ref, plan.wip.worktreePath!)
      archived.wip = plan.wip.ref
    }
  })

  // When the worktree's own admin dir cannot be matched (a gitdir in a form we cannot read, an
  // ambiguous match, a locked worktree), asking git to remove it is the only way to unregister
  // it without a repo-wide prune, and it can only be done while the folder still exists. If git
  // refuses too, the item halts here, before anything was trashed, with git's own reason.
  let removedByGit = false
  await run('trash-folder', hasFolder, async () => {
    if (!(await deps.canUnregister(item.repoPath, item.path!))) {
      await deps.git(item.repoPath, ['worktree', 'remove', '--force', item.path!])
      removedByGit = true
      return
    }
    await deps.trash(item.path!)
  })

  // The step keeps its id for the journal and the pipeline, but it only unregisters THIS
  // worktree now (see ExecutorDeps.removeWorktreeAdmin). Never a silent skip: a registration
  // that cannot be found after the trash is a failed step.
  await run('worktree-prune', hasFolder, async () => {
    if (removedByGit) return
    if ((await deps.removeWorktreeAdmin(item.repoPath, item.path!)) === false) {
      throw new Error("could not find this worktree's registration in git to remove")
    }
  })

  await run('branch-delete', hasLocalBranch, async () => {
    // `-d` by default — a merged-ness guard by design (see the plan's global
    // constraints). But `-d` does its own ancestry check, which squash merges
    // defeat; when the verdict was proven independently of that check, retry
    // with `-D` on that exact refusal instead of leaving a provably-merged
    // branch undeleted.
    //
    // Which signals qualify is DERIVED from the union, never restated here.
    // Restating it is BUG-46: a signal added to `MergeSignal` fell outside the
    // local `||` chain, so every row carrying it classified `harvestable`, was
    // offered to the user, and threw at this exact line — with every classifier
    // test green, because nothing typed connected the two files.
    const retryableSignal = overridesAncestryCheck(item.justifiedBy)
    try {
      await deps.git(item.repoPath, ['branch', '-d', item.branch!])
    } catch (err) {
      if (!retryableSignal || !errorMessage(err).includes('not fully merged')) throw err
      await deps.git(item.repoPath, ['branch', '-D', item.branch!])
    }
  })

  await run('remote-delete', opts.deleteRemote && item.needsRemoteDelete, async () => {
    // Lease-guard the deletion against the OID observed at scan time: if the
    // remote branch moved since, the push is rejected instead of dropping
    // commits pushed in the meantime. Fall back to a plain delete only when the
    // scan couldn't capture the remote OID.
    const lease = item.remoteSha
    const args = lease
      ? ['push', 'origin', `--force-with-lease=${item.branch!}:${lease}`, '--delete', item.branch!]
      : ['push', 'origin', '--delete', item.branch!]
    await deps.git(item.repoPath, args)
  })

  await run('sidebar-detach', hasFolder, async () => {
    await deps.detachSidebar(item.path!)
  })

  const deleted = steps.filter((s) => s.ok && !s.skipped && s.id !== 'guard').map((s) => s.id)

  const tombstone: Tombstone = {
    at: deps.now(),
    repoPath: item.repoPath,
    kind: item.kind,
    branch: item.branch ?? null,
    sha,
    deleted,
    justifiedBy: item.justifiedBy,
    restoreHint: restoreHintFor(item.branch ?? null, sha),
    archiveTipRef: archived.tip,
    archiveWipRef: archived.wip
  }
  // appendTombstone propagates append failures; a lost restore record is a
  // failed step and fails the overall result.
  try {
    await deps.appendTombstone(tombstone)
    steps.push({ id: 'journal', ok: true, skipped: false })
  } catch (err) {
    steps.push({ id: 'journal', ok: false, skipped: false, error: errorMessage(err) })
    halted = true
  }

  return { itemId: item.id, ok: !halted, steps }
}

export async function sweep(
  items: ReapItem[],
  opts: { deleteRemote: boolean },
  deps: ExecutorDeps,
  onProgress?: (r: CleanResult) => void
): Promise<CleanResult[]> {
  const results: CleanResult[] = []
  for (const item of items) {
    const result = await cleanItem(item, opts, deps)
    results.push(result)
    onProgress?.(result)
  }
  return results
}
