# T191 — Worktree lineage in the sidebar: badge on the orchestrator, guide line on what it cut

**Status:** design approved (operator, 2026-07-31) · not implemented
**Card:** `T191` · **Sibling:** [T190](./T190-card-worktree-provenance.md) (card provenance — independent, no shared code)

## Problem

A repo with a fan-out history shows a flat list of worktrees:

```
ProjectAlpha
  PROJ
  PROJ-255-fix-cms-page-500s
  PROJ-347-responsive-image-pipeline
  PROJ-347-wave-1-image-pipeline-foundation
  PROJ-347-wave-2a-glide-serving
  PROJ-373-build-stories-discovery
  T84-bs-0-build-stories-card-component-quote-guard
  ...
```

Many of those were cut **by another worktree's session** during an orchestrated fan-out. That
parent/child relation is real and load-bearing — it is the difference between "12 unrelated
branches" and "3 orchestrators, each with its wave" — and it is completely invisible.

## Current state

**No lineage data exists anywhere.** Concretely:

- `create_worktree` does not record who asked. `createWorktree(repoPath, branch, ...)` receives
  `repoPath` as _which repo_, and drops the caller's identity on the floor.
- The MCP control server uses **one shared bearer token** for every session
  (`mcp/token-store.ts`), so it has no per-session identity to attribute a call to. This is why
  `create_card`'s provenance is stamped without a `sessionId`.
- Git cannot infer it in the common case: `create_worktree` with no `base` forks from
  `origin/main`, so a child has no commit-level kinship with its orchestrator.

Two things do work in our favor:

- The **manifest drain** already knows the origin folder — `runDrainPass(folder, deps)` calls
  `deps.createWorktree(folder, slug)`. That whole path is traceable for free.
- `projects.json` already carries per-worktree birth metadata (`inheritAgentControl`, T61), so
  there is an established, additive place to persist this.

## Approved decisions

| #   | Decision                                                                                            | Rationale                                                                                                            |
| --- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| D1  | Source of truth: **record at birth** (`create_worktree`), plus a manual override in the folder menu | Correct by construction; the manual path covers the retroactive gap                                                  |
| D2  | The badge is **structural** — a folder gets it because worktrees were born from it                  | Reflects an observable fact, not a declared role; a promoted-but-idle Orchestrator does not pollute the sidebar      |
| D3  | **One level of indentation only**; a grandchild flattens under the root mother                      | The sidebar already has repo groups and drill-in depth levels; a third variable depth is unreadable in a narrow pane |
| D4  | **Zone wins over lineage** — nesting only applies within one zone and one group                     | Otherwise lineage would drag folders out of their zone and break zone semantics                                      |
| D5  | Collapse state is **persisted by path**, like repo groups                                           | An orchestrator with 6 children is exactly the case you collapse once and want to stay collapsed                     |

## Design

### 1. Data model

`UserProject` (`src/main/user-projects.ts`) gains one optional field:

```ts
/**
 * T191: the folder whose session asked for this worktree to be cut — the
 * orchestrator. Absolute normalized path. Optional + fail-safe: absent means no
 * mother, and the folder renders flat. Recorded only when the requester is a
 * non-main worktree of the SAME repo; a create made by a human through the
 * New-worktree dialog is deliberately motherless.
 */
bornFrom?: string
```

Same additive, optional, fail-safe posture as the neighboring `inheritAgentControl`. Old
`projects.json` files parse unchanged.

**Who writes it.** `createWorktree()` gains the origin in its existing trailing options block —
the same seam `inheritOpts` already uses. Two callers pass it:

| Caller                        | Origin passed             | Rationale                                                                          |
| ----------------------------- | ------------------------- | ---------------------------------------------------------------------------------- |
| MCP `create_worktree` handler | `ctx.folder`              | In practice the orchestrator's own cwd — the only caller-identity signal available |
| Manifest drain                | the drain pass's `folder` | Already known and exact                                                            |
| New-worktree UI dialog        | _(nothing)_               | A human cut it; it has no orchestrator                                             |

**Recording guards.** `bornFrom` is persisted only when the requester path (a) is not the repo's
main checkout, and (b) resolves to a known folder of the same repo. Anything else is silently
dropped — a missing edge is always preferable to a wrong one.

**Manual marking.** `FolderMenu.vue` gains "Set parent folder" (a submenu of sibling folders in
the same repo) and "Clear parent folder", writing the same field. This is the path for the
worktrees that already exist.

### 2. Rendering

The sidebar pipeline today is `classify → sort → groupByRepo → groupByParentDir`. Lineage nesting
is a **new pure pass appended to that chain**, in `stores/folder-zones.ts`:

```ts
/**
 * Nest each folder under its `bornFrom` mother, within one group. Pure: same
 * input, same output, no I/O. Applies D3 (flatten past one level) and D4 (never
 * nest across a zone or group boundary).
 */
export function nestByLineage<F extends ZoneFolder>(folders: readonly F[]): LineageNode<F>[]
```

Rules the function enforces:

- A child whose mother is not in the **same zone and same group** stays flat (D4).
- A grandchild is re-parented to its root mother, so depth never exceeds one (D3).
- A cycle (A born from B, B born from A) is broken by dropping the edge that closes it; both
  render flat.
- A mother that no longer exists on disk or is hidden leaves the child flat — never orphaned,
  never hidden.
- Existing sort order applies among siblings; children sit immediately below their mother.

### 3. UI

**Badge on the mother** (`SidebarFolder.vue`): a fork glyph plus the child count, in the existing
folder-row badge slot. Present only when the count is ≥ 1 (D2). Clicking it collapses/expands the
children.

**Children**: indented one level, with a 1px `border-border-2` guide line running down their
column, anchored under the mother. New folder-row variant in `design.md` §6.

**Collapse** (D5): persisted by path through the same mechanism the repo groups use. A collapsed
mother still shows its badge count, so the information is never hidden by the collapse.

This is presentation only — it does not interact with the drill-in depth levels, which change
_which_ folders are listed, not how they nest.

### 4. Error handling and edge cases

| Case                                         | Behavior                                                                                                    |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Mother deleted from disk / removed from Capy | Child renders flat. Never hidden.                                                                           |
| Mother hidden by the operator                | Child renders flat (mother is not in the same visible group).                                               |
| Mother is the repo's main checkout           | Edge never recorded (guard b) — everything would nest under main.                                           |
| Cycle                                        | Closing edge dropped; both render flat.                                                                     |
| Depth > 2                                    | Flattened to the root mother (D3).                                                                          |
| `bornFrom` points outside the repo           | Ignored at read time, not only at write time.                                                               |
| Agent sets a nonsense `bornFrom`             | Not possible — no verb writes it directly; only `create_worktree`'s guarded path and the human folder menu. |

### 5. Testing

- `nestByLineage` unit (pure, no Electron): flat input, one mother with N children, grandchild
  flattening, cycle, missing mother, cross-zone mother, cross-group mother, sibling sort
  preservation.
- `user-projects` unit: `bornFrom` round-trip; an old file without the field parses; setting and
  clearing it via the manual path.
- `createWorktree` unit: records the origin on the MCP and drain paths; records **nothing** on the
  human dialog path; drops it when the requester is the main checkout or a foreign repo.

### 6. Mandatory contracts (definition of done)

- `CHANGELOG.md` — dated entry under `### Added`.
- `design.md` — §6 gains the orchestrator badge and the indented-child folder-row variant, plus
  the guide-line spec. Written **before** implementation.
- `docs/user/` — the sidebar page documents the badge, the nesting, and the manual "Set parent
  folder" action.
- `docs/capy-features.md` + version-marker bump — `bornFrom` surfaces in the `create_worktree` ACK
  and in `list_worktrees`, i.e. a new field the agent should read.
- `en.json` **and** `pt-BR.json` in the same change for every new key.

## Out of scope

- Inferring lineage from branch-name prefixes. Rejected: it breaks on exactly the observed cases
  (`T84-bs-0-build-stories-*` shares no prefix with `PROJ-373-build-stories-*`).
- Per-session caller identity in the MCP server (a per-session token). That is a much larger
  change; `ctx.folder` is the pragmatic signal and is accurate in practice.
- A lineage view anywhere other than the sidebar.
- Anything on the roadmap board — that is [T190](./T190-card-worktree-provenance.md).
