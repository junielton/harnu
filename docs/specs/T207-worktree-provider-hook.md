# T207 — Capy as the worktree provider for `claude -w`, via the `WorktreeCreate` HTTP hook

**Date:** 2026-08-05 · **Status:** specified (not implemented) · **Card:** `.capy/memory/roadmap/T207-become-the-worktree-provider-for-claude-w-via-the.md`
**Depends on:** T200 (per the card) · **Prior art, not contradicted:** [T191](./T191-worktree-lineage-sidebar.md) (`bornFrom` lineage), [2026-07-19 watcher cross-slug move](./2026-07-19-watcher-cross-slug-move.md) (the re-homing this card supersedes as the _primary_ path but must not break)

CLI facts below were verified against the **installed binary, `claude 2.1.222`** (`~/.local/share/claude/versions/2.1.222`), not against the changelog prose.

## 1. Goal

One worktree system instead of two. When a session cuts a worktree natively (`claude -w`, `EnterWorktree`, `/fork`, agent isolation), Capy provisions it — manifest seed/setup with the login-shell environment, `bornFrom` lineage, sidebar row — and hands the path back, instead of discovering the checkout afterwards and inheriting a bare one.

## 2. Current behaviour, verified

**Capy's own provisioning.** `createWorktree` (`src/main/worktree-ipc.ts:1185-1402`) is the whole pipeline: `validateWorktreeRequest` argv gate → `resolveWorktreePlan` (manifest read at the git-resolved repo root, `:333-350` / `:746`) → base resolution with a network fetch → `git worktree add` → `applySeedPlan` → `setup` commands via `runManifestCommand` (`:486-518`, `sh -c` with `spawnEnv()`'s login PATH, BUG-27) → `adoptFolder` (`:211-246`, writes `projects.json`, resolves `bornFrom`, emits `folders:adopted`). Failure is transactional: `rollbackWorktree` (`:605-639`) removes the checkout _and_ the branch, then `buildProvisionError` (`:668-690`) raises a `WorktreeProvisionError` (`src/main/worktree-manifest.ts:810-837`) carrying `stage` / `step` / `command` / `kind` / `binary` / `path` / `exitCode` / `stderr` / `rolledBack` / `branchDeleted`. Budgets: `SETUP_TIMEOUT_MS = 10 min`, `SETUP_MAX_BUFFER = 64 MiB` (`worktree-ipc.ts:123-124`).

**Canonical layout.** `worktreesRoot()` = `<repo>/.claude/worktrees` (`worktree-core.ts:47-49`); `canonicalWorktreeParentRepo()` parses a path back to its repo root only for a _direct child_ of that dir (`:66-78`). **That is also Claude Code's own managed location** — the binary refuses `EnterWorktree` switching to anything outside `.claude/worktrees/` of the repo ("Switching from this session is limited to worktrees managed by Claude Code"). The two systems already agree on the directory; they disagree on who fills it.

**What Capy does today when the CLI makes a worktree: it reacts.** Claude Code re-homes the live transcript to a new slug dir; `claude-watcher.ts` correlates the `unlink`/`add` pair by session id (`:230`, `:532`, `:863`) and `reHomeSessionAcrossFolders` (`src/renderer/src/stores/sessions.ts:4078-4108`) moves the row, add-authoritative and order-independent. The worktree itself is whatever the CLI made: no manifest, no `node_modules`, no `.env`, no `bornFrom`, and it only reaches `projects.json` if a human pins it.

**The CLI side (verified).** `WorktreeCreate` hook input is the base hook payload (`session_id`, `transcript_path`, `cwd`, `prompt_id`, `permission_mode`, `agent_id`, `agent_type`, `effort`) plus `hook_event_name: "WorktreeCreate"` and **`name`** — the binary's own doc string reads _"Input to command is JSON with name (suggested worktree slug). Stdout should contain the absolute path to the created worktree directory."_ `WorktreeRemove` input carries `worktree_path`.

**The load-bearing CLI fact the card does not state.** When any `WorktreeCreate` hook is configured, the CLI takes the hook branch **exclusively** and rethrows on failure — there is no fallback to native `git worktree add`:

```js
if (hasWorktreeCreateHook()) {
  let l = await executeWorktreeCreateHook(name).catch((c) => { /* telemetry only */ throw c })
  … dot-segment + symlink-ancestry screen … ; s = { …, hookBased: true }
} else { /* native git worktree creation */ }
```

Post-checks the returned path must survive: it must already **exist as a directory** ("the hook must create the directory before echoing its path"), be absolute, contain no `.`/`..` segments, and have no symlinked component below the checkout root.

## 3. Can the hook bridge answer with a body?

**Yes — the transport already returns JSON bodies, and it is not fire-and-forget.** `startHookServer`'s `respond(code, body)` writes `content-type: application/json` plus an arbitrary string (`src/main/hook-bridge.ts:122-125`), and the active responder path already exercises it: `return respond(200, serializeDecision(event, decision))` (`:216`). `serializeDecision` (`src/main/responder-dispatch.ts:194-228`) emits exactly the `hookSpecificOutput` envelope shape this card needs. The CLI's HTTP branch parses that body and, for `WorktreeCreate`, reads `hookSpecificOutput.worktreePath` when `hookSpecificOutput.hookEventName === "WorktreeCreate"`, else treats the hook as having returned nothing.

So the transport is **not** the work of this card. Three real constraints are:

1. **`WorktreeCreate` is not dispatchable.** `isDispatchable` (`responder-dispatch.ts:107-112`) covers only `PreToolUse` / `PermissionRequest` / `UserPromptSubmit` / `Notification:permission_prompt`. Every other event hits the fast path `return respond(200, '{}')` (`hook-bridge.ts:195-196`). **Subscribing `WorktreeCreate` with no other change actively breaks worktree creation** — the CLI reads `{}` as "hook succeeded but returned no worktree path" and, per §2, does not fall back.
2. **The deadlines are two orders of magnitude too small.** `RESPONDER_DEADLINE_MS = 3500` (`hook-bridge.ts:52`) and the installed handler's `timeout: 5` seconds (`hook-installer.ts:24`, `:83`) versus a 10-minute setup budget. The CLI reads `timeout` per handler in seconds (`g.timeout ? g.timeout*1000 : default`), so a dedicated long timeout is expressible — the bridge branch simply must not run under the responder's abort controller.
3. **A body-returning branch must bypass the FSM fold.** `handleBridgeEvent` folds every `(sessionId, event)` into the task-state machine and forwards it to the renderer (`hook-bridge.ts:439-478`). `WorktreeCreate` carries a `session_id` and would be folded as an unknown edge. It needs the same "route off before the fold" treatment `TEAM_HOOK_EVENTS` already gets (`:160-165`).

## 4. The base-reference decision

`worktree.baseRef` (`fresh` | `head`, default `fresh` since v2.1.133) is a setting on **the CLI's native creation path only** — the path §2 shows is bypassed entirely once a hook exists. The hook input carries no base, no branch, no ref: only `name` and `cwd`. There is therefore no double decision to reconcile at runtime — **Capy decides, always, and it is the only decider.**

That does not license ignoring the operator's expressed intent. Decision:

- Capy reads `worktree.baseRef` from the resolved Claude settings (`readClaudeSettings`, already imported by `hook-bridge.ts:15`) and maps it onto the existing pure planner (`planWorktreeBase`, `worktree-core.ts:232-242`): **`fresh` → `remote-default`** (`origin/<default>`, exactly Capy's current implicit behaviour), **`head` → `folder-head`** pinned to the `cwd` folder's tip.
- The manifest `from:` still wins over the setting, and an explicit `base` still wins over the manifest — precedence is unchanged (`resolveWorktreeBase`, `:176-185`). The setting only replaces what "implicit" means.
- `BAD_BASE` (`badExplicitBaseError`, `:461-463`) is unreachable on this path: the hook never receives an explicit base, so there is no caller-named ref to fail loudly on. The `remote-default` / `named` degrade warnings (`finalizeWorktreeBase`, `:374-432`) still apply and must be surfaced (§5).
- **What the other system must be told:** nothing at runtime. The CLI cannot be informed of the base and does not ask. The obligation is _documentation_ — `docs/user/settings.md` and `folders-and-worktrees.md` must state that with Capy provisioning, `worktree.baseRef` is honoured by Capy, and the resulting base is reported in the sidebar/toast, so an operator never has to reason about which of two systems won.

## 5. Decision

**D1 — Scope: per-session `--settings` blob only; never the global `~/.claude/settings.json`.** `buildHookSettingsBlobJson` (`src/main/hook-settings-blob.ts`, injected at spawn via `hookSettingsBlobJson()`, `hook-bridge.ts:366-369`) gains the two events; `EVENT_SPECS` in `hook-installer.ts:39-56` does **not**. Rationale: a global entry hijacks _every_ `claude -w` on the machine, including repos Capy has never seen, and — because §2 proves there is no CLI-side fallback — a `SIGKILL`ed Capy that outlives `removeOwnHooksSync` (`hook-installer.ts:330`) would break worktree creation CLI-wide until the next Capy boot prunes it. The blob is ephemeral, exists only for sessions Capy spawned, and Capy is alive by construction while those PTYs live (they are killed in `before-quit`).

**D2 — Handler shape.** A new third branch in `startHookServer`, beside the team branch, keyed on the event name and running before the FSM fold and before the responder dispatch. It calls a new module `src/main/worktree-provider-hook.ts` (thin shell) over a pure core `worktree-provider-core.ts` (ADR-0001), and answers:

```json
{ "hookSpecificOutput": { "hookEventName": "WorktreeCreate", "worktreePath": "/abs/path" } }
```

The handler maps `{ cwd, name }` → `createWorktree(cwd, branch, /* baseRef */ undefined, /* ref */ undefined, onProgress, { origin: cwd })`, where `branch` is `name` normalized through `slugifyBranch`/`validateWorktreeRequest`. Passing `origin: cwd` is what gives a CLI-cut worktree the same `bornFrom` lineage a `create_worktree` one gets (T191 §1's table gains a third caller; the recording guards are unchanged, so a create from a repo's main checkout stays motherless — no contradiction with T191). The handler's own `timeout` in the blob is **900 s**, and the branch must not be wrapped in the `RESPONDER_DEADLINE_MS` abort.

`name` is documented by the CLI as a _suggested_ slug, and its own validator (length cap; no `.`/`..` segments; no reserved git directory names; each `/`-separated segment non-empty and limited to letters, digits, dots, underscores, dashes) is **narrower than `SAFE_BRANCH`** (`worktree-core.ts:29`) in one direction and wider in another: the CLI permits `/` inside a name, and `slugifyBranch` collapses it to `-` (`:39-44`). So the returned basename will routinely differ from the suggested `name`. That is allowed — the CLI screens the returned _path_, not its basename (§5 open questions) — but it must be deliberate, and the branch Capy creates must be the un-slugified `name` so the branch the operator sees matches what they typed.

The end-to-end shape:

```
session: EnterWorktree / claude -w / /fork
  → CC POST /hook/<token>/WorktreeCreate/_   { session_id, cwd, name, … }
      → bridge: worktree branch (no FSM fold, no responder, no 3.5 s abort)
          → createWorktree(cwd, name, …, { origin: cwd })
              resolve manifest · base per §4 · git worktree add · seed · setup · adoptFolder
          → 200 { hookSpecificOutput: { hookEventName, worktreePath } }
  → CC: dot-segment + symlink-ancestry + is-a-directory screens → enters the worktree
  → CC re-homes the transcript → watcher/store re-home (2026-07-19) confirms the row
```

The last line is the point: the re-homing path is not replaced, it is _demoted_ to a confirmation. The sidebar row now exists before the transcript moves, because `adoptFolder` ran inside the hook.

**D3 — Failure ladder (the card's "must not leave the session without a worktree").** Because the CLI will not fall back, Capy must:

1. Full provision via `createWorktree`. Success → return the path.
2. On `WorktreeProvisionError` — which has already rolled back the checkout and branch — retry a **bare** `git worktree add` at the same target with the same resolved base, no seed, no setup. Success → return that path, and surface the structured failure (`stage`/`kind`/`binary`/`rolledBack`, reusing `provisionErrorPayload`'s field set) to the operator as a non-blocking notification, plus a `systemMessage` on the response. The session gets a usable checkout; the operator learns the manifest is broken.
3. Bare add also fails → respond `{}` with a `systemMessage`. The CLI then errors the worktree creation explicitly. This is the honest terminal state; there is no way to synthesize a worktree that does not exist, and `worktreePath` pointing at a non-existent directory is rejected by the CLI anyway.

`rolledBack: false` from step 1 means the checkout may still be on disk — step 2 must therefore probe the target and reuse it rather than blindly re-adding.

**D4 — `WorktreeRemove`.** Subscribed in the same blob. Without it the CLI removes the worktree itself (verified: _"No WorktreeRemove hook configured; falling back to git worktree remove for: …"_) — the directory goes, and Capy is left with a pinned `projects.json` entry pointing at nothing, i.e. exactly the ghost folder `remove_folder` exists to clean up by hand. Subscribing is what closes that.

The handler (a) runs `git worktree remove --force <worktree_path>` — if it does not, the CLI logs _"WorktreeRemove hook did not remove worktree, kept at:"_ and the directory survives — then (b) calls `removeGhostFolderFromSidebar` (`worktree-ipc.ts:278-282` → `removeGhostFolder`, `user-projects.ts:962-995`). **Order is load-bearing:** `removeGhostFolder` refuses with `DIRECTORY_STILL_EXISTS` while the directory is on disk, so the sidebar detach must come _after_ the git removal, never before. `FOLDER_UNKNOWN` is a benign no-op (the worktree was never pinned). This is exactly the cleanup step Reaper's `sidebar-detach` already reuses, so a CLI-initiated remove leaves nothing for the Cleanup view to reap — and if the hook itself fails, the state degrades to precisely today's behaviour (a ghost row), never worse.

**D5 — `/fork` (v2.1.222).** A fork that cuts its own worktree goes through the same creation path and is therefore Capy-provisioned by construction — desirable: a fork inheriting a bare checkout is the worse outcome. What the watcher sees is unchanged from the 2026-07-19 design: a _new_ session id writing into a _new_ slug dir, i.e. an ordinary `session:added`, not a re-home. The `adoptFolder` inside the provision emits `folders:adopted` first, so the folder row exists before the transcript lands. **Open:** whether `/fork`'s worktree creation is literally the same code path as `EnterWorktree`'s is inferred from the shared post-checks, not proven — capture it live before implementing.

**D6 — Version gate.** `WorktreeCreate` + `type: "http"` + `hookSpecificOutput.worktreePath` requires **v2.1.84**; the events themselves require v2.1.50. There is **no `claude --version` probe anywhere in `src/main/` today** (verified; the only hits are the argv denylist at `claude-args.ts:143` and the `it2 --version` shim in `it2-bridge.ts:324-328`). This card therefore consumes [T200](./T200-cli-version-detection.md) — the card's declared dep — and gates on `isAtLeast(version, '2.1.84')`. T200's fail-closed default ("unknown behaves as the oldest supported version") is the right one here: an unknown CLI omits both events entirely, because a subscribed-but-unusable hook is not a degraded experience, it is a broken `EnterWorktree` (§3.1). This is also the one gate in T200's call-site table whose legacy branch is _not_ "allow" — worth calling out there.

**Alternatives rejected.** _(a)_ Global install — D1's blast radius. _(b)_ `type: "command"` with a `curl` that echoes the path to stdout — works, but keeps the latency problem, adds a `curl` dependency Capy's command transport only carries as a fallback (`hook-installer.ts:81`), and gives no structured error channel. _(c)_ Keep only reacting — leaves the two systems and the bare-checkout problem intact. _(d)_ Extend `DISPATCHABLE_EVENTS` to cover `WorktreeCreate` — conflates a permission decision (fail-open, deadline-bounded, `{}` is safe) with a provisioning contract (fail-**closed**, minutes-long, `{}` is a hard error); the responder's whole fail-open posture is wrong here.

**Open questions to close before implementing.** Whether a per-handler `timeout` above some ceiling is clamped for `WorktreeCreate`; whether a `systemMessage` on a `WorktreeCreate` response is surfaced to the user; whether the CLI re-validates the returned path's basename against the suggested `name` (no evidence it does — only the directory/dot-segment/symlink screens); how `allowManagedHooksOnly` / `allowedHttpHookUrls` / `disableAllHooks` managed settings interact with the injected blob on locked-down machines.

## 6. Acceptance

- A session running `claude -w` or `EnterWorktree` inside a Capy-spawned session lands in a worktree at `<repo>/.claude/worktrees/<slug>` that has the manifest's `seed` applied and `setup` run with the login-shell PATH — byte-identical treatment to a `create_worktree` create.
- The worktree is pinned in the sidebar with `bornFrom` set when the guards allow, before the session's transcript re-homes.
- A manifest failure never leaves the session worktree-less: the operator sees the structured failure and the session still gets a checkout (D3 step 2).
- `WorktreeRemove` leaves neither a directory nor a sidebar row; the Cleanup view shows nothing to reap.
- The implicit base honours `worktree.baseRef`, and the base actually used is reported.
- With a CLI below 2.1.84, neither event is subscribed and behaviour is exactly today's (re-home only).

## 7. Test plan

| Test                                                                                                                                                | File                                                                                                          | Asserts           |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------- |
| the blob subscribes `WorktreeCreate`/`WorktreeRemove` with the long timeout, and omits both when the version gate is off                            | `tests/hook-settings-blob.test.ts`                                                                            | D1, D6            |
| the GLOBAL `buildHookConfig` still contains exactly the existing events — no worktree events leak into `settings.json`                              | `tests/hook-installer.test.ts` (extends `'registers all observed events with sentinel-tagged http handlers'`) | D1                |
| a `WorktreeCreate` POST returns a `hookSpecificOutput.worktreePath` body, is NOT folded into the task FSM, and never reaches the responder registry | `tests/hook-bridge.test.ts` + `tests/responder-bridge.test.ts`                                                | §3.1, §3.3, D2    |
| pure core: `{cwd,name}` → branch/slug/target; response serialization; the D3 ladder (provision → bare add → `{}`)                                   | **new** `tests/worktree-provider-hook.test.ts`                                                                | D2, D3            |
| the returned path is absolute, dot-segment-free and a direct child of `.claude/worktrees` (the CLI's own screens)                                   | `tests/worktree-path.test.ts` (extends `canonicalWorktreeParentRepo` block)                                   | §2 post-checks    |
| `worktree.baseRef: fresh` maps to `remote-default`, `head` to `folder-head`; manifest `from` and an explicit base still win                         | `tests/worktree-spec.test.ts` (beside `describe('planWorktreeBase …')`)                                       | §4                |
| a provision failure still yields a path, and the structured payload retains `stage`/`kind`/`binary`/`rolledBack`                                    | `tests/worktree-provision-error-ack.test.ts`                                                                  | D3                |
| `removeGhostFolder` refuses while the directory exists — proving the D4 ordering                                                                    | `tests/remove-ghost-folder.test.ts` (existing `'refuses a directory that still exists on disk'`)              | D4                |
| a hook-provisioned worktree's session still re-homes correctly; a `/fork` into a new worktree is an add, not a re-home                              | `tests/sessions-store.test.ts` (existing BUG-55 block, `:1742-1880`) + `tests/claude-watcher.test.ts`         | D5, no regression |
| `bornFrom` is recorded for the hook path and dropped when `cwd` is the repo's main checkout                                                         | `tests/worktree-adopt.test.ts`                                                                                | D2 / T191 guards  |

## 8. Contracts touched

- **`CHANGELOG.md` — YES.** `### Added`: worktrees created by Claude Code itself are now provisioned by Capy.
- **`docs/capy-features.md` — YES, with a marker bump (`v34` → `v35`).** Agent-facing under the "UI affordance the agent should proactively offer" and "grant/confirm semantics" clauses: `EnterWorktree` now yields a _provisioned_ worktree, so an agent should stop hand-rolling `git worktree add` + `npm ci`, and a provisioning failure arrives as a system message rather than silence. The CI gate keys on `tool-catalog.ts`/`capy-features.ts`, neither of which this card touches — update the doc anyway; the contract is broader than the gate.
- **`docs/user/` — YES, and the gate will trip.** A new top-level `src/main/worktree-provider-hook.ts` is exactly the "new main-process capability" trigger. Update `docs/user/folders-and-worktrees.md` (who creates a worktree now) and `docs/user/settings.md` (`worktree.baseRef` is honoured by Capy, §4). `docs/user/cleanup.md` gets the `WorktreeRemove` sentence.
- **`design.md` — NO.** No new visual entity; the failure notification reuses the existing toast/Activity Bell surfaces. If a dedicated "provisioning…" indicator is added instead, `design.md` §6 must be edited first.
- **i18n — YES if any string is added** (the failure toast). `en.json` and `pt-BR.json` in the same change, or the `vue-tsc` build breaks.
- **English-only — YES**, whole change.
- **No new MCP verb**, so `tool-catalog.ts` is untouched.

## 9. Definition of done

- [ ] T200 landed and the `isAtLeast(v, '2.1.84')` gate wired (fail-closed on unknown)
- [ ] `src/main/worktree-provider-core.ts` (pure) + `src/main/worktree-provider-hook.ts` (shell)
- [ ] `WorktreeCreate`/`WorktreeRemove` branch in `startHookServer`, before the FSM fold and the responder dispatch
- [ ] Both events in `hook-settings-blob.ts` only, with the 900 s handler timeout; `hook-installer.ts` untouched
- [ ] `worktree.baseRef` read and mapped onto `planWorktreeBase`
- [ ] D3 failure ladder implemented, including the `rolledBack: false` probe
- [ ] `WorktreeRemove`: git removal then `removeGhostFolderFromSidebar`, in that order
- [ ] Tests in §7 green, including the new file
- [ ] Live capture against `claude 2.1.222`: real `WorktreeCreate` payload logged; `/fork` path confirmed (D5 open item); timeout ceiling confirmed
- [ ] `CHANGELOG.md`, `docs/capy-features.md` + marker bump, `docs/user/` pages, i18n parity
- [ ] `npm run typecheck` and `npm run build` pass

## PRD gap

This is a `complex`-tier card, so the board will also ask for a PRD. What a PRD must cover that this spec deliberately does not:

- **Whether Capy should be the machine-wide worktree provider at all.** D1 scopes to Capy-spawned sessions because that is the safe default; the product question — should an operator be able to opt _in_ to the global install so `claude -w` in a bare terminal also gets provisioned? — is a preference, a settings surface, and a support burden, not a code decision.
- **The failure UX.** D3 says "surface it non-blockingly" and names the payload; which surface (toast, Activity Bell, Approval Inbox row), whether the operator can retry the provision in place, and what a half-provisioned worktree looks like in the sidebar are unspecified.
- **Interaction with the `--bg` dispatch substrate** (audit §4.1): background sessions in isolated worktrees already commit, push and open draft PRs. A Capy-provisioned worktree under a background agent changes who owns the lifecycle, and that overlaps the "commit gap" workstream.
- **Rollout and blast radius.** Default-on vs default-off, the migration story for repos with no `WORKTREE.md`, and what happens on a machine with managed hook restrictions.
- **Success metrics.** How many CLI-initiated worktrees are born usable versus bare, and the provisioning latency an operator will actually tolerate before `EnterWorktree` feels broken.
