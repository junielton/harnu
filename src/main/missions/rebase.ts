/**
 * Missions v4 S-27 (AC-70) — `rebase_stack` for the mission's LEADER.
 *
 * The verb used to be the steward's routine move. It is the leader's now: `git rebase --onto <onto>
 * <from|onto>` in the linked worktree of one of the mission's steps, and nothing else.
 *
 *  - Only the session that leads the mission may ask (`guardMission` with the `lead` need). A Harnu
 *    system worker reads and never writes, so it is refused `READ_ONLY` like any other write.
 *  - Only a step's OWN worktree is rebased. A worktree being linked on a step proves little (a step may
 *    link a sibling it only reads), so ownership needs evidence: the branch of the step's dispatched
 *    card, or else a worktree no other step of any open mission links, off the trunk branches.
 *  - It never pushes. It rewrites the step's own LOCAL branch and says `pushed: false`; publishing the
 *    rewrite is the leader's move, so no code path here can move a remote ref.
 *  - It writes no mission file. A conflict aborts the rebase (the git core verifies the tree is exactly
 *    as it was) and is refused `REBASE_CONFLICT`; raising a blocker on the step is the leader's call
 *    (`mission_set_blocker`), not something this module writes behind its back.
 *
 * The git mechanics are `steward-rebase.ts`'s (kept until S-38 moves them); this module owns who may
 * ask and which worktree. Electron-free: the card lookup and the other missions come in as `deps`.
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { linkPath } from './derive'
import { guardMission, type Actor } from './guard'
import type { MissionV4, StepV4 } from './model'
import { currentBranch, rebaseStack, repoCommonDir, worktreeToplevel } from '../steward-rebase'

export interface RebaseV4Deps {
  /** The branch Harnu stamped on a card when it dispatched it (`executedIn`), or undefined. */
  executedIn: (cardSlug: string) => Promise<string | undefined>
  /** Every OTHER open mission of the repo, to tell whether a worktree is claimed by one step alone. */
  otherOpenMissions: () => Promise<MissionV4[]>
}

export interface RebaseV4Input {
  /** The repo root (never a worktree): relative `worktree` links resolve from it. */
  root: string
  record: MissionV4
  actor: Actor
  onto: string
  from?: string
  stepId?: string
}

export type RebaseV4Result =
  | {
      ok: true
      ack: {
        ok: true
        op: 'rebase_stack'
        stepId: string
        branch: string
        before: string
        after: string
        rebased: boolean
        pushed: false
      }
    }
  | { ok: false; error: string }

const fail = (error: string): RebaseV4Result => ({ ok: false, error })

/** The checkouts (never the main one) a step's `worktree` links resolve to. */
async function stepWorktrees(root: string, step: StepV4): Promise<string[]> {
  const found = new Set<string>()
  for (const l of step.links) {
    if (l.kind !== 'worktree') continue
    const p = linkPath(root, l.ref)
    const st = await fs.stat(p).catch(() => null)
    if (!st) continue
    const top = await worktreeToplevel(st.isDirectory() ? p : path.dirname(p))
    if (top) found.add(top)
  }
  return [...found]
}

/** Why `worktree` is NOT `step`'s own (a reason), or `null` when it is. */
async function foreignReason(
  input: RebaseV4Input,
  deps: RebaseV4Deps,
  step: StepV4,
  worktree: string
): Promise<string | null> {
  const branch = await currentBranch(worktree)
  if (branch === 'main' || branch === 'master') return `it is on ${branch}`
  if (step.card) {
    const owned = await deps.executedIn(step.card)
    if (owned) {
      return branch === owned
        ? null
        : `its branch ${branch ?? '(detached)'} is not the branch ${owned} the step's card was dispatched to`
    }
  }
  const missions = [input.record, ...(await deps.otherOpenMissions())].filter(
    (m) => m.status !== 'closed'
  )
  for (const m of missions) {
    for (const s of m.steps) {
      if (m.id === input.record.id && s.id === step.id) continue
      if ((await stepWorktrees(input.root, s)).includes(worktree)) {
        return `${m.id === input.record.id ? s.id : `${m.id}/${s.id}`} links it too, and nothing names which branch is this step's`
      }
    }
  }
  return null
}

export async function rebaseStackV4(
  input: RebaseV4Input,
  deps: RebaseV4Deps
): Promise<RebaseV4Result> {
  const { root, record, onto, from, stepId } = input
  const access = guardMission(record, input.actor, 'lead')
  if (!access.ok) return fail(access.error)

  const pool = stepId ? record.steps.filter((s) => s.id === stepId) : record.steps
  if (stepId && pool.length === 0) {
    return fail(`STEP_NOT_FOUND: ${record.id} has no step ${stepId}.`)
  }
  const repoDir = await repoCommonDir(root)
  // Fail CLOSED: if the mission's own repository cannot be identified, no worktree can be shown to
  // belong to it, so nothing is rebased.
  if (!repoDir) {
    return fail(
      `WORKTREE_NOT_IN_REPO: could not identify the repository of ${root}, so no worktree can be shown to belong to it — rebase_stack rebases nothing.`
    )
  }

  const candidates: Array<{ step: StepV4; worktree: string }> = []
  for (const step of pool) {
    for (const wt of await stepWorktrees(root, step)) {
      if (wt === root) continue // never the main checkout: the rebase core would refuse it anyway
      if ((await repoCommonDir(wt)) !== repoDir) {
        return fail(
          `WORKTREE_NOT_IN_REPO: ${wt}, linked on ${step.id}, belongs to a different repository than this mission — rebase_stack only rebases this repo's own worktrees.`
        )
      }
      candidates.push({ step, worktree: wt })
    }
  }
  if (candidates.length === 0) {
    return fail(
      `NO_STEP_WORKTREE: ${stepId ?? 'no step of this mission'} links a worktree — mission_link { kind: 'worktree', ref: <path> } the step's worktree first.`
    )
  }

  const own: typeof candidates = []
  const foreign: string[] = []
  for (const c of candidates) {
    const why = await foreignReason(input, deps, c.step, c.worktree)
    if (why) foreign.push(`${c.worktree} (${why})`)
    else own.push(c)
  }
  if (own.length === 0) {
    return fail(
      `NOT_STEP_WORKTREE: none of the worktrees linked on ${stepId ?? 'the steps'} is this step's own — ${foreign.join('; ')}. rebase_stack rewrites only a step's own branch.`
    )
  }
  if (own.length > 1) {
    return fail(
      `STEP_AMBIGUOUS: several steps link a worktree (${own.map((c) => `${c.step.id} → ${c.worktree}`).join('; ')}) — pass stepId.`
    )
  }
  const { step, worktree } = own[0]

  const res = await rebaseStack({ worktree, onto, ...(from ? { from } : {}) })
  if (res.ok) {
    return {
      ok: true,
      ack: {
        ok: true,
        op: 'rebase_stack',
        stepId: step.id,
        branch: res.branch,
        before: res.before,
        after: res.after,
        rebased: res.rebased,
        // The local branch moved; no remote ref did. Publishing is the leader's move.
        pushed: false
      }
    }
  }
  if (res.code === 'REBASE_CONFLICT') {
    return fail(
      `REBASE_CONFLICT: rebase of ${res.branch} onto ${onto} conflicted in ${res.conflicts.join(', ')}. The rebase was aborted and ${worktree} is exactly as it was (HEAD ${res.head}). Do not retry: resolve it by hand or raise a blocker with mission_set_blocker and tell the operator.`
    )
  }
  return fail(`${res.code}: ${res.detail}`)
}
