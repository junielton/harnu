/**
 * The one implementation of "a session Harnu spawned for an agent" (ADR-0013): shared by the
 * `orchestrator_arm` / `orchestrator_disarm` handlers and the companion command gate (T389 P2W1),
 * so the two cannot drift apart. Extracted unchanged from `tool-handlers.ts`.
 */

import type { FolderEntry } from '../folder-model'
import { sessionOwnedByHarnu, spawnOriginForSession } from '../pty'
import { isMessageableOwner } from '../messaging-socket'
import { inFlightFolderFor } from './agent-inflight-registry'
import { listInflightSessions } from './inflight-session-registry'

/**
 * Shared target predicate (ADR-0013): resolve whether `sessionId` is known to
 * Harnu at all, and — if so — whether it is a session Harnu itself spawned for
 * an agent. Mirrors `message_session`'s steps 1/3/4 exactly (same imports, same
 * order), because the addressing decision this card made IS "reuse that
 * boundary" — see the ADR for why a second implementation was rejected.
 */
export function resolveAgentTarget(
  sessionId: string,
  folders: FolderEntry[]
): 'not_found' | 'not_harnu_spawned' | 'operator_owned' | 'ok' {
  const onDisk = folders.some((f) => f.sessions.some((sn) => sn.sessionId === sessionId))
  const inflight =
    listInflightSessions().some((e) => e.syntheticId === sessionId) ||
    inFlightFolderFor(sessionId) !== undefined
  if (!onDisk && !inflight) return 'not_found'
  if (!sessionOwnedByHarnu(sessionId)) return 'not_harnu_spawned'
  if (!isMessageableOwner(spawnOriginForSession(sessionId))) return 'operator_owned'
  return 'ok'
}
