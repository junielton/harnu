/**
 * T215 SHELL — the effects behind `message_session`: probe the candidate
 * socket paths on disk, open an `AF_UNIX` connection, write one NDJSON line.
 *
 * Every DECISION lives in the pure core (`messaging-socket.ts`, in the coverage
 * surface and unit-tested) — the candidate algorithm, the recipient predicate,
 * the rung classifier, the envelope and the audit summary. This module only
 * marshals the effect, which is why it is coverage-excluded like every other
 * env-bound shell (ADR-0001; see `vitest.config.mts`).
 *
 * WHAT THIS MODULE DOES NOT DO, deliberately:
 *  - it never spawns a process. A recipient with no Harnu-owned process is
 *    refused, not started (spec §3.4). Waking a session Harnu PARKED is the
 *    caller's business, through the renderer bridge, before it calls here.
 *  - it never binds a socket of its own, so it learns nothing about what the
 *    recipient did with the message. That is why the ACK says `queued`, never
 *    `delivered` (spec O-2, §4 point 4).
 *  - it never emits `from-mode`. See `buildPeerEnvelope`.
 */

import * as net from 'node:net'
import * as os from 'node:os'
import { promises as fs } from 'node:fs'
import {
  buildPeerEnvelope,
  buildUserFrame,
  classifyReachability,
  messagingSocketCandidates,
  type Reachability
} from './messaging-socket'
import { pidForSession, sessionOwnedByHarnu } from './pty'
import { isHibernated } from './hibernation'

/** How long a `net.connect` may take before the candidate counts as dead. */
const CONNECT_TIMEOUT_MS = 750

/**
 * Result of resolving a session to a writable peer socket. `socketFound`
 * distinguishes `PEER_NO_SOCKET` (nothing on disk in either candidate dir)
 * from `PEER_SOCKET_DEAD` (a file is there but nothing answers — a stale
 * `.sock` left by a crashed process, which is a real and common state).
 */
export interface SocketResolution {
  pid: number
  /** The candidate that both exists AND accepted a connect. */
  socket?: string
  /** Whether ANY candidate path exists on disk. */
  socketFound: boolean
  /** Every path that was probed, for the failure hint. */
  candidates: string[]
}

/** Does this path exist (as anything)? Never throws. */
async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p)
    return true
  } catch {
    return false
  }
}

/**
 * Open a connection to `socketPath`, or resolve `null` if it refuses/times out.
 * The caller owns the returned socket and must `end()` it.
 */
function connectUnix(socketPath: string): Promise<net.Socket | null> {
  return new Promise((resolve) => {
    let settled = false
    const sock = net.connect(socketPath)
    const fail = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      sock.removeListener('error', onError)
      sock.removeListener('connect', onConnect)
      sock.destroy()
      resolve(null)
    }
    // Named, so BOTH are genuinely detachable once the connect phase settles —
    // a leftover connect-phase error handler would swallow a later write error
    // that the caller's own handler needs to see.
    const onError = (): void => fail()
    const onConnect = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      sock.removeListener('error', onError)
      resolve(sock)
    }
    const timer = setTimeout(fail, CONNECT_TIMEOUT_MS)
    sock.once('connect', onConnect)
    sock.once('error', onError)
  })
}

/**
 * Resolve a session key to a live, answering peer socket.
 *
 * BOTH checks are required and neither is sufficient. A stale `.sock` file
 * survives a crashed process (observed in the field: a socket file a full day
 * older than its dead pid), so existence alone would write into nothing. And a
 * `<pid>.sock` whose pid has been RECYCLED is a wrong-recipient hazard, not
 * merely a dead write — which is why the pid comes from Harnu's own live index
 * on every call rather than from a cache. Harnu's index is the freshness proof
 * the filesystem cannot give (spec §3.2, O-4): nothing is ever memoized here,
 * so there is no stale `peer` address to replay across a park→wake cycle.
 *
 * Returns `null` when Harnu holds no process for the key at all.
 */
export async function resolvePeerSocket(sessionKey: string): Promise<SocketResolution | null> {
  const pid = pidForSession(sessionKey)
  if (pid === null) return null
  const candidates = messagingSocketCandidates(
    pid,
    process.env,
    process.getuid?.() ?? 0,
    os.tmpdir()
  )
  let socketFound = false
  for (const candidate of candidates) {
    if (!(await pathExists(candidate))) continue
    socketFound = true
    const sock = await connectUnix(candidate)
    if (!sock) continue
    sock.end()
    // Re-read the index AFTER the async probe: a session that exited (or was
    // parked) mid-probe must not have its now-recyclable pid written to.
    if (pidForSession(sessionKey) !== pid) return null
    return { pid, socket: candidate, socketFound: true, candidates }
  }
  return { pid, socketFound, candidates }
}

/**
 * Reachability WITHOUT sending — the export T213 consumes (spec §6.1, T213's
 * O-3). NEVER writes to any socket: it opens a connection to prove the peer
 * answers and closes it again, which is the only way to tell a live socket from
 * a stale file, and it is what a send-and-see probe would do anyway minus the
 * side effect.
 *
 * @param sessionKey - the Harnu session id.
 * @param opts.known - whether the id resolves in the fleet (scan ∪ the
 *   in-flight registries). The caller owns that lookup; defaults to `true` so a
 *   caller that has already resolved the id does not have to restate it.
 */
export async function probeSessionReachability(
  sessionKey: string,
  opts: { known?: boolean } = {}
): Promise<Reachability> {
  const known = opts.known ?? true
  if (!known) return classifyReachability({ known: false, indexHit: false, isParked: false })
  const resolution = await resolvePeerSocket(sessionKey)
  return classifyReachability({
    known: true,
    indexHit: resolution !== null,
    isParked: isHibernated(sessionKey),
    ...(resolution ? { pid: resolution.pid } : {}),
    ...(resolution?.socket ? { socket: resolution.socket } : {})
  })
}

/** Why a write failed, mapped 1:1 onto the verb's steerable failure codes. */
export type PeerWriteFailure = 'PEER_NO_SOCKET' | 'PEER_SOCKET_DEAD' | 'SOCKET_WRITE_FAILED'

/** Outcome of {@link sendPeerMessage}. `queued`, never `delivered` — see the module doc. */
export type PeerWriteResult =
  | { ok: true; pid: number; socket: string; bytes: number }
  | { ok: false; code: PeerWriteFailure; pid?: number; candidates?: string[] }

/**
 * Write ONE peer message into a session's inbox.
 *
 * The frame is the CLI's own documented injection recipe — which IS the peer
 * wire form, because the RECIPIENT builds the origin and unconditionally stamps
 * `kind:"peer"` before running its own hold gate. Harnu asserts nothing about
 * itself in the frame; its attribution rides in the body envelope, which never
 * carries `from-mode`.
 *
 * `ok:true` means the bytes reached the peer's socket. It does NOT mean the
 * message was read, held, denied or acted on — Harnu has no receipt channel.
 */
export async function sendPeerMessage(sessionKey: string, body: string): Promise<PeerWriteResult> {
  if (!sessionOwnedByHarnu(sessionKey)) return { ok: false, code: 'PEER_NO_SOCKET' }
  const resolution = await resolvePeerSocket(sessionKey)
  if (!resolution) return { ok: false, code: 'PEER_NO_SOCKET' }
  if (!resolution.socket) {
    return {
      ok: false,
      code: resolution.socketFound ? 'PEER_SOCKET_DEAD' : 'PEER_NO_SOCKET',
      pid: resolution.pid,
      candidates: resolution.candidates
    }
  }
  const line = `${buildUserFrame(buildPeerEnvelope({ fromSession: sessionKey, body }))}\n`
  const sock = await connectUnix(resolution.socket)
  if (!sock) {
    return { ok: false, code: 'PEER_SOCKET_DEAD', pid: resolution.pid }
  }
  const wrote = await new Promise<boolean>((resolve) => {
    sock.once('error', () => resolve(false))
    sock.end(line, () => resolve(true))
  })
  if (!wrote) return { ok: false, code: 'SOCKET_WRITE_FAILED', pid: resolution.pid }
  return {
    ok: true,
    pid: resolution.pid,
    socket: resolution.socket,
    bytes: Buffer.byteLength(line, 'utf8')
  }
}

/**
 * The `peer` address for a live session, for `get_fleet`/`get_session` (§3.7).
 * `null` unless Harnu owns the process AND a socket actually answers — an
 * address that only might work is worse than none, because a caller would read
 * it as reachability.
 */
export async function peerAddressForSession(
  sessionKey: string
): Promise<{ pid: number; socket: string } | null> {
  const resolution = await resolvePeerSocket(sessionKey)
  if (!resolution?.socket) return null
  return { pid: resolution.pid, socket: resolution.socket }
}
