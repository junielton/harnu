# Agent control defaults to ON for new folders and worktrees

**Date:** 2026-07-13
**Status:** **SUPERSEDED** by the free-by-default reversal (`feat/agent-autonomy-default-free`,
2026-07-14) — this design was never implemented. The flip that shipped is strictly
larger: it is **retroactive** (existing folders unblock on upgrade, no migration
pass), it **removes the allowlist entirely** rather than defaulting it on, and it
**removes the per-action confirms** (making them an opt-in `ask` pref) instead of
keeping them. The per-folder switch survives only inverted, as a **denylist**
(`agentDenied` — "Block agent control").

The body below is left INTACT: its file:line map is still the best record of the
pre-reversal architecture, and §"Scope decisions" documents the narrower path the
operator considered and then rejected. Read it as history, not as a plan.

> Where this design was explicitly overruled:
>
> - "**Forward-only, no retroactive migration**" → reversed. The new gate stops
>   reading `agentAllowed` at all, so every existing record unblocks on upgrade with
>   no migration. That was the point: a stranded install is the bug.
> - "**No change to the fail-closed read semantics in `policy-assemble.ts` /
>   `permission-core.ts`**" → reversed. Those are exactly the files the reversal
>   rewrites; the allowlist they encoded is gone.
> - "Only the **write side** changes" → reversed. The write side stops writing the
>   field, and the READ side stops consulting it.

## Problem

Agent control (`agentAllowed`) is opt-in today: every newly pinned folder, and every
new git worktree, is born fail-closed. A user adds a folder, kicks off work, and walks
away assuming it's running — but `get_session`/`create_session` are silently refused
until they come back and flip "Allow agent control" by hand. The failure is invisible:
no crash, no error the user sees in the moment, just an idle machine an hour later.

This is a deliberate reversal of a considered security default (see the `SECURITY —
defaults OFF` comments in `worktree-inherit-prefs.ts`, `user-projects.ts`, and
`worktree-ipc.ts`). The reversal is intentional: the operator's standing philosophy for
this app is that human gates belong only at execute/accept/route doors, never between
model and tool — a standing allowlist check on every folder is friction without a
matching trust decision once the operator has already chosen to run Capy against that
folder at all.

## Scope decisions (agreed)

- **Both mechanisms flip**: newly pinned folders default `agentAllowed: true`, and new
  worktrees of an already-allowed repo default to inheriting that control. (Previously
  considered doing only one; rejected — the operator wants both.)
- **Forward-only, no retroactive migration.** Folders/worktrees that already exist
  today keep exactly the behavior they have today. Nothing is silently upgraded on next
  launch. This matters doubly because Capy is bound for an OSS launch — a stranger's
  existing install must not wake up with a wider grant than they configured.
- **Applies uniformly to human-initiated pins AND the agent-callable `adopt_folder`
  MCP verb.** Considered restricting the default-ON behavior to human-initiated pins
  only (Add Folder dialog, sidebar drag-drop, subfolder picker) and leaving
  `adopt_folder` — which lets an agent name and pin an arbitrary existing path over MCP
  — on the old conservative "pin ≠ grant" two-step. Rejected: the operator wants any
  newly pinned folder to be actionable immediately, whichever side initiated the pin.
  The confirm dialog is the disclosure surface for this now (see Change 3) — pinning
  via `adopt_folder` still requires a human confirm, and that confirm must say plainly
  that it also grants, so the approval is still informed.

## Design

### Change 1 — new folders default `agentAllowed: true`

The security-critical read path is untouched: `policy-assemble.ts`'s
`assemblePolicy()` keeps its literal `userProjects.filter((f) => f.agentAllowed)` check
(line ~101) — missing/falsy still reads as not-allowed, exactly as documented today.
Only the **write side** changes: every code path that creates a brand-new
`UserProject` record stamps `agentAllowed: true` explicitly instead of leaving the
field unset or hardcoding `false`.

Two write sites, both funneling through `addUserProject()`
(`src/main/user-projects.ts:273`):

1. `pinFolder()` (`src/renderer/src/stores/sessions.ts:2766-2794`) — the single funnel
   behind every human-initiated pin (`NewFolderDialog.vue:65`, `Onboarding.vue:42`,
   `OpenSubfolderDialog.vue:176`, `Sidebar.vue:135` drag-drop, and the native-picker
   `AddFolderDialog.vue` flow). The `entry` object built at
   `sessions.ts:2769-2774` gains `agentAllowed: true`.
2. `adoptFolder()` (`src/main/worktree-ipc.ts:155-187`) — shared by `createWorktree`
   (agent-initiated `create_worktree`) and `adoptExistingFolder` (the MCP
   `adopt_folder` verb). Its hardcoded `agentAllowed: false` at line 170 changes to
   `true`, **except** when the record being written is itself a canonical
   `.claude/worktrees/*` worktree — those must keep `agentAllowed: false` on their own
   record, because their access is derived entirely through Change 2's inheritance
   mechanism (`inheritAgentControl` + the global setting + the parent's own
   `agentAllowed`), which is designed to be revocable in one motion when the parent
   repo's grant is revoked. Giving a worktree its own independent `agentAllowed: true`
   would let it survive a parent revoke, breaking that guarantee. Concretely: the
   `agentAllowed` value written by `adoptFolder()` becomes `!canonicalWorktreeParentRepo(worktreePath)`
   (true for a plain adopted folder, false for a canonical worktree, which relies on
   inheritance instead).

No migration pass, no back-fill: existing records with `agentAllowed` absent or
`false` are never rewritten, so nothing already pinned changes behavior.

### Change 2 — new worktrees inherit automatically

`readWorktreeInheritControl()` (`src/main/mcp/worktree-inherit-prefs.ts:33-41`)
currently resolves `false` for all three cases it can't distinguish: file missing
(never configured), file present but corrupt (real error), and any other read failure.
The fix distinguishes the "never configured" case from genuine errors:

- File does not exist (`ENOENT`) → resolve **`true`** (the new default).
- File exists but fails to parse, or any other read error → resolve `false`
  (unchanged — a real error still fails closed, preserving the existing invariant that
  corrupt/ambiguous state never silently widens the grant).
- File exists and parses → unchanged, `parsed?.enabled === true` wins as before (so an
  operator who explicitly turned this off keeps it off).

`decideWorktreeInheritance()` (`src/main/worktree-core.ts:86-92`) and
`withInheritedWorktrees()` (`src/main/mcp/policy-assemble.ts:128-148`) are untouched —
both already read the global setting live at every policy assembly (`server.ts:634`),
not frozen at a worktree's birth, and a worktree's own `inheritAgentControl` marker is
fail-closed and fixed at creation time (`user-projects.ts:85`: "a missing value never
inherits"). This is what makes the flip provably forward-only: an existing worktree
that predates this change already has `inheritAgentControl` fixed to whatever it was
(usually absent/false), and no later change to the global setting recomputes that
marker — only a worktree created _after_ the flip gets the new default.

The `create_worktree` confirm dialog's inherit checkbox (`worktreeInheritOffer` in
`server.ts:447-452`) already renders "checked by default, opt-out to uncheck" — that
UI is unchanged; only the setting it reflects flips.

### Change 3 — copy and disclosure updates

- Folder menu (`FolderMenu.vue`) / i18n (`en.json:223-224`, `pt-BR.json` mirror):
  relabel the primary action from "Allow agent control" to "Disallow agent control"
  as the default-visible state for a newly pinned folder (the toggle itself is
  unchanged — same field, same handler — only the label framing flips since the
  starting state flips).
- `adopt_folder`'s confirm prompt (`server.ts:414-421`) currently reads "...it becomes
  visible + actionable, and agents still need a separate per-folder grant to act in
  it." That's no longer true and must be rewritten to disclose the immediate grant
  plainly, e.g.: "Pin this existing folder into the sidebar:\n {folder}\n\nThis grants
  agent control immediately — agents can create sessions, spawn terminals, and read
  transcripts here. No files are created or changed. Turn off agent control from the
  folder menu afterward if you don't want that." No new checkbox — consistent with
  Change 1's "silent default, opt-out after the fact" shape rather than adding
  confirm-time friction.
- `create_worktree`'s confirm prompt already discloses the inherited-control sentence
  conditionally (`server.ts:448-452`); no copy change needed there beyond it now
  firing more often (since the setting defaults on).

### Change 4 — docs impact (per this repo's mandatory-doc contracts)

- `CHANGELOG.md`: dated entry under `### Changed` — user-visible default-behavior
  change, security-relevant, must be described plainly for the in-app Changelog tab.
- `docs/capy-features.md`: this changes grant/confirm semantics (what happens by
  default when a folder is pinned or a worktree created) — agent-facing per the
  self-awareness contract, version marker bump required. Run `/capy-awareness` for the
  exact editorial pass.
- `docs/user/`: whichever page documents agent control / the folder menu / worktree
  creation needs its default-state description updated (was opt-in, now opt-out).

## Non-goals / out of scope

- Non-canonical worktrees (a custom `--path` outside `<repo>/.claude/worktrees/*`)
  still never inherit — `canonicalWorktreeParentRepo()`'s restriction is unchanged.
- No retroactive migration of any existing `projects.json` record.
- No change to the fail-closed read semantics in `policy-assemble.ts` /
  `permission-core.ts` — the security-critical gate logic is untouched; only what gets
  written at creation time changes.
- The T61/T72 "Always / Only this / Deny" contextual discovery upsell
  (`server.ts:358-389`) keeps working unchanged for any worktree that predates this
  change and still needs it.

## Testing / verification plan

- Unit: `policy-assemble.test.ts` (or equivalent) — assert an existing record with
  `agentAllowed` absent still resolves not-allowed (no regression on the read path).
- Unit: `worktree-inherit-prefs` read function — assert `ENOENT` → `true`, corrupt JSON
  → `false`, explicit `{enabled:false}` → `false`.
- Unit: `adoptFolder()` — assert a canonical worktree path still writes
  `agentAllowed: false`; a non-worktree adopted path writes `agentAllowed: true`.
- Manual: pin a brand-new folder via the Add Folder dialog, confirm `get_session`
  works immediately with no separate toggle; confirm an _existing_ pinned folder
  (from before this ships) is unaffected until touched.
- Manual: create a worktree of an already-allowed repo, confirm the inherit checkbox
  is checked by default and a session in that worktree works without an extra step.
- `npm run typecheck` and `npm run build` per this repo's UI-work process.
