/**
 * Guided walks S-7: "Test it" in the Mission dropdown reaches the session (spec "S-7", D-4, D-14; AC-35, AC-37).
 *
 * A click on a step, a milestone or the whole mission asks main to put a walk in front of the operator. Main
 * never writes the walk (a session holds the context and does): it picks one of three things.
 *
 *  1. A run of a walk for that source is already live: nothing is sent, the pane is focused (`focus`).
 *  2. The mission has an open leader: one `[harnu-walk-request]` turn goes to it through the `walk` source of the
 *     user-turn route, which wakes a parked session (`sent`).
 *  3. No leader is reachable (none is open, or the turn was held or could not be delivered): a session is started
 *     with the mission summary and the same request as its first prompt (D-4, `started`). It never becomes the
 *     leader: a click on Test it is not the operator's hand-off.
 *
 * The turn is self-sufficient (AC-37): it names the source and the walks that already exist for it (D-14), the
 * sources to read, and the contract in a short brief, so it works with the `walk` skill switched off.
 *
 * Pure and Electron-free: the mission, the library, the delivery and the session start are injected.
 */
import type { DeliveryOutcome, UserTurnPayload } from '../browser/page-delivery'
import { sanitizeLabel } from '../browser/emit-gate'
import { sourceIdentity, type WalkSource } from '../../shared/walk-source'
import type { WalkLibraryEntry } from './walk-store'

/** The first token of the turn: what a session recognises it by. */
export const WALK_REQUEST_MARKER = '[harnu-walk-request]'

/** The brief (the sources to read and the contract) is at most this many characters. */
export const BRIEF_MAX = 1500

/** How many existing walks of the source the turn names, newest first. */
const EXISTING_MAX = 5

/** What the dropdown asks a walk from (`lib/walk-entry.ts`): one step, one milestone or the whole mission. */
export type RequestSource =
  | { kind: 'step'; missionId: string; stepId: string }
  | { kind: 'milestone'; missionId: string; milestoneId: string }
  | { kind: 'mission'; missionId: string }

type MissionWalkSource = Extract<WalkSource, { kind: 'mission' }>

/** The walk source a dropdown source opens as (the script's own `source`). */
export function missionSourceOf(source: RequestSource): MissionWalkSource {
  switch (source.kind) {
    case 'step':
      return { kind: 'mission', missionId: source.missionId, scope: 'step', id: source.stepId }
    case 'milestone':
      return {
        kind: 'mission',
        missionId: source.missionId,
        scope: 'milestone',
        id: source.milestoneId
      }
    case 'mission':
      return { kind: 'mission', missionId: source.missionId, scope: 'mission' }
  }
}

/** What main knows of the mission the click is about. */
export interface MissionInfo {
  title: string
  /** `false` once the mission is closed: nothing is requested for it. */
  open: boolean
  /** The session that leads it now, or `null` when none is open. */
  leaderId: string | null
  steps: { id: string; title: string }[]
  milestones: { id: string; title: string }[]
}

export interface WalkRequestDeps {
  /** The mission's record read, or `null` when there is none. */
  readMission(folder: string, missionId: string): Promise<MissionInfo | null>
  /** The mission summary a started session is handed (D-4), or `null` when it cannot be built. */
  missionSummary(folder: string, missionId: string): Promise<string | null>
  /** Every walk of the repo (the library), any order. */
  listWalks(folder: string): Promise<WalkLibraryEntry[]>
  /** Hand one turn to the user-turn route; a parked session is woken. */
  deliver(turn: UserTurnPayload): Promise<DeliveryOutcome>
  /** Start a normal session in `folder` with `prompt` as its first prompt, and wait for its real id. */
  startSession(a: {
    folder: string
    prompt: string
  }): Promise<{ ok: true; sessionId: string } | { ok: false; reason: string }>
}

export type WalkRequestResult =
  | { ok: true; action: 'focus'; walkId: string; runId: string }
  | { ok: true; action: 'sent'; sessionId: string; woke: boolean }
  | { ok: true; action: 'started'; sessionId: string }
  | { ok: false; code: string; message: string }

const refuse = (code: string, message: string): WalkRequestResult => ({ ok: false, code, message })

// ---- The turn ----------------------------------------------------------------------------------------

/** The sources to read and the contract, in the words of the `walk` skill's panel contract and no more. */
const BRIEF = [
  'brief:',
  "Read first: mission_get (the record: the criteria, who settles each, the links, the spec), the linked PR and its diff, and the step's own branch or worktree. Call walk_get with the source above: if a walk of it exists, say so in one line instead of writing a duplicate.",
  "Then write the WHOLE walk once and call walk_open { folder, sessionId, script }, with the source above as the script's source. Pass your own sessionId. If it is refused, fix every violation it lists and call it again.",
  'Contract:',
  '1. Never perform a step yourself and never run anything that changes the world; your only commands are read-only checks.',
  '2. One check at a time, exactly one: never preview the next one or bundle two.',
  '3. Every check says where, what to do (each action with what the operator will see), what should be seen, and what a failure looks like.',
  '4. Quote every expected value and check every link you give; never ask for a secret.',
  '5. Never tick or settle a criterion: with this source the operator does it in the Mission dropdown (Mark done).',
  '6. After walk_open act only on [harnu-walk] turns: run the read-only check and answer with walk_report.',
  '7. Silence, "ok" or "it should have worked" never close a check.',
  "Say in one line that the walk is open, then stop: the next move is the operator's."
].join('\n')

export interface FormatInput {
  folder: string
  source: MissionWalkSource
  mission: Pick<MissionInfo, 'title' | 'steps' | 'milestones'>
  existing: readonly WalkLibraryEntry[]
}

/** "4 of 6 passed (run 1)", "in progress (run 2)" or "not walked yet": how an existing walk last went. */
function lastRunText(e: WalkLibraryEntry): string {
  if (e.status === 'live' && e.live) return `in progress (run ${e.live.n})`
  if (e.lastRun) return `${e.lastRun.verified} of ${e.lastRun.total} passed (run ${e.lastRun.n})`
  return 'not walked yet'
}

function whatItWalks(input: FormatInput): string {
  const { source, mission } = input
  if (source.scope === 'step') {
    const t = mission.steps.find((s) => s.id === source.id)?.title
    return `the step ${t ? `"${sanitizeLabel(t, 80)}"` : (source.id ?? '')}`
  }
  if (source.scope === 'milestone') {
    const t = mission.milestones.find((m) => m.id === source.id)?.title
    return `the milestone ${t ? `"${sanitizeLabel(t, 80)}"` : (source.id ?? '')}`
  }
  return 'the whole mission'
}

/** The text of the `[harnu-walk-request]` turn. Titles are cleaned: a title cannot forge another turn. */
export function formatWalkRequest(input: FormatInput): string {
  const { source } = input
  const first = `${WALK_REQUEST_MARKER} Walk ${whatItWalks(input)} by hand with the operator · mission "${sanitizeLabel(input.mission.title, 80)}"`
  const ids = `mission: ${source.missionId} · scope ${source.scope}${source.id ? ` · id ${source.id}` : ''} · folder: ${input.folder}`
  const scriptSource = `source: ${JSON.stringify(source)}`
  const mine = input.existing
    .filter((e) => sourceIdentity(e.source) === sourceIdentity(source))
    .sort((a, b) => (b.lastRun?.at ?? b.createdAt) - (a.lastRun?.at ?? a.createdAt))
    .slice(0, EXISTING_MAX)
  const existing =
    mine.length === 0
      ? ['existing walks: none']
      : [
          'existing walks (newest first):',
          ...mine.map((e) => `- ${e.walkId} · "${sanitizeLabel(e.title, 80)}" · ${lastRunText(e)}`)
        ]
  return [first, ids, scriptSource, ...existing, BRIEF].join('\n')
}

// ---- The decision ------------------------------------------------------------------------------------

/**
 * One click on a Test it control. Never throws: a refusal is an answer (`ok: false`, a stable `code`).
 * Nothing here writes a walk or touches a mission record.
 */
export async function requestWalk(
  deps: WalkRequestDeps,
  a: { folder: string; source: RequestSource }
): Promise<WalkRequestResult> {
  const { folder } = a
  const missionId = a.source.missionId
  const mission = await deps.readMission(folder, missionId).catch(() => null)
  if (!mission) return refuse('MISSION_NOT_FOUND', `There is no mission ${missionId} to test.`)
  if (!mission.open) return refuse('MISSION_CLOSED', `${missionId} is closed.`)
  if (a.source.kind === 'step') {
    const id = a.source.stepId
    if (!mission.steps.some((s) => s.id === id))
      return refuse('STEP_NOT_FOUND', `${missionId} has no step ${id}.`)
  }
  if (a.source.kind === 'milestone') {
    const id = a.source.milestoneId
    if (!mission.milestones.some((m) => m.id === id))
      return refuse('MILESTONE_NOT_FOUND', `${missionId} has no milestone ${id}.`)
  }

  const source = missionSourceOf(a.source)
  const walks = await deps.listWalks(folder).catch(() => [] as WalkLibraryEntry[])
  const identity = sourceIdentity(source)
  const live = walks.find(
    (w) => w.status === 'live' && w.live && sourceIdentity(w.source) === identity
  )
  if (live?.live) return { ok: true, action: 'focus', walkId: live.walkId, runId: live.live.runId }

  const text = formatWalkRequest({ folder, source, mission, existing: walks })
  if (mission.leaderId) {
    const out = await deps
      .deliver({ sessionId: mission.leaderId, folder, text, source: 'walk' })
      .catch((): DeliveryOutcome => ({ status: 'failed', reason: 'the delivery threw' }))
    if (out.status === 'delivered')
      return { ok: true, action: 'sent', sessionId: out.sessionId, woke: out.woke }
    // held or failed: the leader cannot take it now, so D-4 applies
  }

  const summary = await deps.missionSummary(folder, missionId).catch(() => null)
  const prompt = summary ? `${summary}\n\n${text}` : text
  const started = await deps.startSession({ folder, prompt }).catch((err: unknown) => ({
    ok: false as const,
    reason: err instanceof Error ? err.message : String(err)
  }))
  if (!started.ok)
    return refuse(
      'NO_LEADER_REACHABLE',
      `The mission's leader could not be reached and a new session did not start (${sanitizeLabel(started.reason, 120)}).`
    )
  return { ok: true, action: 'started', sessionId: started.sessionId }
}
