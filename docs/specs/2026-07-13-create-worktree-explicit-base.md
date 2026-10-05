# `create_worktree` takes an explicit base

**Date:** 2026-07-13
**Cards:** `create-worktree-cannot-stack-no-way-to-branch-from-anything-but`,
`create-worktree-s-folder-param-silently-bases-the-new-branch-on`
**Status:** design approved, not implemented

## Problem

Capy cannot express a stacked-PR workflow. `create_worktree` always cuts the new branch
from `origin/main`, and there is no parameter that says otherwise. Two repros, one defect:

**(1) No base parameter exists.** The agent wants `feat/B` on top of `fix/A` and has
nothing to say so with. `ref` is not it: `ref` **checks out an EXISTING** local/remote
branch (review a PR), it does not **create a NEW** branch from a given ref.

**(2) `folder` looks like it means "base here", and silently doesn't.** The
`orchestrate-delivery` stacking pattern passes the parent branch's worktree as `folder`,
expecting the fork point to follow. Reproduced live, 2026-07-13 — a worktree checked out
on `card/T83-notification-center`, one commit ahead of `origin/main`:

```
create_worktree({ folder: "<T83's worktree>", branch: "card/T116-agent-notify-verb" })
→ { ok: true, base: "origin/main", ... }
git merge-base --is-ancestor <T83 commit> HEAD   → NO
```

The new worktree came up at main's tip, missing the parent's commits. The ACK is
indistinguishable from a correct dispatch (`ok: true`) — the same **quiet lie** class as
the fanout postmortem's `create_session` ACK. The only reason it was caught at all is that
the ACK reports `base` (T64/BUG-12). Keep that.

### This is BUG-26's fix, over-corrected — do not revert it

Before PR #99, `create_worktree` resolved the base from the primary worktree's **local**
`main`, which drifts stale during a long orchestration session. Pinning the base to
`origin/main` (`planWorktreeBase` → `remote-default`, `worktree-core.ts`) fixed a real bug.
It also pinned it _absolutely_. Both requirements are legitimate:

- BUG-26's: never **silently** pick a stale base.
- These cards': let the caller **deliberately** pick a non-main base.

The resolution is an **explicit** base — not a smarter inference. Inference is the thing
BUG-26 proved dangerous.

### The verb also registers the folder

The workaround used in the live session — bypass the verb, run
`git worktree add -b <branch> <path> <base>` by hand, then `create_session` — works for
git, and then `get_session` against that folder fails `FOLDER_NOT_ALLOWED`. `create_worktree`
does strictly more than `git worktree add`: it resolves the manifest (`WORKTREE.md` →
`dir`/`seed`/`setup`/`create`), provisions the tree, and **adopts** the result as a pinned
folder with the T61 birth-marker inherit — i.e. it is what puts the folder in the agent
allowlist. Any fix must reach the stacked base _through_ the verb, not around it.

## Design

### The parameter

Add an optional `base` to `create_worktree`'s input schema (`tool-catalog.ts:319`):

- **Absent** → byte-for-byte today's behavior: `remote-default` → `origin/main`, with the
  BUG-26 fetch. Nothing silently changes; BUG-26 stays fixed.
- **Present** → branch from that ref, after resolving and **validating** it.
- **Non-existent ref** → a loud, steerable error (`BAD_BASE: …`, naming the ref and that no
  fallback was taken). **Never** a silent fall-back to main. A caller who asked for a base
  and got main is exactly the failure these cards describe.

Most of the machinery already exists and is simply not wired: `createWorktree(repoPath,
branch, baseRef, ref, …)` takes a `baseRef` (`worktree-ipc.ts:419`), `planWorktreeBase`
already has an `explicit` plan kind that passes the caller's base through untouched
(`worktree-core.ts:238`), and `validateResolvedBase` already argv-guards it. The MCP handler
just hard-codes `undefined` in that slot (`tool-handlers.ts:441`). The work is: schema →
handler → the existing `baseRef`, plus an **existence probe** on the explicit path.

The probe is new. `probeWorktreeBase` deliberately does no git for an `explicit` plan
(`worktree-ipc.ts:552`) — with no base param there was never an agent-supplied ref to
verify. With one, a bad ref must fail at the verb with a message the agent can act on,
not as raw `git worktree add` stderr surfacing somewhere downstream. Add a
`git rev-parse --verify <base>^{commit}` (in the repo root) before the add.

### Rejected: infer the base from `folder`'s checked-out branch

Card 2 floats option (a) — make `folder` resolve to "the branch checked out at that path"
when it is a linked worktree. **Rejected.**

- It re-introduces exactly what BUG-26 fixed: a base picked _for_ the caller from a
  checkout's HEAD, which can be stale, dirty, or mid-rebase. BUG-26's whole lesson is that
  an inferred base is a base nobody audits.
- It overloads one parameter with two meanings (_which repo_ / _which base_), so a caller
  who wanted `origin/main` from a feature worktree can no longer say so.
- It does not cover card 1's ask at all: branching from a ref that has **no worktree**
  (`origin/release-2`, a tag, a SHA) remains inexpressible.

An explicit param is strictly safer and strictly more expressive — it covers both repros.
`folder` keeps its one meaning: _which repo_ (and, for a linked worktree, the repo root it
resolves to).

### Warn, don't refuse, on a behind-remote local base

When the explicit base is a **local** branch that is behind its remote counterpart, emit a
`warnings[]` entry (the plan already carries `warnings`) — do not refuse. Deliberately
branching off a not-yet-pushed local branch is the normal stacking case; branching off a
stale one is a mistake worth naming. This preserves BUG-26's intent (nobody is _silently_
stale) without blocking the workflow the cards exist to enable.

### The ACK

Unchanged in shape, now honest in content: `{ ok, op, path, base, branch }` where `base` is
the **resolved** base actually cut from. `warnings` ride along when present. A caller can
keep verifying with `git merge-base --is-ancestor` — and, with this fix, the ACK's `base`
already told them.

## Testing

- **Default unchanged (BUG-26 regression guard):** no `base` given → resolves `origin/main`
  exactly as today, including the fetch and the `--no-track` remote-tracking path.
- **Explicit base honored (the stacking case):** a repo with a local branch one commit ahead
  of `origin/main`; `create_worktree({ folder, branch, base: "<that branch>" })` → the new
  worktree's HEAD **equals the parent's tip**, asserted with
  `git merge-base --is-ancestor <parent commit> HEAD` (the same check that caught the bug).
- **Non-existent base:** `base: "no/such/ref"` → a steerable error naming the ref; **no**
  worktree created, **no** fallback to `origin/main`.
- **ACK reports the resolved base:** on both paths (default and explicit), `base` in the ACK
  is the ref the branch was actually cut from.
- **Behind-remote local base:** produces a warning, not a refusal, and still cuts from the
  named base.
- **Allowlist preserved:** a worktree created with an explicit `base` is adopted and
  agent-reachable — a follow-up `get_session` / read verb against it does **not**
  `FOLDER_NOT_ALLOWED` (the property the manual `git worktree add` workaround loses).

## Contract obligations

- `CHANGELOG.md` — mandatory (user-visible: stacked worktrees become possible; a
  previously-silent wrong base becomes an error).
- `docs/capy-features.md` + version marker bump — **agent-facing**: a new parameter on an MCP
  verb, a new refusal the agent must read, and a workflow (how to stack) it should now
  offer. The CI awareness gate fires on any `tool-catalog.ts` diff and will demand it.
  Document the **actual resolution rule** — base absent → `origin/main`; base present → that
  ref; `folder` is _which repo_, never _which base_.
- `docs/user/` — only if the New-worktree dialog exposes a base picker in the same change.
  The MCP-only fix touches `tool-catalog.ts`, so the user-docs gate fires regardless:
  `docs/user/agent-control.md` gets the human-prose version of the verb's new parameter.
