# ADR-draft — Live sidebar facts are pushed by the Harnu mod; only the redundant reread is demoted

**Status:** proposed (gets a number when merged) · **Date:** 2026-10-09 (revised after
verification round 1) · **Card:** T455 · **Spec:** [`00-spec.md`](00-spec.md)

## Context

For a running session, Harnu re-reads the session's JSONL to learn what the sidebar,
`SessionPreview` and `get_fleet` show. Two readers reopen every live transcript (02-cost.md §8.4,
543 appends attributed reader by reader):

- **The watcher's tail**, within 2 ms of the write: 0.72–1.55 opens per append.
- **The fleet model's slug pass and other non-immediate readers**, on a ~2 s cadence: 0.78–1.32
  opens per append. That is 45 % of the live-transcript opens in sweep-free windows; T455 removes
  its slug-pass part, and on-demand readers in the class remain.

Even so, the first slug-pass reread comes p50 258–565 ms and p90 4.7–8.2 s after a live
session's last append, so the model's view lags at least that much (inferred). Several facts go stale until a reload (F3), `get_fleet` calls every disk session `idle`
(F1), and a new session binds to its row through folder and recency guesses (01-inventory.md
§3.4).

Separate whole-corpus and home-dir sweeps also exist. They are not caused by appends and are
carded as their own bug.

The Harnu mod (ADR-0018) already runs in every session Harnu spawns. It has a typed channel to
Harnu main, a lease, per-family arbitration and a parity ledger. Claude Code 2.1.29x gives a mod
`session.append`: one event per row the conversation keeps, before it is stored, carrying the row's
transcript uuid (types 4348-4359, 10566-10594). The classic `SessionStart` and `UserPromptSubmit`
payloads carry the start `source`, the exact `transcript_path` and the `session_title` (types
826-829, 11643-11648, 14661-14669).

Probed on 2.1.296 (03-prototype.md §P.4):

- the uuids match the JSONL, in order;
- a resume or a fork loads its history without any append;
- `$.session.messages()` cannot stand in for those appends: no door, no `isMeta`, and hook context
  among its rows;
- a fork gets `source: "fork"` and a new id, and the engine names no parent anywhere.

Three constraints bind the design:

- Lesson `synthetic-sessions/004` forbids re-keying a row before its transcript exists.
- T389 ARB-8 and P5W1 §7.6 forbid deleting the transcript watcher.
- ARB-2(b) and R11 make its tail the legacy input and the sign of life of the `taskState` and
  `telemetry` families.

## Decision

1. **The Harnu mod pushes a process-local compact row.**
   - A new feature `sense.row` folds the main conversation's kept rows (`session.append`, observed
     after `next(e)`, on the row as stored) into first prompt, last prompt, last assistant text,
     user-row count and last activity. It also records title and tool calls for parity.
   - It sends a coalesced `session.row` snapshot on the existing events channel: ≤ 500 ms after a
     change, ≤ 2 s worst, and at once at a turn's end.
   - It never seeds from a loaded history. The host composes the push over the cold baseline its
     reader already folded.
2. **Identity rides the shipped snapshot; lineage is the host's.**
   - `session.snapshot` gains an optional `start: { source, transcriptPath }`, and
     `session.rebound` gains `transcriptPath`. No new identity event is added.
   - `forkedFrom` and `resumedFrom` come from a new `PtyRecord.spawnSourceSid`, never from the mod.
     The PTY record dies with the process (a park included), so the identity adapter persists
     each lineage once, at bind time, to `<userData>/companion/lineage.json`; cold rows keep it.
3. **Bind by claim; re-key on proof the model already holds.**
   - A claimed synthetic row shows the pushed facts at once.
   - It is re-keyed through the existing `bindByClaim` migration only once its claim arrives `proven`
     over the existing `companion:identity` push. Main marks it so after its fleet model has inserted the transcript, which it does on the
     watcher's `add` or on a `stat` hit of the validated `transcriptPath`.
   - A reload can then never drop the migrated row.
   - For an owned session, the slug pass is replaced by patching the model's entry in place from
     the tail's delta, the subagent delta and the push. A renderer reload copies the model over the
     live row, so a skipped pass would otherwise roll the status dot, stuck verdict, `ctxPct` and
     `agents` back to stale values. Every reader of the model (spec §7.5, verified field by field)
     gets current values instead, with zero extra file reads.
4. **A new fact family, `row`, conforming to ARB-2(c) and ARB-3 rather than amending them.**
   - Its fields are partitioned once, at design time, as `telemetry`'s are.
   - The companion owns `prompt`, `count`, `activity` and `assistant`.
   - The legacy writer keeps `title` (an `ai-title` is no conversation row) and `tools` (stagnation
     is an input of `taskState`'s stuck verdict).
   - The family flips as one, in one PR, on its parity gate and the operator's confirmation.
   - The renderer is fed through the watcher's existing `SessionUpdatePayload`, extended with
     optional fields, and main through the model's existing records (ARB-5). No new renderer
     channel is opened.
5. **Demote the redundant reread only.**
   - For a session whose `row` family is owned, Harnu main skips the slug pass its appends would
     schedule, and patches the model from the tail delta and the push instead (decision 3), so the
     skip starves no reader.
   - For a claimed row, it also skips the post-migration full reload.
   - The watcher's tail runs for every session in every state: it keeps feeding `transcriptState`,
     `ctxPct`, stagnation, title and away summary, their parity streams, and the stuck timer's sign
     of life.
   - On leaving ownership, one slug pass catches the header up.
6. **SEC-8 is amended for named text fields, with the residual risk stated.** SEC-8 ("no secrets
   at rest or on the wire") gains one exception: `session.row`'s `firstPrompt`, `lastPrompt`,
   `lastAssistant` and `title` may cross the local socket, under these conditions.
   - Never at rest in the session: `$.state` holds counts only, because any co-loaded mod reads it.
   - Redacted first by `redactForWire`: T450's 17 deterministic rules (its whole table but
     `high-entropy`), each match replaced by the bare `[REDACTED:<rule>]` (no salted tag). The table
     is staged from one source into both mods, and a test keeps the copies identical.
   - Fail-closed per field only when the pass throws. A secret no rule matches (a password in prose,
     an unknown credential format) **goes out raw**; that is the accepted residual risk, the
     operator's call (spec Q1).
   - Never at rest on the host: the patched model is process memory; the parity ledger keeps
     verdicts and lengths, never text.
7. **Disclose it, with T450.** Settings → Mods gains one `transcript` chip ("can read or rewrite
   the conversation") for any mod that hooks `session.append` or `session.compact` or calls
   `session.messages`. T450 needs the same chip for rewriting.

## Alternatives considered

- **Per-group flips as an ARB-3 amendment.** Each group would get its own gate and its own flip
  PR. Rejected. It adds an arbitration concept T389 does not have, for little gain: the design-time
  partition already keeps the risky groups (`title`, `tools`) on legacy.
- **Retire the tail for owned sessions.** It would starve `transcriptState`, `ctxPct` and
  stagnation, the legacy inputs of `taskState` and `telemetry`, and their parity streams. It would
  also break ARB-2(b)'s sign of life (R11). It needs every reading family owned **and** an ARB-2(b)
  amendment (spec Q5); not proposed.
- **Seed the fold from `$.session.messages()`.** Rejected on the probe: no door, no `isMeta`, and
  hook context among the rows.
- **A new `session.identified` event.** Rejected. `session.snapshot` already fires at hello, on
  `resync`, and (`probe`) when the first classic hook arrives after the hello.
- **Widen the hook bridge** (keep `session_title`, the prompt and `last_assistant_message`, which
  the bridge drops today). It needs no mod and works at turn granularity only, with no row count,
  activity time, transcript path or binding. Kept as an improvement to the un-owned path (spec Q4),
  not as the design.
- **A separate mod for the row.** It would duplicate the spawn token, rendezvous, lease, feature
  negotiation and parity ledger, and break MOD-4 (one `on()` per event) on the shared events. T450
  is a separate mod for reasons that do not apply here: it fails closed and hooks Bash.
- **Re-key the row at hello (idea 110 as written).** Rejected by lesson 004: the row would be
  dropped by the next reload and could be parked with nothing to resume.

## Consequences

- **Text on the local socket.** Prompt and assistant text (240 characters each, redacted) cross
  it, and contract §8 and SEC-8 gain named exceptions (spec Q1).
- **Harnu main's model is patched in place for owned sessions** (`patchSession`), and the
  renderer migrates claimed rows only on main's proof (a claim marked `proven`).
- **A new parity stream, `row`**, with one gate for the family.
- **The saving is the pass-class reread and one full reload per new session**, not the tail. The
  sweeps are someone else's bug.
- **A session started outside Harnu keeps today's path** in v1 (spec Q3).
- **Contracts owed:**
  - The renderer gains one preview line (the last assistant text), which owes `design.md`, both
    locales and `docs/user/`.
  - `get_fleet` / `get_session` semantics change for owned sessions, which owes
    `docs/harnu-features.md` and a note in T447's `fleetGet` contract.
