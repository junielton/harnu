# ADR-draft — Harnu asks the session before parking it; the session states facts, Harnu decides and bounds

**Status:** proposed (numbered on merge) · **Date:** 2026-10-09 · **Card:** T456 · **Spec:**
[`00-spec.md`](00-spec.md)

## Context

Harnu parks a cold session by killing its `claude` process (`src/main/pty.ts:619-644`). "Cold"
means its PTY has been silent and unfocused for 15 or 60 minutes (`src/main/fleet-policy.ts:58-62,
81-83`). Work that runs outside a turn makes no PTY bytes: background tasks, background subagents,
scheduled wakeups. A remote client attached to the session makes none either. A park kills all of
it (spec §3.4-§3.6, reproduced against the shipped policy in `01-prototype.md` §P3).

The facts that would prevent this live inside the `claude` process. The shipped Harnu mod already
receives most of them: `classic.Stop` carries `background_tasks` and `session_crons` (Claude Code
2.1.295 types, lines 12117-12132), and the companion hooks it (`register.ts:1296-1297`). The
question is who decides, and how the facts reach the decision.

Constraints:

1. The command channel flows host → mod only. Its enum is closed, and every command's origin is
   gated on Harnu's side (T389 contract `01-contract.md:26, 375`; master SEC-5,
   `00-master.md:498`).
2. The companion may not call `$.mcp.call` (SEC-9b, `00-master.md:502`).
3. The channel's default key is `shadow`, in which only observe-only commands may be sent
   (`01-contract.md:785-787, 1037`; `command-gate-core.ts:127-144`).
4. Parking must stay possible: it exists to stop a fleet from exhausting RAM (T119).

## Decision

1. **Harnu asks; the mod answers with facts; Harnu decides.** Before a park chosen by the policy,
   the park coordinator sends one command, `park.query { cause }`. The mod answers
   `{ busy: ParkBusyReason[], retryAfterMs? }` from in-process facts. The answer carries counts and
   type labels only, never command or prompt text. A non-empty `busy` delays the park. It never
   cancels it.
2. **`park.query` is observe-only.** It writes nothing, draws nothing and starts no `$` call with a
   side effect, so it joins the observe-only set and works under the default `shadow` key. Its
   gate row admits only the coordinator's internal cause.
3. **Harnu bounds every delay.** Each cold episode has a cap on declines (8) and a cap on total
   delay (2 h). An answer's `retryAfterMs` is a hint, clamped to 1-30 min. Memory pressure
   (`MemAvailable` under a floor) and the operator's "Park now" bypass the question.
4. **Silence means today's behaviour.** A timeout, no binding, channel `off`, or a session on
   legacy hooks falls back to the same `Stop` facts read by the hook bridge, and then to the park.
5. **One coordinator, two stages.** T456 builds the `requestPark` coordinator P4W4 specified.
   Negotiation is its first stage, and P4W4's resume-plan capture becomes the second, reached only
   when the session is free or when a bound forces the park.

## Alternatives rejected

| Alternative                                                                                   | Why rejected                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Facts only, no question.** Read the Stop counts the hub already gets and veto in the policy | Kept as the fallback, not the design. It misses an attached remote client, which changes without a turn, and it leaves no place for a retry hint. It is what a legacy session gets                                                   |
| **The mod vetoes**, and Harnu obeys any `busy`                                                | A mod bug, or a recurring cron, would pin half a gigabyte per session for good (measured median RSS 504 MB, spec §6.3). Violates constraint 4                                                                                        |
| **The mod pushes "do not park me"** over a new mod → host route or an MCP verb                | The channel has no mod → host command route by rule (constraint 1), and the companion may not call MCP (constraint 2)                                                                                                                |
| **A new mod** that owns parking                                                               | It would need its own lease, its own channel and its own audit row to reach a decision the host must make anyway. The facts are already in the companion                                                                             |
| **`park.query` under `act.*`, channel `active` only**                                         | The default key is `shadow`, so the feature would be off on every default install. The command is a read, so it passes the observe-only test                                                                                         |
| **Pre-compact before parking** (idea 112's `trigger: 'precompute'`)                           | A plugin cannot request `precompute`: `$.session.compact` runs as trigger `plugin` and installs its result (types 4745, 10744-10750, 10850-10856). A real compaction would rewrite the conversation without the operator choosing it |

## Consequences

- Positive: a session waiting on background work or a wakeup is no longer killed mid-work on a
  default install. Every delay is bounded and visible in the System Monitor.
- Positive: no new Settings → Mods chip. The mod half adds one `$` read (`$.session.surfaces`)
  and reads one more field of an event it already hooks (spec §9.3, run).
- Negative: the `cap` trigger can leave the fleet over `maxLive` while every candidate declines.
  This matches T119 §3.5, under which the cap never blocks a spawn.
- Negative: a park can take up to 13 s longer when P4W4 also captures (5 s question and 8 s
  capture, in sequence). A spawn never waits for it.
- Neutral: `docs/harnu-features.md:674` must stop saying a working session is never parked. The
  rule is now "deferred within bounds".

## Kill criteria

Revisit if the W4 live run shows `park.query` answering `silent` for more than a small share of
questions, or if a week of park-ledger data shows declines mostly reaching `limit`. In both cases
the question buys nothing over the facts-only fallback, and the setting `park: 'facts'` becomes
the default.
