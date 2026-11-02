/**
 * Campaign ch.5b (T609, spec §4) — the Merge batch door, over `mission:mergeBatch`.
 *
 * The operator confirmed "merge #A → #B → #C in order" in the Campaign popover. This is the
 * env-bound half of the sequencer in `merge-batch-core.ts`: it validates that every PR belongs to
 * the mission, reads and merges through `gh` (injectable — the tests run a fake), runs the steward
 * between merges, and leaves one Log entry saying how far it got. No MCP verb reaches this module
 * (pinned by tests/merge-batch-door.test.ts): merging is the operator's.
 *
 * It runs outside the per-mission lock — a batch takes minutes, and holding the lock would freeze
 * every other door — and takes the lock only to append its Log entry.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ipcMain } from 'electron'
import { spawnEnvOnce } from './appimage-env'
import { atomicWriteFile } from './mcp/atomic-write'
import { buildMissionFileContent, withMissionIdMintLock } from './mission-core'
import {
  ciOfRollup,
  pickMergeMethod,
  runMergeBatch,
  type BatchPrFacts,
  type MergeBatchDeps,
  type MergeBatchOutcome,
  type RepoMergeFlags,
  type StewardTurn
} from './merge-batch-core'
import { deriveMissionSignals, loadMission, missionRoot } from './mcp/tool-handlers'
import { runStewardTurn } from './scheduler-shell'

const execFileAsync = promisify(execFile)

/** How long the batch waits for the steward's tick between merges, and for gates to settle after it. */
const STEWARD_TURN_TIMEOUT_MS = 5 * 60_000
const SETTLE_TIMEOUT_MS = 5 * 60_000
const POLL_MS = 10_000

export type MergeBatchDoorArgs = { root: string; missionId: string; prs: number[] }

export type MergeBatchResult =
  { ok: true; outcome: MergeBatchOutcome } | { ok: false; error: string }

/** Everything the door touches outside itself, so a test can substitute a fake GitHub. */
export interface MergeBatchEnv {
  /** Run `gh <args>` in `cwd`; resolves stdout, rejects with the CLI's own message. */
  gh(args: readonly string[], cwd: string): Promise<string>
  /** PR numbers the mission's steps own (links and resolved worktree/card PRs). */
  missionPrs(
    root: string,
    missionId: string
  ): Promise<{ ok: true; prs: Set<number> } | { ok: false; error: string }>
  stewardTurn(missionId: string): Promise<StewardTurn>
  sleep(ms: number): Promise<void>
  now(): number
  clock: () => string
  timing: { settleTimeoutMs: number; pollMs: number }
}

async function realGh(args: readonly string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('gh', [...args], {
      cwd,
      encoding: 'utf8',
      env: await spawnEnvOnce(),
      timeout: 60_000,
      windowsHide: true,
      maxBuffer: 1 << 22
    })
    return stdout
  } catch (err) {
    const e = err as { stderr?: string; message?: string }
    throw new Error((e.stderr || e.message || 'gh failed').toString().trim().split('\n')[0])
  }
}

async function realMissionPrs(
  root: string,
  missionId: string
): Promise<{ ok: true; prs: Set<number> } | { ok: false; error: string }> {
  const loaded = await loadMission(root, missionId)
  if (!loaded.ok) return loaded
  if (loaded.mission.status === 'closed') {
    return { ok: false, error: `MISSION_CLOSED: mission ${missionId} was closed by the operator.` }
  }
  const { derived } = await deriveMissionSignals(
    root,
    loaded.mission,
    loaded.log,
    { folder: root, folders: [], denyFolders: [], bridge: undefined },
    Date.now(),
    { prWaitMs: 4000 }
  )
  const prs = new Set<number>()
  for (const st of derived.steps) if (st.prNumber !== null) prs.add(st.prNumber)
  return { ok: true, prs }
}

const realEnv: MergeBatchEnv = {
  gh: realGh,
  missionPrs: realMissionPrs,
  stewardTurn: (missionId) => runStewardTurn(missionId, STEWARD_TURN_TIMEOUT_MS),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
  clock: () => new Date().toISOString(),
  timing: { settleTimeoutMs: SETTLE_TIMEOUT_MS, pollMs: POLL_MS }
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text)
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function readPrFacts(text: string): BatchPrFacts | null {
  const v = parseJson(text)
  if (!v) return null
  const state = v.state
  if (state !== 'OPEN' && state !== 'MERGED' && state !== 'CLOSED') return null
  const rollup = Array.isArray(v.statusCheckRollup)
    ? (v.statusCheckRollup as Array<Record<string, unknown>>)
    : []
  return { state, draft: v.isDraft === true, ci: ciOfRollup(rollup) }
}

/** The Log line the batch leaves: how far it got, and why it stopped. */
function batchLogEntry(at: string, out: MergeBatchOutcome): string {
  const list = (ns: readonly number[]): string => ns.map((n) => `#${n}`).join(', ')
  const head = out.stop
    ? `operator merge batch: merged ${out.merged.length ? list(out.merged) : 'nothing'} — stopped at #${out.stop.at} (${out.stop.reason})`
    : `operator merge batch: merged ${list(out.merged)} in order`
  const body = [
    out.stop ? out.stop.detail : '',
    out.remaining.length ? `Still to merge: ${list(out.remaining)}.` : '',
    out.steward.length ? `Steward turns: ${out.steward.join(', ')}.` : ''
  ]
    .filter(Boolean)
    .join('\n')
  return `\n### ${at} · ${head}\n${body ? `\n${body}\n` : ''}`
}

/**
 * Run one merge batch. Refusals come back as `{ ok: false, error }`, never a throw across IPC; a
 * stop (a red gate, a refused merge) is an `ok: true` outcome the renderer shows and asks again about.
 */
export async function runMergeBatchDoor(
  raw: unknown,
  env: MergeBatchEnv = realEnv
): Promise<MergeBatchResult> {
  const a = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<MergeBatchDoorArgs>
  if (
    typeof a.root !== 'string' ||
    typeof a.missionId !== 'string' ||
    !Array.isArray(a.prs) ||
    !a.prs.every((n) => typeof n === 'number')
  ) {
    return { ok: false, error: 'BAD_ARGS: mergeBatch needs root, missionId and prs (numbers).' }
  }
  const root = missionRoot(a.root)
  const prs = a.prs
  const owned = await env.missionPrs(root, a.missionId)
  if (!owned.ok) return owned
  const stranger = prs.find((n) => !owned.prs.has(n))
  if (stranger !== undefined) {
    return {
      ok: false,
      error: `NOT_A_MISSION_PR: #${stranger} is not a PR of mission ${a.missionId} — a batch merges only the mission's own PRs.`
    }
  }

  let method: '--squash' | '--merge' | '--rebase' | null = null
  const deps: MergeBatchDeps = {
    readPr: async (n) => {
      try {
        return readPrFacts(
          await env.gh(['pr', 'view', String(n), '--json', 'state,isDraft,statusCheckRollup'], root)
        )
      } catch {
        return null
      }
    },
    merge: async (n) => {
      try {
        if (method === null) {
          let flags: RepoMergeFlags | null = null
          try {
            flags = parseJson(
              await env.gh(
                [
                  'repo',
                  'view',
                  '--json',
                  'squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed'
                ],
                root
              )
            ) as RepoMergeFlags | null
          } catch {
            flags = null
          }
          method = pickMergeMethod(flags)
        }
        await env.gh(['pr', 'merge', String(n), method], root)
        return { ok: true }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    },
    afterMerge: async () => ({ steward: await env.stewardTurn(a.missionId as string) }),
    sleep: env.sleep,
    now: env.now
  }

  let outcome: MergeBatchOutcome
  try {
    outcome = await runMergeBatch(prs, deps, env.timing)
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }

  // The Log learns what the operator did — under the lock, but only for the append.
  try {
    await withMissionIdMintLock(a.missionId, async () => {
      const loaded = await loadMission(root, a.missionId as string)
      if (!loaded.ok) return
      const log =
        loaded.log + (loaded.log.endsWith('\n') ? '' : '\n') + batchLogEntry(env.clock(), outcome)
      await atomicWriteFile(loaded.file, buildMissionFileContent(loaded.mission, log), 0o644)
    })
  } catch (err) {
    console.warn('[merge-batch] could not log the batch:', err)
  }
  return { ok: true, outcome }
}

/** Registers `mission:mergeBatch`. Called once from `src/main/index.ts`. */
export function registerMergeBatchIpc(): void {
  ipcMain.handle('mission:mergeBatch', async (_e, args: unknown): Promise<MergeBatchResult> =>
    runMergeBatchDoor(args)
  )
}
