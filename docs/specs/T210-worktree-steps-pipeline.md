# T210 — Worktree `steps:`: resumable runtime bring-up that halts instead of rolling back

**Date:** 2026-08-06 · **Status:** specified (not implemented) · **Card:** `.capy/memory/roadmap/T210-t210-worktree-steps-resumable-runtime-bring-up-that-halts.md`
**Followed by:** [T211](./T211-worktree-steps-agent-surface.md) (agent surface + `{index}`) · **Prior art, not contradicted:** [BUG-27](../../.capy/memory/roadmap/bug-27-create-worktree-setup-runs-in-a-shell-without-the-user-s.md) (login PATH), [BUG-28](../../.capy/memory/roadmap/bug-28-worktree-setup-seed-failure-is-opaque-same-error-for-no-n.md) (failure disclosure), T33 (agentic recipe — Slices B/D dropped by sign-off)

All code facts below were read from the working tree at `2706083`, not inferred from prose.

## 1. Goal

Make a repo's **runtime bring-up** deterministic and resumable, without pretending it is part of worktree creation. Creation stays what it is today — fast, transactional, all-or-nothing. Bring-up becomes a separate, ordered, observable pipeline that survives its own failures.

The concrete driver is the Acme manifest (`/home/u/Workspace/org/acme/www/WORKTREE.md`), whose §1–§4 describe eight ordered runtime commands in **prose** precisely because they cannot be expressed in `setup:` today. That prose is inert: nothing reads it and nothing runs it (§2.3).

## 2. Current behaviour, verified

### 2.1 What `setup:` actually is

`createWorktree` (`src/main/worktree-ipc.ts:1185-1402`) is the entire pipeline: `validateWorktreeRequest` → `resolveWorktreePlan` (manifest read at the git-resolved repo root, `:1230`) → `assertPosixShellAvailable` → `git worktree add` → `applySeedPlan` → the `setup` loop (`:1334-1338`) → `adoptFolder` (`:1377`).

The setup loop runs each entry through `runManifestCommand` (`:486-518`): `sh -c` on POSIX, a resolved Git Bash on Windows (BUG-29/ADR-0005), `cwd` = the new worktree, and — since BUG-27 — `env: await spawnEnv()`, which folds the user's **login-shell PATH** in (`:503-507`, `:565-569`). Budgets are `SETUP_TIMEOUT_MS = 10 * 60_000` and `SETUP_MAX_BUFFER = 64 << 20` (`:123-124`), applied **per command**, not to the list.

Two properties matter for this card:

- **Entries are not token-expanded.** The loop calls `runManifestCommand(manifest.setup[i], target)` directly (`:1337`). `expandCommandTokens` is applied only to a delegated `create`/`remove` (`:1266`, `:1283`). `disclosedWorktreeCommands` (`src/main/worktree-manifest.ts:601-616`) encodes this as an explicit _fidelity contract_ — the confirm disclosure returns `setup[]` verbatim precisely because that is how it executes.
- **Failure is transactional.** The catch at `:1339-1351` calls `rollbackWorktree(repoRoot, target, createdBranch)` (`:605-...`), which runs `git worktree remove --force` **and** `git branch -D` — the branch delete is deliberate, so a retry doesn't die on "a branch named X already exists". It then raises a `WorktreeProvisionError` carrying `stage` / `step {index,total}` / `command` / `kind` / `binary` / `rolledBack` / `branchDeleted` (BUG-28).

### 2.2 Why Acme's steps cannot go in `setup:`

Each of the four premises above is violated by the real recipe:

| Premise of `setup:`                     | Violated by                                                                                                                                                                                 |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fits in the create ACK                  | `sail up -d` + `composer install` + `sail npm ci` on a cold cache. A 5-worktree fan-out serialises into blocked ACKs; `create_session`'s materialisation window is 60s.                     |
| Safe to run blind, every create         | `artisan migrate:fresh --seed` **wipes a database**.                                                                                                                                        |
| Failure means the worktree is worthless | A `filament:assets` failure at step 7 currently deletes the checkout _and_ the branch, discarding the successful `npm ci` that preceded it.                                                 |
| Every step is a command                 | §1 of the Acme manifest requires editing `LAST_DIG` / `COMPOSE_PROJECT_NAME` in the copied `.env` **before** `sail up`, or ports collide with master. That is an allocation, not a command. |

The manifest author's own comment states the tradeoff correctly: the runtime half is "interativo e com risco de wipe de dados … **nunca** em `setup:` (que roda cego a cada create)".

### 2.3 The body and `boot:` are parsed and then dropped

`splitFrontMatter` (`src/main/worktree-manifest.ts:138-161`) separates YAML front matter from the markdown body; `resolveManifest` retains the body on `ResolvedManifest.body` (`:99-100`, assigned `:440`/`:471`, where a `WORKTREE.local.md` body _replaces_ rather than merges). The field's own doc comment calls it "the agent/human execution surface".

**It has no consumers.** A repo-wide read finds no reader of `manifest.body` outside the module. It is not injected into a session's boot prompt, not returned in the `create_worktree` ACK, and not surfaced in the UI. `ManifestBoot` (`:37-42`, resolved at `:480`) is in the same state: `boot.model` / `boot.prompt` parse cleanly and are read by nothing — the Acme manifest's `boot: model: sonnet` is inert. Model routing comes from the per-repo routing table, not the manifest.

This card does not fix `boot:` (out of scope, noted so a future reader does not assume it works). It does make the _body's_ content expressible as `steps:`, which is the part that has a live user.

### 2.4 One stale claim worth retiring

The Acme manifest justifies mirroring `worktree.config.json` as avoiding a dependency on "`node` no PATH do shell da Capy". **That constraint no longer holds** — BUG-27 landed exactly that fix (`:503-507`). A `create:` that delegates to the repo's own `npm run wt` is viable today, independently of this card. Worth a 2-minute test before building anything.

## 3. Shape

A new front-matter key, sibling to `setup:`, with the opposite failure semantics:

```yaml
steps:
  - name: ports
    run: bin/worktree/set-ports.sh
  - name: up
    run: sail up -d
    check: sail ps --status running # exit 0 ⇒ already satisfied, skip
  - name: deps
    run: sail composer install && sail npm ci
    timeout: 1800 # seconds; default = SETUP_TIMEOUT_MS
  - name: db
    run: sail artisan migrate:fresh --seed --database=acme
    destructive: true # never runs without an explicit go
  - name: panels
    run: sail artisan nova:publish && sail artisan filament:assets
```

Fields: `name` (required, unique, the state key), `run` (required), `check` (optional probe), `destructive` (optional, default `false`), `timeout` (optional seconds).

## 4. Decisions

**D1 — `steps:` is a new key, never an extension of `setup:`.** They have inverted failure semantics (`setup` rolls back, `steps` halts) and different lifetimes (`setup` is create-blocking, `steps` is deferred). Overloading one key would silently change the meaning of every existing manifest. Registration is two edits: `KNOWN_KEYS` (`worktree-manifest.ts:119`) — an unregistered key raises an "unknown key" warning — and `PartialManifest` (`:106-114`) plus its `normalizeRecord` branch and the overlay merge (`:354-357` is the shape to mirror).

**D2 — Failure halts; the steps runner never rolls back.** `rollbackWorktree` must be unreachable from this path. A worktree that reached `adoptFolder` exists and stays. The whole point is that ten minutes of successful `npm ci` survives a failing CSS build. Concretely: the runner records the failing step and stops; it does not touch git.

**D3 — Steps run after `adoptFolder`, out of band, and never block the create ACK.** The create returns as it does today. The runner is kicked off afterwards against the adopted folder. Consequence to accept explicitly: `createWorktree`'s existing progress channel (`worktree:progress:<id>`, `src/preload/index.ts:2029`) is create-scoped and closes; steps need their own event stream keyed by worktree path, not by create id.

**D4 — Run state lives in `userData`, keyed by worktree path — not in the worktree.** Follow `src/main/helpers-store.ts` verbatim as precedent: a single JSON file under `app.getPath('userData')` (`:64-68`), `byWorktree[worktreePath]` (`:139-165`), a `stat`-based staleness check (`:146`), and a `removeForWorktree` cleanup (`:175-178`). Rejected alternative: a `.capy/worktree-run.json` inside the checkout — it would oblige every adopting repo to add a gitignore entry, and a stray commit of run state is worse than the inconvenience it saves. **Accepted cost:** a session inside the worktree cannot read the state from disk; it needs a verb. That is exactly T211's scope, and it is the right door anyway.

**D5 — `destructive: true` steps never run from a bulk action.** "Run all" skips them and reports them as _withheld_, not failed. They run only from a per-step, explicitly-confirmed action. `migrate:fresh --seed` is the motivating case and it must be impossible to trigger by reflex.

**D6 — `check:` is a command, not a new language.** Exit 0 ⇒ the step is already satisfied, skip it and mark it `skipped`. Any non-zero ⇒ run the step. No parsing of output, no expression syntax. This buys idempotence — re-running the pipeline on a half-provisioned worktree is safe — at the cost of one extra subprocess per step, which is noise next to `npm ci`.

**D7 — Per-step `timeout`, defaulting to the existing 10 minutes.** `runManifestCommand` already takes the budget from module constants (`:501-502`); it needs to accept an override. `composer install` on a cold cache genuinely exceeds 10 minutes and a silent kill there is the worst possible failure mode.

**D8 — No token expansion in `steps.run` for this slice.** Matches `setup[]`'s existing raw behaviour (§2.1) and keeps the disclosure fidelity contract trivially true. `{index}` — the token that makes port allocation expressible — is deliberately deferred to T211, because it is an _allocation_ with its own correctness question (what happens when worktree 2 of 3 is removed), not a formatting concern.

**D9 — Disclosure happens at run time, not create time.** `disclosedWorktreeCommands` (`worktree-manifest.ts:601-616`) exists to show the operator the RCE surface a create is about to execute. `steps:` does **not** execute during a create, so folding it into that return value would be a lie about what the confirm authorises. Instead: the create confirm gains a _count_ ("this manifest defines 5 deferred steps"), and the full verbatim command list is disclosed by the run surface before the pipeline starts. The fidelity contract in that function's doc comment must be updated to say so explicitly, or the next reader will assume the omission is a bug.

## 5. Non-goals

- **Not a CI runner.** No branching, no conditionals beyond `check:`, no matrices, no parallelism. A step needing logic calls a script the repo already owns — Acme has `bin/worktree/worktree.mjs`, and half its recipe collapses into one step that calls it.
- **Not a dependency graph.** Steps are a list and run in written order.
- **Does not revive T33 Slice B.** No `env_set` / `copy` / `link` / `port_alloc` MCP primitives; those were dropped by explicit operator sign-off on 2026-07-06 and this card does not reopen that.
- **Does not fix `boot:`** (§2.3).

## 6. Surfaces touched / definition of done

- `src/main/worktree-manifest.ts` — `steps` in `KNOWN_KEYS`, `PartialManifest`, `ResolvedManifest`, `normalizeRecord`, the local-overlay merge; a `ManifestStep` interface; the `disclosedWorktreeCommands` doc-comment amendment (D9).
- `src/main/worktree-steps.ts` (new, thin shell) over a pure core per ADR-0001 — the runner, the state reducer, the `check`/`destructive`/`timeout` policy.
- `src/main/worktree-ipc.ts` — `runManifestCommand` gains a timeout override (D7); the create emits the deferred-step count.
- Renderer — a setup/steps panel with per-step status and per-step run, plus the bulk "Run all" that honours D5.
- **`CHANGELOG.md` entry — mandatory.**
- **`docs/user/folders-and-worktrees.md` — mandatory.** A new top-level `src/main/` file and a new top-level component both trip the user-docs CI gate (`scripts/ci/user-docs-gate.mjs`).
- `design.md` — the panel is a new component; read/extend §6 **before** writing the Vue file.
- **No awareness-doc obligation in this slice** — nothing here touches `src/main/mcp/tool-catalog.ts` or `src/main/capy-features.ts`, so `scripts/ci/awareness-gate.mjs` does not fire. T211 is where that changes.

## 7. Open questions

1. **Auto-run on create?** Never (respects D5's spirit), opt-in per repo via a manifest flag, or opt-in per create in the dialog? Leaning: never in slice 1 — earn the trust with a manual run first.
2. **Where does the panel live?** A tab in the folder's existing surface vs. a takeover. Leaning: folder-scoped panel; a takeover is too heavy for something you look at twice per worktree.
3. **Staleness.** `helpers-store` stats the worktree path to drop dead entries (`:146`). Same policy here, or also invalidate the recorded state when `WORKTREE.md`'s `steps:` block changes (a hash, mirroring the roadmap card's `approvedBodyHash` idea)? The second is more correct and more work.
