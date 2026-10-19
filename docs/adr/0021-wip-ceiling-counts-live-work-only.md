# ADR-0021 — The WIP ceiling counts live work only, is configurable per repo, and never pauses the drain silently

**Status:** Accepted
**Date:** 2026-10-19
**Author:** agent (BUG-197)
**Technical context:** `src/main/roadmap-core.ts` (`computeWipVerdict`), `src/main/manifest-drain.ts`, `src/main/manifest-drain-shell.ts`, `docs/specs/T80-roadmap-kanban-rebuild.md` §3.5, `docs/specs/2026-07-19-autonomous-dispatch-manifest.md`, `docs/specs/T213-resume-dispatch.md`

---

## 1. Context

The Roadmap board has an In Progress **WIP ceiling** (`WIP_LIMIT = 5`). The manifest drain (`runDrainPass`) stops dispatching stamped Ready cards when the In Progress count reaches it.

**Why the ceiling exists.** It is a supervision limit, not a throughput limit. One operator can usefully watch four or five agents at once (Cummings' simultaneous-supervision ceiling, T80 §3.5); past that, sessions stall unseen, approvals queue up and review quality drops. The rule only makes sense if "In Progress" means "an agent I am currently responsible for supervising".

**What went wrong (observed 2026-10-19).** A card enters In Progress when a dispatch binds a session to it and leaves only when somebody moves it. A card whose session died therefore keeps its slot forever, and nothing says so. A stamped BUG-196 manifest sat undispatched because five cards were In Progress and four were dead: BUG-128, BUG-149 and BUG-171 were bound to `synthetic-…` ids that never materialized (last touched 2026-10-06, -01 and -09), and T316 had already shipped (2026-09-09). The drain paused with no notice. The operator only found out by counting the column. The limit was hardcoded, so there was no knob either.

Three defects, one root cause: the ceiling measured **bookkeeping** (cards in a column), not **supervised work**.

## 2. Decision

**D-1 — The ceiling counts live work only.** An In Progress card counts toward the ceiling only if its bound session is live. One pure function, `computeWipVerdict` in `roadmap-core.ts`, makes that decision; the drain and the board both consume its output, so they cannot disagree.

A card is **live** when its bound session is:

| Reason     | Meaning                                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------- |
| `process`  | a PTY process is attached to it (working or idle)                                                       |
| `parked`   | hibernated: process killed to reclaim memory, conversation intact, resumable (never death — see T119)   |
| `recent`   | it has a real transcript with activity inside the last `WIP_STALE_AFTER_DAYS`, with no process attached |
| `spawning` | a `synthetic-…` id with no process yet, bound less than `WIP_SPAWN_BACKSTOP_MS` ago (still booting)     |
| `unknown`  | the liveness facts are unavailable (fleet model not ready). Fails toward the old behaviour: it counts.  |

A card is **stale** (excluded from the count, flagged on the board) when it has:

| Reason            | Meaning                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------- |
| `no-session`      | it is In Progress with no session bound                                                       |
| `unmaterialized`  | a `synthetic-…` id with no process, never seen to migrate, bound longer than the backstop ago |
| `unknown-session` | a real session id with no transcript on disk                                                  |
| `inactive`        | a real transcript with no process, not parked, and no activity for `WIP_STALE_AFTER_DAYS`     |

**D-2 — The constants.**

- `WIP_STALE_AFTER_DAYS = 7`. A weekend or a long holiday weekend (2–4 days) must never flip live work to stale; a week of silence on a card nobody has touched is not supervised work on any reading. The four incident cards were 10, 13, 18 and 40 days old, so 7 catches all of them with margin. It is a named constant, not a setting: a second knob would let the two definitions of "dead" drift apart.
- `WIP_SPAWN_BACKSTOP_MS = 60 min`. The same backstop the in-flight session registry uses (ADR-0003 and `inflight-session-registry.ts`): comfortably past the worst observed legitimate boot (~24 min), so a slow boot is never flagged, while a spawn that never materialized stops holding a slot within the hour.

**D-3 — Staleness is a flag with a one-click fix, never an automatic move.** A stale card shows a badge with two actions: **Move to Review** and **Move to Backlog**. Both go through the existing human status-write path (`roadmap:setStatus`); neither is a new door, and `done` stays reachable only by the operator's Close. The board never moves a card by itself: the markdown file stays the source of truth and an agent never moves a card (T80 §0).

**D-4 — A paused drain says so, once.** When a pass leaves stamped Ready cards unattempted at the ceiling, the terminal drain event carries the ceiling, the live count and the cards holding the slots. The renderer raises one Activity notice for that pause and shows a paused state on the board's WIP chip. The same pause (same ceiling, same holders) does not notify again; the memory resets when the pause ends.

**D-5 — The limit is a per-repo setting.** It is stored on the project record (`wipLimit`), resolved exactly like `autoOrganizeCards`: own value, else the parent repo's for a canonical worktree, else the default 5. It is bounded to `1…10` (`WIP_LIMIT_MIN`/`WIP_LIMIT_MAX`) and clamped on read and write, so a hand-edited file cannot produce a limit of 0 (drain never runs) or 500 (no brake). The limit, the verdict and the stale flags are computed in main and read by the renderer over IPC, so the drain and the board read **one** value and apply **one** rule. There is no second copy of the rule to keep in sync.

## 3. Alternatives considered

| Option                                                 | Why not                                                                                                                                                                                    |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Keep counting cards; tell the operator to clean up** | This is today's behaviour. It failed silently on the first real manifest, and the cleanup is exactly the bookkeeping the ceiling should not depend on.                                     |
| **Auto-move dead cards out of In Progress**            | A card moves only by a human act (T80 §0). A wrong guess would also hide work that is resumable (`parked`). A flag plus one click keeps the operator in charge at one gesture's cost.      |
| **Hook the session exit to release the slot**          | Not every death has an exit event (an app crash, a card bound to a spawn that never booted, a shipped card nobody moved). Derived liveness is correct regardless of how the session ended. |
| **Mirror the rule in the renderer**                    | Two implementations of "dead" drift. The renderer asks main for the verdict instead, and still draws it synchronously from the last answer.                                                |
| **Make `WIP_STALE_AFTER_DAYS` a setting**              | One more knob, and the drain and the board must agree on it. A constant with a recorded rationale is easier to reason about; revisit if a real need shows up.                              |
| **Remove the ceiling**                                 | It is the supervision brake the manifest drain relies on (`2026-07-19-autonomous-dispatch-manifest.md`). The fix is to make it measure the right thing and explain itself.                 |

## 4. Consequences

- **The count can now go down by itself.** A session that stops, or is parked and then idle for a week, frees its slot without anyone touching the board. The header chip shows the live count against the limit, and stale cards are still listed (with the badge) so nothing disappears silently.
- **A card bound to a synthetic id relies on a main-side alias.** A card's `session` stays the `synthetic-…` id forever, even after the session migrates to a real uuid. Main therefore records `synthetic → real` aliases when the PTY index re-keys (`PtySessionIndex.rekey`). The alias lives in memory: after an app restart, a synthetic-bound card with no process is judged by the backstop alone, so it can read as stale once its bind is more than an hour old even though its transcript is resumable. The cost of that mistake is one badge and one click, and the card is never moved for the operator. Persisting the real id on the card is possible later but writes a controlled field; it is out of scope here.
- **The drain reads a bit more state per pass** (the fleet model, in memory, and one `stat` per In Progress card). Passes are debounced and single-flight, so this is not a hot path.
- **`unknown` fails toward counting.** If liveness cannot be read, the ceiling behaves as it did before this change. The failure mode is "same as yesterday", never "the brake is off".
- **Unchanged:** drain order (the declared manifest order), manifest stamp semantics, and the exclusion of `internal`-substrate cards.
