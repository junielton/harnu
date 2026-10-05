# PR Stack

**PR Stack** draws the merge chain of a repo's open pull requests on an infinite
canvas, so you can see which PR merges into which without opening a single PR
page on GitHub.

Open it from a folder's context menu → **PR Stack**, or from the
**pull-request icon** in the topbar's right-hand button row (it opens the stack
for the selected session's repo). It replaces the main pane, like the Roadmap
board or Cleanup, and the sidebar stays where it is.

The topbar button is a toggle: it's highlighted while the stack is open, and
clicking it again takes you back to your session. Esc does the same, and so does
clicking any session in the sidebar.

It is **read-only**. Nothing here writes to GitHub.

## The problem it solves

When you stack PRs — PR B based on PR A, PR C based on B — GitHub shows the base
branch in a single line at the top of each PR page. Reconstructing a four-PR
stack means opening four tabs and holding the chain in your head. And two things
you actually need are not written down anywhere:

- **Which branch do I deploy to staging** to test the whole stack at once?
- **Which PR can I merge next**, right now, without checking anything else?

The canvas computes both.

## Reading the canvas

Each chain is a column. Every column is bottom-aligned on the row above the base
node, and chains grow upward — so **how deep a stack is reads as how tall its
column is**, with no edges to trace. Chains are ordered left to right by depth,
deepest first. Arrows always point from a PR to the branch it merges into, and
every chain converges on one node at the bottom: the repo's default branch.

### The markers

| Marker          | Colour | Means                                                                                                                                   |
| --------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Staging tip** | blue   | The leaf of a chain, with a `carries N` count. Deploy this branch and you are testing N PRs at once.                                    |
| **Merge next**  | green  | The base-most PR of a chain: base is already the default branch, checks green, approved, no conflicts. Merge it and the stack advances. |
| **Base merged** | amber  | This PR's base branch was merged and deleted, so GitHub silently retargeted it onto the default branch.                                 |
| **Blocked**     | red    | Failing checks or merge conflicts.                                                                                                      |

Staging tip and merge next are **opposite ends of the same chain**: merge order
runs bottom-up, deploy order runs top-down. A one-PR chain is legitimately both.

A staging tip stays a staging tip even when its checks are red — you deploy to
staging precisely in order to test, so a red tip is still the right branch to
push.

**Base merged is the one worth stopping for.** When a base branch is deleted,
GitHub retargets the PR onto the default branch without telling you, and the
diff you review afterwards is not the diff you reviewed before. Expand that card
and it hands you the exact `gh pr edit N --base <branch>` command, copyable in
one click. The canvas will not run it for you.

### The status chip

Every card carries **exactly one** status chip, and it always tells you the most
blocking thing that is true about the PR:

| Chip                  | Colour | Means                                                                                |
| --------------------- | ------ | ------------------------------------------------------------------------------------ |
| **conflicts**         | red    | GitHub says the branch cannot merge. Nothing else matters until you rebase.          |
| **retarget**          | amber  | The base branch was merged and deleted, and GitHub silently retargeted the PR.       |
| **changes requested** | red    | A reviewer read it and asked for changes. This one is on you.                        |
| **blocked**           | amber  | A branch rule refuses the merge, though no reviewer said no — a required check, say. |
| **approved**          | green  | Reviewed and approved. What is left is mechanics — checks, conflicts, merge order.   |
| **review**            | grey   | Open, nothing blocking it, waiting on a review.                                      |

They are listed in priority order: a PR that both conflicts and has changes
requested shows `conflicts`, because that is what you have to fix first. Only one
chip ever appears, so the card never makes you rank three signals yourself.

`blocked` comes from GitHub's own merge check, and it steps aside when something
more specific already explains the block: a draft keeps its `DRAFT` badge, and a
PR still waiting on a required review keeps `review`. While checks are still
running it keeps its usual chip too: GitHub counts pending required checks as a
block, and the `running` chip already tells you that. A PR with conflicts shows
`conflicts`, whether GitHub or the mergeability check said it.

**`changes requested` is the one that used to be invisible.** Before, a PR a
reviewer had turned down looked exactly like a PR nobody had opened — both drew
the grey `review` chip. Those are the two most different states a PR can be in.

### Who a review is waiting on

A grey `review` chip still covers two situations that need different things from
you, so the card now tells them apart:

- **`review` on its own** — no reviewer is pending. Either nobody has been asked
  yet, or a reviewer already answered with comments only: GitHub drops a
  comment-only reviewer from the request list without recording a verdict. Open
  the PR to see which — then request a review, or reply to the comments.
- **`review` followed by `waiting @dberri`** — a reviewer was asked and has not
  answered yet. Ping them, or wait. With more than one pending request the chip
  reads `waiting @dberri +2`; a person is named ahead of a team, and a team shows
  as `@team-slug`. Expand the card to see every pending reviewer in the
  **waiting on** row.

The `waiting` chip is grey on purpose: a PR that is waiting for a review is not
in trouble. It disappears as soon as there is a verdict — once a PR is approved
or has changes requested, a reviewer who is still "requested" does not change
what you do next. Like the other chips, it only shows when you are zoomed in past
70%.

### Unresolved review threads

Next to the status chip, an amber chip such as **`3 unresolved`** counts the
review threads on the PR that nobody has resolved yet. It answers the question
the status chip can't: is this PR actually waiting on its author? A PR can be
_approved_ and still have six open threads, and now the card says both.

A few rules keep the number honest:

- **Only threads on current code count.** When someone rewrites the lines a
  thread was left on, GitHub marks that thread _outdated_. The code it points at
  is gone, so it doesn't count toward the chip. Expand the card and the
  **threads** row lists them separately, e.g. `3 unresolved · 4 outdated`.
  They're shown lower down, not hidden.
- **No chip means nothing to act on, or no answer.** A PR with no open threads
  shows no chip, and its drawer says `0 unresolved`. If Harnu couldn't ask GitHub
  at all (no `gh`, not logged in, rate-limited, or not a GitHub repo), there's no
  chip and no threads row. Harnu never shows a `0` it didn't actually measure.
- **`100+`** means the PR has more than 100 review threads and Harnu read only
  the most recent 100. Treat the count as "at least".

The header adds a matching count, `N with unresolved threads`, right after
`ready to merge`. It's left out when threads couldn't be read.

**What it costs:** one extra GitHub API call per refresh, for the whole repo
rather than one per PR, and it uses one point of your GitHub rate limit. It runs
at the same time as the PR list fetch, so refreshing doesn't get slower. The
thread counts come from the 100 most recent open PRs, which covers every PR the
canvas can draw.

Reading, replying to or resolving threads isn't done here. Open the PR on
GitHub, or use the [Review pane](./review-pane.md).

### Behind its base

An amber **`5 behind`** chip means the PR's branch is missing 5 commits from the
branch it merges into. Two sources feed it:

- **GitHub** says whether a PR is behind, and it knows even when you have never
  fetched the branch on this machine. When only GitHub knows, the chip reads a
  plain **`behind`**, with no number.
- **Your local checkout** counts the commits, which is where the number comes
  from. It can only count a branch that is actually here.

No chip means neither source found the branch behind. That is not always the
same as "up to date", so expand the card and read the **vs base** row, which
always says one of:

| vs base                       | Means                                                                                                     |
| ----------------------------- | --------------------------------------------------------------------------------------------------------- |
| `5 behind its base`           | Counted here: 5 commits behind.                                                                           |
| `behind its base, per GitHub` | GitHub says it is behind; this checkout could not count by how much.                                      |
| `up to date locally`          | Counted here: nothing missing, against the branches as this checkout last fetched them. Fetch to refresh. |
| `could not measure locally`   | The branch is not fetched on this machine, and GitHub did not report it behind. Unknown.                  |

GitHub only reports "behind" on a branch whose rules require PRs to be up to date
before merging. A PR stacked on another PR's branch never has such a rule, so for
stacked PRs the local count is the only source. The count needs a **local
branch** of that name, not just a remote one, so to get a row measured create it,
for example with `git fetch origin <branch>:<branch>`.

### The merge row

When GitHub has something to say that the chips do not already cover in full,
the expanded card adds a **merge** row:

- `blocked by branch protection` — a rule refuses the merge. Shown even when the
  status chip picked something more pressing, like `changes requested`.
- `a non-required check is failing` — mergeable, but a check that is not
  required is red. The CI chip already shows it failing.

### Drafts

A draft PR carries a small `DRAFT` badge next to its number. It stays there when
you zoom out and the chip row disappears, because "is this even finished?" is a
question you still want answered on a crowded canvas. A draft is never picked as
**merge next**, no matter how green it is.

### Diff size

A chip on the row says how big the PR is — `+412 −38 · 9 files`: lines
added, lines removed, files touched. It is there to answer "which one do I pick
up now?": a 12-line fix and a 900-line refactor used to be the same rectangle.

It is grey on purpose. Red and green on a card mean a verdict — conflicts,
changes requested, approved, CI — and a big PR is not a bad PR, so the numbers
do not borrow GitHub's green and red.

- Thousands are shortened on the chip (`+1.2k −310 · 48 files`), always rounded
  **down**, so a size is never overstated. Expand the card and the `diff` row
  has the exact numbers.
- A PR that touches nothing at all says `empty diff`.
- If GitHub did not report a size, the card shows nothing, rather than a
  made-up `+0 −0`.
- When the row runs out of room it goes whole, so you never see a cut-off
  number — and it disappears when you zoom out below 70%. It is always in the
  expanded drawer at full zoom.

### Auto-merge

A PR with **auto-merge armed** on GitHub carries a small timer icon next to its
age, in the card's top-right corner. It means GitHub merges the PR by itself as
soon as its required checks and reviews clear, so there is nothing for you to
do once they do. An armed PR with conflicts or failing checks keeps the icon,
but it will not land until those are fixed. The icon stays when you zoom out past 70%, so a crowded canvas still
tells a PR that lands on its own apart from one waiting on you. Hover it for a
reminder of what it means.

Expand the card and the drawer's **auto-merge** row names the merge method and
who armed it — for example `squash, armed by @you`.

An armed PR is **not counted in `ready to merge`** in the canvas header. That
number is a to-do count, and a PR that merges itself is not on your list — so a
repo whose merge-next PR is armed can read `0 ready to merge` while that card
still says **merge next**. The canvas never arms or disarms auto-merge; do that
on GitHub, or with `gh pr merge --auto`.

### Labels (off by default)

Cards can show the PR's GitHub labels, but only if you ask for them: turn on
**Settings → PR Stack → Cards → Show labels on cards**. The change applies right
away, even to a canvas sitting open behind the Settings dialog.

With it on:

- A card shows **up to two** labels as small grey chips after its other chips.
  If the PR has more, a `+N` count follows them.
- **Expand the card** to see every label, in a `labels` row in the drawer. That
  is also where to look when a card is crowded and a label chip gets cut off at
  the card's edge.
- Labels show only at full zoom. Below 70% they disappear along with the rest of
  the chip row.
- A PR with no labels shows nothing extra.

Labels are always drawn in the same neutral grey, never in the colours you picked
for them on GitHub. The label's name is what matters, and neutral chips keep red
and green free for the signals that do need action, like `conflicts` or
`changes requested`.

It is off by default because it only helps in some repos. Where labels mark
something you act on, such as `no-user-docs` for a PR that skipped a docs check,
seeing them on the card saves opening the PR. In a repo that puts five labels on
every PR, they would crowd out the chips that actually matter.

### The branch line

Every card shows its branch name under the title, and that line is clickable:

- **Click the name** to open the pull request on GitHub in your browser. The
  branch name is what tells the cards apart at a glance, but the page you
  actually want after reading a card is the PR's own.
- **Hover the line** and a small copy icon appears at its right edge — it copies
  the raw branch name, which is what you want for a local `git checkout`. A
  toast confirms the copy.

## Filtering the canvas

A repo with twenty open PRs is wider than the screen, and panning is a poor way to
ask "what can I merge?" or "what is waiting on me?". The **filter bar** sits at the
top of the canvas, just right of the refresh and zoom controls. It filters the PRs
the canvas already loaded: nothing new is fetched from GitHub.

Click the field, or press **`/`** while the canvas has focus, and start typing.
A term you finish (space or Enter) becomes a chip. **Backspace** on an empty field
pulls the last chip back for editing, **Esc** leaves the field, and a second
**Esc** clears the filter. Pressing `-` in front of any qualifier excludes instead
of includes.

### The query grammar

Terms are separated by spaces and **all must hold** (AND). Repeating the same
qualifier **widens** it (OR): `review:approved review:changes` matches either.
Values are not case-sensitive. A value with spaces goes in quotes:
`label:"good first issue"`.

| Qualifier           | Values                                           | Matches                                                                          |
| ------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------- |
| `is:`               | `tip`, `merge-next`, `blocked`, `stale`, `draft` | The card signals. `stale` is a PR whose base branch was merged.                  |
| `author:`           | a login                                          | PRs opened by that login.                                                        |
| `review:`           | `approved`, `changes`, `required`, `none`        | GitHub's review decision. `none` means no review decision yet.                   |
| `review-requested:` | a login                                          | PRs where that person has a pending review request.                              |
| `ci:`               | `passing`, `failing`, `pending`                  | The CI state shown on the card.                                                  |
| `threads:`          | `unresolved`, `none`                             | Unresolved review threads. A PR whose threads could not be read matches neither. |
| `label:`            | a label name                                     | PRs carrying that label.                                                         |
| `base:`             | a branch                                         | PRs merging into that branch.                                                    |
| `chain:`            | `#412` or `412`                                  | Every PR in the same stack as PR 412.                                            |
| plain words         |                                                  | A substring of the title or branch, or `#412` for that exact PR.                 |

Typing `is:` (or any qualifier name) opens a list of qualifiers; arrow keys and
Enter complete one. A qualifier or value Harnu does not know keeps its chip, in
amber, and matches nothing, so a typo is visible instead of quietly ignored.

There is no `@me`: Harnu has no cheap way to know your GitHub login without an
extra request, so `author:` and `review-requested:` take an explicit login.

### The four menus

**Author**, **Review**, **Checks** and **Labels** list the options with how many
PRs each would match on its own, counted over every open PR, not just the current
result. Checking an option writes its token into the query; deleting the token
unchecks it. The Review menu also holds an **Unresolved threads** option. A menu
that contributes to the query is highlighted and shows how many tokens it holds.

### The header counts

The counts in the takeover header are shortcuts: **ready to merge** applies
`is:merge-next`, **with unresolved threads** applies `threads:unresolved` and
**needs retarget** applies `is:stale`. The active one is highlighted; click it
again to clear. A count of zero is plain text, and **open** and **chains** are
never clickable. A shortcut replaces whatever was in the field.

`ready to merge` leaves out a merge-next PR with auto-merge armed (see above), but
the shortcut filters on `is:merge-next`, so it can show one more PR than the count.

### Dim or Hide

While a filter is active the bar shows `7 of 19`, a **Dim / Hide** switch and a
clear button.

- **Dim** (the default) leaves every card where it is and fades the ones that do
  not match. An arrow is faded unless both its ends match. Faded cards still work:
  you can click, expand and drag them.
- **Hide** removes the non-matching cards and re-arranges the rest. If a match's
  ancestors are filtered out, a dashed pill reading `N hidden · #a #b` keeps the
  match connected to the base, so it never looks as if it sits straight on `main`.
  Click a pill to add `chain:#N` and switch to Dim, which shows that whole stack in
  context. While Hide is on, cards cannot be dragged and your own positions are
  ignored; they come back untouched when you switch to Dim or clear the filter.
  If nothing matches in Hide mode, the canvas says so and offers **Clear filters**.

Filters are **per repo and last for the session only**: they are never saved, and
an app restart starts clean. A background refresh keeps your filter applied.

## Moving around

- **Drag the background** to pan; **scroll** to zoom.
- **Drag a card** to put it wherever you want. Edges stay attached, so the chain
  keeps telling the truth no matter where a card sits.
- **Fit** brings the whole graph into view. It also runs by itself when you open
  the canvas and whenever the graph's _shape_ changes — never on a plain data
  refresh, which would move the view under you mid-read.
- **Re-layout** appears only once you have moved something, and puts every card
  back where the automatic layout wanted it.

Your arrangement is remembered per repo. A card you never moved keeps flowing
with the automatic layout, a new PR is placed automatically, and a PR that
closes takes its saved position with it.

Zooming out does not just shrink the cards — it changes what they show. Below
70% a card drops its branch line and status chips, keeping the PR number, the
draft badge, the unresolved-thread count (as a small badge with just the
number), the auto-merge icon, the age and a one-line title; below 45% it
becomes a small pill with
the PR number and the carry count, keeping the coloured role bar. The point is
that a crowded canvas stays readable instead of becoming a wall of unreadable
text.

## Worktrees on the canvas

Harnu knows about your local worktrees, and they show up in three different
roles:

- A worktree checked out on an **open PR's branch** is linked to that PR's card.
  A small house button appears on the card's branch line: click it and Harnu
  reveals that folder in the sidebar and closes the canvas. A pulsing green dot
  on the button means a session is running in it. The same worktree is listed in
  the card's drawer, with an `Open worktree` button that does the same thing.
  Harnu reveals the folder rather than jumping into a session, so your current
  session is never swapped out from under you. The drawer also carries a
  `Review branch` button, which opens the [Review pane](./review-pane.md) on
  **that PR's** branch — the diff and its receipts, without leaving Harnu. Both
  buttons need a local worktree, so a PR you have never checked out here shows
  neither.
- A worktree that **has no PR yet** is live work. It appears as a dashed node
  hanging off the worktree it was created from, with a pulsing dot when a
  session is running in it.
- A worktree whose **PR already merged** is debris. It has no place in a merge
  chain, so it leaves the graph entirely and lands in the **harvest tray** in the
  bottom-left corner, with its size. `Sweep in Cleanup` takes you to the
  [Cleanup](./cleanup.md) view, which is where the actual deleting happens.

The "is this worktree done with" verdict is the same one Cleanup uses — the two
views can never disagree.

## Refreshing

Two clocks feed the canvas:

- A **background scan** shared with [Cleanup](./cleanup.md), which by default
  runs hourly and can be tuned in Settings → Cleanup.
- A **faster refresh while the canvas is open**, because readiness rots quickly:
  an hour is fine for "is this worktree still needed" and far too slow for "is
  this PR green right now". Set it in **Settings → PR Stack**: 30s, 90s
  (default), 5min, 10min, or off. Each tick is two `gh` calls per open repo
  (the PR list and one review-thread query), so shorter keeps CI honest and
  costs more traffic. Turning it off leaves the
  Refresh button as the only way to fetch. A change applies right away, even to
  a canvas sitting open behind the dialog.

The **Refresh** button in the floating toolbar fetches on demand, and the
timestamp next to it always tells you how stale you are. The icon spins for both
the manual and the background fetch, so you never have to wonder which is
running.

**If a refresh fails**, the canvas keeps the last good picture instead of going
blank. The timestamp beside **Refresh** turns amber with a warning icon and keeps
showing the age of the last _successful_ read; hover it to see what went wrong
(timed out, couldn't reach GitHub, answer too large) and click it to retry. The
next successful refresh clears it. If the very first read fails there is nothing
to keep, so the canvas says the refresh failed — not that the repo is empty — and
offers a **Retry** button.

## Opening a PR from a transcript link

Claude's output is full of pull request links. With **Settings → PR Stack →
Open PR links in the PR Stack** turned on (it is **off** by default),
**Option+click** a link to a pull request of the session's own repo and Harnu opens
the PR Stack, pans to that card and rings it in the accent colour for a couple of
seconds. A plain click still opens the browser, as it always did.

The link has to be a `github.com/<owner>/<repo>/pull/<n>` URL (a trailing
`/files`, `/commits` or `/checks` is fine) for the repo the session's folder
points at via `origin`, and the PR has to be **open**. Anything else — another
repo, a merged or closed PR, a PR link that is not a pull request page — opens in
your browser instead, so the click is never lost.

It is opt-in because each Option+click first asks `gh pr view` whether the PR is
still open, which can take a second (a click on a PR the canvas already shows
skips that check). If `gh` is missing, not authenticated, or does not answer
within five seconds, the link opens in your browser.

## Requirements

PR Stack reads GitHub through the [GitHub CLI](https://cli.github.com/). If `gh`
is missing or not authenticated, the canvas says so and stays empty rather than
guessing — run `gh auth login` and refresh. A slow or failed answer from a working
`gh` is a different thing: it never shows this message, and never wipes a canvas
that already has pull requests on it (see "If a refresh fails" above). The PR
list gets up to two minutes to answer, the same budget the Cleanup scan uses.

Scope is **one repo at a time**, matching the Roadmap board. That is structural,
not a limitation for its own sake: the whole arrangement rests on every chain
converging on a single default branch, and two repos have no shared branch to
converge on.
