# Review pane

**What it is:** a full-screen view that shows you what a branch actually changed
— the diff, plus the receipts that back it — so closing a card is a decision you
can defend instead of something you discover afterwards.

Harnu dispatches work into worktrees all day and then goes quiet. A card lands in
Review, and to find out whether anything real happened you alt-tab to a
terminal, run `git diff`, and open GitHub. The review pane is that trip, done in
one place, without leaving the app.

## Three ways in

All three open the same pane, and all three are anchored on a **branch**, not on
a card — the pane works whether or not a board card is bound to the work.

- **`Cmd+Shift+D`** (`Ctrl+Shift+D` on Linux/Windows), while a folder or a
  session in that folder is selected. Reviews that folder's current branch
  against the repo's default branch.
- **The ✓ button in the topbar**, beside Roadmap board and PR Stack. Same
  folder, same branch, and it is a toggle: the button that opened the pane
  closes it again, and it lights up while its own folder is under review.
- **`Review branch` on a PR Stack card.** This one reviews **that PR's**
  branch, not whatever folder is active — which is the point, since a PR node is
  where "it says it's done, is it?" actually gets asked. Expand a card to find
  it, next to `Open worktree`.

---

## Reviewing someone else's PR

You do **not** have to check a pull request out to read it. The `Review branch`
button on a PR Stack card works for every PR in the canvas, including ones from
a fork and ones nobody on this machine has ever touched.

What happens depends on whether that PR's branch is already checked out here:

- **It is checked out in a worktree Harnu manages** — you review that worktree,
  exactly as before. Your own uncommitted files count, because that checkout is
  yours.
- **It is not checked out anywhere** — Harnu reads the pull request's own head
  straight from GitHub (`refs/pull/<number>/head`, which exists for every PR,
  fork or not) and diffs it. No worktree is created, nothing is checked out, no
  dependencies are installed. Reading someone's PR should not cost you a working
  tree.

**Nothing is fetched when you open the pane.** The pane is offline-first: it
opens instantly and shows you what is already on disk. The first time you open a
PR you have not fetched, you get an explicit **"This head has not been fetched
yet"** panel with a **Fetch this head** button. That button — and the ↻ in the
header — are the only things here that touch the network.

> **"Not fetched yet" is deliberately its own state, and it matters.** A branch
> with nothing on it and a branch Harnu has never fetched produce exactly the
> same `git` output: zero commits, zero files. If the pane showed you "no
> commits" for an unfetched PR, you would reasonably conclude that nothing had
> been done and close it. So the two never share a panel, a sentence, or even a
> number — an unread head shows `—` for commits, never a red `0`.

**Is what you are reading still the PR's head?** The receipts answer that as a
word, not as an age: **`current`** means your copy is the PR's head SHA, and
**`moved`** means the PR has commits your copy does not — refresh. An age would
answer a different question ("this commit is 3 days old" describes the code, not
your copy, and a three-day-old head can be perfectly current), so it appears only
as a `fetched 3h` fallback when GitHub could not be asked for the head SHA at
all. There is no green "up to date" badge, here or anywhere in this pane.

**The base is the PR's own base**, taken from the pull request rather than
assumed to be the repo's default branch. That matters for stacked PRs: diffing
one against `main` when it actually targets its parent branch shows the parent's
commits as its own. If that base does not exist in your clone at all, the pane
**refuses to draw a diff** and says so — a confident diff against the wrong base
is worse than no diff.

**Your working tree is never touched.** The whole path is read-only `git` plus
`git fetch`: no checkout, no reset, no stash, no branch switch. That is what
makes it safe to run from your main checkout with your own uncommitted work
sitting in it — which is exactly where it does run.

**When it does not work**, the button is simply absent rather than present and
dead. A live-looking button that opens an empty or wrong diff is the one failure
this whole feature is built to avoid.

---

## What you see

The pane has three parts, top to bottom.

### 1. The evidence header — the receipts

A single ledger line of facts about the branch, in plain numbers:

| Receipt         | What it means                                                                                                                           |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **commits**     | Commits this branch has that the base does not. A red `0` is a warning.                                                                 |
| **files**       | Files the branch changed.                                                                                                               |
| **lines**       | `+added` / `−removed` across those files.                                                                                               |
| **uncommitted** | Files changed in the worktree but not committed — work the diff below does **not** include. Shows `clean worktree` when there are none. |
| **session**     | How the bound session ended (`ended done`, `killed`, `stood down`, `hibernated`, `running`).                                            |
| **CI**          | The pull request's check rollup, when there is a PR.                                                                                    |
| **PR**          | The pull request number and state.                                                                                                      |
| **PR review**   | GitHub's own review decision, or `none`.                                                                                                |
| **head**        | Whether your copy of the reviewed ref is still the PR's head — `current` or `moved`. Only shown when there is a PR to compare against.  |
| **fetched**     | How long ago the ref was fetched. The fallback for when GitHub could not be asked for the head SHA.                                     |

A value with nothing to report is dimmed, never hidden — an absent receipt is
itself evidence.

Below the receipts sits the **discrepancy strip**: one line per named gap, in
words rather than icons. `✕` for the serious ones, `!` for the ones worth a
look, `·` for context. This is the part that makes "the session said done but
committed nothing" impossible to walk past.

The last line of that strip is the **repo-contract ledger** — whether this diff
touched `CHANGELOG.md`, `docs/harnu-features.md`, `docs/user/` and the i18n pair,
and whether each was actually required by what the diff changed. "Not
applicable" means the contract does not apply to this diff. It is not a pass
mark.

**There is deliberately no "all clear".** The pane will never draw a green badge
telling you a branch is fine. It shows you what it can see; the conclusion is
yours. When there is nothing to report, the discrepancy strip simply is not
there.

### 2. The diff

One box per file, with the path, its `+`/`−` counts, and a chevron showing
whether it is open. Click anywhere on the header to collapse or expand it.
File headers stay pinned while you scroll a long file.

- **Syntax colours come from your terminal's palette.** Whatever theme you are
  using already defines the 16 ANSI colours the terminal uses; the diff is
  painted with those same colours, so switching theme recolours both at once.
  TypeScript, JavaScript, JSON, Markdown, CSS, shell and HTML/Vue are coloured;
  anything else renders as plain text.
- **Only the part of a line that changed is marked.** On a modified line the
  changed span gets its own highlight, so a one-character edit is findable
  without reading the whole line.
- **Colour is never the only signal.** Every added line carries a `+` and every
  removed line a `−` in the gutter, next to the old and new line numbers.
- **Long lines scroll sideways, all together.** Lines are never wrapped, so a
  row's line numbers and its code always stay on the same visual line. Each file
  box scrolls horizontally as one column — drag the bar at the bottom of the
  box, or use shift+wheel — and the line-number gutter stays pinned on the left
  while the code slides under it, so you can always tell which line you are
  looking at.
- **`⋯ n unchanged lines`** marks a stretch git skipped between two hunks.
- **Binary files** are listed by path with a `binary` marker; nothing is
  rendered for them.

On a large diff, files past a size budget open **collapsed** — click a file
header to expand it. That is what keeps a several-thousand-line diff from
locking the window up.

**Sensitive paths open expanded and cannot be quietly skipped.** If a file
matches your repo's sensitive-path list, its box is outlined in amber, its
header carries a `sensitive path` badge and an amber bar, and it is never
auto-collapsed — the point of that list is that you read those diffs yourself.

### Marking a file as read

Working down a nine-file diff, the thing you lose on every interruption is your
place. Each file header carries a **checkbox on the right**: click it to mark
that file read. The file collapses, and the next time you open the pane it is
still marked and still collapsed.

Clicking the box is a different gesture from clicking the header — the header
opens and closes the file, the box marks it. They never share a hit box.

**It is the same mark GitHub uses.** When the branch has a pull request, Harnu
reads and writes GitHub's own per-file "Viewed" state, so a review you start
here and finish in the browser keeps its place, and one you start in the browser
arrives here already marked.

The box has four states:

| what you see                        | what it means                                                |
| ----------------------------------- | ------------------------------------------------------------ |
| empty                               | not read                                                     |
| green check                         | read — and GitHub agrees, or there is no pull request to ask |
| grey check                          | read here, **not yet synced** with GitHub                    |
| empty + `changed since you read it` | you read it, and then the file changed                       |

**`changed since you read it` is not the same as "not read".** GitHub clears its
own viewed mark when a file changes after you read it, and Harnu does the same
locally by remembering exactly which version of the file you read. Only the
files that actually changed lose their mark — a new commit elsewhere in the
branch costs you nothing.

**A grey check means the mark did not reach GitHub.** Harnu tells you why when it
happens (an expired login, a rate limit, a PR you cannot write to), keeps the
mark locally, and pushes it up on the next refresh. It never shows as synced
when it is not.

**With no pull request, no remote, or no `gh`, the mark is simply local** — it
works exactly the same and raises no error, like every other git-only part of
this pane.

**A sensitive file is never collapsed by being read.** Marking it read is
allowed and useful, but its box stays open and its path stays at full contrast:
having read something does not outrank the reason it is on the list.

**There is no "all files viewed" badge and no `7/9` count**, deliberately. A
progress bar over a review reads as "you are done" while saying nothing about
whether anything is right, and this pane does not draw states like that.

### 3. The intent rail

When a board card is bound to what you are reviewing, its body renders in a
column on the right: the title, the kind/complexity/priority chips, the
description and the acceptance criteria. This is the question no automated
reviewer can answer for you — _did it do what I asked, and only that?_

**With no card bound the rail is not there at all**, and the diff takes the full
width. An empty panel would advertise something the branch cannot have.

Below roughly 1000px wide the rail collapses to a narrow strip on the right edge
with a vertical `Intent` label. Click it to open the card — it slides over the
diff rather than squeezing it.

---

## Close and Bounce back

With a card bound, the header offers two actions.

**Close** moves the card to Done. It is the same Close the roadmap board
performs — the same single write, with the same dated entry appended to the
card, and the same `decisions.md` entry when the card is an epic.

**Bounce back** returns the card to Ready with a note. Clicking it opens a small
composer; write why the work is going back, and Harnu appends your note to the
card (stamped with today's date and `author: human`) **before** moving it. If
the note cannot be written the card does not move — a card that came back
carrying no reason is a bounce whose whole point was thrown away.

With **no card bound** both are replaced by **Open in terminal**, which starts a
shell in the worktree. There is nothing to close or bounce.

## Submitting a review to GitHub

When the branch you are reading has a pull request, the header offers **Submit
review**. This is the only thing in Harnu that writes to GitHub as _you_ — the
review lands under your own account, indistinguishable from one you typed on
github.com, and other people see it.

Click it and a small composer opens: a box for what you actually found, and
three buttons — **Approve**, **Request changes** and **Comment**. Write the
body, pick one, confirm, done.

A few things about it are deliberate, and worth knowing before you use it:

- **The three verdicts are equal.** Same size, same styling, same click cost,
  none pre-selected, and all three ask you to write something. GitHub itself
  lets an approval skip the prose and demands it from the other two, which makes
  approving cheaper by exactly the number of keystrokes it takes to say why.
  A surface where approving is one click and objecting is three teaches people
  to approve, and that is the whole thing this pane exists to push back on.
- **Nothing recommends a verdict.** There is no "CI is green — approve?", no
  pre-filled body, and Approve is neither greyed out by failing checks nor
  highlighted by passing ones. The receipts tell you facts; the conclusion is
  yours.
- **A confirm always comes first**, naming the verdict, the repo and the PR
  number. A review submitted to the wrong pull request is not undone by an undo.
- **Anything you paste goes out as your own words.** If you paste text from a
  companion session into that body, it is submitted under your identity and
  carries no different status from something you typed. The confirm says so.
- **No agent can do this.** No session, no skill and no MCP verb can submit a
  review. The only trigger is your click, and a test in the repo fails if anyone
  ever wires one up.

### You can only approve what you read

The diff you are looking at is pinned to the exact commit it was built from.
When you press submit, Harnu re-checks two things before it sends anything:

- that the diff was taken against **the pull request's own base** — not a base
  you configured, and not a fallback — so it is the same diff GitHub shows;
- that the commit you read is **still the commit the branch is on**.

If either has changed — someone pushed, the author amended, another session
moved the branch in a shared worktree — the submission is **refused** and says
which. Nothing is silently recomputed and sent, because that would mean
approving a diff you never saw. Press refresh, read it again, and submit.

### When it fails

`gh pr review` fails for ordinary reasons: not logged in, no pull request for
the branch, approving your own PR (GitHub refuses that), no network,
insufficient permission. Every one of them comes back to you **verbatim**, and
your text stays in the composer so you can fix it and retry.

The pane never shows a submitted state it did not confirm from GitHub. An
approval you believe happened and did not is strictly worse than a visible
error.

**With no `gh`, no login or no pull request, the button is simply not there** —
not greyed out. There would be no reason to find.

---

---

## When there is no remote, or no `gh`

Git-only evidence is a **first-class state, not a degraded one**. On a repo with
no remote — or on a machine without the GitHub CLI, or with `gh` not logged in —
the pane drops the PR and CI receipts, shows `local only` (or `no gh`) under
**remote**, and says so in one line at the bottom of the strip. No error, no
toast, no retry prompt. Everything else works exactly the same.

## Empty states

The pane never goes blank.

- **No commits ahead of base** — a `✕` line naming the branch, plus a panel
  saying nothing has been committed. If the worktree is dirty, the strip says
  so: the work may be unsaved rather than absent.
- **Nothing to review** — the branch and the base hold the same tree.
- **Not a git worktree** — there is no branch to compare.
- **This head has not been fetched yet** — a PR whose head is not on this
  machine. Carries a `Fetch this head` button.
- **The head could not be fetched** — a fetch ran and did not go through.
  Check the network, or that `gh` is authenticated.
- **The base is not in this repo** — the PR targets a branch your clone does
  not have. No button: fetching would not help.

---

## Ask a fresh session

The pane tells you **what changed**. It does not tell you what that means. For
that there is **Ask a fresh session** in the pane's header: it opens a Claude
session in the split beside the diff, so you can ask "what breaks if this
ships?" without leaving the review, rebuilding the context in another window, or
asking the thing that wrote the code to grade its own work.

The button is greyed out while the branch itself is still loading or failed to
load — there is nothing yet for a companion to sit beside, and hovering it says
so. Clicking it again once a companion is already open brings that running
conversation into focus rather than doing nothing.

Three things about it are deliberate, and each one costs something:

**It is always a stranger.** Never the session that wrote the branch, and there
is no option to make it one. Partly because a session reviewing its own code
finds fewer bugs — it has a position to defend, which is why humans do not
review their own PRs either. Mostly because reviewing _someone else's_ PR is a
first-class case, and there the author session does not exist at all. A choice
that vanishes exactly when the feature matters most is not a choice worth
having.

**It cannot write.** The session starts in plan mode and Harnu denies it the
file-editing tools outright, so "fix that for me" mid-review cannot change the
code under the diff you are reading. This is not about protecting the merge —
Harnu already refuses to submit a review when the tree has moved — it is about
protecting your _reading_: you are never unsure whether what is on screen still
matches what is on disk. It can still run your tests and grep the repo, which is
most of why having it there is worth anything.

To lift that, use **Promote** in the pane's header. It hands the same
conversation to an ordinary working session with full access — **and closes the
review**, because a reviewer that edits is the author, and that is the whole
separation you opened the fresh session to get. Promoting is fine. Drifting into
it is not.

Promote stays greyed out until you have actually asked the session something.
Claude only writes a conversation to disk once there is a turn in it, so before
that there is nothing to hand over — and if you just want a working session in
this worktree, **New session** already does that in one click.

**Harnu never speaks first.** No summary, no verdict, no prompt written for you
on open. The conversation is something you _pull_: you ask, you read, you
decide. A session that greeted you with "I reviewed this, it looks fine" would
be an AI findings list wearing a costume — the thing this pane exists to not be.
(Claude's own startup banner is Anthropic's UI, not ours.)

### What the session _is_ told

There is one exception to "Harnu never speaks first", and it is not a message —
nothing is typed into the conversation, and nothing appears in the transcript.
Before its first turn the session is handed a short **orientation**: that the
folder it is standing in has nothing to do with the diff you are reading, the
exact `git diff <base>...<head>` command that _is_ the diff, that it cannot
write, and the PR number when there is one. That is the whole of it.

It exists because of a real failure. Reviewing a PR no longer costs a worktree,
so the folder can sit on `main` while you read a branch 38 commits away — and
asked "do you know the context of this PR?", the session ran `git status` and
answered confidently about the folder. It was right about where it stood and
wrong about what you were reading. A session that knows nothing asks you. A
session with wrong-looking information guesses, and guessing is worse.

So the orientation is deliberately a **negative fact plus a pointer**, not a
briefing. It carries no CI state, no PR or review state, no commit or file
counts, no list of changed files, no `+`/`−` numbers, and none of the diff. Those
would be an opinion about what matters, arriving before you asked one — the same
thing "Harnu never speaks first" rules out. If the head has not been fetched yet,
or the base no longer resolves, the orientation says exactly that and names no
command, so the session asks you instead of running something that quietly works
against the wrong commit.

You can read the whole thing. The scroll icon in the companion's header opens
**What this session was told**, showing the text verbatim. It is worth knowing it
is there: the orientation is invisible by design, and a reviewer who cannot check
what its reader was primed with is trusting a black box.

The orientation is a snapshot from when you opened the session. It is written in
commit SHAs rather than branch names, so it does not go stale into something
false — pressing **Refresh** on the review does not rewrite it, and the running
session keeps pointing at the commits it was given. Promote, and it does not
carry over: the promoted session is an ordinary one, with no read-only posture to
describe and no review still open.

Nothing the session says renders as evidence. It stays in its own pane; the
evidence header, the discrepancy strip and the diff are untouched by its
existence. If you paste something it told you into a Bounce note or a PR review,
that text becomes **yours** — it carries no different status from words you
typed, because you are the one signing it.

One companion per worktree: asking again reveals the conversation already
running rather than starting a second stranger with no shared context. Closing
the review closes the session with it — it belongs to that review, and it does
not come back on the next app start.

---

## What the pane does not do

It renders `git`'s own output, your card's own text, and nothing else. **No
model is asked anything on this path**: there is no AI summary of the diff, no
generated findings list, no "this looks fine". Two reasons, both deliberate:

1. An AI reviewing AI-written code shares its blind spots — it validates that
   the code is plausible, not that it does what you asked.
2. Every AI reviewer people already use is criticised for the same thing: a wall
   of low-value notes that trains you to click past it. If the first thing this
   pane ever showed you were noise, you would stop opening it.

The mechanical layers — the contract flags, the sensitive-path list, the counts
— are deterministic. They can be wrong about relevance; they cannot make
something up.

The companion session above does not change this. It is a conversation in its
own pane, opened by you and answering what you asked; nothing it says is ever
rendered as evidence, and the pane itself still calls no model.

## Setting your sensitive-path list

The list lives with Harnu's own settings, per repo, and **no agent can read or
write it** — the same posture as the model routing table. That is the point: a
never-delegate list that the agents it constrains can read is not a constraint.

There is no editor for it in the UI yet; today it is seeded through Harnu's
internals. Until there is one, the pane still flags anything already on the
list, and re-flags live if the list changes while the pane is open.

---

## What is not built yet

Named here so you know they are missing rather than broken:

- **A ready-made way in for a PR that is not in the PR Stack canvas.** Foreign
  PRs are reviewed through a PR Stack card today; there is no "paste a PR URL"
  entry point.
- **A menu entry.** The topbar button, the PR Stack card and `Cmd+Shift+D` are
  the ways in. The board's Review column and the session/folder menus do not
  offer it yet, so a card sitting in Review is still opened by going to its
  folder first.
- **Expanding a `⋯ n unchanged lines` gap.** The count is accurate; clicking it
  does nothing, because the pane only has the lines git put in the diff.
- **An editor for the sensitive-path list** (above).
- **Asking about specific lines.** The companion session reads the branch, but
  you cannot select lines in the diff and ask about _those_ lines yet — that is
  a later step, deliberately left until the plain conversation has been lived
  with for a while.
- **Inline review comments on specific lines.** The review you submit is a
  single body against the whole pull request; you cannot yet attach a comment to
  a line in the diff. That is a later step, and it will go through the same
  confirm rather than growing a second one.
- **Retrying a failed mark on demand.** A mark that did not reach GitHub is
  pushed again on the next refresh; there is no per-file "retry now" button.
- **AI-assisted findings**, an ordered queue of everything sitting in Review, a
  nudge for cards that have been there too long, and inline comments. All
  deliberate omissions for this first version. The companion session is not an
  exception: it answers what you ask, and nothing it says is ever presented to
  you as a finding.

## See also

- [Roadmap board](roadmap-board.md) — where cards reach Review in the first place
- [PR Stack](pr-stack.md) — the merge chain across a repo's open PRs
- [Folders and worktrees](folders-and-worktrees.md)
