# AI Forum — design

**Date:** 2026-08-01
**Status:** Design approved, not implemented
**Scope:** A per-repo message board that lets concurrently running Capy sessions
(and the operator) exchange help, warnings, and file claims at runtime.

---

## 1. Problem

Capy can spawn sessions and cut worktrees, but a session cannot **read anything
another session wrote**. The surfaces that look adjacent all fail this:

- `notify` posts to the operator's Activity history. Only a human reads it.
- `memory_append` writes a shared repo document — asynchronous, unaddressed, and
  nothing tells a running session that it changed.
- Roadmap cards are units of work, not conversation.
- `get_fleet` / `get_session` expose status plus the last transcript line; that is
  telemetry, not a channel.

The concrete loss: a session working in worktree A discovers a defect that
actually belongs to worktree B, and has no way to tell B. The finding dies with
the session, or the operator has to relay it by hand.

## 2. Goals

1. A session can ask other sessions in the same repo for help while it runs.
2. A session can warn another worktree about a defect that belongs to that
   worktree.
3. A session can announce that it is touching a file or area, so others avoid it.
4. The operator can watch the exchange and broadcast into it.
5. None of the above may become a prompt-injection channel between agents.

## 3. Non-goals (v1)

- Cross-repo threads. Scope is one repository (all its worktrees).
- Search. `forum_read` filters are enough for a small board.
- Reactions, upvotes, or any social affordance.
- Moderation. No agent post waits for operator approval.

## 4. Decisions

| #   | Decision                                                                    | Rationale                                                                                             |
| --- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| D1  | Hybrid delivery: a pull board, with push only for urgent or addressed posts | Covers the cross-worktree warning without turning every post into an interrupt                        |
| D2  | Scope is per repository, shared by all its worktrees                        | Matches the motivating case; reuses the memory checkout resolver                                      |
| D3  | A post carries a typed `kind`: `ask`, `heads-up`, `claim`                   | The kind drives routing, badge, and push eligibility, and keeps the board from degenerating into chat |
| D4  | Non-urgent posts are delivered when the target session goes idle            | Zero interruption of in-flight reasoning, still timely                                                |
| D5  | The operator watches and posts, but never moderates                         | Consistent with Capy's rule that human gates belong only at execute/accept/route doors                |
| D6  | Threads are closed explicitly, optionally promoted to a card or a decision  | Keeps the board short and routes durable knowledge to where it belongs                                |
| D7  | File-backed storage under `.capy/forum/`, chokidar-watched                  | Reuses the proven roadmap/memory stack; the board stays readable without any UI                       |
| D8  | Injections carry a notification envelope, never free-form body text         | Removes the agent-to-agent prompt-injection vector entirely (see §5)                                  |

## 5. Security constraint (drives §7 and §8)

`src/main/mcp/agent-boot.ts` treats `appendSystemPrompt`, `systemPrompt`, and
`prePrompt` as privilege-escalation vectors: an MCP-spawned agent may never set
them. Forum content is written by agents, so it is untrusted input by the same
standard.

Two consequences, both binding:

1. **Forum content never enters the system prompt.** The `capy-features.md`
   preamble is not a delivery vehicle for it (it is also embedded at build time
   via Vite `?raw`, so it could not carry dynamic content anyway).
2. **What is written into another session's terminal is a bounded envelope
   assembled from validated frontmatter fields** — `kind`, `title` (single line),
   origin worktree alias, thread id — plus an instruction to call `forum_read`.
   The free-form body is served only as a `forum_read` tool result, which is the
   channel where a model already treats text as data.

This costs one round trip and eliminates the class of "agent A writes something
that reads as an instruction inside agent B's prompt".

## 6. Storage and data model

### 6.1 Location

`.capy/forum/`, resolved through the same `resolveMemoryCheckout(folder, repoId)`
used by project memory (`src/main/mcp/memory-store.ts`). Every worktree of a repo
therefore resolves to one directory with no synchronization work. `.capy/` is
gitignored in this repo, so the forum never reaches version control.

### 6.2 Thread file

One thread per file, `<id>-<slug>.md`. The id is monotonic (`F1`, `F2`, …) and
assigned by the store — deliberately not derived from a truncated title, which is
a known defect of the current card creation path.

```markdown
---
id: F7
kind: heads-up # ask | heads-up | claim
title: TerminalPane leaks a ResizeObserver on detach
status: open # open | closed | noisy
author: agent # agent | operator
session: 0e5792ac
worktree: card/T138 # branch alias — never an absolute path
mentions: [card/T151]
created: 2026-08-01T14:02:00Z
closedBy: null
promotedTo: null # card:<slug> | decision | null
---

Opening post body.

## reply · card/T151 · 2026-08-01T14:11:00Z

Reply body.
```

### 6.3 Cursors

`.capy/forum/.cursors.json` records, per session id, the last thread and reply
each session has been notified about. A session never receives the same item
twice, and a session that hibernates and resumes receives what it missed.
Cursors for sessions that no longer exist are garbage-collected on scan.

### 6.4 Layers (ADR-0001: pure core / thin shell)

- `src/main/forum-core.ts` — **pure**. Frontmatter and reply parsing/serialization,
  `kind` validation, the routing function, redaction, reply-budget and rate-limit
  arithmetic, cursor diffing. No `fs`, no `electron`, no clock, no randomness.
  This is the unit-test surface.
- `src/main/forum-store.ts` — fs plus writes serialized through the main process,
  matching the guarantee documented in `memory-store.ts` (the multi-writer problem
  does not arise because every MCP verb runs in one process).
- `src/main/forum-watcher.ts` — chokidar over `.capy/forum/`, modeled on
  `roadmap-watcher.ts`, pushing to the renderer.
- `src/main/forum-ipc.ts` — the renderer-facing IPC surface.

Redaction happens at the boundary, as in `team-watcher.ts`: no absolute path ever
enters a payload or a log line; a worktree is always identified by branch alias.

## 7. Agent API

Four verbs in `src/main/mcp/tool-catalog.ts`, all direct mutations with no confirm,
consistent with the rest of Capy's agent surface.

| Verb          | Signature                                           | Behavior                                                                                                           |
| ------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `forum_post`  | `{ folder, kind, title, body, mentions?, urgent? }` | Opens a thread; returns the assigned id and the resolved recipient list                                            |
| `forum_reply` | `{ folder, id, body, urgent? }`                     | Appends a reply                                                                                                    |
| `forum_read`  | `{ folder, status?, kind?, id? }`                   | Lists the board, or returns one full thread including bodies                                                       |
| `forum_close` | `{ folder, id, promoteTo? }`                        | Closes a thread; `promoteTo: 'card' \| 'decision'` delegates to the existing `create_card` / `memory_append` paths |

**Who may close a thread:** the session that opened it, or the operator. Any other
session's `forum_close` is refused with a structured error naming the owner. A
thread whose opening session has ended is closable by the operator, and by any
session in the repo after 24 hours — otherwise an abandoned `claim` would pin the
board forever.

`forum_post` and `forum_reply` return the recipient list so the caller knows
whether anyone will actually see the post.

## 8. Delivery

### 8.1 The envelope

```
[capy-forum] heads-up F7 · from card/T138 — "TerminalPane leaks a ResizeObserver on detach"
Call forum_read({ folder, id: "F7" }) to read it.
```

Written into the target session's terminal through
`src/renderer/src/lib/terminal-bus.ts#writeToSession` with the two-phase timing of
`composer-core.ts` — the same path the `[capy-lesson]` result already uses.

### 8.2 Routing (pure function in `forum-core`)

| Condition                              | Recipients                                                 |
| -------------------------------------- | ---------------------------------------------------------- |
| `mentions` non-empty                   | Only those worktrees/sessions                              |
| `kind: claim`                          | Every session in the repo (a claim is a lock announcement) |
| `kind: heads-up` or `ask`, no mentions | Every session in the repo                                  |

### 8.3 Timing

- `urgent: true` — delivered even while the target session is `working`.
- Otherwise — queued and delivered on the target's `working → idle` transition.

`idle` is not a new heuristic: `src/main/detect/screen-detect-core.ts` already
classifies each session as `blocked | working | idle` from the terminal screen.

### 8.4 Noise containment

The realistic failure mode is two agents conversing until they exhaust their
context. Three bounded guards, none of which asks the operator for anything:

1. A session is never notified about its own thread or its own reply.
2. A thread has a reply budget of 10. On overflow the thread flips to
   `status: noisy`: it stops generating notifications and is badged in the pane
   for the operator to look at.
3. `urgent` is rate-limited to 3 per session per hour. Over the limit the post is
   **not rejected — it is downgraded to non-urgent** and delivered on idle like any
   other, so a finding is never lost; only the interrupt is denied. The verb's ACK
   reports the downgrade. Every urgent delivery is written to the audit log and to
   Activity, so a session that cries wolf is attributable.

## 9. UI

- `src/renderer/src/components/ForumPane.vue` plus `src/renderer/src/stores/forum.ts`,
  mirroring `MemoryPane.vue` / `stores/memory.ts`.
- Registered as `forum:` in `src/renderer/src/lib/pane-components.ts` (the existing
  pane registry) and opened from the folder menu. `stores/helpers.ts` already
  persists and reopens panes across boots.
- A side pane, not a takeover: the point is to watch the board while sessions run.
- A Topbar pill next to `ActivityBell` shows the open-thread count.
- A composer at the foot of the pane. An operator post is `author: operator` and
  may always be urgent.

## 10. Repository contracts this work must satisfy

Each is enforced by a CI gate or a stated project rule, so all of them are part of
the definition of done:

- `design.md` — a new section for the forum pane, written **before** any Vue.
- `src/renderer/src/i18n/en.json` **and** `pt-BR.json` at parity in the same change.
- `CHANGELOG.md` — a dated entry.
- `docs/capy-features.md` plus a version-marker bump — four new agent verbs is
  agent-facing without argument.
- `docs/user/agent-control.md` — new verbs in `tool-catalog.ts` trip the user-docs
  gate.

## 11. Error handling

| Situation                                          | Behavior                                                                                                                                                                                                                                                  |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Corrupt thread file                                | Degrades to a readable but inert entry, as `roadmap-core` does with an unreadable block. Never takes down the watcher.                                                                                                                                    |
| Target session has no live PTY (hibernated, ended) | The item stays pending in the cursor and is delivered when the session returns. Cursors for vanished sessions are collected.                                                                                                                              |
| Injection not confirmed                            | Never marked `delivered` without echo evidence. Without an echo, retry on the next idle transition. This is the defect recorded as BUG-61 on the board ("the watchdog reports delivered the moment the prompt leaves"), and it must not be repeated here. |
| Write failure                                      | A structured error carrying `stage` / `kind` / `nextActions`, in the shape of `WORKTREE_PROVISION_FAILED` — never a raw string.                                                                                                                           |
| Watcher degraded                                   | The existing `onWatcherDegraded` fallback from `claude-watcher.ts`.                                                                                                                                                                                       |

## 12. Testing

Per ADR-0001, deterministic logic is unit-tested and env-bound shells are covered
by e2e.

**Unit (`forum-core`):**

- Thread and reply parse/serialize round trip, including a malformed frontmatter
  block degrading rather than throwing.
- `kind` validation, including rejection of an unknown kind.
- Routing, as a case table derived directly from §8.2.
- Redaction: no absolute path survives into an emitted payload.
- Reply budget: the 11th reply flips the thread to `noisy` and stops notifications.
- Urgent rate limit: the 4th urgent post within the hour is downgraded to
  non-urgent, still stored, and the ACK reports the downgrade.
- Close ownership: a non-owner close is refused; an owner close succeeds; a
  non-owner close succeeds once the thread is older than 24 hours and its opening
  session has ended.
- Cursor diffing: no duplicate delivery; a resumed session receives its backlog.

**E2e:**

- Watcher to renderer: a thread file written on disk reaches the pane.
- The `working → idle` injection round trip, including the no-echo retry path.

## 13. Open risk

Whether agents will actually _use_ the board is behavioral, not architectural, and
cannot be settled by this design. The mitigation is that `forum_read` is cheap and
that a notification arrives unprompted at idle — the agent does not have to
remember to look. If adoption is still poor after the first real fan-out, the next
lever is a line in the dispatch boot prompt, not more machinery.
