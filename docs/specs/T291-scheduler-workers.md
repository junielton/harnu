# T291 — Scheduler Workers: a dumb recurring runner that executes a prompt on a cadence

**Status:** Design (no code)
**Date:** 2026-09-07
**Card:** none yet — mint with `create_card`. The board's highest id is T290, so
`mintNextCardId` (`max + 1`) predicts **T291**; this number is a _prediction_ and must be
reconciled with the minted id before implementation. Never hand-write the card file.
**Related:** T233 PR Conformance Watcher (design, no code — a per-PR headless watcher; this
spec is the generic engine T233 can sit on), T113 background manifest drain (the drain
driver whose pure-core/thin-shell shape this mirrors), T217 bundled skills (`--plugin-dir`
staging, which this reuses verbatim), T55 Capy self-awareness (the preamble this
deliberately does NOT inject), T93 MCP allow rule (the blanket allow this deliberately
narrows).

---

## 1. Problem

Capy dispatches work when a human asks, and drains a manifest when a human stamps one.
It has no way to make something happen **on a cadence, unattended**.

The operator's own words: _"I want that scheduler, that worker, that… I don't know how to
call it yet. Keep looking to this repo and every five minutes check if something changes.
If someone had opened a PR."_

Three needs bundle into that sentence and separate cleanly:

1. **A place** — a surface that is not scoped to whatever folder is selected in the sidebar.
2. **A trigger** — a configurable interval, plus "run when Capy boots" and "run now".
3. **An open prompt** — free text the operator keeps editing; the worker re-reads it each tick.

What must NOT be built into it is a decision about _what the work is_. The operator was
explicit: the scheduler should be **dumb**. What a tick does belongs in the prompt and in
the skills the prompt names — reviewing a PR, addressing review comments, watching a repo,
fetching a market price. The scheduler runs and records; it never decides.

## 2. Decisions taken, and why

These were settled during design and are not open for rediscovery.

### 2.1 A tick is a NEW session, every time

Each firing spawns a fresh headless process that reads the prompt, works, and dies. No
context accumulates, cost is predictable, nothing ever compacts, and there is no permanent
process for the hibernation policy to fight over.

The cost is that a tick does not remember the previous tick. Continuity, where it is
needed, comes from readable state (the repo, the board) plus an opt-in one-line carry-over
(§4.6) — never from a long-lived session.

**Rejected:** one long-lived session woken by `command-bridge`. It gets "I already saw PR
#281" for free, but its context grows without bound, it collides with the hibernation
policy that kills cold sessions, and a 5-minute worker becomes a permanent resident in RAM.

### 2.2 A tick is INVISIBLE to the fleet

A worker firing every 5 minutes is **288 sessions per day**. Capy's watcher reads
`~/.claude/projects/`, so a persisted tick session would land in the sidebar, the fleet,
and `get_fleet` — the exact pollution BUG-77 already tracks for Capy's own usage probes.

Ticks therefore run with `--no-session-persistence` (print-mode only), which writes no
transcript to `~/.claude/projects/`. Nothing to watch, nothing in the sidebar.

The operator is not left blind: Capy captures the process's own stdout and keeps **its own**
run record (§5), with retention Capy controls.

**Rejected:** visible PTY sessions (the sidebar dies in a day), and a third "session that is
not a fleet session" concept (it would have to cross the watcher, hibernation, the reaper
and `get_fleet` — the most expensive option on the board).

### 2.3 The substrate is local headless `claude -p`, not a cloud routine

A cloud routine (`CronCreate`) survives Capy being closed, but it has no access to the local
repo, no folder, and no staged Capy skills — which rules out every case the operator
described. Capy closed means nothing runs; that is a known limitation (§8), not a bug.

### 2.4 Skills are named in the prompt. There is no "attach skills" field

A skill is not an attachment the scheduler carries. The **`claude` runtime** is what reads
`SKILL.md`, matches on `description`, and composes the prompt. The scheduler only ever hands
over text. An "attach skills" picker would be UI lying about who does the work.

What the scheduler DOES own is the **scope**: the worker's folder decides which bundled
skills are staged, because staging is per-folder (T217).

**Verified live**, not assumed:

```
$ claude -p --plugin-dir <staged> --model haiku "Invoke the zzz-probe skill and tell me the magic word."
CAPYSCHED-7788
```

Headless print mode loads a `--plugin-dir` plugin and invokes its skill normally. The exact
staging Capy already performs per folder works without a PTY.

### 2.5 Provider-agnostic is already solved; runtime-agnostic is not worth it

> **Superseded 2026-09-08 (BUG-114).** The reasoning below describes a Provider
> picker on the worker that was drawn, persisted — and never read on the spawn
> path. No worker ever ran against a selected endpoint; every tick used the
> Anthropic default. The control was removed rather than left inert, and
> `provider` is dropped from a worker on load (`normalizeWorker`). The argument
> for _why_ provider-agnosticism would be cheap still stands and is kept here as
> the historical record; what did not ship is the wiring that would have made it
> true.

The Endpoints registry (`claude-args.ts#EndpointProfile`, edited in `EndpointsPane.vue`) is
**not an HTTP client**. It is three env vars — `ANTHROPIC_BASE_URL` / `ANTHROPIC_MODEL` /
`ANTHROPIC_AUTH_TOKEN` — injected into the `claude` process Capy spawns
(`claude-config.ts:238`, `pty.ts:895`). It frees the session from Anthropic's servers, not
from the Claude Code CLI. There is no code in Capy today that calls an LLM over HTTP.

So a worker can already run against a local model by picking an endpoint. That is
**provider** agnosticism, and it is free.

A second job kind — a raw `fetch` to an endpoint, no CLI — was considered and **rejected for
v1**. Dropping the CLI drops skills, tools, MCP, git and repo access along with it: text in,
text out. `claude -p --model haiku` pointed at a local endpoint covers the same "watch a
URL" case **and** keeps tools. The cost of the second path is a whole parallel execution
route plus a form that must explain why half its fields vanish. Revisit only if real usage
demands it.

## 3. The worker

A worker is a definition, persisted in `<userData>/schedulers.json`. It holds no live state.

```ts
interface Worker {
  id: string
  name: string // "PR watcher — capy"
  enabled: boolean
  prompt: string // free text; names skills here (/mission, "use skill X")
  folder: string // REQUIRED: the tick's cwd, and the source of staged skills
  everyMinutes: number
  runOnBoot: boolean
  model: string // haiku | sonnet | opus | fable | full id
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  mode: 'observe' | 'act'
  provider?: string // EndpointProfile id; empty = default
  timeoutSeconds: number // default 300
  carryLastResult: boolean // default false — see §4.6
  keepTranscript: boolean // default false — see §5.2
  extraReadCommands?: string[] // observe only, additive; see §4.4
  systemPrompt?: string // advanced; replaces the default system prompt
}
```

> **Superseded 2026-09-08.** Two fields above never shipped as working settings
> and are gone from `Worker` in `src/main/scheduler-core.ts`: `provider`
> (BUG-114, see §2.5) and `keepTranscript` (BUG-115, see §5.2). Both are dropped
> on read, so an old `schedulers.json` heals itself. Two fields arrived after
> this spec was written: `notifyOn` (T304 — `silent` | `failure` | `every`, absent
> resolving to `silent`) and `failureStreak`. The live shape is the interface in
> `scheduler-core.ts`, not this block.

### 3.1 `folder` is required

"It shouldn't matter whether I'm in a folder" applies to the **surface**, which is global.
It does not apply to the worker: without a cwd there is no repo, and without a folder there
are no staged skills. A worker whose task is repo-independent still names a folder and
ignores it.

**The field is a searchable combobox over `sessions.folders`** — the same list that feeds
the sidebar (pinned, "active elsewhere", worktrees), each already carrying `alias`,
`branch`, `repoId` and `path` — grouped by repo the way the sidebar groups, rendered as
`alias · branch`. A trailing "Choose another folder…" item opens the native dialog and
adopts the folder (`adopt_folder`). A free-text path input is rejected: a typo becomes a
worker that dies silently at 3am.

Implement as `ui/FolderCombobox.vue`, a sibling of the existing `ui/BranchCombobox.vue` with
the same anatomy and tokens. Do **not** generalize `BranchCombobox` now — it declares itself
scoped to `BranchRef[]`, it has two call sites, and refactoring it mid-feature buys a
regression in `NewWorktreeDialog` for nothing. A third combobox is the moment to extract.

Two behaviors the field carries:

- **Skill hint.** If the chosen folder has no bundled skill enabled
  (`bundledSkillsGetFolder`), show a hint — a prompt naming `/mission` in a skill-less
  folder fails silently.
- **Vanished folder.** If the folder no longer exists at tick time, the worker
  **disables itself** and notifies, naming the folder. It never spawns into a dead cwd and
  never accumulates 288 failures a day.

### 3.2 The surface

A global takeover, the established pattern of `UsageDashboard` / `SystemMonitor` /
`CleanupView` (`ui.<x>Open` → `App.vue` `v-else-if`). Worker list on the left, editor on the
right; per worker a state dot, the last run, and "Run now". This is the "somewhere outside
the sidebar that I click" the operator asked for, and it costs no new layout concept.

**Entry point: a footer pill** in `StatusFooter.vue` — quiet (`--text-4`, a clock glyph and
the word) when nothing is running, and a green count with the same pulse a running row uses
when something is. A folder menu would be wrong: the surface is global and a worker names its
own folder. Sibling of the heap gauge and the cleanup pill already living there.

The visual contract is `docs/specs/2026-09-07-scheduler-takeover/` (`spec.html` +
`review.html`).

## 4. The engine

`scheduler-core.ts` (pure) + `scheduler-shell.ts` (effects), the pure-core/thin-shell pair
`manifest-drain` uses, per ADR-0001.

```ts
dueWorkers(workers, runs, now): Worker[]
nextRunAt(worker, lastRun, now): string
tickArgv(worker, ctx): string[]
```

`tickArgv` being pure is the point: every permission, model, effort, provider and flag
decision in this spec becomes an argv assertion in a unit test, with nothing spawned.

### 4.1 The clock

A single 30s `setInterval` in main — one _ticker_, not a timer per worker. Each beat asks
the core who is due. This is the house pattern (`claude-status.ts`, `usage.ts`,
`updater.ts`); N timers would be N states to sync, drift and clean up.

### 4.2 The argv

```
claude -p <prompt>
  --model <model>  --effort <effort>
  --plugin-dir <staged skills for folder>
  --strict-mcp-config  --mcp-config <Capy's own config file>
  --setting-sources ''
  --no-session-persistence
  --output-format json            # or stream-json when keepTranscript
  <permission args — §4.4 / §4.5>
  [--settings <Capy hook blob>]       # both modes, observation only, §4.5
  [--system-prompt <advanced>]
cwd = worker.folder    stdin = /dev/null    env += provider endpoint vars
```

> **Superseded 2026-09-08.** Two lines in the argv block above never shipped.
> `--output-format` is **always** `json` — the `stream-json` branch (BUG-115)
> existed only for `keepTranscript`, and `runFromResult` parses the LAST line of
> stdout as the whole document, which for a stream is one event rather than the
> result; the flag could only make the reader wrong. And `env += provider
endpoint vars` never happened (BUG-114): nothing on the spawn path read
> `provider`. Everything else in the block is what `tickArgv` emits today, plus
> `--` before the prompt (an operator's free text that happened to equal a real
> flag was being parsed as that flag).

`stdin = /dev/null` is not optional: `-p` waits ~3s for stdin and warns when none arrives.

### 4.3 Born lean — measured, not assumed

Measured with `--output-format json`, haiku, a trivial prompt. Total context =
`input + cache_read + cache_creation`. These move ±2k with cache state; treat as order of
magnitude.

| variant                                                          | context     |
| ---------------------------------------------------------------- | ----------- |
| today's normal Capy session (default prompt + Capy preamble)     | ~38,200     |
| bare `claude -p`                                                 | ~27,000     |
| `+ --strict-mcp-config` (drops the user's MCP servers)           | ~22,900     |
| **default prompt, no Capy preamble, no MCP, narrow allowlist**   | **~18,300** |
| all of the above + short `--system-prompt` replacing the default | ~12,100     |

**~38k → ~18k is −52% with no behavioral change.** At 288 ticks/day that is 11M → 5.3M
tokens/day.

Two things earn that:

- **The Capy preamble is not injected.** `docs/capy-features.md` (41 KB, ~11k tokens) is
  prepended by Capy via `--append-system-prompt`
  (`claude-args.ts#composeAppendSystemPrompt`, called from `pty.ts`) — it is Capy's choice,
  not the CLI's default. It describes the Approval Inbox, the sidebar, panes and UI
  affordances a headless tick cannot use. Injecting it would be 11k tokens teaching a blind
  worker to click.
- **`--strict-mcp-config` + `--setting-sources ''`** drop the user's MCP servers and
  settings.

The last ~6k requires **replacing** the default system prompt, and that is NOT the default
here. The default prompt is what teaches the model to use tools well and follow CLAUDE.md; a
worker that saves 6k and gets subtly worse at its job is a loss that no token counter shows.
`systemPrompt` therefore ships as an **advanced, per-worker** field, and only becomes a
default if measured quality says so.

### 4.4 `observe` mode

Native tools:

```
--allowedTools "Read,Grep,Glob,WebFetch,
                Bash(git log:*),Bash(git status:*),Bash(git diff:*),Bash(git show:*),
                Bash(gh pr list:*),Bash(gh pr view:*),Bash(gh run list:*)"
--disallowedTools "Edit,Write,NotebookEdit,Task"
```

`WebFetch` is included deliberately — it is what makes a "watch an external source" worker
work without handing it a write-capable shell.

**Capy verbs are allowlisted BY NAME, not by server.** This closes a real hole: Capy passes
`--allowedTools mcp__capy` alongside `--mcp-config` (T93, `mcp/config-file.ts`) so no verb
prompts on first call. That is correct for an interactive session. For a tick it would mean
an "observe" worker could call `create_session` and `submit_manifest` — i.e. spawn an
unrestricted agent that writes whatever it likes. The native allowlist does not cover the
MCP surface.

| allowed in `observe`                                                                                                | denied in `observe`                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory_read`, `memory_query`, `get_fleet`, `get_session`, `list_worktrees`, `create_card`, `update_card`, `notify` | `create_session`, `create_worktree`, `spawn_terminal`, `submit_manifest`, `adopt_folder`, `remove_folder`, `move_card`, `delete_card`, `message_session`, `memory_append`, `draw_canvas` |

`memory_append` is excluded on purpose: a sensor rewriting `hot.md` every 5 minutes destroys
the project's memory.

**This table is not user-editable, and that is deliberate.** The modes are a safety
contract, not a preference — `observe` means "this cannot start work". A 20-checkbox grid is
filled in wrongly exactly once, on a Sunday, and then the label means nothing and the red
warning on `act` is theater. The escape hatch already exists: a worker that needs
`create_worktree` is an `act` worker.

What IS configurable is the dimension that genuinely varies per project:
`extraReadCommands`, an **additive** field that accepts only read-only `Bash(...)` rules (a
repo on `jj` adding `Bash(jj status:*)`). It can never add a Capy verb or a write tool. It
widens what a worker can **see**, never what it can **do** — and per BUG-108 that is now
enforced on the invoked **verb** (`READ_COMMANDS`), not on the rule's punctuation. A rule
that does not name a read-only verb is rejected rather than narrowed.

Whether `observe` should grow is a question to answer with **evidence, not guesses**:
`permission_denials` (§5.1) records exactly which verb each worker wanted and was refused.
Move a verb into `observe` when the data says so.

### 4.5 `act` mode

`--permission-mode bypassPermissions`, full `mcp__capy`. It writes, commits, pushes, and can
dispatch.

**It does not pass through the Approval Inbox** — there is no operator in the loop, and the
Inbox sits on Capy's MCP/hook confirm path, which `bypassPermissions` bypasses by
definition.

**It does not keep the Sentinel, and the form no longer claims it does** (BUG-111). This
paragraph previously specified that it did; what shipped, and what is true after BUG-111,
is narrower.

`--setting-sources ''` drops the global `PreToolUse` hook that carries the Sentinel's
auto-deny (`hook-installer.ts` → `hook-bridge.ts` → `sentinel-core.ts`). Every tick now
injects Capy's hook blob via `--settings` (`hook-settings-blob.ts#injectHookSettings`, fed
from `hook-bridge.ts#hookSettingsBlobJson`), in **both** modes — `act` because nothing else
observes an unattended writer, `observe` because it had no second net either, and the blob
is loopback-only, observation-only and writes nothing to disk.

That blob carries `UserPromptSubmit` / `Stop` / `SessionStart` / `SessionEnd` /
`Notification` — **state observation only**. It deliberately omits `PreToolUse`, which is
the event the Sentinel resolver inspects, so a tick is now _visible_ to the Hook Bridge but
its shell commands are still _unscreened_. Reviving the Sentinel for a tick needs two things
this spec should not pretend are done:

1. a `PreToolUse` handler in the injected blob — a change to `hook-settings-blob.ts`, which
   is shared with every PTY spawn, so it cannot be added for ticks alone without a
   tick-scoped variant; and
2. the responder ramp being on. `sentinel-resolver.ts` abstains unless `rampActionFor`
   returns `park`, and the bridge never decides at all while the responder mode is `shadow`
   — which is the **default**. Even with (1), the guard would be conditional on operator
   configuration the `act` form does not mention.

Until both hold, `act` has no command screening, and the red warning says exactly that
rather than promising a net that is not there.

### 4.6 The four rules that stop this becoming a fire

- **No overlap.** If the previous tick is still alive when the next is due, **skip** and
  record `skipped`. Never queue — a 5-minute sensor that queues becomes an avalanche after
  one bad night.
- **Timeout kills.** `timeoutSeconds` (default 300), recorded as `timeout`. Without it a
  hung tick blocks the worker forever under the rule above.
- **Global ceiling of 2 concurrent ticks.** Each tick is a `claude` process worth hundreds
  of MB; six workers due in the same minute take the machine down. Whoever does not fit
  waits for the next beat.
- **3 consecutive failures → the worker disables itself and notifies.** Better dead and
  reported than 288 failures a day.

**Stop.** A running tick can be killed by hand, from the detail strip and from the row's
hover actions. The timeout already bounds every tick, but a worker four minutes into a bad
prompt is burning tokens for nothing and the operator should not have to wait it out. A
stopped run records as `stopped` — a fifth `Run.status` — and deliberately does **not** count
toward the three-strikes auto-disable: the operator intervening is not the worker
misbehaving.

`runOnBoot` fires staggered at Capy start, never all in the same second.

**Opt-in continuity.** `carryLastResult` prepends one line to the tick prompt:
`Last run (5 min ago): <result>`. It costs a few tokens and kills the most common duplicate
case without inventing a state file or a live session. Off by default.

## 5. The run record

### 5.1 What Capy keeps

Everything below comes from the process's own JSON — nothing is estimated.

```ts
interface Run {
  workerId: string
  startedAt: string
  endedAt: string
  durationMs: number
  status: 'ok' | 'error' | 'timeout' | 'skipped' | 'stopped'
  result: string // the tick's final text
  terminalReason: string // completed | max_turns | …
  numTurns: number
  costUsd: number // total_cost_usd
  tokens: { in: number; out: number; cacheRead: number; cacheWrite: number }
  denials: string[] // permission_denials
}
```

Stored at `<userData>/scheduler-runs/<workerId>.jsonl`, append-only, one line per run,
trimmed to the last 200. Appending beats rewriting a growing blob every 5 minutes, and
deleting a worker is deleting a file.

**`permission_denials` is a first-class signal, not a log line.** An `observe` worker that
hit the wall 12 times is telling you something: either the prompt asks for what it cannot
have, or the worker should be `act`. Surface it on the worker as "tried and couldn't: Edit
×9, Bash(git commit) ×3".

### 5.2 Debug transcripts

> **Superseded 2026-09-08 (BUG-115).** This section was never built. No
> transcript was ever written to `<userData>/scheduler-runs/<workerId>/` or
> anywhere else, and no retention ran. All `keepTranscript` actually did was
> switch the output format, which only broke the reader — so the toggle was
> removed and the field is dropped on load. A worker's run history today is the
> `Run` records in `scheduler-runs/<workerId>.jsonl` (result, terminal reason,
> denials, tokens, cost — 200 deep), readable per run in the Runs tab. Debug
> transcripts remain unbuilt; nothing below describes shipped behaviour.

`keepTranscript` switches the tick to `--output-format stream-json`; Capy saves the
turn-by-turn to `<userData>/scheduler-runs/<workerId>/<runId>.stream.jsonl`. Full record, in
Capy's own directory, still invisible to the watcher. Retention is short (last 5) — this is
a debugging tool, not history.

### 5.3 Who decides what is worth interrupting for: the worker

288 ticks/day cannot become 288 notifications, and the scheduler cannot judge what is
interesting — it does not know whether "no new PRs" is news.

But the tick **has Capy's MCP** (that is what `--mcp-config` preserved). So `notify` is
called **by the worker**, when its prompt or its skill concludes it found something. The
scheduler executes and records; the decision to interrupt the operator lives in the prompt,
which is exactly where the operator wanted all judgment to live.

The scheduler notifies on its own in exactly two cases, and both are about itself rather
than about the work: **the worker disabled itself** (3 failures, or the folder vanished).

### 5.4 What the operator sees

- **List:** state dot, "ran 3 min ago", today's cost.
- **Worker:** the last `result` in full, a run table (time · status · turns · cost ·
  duration), and the denials block.
- **Cost:** `total_cost_usd` summed per day per worker, shown plainly. A 5-minute worker is
  a financial decision and the screen should say so. `daily-budget` is the natural place to
  hang aggregate limits later.

## 6. The action arm

An `observe` worker that concludes action is needed **raises a card and stops**. The
operator reads it and dispatches through the normal door — manifest, drain, worktree, a
session with the approval machinery intact. The worker never triggers execution itself; it
converts an observation into a recorded intention.

This is what gives `observe` a high ceiling: it is not a mute sensor, it is a sensor that
can open a ticket.

**Duplicate suppression is the prompt's job, not the scheduler's** — consistent with the
dumb-scheduler principle. Two pieces make it tractable, neither of which puts judgment in
the engine:

- **The board is readable.** Cards are `.capy/memory/roadmap/*.md` inside the worker's
  folder, and `observe` has `Glob` and `Read`. A well-written skill checks before creating.
- **`carryLastResult`** (§4.6) kills the common case without any state file.

## 7. Testing

> **Superseded 2026-09-08.** The `tickArgv` matrix below still holds, minus the
> two dimensions that no longer exist: `provider` (BUG-114) and `keepTranscript`
> (BUG-115). `dueWorkers` is likewise not tested across "skipped workers" as a
> recorded outcome — a busy or over-ceiling worker is simply omitted from the due
> list and no `Run` is appended, so `RunStatus`'s `skipped` is a state nothing in
> `src/main` constructs. The guard for it is kept in `shouldNotifyRun` and
> `nextFailureState` because it is cheap and correct if such a record is ever
> written; it is not a row anyone can see today.

- `scheduler-core.ts` is pure and unit-tested exhaustively (ADR-0001): `dueWorkers` across
  clock edges and disabled/skipped workers, `nextRunAt`, and `tickArgv` for every
  combination of mode, model, effort, provider, `extraReadCommands`, `systemPrompt`,
  `keepTranscript`. The permission tables in §4.4 become argv assertions — the security
  contract is a test, not a comment.
- `scheduler-shell.ts` is env-bound (spawn, fs, notify) ⇒ e2e-only, in `coverage.exclude`.
- E2E: a worker with a trivial prompt fires, produces a run record, and — the load-bearing
  assertion — **creates no entry in `~/.claude/projects/`** and no row in `get_fleet`.
- E2E: an `observe` worker's `create_session` attempt is refused and lands in `denials`.

## 8. Known limitations — stated, not hidden

- **Capy closed means nothing runs.** A consequence of the local substrate (§2.3). A cloud
  routine would survive but cannot reach the local repo.
- **The user's hooks do not run.** `--setting-sources ''` drops `settings.json`, so any user
  hooks are absent from a tick. This is the price of being born lean, and it is the right
  trade (an interactive hook in a terminal-less process is unpredictable) — but it is a real
  behavioral difference between "run this in a session" and "run this in a worker". Capy's
  own hook blob (§4.5) is the one exception, and it is injected in both modes.
- **No mode screens the commands a tick runs.** The injected blob observes state; it carries
  no `PreToolUse`, so the Sentinel never sees a tick's shell calls. `act` therefore runs
  unattended with no command-level net, which is what the `act` warning now says (BUG-111).
  §4.5 records the two things that would have to change to revive it.
- **`extraReadCommands` validates the invoked verb, not the rule's shape** (BUG-108). It
  previously accepted anything matching `Bash(...)`, so a writing command widened an
  `observe` allowlist. It is now checked against `READ_COMMANDS` in `scheduler-core.ts`:
  chained, substituted and redirecting commands are refused outright, and a verb whose
  subcommands are not all read-only (`git`, `gh`, `jj`) is only accepted with its
  subcommand. Three checks have to agree, because each closes a way around the other two:
  the verb is allowlisted, no token carries a writing flag in ANY shell form (`-o file`,
  `-ofile`, `-lo`), and a `:*` wildcard is refused for a verb whose arguments could write
  (`PREFIX_UNSAFE_COMMANDS`) — the wildcard authorizes arguments the validator never sees,
  which briefly made it weaker than the explicit form it is supposed to generalize. The cost is that the `Bash(npm run lint:*)` example above no longer passes —
  `npm run <script>` executes whatever `package.json` says, which is precisely the class the
  field promises it cannot add. A refused rule is surfaced in the worker's Runs tab
  alongside its permission denials, never silently dropped.
- **`act` does not pass through the Approval Inbox** (§4.5).
- **No cross-tick memory by construction** (§2.1); §4.6 and §6 are the mitigations.
- **`--strict-mcp-config` is a deliberate departure.** `mcp/config-file.ts` documents as an
  invariant that Capy NEVER emits that flag, because injecting Capy's server into an
  interactive session must be additive and must not swallow the user's `.mcp.json`. For a
  tick the reasoning inverts: there is no user, and silence is the feature. The scheduler
  therefore **builds its own argv** and does not reuse `appManagedMcpArgs`. Record this next
  to that invariant so it is not read as a violation.
- **Writing this spec tripped the Sentinel.** The first attempt to write the file was
  auto-denied because §4.5 quoted the Sentinel's own catastrophe patterns verbatim, and the
  classifier matched the prose. The patterns are now described in words rather than quoted.
  This is a live instance of a known review lesson (a guard invalidating its own worked
  example) and belongs in whatever follow-up tunes `sentinel-core.ts` — the classifier reads
  a shell command string with no notion of "this is documentation".

## 9. Repo contracts this change must satisfy

Listed here so the implementation plan budgets for them rather than discovering them in CI.

- **CHANGELOG.md** — mandatory, dated entry, one user-facing bullet per change.
- **`docs/user/`** — mandatory. This adds a new top-level component (the Scheduler takeover)
  and new top-level `src/main/` files, which is the gate's definition of user-visible. The
  `user-docs-gate.mjs` check fails otherwise.
- **`docs/capy-features.md`** — **not** required as specced. The scheduler adds no MCP verb
  and changes no ACK shape or grant semantics; it is a UI capability the session cannot call.
  It becomes agent-facing only if a later unit exposes a verb (e.g. an agent creating a
  worker), and then the marker must be bumped.
- **i18n** — every new key lands in BOTH `en.json` and `pt-BR.json` in the same change, or
  `vue-tsc` breaks on the schema.
- **`design.md`** — the Scheduler takeover, the worker row, the run table, the footer pill and
  the `act` mode warning are new §6 entities. Update `design.md` FIRST, then implement; no raw
  colors or off-system sizes.
- **Four new tokens, already declared in `design.md` by the mockup change.** Writing the
  Badges table in tokens was impossible because `--warning-soft` did not exist: the accent
  triple (`soft`/`line`/base) sets the grammar, and green, red and warning were each half
  built. `design.md` §2/§9 now declares `--green-line`, `--red-line`, `--warning-soft` and
  `--warning-line`, and the Badges table gains the **Danger** row it was missing. **The
  implementation must add all four to every one of the 13 theme blocks in `themes.css`**,
  each derived from that theme's own base hue — never copied from the Ink values.
  Out of scope, recorded as a follow-up: `usage-dashboard-format.ts` still hardcodes the
  pre-Ink emerald and amber as RGB triples.
- **Client confidentiality** — the worked examples here use neutral vocabulary already; keep
  it that way, `tests/no-client-identifiers.test.ts` greps the tracked tree.

The scope is large enough that the implementation plan should decompose it into units (core,
persistence + IPC, the takeover, the combobox, the action arm) rather than one PR.

## 10. Open questions

**Settled 2026-09-07:** the entity is a **Worker** and the surface the **Scheduler**; the
entry point is a **footer pill**; a running tick **can be stopped by hand** (§4.6).

- **Global ceiling of 2** is a judgment call, not a measurement. Revisit against
  `SystemMonitor` data once real workers exist.
- **Does `observe` need to grow?** Answer from `permission_denials` after real usage (§4.4),
  never from a checkbox grid.
