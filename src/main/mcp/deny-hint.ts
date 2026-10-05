/**
 * T44 Slice 1 — "errors that steer". Turn a gate DENY reason into a structured,
 * agent-actionable hint. In an LLM-driven control surface the error message IS
 * the discovery interface: a bare `FOLDER_NOT_ALLOWED` is a dead end the agent
 * retries blindly; a hint that names the *exact* way forward (the human grant, a
 * contained path, the master switch) lets it proceed or ask the operator
 * precisely.
 *
 * Pure + deterministic. Keyed off the audit `result` string (the machine reason).
 * Returns `null` for results that carry no actionable affordance (BAD_ARGS /
 * UNKNOWN_TOOL / operator denials) so the caller keeps the existing bare-string
 * error for those.
 *
 * UPDATED 2026-07-14 (free-by-default reversal, PR #113): there is no more
 * allowlist to be granted onto. `FOLDER_NOT_ALLOWED` now means the operator
 * EXPLICITLY BLOCKED this folder (`agentDenied`) — absolute, and it covers the
 * whole subtree. The old copy told the agent to go ask for a grant that no
 * longer exists as a concept; that steer is gone. `PATH_ESCAPE` is likewise
 * only reachable in the opt-in guarded (`ask`) mode now (`permission-core.ts`).
 */

/** One concrete way for the agent to progress (a verb to call, or a human ask). */
export interface NextAction {
  /** What to do — an MCP verb to call, or an operator action to request. */
  do: string
  /** Why it unblocks the call. */
  why: string
}

/** A gate denial reshaped for the agent: machine key + explanation + affordances. */
export interface SteerableDenial {
  /** The machine-readable reason (unchanged — still greppable/auditable). */
  error: string
  /** A one-line explanation the agent (and, via it, the human) can act on. */
  message: string
  /** Ordered concrete next steps. */
  nextActions: NextAction[]
  /** The spawn this denial is about, when known (BUG-58 — SPAWN_NOT_MATERIALIZED). */
  syntheticId?: string
}

/**
 * Reshape a gate deny `result` into a steerable denial, or `null` when the result
 * has no useful affordance (leave those as the existing bare error).
 */
export function shapeDenial(
  result: string,
  ctx: { folder?: string; syntheticId?: string } = {}
): SteerableDenial | null {
  const at = ctx.folder ? ` (${ctx.folder})` : ''
  switch (result) {
    case 'FOLDER_NOT_ALLOWED':
      return {
        error: result,
        message: `The operator explicitly blocked agent activity in this folder${at} (or a parent of it). This is not a missing grant — agents are free by default everywhere else — it is a deliberate block, and it is absolute.`,
        nextActions: [
          {
            do: "Ask the operator to unblock this folder (right-click it in the sidebar → 'Allow agent control', or Settings → Control server → blocked folders), then retry.",
            why: 'A block covers the folder and everything under it; no grant, confirm, or discovery step can override it — only the operator lifting the block does.'
          }
        ]
      }
    case 'PATH_ESCAPE':
      return {
        error: result,
        message: `The target path${at} is outside the known repository roots, and this Harnu is running in the guarded ("Ask before agent actions") mode, which enforces that boundary.`,
        nextActions: [
          {
            do: 'Target a path inside a folder Harnu already tracks — a pinned repo or one of its worktrees.',
            why: 'Containment is only enforced in guarded mode; in the default free mode this call would not have been refused for this reason.'
          }
        ]
      }
    case 'SERVER_DISABLED':
      return {
        error: result,
        message: 'The Harnu control server is disabled, so every tool call is refused.',
        nextActions: [
          {
            do: 'Ask the operator to enable the control server (Settings → Control server).',
            why: 'The master switch is off; nothing dispatches until it is turned on.'
          }
        ]
      }
    // T74 S4: `open_file` named a file outside the known Harnu folders — the viewer
    // confines reads to the pinned + scanned roots, so the file can never load.
    case 'MARKDOWN_OUTSIDE_ROOTS':
      return {
        error: result,
        message: `That file${at} is outside Harnu's known folders, so the viewer will not read it.`,
        nextActions: [
          {
            do: 'Point open_file at a file inside a folder Harnu already tracks (a pinned repo or one of its worktrees); if the file lives in an untracked folder, ask the operator to pin that folder first (or use adopt_folder on it).',
            why: 'The viewer confines every read to the known roots; a path outside them can never be opened.'
          }
        ]
      }
    // 2026-07-13 agent-pane-routing design: the gate anchor resolved (the
    // caller IS allowlisted), but its raw spelling (a trailing slash, a
    // symlink, ...) doesn't match any KNOWN folder's canonical path — routing
    // a pane by it would silently append to a stack no session ever renders
    // (the hidden cause behind BUG-20). Steer instead of silently no-opping.
    case 'PANE_FOLDER_UNKNOWN':
      return {
        error: result,
        message: `This folder${at} doesn't match any folder Harnu currently tracks, so a pane can't be routed to a stack the operator would actually see.`,
        nextActions: [
          {
            do: 'Call get_fleet or list_worktrees to see the known folder paths, and retry with the exact one listed there.',
            why: "A pane only ever lands in a KNOWN folder's split stack — an unrecognized spelling has no stack to append to."
          }
        ]
      }
    // This card (2026-07-19): a second create_session for a folder that already
    // has an un-materialized spawn in flight — the structural fix for the
    // 2026-07-18 five-process collision (never queue a duplicate silently).
    case 'SESSION_ALREADY_IN_FLIGHT':
      return {
        error: result,
        message: `A create_session for this folder${at} is already in flight and has not yet materialized (or finished timing out).`,
        nextActions: [
          {
            do: 'Wait for the in-flight call to resolve (materialize or time out) before retrying — do not dispatch a second create_session into the same folder.',
            why: 'Two concurrent spawns into one folder land as independent processes sharing the same working tree, which is how a prior incident nearly corrupted a checkout.'
          }
        ]
      }
    // This card: `ok:true` now means MATERIALIZED, not merely dispatched. A spawn
    // that never produced a real process + on-disk transcript within the
    // deadline reports this instead of a silent lie; the reserved grant unit is
    // refunded by the caller (server.ts) since the action never happened.
    //
    // BUG-58: a timeout no longer tears the spawn down or frees the folder — a
    // late materialization is healthy work, and the field has observed a
    // ~14-minute tail. The `syntheticId` (when known) is carried so the agent
    // can adopt/poll it instead of retrying blind; a retry into this same
    // folder is refused with SESSION_ALREADY_IN_FLIGHT until the reservation
    // resolves (materializes or is reaped) — see agent-inflight-registry.ts /
    // inflight-session-registry.ts.
    case 'SPAWN_NOT_MATERIALIZED':
      return {
        error: result,
        message: `create_session was dispatched for this folder${at} but no session materialized (process + on-disk transcript) within the deadline. The reserved budget was refunded. The session was NOT torn down and the folder stays reserved until it resolves${ctx.syntheticId ? ` — adopt it via get_session({ sessionId: '${ctx.syntheticId}' })` : ''}.`,
        nextActions: [
          {
            do: ctx.syntheticId
              ? `Poll get_session({ sessionId: '${ctx.syntheticId}' }) (it reports status "spawning" until the transcript lands) instead of retrying create_session for this folder.`
              : 'Call get_session or get_fleet to check whether the spawn landed late.',
            why: 'The folder reservation is held for this exact spawn — a create_session retry into the same folder while it is unresolved is refused with SESSION_ALREADY_IN_FLIGHT, precisely to stop a second process from landing in the same working tree.'
          }
        ],
        ...(ctx.syntheticId ? { syntheticId: ctx.syntheticId } : {})
      }
    // ---- T215 `message_session` refusals (spec §3.5) ----------------------
    //
    // Every one of these is a DEAD END for the tool call, but never for the
    // agent: each names the exact next move, and none of them ever suggests
    // resuming a session Harnu did not start (that would put a second process
    // on one transcript — the "1 session = 1 process" hazard `pty:create`'s
    // dedup exists to prevent).
    case 'SESSION_NOT_FOUND':
      return {
        error: result,
        message:
          'No session with that id is known to Harnu — it is absent from the folder scan and from both in-flight registries.',
        nextActions: [
          {
            do: 'Call get_fleet and re-read the recipient id from the listing.',
            why: 'Session ids are exact; a stale or hand-edited id resolves to nothing, and a card can hold a dangling synthetic- id long after its session is gone.'
          }
        ]
      }
    // The scope refusal. ONE code, not two, on purpose: "on disk, no PTY, not
    // parked" and "a live `claude` Harnu did not spawn" are the SAME observable
    // state, and Harnu cannot split them without a /proc sweep over the
    // cc-socks/ pids (rejected, and Linux-only). Two codes for one observable
    // would ship a distinction Harnu cannot actually make.
    case 'RECIPIENT_NOT_HARNU_SPAWNED':
      return {
        error: result,
        message:
          'Harnu has no process of its own for that session, so it will not message it. message_session only reaches sessions Harnu itself spawned and still owns (or parked). Harnu cannot tell whether that session is a cold transcript or a live `claude` running outside Harnu — and it refuses both for the same reason: it has no addressable, owned process, and messaging a session it did not start is outside this verb.',
        nextActions: [
          {
            do: 'Call get_fleet and pick a session Harnu is running (or one Harnu parked — those are wakeable).',
            why: "Only a Harnu-owned process has a resolvable pid and socket; the addressing itself starts from Harnu's own session index."
          },
          {
            do: 'If the work needs a NEW session, call create_session (optionally after create_worktree) and message that one.',
            why: 'A session Harnu spawns is in scope from its first turn — including a manually dispatched one, which is never bound to a card.'
          },
          {
            do: 'If the recipient is a `claude` running outside Harnu, ask the operator to reach it — Harnu will not.',
            why: 'Harnu has no identity, lifecycle or audit hold over a process it did not start; brokering into one would be an unaudited door, not an audited one.'
          }
        ]
      }
    // The T215 DoD ownership marker. `harnuOwnsSession` cannot make this
    // distinction — a session the operator opens inside Harnu goes through the
    // same spawn and lands in the same index — so the origin is stamped on the
    // PTY record at spawn time and read back here.
    case 'RECIPIENT_OPERATOR_OWNED':
      return {
        error: result,
        message:
          "That session is one the OPERATOR opened in Harnu, not one Harnu spawned for an agent, so message_session will not inject into it. This is the operator's own session, and an agent does not get to put input in front of them without them asking.",
        nextActions: [
          {
            do: 'Use notify to surface what you need to say — it posts to the Activity history, which the operator reads on their own terms from any window.',
            why: 'A notice waits to be read; a peer message lands in a live turn. For the operator, the first is the right register and the second is an interruption.'
          },
          {
            do: 'If you need a peer that can actually act, call create_session (optionally after create_worktree) and message THAT session.',
            why: 'A session Harnu spawns for an agent is in scope from its first turn — including a manually dispatched one, which is never bound to a card.'
          }
        ]
      }
    case 'WAKE_TIMEOUT':
      return {
        error: result,
        message:
          'That session was parked; Harnu dispatched a wake and it did not come up in time. THE MESSAGE WAS NOT SENT — nothing was written to any socket.',
        nextActions: [
          {
            do: 'Poll get_session for that id until it reports a live session, then call message_session again.',
            why: 'A `claude --resume` of a long transcript can outrun the wake window; the resume is very likely still in flight, so retrying immediately would only race it.'
          },
          {
            do: 'Do NOT call create_session for the same session as a workaround.',
            why: 'That would put a second process on one transcript — the exact hazard the wake path exists to avoid.'
          }
        ]
      }
    // Four causes, so the hint ENUMERATES them and diagnoses none. Both
    // remedies are named: the bind gate returns early on
    // CLAUDE_CODE_HARBOR_KITE, and the inbound policy is `crossSessionInbound`
    // in settings.json (spec O-5, corrected on review).
    case 'PEER_NO_SOCKET':
      return {
        error: result,
        message:
          'Harnu owns a live process for that session, but it is not listening on a cross-session socket. Harnu cannot tell which of four causes applies: the session predates cross-session messaging (needs Claude Code ≥ 2.1.224, and a session started before an upgrade keeps its old binary until it restarts); the messaging gate is off for it; it is a remote thin client; or its socket bind failed (a too-long runtime path, or permissions).',
        nextActions: [
          {
            do: 'Reach the recipient another way — open_file a report in its folder, or notify the operator — and do not retry this call in a loop.',
            why: 'None of the four causes clears on its own; retrying writes nothing and buys nothing.'
          },
          {
            do: 'Ask the operator to check Settings → Claude Code for the installed CLI version, to set `crossSessionInbound` in settings.json if the inbound policy is refusing, and — if the socket never binds at all — to launch with `CLAUDE_CODE_HARBOR_KITE=1`, which forces the messaging gate on.',
            why: 'Those are the two operator-settable mechanisms: `crossSessionInbound` governs whether an arriving message is accepted, and `CLAUDE_CODE_HARBOR_KITE` short-circuits the gate that decides whether a socket is bound in the first place.'
          },
          {
            do: 'If the session simply needs a newer CLI, ask the operator to restart it after upgrading.',
            why: 'A running `claude` keeps the binary it exec-ed; upgrading the CLI does not retrofit a socket onto a live session.'
          }
        ]
      }
    case 'PEER_SOCKET_DEAD':
      return {
        error: result,
        message:
          'A socket file for that session exists but nothing answered on it — the classic stale `.sock` a crashed process leaves behind.',
        nextActions: [
          {
            do: 'Call get_fleet to re-read the session state; if Harnu still shows it live, wait a moment and retry once.',
            why: "Harnu's own index is refreshed on every call, so a genuinely dead process drops out of it and the next attempt reports the accurate refusal instead."
          }
        ]
      }
    case 'SOCKET_WRITE_FAILED':
      return {
        error: result,
        message:
          "Harnu connected to that session's socket but the write failed (the peer closed the connection mid-write, or the pipe broke). Nothing was queued.",
        nextActions: [
          {
            do: 'Retry once. If it fails again, surface it to the operator instead of looping.',
            why: 'A single broken pipe is usually a peer that exited between the connect and the write; a repeat means something is wrong that another write will not fix.'
          }
        ]
      }
    case 'MESSAGE_TOO_LARGE':
      return {
        error: result,
        message: 'The message body is over the size cap message_session accepts.',
        nextActions: [
          {
            do: 'Shorten it, or write the long version to a file, open_file it, and message the path instead.',
            why: 'The cap keeps the audit hash and the operator-visible Activity row bounded; a report is better read in the viewer than pasted into a turn.'
          }
        ]
      }
    // ---- T238 `speak` refusals -------------------------------------------
    // Both are the ORDINARY outcome of a verb that is off by default, so each
    // one's job is to stop the agent retrying and tell it exactly which switch
    // the operator would have to flip. They are two codes, not one, because the
    // right ask differs: a deliberate per-folder mute is not fixed by turning
    // the global on, and telling the operator otherwise would talk them into
    // undoing a decision they made on purpose.
    case 'VOICE_DISABLED':
      return {
        error: result,
        message: `Agent speech is not enabled for this folder${at}: voice is off globally and this folder has no override of its own. Nothing was said, and nothing was recorded.`,
        nextActions: [
          {
            do: 'Ask the operator to turn agent voice on (Settings → Voice — globally, or just for this folder), then say it again. Until then, use notify for anything they must not miss.',
            why: 'Speech is the one channel that reaches everyone in the room, so it stays off until the operator opts in; a notify row is waiting for them whenever they look.'
          }
        ]
      }
    case 'VOICE_MUTED_FOR_FOLDER':
      return {
        error: result,
        message: `This folder${at} is explicitly muted for agent speech. That is a deliberate per-folder decision and it outranks the global voice setting, which may well be on.`,
        nextActions: [
          {
            do: 'Do not ask for the global switch — it would not help. Use notify here, and only raise the mute with the operator if you have reason to think it was set by accident.',
            why: 'An explicit mute beats the global by design; someone silenced this folder on purpose, and a folder that keeps asking to be un-muted is the behaviour the setting exists to stop.'
          }
        ]
      }
    case 'SPEAK_RATE_LIMITED':
      return {
        error: result,
        message:
          'This session has already spoken its allowance for the current window. Nothing was said; the refusal itself does not count against you.',
        nextActions: [
          {
            do: 'Stop speaking and carry on working. Say one summary line when the work is actually done, rather than narrating each step.',
            why: 'The speakers are serial and cannot be skimmed — an agent that talks per step holds them for everyone, which is exactly what the limit is for.'
          }
        ]
      }
    // ---- T309 `orchestrator_arm`/`orchestrator_disarm` refusals (ADR-0013) --
    // Same scope as `message_session`'s recipient predicate, applied to the
    // arm/disarm TARGET instead: only a session Harnu itself spawned for an
    // agent, in a folder the operator has not blocked.
    case 'TARGET_NOT_HARNU_SPAWNED':
      return {
        error: result,
        message:
          'Harnu has no process of its own for that session, so it will not arm/disarm its guard. orchestrator_arm/orchestrator_disarm only reach sessions Harnu itself spawned and still owns (or parked) — the same scope message_session uses for its recipient.',
        nextActions: [
          {
            do: 'Call get_fleet and pick a session Harnu is running (or one Harnu parked — those are wakeable via message_session first).',
            why: "Only a Harnu-owned process has a resolvable session record; the addressing itself starts from Harnu's own session index."
          },
          {
            do: 'If you meant to arm the SESSION MAKING THIS CALL, pass its own sessionId — get it from get_fleet or your dispatch context. There is no bare "arm me" call: the MCP transport has no per-session identity.',
            why: 'Self-targeting requires the caller to already know its own id, the same convention speak/notify use for their optional self-sessionId.'
          }
        ]
      }
    case 'TARGET_OPERATOR_OWNED':
      return {
        error: result,
        message:
          "That session is one the OPERATOR opened in Harnu, not one Harnu spawned for an agent, so orchestrator_arm/orchestrator_disarm will not touch its guard. This is the operator's own session, and an agent does not get to change what tools it is allowed to use.",
        nextActions: [
          {
            do: "If the operator wants that session promoted, point them at its right-click menu → 'Promote to orchestrator' — that gesture is not gated the same way this verb is.",
            why: 'The renderer-driven promote/demote toggle is a trusted, same-process action; this verb is scoped narrower on purpose (ADR-0013).'
          }
        ]
      }
    default:
      return null
  }
}
