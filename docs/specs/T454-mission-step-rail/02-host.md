# T454 — The Harnu side: whose step, how fresh, and the route of a press

Part of the [T454 spec](00-spec.md) (AC U-4, and the security half of U-3). Sources and tags as in
the spec's §2. Everything here is Harnu main; nothing here is prototyped (the prototype stands in
for it with a scripted host, [`01-prototype.md`](01-prototype.md) §1).

## 1. Which step is this session's

### 1.1 The match

One pure function, `resolveMissionRole(views, ids, cwd)`, in a new `src/main/mission-role-core.ts`.
`views` are the open missions as `listMissionViews` builds them (`mission-ipc.ts:168-201`); `ids`
is the binding's **trusted id set** (§1.2); `cwd` its folder. It returns every role it finds:

```ts
interface MissionRoles {
  /** Newest non-closed mission whose owner.sessionId is in `ids` (the pill's rule). */
  owner?: { missionId: string }
  /** Newest non-closed mission with a step this binding builds. */
  child?: { missionId: string; mySteps: string[]; matchedBy: 'session' | 'worktree' }
}
```

1. **Owner:** `owner.sessionId` in `ids`, the rule the pill and `mission_get({ ownerSessionId })`
   use (`lib/mission-view.ts:266-277`).
2. **Child by session link:** a step whose `links` hold `{ kind: 'session', ref }` with `ref` in
   `ids`. Those steps are `mySteps`.
3. **Child by worktree link**, only when 2 found nothing: a step with a `worktree` link whose path,
   resolved like the derive resolves it, equals the binding's `cwd` (one worktree per card is the
   dispatch convention, `substrate: 'worktree'`). **Display only:** a folder is not a session. A
   second operator session in the same worktree, or a re-dispatched executor, matches it too, so
   it must not be able to claim or block (spec §5, §7.2).
4. Several `mySteps`: the rail shows the first in progress order that is not `done`/`verified`,
   else the last.

The rail draws the child role when there is one, else the owner role (spec §5).

### 1.2 The ids the host may trust

Round 1 built the id chain from the binding's `sid` plus a `sidHistory` appended by the
`session.rebound` handler. That made the target of a press rest on sensor traffic:

- `onRebound` accepts any well-formed `sid` and calls `host.rebind` without checking it
  (`identity-adapter.ts:259-268`); `rebind` overwrites the binding's `sid`
  (`session-table.ts:266-269`).
- Any plugin in the session can read `conn` and post events for the binding (smoke D6), which
  T389 accepts only because "no consumer trusts [them] as authority" (P1W1:577-579, SEC-3b).
- So `session.rebound { sid: <any id some mission links> }` would have aimed the next revision,
  and the next press, at that step. The bound on a forged press would have been "any open step",
  no narrower than an MCP holder's. The reason the press carries no step id applies to `sid`
  equally.

**The rule now: a press is aimed with ids Harnu observed itself.** For a binding spawned by Harnu
(`owner.kind === 'pty'`), the trusted id set is built from Harnu's own PTY index,
`PtySessionIndex` (`pty-session-index.ts`), never from the binding's `sid`:

| Source of an id for the binding's PTY                                                                                                                         | Trusted                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| the key the PTY was spawned with (`sessionIndex.register(opts.sessionKey, id)`, `pty.ts:959`): a `--resume <uuid>`, or a synthetic id for a new session       | yes                                                                                                        |
| a key the index moved to by a migration Harnu correlated itself: `MigrateVia` `agent-correlation`, `collapse`, `resolved-window` (`stores/sessions.ts:702`)   | yes                                                                                                        |
| a key moved by a `companion` migration whose claim has `cause: 'spawn'` and binds the PTY's own synthetic row (`bindByClaim`, `stores/sessions.ts:5138-5156`) | **yes, under S1–S5 below** (W1 gives this migration its own `via`, `companion-spawn`)                      |
| a key moved by a `companion` migration whose claim has `cause: 'clear'` or `'resume'` (a `session.rebound`, `:5157-5176`)                                     | **never**: recorded for the audit and the OQ-8 gesture, flagged contested when a step or an owner links it |
| the binding's `sid`, a `session.rebound` as such, anything else the mod says                                                                                  | no                                                                                                         |

**Why a spawn claim has to be trusted.** In companion mode `active` (T389's target) the claim path
runs before every other binder: `reconcileSessionAdded` honours an acting claim first
(`stores/sessions.ts:5200-5201`), and a claim acts whenever the mode is `active`, the CLI gate is
ok and the lease is live (`mayAct`, `identity-core.ts:41-48`). So a fresh `create_session`
executor reaches the real id that `mission_link_child` later links through a **`companion`**
migration, not `agent-correlation`. Without the third row only `--resume` spawns would keep their
actions, and the rail would work in the legacy modes only. W0 records the `via` and the claim
`cause` a fresh executor actually gets in each mode (A-11).

**The five conditions on a spawn claim**, all evaluated by Harnu from facts it holds, at the
`session:added` of the transcript the claim names:

- **S1** the claim's cause is `spawn`, which only a binding's first hello carries (the hello that
  redeemed the one-time spawn token), and it migrates the PTY's own synthetic row (`row.synthetic
=== true`): the key comes from the PTY that carried the token (`:5129-5131`), never from a
  request. One spawn claim is accepted per PTY.
- **S2** the transcript landed in the folder the PTY runs in: the event's `slug` resolves to the
  row's folder. `bindByClaim` takes the folder from the row and ignores the event's slug today;
  W1 adds the check. A forged `sid` naming a sibling's transcript, which lives in the sibling's
  worktree, fails here.
- **S3** no other live PTY and no other unmigrated synthetic row runs in that folder. A shared
  folder is ambiguous, so its sessions are display-only.
- **S4** the transcript was born after the PTY's spawn (its first timestamped record, A-1), no
  live PTY holds the id, and Harnu never registered it for any other PTY (the process-lifetime
  ledger in `PtySessionIndex`, so a hibernated or finished sibling still refuses).
- **S5** no step of any mission links the id and no mission has it as `owner.sessionId`, as the
  views stand at that moment. A fresh executor's id is new, so it is unlinked; the orchestrator
  links it afterwards, and a link made after the migration does not undo it (a spawn-cause id is
  trusted, not contested).

**Forged-rebound reasoning, re-run against this.**

- A forged `session.rebound` carries `cause: 'clear'` or `'resume'` and so never matches (row 4).
  That is the vector round 1 used, closed.
- A forged **first hello**: a sibling plugin reads `HARNU_SPAWN_TOKEN` (any plugin can
  `$.env.get` it) and redeems it before the companion, with a `sid` of its choosing. The claim
  then acts only if a transcript with that id lands in A's own folder (S2) while A's synthetic row
  is unmigrated, with no other PTY or synthetic there (S3), and the id is new and held by nobody
  (S4, S5). Naming a sibling executor's id fails S2, S3 or S4. The one id that can pass is a
  `claude` the person started by hand in A's folder in that window, and the forger then needs an
  orchestrator to link that session to a step: **K-9's remainder**, three coincidences deep. The
  real companion's hello then fails (the token is spent), the binding record shows "did not
  connect" in the Mods tab, and the rail row goes to whichever plugin holds `conn`, so the forger
  cost the session its own companion.
- A forged hello cannot be repeated: a second claim for the same PTY is refused (S1).

**What this means for a `/clear`.** A `/clear` or `/resume` typed in an executor is a rebound with
`cause: 'clear'` or `'resume'`, so the new id never matches (row 4): the executor keeps its rail
only through the `worktree` link (display only) until Harnu respawns it (`--resume <its id>`,
row 1) or the operator uses a gesture (OQ-8). Harnu cannot tell a genuine `/clear` from a forged
rebound once a step links the id, so this is fail-closed on purpose. Fresh executors and `--resume`
spawns keep their actions.

**What is left of the forged-rebound risk.** For a rebound, nothing: it never matches. For a
forged first hello, the remainder named above.

**A stronger option, not adopted: mint the id.** `pty:create` already accepts a caller-minted
`claudeSessionId` for `claude-new` and emits `--session-id <uuid>` (T245, T344;
`pty.ts:212-224`, `:698-733`; agent-dispatched spawns skip it today). If every Harnu-spawned
executor were started that way, the PTY's key would be the real id from the first moment, the
fact would be `confirmed` (`key === sid`), and no claim would carry the target. It changes every
dispatch's argv, the synthetic-row machinery and the T245/T344 arming rules, so it is OQ-B for the
operator, not a decision of this spec.

**When the checks run, and what they read.** S1 to S5 run once, when the spawn claim is evaluated
at the transcript's `session:added`, against the views of that moment (S5). The _contested_ flag of
a rebound-derived id is recomputed on every publish, before `resolveMissionRole`, and on every
mission write, against that publish's views (up to `RAIL_LIST_MS` old, 20 s); a session link added
by a direct edit of a mission file is seen at the next tick. A press never rests on any of those
views: the executor reads the mission file fresh under the lock
(§3.2) and refuses `RAIL_STALE` unless the matched step still holds a `session` link to one of the
binding's trusted keys.

What changes in code (W1): `PtySessionIndex` keeps, per PTY, a bounded history of
`{ key, via: 'spawn' | MigrateVia, at }`, plus the process-wide ledger of S4; the `pty:rekey` IPC (`pty.ts:1140`, today
`(fromKey, toKey)`) and the renderer's migrate handler (`registerMigrateHandler`,
`stores/sessions.ts:1340`, today `(fromId, toId)`) carry the `via` that `fireMigrate` already has
(`stores/sessions.ts:1741`). The renderer is Harnu's own code, so its `via` is a host fact.

**External bindings** (P4W3, no PTY) use their corroborated `sid` (Harnu's watchers saw the
transcript, `external-corroboration.ts`) for the display row only; they never get an action.

**Residual, stated.** A plugin in the session could delete and recreate another session's
transcript file, or write a first record with a late timestamp, to give it a fresh birth time
(S3, S4 and S5 still apply to it). The same plugin can write `.harnu/missions/*.md`
directly, so this adds no capability it lacked (ADR-0018 Decision 3: a mod is unsandboxed code).

No amendment to SEC-3b is needed: no consumer here trusts an event as authority.

### 1.3 Display and actions use the same ids

The trusted set aims both the display and the actions. A row that shows a step the session cannot
act on would teach the person to press keys that answer `RAIL_NOT_OFFERED`. After a `/clear` the
rail therefore shows the step of a trusted key, and after a `/clear` the worktree match, display
only, or nothing (§1.2, OQ-8).

### 1.4 T447's finding, D-A, and the order of roles

T447 found that "`mission_get` looks a mission up by `missionId` or `ownerSessionId` only …, so an
executor cannot find its mission by owner" (T447 `00-spec.md:408-409`), and that a linked
transcript id goes stale after `/clear` or a resume (T447 A7, `00-spec.md:236`). It proposed D-A:
a server-side child lookup that matches "**by binding first** … the binding's whole id chain …
**By worktree second**" (`00-spec.md:426-435`, `:862`).

- **One function, two policies.** `resolveMissionRole` returns both roles. T447's `missionCurrent`
  resolves the owner first (T447 §5.4); the rail shows the child first (spec §5). If D-A wraps
  this function, `$.harnu.missionCurrent` and the rail can show different missions for a session
  that is both an owner and a child. That is deliberate and documented: `missionCurrent` answers
  "the mission I am responsible for", the rail "the step I am working on". D-A itself,
  `mission_get({ childSessionId })`, returns the child match only.
- **Trust differs by purpose.** D-A is a read; like `ownerSessionId` it takes a self-declared id
  ("Self-declared, not authenticated", `TC:1394-1404`), and that is fine for a read. The rail's
  writes are aimed only with the trusted set of §1.2. D-A should not adopt T447's "binding's whole
  id chain" from `session.rebound` for anything that writes.
- **No duplication.** Whichever of W1 and D-A lands first creates `mission-role-core.ts`, the
  first-lander rule P4W2 applies to its ask client (P4W2:29-30).

## 2. Freshness and cost

### 2.1 Why not MCP, and why not `$.harnu`

- An executor dispatched with `create_session` is `agentControlled`; Harnu withholds its
  `--mcp-config` so "the agent gets NO Harnu MCP server" (`pty.ts:811-818`). A board or manifest
  dispatch gets the server (T447 SDK-Q10), but the MCP-spawned executor is the rail's main reader.
- In such a session `$.mcp.call('harnu', …)` has no server to reach, and T447's noun answers
  `NO_MCP` for every mission method (T447 `00-spec.md:501-508`).
- The companion may not call `$.mcp.call` at all (T389 SEC-9 (b), `00-master.md:502`).
- The companion **is** loaded in those sessions: the spawn path asks the companion provider with
  `trust: trustFor({ agentControlled, … })` and inserts its `--plugin-dir` for agent and non-agent
  spawns alike (`pty.ts:836-857`).

So the host is the only party that both knows the mission and reaches every executor.

### 2.2 A timer Harnu main owns

Round 1 rode the renderer's mission poll. That poll is not a guarantee: it starts only when a
`MissionPill` or `SidebarFolder` mounts (`missions.ensureStarted()`, `MissionPill.vue:22`,
`SidebarFolder.vue:410`; `stores/missions.ts:151-155`), it lists only `sessions.folders`
(`stores/missions.ts:112`), and it is a renderer `setInterval`, which Chromium may throttle while
the window is hidden (an assumption, not measured; the rail no longer depends on it).

So `src/main/companion/rail.ts` owns the clock:

- **A tick every `RAIL_LIST_MS` (20 000)**, running only while at least one bound binding has
  `ui.band` enabled. It calls `listMissionViews` over the repos of those bindings' folders, with
  `prWaitMs: 0` so the derive reads the sticky link cache (`mission-link-cache.ts`) instead of
  waiting on GitHub. `listMissionViews` passes no options to the derive today
  (`mission-ipc.ts:192-198`); W1 adds the pass-through. A renderer list that covered the same
  repos less than 20 s ago is reused instead of a second derive.
- **Every write, at once.** After any mission write — a `mission_*` handler (`editMission`,
  `missionLogHandler`), an operator door (`runOperatorDoor`) or a rail press — the publisher
  re-derives that one mission with `prWaitMs: 0` and republishes the bindings it touches.
- **The channel's own timing**, unchanged from P4W2: debounce `BAND_DEBOUNCE_MS` (500 ms),
  keep-alive `BAND_REFRESH_MS` (60 s), mod TTL `BAND_TTL_MS` (90 s). `ui.band.set` is
  observe-only, so it is admitted while the Harnu mod's `channel` key is at its default `shadow`
  (`command-gate-core.ts:127-142`; P4W2:168-172).

**The bound, stated:** a write shows within the debounce plus one single-mission derive; a
time-dependent field (`running`, `waiting`, `stale`) within 20 s plus one list, whether or not a
Harnu window is open or visible.

### 2.3 Cost across a fleet

Measured (`MEAS`; method: parse the frontmatter of every `.harnu/missions/*.md` in the main
checkout and count statuses, steps, `session` links and title lengths): 17 mission files, of which
11 are not closed; 109 steps; 141 `session` links.

Per tick (every 20 s, only while a rail is live):

- One `listMissionViews` over the rail bindings' repos, the same work one renderer poll does
  today, with no GitHub wait; or none, when a renderer list is reused.
- One `resolveMissionRole` per bound binding: a scan of the open missions' links against a trusted
  set of a few ids. With 20 bindings and this repo's 141 links, a few thousand string comparisons
  per tick. **Not measured as time** (A-6); W1 measures it on a synthetic 50-mission, 50-binding
  fleet and records the number.
- `ui.band.set` only for bindings whose value changed, debounced. A steady fleet sends one
  keep-alive per binding per minute, the P4W2 rate.
- **Zero** MCP calls, zero calls from any session.

Per press: the checks of §3.1, one locked write, one single-mission re-derive.

For contrast, T447's v1 `mission` topic polls one `$.mcp.call` per session every 10 s, with up to
10 `mission_get` calls to resolve a child (T447 `00-spec.md:414-420`, `:621-623`), and cannot run
in an executor at all.

## 3. The route of a press

### 3.1 The event and its checks

1. The Button's `onPress` (or the `Input`'s `onSubmit`) runs in the mod. Claim first switches the
   row to its confirm; block and log to an `Input`. When the person ends it, the mod checks that
   the line and the action are still there (spec §7.5) and only then sends.
2. The mod queues the edge event and flushes it at once (edge events flush immediately,
   `T389/01-contract.md:359-361`):

   ```ts
   /** Δ4: the edge event (contract §6). */
   type RailActionEvent = {
     name: 'step.claim' | 'step.block' | 'step.unblock' | 'step.log'
     rev: number
     text?: string // block and log only; ≤ 200 chars
   }
   ```

   It carries **no step id, no mission id, no session id**: any plugin can rewrite another's
   `$.state` value through a `state.set` hook (E9) and post events with `conn` (§1.2), so nothing
   the mod holds may name the target.

3. Harnu main checks, in order, and answers the first failure as `result.code` in the next
   revision:
   - the binding is bound with a live lease, profile `interactive`, trust `agent` or `operator`,
     owned by a PTY, and has `ui.rail` enabled (`RAIL_NOT_ENABLED`);
   - "Ask before agent actions" is off (`ASK_MODE`; §3.3);
   - **`rev` is the revision the person saw when the key was drawn or the field opened**, pinned
     by the mod (spec §7.5, rule 1). The host keeps, per binding, the target (`missionId`,
     `stepId`) of each of its last 32 published revisions. If `rev` is not among them, or the
     target it names differs from the binding's current target, the answer is `RAIL_STALE`: a
     note typed for step 3 never lands on step 5, whether another mission arrived or the child
     moved to its next step (`KIT` test 10; `LIVE` E9). A pinned revision whose target is still
     the current one is accepted even though a later push bumped the revision (a stale age
     ticking over must not void a note);
   - the action is in the **current** revision's `actions`, which only a child matched by a
     trusted session link ever has (`RAIL_NOT_OFFERED`);
   - `text`, when the action takes one, is 1–200 characters after trimming and stripping control
     characters (`BAD_TEXT`);
   - at most one action per `RAIL_MIN_INTERVAL_MS` (2 000) per binding (`TOO_FAST`).
4. Harnu main takes `missionId` and `stepId` from **its own** record of the target of the pinned
   revision (which step 3 required to equal the current target) and applies the write of §3.2.
5. It writes one audit record (§3.4), re-derives the mission and publishes the next revision with
   `result`. No toast, no `$.ui.status`: P4W2 keeps the band and the status line from saying the
   same thing (P4W2 §7.4).

```ts
type RailRefusal =
  | 'RAIL_NOT_ENABLED'
  | 'ASK_MODE'
  | 'RAIL_STALE'
  | 'RAIL_NOT_OFFERED'
  | 'BAD_TEXT'
  | 'TOO_FAST'
  | 'MISSION_CLOSED'
  | 'FOLDER_NOT_ALLOWED'
  | 'STEP_NOT_FOUND'
  | 'PROOF_NOT_CLAIMABLE'
  | 'REFUSED'
```

**Specified, not run.** The host half of the pin (the 32-revision target record, `RAIL_STALE`,
`RAIL_NOT_OFFERED`, the fresh re-read under the lock) is not prototyped: the kit's stand-in host
only records the revision it receives. Its L1 tests are W2's, and W0 checks the revision-ring size
against a real publish rate (A-10).

`KIT` tests 2, 3 and 10 and the `LIVE` host log show step 2: `{"name":"step.claim","rev":5}`, and
`{"name":"step.log","rev":1791579453,"text":"note for the old step"}`, the revision of the frame
the field opened on, sent after the host had pushed `null` and a line for step 5 (E9).

### 3.2 One locked write, with provenance

Round 1 ran the verb's handler and then appended a Log line through `mission_log`: two locked
writes, a failure between them leaving a claim with no attribution, and a Log line any MCP holder
could forge verbatim, since `ToolHandlerCtx` carries no caller identity (`tool-handlers.ts:234-262`)
and the handlers store none. Now:

- **One mutation, shared.** W2 extracts the mutation bodies of the three handlers into pure
  functions in `mission-core.ts`: `applyClaim(m, stepId)` (the body of
  `missionUpdateStepHandler`'s `proof: 'claimed'` branch, `tool-handlers.ts:4187-4203`, with its
  `PROOF_NOT_CLAIMABLE` refusals), `applySetBlocker(m, stepId, b)` (`:4291-4323`),
  `applyClearBlocker(m, stepId, reason)` (`:4325-4357`). The handlers call them; so does the rail.
  One mutation path, one set of refusals.
- **One write, through `editMission`.** `editMission(args, ctx, fn)` (`tool-handlers.ts:4051-4084`)
  already does everything a locked write needs: load under `withMissionIdMintLock`, refuse
  `MISSION_CLOSED`, refuse a blocked folder (`missionFolderRefusal`), stamp `updatedAt`, and write
  the frontmatter **and** `edit.logAppend` in one `atomicWriteFile`; its `fn` may return
  `logAppend` (`MissionEdit`, `:4020-4026`). W2 exports a thin `editMissionFor(root, id, ctx, fn)`
  with that body and the rail calls it with a `fn` that applies the shared mutation and returns
  `logAppend`: no steps are copied. The ctx carries the agent policy (the live `denyFolders`), as
  for any agent verb. A log press is a `fn` that only returns `logAppend`.
- **The Log header is not provenance on its own.** The entry's header is `### <iso> · rail ·
stp-3`, and the verbs build their own headers (`missionLogEntry(before, tag, text)`,
  `tool-handlers.ts:4362`, tag ` · <stepId>`). But several of them insert caller text raw: the
  `note` of `mission_log`, up to 8000 characters (`TC:1524`, `tool-handlers.ts:4553`); the
  `evidence` of `mission_verify_step` (`:4524`); and in `mission_set_end` the `reason` **and**
  `declaredEnd.target` and `.evidence`, which are only trimmed (`:4383-4384`) and interpolated
  through `formatDeclaredEnd` into the `was:` and `now:` lines (`:4405`); the importer copies a
  legacy Log verbatim. A newline in any of them can start a line that reads `### <iso> · rail ·
stp-3` and, below it, `Claimed from the terminal rail …`. So W2 adds **one shared helper,
  `neutralizeLogText`, and every verb applies it to the whole body it composes, after its own
  header line and not field by field**: each line matching `^ {0,3}#{1,6}(\s|$)`, up to three
  leading spaces being what CommonMark still renders as a heading, gets a backslash before the `#`.
  A drift test greps `tool-handlers.ts` and `mission-core.ts` for every `logAppend`,
  `missionLogEntry` and `createMissionFile` call and fails on one whose body is not wrapped, so a
  later verb cannot add a raw path. `readMissionLog` is unchanged. With that, a `· rail ·` header
  can only come from the rail's executor. Even so, the Log is a record for people; what the code
  and the popover trust is the `via` mark below, which no verb can set.
  Bodies are fixed templates: "Claimed from the terminal rail (operator, session `1a2b3c4d`).",
  "Blocker raised from the terminal rail …", "Blocker cleared from the terminal rail …", and for a
  log press "Operator note: {text}". The session is the first eight characters of the trusted key
  the step matched.
- **A mark on the record.** The rail sets `via: 'rail'` on a blocker it raises
  (`Blocker.via?: 'rail'`) and `claimedVia: 'rail'` on a step it claims. No verb accepts either
  field (`mission_update_step` refuses unknown `set` keys, `BAD_ARGS`; `mission_set_blocker` takes
  `reason`, `unblocks`, `owner` only), and W2 adds both, optional, to the mission file's validator.
  The popover shows "from the terminal rail" beside such a blocker or claim (`mission.viaRail`,
  both locales). **The mark must not outlive the act it describes.** `mission_set_blocker` updates a
  blocker with the same `reason` in place (`tool-handlers.ts:4304-4306`: `unblocks` and `owner`
  are overwritten), and `mission_update_step` can set `proof: 'claimed'` again on a claimed step
  (`:4187-4203`). W2 makes both handlers delete `via` and `claimedVia` when they touch the record,
  and every other write that changes a step's `proof` does the same: `mission_verify_step`
  (`:4524` and its proof update) and the operator doors (`applyOperatorVerifyStep`, ticking and
  unticking a human step), so `claimedVia` never survives a verification. A mark means "this
  record was last written by a press"; a rail press that updates an existing blocker sets it
  again.

### 3.3 Who can press, and what that grants

The question is whether the rail gives an agent-dispatched session a mission write that Harnu
deliberately withheld (SEC-9 (g): "agent-controlled spawns get no Harnu MCP").

- **The model cannot press.** A Button is pressed by person input on a surface (E7); no plugin can
  raise a press at run time (E8, A-4); the model has no route to the band. The rail adds no slash
  command (P4W2's Q-P4W2-d does not arise).
- **The model's tools cannot forge an event either**, provided the Bash tool's processes cannot
  read `conn` from the `claude` process (A-3).
- **A sibling plugin can forge an event** (it can read `conn`). What it gets: the four agent-level
  writes, on the step Harnu resolved from ids it observed itself (§1.2), in the current revision,
  one per 2 s, each under a `· rail ·` header, marked `via: 'rail'` and audited. A forged block
  raises an operator-owned blocker that chimes every 30 minutes until cleared (risk K-8): the
  popover shows where it came from, one click clears it, and any MCP holder can already raise the
  same blocker with `mission_set_blocker`.
- **A plugin above the rail can rewrite its tree** (it receives the rail's row as `below`):
  relabel a Button, change a hotkey, hide the confirm's wording. A press still runs the
  companion's closure for the companion's key (E7). Nothing in-process prevents it (smoke D6:
  plugins of one tier are not isolated); what a press did is what the Log line and the popover
  say, never the label (risk K-3).
- **The same writes are open to any MCP holder.** The four handlers check no owner and no link
  (T447 §5.4: "any caller with the MCP server can write to any step of any mission in the
  folder"). The rail is narrower: one step, the one Harnu resolved.
- **External bindings and folder matches get no actions** (spec §5).
- **"Ask before agent actions" on → no actions.** The operator chose that agent-reachable writes
  wait for a confirm. The rail cannot prove a press came from the person, so in Ask mode the host
  sends `actions: []` and refuses any event `ASK_MODE`; the row stays, display only (OQ-6).

### 3.4 Audit (SEC-6)

One record of kind `rail` per accepted or refused event, in `<userData>/companion/audit.ndjson`:
binding, action, mission id, step id, the trusted key the step matched, outcome, a hash of `text`
(never the text). The mission Log entry is the trace the orchestrator and the operator read.

## 4. Environments

| Session                                                         | What the rail does                                                                                                                                       |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spawned by Harnu for an agent (`agentControlled`), no Harnu MCP | full rail and actions: the data comes over the companion channel, not MCP (§2.1)                                                                         |
| Spawned by Harnu, operator-started, with Harnu MCP              | same; the rail never uses the MCP server                                                                                                                 |
| Board or manifest dispatch (trust `agent`)                      | same                                                                                                                                                     |
| Fresh `create_session` executor, companion `active`             | reaches its real id through a `companion` migration with claim cause `spawn`: trusted under S1–S5, full rail and actions (A-11)                          |
| A session sharing a worktree with a step's link, not linked     | display only (§1.1, rule 3)                                                                                                                              |
| Read-only review spawn                                          | display only                                                                                                                                             |
| Scheduler tick                                                  | nothing: headless, `ui.render` not raised; `ui.band` is never enabled headless (`feature-policy.ts:82`)                                                  |
| Outside Harnu, P4W3 on                                          | owner row (P4W2 row 4 + Δ5), child row display-only, both after corroboration                                                                            |
| Companion `off`, CLI below the floor, sideload-blocked          | nothing: no companion, no band                                                                                                                           |
| Companion `legacy` (loaded, not authoritative)                  | nothing until `ui.band` is enabled for the binding (spec §10)                                                                                            |
| Harnu quits mid-session                                         | the row turns final after the TTL; an open field or confirm stays until the person ends it (spec S8, §7.5)                                               |
| Hot reload of the companion                                     | the row redraws from `$.state` (the `band` value survives a reload, `TYPES:3376-3383`)                                                                   |
| Hibernation, then resume                                        | Harnu respawns with `--resume <uuid>`: the spawn key is trusted (§1.2)                                                                                   |
| `/clear` or `/resume` typed in the executor                     | display only through a `worktree` link, or nothing; actions return with a respawn by Harnu (`--resume`, a spawn key) or an operator gesture (§1.2, OQ-8) |
