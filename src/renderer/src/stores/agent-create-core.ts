/**
 * Pure mint + correlation-bind core for agent-created sessions (MCP fleet).
 *
 * Why a separate module from `sessions.ts`'s `createNewSession` /
 * `createForkedSession`:
 *
 *  1. **Non-dedupe mint.** `createNewSession` enforces "one synthetic per folder"
 *     — calling it on a folder that already has a synthetic re-selects the
 *     existing one. That is right for a human clicking `+ New session`, but wrong
 *     for agents: two agents (or an agent and a human) can legitimately ask for a
 *     session in the SAME folder concurrently. Each agent request must mint a
 *     FRESH `synthetic-<uuid>`, never reusing the folder's existing user synthetic.
 *
 *  2. **Deterministic bind, not recency.** When the real JSONL lands on disk,
 *     `reconcileSessionAdded` migrates the "newest synthetic in the folder" to the
 *     real id. With several coexisting synthetics that recency heuristic can bind
 *     the WRONG one (a user synthetic, or another agent's). So every agent
 *     synthetic carries an opaque `correlationId` minted here; {@link bindMigration}
 *     matches THAT token, binding the agent's own synthetic and leaving every other
 *     synthetic untouched.
 *
 * Pure module (ADR-0001 pure-core/thin-shell): no electron / node / Pinia import.
 * The only side effect — id generation — is injected via `genId` so the core is
 * deterministic under test. The shell (sessions store) inserts the returned
 * synthetic into `folder.sessions[]` and applies the bind result.
 */

/** Injectable id source. Defaults to `crypto.randomUUID`. */
export type IdGen = () => string

const defaultGenId: IdGen = () => crypto.randomUUID()

/** A freshly minted agent synthetic plus the token that binds it to its real id. */
export interface AgentSession {
  /** `synthetic-<uuid>` id — a fresh, NON-deduped synthetic session id. */
  syntheticId: string
  /** Opaque correlation token tying THIS synthetic to its eventual real uuid. */
  correlationId: string
  /** cwd the synthetic launches in — echoed so the caller inserts into the right folder. */
  folderPath: string
}

/** One candidate synthetic considered during a migration bind. */
export interface SyntheticCandidate {
  /** The synthetic's current `synthetic-<uuid>` id. */
  syntheticId: string
  /**
   * Correlation token if this synthetic was agent-minted (via {@link makeAgentSession});
   * `undefined` for plain user `+ New session` synthetics, which carry none.
   */
  correlationId?: string
}

/** Success: the agent's OWN synthetic to migrate, plus the real uuid it binds to. */
export interface BindSuccess {
  boundSyntheticId: string
  realUuid: string
}

/** Failure: no candidate carried the requested correlation token (or bad input). */
export interface BindError {
  error: string
}

/** Discriminated by key presence: success has `boundSyntheticId`, failure has `error`. */
export type BindResult = BindSuccess | BindError

/**
 * Mint a fresh, NON-deduped synthetic session for an agent request in `folderPath`.
 *
 * Unlike `createNewSession`, this never inspects existing folder sessions and never
 * reuses a folder's current user synthetic — every call mints a brand-new
 * `synthetic-<uuid>` plus a unique `correlationId`. The correlation token is what
 * {@link bindMigration} later uses to bind THIS synthetic (and only this one) to the
 * real session id once its JSONL lands on disk.
 *
 * @param folderPath - cwd the agent session launches in; echoed on the result.
 * @param genId - injectable id generator (default `crypto.randomUUID`); two ids are drawn.
 * @returns the synthetic id, its correlation token, and the folder path.
 */
export function makeAgentSession(folderPath: string, genId: IdGen = defaultGenId): AgentSession {
  const syntheticId = `synthetic-${genId()}`
  const correlationId = `agent-corr-${genId()}`
  return { syntheticId, correlationId, folderPath }
}

/**
 * Deterministically bind an agent's own synthetic to a freshly-landed real uuid by
 * its correlation token — NOT by the recency heuristic used for user synthetics.
 *
 * Scans `candidates` for the one whose `correlationId` equals `correlationId` and
 * returns its `syntheticId` paired with `realUuid`. Every other candidate (a
 * coexisting user synthetic, or another agent's synthetic) is left untouched — this
 * function is pure and never mutates its inputs. Returns a `{ error }` result when
 * `correlationId`/`realUuid` is empty or no candidate correlates.
 *
 * @param correlationId - the token returned by {@link makeAgentSession} for this agent.
 * @param candidates - the folder's current synthetics (agent-minted carry a token, user ones don't).
 * @param realUuid - the real session id that has just appeared on disk.
 * @returns `{ boundSyntheticId, realUuid }` on a match, else `{ error }`.
 */
export function bindMigration(
  correlationId: string,
  candidates: ReadonlyArray<SyntheticCandidate>,
  realUuid: string
): BindResult {
  if (!correlationId) return { error: 'empty correlationId' }
  if (!realUuid) return { error: 'empty realUuid' }

  const match = candidates.find((c) => c.correlationId === correlationId)
  if (!match) return { error: `no synthetic matches correlation ${correlationId}` }

  return { boundSyntheticId: match.syntheticId, realUuid }
}
