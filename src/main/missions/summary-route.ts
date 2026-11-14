/**
 * Missions v4 S-16b (AC-41) — the mission summary served to the leader after a compaction, with no
 * steward.
 *
 * One `command` handler in the per-session settings blob (`hook-settings-blob.ts`) runs on `SessionStart`
 * with matcher `compact` and posts the hook's body to the hook bridge's `/mission/<token>/summary`
 * route; the bridge calls {@link summaryRoute}, and whatever it returns is what the hook prints and
 * Claude Code adds to the session's context. Nothing is written to any folder: the blob is rebuilt with
 * the live port and token at every spawn.
 *
 * **Who gets it.** Only the OPEN LEADER of an OPEN v4 mission, and only after a compaction (`source` is
 * `compact`). A worker, a session that was handed off, a stranger, a session that leads a closed mission:
 * nothing, so a worker is never handed its leader's state. Only records whose source is `v4` are served
 * until the cut-over (S-35): a leader of a v3 mission sees no change, and no v3 file is read.
 *
 * **Never throws, never blocks.** A hook runs inside someone's session: the worst it may do is print
 * nothing. A bad body, a failing or slow store, a throw: all answer `''`. The whole answer is under
 * {@link SUMMARY_ROUTE_MAX} characters (Claude Code replaces a longer hook output with a file path and
 * a preview): each summary is at most 8,000, and a second one is added only when it fits whole.
 *
 * Imports no steward file (AC-26). Electron-free.
 */

import { promises as fs } from 'node:fs'
import { repoRoot } from '../data-dir'
import { openEntry } from './guard'
import type { MissionV4 } from './model'
import { readMissionRecord, v4RecordsDir, type RecordSource } from './record-store'
import type { StepInput } from './state'
import { buildMissionSummary } from './summary'

/** The most characters the route answers: under the 10,000 Claude Code keeps from a hook's output. */
export const SUMMARY_ROUTE_MAX = 9_900
/** The whole answer's deadline; the hook's own timeout is 5 s (`HOOK_TIMEOUT_S`). */
export const SUMMARY_DEADLINE_MS = 3_000
/** How long the summary waits for the facts of its steps before it reads from the record alone. */
export const SUMMARY_INPUTS_MS = 1_200

/** One record the route may serve. */
export interface SummaryRouteRecord {
  record: MissionV4
  log: string
  source: RecordSource
}

export interface SummaryRouteDeps {
  /** The repo's records that exist as v4 (never converts or writes a v3 one). `cwd` is the session's folder. */
  records(cwd: string): Promise<SummaryRouteRecord[]>
  /** The facts of each step, so the summary reads what Harnu knows. Optional and best effort. */
  inputsFor?(cwd: string, record: MissionV4): Promise<Readonly<Record<string, StepInput>>>
  deadlineMs?: number
  inputsMs?: number
}

/** `promise`, or `fallback` when it does not settle in `ms`. The timer never keeps the process up. */
async function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms)
    timer.unref?.()
  })
  try {
    return await Promise.race([promise, late])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** Fit `parts` in the cap: whole summaries only, in order; one that never fits alone is cut at a line. */
function fit(parts: readonly string[]): string {
  const kept: string[] = []
  let length = 0
  for (const part of parts) {
    const extra = (kept.length > 0 ? 2 : 0) + part.length
    if (length + extra > SUMMARY_ROUTE_MAX) break
    kept.push(part)
    length += extra
  }
  if (kept.length === 0 && parts.length > 0) {
    const cut = parts[0].slice(0, SUMMARY_ROUTE_MAX)
    const edge = cut.lastIndexOf('\n')
    return edge > 0 ? cut.slice(0, edge) : cut
  }
  return kept.join('\n\n')
}

async function answer(body: unknown, deps: SummaryRouteDeps): Promise<string> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return ''
  const b = body as Record<string, unknown>
  const sessionId = str(b.session_id ?? b.sessionId)
  const cwd = str(b.cwd)
  // SessionStart fires for every start; only a compaction needs the summary.
  if (sessionId === '' || cwd === '' || str(b.source) !== 'compact') return ''

  const led = (await deps.records(cwd)).filter(
    (r) =>
      r.source === 'v4' &&
      r.record.status === 'open' &&
      openEntry(r.record, sessionId)?.role === 'leads'
  )
  if (led.length === 0) return ''

  const texts: string[] = []
  for (const { record, log } of led) {
    const inputs =
      deps.inputsFor === undefined
        ? {}
        : await within(
            deps.inputsFor(cwd, record).then(
              (x) => x ?? {},
              () => ({})
            ),
            deps.inputsMs ?? SUMMARY_INPUTS_MS,
            {}
          )
    texts.push(buildMissionSummary(record, log, { inputs }).text)
  }
  return fit(texts)
}

/**
 * Answer one `SessionStart` hook body. Returns the text the hook prints, `''` for everyone who is not an
 * open leader after a compaction, and `''` on any failure or when the store does not answer in time.
 */
export async function summaryRoute(body: unknown, deps: SummaryRouteDeps): Promise<string> {
  try {
    return await within(answer(body, deps), deps.deadlineMs ?? SUMMARY_DEADLINE_MS, '')
  } catch (err) {
    console.warn('[mission] summary route failed (printing nothing):', err)
    return ''
  }
}

// ---- The real store -----------------------------------------------------------------------------

/** `mnt-<8 hex>` at the start of a v4 record's file name. */
const FILE_ID = /^(mnt-[0-9a-f]{8})-/

/**
 * The v4 store as the route reads it: the ids of `.harnu/missions-v4/` and one read of each. A repo
 * with no such directory answers none without reading a v3 file or creating anything, and a v3 mission
 * that was never converted is never listed (the listing that would convert it is not used here).
 */
export function defaultSummaryRouteDeps(): SummaryRouteDeps {
  return {
    async records(cwd) {
      const root = repoRoot(cwd)
      const names = await fs.readdir(v4RecordsDir(root)).catch(() => [] as string[])
      const ids = [...new Set(names.flatMap((n) => FILE_ID.exec(n)?.[1] ?? []))]
      const out: SummaryRouteRecord[] = []
      for (const id of ids) {
        const read = await readMissionRecord(root, id)
        if (read.ok && read.source === 'v4') {
          out.push({ record: read.record, log: read.log, source: read.source })
        }
      }
      return out
    }
  }
}
