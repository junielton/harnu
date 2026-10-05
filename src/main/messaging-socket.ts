/**
 * T215 pure core — addressing, reachability and envelope shaping for Claude
 * Code's cross-session inbox (`message_session`).
 *
 * Harnu does NOT reimplement the transport. Claude Code ≥ 2.1.224 binds a
 * per-process Unix domain socket named after its own pid and speaks
 * newline-delimited JSON over it. What Harnu owns is IDENTITY (a Harnu
 * `sessionId` → the exact process, no name guessing), LIFECYCLE (it can wake a
 * session it parked) and GOVERNANCE (the audit ring, the folder block, the
 * `ask` friction pref). This module holds every DECISION in that path; the
 * effects (fs probe, `net.connect`, the write) live in the shell
 * (`src/main/messaging.ts`) per ADR-0001.
 *
 * ── CAPTURED FROM CLAUDE CODE 2.1.241 (2026-08-23) ─────────────────────────
 * The socket-path algorithm below MIRRORS a private function in the CLI
 * binary (`_kh`, formerly `wOS`). It was re-read on 2.1.241 and is unchanged
 * since the 2.1.226 reading in `docs/specs/T215-message-session-verb.md` §2.1
 * except for minified symbol names. RE-VERIFICATION RITUAL (BUG-83 §4.4
 * precedent): when a CLI upgrade changes peer messaging, re-extract the
 * resolver and update {@link MESSAGING_SOCKET_CAPTURED_FROM} in the same
 * change. "The socket path is stable" must never be read as "the wire
 * contract is stable" — the protocol around it (auth frames, `verifiedPeerPid`,
 * hop chains) demonstrably moved in that same window (spec O-6).
 *
 * The named fallback if the algorithm ever becomes unreconstructable is the
 * CLI's own `--messaging-socket-path` flag at spawn — deliberately NOT taken
 * today, because a Harnu-owned path moves Harnu's sessions out of the shared
 * `cc-socks/` namespace and the CLI's receipt check is a DIRECTORY comparison
 * (spec §3.2).
 */

import * as path from 'node:path'
import { createHash } from 'node:crypto'

/** The CLI release every claim in this module was read out of (spec §2.7). */
export const MESSAGING_SOCKET_CAPTURED_FROM = '2.1.241'

/**
 * The CLI's own byte cap on the primary socket path (`EOS`/`QFE` = 103; its
 * error text says "max ~104"). Above it the CLI silently switches to the
 * `/tmp/cc-socks-<uid>/` branch — which is why hardcoding
 * `$XDG_RUNTIME_DIR/cc-socks` is a latent bug on any machine with a long
 * runtime dir, and likely the COMMON case on macOS (a `/var/folders/xx/…/T/`
 * `$TMPDIR` blows the cap routinely — spec O-3).
 */
export const MESSAGING_SOCKET_PATH_MAX = 103

/**
 * The candidate socket paths for `pid`, most-likely first. Mirrors the CLI's
 * own resolver including the {@link MESSAGING_SOCKET_PATH_MAX} cap and the
 * Termux branch:
 *
 * ```js
 * let e = env.XDG_RUNTIME_DIR || (env.CLAUDE_CODE_TMPDIR || os.tmpdir()),
 *   t = path.join(e, 'cc-socks', `${pid}.sock`)
 * if (Buffer.byteLength(t) <= 103) return t
 * let r = env.TERMUX_VERSION ? env.PREFIX : undefined,
 *   n = r ? path.join(r, 'tmp') : '/tmp'
 * return path.join(n, `cc-socks-${uid}`, `${pid}.sock`)
 * ```
 *
 * Two deliberate differences from the CLI, both in the safe direction:
 *  - the fallback is ALWAYS returned as a second candidate when the primary
 *    fits, so a resolver probes both directories rather than trusting one path
 *    (spec §3.2 — "never trust one path"); the caller still requires an
 *    existence check AND a connect probe on whichever answers;
 *  - when the primary EXCEEDS the cap it is dropped entirely, because the CLI
 *    could not have bound there — leaving it in would invite a write to a path
 *    no `claude` ever listens on.
 *
 * Windows is deliberately unrepresented: `claude` maps to a named pipe
 * (`\\.\pipe\cc-msg-…`) there, not a path of this shape, so the caller degrades
 * to `PEER_NO_SOCKET` honestly rather than claiming support it never verified
 * (spec O-3 — neither macOS nor Windows was executed).
 *
 * @param pid - the listening process's own pid (the socket is named after it).
 * @param env - the environment to resolve from (injected, so this stays pure).
 * @param uid - the effective uid, for the `/tmp/cc-socks-<uid>/` branch.
 * @param tmpDir - `os.tmpdir()`, injected for the same reason.
 * @returns candidate absolute paths, most-likely first. Never empty.
 */
export function messagingSocketCandidates(
  pid: number,
  env: Record<string, string | undefined>,
  uid: number,
  tmpDir: string
): string[] {
  const runtimeDir = env.XDG_RUNTIME_DIR || env.CLAUDE_CODE_TMPDIR || tmpDir
  const primary = path.join(runtimeDir, 'cc-socks', `${pid}.sock`)
  const termuxPrefix = env.TERMUX_VERSION ? env.PREFIX : undefined
  const fallbackRoot = termuxPrefix ? path.join(termuxPrefix, 'tmp') : '/tmp'
  const fallback = path.join(fallbackRoot, `cc-socks-${uid}`, `${pid}.sock`)
  if (Buffer.byteLength(primary) > MESSAGING_SOCKET_PATH_MAX) return [fallback]
  return primary === fallback ? [primary] : [primary, fallback]
}

// ---- the recipient predicate (spec §3.2a) ----------------------------------

/**
 * True iff Harnu owns (or parked) the process behind this session key, IN THIS
 * APP RUN — the recipient scope the operator decided on 2026-08-23.
 *
 * Both arms are CAUSAL, not correlational:
 *  - `indexHit` is `PtySessionIndex.has`. The only write to that index is
 *    `pty.ts`'s single `sessionIndex.register`, inside the single `pty:create`
 *    handler, right after the single `spawn()`. Nothing else in the codebase
 *    can put a key there, so a hit means Harnu ran `spawn()` for it and the
 *    child is still alive.
 *  - `isParked` is `hibernation.ts`'s flag, written only by `markHibernated`,
 *    called only from `hibernateSession`, which itself bails unless the key
 *    HAD an index entry. A parked key is provably one Harnu spawned and then
 *    killed itself. Without this arm the wake (spec §3.4) would be dead code,
 *    because `hibernateSession` removes the index entry before setting the flag.
 *
 * It deliberately does NOT consult the board, the in-flight registry,
 * `agentControlled`, or the terminal ledger — spec §3.2a records why each is
 * wrong. The board one matters most: Harnu binds `session` to a card only on
 * manifest/board dispatch, so a card-bound predicate would refuse every
 * MANUALLY dispatched session (`create_worktree` + `create_session`), which is
 * the most-used path.
 *
 * Returns `false` after an app restart. That is a TRUE negative — the process
 * is gone too — not a regression.
 */
export function harnuOwnsSession(indexHit: boolean, isParked: boolean): boolean {
  return indexHit || isParked
}

/**
 * Who caused the spawn Harnu is holding (the T215 DoD ownership marker).
 *
 * `harnuOwnsSession` above cannot make this distinction: a session the OPERATOR
 * opens inside Harnu ("+ New session", or selecting a cold transcript) goes
 * through the same `pty:create` and lands in the same index as one an agent
 * dispatched. This marker is stamped at ORIGIN instead — the renderer knows
 * which gesture caused the spawn — and rides on the PTY record so the send
 * path can read it. See {@link isMessageableOwner}.
 */
export type SpawnOrigin = 'operator' | 'agent'

/**
 * Whether a recipient's spawn origin permits a brokered peer message.
 *
 * Fails CLOSED: an unknown/absent origin is treated as `'operator'`, so a
 * spawn path that forgets to stamp the marker refuses rather than silently
 * opening the operator's own session to agent traffic.
 *
 * This is the second half of the containment the recipient predicate could not
 * deliver on its own (spec §3.2a "What this predicate does NOT cover", point 1,
 * and O-9). It narrows, and never widens, `harnuOwnsSession`.
 */
export function isMessageableOwner(origin: SpawnOrigin | undefined): boolean {
  return origin === 'agent'
}

// ---- reachability (spec §6.1 — the interface T213 consumes) ----------------

/**
 * How reachable a session is WITHOUT sending anything. Answers T213's O-3: its
 * operator dialog must render the rung BEFORE the operator commits, and a
 * send-and-see probe is unacceptable when a partial send may already have
 * landed.
 */
export type Reachability =
  /** Harnu-owned process, socket answers. */
  | { rung: 'socket'; pid: number; socket: string }
  /** Harnu-owned process, unaddressable (no socket, or it refused). */
  | { rung: 'no-socket'; pid: number }
  /** Harnu parked it; wakeable (spec §3.4). */
  | { rung: 'parked' }
  /**
   * NO PROCESS HARNU OWNS. Historically documented as "no process, not parked" —
   * Harnu cannot make that claim. A `claude` the operator runs in their own
   * terminal produces exactly this state while being very much alive. The rung
   * NAME is kept (T213's operator dialog renders it), but its contract is "no
   * process Harnu owns". v1 refuses it.
   */
  | { rung: 'cold' }
  /** The id is not in the scan and not in either in-flight registry. */
  | { rung: 'unknown-session' }

/** The observations {@link classifyReachability} decides from. */
export interface ReachabilityInput {
  /** Is the id known at all (fleet scan ∪ in-flight registries)? */
  known: boolean
  /** `PtySessionIndex.has(sessionKey)`. */
  indexHit: boolean
  /** `isHibernated(sessionKey)`. */
  isParked: boolean
  /** The live pid bound to this key, when there is one. */
  pid?: number
  /** The candidate that both EXISTS and accepted a connect, when one did. */
  socket?: string
}

/**
 * Classify a session into its {@link Reachability} rung. Pure: every
 * observation is passed in.
 *
 * Order is load-bearing. The index arm is checked before the parked flag so a
 * live session is never reported `parked`, and `parked` is checked before
 * `cold` so the two can never collapse — T213's rung 3 wakes one and must not
 * wake the other (spec §6.3).
 */
export function classifyReachability(input: ReachabilityInput): Reachability {
  if (!input.known) return { rung: 'unknown-session' }
  if (input.indexHit && typeof input.pid === 'number') {
    if (input.socket) return { rung: 'socket', pid: input.pid, socket: input.socket }
    return { rung: 'no-socket', pid: input.pid }
  }
  if (input.isParked) return { rung: 'parked' }
  return { rung: 'cold' }
}

// ---- the wire shapes (spec §3.3) ------------------------------------------

/** The schema cap on a message body. Keeps the audit hash + Activity row bounded. */
export const MESSAGE_MAX_CHARS = 4096

/** Sender name Harnu puts on every brokered message. */
export const PEER_FROM_NAME = 'Harnu'

/**
 * Build the body envelope the recipient parses out of the message text.
 *
 * THE ONE HARD CONSTRAINT: this NEVER emits `from-mode`. That attribute is a
 * SENDER-ASSERTED permission-parity claim, and the 2026-08-23 probe (spec §2.7,
 * B1/B2) showed it is exactly what defeats the recipient's hold: a
 * bypass-mode recipient HOLDS a message with no `from-mode` and ACCEPTS the
 * same message when the sender asserts `from-mode="bypass"`. Emitting it would
 * make Harnu the laundering machine the CLI's own inbound wrapper exists to warn
 * about. Omitting it is what leaves the recipient's hold able to fire.
 *
 * `from` is also omitted, deliberately: it is a receipt REPLY ADDRESS, and Harnu
 * binds no socket of its own (spec O-2). A fabricated address makes the
 * recipient log an ENOENT at best, and a real one belonging to another session
 * misdirects a receipt at worst. With it absent the recipient stamps
 * `origin.from = "unknown"` and skips the receipt — the shape probe P1
 * exercised end to end.
 *
 * The recipient's parser plucks attributes independently
 * (`\bfrom="([^"]+)"`, `\bfrom-name="([^"]+)"`, … each with a `??` fallback)
 * and strips the tags with unconditional replaces, so attribute ORDER does not
 * matter and an omitted attribute is not a parse failure.
 */
export function buildPeerEnvelope(input: { fromSession: string; body: string }): string {
  const open =
    `<cross-session-message from-name="${escapeAttr(PEER_FROM_NAME)}"` +
    ` from-session="${escapeAttr(input.fromSession)}">`
  return `${open}\n${input.body}\n</cross-session-message>`
}

/**
 * Escape a value for a double-quoted attribute in the envelope.
 *
 * `>` matters as much as `"` here: the recipient's tag matcher is
 * `^<cross-session-message\b([^>]*)>`, so a raw `>` inside an attribute would
 * terminate the opening tag early and the rest would land in the body as
 * literal text.
 */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * Build the single NDJSON line written to the peer's socket.
 *
 * This is the CLI's OWN documented injection recipe, verbatim in shape — and
 * that shape IS the peer wire form, not an operator impersonation. The
 * recipient's `type:"user"` handler builds the origin itself and
 * unconditionally stamps `kind:"peer"` before running its hold gate; a
 * sender-supplied `origin`/`senderTaskId` is discarded (spec §2.4's correction,
 * probes P2/P3/P7). So Harnu sends the plain frame and asserts nothing.
 *
 * No `auth` frame: auth is Windows-only on the CLI side
 * (`Hti() = platform === "windows"`), and the Linux bind line says so itself
 * ("auth line optional here").
 */
export function buildUserFrame(body: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: body } })
}

// ---- audit + activity shaping (spec §3.6) ---------------------------------

/** First 12 hex chars of the body's sha256 — pins WHAT was said without storing it. */
export function bodyHashPrefix(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 12)
}

/**
 * The audit row's `disclosedPayloadSummary` for one brokered message.
 *
 * The FULL BODY DELIBERATELY DOES NOT GO IN THE RING. 200 entries × 4 KiB of
 * plaintext persisted to `<userData>/mcp-audit.json` is a transcript of every
 * inter-agent message — a disclosure liability, not an audit. The hash pins
 * what was said; the row proves THAT it was said, to whom, and when.
 */
export function messageAuditSummary(input: {
  sessionId: string
  pid: number
  chars: number
  bytes: number
  body: string
}): string {
  // Both a char count and a byte count: §3.6 specifies the former in its format
  // string and §7's acceptance asks for the latter, and they differ the moment a
  // message carries anything non-ASCII. Carrying both costs nothing and makes
  // the row answer either question without a reader having to guess which the
  // number is.
  return (
    `message_session → ${input.sessionId} (pid ${input.pid}), ` +
    `${input.chars} chars / ${input.bytes} bytes, sha256:${bodyHashPrefix(input.body)}`
  )
}

/** `notify`'s existing description budget — the Activity row reuses that surface. */
export const ACTIVITY_DESCRIPTION_MAX = 2_000

/**
 * The operator-readable copy of the body for the Activity row, truncated to
 * `notify`'s existing budget with an EXPLICIT marker so a clipped message is
 * never mistaken for the whole one.
 */
export function activityDescription(body: string, cap = ACTIVITY_DESCRIPTION_MAX): string {
  if (body.length <= cap) return body
  const marker = '… (truncated)'
  return `${body.slice(0, Math.max(0, cap - marker.length))}${marker}`
}
