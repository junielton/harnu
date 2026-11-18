/**
 * Guided walks: the run machine (spec S-1, AC-5 and AC-6).
 *
 * The rules of a walk live here, once, pure and Electron-free (ADR-0001), so main and the renderer
 * import the same module: the pane draws what the machine says and recounts nothing.
 *
 * The machine runs over a RUN (one pass through a walk). It serves exactly one check at a time,
 * and every transition is a function `Run -> Result`: a refused move returns `{ ok: false, error }`
 * and changes nothing, so a caller persists only what was accepted. Nothing here reads a clock or a
 * file: the time is an argument, and so is the 30 s wait of D-7 ({@link WALK_WAIT_MS}).
 *
 * Vocabulary (spec "Flow and states"): a check is `todo`, `awaiting` (Done, and its agent check has
 * not answered), `disagrees` (the agent's check failed after a Done), `verified`, `caveat`,
 * `failed` or `skipped`. A run is `ready` (the roadmap is shown and nobody pressed Start), `live`
 * or `ended`.
 */

/** D-7: how long the operator waits for the agent's check before Continue without the check. */
export const WALK_WAIT_MS = 30_000

// ---- Types -----------------------------------------------------------------------------------

/** What the machine needs to know of a walk's check. */
export interface MachineCheck {
  id: string
  /** The script gave the check a read-only agent check (`check`, not `nothingFromHere`). */
  hasAgentCheck: boolean
  /** Ids of later checks that depend on this one. Non-empty means this check is blocking. */
  blocks?: string[]
  /** A pre-closed row of the script: complete, and already verified or a caveat. */
  preClosed?: { status: 'verified' | 'caveat' }
}

export type CheckState =
  'todo' | 'awaiting' | 'disagrees' | 'verified' | 'caveat' | 'failed' | 'skipped'

/** How a check closed: what the close-out says ("verified, Done plus the check"). */
export type ClosedHow =
  | 'done-check'
  | 'done-nothing'
  | 'continued'
  | 'follow-anyway'
  | 'pre-closed'
  | 'ended-before-agent'

export interface Failure {
  line?: string
  shot?: string
  at?: number
  from: 'operator' | 'agent'
}

export interface AgentReport {
  result: 'pass' | 'fail'
  evidence: string
  at: number
}

export interface RunCheck {
  id: string
  hasAgentCheck: boolean
  blocks: string[]
  /** Counted in N and served. False only for a pre-closed row of the first run. */
  countable: boolean
  state: CheckState
  closedHow: ClosedHow | null
  /** Times the operator pressed Failed. */
  attempts: number
  failures: Failure[]
  correction: { text: string } | null
  /** The agent's current report; cleared by Back and Try again (the log keeps it). */
  report: AgentReport | null
  reportLog: AgentReport[]
  /** When the turn that asked for the agent's check was delivered (the wait runs from here). */
  deliveredAt: number | null
}

export type RunState = 'ready' | 'live' | 'ended'

export interface Run {
  /** The run's ordinal in its walk (1 is the first run). */
  n: number
  state: RunState
  checks: RunCheck[]
  /** The served check, or `null` (before Start, in the skipped list, after the end). */
  cursor: string | null
  /** Served checks, oldest first; Back walks it. When a check is current it is the last entry. */
  served: string[]
  startedAt?: number
  endedAt?: number
}

export type MachineError = { code: string; message: string }
export type MachineResult = { ok: true; run: Run } | { ok: false; error: MachineError }

export type WalkView =
  | { mode: 'roadmap' }
  | {
      mode: 'check'
      checkId: string
      /** The check's fixed ordinal among the checks to walk. */
      n: number
      /** N, the number of checks to walk. */
      total: number
      phase: 'todo' | 'awaiting' | 'disagrees' | 'failed'
      blocking: boolean
    }
  | { mode: 'skipped-list'; ids: string[] }
  | { mode: 'closeout' }

export type ReportInput =
  | { kind?: 'check'; checkId: string; result: 'pass' | 'fail'; evidence: string; now: number }
  | { kind: 'correction'; checkId: string; text: string }

export interface Counts {
  verified: number
  caveat: number
  failed: number
  skipped: number
  disagrees: number
  awaiting: number
  todo: number
  /** N: the checks to walk. */
  total: number
}

// ---- Internals -------------------------------------------------------------------------------

const refuse = (code: string, message: string): MachineResult => ({
  ok: false,
  error: { code, message }
})
const accept = (run: Run): MachineResult => ({ ok: true, run })
const clone = (run: Run): Run => structuredClone(run)
const byId = (run: Run, id: string): RunCheck | undefined => run.checks.find((c) => c.id === id)
const isClosed = (c: RunCheck): boolean => c.state === 'verified' || c.state === 'caveat'
const isBlocking = (c: RunCheck): boolean => c.blocks.length > 0

function toRunCheck(c: MachineCheck, firstRun: boolean): RunCheck {
  const pre = firstRun ? c.preClosed : undefined
  return {
    id: c.id,
    hasAgentCheck: c.hasAgentCheck,
    blocks: [...(c.blocks ?? [])],
    countable: !pre,
    state: pre ? pre.status : 'todo',
    closedHow: pre ? 'pre-closed' : null,
    attempts: 0,
    failures: [],
    correction: null,
    report: null,
    reportLog: [],
    deliveredAt: null
  }
}

/** The checks that must be closed before `id` may be served: those whose `blocks` name it. */
function blockersOf(run: Run, id: string): RunCheck[] {
  return run.checks.filter((c) => c.blocks.includes(id))
}

/** Make `id` the current check and remember that it was served. */
function serve(run: Run, id: string): void {
  run.cursor = id
  if (run.served[run.served.length - 1] !== id) run.served.push(id)
}

/**
 * Move the cursor to the next check to serve, in this order: a check that still needs an answer
 * (awaiting, disagrees or failed, so a late disagreement resurfaces before anything new), then the
 * first to-do check whose blockers are closed. `null` when there is none.
 */
function nextToServe(run: Run): RunCheck | null {
  const unresolved = run.checks.find(
    (c) =>
      c.countable && (c.state === 'awaiting' || c.state === 'disagrees' || c.state === 'failed')
  )
  if (unresolved) return unresolved
  const todo = run.checks.find(
    (c) => c.countable && c.state === 'todo' && blockersOf(run, c.id).every(isClosed)
  )
  return todo ?? null
}

const skippedIds = (run: Run): string[] =>
  run.checks.filter((c) => c.countable && c.state === 'skipped').map((c) => c.id)

/**
 * After a transition on a live run: serve the next check; when there is none and nothing is
 * skipped, the run ends (no to-do or skipped check is left).
 */
function settle(run: Run, now: number): Run {
  if (run.state !== 'live') return run
  const next = nextToServe(run)
  if (next) {
    serve(run, next.id)
    return run
  }
  run.cursor = null
  if (skippedIds(run).length === 0) {
    // a to-do check that only a skipped check blocks cannot exist without a skipped one; the
    // defensive branch below serves it rather than ending a run with work left
    const stuck = run.checks.find((c) => c.countable && c.state === 'todo')
    if (stuck) serve(run, stuck.id)
    else {
      run.state = 'ended'
      run.endedAt = now
    }
  }
  return run
}

function live(run: Run): MachineError | null {
  if (run.state === 'ended') return { code: 'RUN_ENDED', message: 'The run has ended.' }
  if (run.state === 'ready') return { code: 'RUN_NOT_LIVE', message: 'The run has not started.' }
  return null
}

/** The live run's current check, or the refusal for why there is none. */
function current(run: Run): { run: Run; check: RunCheck } | MachineResult {
  const e = live(run)
  if (e) return { ok: false, error: e }
  if (run.cursor === null) return refuse('NO_CURRENT', 'No check is being served.')
  const c = byId(run, run.cursor)
  if (!c) return refuse('NO_CURRENT', 'No check is being served.')
  return { run, check: c }
}
const isRefusal = (x: unknown): x is MachineResult =>
  typeof x === 'object' && x !== null && 'ok' in x

// ---- Building a run --------------------------------------------------------------------------

/**
 * A new `ready` run over `checks`. In the first run (`n` 1) a pre-closed row is drawn in the
 * roadmap with its glyph, is not counted and is never served; in a re-run (`n` above 1) every
 * check is to do again, pre-closed rows included, with nothing carried over.
 */
export function newRun(checks: readonly MachineCheck[], opts: { n: number }): Run {
  const firstRun = opts.n === 1
  return {
    n: opts.n,
    state: 'ready',
    checks: checks.map((c) => toRunCheck(c, firstRun)),
    cursor: null,
    served: []
  }
}

/** Press Start with 1: the run becomes live and serves its first check. */
export function startRun(run: Run, now = 0): MachineResult {
  if (run.state === 'ended') return refuse('RUN_ENDED', 'The run has ended.')
  if (run.state === 'live') return refuse('RUN_ALREADY_LIVE', 'The run has already started.')
  const r = clone(run)
  r.state = 'live'
  r.startedAt = now
  return accept(settle(r, now))
}

/** `walk_extend` with `append`: new checks at the end. N grows; nothing is reordered or removed. */
export function appendChecks(run: Run, checks: readonly MachineCheck[]): MachineResult {
  if (run.state === 'ended') return refuse('RUN_ENDED', 'The run has ended.')
  for (const c of checks)
    if (byId(run, c.id)) return refuse('DUPLICATE_CHECK', `A check ${c.id} is already in the run.`)
  const r = clone(run)
  for (const c of checks) r.checks.push(toRunCheck(c, false))
  // a run that was only offering skipped checks has something to serve again
  return accept(r.state === 'live' && r.cursor === null ? settle(r, r.endedAt ?? 0) : r)
}

// ---- Reading a run ---------------------------------------------------------------------------

/** N: the number of checks to walk. */
export function totalChecks(run: Run): number {
  return run.checks.filter((c) => c.countable).length
}

/** A check's fixed ordinal among the checks to walk, or `null` for a row that is not walked. */
export function ordinalOf(run: Run, id: string): number | null {
  const walked = run.checks.filter((c) => c.countable)
  const i = walked.findIndex((c) => c.id === id)
  return i === -1 ? null : i + 1
}

/** What the pane draws: the roadmap, one check, the skipped list or the close-out. */
export function view(run: Run): WalkView {
  if (run.state === 'ready') return { mode: 'roadmap' }
  if (run.state === 'ended') return { mode: 'closeout' }
  if (run.cursor !== null) {
    const c = byId(run, run.cursor)
    const n = ordinalOf(run, run.cursor)
    if (c && n !== null) {
      const phase =
        c.state === 'awaiting' || c.state === 'disagrees' || c.state === 'failed' ? c.state : 'todo'
      return {
        mode: 'check',
        checkId: c.id,
        n,
        total: totalChecks(run),
        phase,
        blocking: isBlocking(c)
      }
    }
  }
  const ids = skippedIds(run)
  return ids.length > 0 ? { mode: 'skipped-list', ids } : { mode: 'closeout' }
}

/** Counts over the checks to walk (pre-closed rows of the first run are not part of "N passed"). */
export function counts(run: Run): Counts {
  const out: Counts = {
    verified: 0,
    caveat: 0,
    failed: 0,
    skipped: 0,
    disagrees: 0,
    awaiting: 0,
    todo: 0,
    total: 0
  }
  for (const c of run.checks) {
    if (!c.countable) continue
    out.total++
    out[c.state]++
  }
  return out
}

/** From the second failure of a check the operator is offered the escalation door. */
export function canEscalate(run: Run, id: string): boolean {
  return (byId(run, id)?.attempts ?? 0) >= 2
}

// ---- Last time (re-run) ----------------------------------------------------------------------

/** What a check said the last time it was walked (a re-run's quiet `last time:` hint). */
export interface LastTime {
  /** `unverified` is a caveat or a check the agent disagreed with: closed, but not confirmed. */
  result: 'passed' | 'failed' | 'skipped' | 'unverified'
  /** What the operator wrote the last time it failed. */
  line?: string
}

/**
 * The hints a re-run carries, read from the run it follows (never copied into the new run, so an earlier
 * run stays as it was): one per check that run walked. A check it never reached, and a pre-closed row of
 * the first run, have none.
 */
export function lastTimeHints(prev: Run): Record<string, LastTime> {
  const out: Record<string, LastTime> = {}
  for (const c of prev.checks) {
    if (!c.countable) continue
    switch (c.state) {
      case 'verified':
        out[c.id] = { result: 'passed' }
        break
      case 'caveat':
      case 'disagrees':
        out[c.id] = { result: 'unverified' }
        break
      case 'skipped':
        out[c.id] = { result: 'skipped' }
        break
      case 'failed': {
        const line = c.failures.findLast((f) => f.from === 'operator' && f.line)?.line
        out[c.id] = { result: 'failed', ...(line ? { line } : {}) }
        break
      }
      default:
        break // todo and awaiting: the run ended before it got there
    }
  }
  return out
}

// ---- The operator's answers ------------------------------------------------------------------

/**
 * Done on the current check. With an agent check it stays `awaiting` until `walk_report` (the wait
 * runs from `now`, the moment the turn is delivered); with nothing to check from here it verifies.
 */
export function done(run: Run, now: number): MachineResult {
  const cur = current(run)
  if (isRefusal(cur)) return cur
  const { check } = cur
  if (check.state === 'awaiting') return refuse('AWAITING_AGENT', 'The agent is still checking.')
  if (check.state === 'disagrees')
    return refuse('WRONG_STATE', 'The agent disagreed: answer its evidence.')
  const r = clone(run)
  const c = byId(r, check.id)!
  if (c.hasAgentCheck) {
    c.state = 'awaiting'
    c.deliveredAt = now
    return accept(r)
  }
  c.state = 'verified'
  c.closedHow = 'done-nothing'
  return accept(settle(r, now))
}

/** Failed: needs the operator's line or a pasted screenshot; the same check stays on screen. */
export function fail(
  run: Run,
  input: { line?: string; shot?: string; now?: number }
): MachineResult {
  const cur = current(run)
  if (isRefusal(cur)) return cur
  const { check } = cur
  if (check.state === 'awaiting') return refuse('AWAITING_AGENT', 'The agent is still checking.')
  if (check.state === 'disagrees')
    return refuse('WRONG_STATE', 'The agent disagreed: answer its evidence.')
  const line = input.line?.trim()
  if (!line && !input.shot)
    return refuse('FAILURE_NEEDS_LINE', 'Failed needs one line or a screenshot.')
  const r = clone(run)
  const c = byId(r, check.id)!
  c.state = 'failed'
  c.attempts += 1
  c.correction = null
  c.failures.push({
    ...(line ? { line } : {}),
    ...(input.shot ? { shot: input.shot } : {}),
    at: input.now,
    from: 'operator'
  })
  return accept(r)
}

/** Skip the current check; it is offered again from the list once no to-do check is left. */
export function skip(run: Run, now = 0): MachineResult {
  const cur = current(run)
  if (isRefusal(cur)) return cur
  const { check } = cur
  if (check.state === 'awaiting') return refuse('AWAITING_AGENT', 'The agent is still checking.')
  if (check.state === 'disagrees')
    return refuse('WRONG_STATE', 'The agent disagreed: answer its evidence.')
  const r = clone(run)
  byId(r, check.id)!.state = 'skipped'
  return accept(settle(r, now))
}

/**
 * Back: return to the previous served check, whatever state it closed in. That check becomes
 * current again as a to-do, its agent report is cleared (the log keeps it) and its attempts stay.
 */
export function back(run: Run): MachineResult {
  const cur = current(run)
  if (!isRefusal(cur) && cur.check.state === 'awaiting')
    return refuse('AWAITING_AGENT', 'The agent is still checking.')
  const e = live(run)
  if (e) return { ok: false, error: e }
  const r = clone(run)
  const stack = [...r.served]
  // with a check on screen the top of the stack is that check; in the skipped list it is the last one served
  if (r.cursor !== null && stack[stack.length - 1] === r.cursor) stack.pop()
  const prevId = stack[stack.length - 1]
  if (prevId === undefined) return refuse('NO_PREVIOUS', 'There is no earlier check to go back to.')
  const prev = byId(r, prevId)!
  prev.state = 'todo'
  prev.closedHow = null
  prev.report = null
  prev.deliveredAt = null
  prev.correction = null
  r.served = stack
  r.cursor = prevId
  return accept(r)
}

/** Try again (after a correction or a disagreement): the same check, with its outcomes again. */
export function tryAgain(run: Run): MachineResult {
  const cur = current(run)
  if (isRefusal(cur)) return cur
  const { check } = cur
  if (check.state !== 'failed' && check.state !== 'disagrees')
    return refuse('WRONG_STATE', 'There is nothing to try again.')
  const r = clone(run)
  const c = byId(r, check.id)!
  c.state = 'todo'
  c.correction = null
  c.report = null
  c.deliveredAt = null
  return accept(r)
}

/** Follow anyway (unverified): a non-blocking check the agent disagreed with closes as a caveat. */
export function followAnyway(run: Run, now = 0): MachineResult {
  const cur = current(run)
  if (isRefusal(cur)) return cur
  const { check } = cur
  if (check.state !== 'disagrees') return refuse('WRONG_STATE', 'The agent has not disagreed.')
  if (isBlocking(check))
    return refuse('BLOCKING_CHECK', 'A blocking check cannot be followed anyway.')
  const r = clone(run)
  const c = byId(r, check.id)!
  c.state = 'caveat'
  c.closedHow = 'follow-anyway'
  return accept(settle(r, now))
}

/** Treat as failed: the agent's evidence is the symptom, so no new line is needed. */
export function treatAsFailed(run: Run, now?: number): MachineResult {
  const cur = current(run)
  if (isRefusal(cur)) return cur
  const { check } = cur
  if (check.state !== 'disagrees' || !check.report)
    return refuse('WRONG_STATE', 'The agent has not disagreed.')
  const r = clone(run)
  const c = byId(r, check.id)!
  c.state = 'failed'
  c.attempts += 1
  c.correction = null
  c.failures.push({ line: check.report.evidence, at: now, from: 'agent' })
  return accept(r)
}

/**
 * Continue without the check: once the wait has run from delivery, the awaiting check closes as a
 * caveat. A late `walk_report` still upgrades or fails it.
 */
export function continueWithout(
  run: Run,
  now: number,
  waitMs: number = WALK_WAIT_MS
): MachineResult {
  const cur = current(run)
  if (isRefusal(cur)) return cur
  const { check } = cur
  if (check.state !== 'awaiting') return refuse('WRONG_STATE', 'No check is waiting for the agent.')
  if (now - (check.deliveredAt ?? now) < waitMs)
    return refuse('TOO_EARLY', 'The wait has not run out.')
  const r = clone(run)
  const c = byId(r, check.id)!
  c.state = 'caveat'
  c.closedHow = 'continued'
  return accept(settle(r, now))
}

/** From the skipped list: retry one skipped check. */
export function pickSkipped(run: Run, id: string): MachineResult {
  const e = live(run)
  if (e) return { ok: false, error: e }
  if (run.cursor !== null) return refuse('NOT_AT_SKIP_LIST', 'A check is being served.')
  const c = byId(run, id)
  if (!c) return refuse('CHECK_NOT_FOUND', `No check ${id}.`)
  if (c.state !== 'skipped') return refuse('NOT_SKIPPED', 'That check was not skipped.')
  const r = clone(run)
  byId(r, id)!.state = 'todo'
  serve(r, id)
  return accept(r)
}

/** From the skipped list: close out with the skipped checks owed. */
export function closeOutWithSkipped(run: Run, now = 0): MachineResult {
  const e = live(run)
  if (e) return { ok: false, error: e }
  if (run.cursor !== null || skippedIds(run).length === 0)
    return refuse('NOT_AT_SKIP_LIST', 'The skipped list is not on offer.')
  const r = clone(run)
  r.state = 'ended'
  r.endedAt = now
  return accept(r)
}

/**
 * End the walk (the pane's X, once a check is closed). A check still awaiting the agent is
 * recorded as a caveat ("ended before the agent answered").
 */
export function endRun(run: Run, now: number): MachineResult {
  const e = live(run)
  if (e) return { ok: false, error: e }
  const r = clone(run)
  for (const c of r.checks) {
    if (c.state === 'awaiting') {
      c.state = 'caveat'
      c.closedHow = 'ended-before-agent'
    }
  }
  r.state = 'ended'
  r.endedAt = now
  r.cursor = null
  return accept(r)
}

// ---- The agent's answers ---------------------------------------------------------------------

/**
 * `walk_report`: the agent's check of a check (`pass` or `fail`), or its one correction after a
 * Failed. A check report is accepted for an awaiting check and for a check that closed by Continue
 * without the check (a late report: a pass upgrades the caveat, a fail makes it disagree and
 * serves it again). Any other check is refused: it is not awaiting.
 */
export function report(run: Run, input: ReportInput): MachineResult {
  if (run.state === 'ended') return refuse('RUN_ENDED', 'The run has ended.')
  if (run.state === 'ready') return refuse('RUN_NOT_LIVE', 'The run has not started.')
  const c0 = byId(run, input.checkId)
  if (!c0) return refuse('CHECK_NOT_FOUND', `No check ${input.checkId}.`)

  if (input.kind === 'correction') {
    if (c0.state !== 'failed' || c0.failures.length === 0)
      return refuse('NO_FAILURE', 'There is no failure to correct.')
    if (c0.correction)
      return refuse('CORRECTION_PENDING', 'A correction is already waiting for the operator.')
    const r = clone(run)
    byId(r, input.checkId)!.correction = { text: input.text }
    return accept(r)
  }

  const lateCaveat = c0.state === 'caveat' && c0.closedHow === 'continued'
  if (c0.state !== 'awaiting' && !lateCaveat)
    return refuse('NOT_AWAITING', 'That check is not waiting for the agent.')
  const r = clone(run)
  const c = byId(r, input.checkId)!
  const entry: AgentReport = { result: input.result, evidence: input.evidence, at: input.now }
  c.report = entry
  c.reportLog.push(entry)
  if (input.result === 'pass') {
    c.state = 'verified'
    c.closedHow = 'done-check'
    return accept(lateCaveat ? r : settle(r, input.now))
  }
  c.state = 'disagrees'
  c.closedHow = null
  // a disagreement is served before anything new, including after a late report
  serve(r, c.id)
  return accept(r)
}
