/**
 * Sessions parked on a human-gating tool, and the closes that follow an archive or a removal.
 *
 * A parked `AskUserQuestion` or `ExitPlanMode` is a question only the operator can answer, and
 * a TUI selector cannot be answered by typing text, so its card offers Open session only. The
 * hooks cannot say which tool is waiting (`tool_name` is not forwarded and `PreToolUse` is
 * global-install only), so the transcript tail is read on each needs-input edge and each sweep.
 * Tool permissions get no card: they stay in the Approval Inbox.
 */

import type { HookTaskEvent } from '../detect/task-state-hub'
import type { TaskState } from '../hook-state'
import { HUMAN_GATING_TOOLS, isChainParticipant } from '../transcript-truth'
import {
  closeCard,
  closeForFolder,
  closeForSessions,
  reconcileSource,
  upsertStructured,
  type CardLane,
  type StructuredDraft,
  type YourMoveCard,
  type YourMoveMode
} from './core'
import type { YourMoveStore } from './store'
import type { readFrom } from './transcript'

/** How far back the transcript is read for a parked gate. */
const GATE_TAIL_BYTES = 128 * 1024

export interface PendingGate {
  toolUseId: string
  tool: string
  question: string
}

/** The `system` subtypes the CLI writes when a turn has ended: nothing can be parked after one. */
const TURN_END_SUBTYPES = new Set(['turn_duration', 'stop_hook_summary'])

const contentBlocks = (e: Record<string, unknown>): Record<string, unknown>[] => {
  const message = e.message as { content?: unknown } | undefined
  return message && Array.isArray(message.content)
    ? (message.content.filter((b) => b && typeof b === 'object') as Record<string, unknown>[])
    : []
}

/** Every tool call in the window that has a result there: those gates are answered. */
export function answeredToolUseIds(lines: readonly Record<string, unknown>[]): Set<string> {
  const ids = new Set<string>()
  for (const e of lines) {
    if (e.type !== 'user') continue
    for (const b of contentBlocks(e)) {
      if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') ids.add(b.tool_use_id)
    }
  }
  return ids
}

/**
 * The human-gating tool call the session is parked on, or null: the newest `AskUserQuestion` or
 * `ExitPlanMode` call that has no tool_result in the window. Whatever else follows it does not
 * matter (a `user` prompt, a recap or an informational `system` entry are written while a
 * question is parked); only a turn-end entry after it (`turn_duration`, `stop_hook_summary`)
 * says the turn moved on. A subagent's entries are not the session's own. `stop_reason` is not
 * looked at, so a gate still marked as streaming counts: a miss costs a session.
 */
export function pendingHumanGate(lines: readonly Record<string, unknown>[]): PendingGate | null {
  const answered = answeredToolUseIds(lines)
  let found: { gate: PendingGate; at: number } | null = null
  let lastTurnEnd = -1
  for (let at = 0; at < lines.length; at++) {
    const e = lines[at]
    if (e.isSidechain === true) continue
    if (e.type === 'system' && typeof e.subtype === 'string' && TURN_END_SUBTYPES.has(e.subtype)) {
      lastTurnEnd = at
      continue
    }
    if (e.type !== 'assistant' || !isChainParticipant(e)) continue
    for (const b of contentBlocks(e)) {
      if (b.type !== 'tool_use' || typeof b.name !== 'string' || !HUMAN_GATING_TOOLS.has(b.name)) {
        continue
      }
      const id = typeof b.id === 'string' && b.id !== '' ? b.id : `${b.name}:${String(e.uuid)}`
      if (answered.has(id)) continue
      const input = (b.input && typeof b.input === 'object' ? b.input : {}) as {
        questions?: unknown
      }
      const first = Array.isArray(input.questions) ? input.questions[0] : undefined
      const question =
        b.name === 'AskUserQuestion' &&
        first &&
        typeof first === 'object' &&
        typeof (first as { question?: unknown }).question === 'string'
          ? (first as { question: string }).question.trim()
          : ''
      found = { gate: { toolUseId: id, tool: b.name, question }, at }
    }
  }
  return found && found.at > lastTurnEnd ? found.gate : null
}

export function gateDraft(
  g: PendingGate,
  sessionId: string,
  folder: string,
  lane: CardLane
): StructuredDraft {
  const plan = g.tool === 'ExitPlanMode'
  const ask = plan
    ? 'The session has a plan waiting for your approval'
    : g.question || 'The session is waiting for your answer to a question'
  return {
    sessionId,
    folder,
    kind: 'decide',
    ask,
    ...(plan ? { askKey: { key: 'yourMove.system.planReady', params: {} } } : {}),
    source: 'human-gate',
    sourceKey: `gate:${g.toolUseId}`,
    lane
  }
}

export interface GateWatchDeps {
  store: YourMoveStore
  mode(): YourMoveMode
  lane(): CardLane
  eligible(sessionId: string, folder: string): Promise<boolean>
  locate(sessionId: string): Promise<string | null>
  resolveFolder(
    sessionId: string,
    cwd: string | undefined,
    transcriptPath: string
  ): Promise<string | null>
  read: typeof readFrom
  /** The transcript's size in bytes (0 when it cannot be read): a cheap "did it grow?". */
  size(transcriptPath: string): Promise<number>
  /** The folded task state of every live session. */
  states(): ReadonlyMap<string, TaskState>
  mintId(): string
  now(): number
}

const gateIdOf = (sourceKey: string | undefined): string | null =>
  sourceKey?.startsWith('gate:') ? sourceKey.slice('gate:'.length) : null

/**
 * Keeps one `gate:` card per parked gate. A card closes in exactly two ways: the transcript
 * shows the matching tool_result, or the session's next Stop says the turn moved on. Nothing
 * else closes it, and above all not "I could not see it": an empty or missing transcript, or a
 * gate that scrolled past the tail, leaves the card open.
 *
 * A session is looked at when it enters needs-input (the CLI is not known to raise that edge
 * for every parked question) and on every sweep tick for any session whose transcript grew
 * since the last look, whatever state the hooks think it is in.
 */
export function createGateWatch(deps: GateWatchDeps): {
  onTaskEvent(ev: HookTaskEvent): void
  tick(): Promise<void>
  idle(): Promise<void>
  dispose(): void
} {
  let disposed = false
  const pending = new Set<Promise<unknown>>()
  const checking = new Set<string>()
  /** Where each swept session lives, found once. */
  const where = new Map<string, { path: string; folder: string }>()
  /** The transcript size at each session's last successful look. */
  const lastSize = new Map<string, number>()
  /** Gates a Stop already closed: the turn moved on, so they are not filed again. */
  const dismissed = new Set<string>()

  const openGateCards = (sessionId: string): YourMoveCard[] =>
    deps.store
      .state()
      .cards.filter(
        (c) => c.closedAt === undefined && c.source === 'human-gate' && c.sessionId === sessionId
      )

  async function check(
    sessionId: string,
    hint: { cwd?: string; path?: string },
    onlyIfGrown: boolean
  ): Promise<void> {
    let spot = where.get(sessionId)
    if (!spot) {
      const path = hint.path ?? (await deps.locate(sessionId))
      if (!path || disposed) return
      const folder = await deps.resolveFolder(sessionId, hint.cwd, path)
      if (!folder) return
      spot = { path, folder }
      where.set(sessionId, spot)
    }
    if (!(await deps.eligible(sessionId, spot.folder)) || disposed) return
    const size = await deps.size(spot.path)
    if (onlyIfGrown && lastSize.get(sessionId) === size) return
    const res = await deps.read(spot.path, { tail: GATE_TAIL_BYTES })
    // Nothing to read is not "nothing parked": an empty or missing transcript decides nothing.
    if (res.lines.length === 0) return
    const gate = pendingHumanGate(res.lines)
    const answered = answeredToolUseIds(res.lines)
    const folder = spot.folder
    const open = openGateCards(sessionId)
    const fresh = gate !== null && !dismissed.has(gate.toolUseId)
    const resolved = open.filter((c) => {
      const id = gateIdOf(c.sourceKey)
      return id !== null && answered.has(id)
    })
    if (fresh || resolved.length > 0) {
      await deps.store.transact((s) => {
        let next = s
        if (fresh && gate) {
          next = upsertStructured(
            next,
            gateDraft(gate, sessionId, folder, deps.lane()),
            deps.mintId,
            deps.now()
          )
        }
        for (const c of resolved) next = closeCard(next, c.id, 'source-resolved', deps.now())
        return { next, result: undefined }
      })
    }
    lastSize.set(sessionId, size)
  }

  function run(
    sessionId: string,
    hint: { cwd?: string; path?: string } = {},
    onlyIfGrown = false
  ): Promise<void> {
    if (checking.has(sessionId)) return Promise.resolve()
    checking.add(sessionId)
    const p = check(sessionId, hint, onlyIfGrown)
      .catch((e) => console.error(`[your-move] gate check failed: ${(e as Error)?.message ?? e}`))
      .finally(() => {
        checking.delete(sessionId)
        pending.delete(p)
      })
    pending.add(p)
    return p
  }

  /** The turn moved on: close the session's gate cards and remember not to file them again. */
  async function stopped(sessionId: string): Promise<void> {
    const open = openGateCards(sessionId)
    if (open.length === 0) return
    for (const c of open) {
      const id = gateIdOf(c.sourceKey)
      if (id) dismissed.add(id)
    }
    await deps.store.transact((s) => ({
      next: reconcileSource(s, { source: 'human-gate', sessionId }, [], deps.mintId, deps.now()),
      result: undefined
    }))
  }

  return {
    onTaskEvent(ev) {
      if (disposed || deps.mode() === 'off' || ev.agentId !== undefined) return
      if (ev.event === 'Stop') {
        const p = stopped(ev.sessionId)
          .catch((e) =>
            console.error(`[your-move] gate close failed: ${(e as Error)?.message ?? e}`)
          )
          .finally(() => pending.delete(p))
        pending.add(p)
        return
      }
      if (ev.taskState === 'needs-input' || openGateCards(ev.sessionId).length > 0) {
        void run(ev.sessionId, { cwd: ev.payload?.cwd, path: ev.payload?.transcriptPath })
      }
    },
    async tick() {
      if (disposed || deps.mode() === 'off') return
      const ids = new Set<string>(deps.states().keys())
      for (const c of deps.store.state().cards) {
        if (c.closedAt === undefined && c.source === 'human-gate') ids.add(c.sessionId)
      }
      for (const id of [...where.keys()]) if (!ids.has(id)) where.delete(id)
      for (const id of [...lastSize.keys()]) if (!ids.has(id)) lastSize.delete(id)
      for (const id of ids) {
        if (disposed) return
        await run(id, {}, true)
      }
    },
    async idle() {
      while (pending.size > 0) await Promise.allSettled([...pending])
    },
    dispose() {
      disposed = true
    }
  }
}

/** Close a session's cards the moment it is archived. Returns the unsubscribe. */
export function watchArchive(deps: {
  store: YourMoveStore
  archive: {
    onChange(cb: (changedIds: string[]) => void): () => void
    has(id: string): boolean
  } | null
  now(): number
}): () => void {
  if (!deps.archive) return () => undefined
  const archive = deps.archive
  const close = (ids: string[]): void => {
    if (ids.length === 0) return
    deps.store
      .transact((s) => ({ next: closeForSessions(s, ids, 'archived', deps.now()), result: null }))
      .catch((e) => console.error(`[your-move] archive close failed: ${(e as Error).message}`))
  }
  // Sessions archived while the app was closed leave cards behind: close them now.
  close([
    ...new Set(
      deps.store
        .state()
        .cards.filter((c) => c.closedAt === undefined && archive.has(c.sessionId))
        .map((c) => c.sessionId)
    )
  ])
  return archive.onChange((changed) => close(changed.filter((id) => archive.has(id))))
}

/** Close the cards of a folder the moment it is removed (hiding it is not removing it). */
export function watchFolderRemoval(deps: {
  store: YourMoveStore
  subscribe(listener: (path: string) => void): () => void
  now(): number
}): () => void {
  return deps.subscribe((removed) => {
    deps.store
      .transact((s) => ({
        next: closeForFolder(s, removed, 'folder-removed', deps.now()),
        result: null
      }))
      .catch((e) => console.error(`[your-move] folder close failed: ${(e as Error).message}`))
  })
}
