# ADR-0025 — One Mission → Milestone → Step model; the Campaign, the steward and the owner-session mission are retired

**Status:** Accepted under the operator's standing mandate of 2026-11-14 (the calls inside are listed in the spec's Open decisions table and await their review)
**Date:** 2026-11-14
**Author:** agent (T703)
**Supersedes:** ADR-0015 (the goal file becomes structured data; `agentControlled` children report by native SendMessage; the mission is owned by one session) and ADR-0023 (a Campaign is a separate record above the Mission; a chapter is a mission). ADR-0023 section 5 ("Revisit when") named the trigger: the operator wants to restructure chapters, which breaks the append-only, one-mission-per-chapter rule.
**Technical context:** `docs/specs/2026-11-14-missions-v4/spec.md`, `docs/prds/T703-missions-v4.md`, `docs/design/missions-v4/`

---

## 1. Context

ADR-0015 made the mission a structured record owned by one session, with a flat list of steps and a fixed last step. ADR-0023 added a second record above it, the Campaign, whose chapters are missions bound by id, because one mission could not hold a 110-row plan. Since then a steward, a merge batch, gates, a ledger and three popovers were added on top. Measured on 2026-11-14: six state vocabularies, three disagreeing "waits on you" lists, 14 surfaces, about 3,900 lines of mission logic inside the MCP handler file, 22 verbs, and a mission that dies with the session that owns it.

Five facts from real use force a new decision rather than another layer:

- A real 10-chapter delivery needed milestones that run ahead of each other, optional ones, and chapters that have no steps until they start. The campaign record models some of this and the mission file none of it.
- ACs lived in card bodies while the mission kept one verdict per step; a human check was sometimes really a fact ("CI is green once the fix lands").
- A session Harnu spawns holds no Harnu verbs (BUG-253), the reason ADR-0015 decision 2 sends everything through the owner. A step's own session therefore cannot report on its step, and a verifier cannot record a verdict.
- ADR-0015 ties the mission to its owner session and the skills forbid handing it on, so a long delivery either compacts the leader repeatedly or dies with it.
- The steward (ADR-0023 follow-on) has three open defects and was never wired into the campaign map.

## 2. Options

| Option                                                                                                                                                                               | What it is                                                                                                                                                  | Verdict                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. One record, three levels: Mission, optional Milestone, Step (a board card when it is dispatched), with criteria on the step; the mission is durable and sessions attach to it** | A Campaign is a Mission, a Chapter a Milestone. Sessions are listed in the mission with a role; the operator decides every hand-off. The steward is retired | **Chosen**                                                                                                                                                                                               |
| B. Keep Campaign and Mission, redesign only the surfaces                                                                                                                             | The earlier proposal in the diagnosis (phases 1 to 3)                                                                                                       | Rejected: it keeps two records, two derives, six vocabularies and the owner-bound mission; the operator asked to rethink from the concept                                                                |
| C. Merge the Mission into the board (an epic card with child cards)                                                                                                                  | The board already has cards and a WIP ceiling                                                                                                               | Rejected again, for ADR-0023's reason: a card is an intention; nothing on the board derives progress from pull requests, criteria or sessions. A dispatched step _is_ a card, but the mission is not one |
| D. Keep ownership by one session and add a "resume" verb                                                                                                                             | Smaller change to ADR-0015                                                                                                                                  | Rejected: the mission must outlive its sessions, and a verb the agent calls would let a session switch itself, which the operator ruled out                                                              |

## 3. Decision

**A.** The rules chosen, as the spec details them:

1. **The model.** Mission (title, Done when, optional milestones, steps, sessions, links), Milestone (optional, can be marked optional and can wait for another), Step (one pull request, a board card only when dispatched, with acceptance criteria). A mission with no milestones is valid. The fixed step "Delivered and verified" is replaced by the operator confirming Done when at close.
2. **One state vocabulary.** A step is to do, running, waiting for review or done; blocked is a mark. Milestones and the mission derive from steps. More than one milestone may be open at once. Progress is derived once, server-side, by a pure function with no side effects; a read never writes.
3. **Four ways to settle a criterion:** a fact Harnu reads (derived, sticky, never stored), a second session, the operator, or another person the operator marks. A self-check never settles. This keeps ADR-0015 decision 4's honesty (convention and audit) and strengthens it where it can: for a session Harnu spawned, identity comes from a scoped credential.
4. **A dispatched step is a board card.** The mission file holds the criteria (single source); a card exists only when the step is dispatched, and carries mission, milestone and step fields and a marked block that only Harnu rewrites. A step the leader does itself has no card. Harnu never moves a card to Done.
5. **Sessions attach.** A session sees and touches only the mission it is attached to; attaching needs the operator's confirmation, except for the session that creates the mission (it leads it) and for sessions dispatched for a step (workers with scoped verbs). The mission keeps a history of sessions (role, from, to, where each stopped). A hand-off is always the operator's decision and starts from a deterministic summary. This reverses the rule in ADR-0015's skills that forbids it.
6. **Doors stay the operator's.** The agent can request a close and ask to attach; the operator closes, discards, marks, approves a new Done when, allows or denies. Close is never refused; open matters are warnings. Agents add to a plan and never shrink it.
7. **The steward is retired** in two steps: at runtime first (no new steward, workers and hooks removed at boot, no mission file written), its code deleted last. The leader and the observe-mode watchdog replace its moves. `rebase_stack` stays.
8. **Verbs go from 22 to 16.** Campaign verbs fold into mission verbs; checks and verification become criteria verbs; owner transfer becomes attach plus a door; the goal-file importer goes.
9. **A v4 build never modifies a v3 file.** v4 records live in their own directory, `.harnu/missions-v4/`. A v3 record is read as a v4 view with no write; the first v4 write for a mission born in v3 creates its v4 record by copy and leaves the v3 file byte-identical. A campaign converts by copy into one new mission with a deterministic id, and sidecars make the old ids resolve. This is stronger than an archive copy because the operator runs an installed build of the current version beside any build of main, and a rewritten v3 file would no longer open there.
10. **The writing contract is enforced by refusal**, never by rewriting: caps of 60, 45, 50, 90 plus 60, 70 and 16 characters on write, never on read.
11. **The surface is one Mission pane** in the helper stack, following the selected session. The popovers, the steward dialog and block, and the review and bulk-close dialogs are removed (chapter 1 already removed the Campaign map and the merge dialog), last, after every caller has moved: the new is added before the old is removed, and a test checks that no skill or doc names an unregistered verb at any slice.
12. **Who may read and write.** Write only from an attached session; read the detail from an attached session and from a Harnu system worker bound to the folder; list one-line rows to any session in the folder. A session that creates a mission leads it with no confirmation; proactive missions are created by the session itself, never by Harnu.

## 4. Consequences

- Reading and converting are pure functions, so the compatibility test (frozen fixtures, byte equality) is cheap and exact.
- An installed older build never sees a v4 record: it keeps showing the mission at its last v3 state and never fails. Work done in the installed build on a mission after its first v4 write is not seen by the v4 build, so a live mission should be worked in one build. This is the price of one model with no destructive rewrite.
- The CI contracts that pinned v3 skill text (16 test files) are replaced by per-skill v4 tests; the 16 behaviour-eval scenarios are rewritten.
- Closing many finished missions costs one click each, because the cross-mission review and bulk-close dialogs are gone (flagged for the operator's review).
- A step done on a card still in Review leaves the card in Review until the operator closes it on the board.
- The awareness doc's mission text drops from about 6,900 words to at most 2,000, which lowers the cost of every session and removes the lineage tags that meant nothing to a session.
- A session Harnu spawns gets a scoped credential, which also closes BUG-253 for missions and gives Harnu an authenticated identity for the first time for those sessions.

## 5. Revisit when

Several orchestrators must work at once, or two milestones must be planned in parallel (both deferred by the operator); an agent needs to shrink a plan (today only the operator can); a view across missions or sessions is wanted again; or Harnu can read an agent's own step list from the transcript (today no transcript carries one), which would make an automatic timeline for sessions with no mission possible.
