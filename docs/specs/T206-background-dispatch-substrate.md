# T206 — A `bg` dispatch substrate on `claude --bg`, so dispatched cards commit their own work

**Date:** 2026-08-05 · **Status:** specified (not implemented) · **Card:** `.capy/memory/roadmap/T206-add-a-background-dispatch-substrate-on-top-of-claude-bg-so.md`
**Depends on:** T200 (CLI version detection) · T205 (`claude agents --json` reconciliation) · **Sibling:** T207 (`WorktreeCreate` hook)

> **`--bg` EXISTS on the installed CLI (2.1.222)** — verbatim in §2. The card is buildable. Two things it assumes are **not** on that surface: `--exec` and a `--bg`-compatible `--max-budget-usd` (§2.2).

## 1. Goal, and the wound it closes

Capy's memory records the **session commit gap**: an MCP-dispatched session reports done with green gates and _no commit_, so the operator must `git rev-list` the branch and commit on its behalf. Today's machinery can't close that itself — Capy spawns a PTY, hands it a boot prompt, and its only completion evidence is a git probe the operator runs afterwards (`probeMergeEvidence`, `roadmap-ipc.ts:167-203`).

CC ≥ 2.1.198/2.1.221 closes it upstream: a background agent finishing worktree work commits, pushes, opens a draft PR when warranted, follows `CLAUDE.md` git instructions, and reports where the work lives. This card makes that a **dispatch substrate** (`substrate: bg`), so Capy is the cockpit for a machine the CLI already operates. **Non-goal:** replacing `worktree`. `bg` is a fifth, additive value; older CLIs keep today's four (§5.6).

## 2. What the installed CLI actually offers

### 2.1 Verbatim (`claude --version` → `2.1.222 (Claude Code)`; `claude --help`)

```
  --bg, --background                    Start the session as a background agent
                                        and return immediately (manage with
                                        `claude agents`)
  -n, --name <name>                     Set a display name for this session
  -w, --worktree [name]                 Create a new git worktree for this session
  --permission-mode <mode>              (choices: "acceptEdits", "auto",
                                        "bypassPermissions", "manual", "dontAsk", "plan")
Commands:
  agents [options]                      Manage background agents
```

`claude agents --help` confirms T205's input: `--json` ("Print active sessions (interactive and background) as a JSON array and exit … does not require a TTY"), `--all`, `--cwd <path>` ("Show only background sessions started under `<path>`"). `claude` takes a positional `prompt`, and `--bg` is rejected only with `-p/--print` (CC v2.1.198) — so `claude --bg --name <slug> "<boot prompt>"` is the launch shape (verify: §5.7 V1).

### 2.2 What the card assumes but the installed help does NOT show

- **`--exec` does not exist** on 2.1.222 (no match in `--help`). Use the positional prompt.
- **`--max-budget-usd` is documented "only works with `--print`"**, and `--bg` rejects `-p`. The card's "budget halts background agents (v2.1.217)" lever is **not reachable from this launch shape** — see Q3, not a shipped guard.
- **No `--base-ref` / `--bg-isolation` flags.** `worktree.bgIsolation` / `worktree.baseRef` are `settings.json` keys, reached through the `--settings` blob Capy already injects (`injectHookSettings`, `pty.ts:706-709`).
- `claude attach` (CC v2.1.216) is **not** a listed subcommand on 2.1.222; attaching goes through `claude agents`' interactive view.

## 3. Current dispatch machinery, verified

| Concern                                                                                       | file:line                                                |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Canonical enum `['session','worktree','teammate','internal']`                                 | `src/main/roadmap-core.ts:116-117`                       |
| `isCardSubstrate` / `resolveCardSubstrate` (default `session`)                                | `roadmap-core.ts:120-132`                                |
| Lenient frontmatter read (unknown → `undefined`)                                              | `roadmap-core.ts:455-456`                                |
| Renderer mirror + `planCardDispatch` (`same-folder`/`worktree`/`skip-internal`)               | `stores/dispatch-substrate.ts:15-30, 63-85`              |
| Board dispatch: worktree cut → spawn → bind                                                   | `components/RoadmapBoard.vue:606-670`                    |
| Headless drain: substrate branch                                                              | `src/main/manifest-drain.ts:197, 240, 283`               |
| Drain deps (`createWorktree`/`spawnSession`/`bindSession`/`resolveBranch`/`rollbackWorktree`) | `src/main/manifest-drain-shell.ts:95-170`                |
| MCP surface (`update_card`, `submit_manifest`)                                                | `src/main/mcp/tool-catalog.ts:631-633, 766-769`          |
| Operator override at Allow                                                                    | `roadmap-ipc.ts:1526-1541`, `RoadmapBoard.vue:1467-1474` |
| i18n labels                                                                                   | `i18n/en.json:1600-1605` (+ `pt-BR.json` parity)         |

**Where it LOCKS.** `planCardSet` refuses a `substrate` write once a session is bound — `roadmap-core.ts:851-853` (`SUBSTRATE_LOCKED`) — because `bindSessionCore` writes `session` + `status: in-progress` + resolved `substrate` + `executedIn` in ONE frontmatter write (`roadmap-ipc.ts:1217-1245`). A new value inherits the lock for free.

**What a dispatch spawns today.** `spawnAndBind` (`RoadmapBoard.vue:606`) → optional `window.api.worktreeCreate({repoPath, branch, optOutInherit:false})` → `sessions.dispatchCardSession` (`stores/sessions.ts:2524-2570`), a **synthetic PTY-hosted** session (`synthetic-<uuid>`, boot prompt as `bootOverride.prePrompt`) → `roadmap.bindSession`. PTY kinds are `'shell' | 'claude-new' | 'claude-resume' | 'claude-fork' | 'teammate'` (`pty.ts:166`); argv at `pty.ts:626-710`.

**Agent-controlled spawns may override only `{model, effort}`** — `ALLOWED_KEYS`, `src/main/mcp/agent-boot.ts:43`, enforced by `sanitizeAgentBootOverride` (throws on any other key), backstopped by `forceDowngradePermission` on the resolved config (`pty.ts:690-697`). Actual model/effort come from the operator-owned routing table (`routing-policy.ts:44-53, 66-80`). `downgradeArgvPermission` (`pty.ts:438-456`) drops `--dangerously-skip-permissions` and rewrites `bypassPermissions` → `manual`; it is wired **only** to `kind === 'teammate'` (`pty.ts:722`).

**The Capy worktree layout.** `worktreesRoot(root)` = `<repo>/.claude/worktrees` (`worktree-core.ts:47-49`). `canonicalWorktreeParentRepo` (`:58-79`) recognizes **only** a direct child of that dir, else `null`; `decideWorktreeInheritance` (`:81-95`) is the AND that grants agent control. **A worktree cut anywhere else is fail-closed: no inherited grant.** This decides §4.

**Evidence today.** `evidence` is CONTROLLED (`roadmap-core.ts:790-798`); `update_card` refuses it (`planCardSet` → `CONTROLLED_FIELD`, `:847-848`), documented to agents at `tool-catalog.ts:653`. The **only** writer is the human IPC `roadmap:moveToReview` (`roadmap-ipc.ts:820-855`), which merges caller refs with the card's list and writes `status: review` + `evidence` together. Refs come from `probeMergeEvidence` (`:167-203`): `origin/main..<branch>`, count + ≤5 short hashes. PR URLs are reachable in main via `gh pr list --json` (`pr-stack.ts:73-85`), unused by the board today.

## 4. The worktree-ownership decision

The hazard: **two competing worktree owners.** CC's `--bg` isolates itself (`worktree.bgIsolation`/`baseRef`, hardened v2.1.216/222); Capy also cuts worktrees, with WORKTREE.md provisioning, adoption, rollback and sidebar lineage.

| Option                                                                                                                      | Shape                                | Verdict                              |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------ |
| **A** — native CC worktree (`--bg -w card/<slug>`, Capy observes)                                                           | CC picks path + base ref             | **Rejected**                         |
| **B** — Capy worktree passed in (`create_worktree`, then `--bg` with `cwd` = that worktree, `worktree.bgIsolation: "none"`) | One owner, existing machinery reused | **PICKED**                           |
| **C** — `WorktreeCreate` HTTP hook (T207)                                                                                   | Unifies both worlds                  | **Deferred**, the intended end state |

**Why B.** Nothing structural changes: `manifest-drain-shell.ts:95-123` already cuts `card/<slug>` and echoes the `adopted` payload; `rollbackWorktree` already un-cuts on spawn failure (`manifest-drain.ts:259`); `resolveBranch` already stamps `executedIn` from the spawn folder (`manifest-drain-shell.ts:165`). `bg` reuses all of it and replaces only the _spawn_ step. One owner, zero new lifecycle.

**Breaks under A.** The CC worktree lands outside `<repo>/.claude/worktrees/`, so `canonicalWorktreeParentRepo` → `null` → `decideWorktreeInheritance` false → the bg session is born **without** the parent repo's agent-control grant, silently, with no error anywhere. Capy also loses WORKTREE.md provisioning (recorded lesson: a bare checkout has no `node_modules`, so the gates the card demands cannot run), rollback-on-failure, and the `executedIn` stamp (T190) Review reads. Capy would have to discover and adopt the path after the fact — a second reconciler, exactly what the card forbids.

**Breaks under C.** Nothing conceptually — it is strictly better — but it needs T207's hook contract captured and shipped first, and T207 is itself `complex`. Blocking on it keeps the commit gap open across two workstreams. **B is forward-compatible:** when T207 lands, the hook becomes the mechanism by which Capy hands CC the same `.claude/worktrees/<slug>` path B passes explicitly; `bg` inherits it with no card-facing change.

**The B risk, stated plainly.** CC's auto-commit/push/draft-PR (v2.1.198/221) is described as applying to an agent "finishing **worktree** work". If it is conditioned on CC having _cut_ the worktree rather than on the cwd _being_ a non-main worktree, B yields a background session that still doesn't commit — the wound stays open. That is **V2** (§5.7); it gates the whole card. If V2 fails, the fallback is **C**, never A.

## 5. Decision

**5.1 Enum.** Add `'bg'` to `CARD_SUBSTRATES` (`roadmap-core.ts:116`) and its renderer mirror. `planCardDispatch` gains `| { kind: 'bg'; substrate: 'bg'; repoPath: string; branch: string }`, resolved exactly like `worktree` (same `worktreeDispatchBranch(slug)` → `card/<slug>`). The lock, the operator override, and the MCP `z.enum(CARD_SUBSTRATES)` surfaces pick it up automatically. i18n: `roadmap.substrate.bg` = "Background (self-committing)" in **both** locale files.

**5.2 Flag assembly — a new main-process spawner, NOT a `PtyKind`.** `claude --bg` returns immediately; hosting it as a sixth `PtyKind` produces a PTY that exits in <1s, which Capy's exit handling reads as a completed/failed session (the BUG-70 class of bug). So: **new module `src/main/bg-dispatch.ts`**, an `execFile` spawn — no PTY, no `liveTerminals` entry. Argv, built through the same `buildClaudeArgs` path so Claude Boot options still apply:

```
claude --bg --name <card-slug> --model <routed> --effort <routed>
       --permission-mode <resolved, 5.3>
       --settings <hook blob ⊕ {"worktree":{"bgIsolation":"none"}}>
       [--mcp-config …]        # withheld when agentControlled (pty.ts:698-701 posture)
       "<boot prompt>"         # positional; never -p (rejected with --bg)
```

run with `cwd` = the Capy worktree from §4/B. No denylist change needed (`DENY_BOOL`/`DENY_VALUE`, `claude-args.ts:135-152`, lack `--bg`); `name` is already a `ClaudeBootConfig` field emitted at `claude-args.ts:376`, so `--name <slug>` is wiring, not a new flag — and it doubles as the §5.4 correlation key.

**5.3 Permission posture — operator-owned, never agent-influenced.** A `bg` session is unattended by construction: there is no terminal for a prompt to appear in, so the existing rules are wrong in both directions — `downgradeArgvPermission`'s `bypassPermissions → manual` rewrite would leave it blocked forever on its first gated tool, indistinguishable from a stall.

1. **Default `--permission-mode acceptEdits`.** Edits land; `Bash` still gates. A blocked session is visible as `waitingFor` via T205 instead of silently idle.
2. **`bypassPermissions` only from an explicit per-folder operator toggle** in the folder's Startup dialog ("Background dispatch may skip permissions"), default OFF. Never reachable from `submit_manifest`, `create_session`, or any `bootOverride`: `agent-boot.ts`'s `ALLOWED_KEYS` stays exactly `{model, effort}`, and `forceDowngradePermission` still runs on the resolved config for agent-controlled bg dispatches.
3. The toggle's disclosure must state that CC persists the bypass across retire→wake (v2.1.143) — one human decision with an unbounded lifetime. Hence per-folder and off by default.

**5.4 Fleet visibility — consume T205, do not build a second reader.** T206 ships **zero** `claude agents` calls. Interface needed from T205, to be stated in T205's spec:

```ts
export interface BgAgentRow {
  id: string
  name?: string
  cwd?: string
  state: string
  waitingFor?: string
}
export function listAgents(opts?: { cwd?: string; all?: boolean }): Promise<BgAgentRow[]>
export function onAgentsReconciled(cb: (rows: BgAgentRow[]) => void): () => void
```

- **R1 — `name` preserved.** It is how a launch correlates to a card without a PTY handshake.
- **R2 — `cwd` filter** (`--cwd <spawnFolder>`), so two cards dispatched in the same second can't cross-bind.
- **R3 — a terminal-state edge**: a consumer must be able to detect a row leaving the active set / reaching a terminal `state`. That triggers §5.5. Polling from T206 is out.

Binding: after `execFile` returns, correlate on `(name === slug && cwd === spawnFolder)` inside a bounded window (reuse the `agent-correlation-window` shape), then call `bindSessionCore(folder, slug, agentId, 'dispatched-with: model·effort', 'bg', executedIn)` — the same door §3 describes. A correlation timeout rolls back the worktree and reports a NAMED failure through the drain's existing `failedCards` channel (`manifest-drain.ts:57-62`), never a silent null.

**5.5 Evidence write-back.** On R3's terminal edge, against the card's `executedIn` branch in the spawn folder: (1) `probeMergeEvidence(spawnFolder, executedIn)` → `{ahead, refs}`; (2) `gh pr list --state all --head <branch> --json number,url,isDraft` via the guarded runner `pr-stack.ts:73` already uses — absent `gh` degrades to no PR ref, never an error; (3) `attachEvidenceCore(folder, slug, refs)`, a new export **extracted verbatim** from `roadmap:moveToReview`'s merge+write (`roadmap-ipc.ts:840-852`) minus the status write.

_Who may write `evidence`:_ the field stays CONTROLLED and every MCP verb keeps refusing it. `attachEvidenceCore` is a **Capy-owned main-process writer**, same class as `bindSessionCore` — reached only from a terminal edge Capy itself observed, never from agent input. Entries are `<short-sha>` refs plus `pr:<url>`. **Status is NOT moved:** the card stays `in-progress` with fresh evidence; the operator still makes the Review move (golden rule, `roadmap-core.ts:1436`). The point is that Review now has something to read.

**5.6 Version gate.** Gated on T200's detected version. Below the floor (`2.1.198` — the release where background agents commit/push/open PRs, the CC-side reason this substrate exists) `bg` is not offered: the picker omits it, and `planCardDispatch` degrades an on-disk `bg` to the `worktree` branch with the disclosure saying so in one line. Never a silent substitution.

**5.7 Verification, before implementation.**

- **V1** — `claude --bg --name t206-probe "echo hi"` in a scratch repo: positional prompt accepted, exit 0, row present in `claude agents --json --all` with that `name`? Record the exact JSON shape — it is also T205's input contract.
- **V2 (gating, §4)** — in a **Capy-cut** `.claude/worktrees/<slug>` worktree with `bgIsolation: "none"`, does a `--bg` session that edits a file commit/push/open a draft PR on its own? If no → fall back to C (T207); do not implement B.
- **V3** — does `--settings` composition survive `--bg` (Capy's hook blob still POSTs to the Hook Bridge)? If not, `bg` fleet state rests entirely on T205.

**5.8 Open questions (flagged, not silently deferred).**

- **Q1** — Does a bg session's `.jsonl` land under `~/.claude/projects/<slug>/`, giving a sidebar row from the existing chokidar watcher for free? If not, the fleet row is T205-only and the sidebar needs an explicit `bg` source.
- **Q2** — Can the operator _attach_ from Capy? `claude attach` is absent on 2.1.222; fallback is a session-menu item that opens `claude agents` in a PTY.
- **Q3** — Cost containment. No argv budget cap exists for `bg` (§2.2). Until CC exposes one, the ceiling is the existing WIP cap (`WIP_LIMIT = 5`, `roadmap-core.ts:553`) plus the grant budget the dispatch already reserves.

## 6. Acceptance

1. `bg` is a fifth `CARD_SUBSTRATES` value — resolved at dispatch, locked once a session binds, overridable by the operator at Allow — through the existing machinery, no parallel path.
2. Dispatch launches `claude --bg --name <slug>` with the **routed** model/effort inside a **Capy-cut** `.claude/worktrees/card-<slug>` worktree, recording `dispatched-with: model·effort` + `executedIn` exactly as the other substrates do.
3. The session appears in the fleet with real state from T205's `listAgents`; T206 makes zero `claude agents` calls.
4. Branch, commit refs and (when present) the draft-PR URL are written to `evidence` by a Capy-owned main writer; `evidence` remains refused by every MCP verb.
5. A CLI below the floor never dispatches `bg` silently — it degrades to `worktree` and says so.
6. A failed spawn or correlation timeout rolls back the worktree and surfaces a named reason.

## 7. Test plan

| Test                          | File                                                                                              | Asserts                                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Enum + lenient read + default | `tests/roadmap-core.test.ts`                                                                      | `isCardSubstrate('bg')`; `resolveCardSubstrate({})==='session'`; unknown still → `undefined`                                      |
| Lock survives                 | `tests/roadmap-core.test.ts`                                                                      | `planCardSet({set:{substrate:'bg'},hasSession:true})` → `SUBSTRATE_LOCKED`                                                        |
| Fourth dispatch branch        | `tests/dispatch-substrate.test.ts`                                                                | `bg` → `{kind:'bg',repoPath,branch:'card/<slug>'}`; override precedence unchanged for the other four                              |
| Version-gate degrade          | `tests/dispatch-substrate.test.ts`                                                                | below the floor, `bg` resolves to the `worktree` branch carrying a `degraded` marker                                              |
| Drain cut + rollback          | `tests/manifest-drain.test.ts`                                                                    | a `bg` card cuts a worktree; a failing `spawnSession` calls `rollbackWorktree` and lands in `failedCards` with the reason         |
| No agent escalation           | `tests/mcp-agent-boot.test.ts`                                                                    | `sanitizeAgentBootOverride({permissionMode:'bypassPermissions'})` throws; `forceDowngradePermission` still rewrites a leaked flag |
| Routing beats the hint        | `tests/routing-policy.test.ts`                                                                    | a `bg` dispatch resolves `{model,effort}` from the table, not the manifest suggestion                                             |
| Argv assembly                 | `tests/claude-args.test.ts`                                                                       | `--bg` survives `filterDenylistedArgs`; `--name` emitted from `cfg.name`; `-p` never co-emitted with `--bg`                       |
| Correlation window            | `tests/agent-correlation-window.test.ts`                                                          | `(name, cwd)` match binds; no match in-window → named timeout, no bind                                                            |
| Evidence writer               | new `tests/bg-evidence.test.ts`                                                                   | `attachEvidenceCore` merges/dedupes refs, adds `pr:<url>`, leaves `status` untouched; absent `gh` degrades                        |
| MCP surface                   | `tests/mcp-tool-catalog.test.ts`                                                                  | `update_card`/`submit_manifest` substrate enums include `bg`; `evidence` still refused                                            |
| i18n parity                   | `tests/ci-i18n-parity.test.ts`                                                                    | `roadmap.substrate.bg` in `en.json` **and** `pt-BR.json`                                                                          |
| Contract gates                | `tests/awareness-gate.test.ts`, `tests/ci-changelog-gate.test.ts`, `tests/user-docs-gate.test.ts` | the diff satisfies all three (§8)                                                                                                 |

## 8. Contracts touched

| Contract                      | Touched?             | Why                                                                                                                                                                                                          |
| ----------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CHANGELOG.md`                | **YES**              | User-visible new dispatch mode — one `### Added` bullet under today's date.                                                                                                                                  |
| `docs/capy-features.md`       | **YES**              | A new substrate is agent-facing: `submit_manifest`/`update_card` accept it and the agent must know what it means. Exact edit in §8.1.                                                                        |
| `docs/user/`                  | **YES**              | `roadmap-board.md` (substrate list) + `agent-control.md` (permission posture, who may skip permissions). A new top-level `src/main/bg-dispatch.ts` also trips `scripts/ci/user-docs-gate.mjs` independently. |
| `design.md`                   | **YES**              | §6 — the substrate picker gains a fifth option and the card face a `bg` chip. Edit `design.md` first, per the contract.                                                                                      |
| i18n `en.json` + `pt-BR.json` | **YES**              | `roadmap.substrate.bg` in both files, same change (schema parity).                                                                                                                                           |
| ADR                           | **NO**               | §4 is a substrate choice inside an existing pattern, not a new architectural pattern. If V2 fails and the design pivots to the hook, T207 carries the ADR.                                                   |
| English-only                  | **YES (compliance)** | Spec, code, comments and CHANGELOG entry in English; the only non-English text is `pt-BR.json`.                                                                                                              |

**8.1 The exact `docs/capy-features.md` edit.** Bump the marker on line 1: `<!-- capy-features v34 (2026-07-31) -->` → `<!-- capy-features v35 (2026-08-05) -->`. In the **"Dispatch substrate — WHERE a card actually runs."** paragraph (lines 408-419), extend the enumeration `one of session/worktree/teammate/internal` to include `bg`, and insert after the `internal` clause:

> `bg` cuts the same fresh worktree as `worktree` but launches a **native background agent** (`claude --bg`) inside it instead of a terminal session: it runs unattended, and when it finishes it commits, pushes and opens a draft PR itself, after which Capy writes the branch, commit refs and PR URL onto the card as `evidence`. So for a `bg` card, do NOT expect a terminal you can watch, and do NOT plan to commit the work yourself — read the card's evidence instead. `bg` is only available when the installed CLI supports it; on an older CLI it resolves as `worktree` and the dispatch disclosure says so.

Nothing else changes: the lock sentence, the "strong hint, operator can override" posture, and the `evidence`-is-controlled sentence (line 316) all stay true verbatim.

## 9. Definition of done

- [ ] V1–V3 (§5.7) run and recorded here; **V2 green**, or the card re-planned onto T207.
- [ ] `'bg'` in `CARD_SUBSTRATES` + renderer mirror; `planCardDispatch` fourth branch.
- [ ] `src/main/bg-dispatch.ts`: `execFile` launch, `--settings` composition, correlation, rollback.
- [ ] Board and drain both route `bg` through the shared cut → spawn → bind path (no second path).
- [ ] `attachEvidenceCore` extracted from `roadmap:moveToReview`; evidence written on the terminal edge.
- [ ] Consumes T205's `listAgents`/`onAgentsReconciled`; zero direct `claude agents` calls in T206.
- [ ] Permission posture: `acceptEdits` default; `bypassPermissions` only via the per-folder operator toggle; `agent-boot.ts` `ALLOWED_KEYS` unchanged.
- [ ] Version gate wired to T200; degrade path visible in the disclosure.
- [ ] Every §7 test green; `npm run typecheck` and `npm run build` pass.
- [ ] `design.md` §6, `CHANGELOG.md`, `docs/user/roadmap-board.md` + `agent-control.md`, `docs/capy-features.md` (+ marker → v35), `en.json` + `pt-BR.json` — all in the same change.

## PRD gap

This is a `complex`-tier card, so the requirement matrix also asks for a PRD. This spec is deliberately a **mechanism** document; a PRD must cover what it does not:

- **Operator experience of an unwatchable session.** `bg` breaks Capy's core promise that every dispatch is a terminal you can open. What the sidebar row looks like, what clicking it does, and what the recovery gesture is when a bg agent goes wrong (Q2 is the mechanism; the product answer is a PRD call).
- **Trust rollout.** Default-off, per-folder opt-in, or the recommended substrate for `feature` cards — and what evidence would justify moving it.
- **A success metric for the commit gap.** e.g. % of `bg`-dispatched cards reaching Review with ≥1 commit ref in `evidence` over N dispatches, versus today's baseline.
- **Cost and blast radius.** Unattended agents with `acceptEdits` and no argv budget cap (Q3): what spend and concurrency are acceptable, and who is accountable when one runs long.
- **Interaction with the human review loop.** If bg agents open draft PRs, does the PR Stack become the primary review surface instead of the board's Review column? A workflow decision this spec deliberately leaves alone.
