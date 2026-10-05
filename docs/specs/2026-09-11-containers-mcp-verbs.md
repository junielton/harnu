# Spec — Containers MCP verbs (T328, T329)

**Parent:** T320 · **PRD:** [`docs/prds/T320-containers-takeover.md`](../prds/T320-containers-takeover.md) ·
**Parity source:** [`smoke-test.md` §4, §6](2026-09-10-containers-view/smoke-test.md)

## Principle

Every action the Containers takeover offers the operator has an agent verb. Each verb calls the
**same main-process function** as the UI (PRD §3.4), so tiers are enforced once. Gate postures
follow the existing precedents in `src/main/mcp/tool-catalog.ts`:

- **Reversible actions run free,** like `archive_card`.
- **Irreversible actions always ask,** like `delete_card` and `delete_worker`.
- **When the input carries the risk, the input triggers the confirm,** like `update_worker`
  (`forceConfirmFor`).

## Verbs

### `list_containers` (T328)

|           |                                                                                                                                                                                                                                                                                          |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Input     | `{ folder?: string }`: limits the listing to one repo and its worktrees.                                                                                                                                                                                                                 |
| Gate      | `mutates: false`, `discloses: 'paths'`                                                                                                                                                                                                                                                   |
| ACK       | `{ ok: true, scannedAt, dockerAvailable, totals, stacks[], recent[] }`: the `ContainersSnapshot` unchanged, with paths redacted to aliases (`folderAlias`) the way `list_workers` redacts them. A stack attributed to a blocked folder still lists, carrying `agentControllable: false`. |
| Refusal   | `DOCKER_UNAVAILABLE`, with the one-line docker error. It is never an empty list.                                                                                                                                                                                                         |
| Scheduler | Added to the observe-mode **allowlist** in `src/main/scheduler-core.ts`.                                                                                                                                                                                                                 |

### `stop_containers` (T329)

|                      |                                                                                                                                                                             |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Input                | `{ stacks: string[] (1..n), force?: boolean }`                                                                                                                              |
| Gate                 | `mutates: true`, `silentAllowInAgentFolder: true`, `forceConfirmFor: (i) => i.force === true`                                                                               |
| Refusals (per stack) | `STACK_NOT_ATTRIBUTABLE` (unknown, always, even with `force`) · `STACK_IN_USE` (active, unless `force`) · `STACK_PROTECTED` (protected, unless `force`) · `STACK_NOT_FOUND` |
| ACK                  | `{ ok, results: [{ stack, ok, freedBytes, portsReleased, error? }] }`. A partial failure is reported per stack, never swallowed.                                            |

### `start_containers` (T329)

|                      |                                                                                   |
| -------------------- | --------------------------------------------------------------------------------- |
| Input                | `{ stacks: string[] (1..n) }`                                                     |
| Gate                 | `mutates: true`, `silentAllowInAgentFolder: true`                                 |
| Refusals (per stack) | `WORKTREE_GONE` (orphan) · `STACK_NOT_ATTRIBUTABLE` (unknown) · `STACK_NOT_FOUND` |
| ACK                  | `{ ok, results: [{ stack, ok, error? }] }`                                        |

### `remove_containers` (T329)

|          |                                                                                                                                                                                                  |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Input    | `{ stack: string, removeVolumes?: boolean }`: exactly **one** stack per call; there is no bulk form.                                                                                             |
| Gate     | `mutates: true` and **no** `silentAllowInAgentFolder`, `grantable` or `alwaysAllowable`, so it **always asks**.                                                                                  |
| Refusals | `STACK_RUNNING` (stop it first; the verb never uses `--force`) · `STACK_IN_USE` (active) · `STACK_PROTECTED` · `STACK_PENDING` (not a zombie yet) · `STACK_NOT_ATTRIBUTABLE` · `STACK_NOT_FOUND` |
| Order    | Containers first, then volumes when `removeVolumes` is set.                                                                                                                                      |
| ACK      | `{ ok, stack, removedContainers: string[], removedVolumes: string[], restoreHint? }`                                                                                                             |

## Shared rules

- **Audit trail.** Every mutating call writes **one** tombstone to the containers journal with
  `actor: 'agent'`. It appears in the UI's "Recent" list and in `list_containers.recent`.
- **Observe mode.** `stop_containers`, `start_containers` and `remove_containers` are added to the
  observe-mode **deny list** in `src/main/scheduler-core.ts`. An observe worker can watch but
  never act.
- **Parity test.** A test asserts that the set of verbs accepted by the main-process action
  function equals `{stop, start, remove}`, and that each maps to one containers MCP op. Adding a
  UI action without an agent verb, or the reverse, then fails CI.
- **Contracts, in the same change as each verb:**
  - `docs/capy-features.md`: a prose section, the verb name in the index sentence
    (`tests/capy-features-verb-roster.test.ts`), and a bump of the version marker;
  - `docs/user/agent-control.md`;
  - `CHANGELOG.md`.
- **Sequencing.** T328 lands before T329. Both edit `tool-catalog.ts`, `MCP_OPS`, the
  `capy-features.md` index and version marker, and `agent-control.md`.
