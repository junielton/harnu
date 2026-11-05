// The shelve half of the cleanup cycle (autonomous cleanup U2.2, design §4 U2, §5, C1).
//
// Every tick, after the clean: find the worktrees whose branch is not proven merged and that have
// been idle past the threshold, and shelve them (preserve, verify, free the disk, keep the branch).
// It has its OWN switch and its OWN report-only first cycle, so an operator who already runs the
// autopilot gets nothing new until they turn this on and have seen what it would take.
//
// Guardrails (§5): a per-cycle cap, a per-repo lock around each shelve, a kill switch after a
// streak of failures, every action bound to the facts it was decided on (the executor re-probes),
// and one journal entry per shelve. Nothing here treats a shelved folder as removed.
//
// Every effect is an injected dep, so the cycle is unit-tested with fakes in
// tests/gc-shelve-cycle.test.ts.

import * as path from 'node:path'
import type { WorktreeBundle } from './bundle-core'
import { formatBytes, type CycleState } from './gc-cycle'
import type { GcPrefs } from './gc-prefs'
import type { JobQueue } from './gc-jobs-core'
import type { GcItemResult, GcStep } from './pipeline-core'
import type { ShelveCycleRecord, ShelvedSummary } from './gc-wire'
import type { RepoLockResult } from './repo-lock-shell'
import { shelveCandidate, shelveVerdict, type ShelveProbe } from './shelve-eligibility-core'
import type { ShelveDecision, ShelveOutcome } from './shelve-exec-shell'
import type { Tombstone } from '../reaper/journal'

const DAY_MS = 86_400_000
const plural = (n: number, one: string, many = `${one}s`): string => (n === 1 ? one : many)

/** How long a worktree a shelve was refused or failed for is left alone before it is tried again. */
export const SHELVE_FAILURE_TTL_MS = DAY_MS

const NOTICE_TITLE = 'Workspace cleanup'

export interface ShelveCycleDeps {
  prefs(): GcPrefs
  /** Folders a session drifted into (C4); a worktree any of them lies in is not shelved. */
  driftedCwds(): readonly string[]
  /** What the worktree itself says right now (HEAD, work fingerprint, last commit…). */
  probe(b: WorktreeBundle): Promise<ShelveProbe>
  /** Shelves one decided worktree (the executor). Never throws. */
  shelve(d: ShelveDecision): Promise<ShelveOutcome>
  /** One shelve at a time per repository, across Harnu instances. */
  lock<T>(repoPath: string, work: () => Promise<T>): Promise<RepoLockResult<T>>
  queue: JobQueue
  journal(t: Tombstone): Promise<void>
  /** The kill switch: persists `shelve.enabled = false`. */
  disableShelving(): Promise<void>
  notify(n: { title: string; body: string }): void
  now(): number
}

const empty = (mode: ShelveCycleRecord['mode']): ShelveCycleRecord => ({
  mode,
  found: 0,
  foundBytes: 0,
  shelved: [],
  refused: 0,
  failed: 0,
  deferred: 0,
  paused: false,
  locked: 0,
  journalFailed: 0
})

/** Oldest sign of life first; no sign of life sorts last (least certain). */
const bySignOfLife = (a: WorktreeBundle, b: WorktreeBundle): number => {
  if (a.lastSignOfLifeAt === b.lastSignOfLifeAt) return 0
  if (a.lastSignOfLifeAt === null) return 1
  if (b.lastSignOfLifeAt === null) return -1
  return a.lastSignOfLifeAt - b.lastSignOfLifeAt
}

/** Values that are already safe as one shell word; anything else is quoted (as journal.ts does). */
const SHELL_SAFE = /^[A-Za-z0-9,._+:@%/-]+$/
const quote = (v: string): string => (SHELL_SAFE.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`)

/** A refusal is the world moving or a limit being reached; it is not a failure of shelving. */
function isRefusal(o: Extract<ShelveOutcome, { ok: false }>): boolean {
  if (o.step === 'reprobe' || o.step === 'in-use') return true
  if (o.step === 'unregister' && !o.folderRemoved) return true
  return (
    o.step === 'preserve' && (o.reason === 'snapshot-too-large' || o.reason === 'nested-repository')
  )
}

/** The nearest existing step name, for the shared job UI. */
const STEP_OF: Record<Extract<ShelveOutcome, { ok: false }>['step'], GcStep> = {
  reprobe: 'reprobe',
  'in-use': 'reprobe',
  preserve: 'archive',
  verify: 'archive',
  remember: 'archive',
  remove: 'trash',
  unregister: 'prune'
}

interface Judged {
  b: WorktreeBundle
  decision: ShelveDecision
}

export async function runShelveCycle(
  deps: ShelveCycleDeps,
  bundles: readonly WorktreeBundle[],
  state: CycleState
): Promise<ShelveCycleRecord> {
  const prefs = deps.prefs()
  if (!prefs.shelve.enabled) return empty('off')
  const now = deps.now()
  const ctx = { prefs, driftedCwds: deps.driftedCwds() }

  for (const [id, note] of state.shelveFailures) {
    if (now - note.at >= SHELVE_FAILURE_TTL_MS) state.shelveFailures.delete(id)
  }

  // Cheap bundle rules first, so no git call is spent on a worktree that can never qualify.
  const candidates = bundles
    .filter((b) => shelveCandidate(b, ctx) === null && !state.shelveFailures.has(b.item.id))
    .sort(bySignOfLife)

  const judged: Judged[] = []
  for (const b of candidates) {
    let probe: ShelveProbe
    try {
      probe = await deps.probe(b)
    } catch {
      continue
    }
    const v = shelveVerdict(b, probe, { ...ctx, now })
    if (!v.eligible) continue
    judged.push({
      b,
      decision: {
        id: b.item.id,
        repoPath: b.item.repoPath,
        worktreePath: b.item.path as string,
        branch: b.item.kind === 'detached-worktree' ? null : (b.item.branch ?? null),
        binding: {
          headSha: probe.headSha,
          workStamp: probe.workStamp,
          newestMtime: probe.newestMtime
        },
        since: v.since,
        idleDays: Math.floor(v.idleMs / DAY_MS),
        diskBytes: b.item.diskBytes ?? null
      }
    })
  }
  const foundBytes = judged.reduce((sum, j) => sum + (j.b.item.diskBytes ?? 0), 0)

  if (!prefs.shelve.firstReportAcknowledged) {
    const key = String(judged.length)
    if (judged.length > 0 && key !== state.shelveReportKey) {
      deps.notify({
        title: NOTICE_TITLE,
        body: `Found ${judged.length} idle ${plural(judged.length, 'worktree')} that would be shelved (branches kept), ${formatBytes(foundBytes)}.`
      })
    }
    state.shelveReportKey = key
    return { ...empty('report'), found: judged.length, foundBytes }
  }
  state.shelveReportKey = null

  const record: ShelveCycleRecord = {
    ...empty('shelve'),
    found: judged.length,
    foundBytes,
    deferred: Math.max(0, judged.length - prefs.shelve.maxPerCycle)
  }
  const batch = judged.slice(0, prefs.shelve.maxPerCycle)
  if (batch.length === 0) return record

  const submitted = deps.queue.submit(
    'autopilot',
    batch.map((j) => j.decision.id),
    async (reporter) => {
      const results: GcItemResult[] = []
      for (const { decision } of batch) {
        if (state.shelveStreak >= prefs.shelve.failureLimit) break
        reporter.onStart(decision.id)
        let result: GcItemResult
        const locked = await deps.lock(decision.repoPath, () => deps.shelve(decision))
        if (!locked.ok) {
          record.locked++
          result = {
            id: decision.id,
            ok: false,
            haltedAt: 'reprobe',
            error: locked.reason === 'locked' ? 'repo-locked' : locked.message,
            freedBytes: 0
          }
        } else if (locked.value.ok) {
          const outcome = locked.value
          state.shelveStreak = 0
          state.shelveFailures.delete(decision.id)
          const summary: ShelvedSummary = {
            id: decision.id,
            branch: decision.branch,
            folderAlias: path.basename(decision.worktreePath) || decision.worktreePath,
            folderPath: decision.worktreePath,
            idleDays: decision.idleDays,
            freedBytes: outcome.entry.freedBytes
          }
          record.shelved.push(summary)
          try {
            await deps.journal(tombstoneOf(decision, outcome, deps.now()))
          } catch (err) {
            record.journalFailed++
            console.warn(
              '[gc] could not journal a shelve',
              err instanceof Error ? err.message : err
            )
          }
          result = {
            id: decision.id,
            ok: true,
            haltedAt: null,
            freedBytes: outcome.entry.freedBytes ?? 0
          }
        } else {
          const outcome = locked.value
          state.shelveFailures.set(decision.id, { at: deps.now(), reason: outcome.reason })
          if (isRefusal(outcome)) {
            record.refused++
          } else {
            record.failed++
            state.shelveStreak++
            console.warn('[gc] shelve failed', decision.id, outcome.step, outcome.reason)
          }
          result = {
            id: decision.id,
            ok: false,
            haltedAt: STEP_OF[outcome.step],
            error: `${outcome.reason}: ${outcome.message}`,
            freedBytes: 0
          }
        }
        results.push(result)
        reporter.onItem(result)
      }
      return results
    }
  )
  await submitted.finished

  if (state.shelveStreak >= prefs.shelve.failureLimit) {
    record.paused = true
    state.shelveStreak = 0
    try {
      await deps.disableShelving()
    } catch (err) {
      console.warn('[gc] could not switch shelving off', err instanceof Error ? err.message : err)
    }
    deps.notify({
      title: NOTICE_TITLE,
      body: `Shelving paused itself after ${prefs.shelve.failureLimit} failures in a row. Nothing was lost: every worktree it touched still verifies. Turn it back on once the cause is fixed.`
    })
  }
  if (record.shelved.length > 0) {
    const n = record.shelved.length
    const freed = record.shelved.reduce((sum, s) => sum + (s.freedBytes ?? 0), 0)
    deps.notify({
      title: NOTICE_TITLE,
      body: `Shelved ${n} ${plural(n, 'worktree')}, ${formatBytes(freed)}. Branches and their work are kept.`
    })
  }
  return record
}

function tombstoneOf(
  d: ShelveDecision,
  outcome: Extract<ShelveOutcome, { ok: true }>,
  at: number
): Tombstone {
  const { record } = outcome
  return {
    at,
    repoPath: d.repoPath,
    kind: 'shelved-worktree',
    branch: d.branch,
    sha: record.headSha,
    deleted: [d.worktreePath],
    justifiedBy: null,
    restoreHint: `git -C ${quote(d.repoPath)} worktree add ${quote(d.worktreePath)} ${quote(d.branch ?? record.tipRef)}`,
    archiveTipRef: record.tipRef,
    archiveWipRef: record.wipRef,
    actor: 'autopilot'
  }
}
