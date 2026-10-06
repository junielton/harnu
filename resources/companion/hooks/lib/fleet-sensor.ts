import { ASK_RECORD_MAX, type AttentionKind, type EventPayloads } from '../contract'

/**
 * The fleet sensors' core (T389 P1W5 §7.1): turns, attention and subagents. Pure: no `$`, no
 * clock, no imports beyond the contract (MOD-1). `register.ts` feeds it what each hook saw and
 * emits what it returns; the state is mirrored to `$.state` (key `fleet`, contract §22), so a hot
 * reload re-derives a correct `session.snapshot` (MOD-4).
 *
 * Nothing here alters a verdict (MOD-8), and nothing carries tool input, prompt text, a message
 * or a task description (SEC-8): tool names and ids only.
 */

type Origin = EventPayloads['turn.started']['origin']

export interface OpenItem {
  kind: AttentionKind
  toolUseId?: string
  tool?: string
  agentId?: string
}

/** The one shared record list of contract §22 (`tool.check` → `ask`); P3W1 fills `inputKey`, `claimedBy`. */
export interface CheckRecord {
  toolUseId: string
  tool: string
  inputKey?: string
  at: number
  claimedBy?: string
  agentId?: string
  hook?: string
}

export interface FleetSensorState {
  activeTurnId: string | null
  nextOrigin: Origin
  open: OpenItem[]
  checks: CheckRecord[]
  runningSubagents: number
  lastStop: { all: number; subagents: number } | null
  pendingFailure: string | null
  /** Per-agent facts, keyed on the agent id: the subagents this sensor counted. */
  agents: Record<string, string>
  /**
   * The ids of subagents that already stopped (the newest `STOPPED_MAX`). The CLI still lists a
   * finished agent as `running` in the `background_tasks` of the next main `Stop` (observed on
   * 2.1.291: the task id is the agent id), so a hold must not count it.
   */
  stopped: string[]
}

export type SensorInput =
  | { k: 'prompt'; originKind: unknown }
  | { k: 'turn.start'; turnId: string }
  | {
      k: 'tool.check'
      tool: string
      decision: string
      toolUseId?: string
      agentId?: string
      hook?: string
      at: number
    }
  | { k: 'permission.request'; tool: string; agentId?: string }
  | { k: 'notification'; type: string }
  | { k: 'post-tool'; toolUseId?: string; tool?: string; agentId?: string; failed: boolean }
  | { k: 'stop'; tasks: readonly { type: string; status?: string; id?: string }[] | undefined }
  | { k: 'stop-failure'; error: string }
  | {
      k: 'turn.complete'
      turnId: string
      reason: EventPayloads['turn.completed']['reason']
      isAborted: boolean
      durationMs: number
      usage?: unknown
      agentId?: string
    }
  | { k: 'subagent.start'; agentType: string; agentId?: string }
  | { k: 'subagent.stop'; agentType: string; agentId?: string }
  | { k: 'rebound' }

export type OutEvent =
  | { t: 'turn.started'; d: EventPayloads['turn.started']; turnId: string }
  | { t: 'turn.completed'; d: EventPayloads['turn.completed']; turnId: string; agentId?: string }
  | { t: 'attention.raised'; d: EventPayloads['attention.raised']; agentId?: string }
  | { t: 'attention.cleared'; d: EventPayloads['attention.cleared'] }
  | { t: 'subagent.started'; d: EventPayloads['subagent.started'] }
  | { t: 'subagent.stopped'; d: EventPayloads['subagent.stopped'] }

/** The host treats counters as untrusted and clamps at 256 (§9); the sensor never exceeds it. */
const COUNT_MAX = 256
const STOPPED_MAX = 64

/** Statuses of a background task that has stopped running (types L641 name the field; Q12 the values). */
const FINISHED = new Set(['completed', 'failed', 'killed', 'stopped', 'cancelled', 'error'])

export function neutralFleet(): FleetSensorState {
  return {
    activeTurnId: null,
    nextOrigin: 'unknown',
    open: [],
    checks: [],
    runningSubagents: 0,
    lastStop: null,
    pendingFailure: null,
    agents: {},
    stopped: []
  }
}

/** What `$.state` returned, made safe: a value this sensor did not write reads as the neutral state. */
export function sanitizeFleet(raw: unknown): FleetSensorState {
  const out = neutralFleet()
  if (typeof raw !== 'object' || raw === null) return out
  const r = raw as Record<string, unknown>
  if (typeof r.activeTurnId === 'string') out.activeTurnId = r.activeTurnId
  if (r.nextOrigin === 'human' || r.nextOrigin === 'plugin' || r.nextOrigin === 'peer') {
    out.nextOrigin = r.nextOrigin
  }
  if (Array.isArray(r.open)) {
    for (const o of r.open) {
      if (typeof o !== 'object' || o === null) continue
      const i = o as Record<string, unknown>
      if (i.kind !== 'permission' && i.kind !== 'idle' && i.kind !== 'input') continue
      out.open.push({
        kind: i.kind,
        ...(typeof i.toolUseId === 'string' ? { toolUseId: i.toolUseId } : {}),
        ...(typeof i.tool === 'string' ? { tool: i.tool } : {}),
        ...(typeof i.agentId === 'string' ? { agentId: i.agentId } : {})
      })
    }
  }
  if (Array.isArray(r.checks)) {
    for (const c of r.checks.slice(-ASK_RECORD_MAX)) {
      if (typeof c !== 'object' || c === null) continue
      const i = c as Record<string, unknown>
      if (typeof i.toolUseId !== 'string' || typeof i.tool !== 'string') continue
      out.checks.push({
        toolUseId: i.toolUseId,
        tool: i.tool,
        at: typeof i.at === 'number' ? i.at : 0,
        ...(typeof i.inputKey === 'string' ? { inputKey: i.inputKey } : {}),
        ...(typeof i.claimedBy === 'string' ? { claimedBy: i.claimedBy } : {}),
        ...(typeof i.agentId === 'string' ? { agentId: i.agentId } : {}),
        ...(typeof i.hook === 'string' ? { hook: i.hook } : {})
      })
    }
  }
  if (typeof r.runningSubagents === 'number' && Number.isFinite(r.runningSubagents)) {
    out.runningSubagents = Math.min(COUNT_MAX, Math.max(0, Math.trunc(r.runningSubagents)))
  }
  const ls = r.lastStop as { all?: unknown; subagents?: unknown } | null | undefined
  if (ls && typeof ls.all === 'number' && typeof ls.subagents === 'number') {
    out.lastStop = { all: ls.all, subagents: ls.subagents }
  }
  if (typeof r.pendingFailure === 'string') out.pendingFailure = r.pendingFailure
  if (typeof r.agents === 'object' && r.agents !== null) {
    for (const [id, type] of Object.entries(r.agents as Record<string, unknown>)) {
      if (typeof type === 'string' && Object.keys(out.agents).length < COUNT_MAX) {
        out.agents[id] = type
      }
    }
  }
  if (Array.isArray(r.stopped)) {
    out.stopped = r.stopped.filter((x): x is string => typeof x === 'string').slice(-STOPPED_MAX)
  }
  return out
}

/** `origin.kind` of a `prompt.submit` event → the contract's four origins. */
export function originOf(kind: unknown): Origin {
  switch (kind) {
    case 'composer':
    case 'bridge':
    case 'sdk':
      return 'human'
    case 'plugin':
      return 'plugin'
    case 'peer':
    case 'peer-send-message':
    case 'projects-relay':
    case 'coordinator':
      return 'peer'
    default:
      return 'unknown'
  }
}

/** The snapshot's fleet half (contract §8): neutral values before any turn. */
export function snapshotFields(s: FleetSensorState): {
  activeTurnId: string | null
  openAttention: { kind: AttentionKind; toolUseId?: string }[]
  runningSubagents: number
} {
  return {
    activeTurnId: s.activeTurnId,
    openAttention: s.open.map((o) => ({
      kind: o.kind,
      ...(o.toolUseId !== undefined ? { toolUseId: o.toolUseId } : {})
    })),
    runningSubagents: s.runningSubagents
  }
}

const cleared = (o: OpenItem, cause: EventPayloads['attention.cleared']['cause']): OutEvent => ({
  t: 'attention.cleared',
  d: { kind: o.kind, ...(o.toolUseId !== undefined ? { toolUseId: o.toolUseId } : {}), cause }
})

function turnUsage(raw: unknown): EventPayloads['turn.completed']['usage'] {
  if (typeof raw !== 'object' || raw === null) return undefined
  const u = raw as Record<string, unknown>
  if (typeof u.model !== 'string') return undefined
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  return {
    model: u.model,
    inputTokens: n(u.input_tokens),
    outputTokens: n(u.output_tokens),
    cacheReadTokens: n(u.cache_read_input_tokens),
    cacheCreationTokens: n(u.cache_creation_input_tokens)
  }
}

/**
 * One step. Pure and total over well-formed input; a malformed element of a hook payload may
 * throw, and the hook that called it turns the throw into one `mod.error` (MOD-2).
 */
export function step(
  s: FleetSensorState,
  input: SensorInput
): { state: FleetSensorState; events: OutEvent[] } {
  const events: OutEvent[] = []
  const next: FleetSensorState = {
    ...s,
    open: [...s.open],
    checks: [...s.checks],
    agents: { ...s.agents },
    stopped: [...s.stopped]
  }

  switch (input.k) {
    case 'prompt': {
      next.nextOrigin = originOf(input.originKind)
      for (const o of next.open) events.push(cleared(o, 'prompt'))
      next.open = []
      break
    }
    case 'turn.start': {
      events.push({
        t: 'turn.started',
        d: { origin: next.nextOrigin },
        turnId: input.turnId
      })
      next.activeTurnId = input.turnId
      next.lastStop = null
      next.pendingFailure = null
      next.nextOrigin = 'unknown'
      break
    }
    case 'tool.check': {
      // only an `ask` with an id is recorded; under `dontAsk` and `-p` no dialog follows (B1.6)
      if (input.decision !== 'ask' || input.toolUseId === undefined) break
      const id = input.toolUseId
      if (next.checks.some((c) => c.toolUseId === id)) break
      next.checks.push({
        toolUseId: id,
        tool: input.tool,
        at: input.at,
        ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
        ...(input.hook !== undefined ? { hook: input.hook } : {})
      })
      if (next.checks.length > ASK_RECORD_MAX)
        next.checks.splice(0, next.checks.length - ASK_RECORD_MAX)
      next.open.push({
        kind: 'permission',
        toolUseId: id,
        tool: input.tool,
        ...(input.agentId !== undefined ? { agentId: input.agentId } : {})
      })
      events.push({
        t: 'attention.raised',
        d: { kind: 'permission', source: 'check', toolUseId: id, tool: input.tool },
        ...(input.agentId !== undefined ? { agentId: input.agentId } : {})
      })
      break
    }
    case 'permission.request': {
      // FIFO over the unclaimed records of the same tool and agent: the pairing P3W1 reuses
      const rec = next.checks.find(
        (c) => c.claimedBy === undefined && c.tool === input.tool && c.agentId === input.agentId
      )
      if (rec) rec.claimedBy = 'request'
      const id = rec?.toolUseId
      const known = next.open.some(
        (o) =>
          o.kind === 'permission' &&
          (id !== undefined
            ? o.toolUseId === id
            : o.toolUseId === undefined && o.tool === input.tool)
      )
      if (!known) {
        next.open.push({
          kind: 'permission',
          tool: input.tool,
          ...(id !== undefined ? { toolUseId: id } : {}),
          ...(input.agentId !== undefined ? { agentId: input.agentId } : {})
        })
      }
      events.push({
        t: 'attention.raised',
        d: {
          kind: 'permission',
          source: 'request',
          tool: input.tool,
          ...(id !== undefined ? { toolUseId: id } : {})
        },
        ...(input.agentId !== undefined ? { agentId: input.agentId } : {})
      })
      break
    }
    case 'notification': {
      const kind: AttentionKind | null =
        input.type === 'permission_prompt' || input.type === 'worker_permission_prompt'
          ? 'permission'
          : input.type === 'elicitation_dialog'
            ? 'input'
            : input.type === 'idle_prompt'
              ? 'idle'
              : null
      if (kind === null) break
      // the dialog a check or a request already opened is the same dialog
      if (!next.open.some((o) => o.kind === kind)) next.open.push({ kind })
      events.push({
        t: 'attention.raised',
        d: { kind, source: 'notification' }
      })
      break
    }
    case 'post-tool': {
      const idx = next.open.findIndex((o) => {
        if (o.kind !== 'permission') return false
        if (o.agentId !== input.agentId) return false
        if (o.toolUseId !== undefined) return o.toolUseId === input.toolUseId
        if (o.tool !== undefined) return o.tool === input.tool
        return true // a bare notification item: any tool settling means the dialog is over
      })
      if (input.toolUseId !== undefined) {
        next.checks = next.checks.filter((c) => c.toolUseId !== input.toolUseId)
      }
      if (idx < 0) break
      const [item] = next.open.splice(idx, 1)
      if (item) events.push(cleared(item, 'tool-settled'))
      break
    }
    case 'stop': {
      const tasks = Array.isArray(input.tasks) ? input.tasks : []
      next.lastStop = {
        all: tasks.length,
        // `type === 'subagent'` only (spec §7.1, Q12). A task that finished, or whose agent this
        // sensor already saw stop, does not hold: the CLI keeps listing it as `running`
        subagents: tasks.filter(
          (t) =>
            t.type === 'subagent' &&
            !FINISHED.has(String(t.status)) &&
            !(typeof t.id === 'string' && next.stopped.includes(t.id))
        ).length
      }
      break
    }
    case 'stop-failure': {
      next.pendingFailure = input.error.slice(0, 64)
      break
    }
    case 'turn.complete': {
      const usage = turnUsage(input.usage)
      if (input.agentId !== undefined) {
        events.push({
          t: 'turn.completed',
          d: {
            reason: input.reason,
            isAborted: input.isAborted,
            durationMs: input.durationMs,
            ...(usage ? { usage } : {})
          },
          turnId: input.turnId,
          agentId: input.agentId
        })
        break
      }
      for (const o of next.open) events.push(cleared(o, 'turn-completed'))
      events.push({
        t: 'turn.completed',
        d: {
          reason: input.reason,
          isAborted: input.isAborted,
          durationMs: input.durationMs,
          ...(usage ? { usage } : {}),
          backgroundTasks: s.lastStop?.all ?? 0,
          backgroundSubagents: Math.max(s.runningSubagents, s.lastStop?.subagents ?? 0),
          ...(s.pendingFailure !== null ? { failure: { type: s.pendingFailure } } : {})
        },
        turnId: input.turnId
      })
      next.open = []
      next.checks = [] // nothing outstanding survives the end of a main turn
      next.activeTurnId = null
      next.lastStop = null
      next.pendingFailure = null
      break
    }
    case 'subagent.start': {
      // only a start with an agent type counts; teammates are a distinct kind (contract §8)
      if (input.agentType === '') break
      if (input.agentId !== undefined) {
        if (input.agentId in next.agents) break
        if (Object.keys(next.agents).length >= COUNT_MAX) break
        next.agents[input.agentId] = input.agentType
      }
      next.runningSubagents = Math.min(COUNT_MAX, next.runningSubagents + 1)
      events.push({
        t: 'subagent.started',
        d: {
          agentType: input.agentType,
          ...(input.agentId !== undefined ? { agentId: input.agentId } : {})
        }
      })
      break
    }
    case 'subagent.stop': {
      if (input.agentType === '') break // the stray stop of smoke A4 (MOD-7)
      let agentType = input.agentType
      if (input.agentId !== undefined && input.agentId !== '') {
        const known = next.agents[input.agentId]
        if (known === undefined) break // an agent this sensor never counted moves nothing
        agentType = known
        delete next.agents[input.agentId]
        next.stopped.push(input.agentId)
        if (next.stopped.length > STOPPED_MAX)
          next.stopped.splice(0, next.stopped.length - STOPPED_MAX)
      }
      next.runningSubagents = Math.max(0, next.runningSubagents - 1)
      events.push({
        t: 'subagent.stopped',
        d: {
          agentType,
          ...(input.agentId !== undefined && input.agentId !== '' ? { agentId: input.agentId } : {})
        }
      })
      break
    }
    case 'rebound':
      return { state: neutralFleet(), events }
  }
  return { state: next, events }
}
