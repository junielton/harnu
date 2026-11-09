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
  closeForFolder,
  closeForSessions,
  reconcileSource,
  type CardLane,
  type StructuredDraft,
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

/**
 * The human-gating tool call the session is parked on, or null. It is pending when the last
 * conversation entry is an assistant entry holding one: a resolved call would be followed by
 * its result, and a subagent's entries (`isSidechain`) are not the session's own. `stop_reason`
 * is not looked at, so a gate still marked as streaming counts: a miss costs a session.
 */
export function pendingHumanGate(lines: readonly Record<string, unknown>[]): PendingGate | null {
  let last: Record<string, unknown> | null = null
  for (let i = lines.length - 1; i >= 0; i--) {
    const e = lines[i]
    if (e.isSidechain === true || !isChainParticipant(e)) continue
    last = e
    break
  }
  if (!last || last.type !== 'assistant') return null
  const message = last.message as { content?: unknown } | undefined
  if (!message || !Array.isArray(message.content)) return null
  for (const block of message.content) {
    if (!block || typeof block !== 'object') continue
    const b = block as { type?: unknown; name?: unknown; id?: unknown; input?: unknown }
    if (b.type !== 'tool_use' || typeof b.name !== 'string' || !HUMAN_GATING_TOOLS.has(b.name)) {
      continue
    }
    const input = (b.input && typeof b.input === 'object' ? b.input : {}) as {
      questions?: unknown
    }
    const first = Array.isArray(input.questions) ? input.questions[0] : undefined
    const question =
      b.name === 'AskUserQuestion' &&
      first &&
      typeof first === 'object' &&
      typeof (first as { question?: unknown }).question === 'string'
        ? ((first as { question: string }).question as string).trim()
        : ''
    return {
      toolUseId: typeof b.id === 'string' && b.id !== '' ? b.id : `${b.name}:${String(last.uuid)}`,
      tool: b.name,
      question
    }
  }
  return null
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
  /** The folded task state of every live session. */
  states(): ReadonlyMap<string, TaskState>
  mintId(): string
  now(): number
}

/**
 * Keeps one `gate:` card per parked gate. Looks at a session when it enters needs-input, on the
 * sweep, and while it still has an open gate card (to close that card once answered).
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

  const hasOpenGate = (sessionId: string): boolean =>
    deps.store
      .state()
      .cards.some(
        (c) => c.closedAt === undefined && c.source === 'human-gate' && c.sessionId === sessionId
      )

  async function check(
    sessionId: string,
    hint: { cwd?: string; path?: string } = {}
  ): Promise<void> {
    const path = hint.path ?? (await deps.locate(sessionId))
    if (!path || disposed) return
    const folder = await deps.resolveFolder(sessionId, hint.cwd, path)
    if (!folder || !(await deps.eligible(sessionId, folder)) || disposed) return
    const res = await deps.read(path, { tail: GATE_TAIL_BYTES })
    const gate = pendingHumanGate(res.lines)
    if (!gate && !hasOpenGate(sessionId)) return
    const owed = gate ? [gateDraft(gate, sessionId, folder, deps.lane())] : []
    await deps.store.transact((s) => ({
      next: reconcileSource(s, { source: 'human-gate', sessionId }, owed, deps.mintId, deps.now()),
      result: undefined
    }))
  }

  function run(sessionId: string, hint?: { cwd?: string; path?: string }): Promise<void> {
    if (checking.has(sessionId)) return Promise.resolve()
    checking.add(sessionId)
    const p = check(sessionId, hint)
      .catch((e) => console.error(`[your-move] gate check failed: ${(e as Error)?.message ?? e}`))
      .finally(() => {
        checking.delete(sessionId)
        pending.delete(p)
      })
    pending.add(p)
    return p
  }

  return {
    onTaskEvent(ev) {
      if (disposed || deps.mode() === 'off' || ev.agentId !== undefined) return
      if (ev.taskState === 'needs-input' || hasOpenGate(ev.sessionId)) {
        void run(ev.sessionId, { cwd: ev.payload?.cwd, path: ev.payload?.transcriptPath })
      }
    },
    async tick() {
      if (disposed || deps.mode() === 'off') return
      const ids = new Set<string>()
      for (const [id, state] of deps.states()) if (state === 'needs-input') ids.add(id)
      for (const c of deps.store.state().cards) {
        if (c.closedAt === undefined && c.source === 'human-gate') ids.add(c.sessionId)
      }
      for (const id of ids) {
        if (disposed) return
        await run(id)
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
