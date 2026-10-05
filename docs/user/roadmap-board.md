# Roadmap board

The roadmap board is a kanban for a repo's backlog, opened per folder — from the folder's context menu → **Roadmap board**, or from the **kanban icon** in the topbar's right-hand button row (it opens the board for the selected session's repo, is highlighted while the board is open, and closes it again on a second click — as do Esc and clicking any session). It's meant to be a shared space between you and any Claude sessions working on the repo: an agent can draft, refine, and reorganize cards on its own, but launching one as an actual running session always goes through a step you control.

## Columns and cards

Cards move through five columns: **Backlog → Ready → In progress → Review → Done.**
The board header shows an "N cards · M working" count at a glance — N is every
non-Done card that survives your current filters, M is how many bound sessions are
actively working right now, regardless of filtering.

Each card shows a live status dot mirroring the sidebar (working / needs you / stuck / idle) when it's bound to a running session, a title, who authored it (a bot icon for agent-drafted cards, a person icon for your own), and a handful of chips: a colored **kind** chip (bug is red, feature is accent-colored; scout/review/chore stay a quiet grey), **complexity**, dependency and evidence counts, and a readiness badge if something's missing before it can be dispatched. A card bound to a session also shows a short monospace session-id chip so you can tell two bound cards apart at a glance. A card that was launched through an approved manifest (see below) carries a small "manifest ✓" mark. If a card has open questions waiting on you (see below), it also shows a small `? N` chip counting only the ones still unanswered.

Since project memory is shared by every worktree of a repo, a busy board can span a dozen worktrees at once — so each card also carries a small **branch chip** showing which worktree it's tied to: a solid chip once a dispatch has actually run there, a dashed chip when Harnu is only guessing from a matching local branch name (never saved, just a hint), or the card's origin branch when neither is known. Opening the card's full detail shows both facts as separate rows — **Born in** (which worktree drafted the card) and **Executed in** (which worktree last ran it) — since they can legitimately differ (a card born on `main` dispatched into its own worktree, or re-dispatched into a different one later).

## Filtering, grouping, and Done

A filter bar sits right under the board header:

- **Search** filters cards live by id or title as you type. It always starts empty — it's never remembered between visits.
- **Kind chips** (bug, feature, chore, scout, review) let you dim out kinds you don't want to see right now. With every chip off, nothing is filtered — you see everything, same as if you'd never touched the chips.
- **Group** switches each column from a flat list to sections: **epic** groups cards under their parent card's id + title (cards without a parent land in an unlabeled group at the bottom), **kind** groups by kind, and **none** is the original flat list.
- **Hide done** collapses the Done column into a slim vertical rail showing its count (`Done · N`) instead of a full column — click the rail to expand it back, or flip the toggle. Either way, dragging a card onto Done — rail or expanded — is still blocked; Done is still reached only by Close.
- **Worktree** scopes the board to one branch — a card matches if it was either born there or executed there. Opening the board from a worktree (not the repo's main checkout) pre-selects that worktree's branch automatically, so you land on "just this worktree's work" without having to ask for it; the dropdown always shows what's active, and picking "All worktrees" clears it in one click.

Your kind-chip selection, group mode, and hide-done state are remembered per repo, so reopening the board on the same folder later picks up right where you left it. The **Worktree** scope is the one exception — it's never remembered; it always resets to the auto-selected worktree (or "All worktrees") the next time you open the board.

## Creating a card from the board

The **`+ New card`** button on the far right of the filter bar opens the same card
detail modal in create mode. Pick a **kind** (bug, feature, chore, scout, review)
and a **complexity** (trivial, simple, standard, complex), type a title, and the
body starts pre-filled with that kind's delegation-packet template — the same
template an agent's `create_card` uses. Switch the kind before you've touched the
body and it re-seeds with the new template; once you've started editing, switching
kind leaves your text alone. An [extension](extensions.md) can override a kind's
template pack-wide (every repo's board), falling back to Harnu's bundled one if
the extension's file goes missing.

The card is always born in **Backlog** — there's no way to create it directly into
any other column. Hitting **Create card** opens the fresh card straight into its
own detail view, so you can see exactly what got written before doing anything
else with it. Cancel, Esc, or clicking outside the modal discards the draft — if
you've already typed a title or changed the body, it asks first rather than
silently losing it.

## Answering a card's open questions

Open a card to see its full detail view. If it has an "Open questions" section, each
question shows either as an answered block (a green stripe, who answered it and when,
and the answer itself) or, if it's still open, the question text with a small text
box and a **Send** button. Typing an answer and hitting Send saves it straight to the
card — no separate save step — and the question flips to answered immediately. The
badge next to the section header always shows how many are still open; once it hits
zero the badge disappears.

## Generating a missing spec, PRD, or ADR

When a card is missing a doc its complexity tier requires (a **standard** card
without a spec, a **complex** card without a spec or PRD), its Docs row shows a
**Generate** button alongside a short hint about what it'll produce. Clicking it goes
through the exact same launch disclosure as dispatching the card itself — same model/
effort picker, same "where it runs" choice, same boot prompt shown verbatim — you
approve it the same way. The one difference: generating a doc never rebinds the
card's own session or moves it to In progress, since it's a side-task rather than
the card's actual dispatch. What the launched session actually does depends on the
card's complexity: a trivial or simple card would draft directly (though those tiers
never require a doc, so you won't see this button on them); a standard card gets a
complete draft immediately, with its assumptions spelled out and up to a few
follow-up questions parked in Open questions for you to answer later; a complex card
asks its questions first and holds off drafting until you've answered them.

## Moving cards

Drag a card between columns to move it manually. The one thing you can't do by dragging is drop a card onto **Done** — that column is reached only through the **Close** button on the card itself, never automatically, and never by an agent. Closing a card records it as complete, notes it in project memory, and — if a session was bound to it — archives that session for you (with an undo, in case you close the wrong one).

Moving a card into **Ready** doesn't start anything by itself. It just marks the card as eligible to run; actually launching it is a separate step, described next.

## Archiving and deleting cards

Open a card's detail view and you'll find **Archive** and **Delete** icon buttons next to Edit. Archive pulls the card off the board — reversible, no confirmation needed, and the toast that follows carries an Undo in case you archived the wrong one. Delete removes the card's file for good, so it asks you to confirm first. Both are disabled while a card is In progress, since its bound session keeps running regardless and removing the card mid-flight would lose the record of it — move it to Review first if you want to archive or delete it.

A session with [agent control](agent-control.md) enabled can do the same two things. Archiving runs directly, same as its other board-organizing actions, since it's reversible; deleting always stops to ask you first.

## From Ready to running

Dispatching a card — whether you drag it out of Ready yourself or a session proposes doing so — opens a disclosure showing exactly what would happen: the card's boot prompt verbatim, which model and effort level it would launch with, and where it would run (a plain session in the same folder, a fresh git worktree, or as a "teammate"). You approve that before anything actually starts.

When a session wants to launch several ready cards at once, it submits them as a single named batch (a "manifest") instead of asking once per card. That batch shows up in your [Approval Inbox](approval-inbox.md) as a checklist, in the order the session proposed running them — you can approve the whole thing, or uncheck individual cards to leave them alone rather than running. Only your approval actually clears cards to launch; a session drafting or reordering the batch never does.

If you edit a card's title, spec, or body after it's already been approved this way, that edit still goes through, but the approval is voided — the card falls back to asking again individually the next time something tries to dispatch it, rather than silently keeping the old approval.

## Model routing

Which model and effort level a card actually launches with comes from a routing table you configure yourself, per card kind (scout / bug / feature / chore get one set of defaults, review gets another), reachable from a folder's launch settings. A session can suggest a model or effort when it proposes a card or a dispatch batch, but that's only ever a hint shown to you — the table you've configured is what actually decides what launches. Once a card has been dispatched, it records which model/effort it actually ran with, so you can always check what really happened rather than relying on the suggestion.

## What agents can and can't do here

A Claude session with [agent control](agent-control.md) enabled for the folder can create cards, edit their fields, and move them between Backlog, Ready, and Review — directly, without asking you each time, the same way it can write to project memory. New cards always start in Backlog. What it can't do, ever: move a card straight to Done (that's exclusively your Close action) or into In progress (that only happens via a real dispatch), or launch a batch of work without your approval on the manifest. In short: an agent can organize the board freely, but only you can actually greenlight work running.

## What the columns guarantee — and what they don't

Every rule above (cards are born in Backlog, an agent can't move to Done or In progress, launching needs your approval) is enforced by the tools a session is told to use — not by the file on disk. A card is a plain markdown file at `.harnu/memory/roadmap/<slug>.md`, and that file is as editable as any other file in the repo. Harnu trusts what's written there: if a card's frontmatter says `status: done`, the board shows it as done, however it got written. The columns are a faithful mirror of the files, not a lock on them.

In practice this hasn't been a problem: cards you write by hand (which is how every card predating agent control got here) are exactly as valid as agent-created ones, and a well-behaved agent only ever touches a card through the create/update/move actions above, which is what keeps the provenance, validation, and approval stamps genuine. If you ever see a card whose history looks off — a status or approval that doesn't match anything that happened in a session or a drag on the board — that's a sign something edited the file directly instead of going through those actions, worth a look rather than something to route around.
