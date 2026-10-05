# T213 — Resume dispatch: route a follow-up into a card's already-bound session instead of spawning a cold one

**Date:** 2026-08-08 · **Status:** specified (not implemented) · **Card:** `.capy/memory/roadmap/T213-resume-dispatch-message-an-already-bound-session-instead-of.md`
**Depends on:** T215 (`.capy/memory/roadmap/T215-message-session-verb-bridge-claude-code-2-1-224-cross-session.md`) — this card **consumes** that verb and its wake path; it does not re-specify either. · **Verified against:** repo `main` @ `2706083`, Claude Code **2.1.224**

> **Three drift notes, recorded rather than hidden.**
> (a) The working tree is at `f35a79d` — `2706083` plus one docs-only commit; no source claim below is affected.
> (b) `claude --version` on this machine now reports **2.1.226**. 2.1.224 remains the socket floor this spec assumes. **Narrowed 2026-08-08:** "nothing re-verified on .226" applies to _this_ spec's claims and to the send→read round-trip timing only — it is **not** true of T215, whose §2.1 transport mechanics (socket-path algorithm, permissions, wire format, gate strings) were read out of the installed 2.1.226. Defer to `T215-message-session-verb.md` §2.0 on any transport fact.
> (c) **Card-id collision — found by this spec, since resolved.** `docs/specs/T212-folder-view.md` already existed (added by `f35a79d`) and is about a **folder view**, not cross-session messaging, so "Depends on: T212" would have led a reader to the wrong document. The cross-session card was renumbered **T212 → T215** and the original archived; every reference in this spec now reads T215. `docs/specs/T212-folder-view.md` keeps T212 and was not touched.
> Root cause, worth its own card: board ids are allocated by scanning **cards**, so a spec filed straight into `docs/specs/` without a card burns an id invisibly and the allocator hands it out again. Audit at renumber time: only `T178` and `T212` are spec ids with no card.

## 1. Goal, and the cost being removed

Every dispatch today spawns. The queue filter is explicit about it: the drain only ever considers cards with **no** bound session (`manifest-drain.ts:196`, `!c.session`), and the board's Ready-column click is gated the same way (`RoadmapBoard.vue:532`, `col === 'ready' && !card.session`). So a card whose session already did the work — and still holds the diff, the reasoning and the file layout — can only be re-driven by a **new, cold** session that rebuilds all of it from zero.

The killer case is the review loop: a reviewer finds three problems and the orchestrator wants them landed by the session that wrote the code. Today that is a fresh process paying full cold-start cost in tokens and latency, against a repo it has never read.

**Non-goal:** replacing spawn. Resume is a _second door_, reachable only when a card already has a reachable bound session, and it fails **loudly** to the existing spawn door when it doesn't (§6).

## 2. Current dispatch, verified end to end

### 2.1 The go-door and the drain

| Step                                                               | file:line                                                           |
| ------------------------------------------------------------------ | ------------------------------------------------------------------- |
| `submit_manifest` — the batch go-door, stamps `approved` + hash    | `mcp/tool-catalog.ts:751-777`                                       |
| Drain walk over the stamped Ready queue                            | `manifest-drain.ts:188-299`                                         |
| Queue filter (`ready` ∧ `approved` ∧ **no session** ∧ ≠`internal`) | `manifest-drain.ts:193-199`                                         |
| WIP count = cards in `in-progress`; `WIP_LIMIT = 5`                | `manifest-drain.ts:190`, `roadmap-core.ts:553`                      |
| Worktree cut (substrate `worktree` only)                           | `manifest-drain.ts:240-248` → `manifest-drain-shell.ts:95-122`      |
| Spawn (bridged to the renderer as `session.dispatchCard`)          | `manifest-drain.ts:251-256` → `manifest-drain-shell.ts:124-155`     |
| `executedIn` probe, then bind                                      | `manifest-drain.ts:277-285` → `manifest-drain-shell.ts:161-162,165` |
| Board equivalent (`spawnAndBind`)                                  | `RoadmapBoard.vue:606-674`                                          |
| Substrate → where it spawns (`planCardDispatch`)                   | `stores/dispatch-substrate.ts:63-85`                                |
| The one bind door                                                  | `roadmap-ipc.ts:1216-1250` (`bindSessionCore`), IPC at `:660-681`   |
| Substrate lock once bound                                          | `roadmap-core.ts:851-853` (`SUBSTRATE_LOCKED`)                      |
| `evidence` is CONTROLLED; only writer is the human Review move     | `roadmap-core.ts:790-798`, `roadmap-ipc.ts:825-855`                 |

**The bind is one atomic frontmatter write.** `bindSessionCore` writes `session` + `status: 'in-progress'` unconditionally (`roadmap-ipc.ts:1227-1230`), plus `substrate` and `executedIn` when supplied (`:1231-1236`), then best-effort appends the `dispatched-with: model·effort` audit line to the card body (`:1238-1248`). That single write is what makes a card "bound", and §5 turns on the fact that it can never be reused for a resume.

**`docs/capy-features.md` states the contract to the agent** at `:382-406` (manifest) and `:408-419` (substrate). Neither paragraph contemplates a second dispatch of the same card; the substrate paragraph says only "locks once a `session` is bound … propose it before dispatch, not after".

### 2.2 What "already-bound" actually is — the blocking correction

**The card's `session:` value is, for most board-dispatched cards, an id that resolves to nothing.**

`dispatchCardSession` mints `synthetic-${crypto.randomUUID()}` and returns it immediately (`sessions.ts:2533, 2569`). Both callers bind **that** id — the board at `RoadmapBoard.vue:672`, the drain at `manifest-drain.ts:278` via `manifest-drain-shell.ts:161`. When the real transcript lands on disk, `collapseSyntheticInto` (`sessions.ts:4027-4071`) mutates the row **in place** and calls `fireMigrate(synthId, realId)` (`sessions.ts:1462-1499`), which re-keys the pending pre-prompt (`:1471`), the injection ledger (`:1476`), the main-process PTY index (`pty.ts:335-338`) and every registered pane handler. Its subscribers are exactly three — `TerminalPane.vue:1040`, `TerminalPane.vue:1183`, `stores/helpers.ts:844`. **None of them rewrites the card's frontmatter.** There is no roadmap-side migrate handler at all (`grep registerMigrateHandler src/renderer/src` returns those three sites only), and `bindSessionCore` has exactly two callers (`roadmap-ipc.ts:673`, `manifest-drain-shell.ts:162`), both at dispatch time.

Measured on this repo's own board (`.capy/memory/roadmap/*.md`, 2026-08-08):

- 28 cards carry a non-empty `session:`
- **19 of them (68%) are `session: synthetic-<uuid>`** — dangling ids that match no live session after migration and no session at all after an app restart
- 9 are real uuids

Consequences that T213 cannot route around:

1. `sessions.findSessionById(card.session)` — the lookup the board already does at `RoadmapBoard.vue:143, 238, 271, 897` — returns `null` for those 19. Any resume resolver built on `card.session` inherits the same miss.
2. `kind: 'claude-resume'` validates its argument against `SESSION_UUID_RE` and **throws** on anything that isn't a session uuid (`pty.ts:635-637`). A `synthetic-` id can never reach the CLI's `--resume`.

So "route the follow-up to the card's already-bound session" is, today, undefined for two thirds of bound cards. §3.1 makes fixing that a **precondition of this card**, not an afterthought.

### 2.3 Hibernation kills the process

`hibernateSession` flushes, `markParking`, **`rec.pty.kill()`**, drops the index entry and broadcasts `pty:hibernated` (`pty.ts:551-576`). Its own doc comment is explicit: "The conversation is NOT lost — it lives in the JSONL, and the next `activate()` takes the existing `claude-resume` path". A parked session therefore has **no process and no socket**; there is nothing for a cross-session message to reach. Waking is a fresh `pty:create` with `kind: 'claude-resume'` → `claude --resume <uuid>` (`pty.ts:631-638`), which clears the hibernated flag and records the wake in the park ledger (`pty.ts:821-831`, `hibernation.ts:91-100`).

**This is the single most important fact for T213** and it reframes the card's premise: the bound session an orchestrator wants is very often _not a warm process at all_. See §6's ladder.

### 2.4 Prompt delivery into a session Capy hosts

Capy already has a last-mile injector for text that must land in a REPL that is actually up: `pendingAgentPrompts` (`sessions.ts:1180`) → `hasAgentPrompt`/`takeAgentPrompt` (`:1392-1407`) → `armInjectGate` on `pty:sessionReady` (`TerminalPane.vue:1124-1149`), with a queryable outcome in the injection ledger (`stores/injection-ledger.ts:98-141`, statuses `none|dequeued|injected|cancelled|escalated`). Short prompts skip the queue entirely and ride argv as `--` + `prePrompt` (`sessions.ts:2555-2557`, `claude-args.ts:418`).

This matters because it is the **only** existing mechanism that puts text into an already-running Claude, and it is a _paste into the PTY_ — which collides with an operator who is typing. T215's socket transport does not have that problem. §6 keeps the two on different rungs deliberately.

### 2.5 What does not exist yet

`grep -rn "message_session\|send_message" src/` returns nothing. There is no cross-session verb in `tool-catalog.ts` (last verb: `submit_manifest`, `:751`). T215 builds it; T213 assumes only its interface (§7).

## 3. Precondition — the card must point at a session that exists

### 3.1 Rebind the card's `session` across the synth→real migration

Add a fourth `registerMigrateHandler` subscriber, in `stores/roadmap.ts`, calling a new **human-channel IPC** `roadmap:rebindSession` → `rebindCardSessionCore(folder, slug, fromId, toId)` in `roadmap-ipc.ts`, beside `bindSessionCore`:

- Writes **only** `session` — never `status`, never `substrate`, never `executedIn`. It is an identity correction, not a dispatch.
- **Compare-and-swap:** rewrites only when the card's current `session` is exactly `fromId`. A card re-dispatched in the meantime, or hand-edited, is left alone. Idempotent and safe to fire twice.
- Best-effort, same posture as the `dispatched-with` append: a failed rebind logs and never breaks the migration (`fireMigrate` is critical path, `sessions.ts:1477-1483`).
- No MCP surface. Agents never call it; `session` stays a CONTROLLED field (`roadmap-core.ts:790-798`) refused by `update_card`.

**Backfill for the 19 already-dangling cards is out of scope and must be stated, not silently skipped.** Those cards' synthetic ids are unrecoverable from disk — the mapping only ever existed in a renderer process that has since exited. A resume against one of them resolves to `unbound` and degrades per §6. Say so in the ACK; do not guess by recency (the recency heuristic that exists in `collapseSyntheticInto` is a _migration_ fallback with a live correlation window, not an archaeology tool).

**Argued alternative, rejected:** keep an in-memory synthetic→real alias map and resolve through it. It dies with the renderer, which is exactly the case that matters (an app restart is the most common reason a bound session is cold), and it leaves the on-disk board permanently wrong. Fixing the durable record is the cheaper correctness.

## 4. Is `resume` a fifth substrate, or a mode? — **a mode, orthogonal to substrate**

The card leaves this open. The decision is **mode**, and the code makes the case in four independent ways.

**4.1 The lock is a proof by contradiction.** `planCardSet` refuses any `substrate` write once `hasSession` is true (`roadmap-core.ts:851-853`). A resume is _by definition_ only possible when `hasSession` is true. A `substrate: resume` would therefore be a value that can only ever be set at the exact instant it is forbidden — you would have to punch a hole in the one guard that exists to stop a card silently relabeling where it ran mid-flight. That guard is load-bearing (`roadmap-core.ts:112-114`: "the substrate a card was dispatched on shouldn't silently relabel itself"); T206 explicitly inherits it for free by adding `bg` _before_ the bind. Resume cannot.

**4.2 It would destroy information the board depends on.** `substrate` records **where** the work runs, and `executedIn` is stamped alongside it in the same write (`roadmap-ipc.ts:1231-1236`). A resumed `worktree` card still runs in `card/<slug>` — the process's cwd was fixed at spawn and cannot change. Overwriting `substrate: worktree` with `substrate: resume` would erase the only durable record that the work lives in a worktree, which Review reads.

**4.3 It answers a different question.** `planCardDispatch` (`stores/dispatch-substrate.ts:63-85`) answers "_which folder do I spawn in_" and its return union is folder-shaped (`same-folder` / `worktree` / `skip-internal`). Resume answers "_do I spawn at all_". That decision sits strictly **before** substrate resolution, and the existing code already places it there: the drain's `!c.session` filter (`manifest-drain.ts:196`) runs before any substrate branch (`:240`).

**4.4 Contrast with T206's `bg`, which genuinely is a substrate.** `bg` changes how the process is _hosted_ and is chosen while the card is still unbound, so it slots into the enum, the lock, the operator override and the `z.enum(CARD_SUBSTRATES)` surfaces (`tool-catalog.ts:631-634, 766-769`) with no new machinery. Resume shares none of those properties.

**Therefore:** `CARD_SUBSTRATES` is **unchanged** — no fifth value, no renderer-mirror edit, no new `roadmap.substrate.*` i18n key, no `design.md` substrate-picker change. Resume is a **per-dispatch mode** carried by the call that requests it, never persisted as card state.

## 5. Where resume enters, and what it must not touch

### 5.1 The entry point: a card-scoped verb, not a manifest field

**The drain structurally cannot carry resume.** Its queue requires `status === 'ready'` **and** `!c.session` (`manifest-drain.ts:193-199`). A resume-eligible card has a session and is `in-progress` or `review`. Widening that filter would mean the unattended background walk could re-drive already-running cards — the opposite of what the WIP ceiling and the one-attempt-per-pass rule (`manifest-drain.ts:227`) exist to guarantee.

So:

- **`resume_card({ folder, slug, message })`** — a new MCP verb in `tool-catalog.ts`. It resolves the card's bound session and delegates **delivery** to T215's transport. It does **not** accept a `sessionId`, a pid, or a socket path: the _card_ is the addressing unit, which is precisely T215's thesis (Capy owns addressing and audit; the CLI owns transport). It does not accept a folder/branch either — the target's cwd was fixed at spawn and `executedIn` already records it (§5.3).
- **An operator gesture on the board** — a "Send to bound session" action on an `in-progress`/`review` card (card menu + detail modal), which composes the same call. The operator sees every degrade rung of §6 and picks.

**Rejected: a `dispatch: 'resume'` field on `submit_manifest`'s `cards[]`.** The manifest's whole apparatus — `approved` + body fingerprint, the void-on-edit rule, the boot-prompt preview in the disclosure (`tool-catalog.ts:753`) — exists to approve _starting_ work on a card that has not run. A resume has no boot prompt to preview and no first-run to approve; overloading the go-door would make the stamp mean two different things.

**Rejected: reusing `create_session` with a resume flag.** `create_session` is folder-scoped (`tool-catalog.ts:346-347`) and its whole ACK contract is "the session actually MATERIALIZED" (`:345`) — a claim a message can never make (§8).

### 5.2 Status: resume writes **no** frontmatter

**A resume must never call `bindSessionCore`.** That function writes `status: 'in-progress'` unconditionally (`roadmap-ipc.ts:1229`). Reusing it would silently drag a `review` card back into `in-progress` — corrupting the operator's Review column, re-consuming a WIP slot (`manifest-drain.ts:190`), and leaving already-attached `evidence` sitting on a card the board now claims is still being built.

What a resume writes instead: **one provenance-stamped body append**, through the same `appendMemoryEntry` door `bindSessionCore` uses for its audit line (`roadmap-ipc.ts:1239-1247`) — recording that a follow-up was sent, when, and its text (truncated). The body is not a controlled field, so this needs no new write authority.

**The `review` → `in-progress` question is left open, deliberately.** There is no door back to `in-progress` today: `move_card` accepts only `backlog|ready|review` (`tool-catalog.ts:711-713`) and the human `roadmap:setStatus` is column-status-gated (`roadmap-ipc.ts:640`). Inventing one inside a resume would be a status-write door minted as a side effect. **O-1** below.

### 5.3 `executedIn`: never rewritten, true for free

`executedIn` is stamped once at bind and is the card's durable OWNER (`roadmap-core.ts:238`, `roadmap-ipc.ts:1234-1236`, "never cleared by a later `move_card`"). A resumed session runs in the working tree its process was spawned into — Capy cannot move a running process — so the field stays correct without any write. **Assert this negatively in the tests:** a resume that touches `executedIn` is a bug, and the verb taking no folder/branch argument makes it unreachable by construction.

### 5.4 WIP: a resume consumes no new slot

The ceiling counts distinct in-flight _cards_ (`manifest-drain.ts:190`), and a resume creates no new card and no new bound session. An `in-progress` card is already counted; a `review` card correctly is not. This is consistent with what the ceiling is for — supervision load — and it is one of the few genuine wins here: the review loop stops burning a WIP slot per bounce.

One real interaction: on the §6 rungs that **do** start a process (wake / respawn), `pty:create` runs `runPolicy('cap')` (`pty.ts:601`) and may park a colder session to stay under `maxLive`. That is existing, correct behavior and needs no change — but the ACK should say a wake happened, because a wake can evict someone else.

## 6. The reachability ladder, and the honest fallback

The card's framing — "warm session vs cold session" — is **too coarse**. There are four states, and the middle two are neither warm nor cold:

| Rung  | State of the bound session                                | Mechanism                                                | Cost                                        |
| ----- | --------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------- |
| **1** | Live process, socket present (CLI ≥ 2.1.224)              | T215 `message_session`                                   | ~free; context already in RAM               |
| **2** | Live process, **no socket** (started on an older CLI)     | **unreachable** — no transport exists                    | —                                           |
| **3** | Parked by hibernation, or no process (app restarted)      | wake / respawn `claude --resume <uuid>` + §2.4 injection | re-reads the transcript — cheaper, not free |
| **4** | `session` unbound, dangling `synthetic-`, transcript gone | nothing to resume                                        | —                                           |

**Rung 2 is not hypothetical.** T215's field data: of 4 live `claude` processes, 2 (on 2.1.223, 5h09m uptime) had **no socket at all** — invisible to `ListAgents`, unreachable, and unfixable without restarting that session. 50% of the live fleet. That process is _warm and permanently unaddressable_; only killing it makes it reachable, which throws away the warmth. There is no clever fix, only an honest report.

**The fallback rule.** `resume_card` **never silently spawns**, and never stalls:

- Rung 1 → deliver. ACK `{ ok: true, via: 'message' }`.
- Rung 3 → wake/respawn via T215's wake path, then deliver. ACK `{ ok: true, via: 'resumed-process', woke: true }` — the caller must learn it paid a transcript re-read, because that changes whether a follow-up should re-state context.
- Rung 2 → refuse: `{ ok: false, code: 'RESUME_UNREACHABLE', reason: 'no-socket', hint: … }`. Restarting the session to gain a socket would discard the exact context resume exists to preserve, so this rung degrades **down to a spawn**, not sideways.
- Rung 4 → refuse: `{ ok: false, code: 'RESUME_UNREACHABLE', reason: 'unbound' | 'session-not-found' }`.

Every refusal names the alternative in prose (`submit_manifest` for an agent, the board's Dispatch confirm for the operator). **Auto-spawning behind the caller's back is forbidden**, and this is not fastidiousness: the recorded fan-out post-mortem (2026-07-10) is exactly a lying `ok:true` ACK, and a resume that silently became a spawn would leave the caller believing its warm-context assumption held while a cold session re-derived everything. On the operator path the same refusal renders as a dialog with a one-click "Dispatch a fresh session instead" — a human sees the degrade and chooses it.

**Rung 3 has no operator-collision hazard, by construction.** Rung 3 only fires when there is no live process, so no one can be attached to the terminal the §2.4 injector pastes into. Rung 1 uses the socket, which does not touch the PTY at all. The paste-into-a-session-someone-is-typing-in failure mode is therefore unreachable on both rungs — assert it rather than assume it.

**Version gate.** Rung-1 availability is a per-session property (does _that_ process have a socket), not a machine property — a machine can run 2.1.226 and still host a 2.1.223 session from before the upgrade. So the check is T215's per-session resolution result, **not** T200's installed-version probe. T200/BUG-83 still matter for the _explanation_ the UI shows ("this session started on an older CLI"), but they cannot be the gate.

## 7. What T213 needs from T215 (interface, to be stated in T215's spec)

T213 ships **zero** socket code, zero `ListAgents` parsing, and zero pid resolution. It needs exactly this:

```ts
export type MessageSessionAck =
  | { ok: true; via: 'socket'; woke: boolean }
  | { ok: false; reason: 'no-socket' } // version skew — the process is alive but unaddressable
  | { ok: false; reason: 'process-dead' } // nothing running under this session key
  | { ok: false; reason: 'unknown-session' }

export function messageSession(sessionKey: string, message: string): Promise<MessageSessionAck>
```

- **R1 — addressed by Capy `sessionKey`.** T213 passes the id the card carries (post-§3.1), never a pid, never a socket path. `sessionKey` is already the main-process identity for a session (`pty.ts:528`, `PtySessionIndex`), and it survives the synth→real migration (`pty.ts:335-338`).
- **R2 — wake-before-send lives inside T215** (its card, §3 item 2). The ACK must distinguish `woke: true` from `woke: false`; T213 surfaces the difference (§6 rung 3) and must not have to infer it.
- **R3 — the three failure reasons must be distinct.** `no-socket` and `process-dead` map to _different_ rungs; collapsing them into one error would make T213 offer a respawn to a session that is alive and would then be running twice — the exact "1 session = 1 process" invariant the PTY dedup guard protects (`pty.ts:594-597`).
- **R4 — `WakeGesture` widening.** `hibernation.ts:66` is `'select' | 'restart' | 'notification-click' | 'unknown'`. Add a value for a message-driven wake so the park ledger (`hibernation.ts:78-100`) records _why_ a session was woken. Owned by T215, consumed by T213's audit trail.
- **R5 — every send is audited** (T215's stated point). T213 additionally writes the card-side record (§5.2), so the board is a second, durable copy.

## 8. A delivered message is NOT a completion signal

**There is no result ACK at the CLI layer.** A message enqueues and drains at the peer's next tool round. T215's own live measurement: sent at 13:15:16, peer read at 13:15:47 — **31 s**, and that is a _read_, not a result. The peer was idle between turns; it drained without interrupting anything. Nothing in that path reports whether the work was done, done correctly, or attempted at all.

Therefore, binding rules for this card:

1. **`resume_card`'s `ok: true` means "handed to the peer's inbox".** Nothing more. The verb description in `tool-catalog.ts` must say that in those words, in the same register the `create_session` description uses to say the opposite ("`ok:true` means the session actually MATERIALIZED"). The two ACKs sit next to each other in the same catalog and must not be readable as the same kind of promise.
2. **No status moves on delivery.** Not to `in-progress`, not to `review`, not on a timer. §5.2 already forbids the write; this is why.
3. **No board affordance may imply progress.** A resumed card may render "last follow-up sent <ts>" — a fact. It may **not** get a spinner, a "working" chip, or a fleet-state change: `fleetStateFor(card.session)` (`RoadmapBoard.vue:143`) is fed by the hook FSM, which reports what the session actually does. Let it stay the only source.
4. **Evidence still governs "done".** Unchanged: `probeMergeEvidence` (`roadmap-ipc.ts:168-204`) counts `origin/main..<branch>` and grabs ≤5 short hashes; the human `roadmap:moveToReview` (`roadmap-ipc.ts:825-855`) is the **only** writer of `evidence`; Close stays the operator's. The recorded lesson stands verbatim — MCP sessions can report done with green gates and no commit, so `git rev-list` at DONE is the check, not any ACK.
5. **No retry-until-answered loop.** A caller that wants confirmation re-reads the card's evidence or the transcript. A resume verb that polled for a reply would be inventing a completion protocol the CLI does not have.

**Governance.** The CLI's own `SendMessage` documentation warns about cross-session **permission laundering** — never ask a peer to perform an action denied in your session. `resume_card` is a laundering vector by construction: the target may be a non-agent-controlled session with full permissions and Capy's `--mcp-config`, while the caller may be an agent-controlled one that was deliberately spawned without either (`pty.ts:685-698`, `forceDowngradePermission` + withheld `--mcp-config`). Mitigations, all inside T213's scope:

- The card is the addressing unit, so a caller can only reach a session **bound to a card in a folder it already reached** — it cannot enumerate the fleet and pick a privileged peer.
- The folder gate applies unchanged: a blocked folder refuses before any resolution (`FOLDER_NOT_ALLOWED` posture).
- The message text lands in the card body (§5.2), so a laundering attempt is legible after the fact.

**Verb posture — recommendation, with the uncertainty stated.** `mutates: true`, `op: 'resume_card'`, `grantable: isSafeGrantVerb('resume_card')`, `silentAllowInAgentFolder: true`, and **NOT `alwaysAllowable`** in v1. Rationale: `create_session` carries `alwaysAllowable` (`tool-catalog.ts:366`) because a new session in a fresh folder has a bounded blast radius; injecting a prompt into a session that already holds context, permissions and possibly the operator's attention does not. This is a judgment call, not a derivation — **O-2**.

## 9. Acceptance

1. A card's `session` is corrected to the real transcript uuid when the synthetic migrates, via a compare-and-swap write that touches **nothing else**; cards whose synthetic id is already dangling are reported as `unbound`, never guessed.
2. `resume_card({folder, slug, message})` delivers to the card's bound session through T215's transport, and makes **zero** socket/pid/`ListAgents` calls of its own.
3. `CARD_SUBSTRATES` is unchanged — resume is a mode; `planCardSet`'s `SUBSTRATE_LOCKED` guard is untouched and still red on any widening attempt.
4. A resume writes **no** frontmatter field: `status`, `substrate`, `executedIn`, `session` and `evidence` are all byte-identical before and after. The only durable trace is a provenance-stamped body append.
5. A `review` card resumed stays in `review`; an `in-progress` card stays `in-progress`; the WIP count is unchanged in both.
6. Every unreachable rung refuses with a **named** reason and names the spawn alternative. No rung auto-spawns, and no rung stalls silently.
7. A parked session is woken through T215's wake path before delivery, and the ACK reports `woke: true`.
8. `no-socket` never triggers a respawn (it would duplicate a live process); `process-dead` does.
9. The `resume_card` catalog description states, in words, that `ok:true` means enqueued — not completed, not started.
10. `npm run typecheck`, `npm run lint`, `npm run test:coverage`, `npm run build` pass.

## 10. Test plan

| Test                                                                                                                                                     | File                                                                                              | Asserts        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------- |
| `rebindCardSessionCore` — swaps only on an exact `fromId` match; no-ops on a mismatch; idempotent                                                        | `tests/roadmap-ipc-*.test.ts` (new `describe`)                                                    | §3.1           |
| rebind writes **only** `session` (status / substrate / executedIn / evidence byte-identical)                                                             | same                                                                                              | §3.1, §9.4     |
| the migrate handler fires the rebind exactly once per migration and never throws into `fireMigrate`                                                      | `tests/sessions-*.test.ts` (existing migrate suite)                                               | §3.1           |
| `planCardSet({set:{substrate:'resume'},…})` → `INVALID_VALUE` (resume is not a substrate)                                                                | `tests/roadmap-core.test.ts`                                                                      | §4             |
| `CARD_SUBSTRATES` unchanged; `SUBSTRATE_LOCKED` still fires with `hasSession:true`                                                                       | `tests/roadmap-core.test.ts`, `tests/dispatch-substrate.test.ts`                                  | §4, regression |
| drain queue filter unchanged — a bound card is never re-queued by `runDrainPass`                                                                         | `tests/manifest-drain.test.ts` (existing suite)                                                   | §5.1           |
| pure resume resolver: 4 rungs from `(cardSession, messageSessionAck)` → `message` / `resume-process` / `unreachable(no-socket)` / `unreachable(unbound)` | new `tests/resume-dispatch.test.ts` (pure core)                                                   | §6             |
| `no-socket` never selects the respawn rung; `process-dead` always does                                                                                   | same                                                                                              | §6, §9.8       |
| refusal ACKs carry a named reason + the spawn alternative; no code path spawns on refusal                                                                | same                                                                                              | §6, §9.6       |
| `resume_card` never calls `bindSessionCore` (spy asserts zero calls on every rung)                                                                       | new `tests/resume-dispatch.test.ts`                                                               | §5.2, §9.4     |
| a `review` card resumed stays `review`; WIP count unchanged                                                                                              | same                                                                                              | §5.2, §5.4     |
| catalog: `resume_card` present with the stated posture; description contains the enqueued-≠-done wording                                                 | `tests/mcp-tool-catalog.test.ts`                                                                  | §8, §9.9       |
| `session`/`evidence` still refused by `update_card` after the new verb lands                                                                             | `tests/mcp-tool-catalog.test.ts`, `tests/roadmap-core.test.ts`                                    | regression     |
| i18n parity for every new key                                                                                                                            | `tests/ci-i18n-parity.test.ts`                                                                    | §11            |
| contract gates satisfied by the diff                                                                                                                     | `tests/awareness-gate.test.ts`, `tests/ci-changelog-gate.test.ts`, `tests/user-docs-gate.test.ts` | §11            |

**Honest gaps.** (a) Whether a message actually reaches a peer, and how long it takes, is a live-CLI fact — verify with the second-instance recipe (`docs/dev/live-verify-second-instance.md`), record the timing in the PR, and do not assert it from a mock. (b) `src/main/pty.ts` is coverage-excluded imperative shell, so the wake path is verified by reading the park ledger (`hibernation.ts:61-100`) after a real run, not by vitest. (c) Rung 2 (a live process with no socket) can only be produced by keeping a pre-2.1.224 session alive; if no such process is available at implementation time, say so in the PR rather than claiming the rung was exercised.

## 11. Contracts touched

| Contract                      | Touched?              | Why                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CHANGELOG.md`                | **YES**               | One `### Added` bullet (a follow-up can be sent to the session a card is already bound to, instead of spawning a fresh one) and one `### Fixed` bullet (a card's bound session id is now corrected when the session materializes, so it stays resolvable). Both user-facing.                                                            |
| `docs/capy-features.md`       | **YES** + marker bump | A new MCP verb **and** a new ACK shape the agent must read — squarely agent-facing, and `tool-catalog.ts` changes so `scripts/ci/awareness-gate.mjs` trips anyway. Exact edit in §11.1.                                                                                                                                                 |
| `docs/user/`                  | **YES**               | `roadmap-board.md` §"From Ready to running" (a bound card can be re-driven without a new session) and `agent-control.md` §"Getting from a card to a running session" + §"Parked and hibernated sessions" (what a follow-up does to a parked session). The `tool-catalog.ts` change trips `scripts/ci/user-docs-gate.mjs` independently. |
| `design.md`                   | **YES, narrowly**     | §6 — the card menu / detail modal gains a "Send to bound session" action and its unreachable/disabled state with a reason. Edit `design.md` **first**, per the contract. **No** substrate-picker change (§4).                                                                                                                           |
| i18n `en.json` + `pt-BR.json` | **YES**               | The action label, the sent-confirmation, and one key per refusal reason (`no-socket` / `process-dead` / `unbound`), in **both** files in the same change (`MessageSchema = typeof en`). **No** new `roadmap.substrate.*` key.                                                                                                           |
| ADR                           | **NO**                | §4 is a placement decision inside an existing pattern (mode vs. enum value), not a new architectural pattern. If T215's transport choice needs an ADR, it belongs to T215.                                                                                                                                                              |
| English-only                  | **YES (compliance)**  | Spec, verb descriptions, code comments, tests and CHANGELOG in English; `pt-BR.json` is the sole exception.                                                                                                                                                                                                                             |

**11.1 The exact `docs/capy-features.md` edit.** Bump the marker on line 1: `<!-- capy-features v34 (2026-07-31) -->` → `v35 (2026-08-08)`. **Version collision:** T206's spec (§8.1) also claims v35; whichever lands second takes the next number — do not ship two v35s.

Insert a new paragraph immediately after the "Dispatch substrate" paragraph (`:408-419`), which itself stays true verbatim:

> **Resuming a card's session — cheaper than dispatching again.** A card that already has a bound `session` can be re-driven instead of re-dispatched: `resume_card({ folder, slug, message })` hands your follow-up to the session that already did the work, which still holds the diff and the file layout in context. This is the right call for a review loop. `ok:true` means the message was **enqueued** in that session's inbox — it is NOT a completion signal, and it is NOT a claim the session started: the CLI gives no result ACK, and the message drains at the peer's next tool round. Verify the outcome the same way you always do — commits, a PR, the transcript — never by the fact that the send succeeded. Nothing on the card moves: status, substrate and `executedIn` are untouched, so a card in Review stays in Review. If the bound session cannot be reached — it was started on an older CLI and has no message channel, or it was never bound to a real session — the call REFUSES with a named reason instead of quietly spawning a cold session; dispatch a fresh one through `submit_manifest` if that is what you want. A parked session is woken first, which costs it a transcript re-read; the ACK tells you when that happened.

Nothing else changes. The manifest paragraph (`:382-406`) and the substrate lock sentence stay exactly as written.

## 12. Open questions (resolve before or while implementing — do not silently default)

- **O-1 (design, blocking §5.2's edges).** Should a `review` card resumed with a fix request return to `in-progress`? Today there is **no** door: `move_card` accepts only `backlog|ready|review` (`tool-catalog.ts:711-713`) and `bindSessionCore` is the only writer of `in-progress`. v1 leaves status untouched. If the answer is yes, it needs its own door with its own posture — not a side effect of a message.
- **O-2 (posture).** Is `resume_card` `alwaysAllowable`? §8 recommends **no** for v1 and gives the reasoning; this is a judgment call the operator should make, since it decides whether a mission grant can bounce prompts into running sessions unattended.
- **O-3 (T215 boundary).** Does T215's resolution answer "does this session have a socket" **without** sending? T213's §6 rung selection needs a probe, not a send-and-see — a failed send may already have side effects, and the operator dialog must show the rung _before_ the operator commits.
- **O-4 (rung 3 fidelity).** After `claude --resume <uuid>`, is the reconstructed context equivalent enough that a follow-up assuming "you already know this repo" is safe, or must the message re-state more? This decides whether the ACK's `woke: true` is merely informational or a caller obligation. Answer empirically before wording the verb description.
- **O-5 (backfill).** 19 cards on this board carry an unrecoverable `synthetic-` id (§2.2). Do they get a one-time operator-visible sweep that clears the field (making them honestly unbound and re-dispatchable), or do they stay as-is and simply refuse? Clearing `session` would also free their `in-progress` WIP slots — attractive, and exactly why it needs a deliberate decision rather than a migration script slipped into this PR.
- **O-6 (id collision) — RESOLVED 2026-08-08, kept for the record.** The `T212` id named both a board card (`message_session` verb) and a shipped spec (`docs/specs/T212-folder-view.md`, committed in `f35a79d`). The card was renumbered **T212 → T215** and the original archived; the folder-view spec keeps T212 untouched. What remains open is the _cause_, not this instance: the id allocator scans **cards**, so a spec filed straight into `docs/specs/` without a card burns an id invisibly and the allocator re-hands it out. Audit at renumber time found `T178` and `T212` as the only spec ids with no card. Worth its own card — it will recur.

## 13. Definition of done

- [ ] O-1 … O-6 answered and recorded in this spec
- [ ] T215 landed, with `messageSession` matching §7's R1–R5 (incl. the `WakeGesture` widening)
- [ ] `rebindCardSessionCore` + `roadmap:rebindSession` IPC in `roadmap-ipc.ts`, compare-and-swap, `session` only
- [ ] `stores/roadmap.ts` registers the migrate handler; failures never break `fireMigrate`
- [ ] Pure resume resolver (4 rungs) in a new, unit-tested core module — no Electron imports
- [ ] `resume_card` in `tool-catalog.ts` with the §8 posture and the enqueued-≠-done wording
- [ ] Board action ("Send to bound session") with its disabled + refusal states, rendered from the named reason
- [ ] `CARD_SUBSTRATES`, its renderer mirror, `planCardDispatch` and `SUBSTRATE_LOCKED` verified **unchanged**
- [ ] `bindSessionCore` verified **uncalled** by every resume path
- [ ] Live verification recorded in the PR: a real rung-1 delivery (with timing) and a real rung-3 wake; rung 2 exercised or explicitly reported as unexercisable
- [ ] Every §10 test green
- [ ] `design.md` §6, `CHANGELOG.md`, `docs/user/roadmap-board.md` + `agent-control.md`, `docs/capy-features.md` (+ marker bump, collision with T206 resolved), `en.json` + `pt-BR.json` — all in the same change
- [ ] `npm run typecheck` and `npm run build` pass
