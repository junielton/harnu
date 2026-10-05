# T211 — Expose worktree steps to the session: `worktree_steps` verb + `{index}` token

**Date:** 2026-08-06 · **Status:** specified (not implemented) · **Card:** `.capy/memory/roadmap/T211-expose-worktree-steps-to-the-session-worktree-steps-mcp-verb.md`
**Depends on:** [T210](./T210-worktree-steps-pipeline.md) (the `steps:` key, the runner, the state store) · **Constrained by:** T33 Slice B/D sign-off, 2026-07-06 (no `env_set` / `copy` / `link` / `port_alloc` MCP primitives)

## 1. Goal

Two things T210 deliberately left out, both of which need the agent-facing surface T210 avoided touching:

1. **A session inside the worktree can see and continue its own bring-up.** T210 D4 puts run state in `userData`, not in the checkout — a correct call for repo hygiene, but it means a session has no on-disk file to read. The verb is the door.
2. **Per-worktree port allocation becomes expressible**, so Acme's §1 (`LAST_DIG`, `COMPOSE_PROJECT_NAME`) stops being a manual pre-edit.

## 2. Why the verb, and not "let the session shell out"

A session could in principle run the commands itself. It should not, for three reasons:

- It would re-derive the recipe from the `WORKTREE.md` body — the prose surface that T210 §2.3 shows nothing reads and nothing validates. Two sources of truth, one of them unparsed.
- It would have no idea which steps already succeeded, so it would re-run `migrate:fresh --seed` on a working database.
- It would bypass T210 D5 entirely — `destructive: true` means nothing if the executor is a shell call.

The verb exists to make the _state_ readable and the _policy_ enforceable, not to save typing.

## 3. Verb shape

```
worktree_steps({ folder, action: "read" | "run", step?, allowDestructive? })
```

**`action: "read"`** → the per-step state: `name`, `status` (`pending` | `ok` | `failed` | `skipped` | `withheld`), `destructive`, plus `exitCode`, a bounded `stderrTail`, and `at` for anything that ran. Includes `nextStep` — the first step not yet satisfied — so a session does not have to reimplement the ordering rule.

**`action: "run"`** → continues from `nextStep` to the end. Honours T210 D6 (`check:` probes skip satisfied steps) and D5: a `destructive: true` step is **withheld**, not run, and the run stops there reporting why. Passing `step: "<name>"` runs exactly one step; `allowDestructive: true` is the explicit opt-in that a destructive step requires, and it is only ever honoured together with a named `step` — never on a bulk continue.

Failure returns the same structured fields the create path already standardised in BUG-28 (`stage` / `step` / `command` / `kind` / `binary` / `exitCode` / `stderr`), so an agent parses one shape for both pipelines rather than two.

## 4. Decisions

**D1 — Risk class splits by action, not by verb.** `read` is a pure observation and belongs with the free verbs. `run` **executes committed shell content** and belongs in the same class as `create_worktree` — the one verb the catalog already flags as running a shell (`src/main/mcp/tool-catalog.ts:216`, `isSafeGrantVerb` at `:398`). Registering the whole verb as free because "it's mostly a reader" would quietly widen the shell-execution surface, which is the exact failure this note exists to prevent.

**D2 — `{index}` is an allocation, not a positional index.** The naive reading — position in `git worktree list` — is wrong and dangerous: remove worktree 2 of 3 and the third renumbers onto the second's ports, colliding with a live `sail` stack. Instead: **the lowest positive integer not currently assigned to a live worktree of this repo**, allocated at create time, persisted alongside T210's run state, and released by the same `removeForWorktree` cleanup that `helpers-store.ts:175-178` models. Stable for the worktree's whole life; reused only after the holder is gone.

**D3 — This does not reopen T33 Slice B.** That sign-off rejected _agent-callable primitives that mutate the environment_ — `env_set`, `copy`, `link`, `port_alloc` — on blast-radius grounds. `{index}` is neither callable nor a mutation: it is a value Capy computes and substitutes into a command the repo author already committed. The agent cannot request an index, choose one, or write one. The distinction is the whole reason this is acceptable and it must survive review intact — if implementation drifts toward "the agent asks for an index", stop and re-read the sign-off.

**D4 — Token expansion applies to `steps.run` and `steps.check` only; `setup[]` stays raw.** `setup[]` is deliberately unexpanded today and `disclosedWorktreeCommands` (`src/main/worktree-manifest.ts:601-616`) encodes that as a fidelity contract. Expanding it now would change the meaning of every existing manifest containing a literal `{branch}`. `steps:` is new, so it can be expanded from birth with no compatibility cost. Document the divergence in the manifest reference — an author reading both keys side by side will otherwise assume it is a bug.

**D5 — `{index}` follows the existing quoting discipline.** `expandCommandTokens` (`:561-571`) inserts validated values literally and single-quotes unvalidated ones via `shSingleQuote` (`:574-576`). `{index}` is Capy-generated and integral, so it is validated by construction — assert it is a non-negative integer at the substitution site and insert literally. The assertion is not ceremony: it is what stops a future refactor that sources the index from anywhere else from opening an injection hole.

## 5. Surfaces touched / definition of done

- `src/main/mcp/tool-catalog.ts` — register `worktree_steps` with the D1 risk split.
- `src/main/mcp/tool-handlers.ts` — the handler, over T210's pure core.
- `src/main/worktree-manifest.ts` — `{index}` in `expandCommandTokens` + the D5 assertion; expansion wired into `steps.run` / `steps.check`.
- Index allocation + release in T210's state store.
- **`docs/capy-features.md` + `<!-- capy-features vN -->` marker bump — mandatory.** A new MCP verb is agent-facing by definition; `scripts/ci/awareness-gate.mjs` fires on any diff touching `tool-catalog.ts`.
- **`docs/user/agent-control.md` — mandatory.** `scripts/ci/user-docs-gate.mjs` fires on the same file.
- **`CHANGELOG.md` entry — mandatory.**

## 6. Open questions

1. **Does `run` block the verb call, or return a handle?** A ten-minute `npm ci` against the MCP call timeout is the same shape as the `create_session` materialisation problem. Leaning: return immediately with the started step, let the agent poll `read` — which is also why `read` must be free (D1).
2. **Should `{index}` be exposed to `create:`/`remove:` too?** They already expand tokens, so it is nearly free, but no current use case demands it. Defer until one does.
3. **What happens to a running pipeline when Capy quits?** PTYs are killed in `before-quit`; a step subprocess presumably should be too, leaving the step `failed` rather than eternally `pending`. Needs an explicit policy, not an emergent one.
