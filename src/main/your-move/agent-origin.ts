/**
 * Which sessions Harnu spawned FOR AN AGENT (BUG-308 delta 1). Their launch prompt is stored in
 * the transcript as a human entry, so the transcript alone cannot tell it from the operator.
 *
 * The marker `message_session` reads (`spawnOriginForSession`) lives in memory only: it survives
 * a park, not a restart, and resuming a row by clicking it stamps `operator`. So whatever it says
 * `agent` about is written down here and stays. For sessions that started before this file
 * existed, the companion audit log records the trust class each session was spawned with; it
 * rotates, so it covers only the recent ones.
 *
 * Recall over noise: only a sure `agent` is `true`. Nothing read, a broken file or a marker that
 * throws all mean unknown, and an unknown session keeps its human entry. Electron-free.
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { atomicWriteFile } from '../mcp/atomic-write'

export interface AgentOrigins {
  isAgentSpawned(sessionId: string): Promise<boolean>
  /** Record the session if the live marker says an agent spawned it. Never throws. */
  note(sessionId: string): void
  /** Resolves when every write started so far has settled. */
  idle(): Promise<void>
}

export interface AgentOriginDeps {
  /** The durable list, `userData/your-move-agent-sessions.json`. */
  file: string
  /** The companion audit log, older generation first. */
  auditFiles: readonly string[]
  /** The in-memory spawn marker of the running app. */
  live(sessionId: string): 'agent' | 'operator' | undefined
  now(): number
}

/** The audit log changes with every command: it is read again at most this often. */
const AUDIT_REREAD_MS = 60_000
/** The newest ids kept. */
const MAX_REMEMBERED = 5_000

function agentSidsIn(raw: string, into: Set<string>): void {
  for (const line of raw.split('\n')) {
    if (!line.includes('"agent"')) continue
    try {
      const r = JSON.parse(line) as { kind?: unknown; trust?: unknown; sid?: unknown }
      if (r.kind === 'binding' && r.trust === 'agent' && typeof r.sid === 'string') into.add(r.sid)
    } catch {
      /* a torn line */
    }
  }
}

export function createAgentOrigins(deps: AgentOriginDeps): AgentOrigins {
  const known = new Set<string>()
  let audited = new Set<string>()
  let auditedAt = -Infinity
  let queue: Promise<unknown> = Promise.resolve()

  const loaded: Promise<void> = fs.readFile(deps.file, 'utf8').then(
    (raw) => {
      try {
        const ids = (JSON.parse(raw) as { ids?: unknown }).ids
        if (Array.isArray(ids)) for (const id of ids) if (typeof id === 'string') known.add(id)
      } catch {
        console.warn('[your-move] the agent session list could not be read: starting empty')
      }
    },
    () => undefined
  )

  const remember = (sessionId: string): void => {
    if (known.has(sessionId)) return
    known.add(sessionId)
    queue = queue
      .then(async () => {
        await loaded
        const ids = [...known].slice(-MAX_REMEMBERED)
        await fs.mkdir(path.dirname(deps.file), { recursive: true })
        await atomicWriteFile(deps.file, JSON.stringify({ version: 1, ids }), 0o600)
      })
      .catch((e) =>
        console.error(`[your-move] agent session not saved: ${(e as Error)?.message ?? e}`)
      )
  }

  const liveSaysAgent = (sessionId: string): boolean => {
    try {
      return deps.live(sessionId) === 'agent'
    } catch {
      return false
    }
  }

  async function auditSays(sessionId: string): Promise<boolean> {
    if (deps.now() - auditedAt >= AUDIT_REREAD_MS) {
      auditedAt = deps.now()
      const next = new Set<string>()
      for (const file of deps.auditFiles) {
        try {
          agentSidsIn(await fs.readFile(file, 'utf8'), next)
        } catch {
          /* no log, or not readable: it says nothing */
        }
      }
      audited = next
    }
    return audited.has(sessionId)
  }

  return {
    async isAgentSpawned(sessionId) {
      await loaded
      if (known.has(sessionId)) return true
      if (!liveSaysAgent(sessionId) && !(await auditSays(sessionId))) return false
      remember(sessionId)
      return true
    },
    note(sessionId) {
      if (liveSaysAgent(sessionId)) remember(sessionId)
    },
    async idle() {
      await queue
    }
  }
}
