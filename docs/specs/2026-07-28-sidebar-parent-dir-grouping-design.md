# Sidebar parent-directory grouping — one grouping concept for git and non-git folders (design)

**Date:** 2026-07-28 · **Status:** implemented

## Problem

The sidebar groups folders by two unrelated rules, and only one of them behaves the way
operators expect.

**Git folders** collapse under a synthetic `RepoGroup` header keyed on `repoId` (the
realpath'd git common-dir probed in `src/main/git-probe.ts`). Position on disk is irrelevant:
worktrees scattered across `~/Workspace/org/proj/worktrees/**` still gather under one
"ProjectAlpha" header. This works well.

**Non-git folders** use `nestByPath` (T70 Fix B): a visible bare folder nests one level under
the **shallowest** other visible bare folder that is a strict path ancestor of it. The
shallowest-ancestor choice exists to guarantee the "anti-VS-Code" flattening — deep chains
collapse to a single level rather than a staircase — but it has a degenerate case that was
never considered: pinning a folder near the filesystem root makes it the umbrella for
everything below it, at any depth.

That case is now live on the maintainer's machine. `/home/u` was pinned on
2026-07-27T18:30 (`projects.json`, alias `junielton`). Every visible folder that is _not_
already inside a `RepoGroup` — `~/Workspace/org/api-gateway`, `~/Workspace/org/web-api`,
`~/Workspace/org/portal`, `~/.claude/skills`, single-worktree repos generally — is a
descendant of `$HOME`, so all of them flatten under a single `junielton` row that conveys
nothing about where they actually live or how they relate to each other.

Two secondary defects fall out of the same split:

- Single-worktree git repos never form a `RepoGroup` (a `repoId` needs 2+ members), so they
  fall through to the path rule and get swallowed alongside genuinely non-git folders.
- `SidebarDrillView.vue:50` filters `FolderNest` out of the drill-in root entirely
  (documented at `:31`), so a path-nested child folder is **unreachable** in drill-in mode.

## Goal

One grouping concept. A folder's umbrella is its **direct** parent directory, not its
topmost visible ancestor, and that umbrella renders even when the parent directory is not
itself a pinned or active folder.

## Decisions fixed during brainstorming

| Decision                              | Choice                                                                                 |
| ------------------------------------- | -------------------------------------------------------------------------------------- |
| Grouping key for non-git folders      | `dirname(path)` — the **direct** parent, never a deeper ancestor                       |
| Does the parent need to be pinned?    | No — the header is **synthetic**, like `RepoGroup`                                     |
| Parent directory that _is_ visible    | Becomes **member #0** of its own group (mirrors `isMainWorktree` inside a `RepoGroup`) |
| `FolderNest` (T70 Fix B)              | **Deleted** — fully replaced by the synthetic path group                               |
| Do `RepoGroup`s join a parent group?  | No — they pass through untouched at top level; the 1-level cap from T70 stands         |
| Minimum group size                    | 2 members, same as `RepoGroup`                                                         |
| Which folders participate             | All visible bare folders (pinned ∪ active), same set `nestByPath` operates on today    |
| Settings toggle / depth configuration | None (YAGNI)                                                                           |
| Changes to `groupByRepo`'s git logic  | None                                                                                   |

## Model — `src/renderer/src/stores/folder-zones.ts`

`RepoGroup` and `FolderNest` collapse into one node type:

```ts
export interface FolderGroup<F extends ZoneFolder = ZoneFolder> {
  kind: 'folder-group'
  /** Where the grouping came from: a shared `repoId`, or a shared parent directory. */
  source: 'repo' | 'path'
  /** The group key — the `repoId` for `source: 'repo'`, the parent dir for `source: 'path'`. */
  id: string
  label: string
  derivedLabel: string
  parentHint?: string
  expanded: boolean
  folders: F[]
}
```

`FolderNest` is removed. `RepoGroup` is kept only as a type alias
(`FolderGroup & { source: 'repo' }`) if that reduces churn at call sites; the runtime
discriminant everywhere becomes `kind === 'folder-group'` plus a `source` check where the two
genuinely differ (today: the header icon).

Keeping one node type is the point of the change — header rendering, the keyboard cursor,
collapse persistence, group aliases, and drill-in each stop needing a second code path.

## Pipeline — `stores/sessions.ts#visibleFolders`

```
classify → sort → groupByRepo → groupByParentDir
```

`nestByPath` is deleted. `groupByParentDir` runs on `groupByRepo`'s output and:

1. **Passes `FolderGroup` nodes through untouched.** A repo group is never a member of a path
   group and never becomes one's parent. This is what preserves the T70 1-level cap.
2. **Buckets bare folders by `dirname(path)`.** A bucket with 2+ members emits a
   `FolderGroup{ source: 'path', id: <parent dir> }` at the position of its first member.
   A bucket with one member emits that folder unchanged, at its original position.
3. **Promotes the parent as member #0.** If a visible bare folder's own `path` equals a
   bucket key, it is pulled into that bucket as the first member instead of being bucketed by
   its own `dirname`. It keeps its own sessions and its own row behavior — only its position
   changes.
4. **Resolves chains deepest-key-first.** Being the parent of a group wins over being a member
   of another group. Given visible `/a`, `/a/b`, `/a/b/c`: `/a/b` forms first (`b` promoted as
   member #0, `c` as member), which removes `b` from bucket `/a`; bucket `/a` is then left
   with fewer than 2 members and dissolves, so `a` renders as a loose row. The result is
   `a` (loose) followed by group `b` = `{b, c}` — never a three-level staircase.
5. **Disambiguates colliding labels.** The existing `parentHint` post-pass runs once over all
   groups in the list — repo and path alike — so two groups that resolve to the same label
   (e.g. two `www`) each get their own parent-dir hint.

Label resolution for a path group: the group alias if set, else `basename(id)`. The
un-aliased `basename(id)` is kept on `derivedLabel` as the reset target, matching `RepoGroup`.

## Persistence and aliases

Group ids are namespaced so a repo key and a path key can share one store:

- `collapsedRepoGroups` (`om2tab.repoGroupsCollapsed`) stores `repo:<repoId>` /
  `path:<dir>`. On read, a bare unprefixed value migrates to `repo:<value>` — existing
  collapsed repo groups survive the upgrade.
- The `repoAliases` ref is renamed `groupAliases` and its record is re-keyed the same way, so
  **renaming a path group works through the existing menu with no new UI**. The
  `localStorage` key stays `om2tab.repoAliases` — per `CLAUDE.md`, the `om2tab.*` prefix and
  existing storage keys are deliberately retained; renaming it would silently drop every
  alias the operator has already set. The same bare-value → `repo:` read migration applies.
- `toggleRepoGroup(repoId)` becomes `toggleGroup(id)` over the namespaced id.

## Rendering

- **`RepoGroupHeader.vue`** gains a `source` prop. `source: 'repo'` keeps the 13px
  `git-branch` icon; `source: 'path'` uses the 13px `folder` icon. Everything else — height,
  chevron, label, count, collapse gesture — is unchanged. **No new tokens.**
- **`Sidebar.vue`** drops `isFolderNest` and its template branch; the group branch renders
  both sources.
- **`SidebarDrillView.vue`** widens its root filter (`:50`) from "repo groups only" to "any
  `FolderGroup`", and drops the `FolderNest`-is-unreachable caveat at `:31`. Path groups
  become drillable screens, which fixes the existing unreachability defect.
- **Keyboard cursor** (`SidebarCursorKind`, `sessions.ts:507`): the `'repo-group'` kind is
  renamed `'group'` and its row id becomes the namespaced group id. The cursor holds no
  `localStorage`-backed state (verified: no persisted cursor ref in `sessions.ts`), so the
  rename needs no migration.

## Non-goals

- No two-level nesting (a repo group inside a path group). Explicitly rejected — it
  reintroduces the staircase T70 exists to prevent.
- No settings toggle and no configurable depth.
- No change to how `repoId`, `gitBranch`, or `isMainWorktree` are probed.
- The duplicate `Portal` rows (the git `RepoGroup` for `~/Workspace/org/portal/www` at top
  level, and the pinned bare folder `~/Workspace/org/portal` inside the `org` group) are
  **not** addressed. This already happens today; the design neither worsens nor fixes it.

## Testing — `tests/folder-zones.test.ts`

`groupByParentDir` is a pure function over plain objects, so every case below is a direct
unit test with no Pinia and no DOM:

| Case                                | Expectation                                                         |
| ----------------------------------- | ------------------------------------------------------------------- |
| Two siblings, parent not visible    | One `FolderGroup{source:'path'}` labeled with the parent's basename |
| One folder alone under a parent     | Emitted unchanged, no group                                         |
| Parent itself visible               | Parent is `folders[0]`; siblings follow                             |
| `/a`, `/a/b`, `/a/b/c`              | `a` loose + group `b` = `{b, c}`; never three levels                |
| `$HOME` pinned, no direct children  | `$HOME` renders loose; grandchildren keep their own parent groups   |
| `RepoGroup` in the input            | Passed through at its original index, never a member or a parent    |
| Two groups resolving to same label  | Both receive a distinct `parentHint`                                |
| Collapsed set with a legacy bare id | Migrates to `repo:` and the group still renders collapsed           |
| Input array                         | Never mutated (every grouping returns new arrays, as today)         |

Regression guard on the git path: `groupByRepo`'s grouping LOGIC is not modified, and its
behavioral assertions (membership, ordering, label derivation, position, passthrough) carry
over unchanged. Its shape assertions do change — `kind` becomes `'folder-group'`, `repoId`
becomes `id`, and the collapsed-set key becomes namespaced — because the node type is now
shared with path groups. An earlier draft of this spec claimed those tests would pass
untouched; that was wrong, and the distinction between logic and node shape is the reason.

## Rollout note

Independent of this change, the operator can unpin or hide `/home/u` today to stop
`$HOME` from swallowing the list. The design removes the failure mode; it is not the only
remedy for the current symptom.

## Contracts to satisfy

Per `CLAUDE.md`, the implementing PR is incomplete without:

- a dated `CHANGELOG.md` entry (user-visible: folder grouping changes);
- a `design.md` update — the "Path-based folder nesting (non-git — T70 Fix B)" section
  (`design.md:1483`) is superseded and must be rewritten, along with the `RepoGroupHeader`
  section that describes the git-only header;
- a `docs/user/` update if the grouping is described there;
- **no** `docs/capy-features.md` update — nothing here changes an MCP verb, an ACK shape, or
  grant semantics, so this is not agent-facing.
