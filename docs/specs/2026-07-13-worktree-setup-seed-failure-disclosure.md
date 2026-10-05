# Worktree setup/seed failures disclose what broke — and that it rolled back

**Date:** 2026-07-13
**Card:** `bug-28-worktree-setup-seed-failure-is-opaque-same-error-for-no-n`
**Status:** design approved, not implemented

## Problem

A `create_worktree` whose `WORKTREE.md` `setup` step fails hands the caller one line:

```
sh: 1: npm: not found
```

That string is all the operator (New-worktree dialog) or the agent (MCP ACK) ever sees.
It hides two independent facts.

**1. Two failure classes collapse into the same string.**

- The user genuinely has no Node → a legitimate user error; the answer is "install Node ≥ 22".
- Capy's spawned shell can't _see_ the user's Node (mise/nvm/Homebrew + a GUI launch that
  never sourced a login shell) → a **Capy bug**. That was BUG-27, fixed by folding the
  login-shell PATH into `spawnEnv()` (`worktree-ipc.ts:357`).

With BUG-27 landed, this error string is the **only** thing separating "your machine" from
"a Capy regression". It is not cosmetic follow-up: it is what makes the PATH fix falsifiable
by the person hitting it.

**2. The rollback is real and never disclosed.**

`createWorktree` is transactional by design: any seed/setup throw runs `rollbackWorktree`
(`worktree-ipc.ts:370`, called at `:942`), which `git worktree remove --force`s the checkout
**and** `branch -D`s the branch `add -b` created — correct, and deliberately so a retry isn't
poisoned by a zombie branch. But `git worktree add` **did** succeed before that, and nothing
in the error says the checkout existed and was undone. The caller cannot tell whether the
worktree is on disk. In the session that found this, the agent had to probe
`git worktree list` by hand to learn the worktree was gone.

`runManifestCommand` (`worktree-ipc.ts:334`) throws `gitError(err)` — a bare `Error` whose
message is the child's verbatim `stderr`. No stage, no command, no exit code, no rollback
state. Every consumer downstream is string-only: the UI shows the message; the MCP paths wrap
it (`grant actuation failed: …` at `server.ts:720`, `actuation failed: …` at `server.ts:920`).

## Design

### 1. Classify the failure in `runManifestCommand`

`execFile`'s rejection already carries what we need; we throw it away. Keep it:

- **binary missing** — `code === 127` (`sh -c` could not find the command) or Node's
  `ENOENT` (the `sh` binary itself is absent). Extract the **name of the missing binary**
  from the shell's `<name>: not found` / `command not found: <name>` stderr, falling back to
  the first token of the command string.
- **command ran and failed** — any other non-zero exit. The command was found; its own
  failure (a failing `npm ci`, a migration error) is the story, so `stderr` stays the payload.
- **timed out** — `killed`/`SIGTERM` against `SETUP_TIMEOUT_MS`. Distinct from both; a
  10-minute `npm ci` that got cut is neither a missing binary nor a real failure.

Classification is a **pure function** over the rejection shape (`code`, `signal`, `killed`,
`stderr`) plus the command string, unit-testable per ADR-0001 — the env-bound `execFile` call
stays in the imperative shell.

### 2. The enriched error shape

A `WorktreeProvisionError extends Error` carrying the structured facts, thrown by the
seed/setup catch in `createWorktree` after the rollback runs (so the rollback state is known
at throw time):

| field           | meaning                                                                 |
| --------------- | ----------------------------------------------------------------------- |
| `stage`         | `'seed' \| 'setup' \| 'delegated-create'`                               |
| `step`          | `1`-based index + total, when the stage has steps (`setup step 1 of 2`) |
| `command`       | the command verbatim, as run (`npm ci`) — never a paraphrase            |
| `kind`          | `'binary-missing' \| 'command-failed' \| 'timeout'`                     |
| `binary`        | the missing binary's name — set only when `kind === 'binary-missing'`   |
| `path`          | the resolved `PATH` the setup shell used — set only on `binary-missing` |
| `exitCode`      | the child's exit code, when there was one                               |
| `stderr`        | verbatim, trimmed, capped                                               |
| `rolledBack`    | `true` when the checkout was removed                                    |
| `branchDeleted` | the branch name `add -b` created and rollback deleted, or `null`        |

`rollbackWorktree` today swallows both of its failures (correctly — the provisioning error
must win). It gains a **return value** reporting what it actually undid, so `rolledBack` /
`branchDeleted` are observed, not assumed. A rollback that itself fails reports
`rolledBack: false` — a half-state the operator must be told about, not hidden.

The `path` disclosure closes the BUG-27 loop: if the resolved PATH has no `~/.local/share/mise`
in it on a machine that has mise, that is a Capy bug and the error says so out loud.

### 3. One message, both surfaces

The human-readable rendering is a **single pure formatter** (`formatProvisionError`), used by
the UI create path _and_ the MCP ACK so the wording can never drift:

```
setup step 1 of 1 failed: `npm ci`
npm: command not found — Capy's setup shell could not find it.
PATH used: /usr/local/bin:/usr/bin:/bin
Either npm is not installed, or Capy cannot see it (GUI launch + mise/nvm/Homebrew).
The worktree was created and rolled back; branch `feat/x` was deleted.
```

and for the command-ran-and-failed class:

```
setup step 2 of 3 failed: `npm run build` (exit 1)
<stderr, verbatim>
The worktree was created and rolled back; branch `feat/x` was deleted.
```

- **UI** (`NewWorktreeDialog.vue` via `worktree:create`): the formatted message replaces the
  bare `stderr` in the dialog's error slot. Strings go through i18n (`en.json` + `pt-BR.json`,
  both in the same change); the command, binary, PATH, branch and `stderr` are interpolated
  data, never translated.
- **MCP** (`create_worktree`): the handler catches `WorktreeProvisionError` and returns a
  **structured** error result — the same `{error, message, nextActions}` steer shape
  `tool-result.ts` already uses — rather than letting it escape as a bare `Error` that
  `server.ts` stringifies into `grant actuation failed: <stderr>`. The payload carries the
  fields above verbatim (`stage`, `command`, `kind`, `binary`, `rolledBack`, `branchDeleted`)
  plus the same `message`, so an agent reads facts instead of parsing prose, and
  `nextActions` steers ("install Node ≥ 22, then retry `create_worktree`" vs. "fix the failing
  `setup` command in `WORKTREE.md`"). Both the grant-actuation and the parked-confirm paths in
  `server.ts` must let a structured error through **unwrapped**, or the shape is lost to string
  concatenation.

The delegated-`create:` branch (`worktree-ipc.ts:882`) gets the same treatment with
`stage: 'delegated-create'`; its rollback is the manifest's companion `remove:`, so
`rolledBack` reflects whether that ran, and `branchDeleted` is `null` (the script owned the
flow; Capy created no branch).

### 4. Scope

Out of scope: streaming setup output (the `spawn`-instead-of-`execFile` refinement noted at
`worktree-ipc.ts:99`), and any change to the rollback _policy_ — the transaction is correct;
only its disclosure is missing.

## Testing

Pure-core tests (no subprocess), per ADR-0001:

- **`classifyManifestFailure`** — exit 127 with `sh: 1: npm: not found` → `binary-missing`,
  `binary: 'npm'`; `ENOENT` → `binary-missing`; exit 1 with stderr → `command-failed`;
  `killed` + `SIGTERM` → `timeout`. Binary-name extraction covers both shell dialects
  (`<name>: not found`, `command not found: <name>`) and falls back to the command's first token.
- **`formatProvisionError`** — a `binary-missing` error renders the binary name, the resolved
  PATH, and the rollback sentence; a `command-failed` error renders `setup step N of M` + the
  exact command + exit code + verbatim stderr, and the rollback sentence.
- **MCP ACK, binary missing** — the `create_worktree` handler with a mocked `createWorktree`
  that throws a `binary-missing` `WorktreeProvisionError` returns a structured error naming
  the missing binary and stating `rolledBack: true` + the deleted branch. The assertion is
  that an agent never has to probe `git worktree list` to learn the worktree is gone.
- **MCP ACK, command failed** — same, asserting `stage`, `step`, and the verbatim `command`
  are present, and that `binary` is absent (the tool was found; it failed).
- **Structured error survives the server paths** — the grant-actuation and parked-confirm
  wrappers pass a structured provision error through without flattening it to a string.
- **Rollback reporting** — `rollbackWorktree` returning "remove failed" surfaces
  `rolledBack: false`, and the message says the worktree may still exist.

The end-to-end (a real `WORKTREE.md` with `setup: [nonexistent-binary]`) stays e2e-only —
`createWorktree` is env-bound.

## Contract obligations

- `CHANGELOG.md` — mandatory. The error a person reads when a worktree create fails changes
  shape and now discloses the rollback.
- `docs/capy-features.md` + version-marker bump — **agent-facing**. `create_worktree`'s
  failure ACK gains fields the agent must read (`kind`/`binary`/`rolledBack`/`branchDeleted`)
  and a `nextActions` steer; per the "budget-with-no-ACK" litmus in `CLAUDE.md` a new field
  the agent reads is in. The CI awareness gate fires on the `tool-catalog.ts`/`capy-features.ts`
  diff; the handler change alone still owes this doc.
- `docs/user/` — the New-worktree dialog now explains _why_ a create failed and that it was
  rolled back. `docs/user/agent-control.md` (the human prose for the MCP verbs) carries the
  same wording for `create_worktree`.
- i18n — every new string in **both** `en.json` and `pt-BR.json` in the same change, or
  `vue-tsc` breaks on the `MessageSchema` parity.
