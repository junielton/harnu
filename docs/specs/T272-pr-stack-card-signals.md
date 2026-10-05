# T272 — PR Stack card signals: make the card answer "what is this PR waiting on?"

**Date:** 2026-09-03 · **Status:** specified (not implemented)
**Cards:** `T272` (umbrella) → `T273` S1 · `T274` S2 · `T275` S3 · `T276` S4 · `T277` S5 · `T278` S6 · `T279` S7
**Verified against:** repo `main` @ `48500d1`, `gh` field list and GraphQL cost measured live on 2026-09-03.
**Touches:** `src/main/pr-stack.ts`, `src/main/pr-stack-core.ts`, `src/renderer/src/components/PrStackCard.vue`, `src/renderer/src/components/pr-stack-format.ts`, `src/main/pr-stack-prefs.ts`, `src/renderer/src/components/PrStackSettingsPane.vue`
**Not agent-facing:** no MCP verb changes, so `docs/capy-features.md` is deliberately untouched by every unit here.

---

## 1. The problem, stated once

The PR Stack Canvas (T198) gets the _graph_ right. It gets the _card_ wrong in one
specific way: the card collapses most of a PR's state into a single grey `review` chip,
so the canvas can tell the operator **where** a PR sits in the merge DAG but not **what
it is waiting on**.

Observed on a live 10-PR canvas: every card that was not `approved`, `conflicts` or
`retarget` rendered the identical neutral `review` chip. That bucket contained, drawn
indistinguishably:

- PRs where a reviewer had **requested changes**;
- PRs that were still **drafts**;
- PRs nobody had been asked to review;
- PRs with a requested reviewer who had not responded;
- PRs carrying unresolved review threads.

Five different next actions, one rectangle.

## 2. Current behaviour, verified

### 2.1 The query

`src/main/pr-stack.ts:41` — `GH_FIELDS`, the single source of everything the card knows:

```
number, title, headRefName, baseRefName, state, isDraft,
mergeable, reviewDecision, statusCheckRollup, url, author, updatedAt
```

fetched by one `gh pr list --state all --limit 100 --json …` (`pr-stack.ts:77`), 15 s
timeout, degrading to an empty canvas rather than an error dialog when `gh` is absent.

### 2.2 The chip row

`src/renderer/src/components/PrStackCard.vue:251` renders, in order:

1. a CI chip — `failing N` / `running N` / `CI` — a `v-if / v-else-if` chain;
2. a **status chip**, a strict ladder with a terminal `v-else`:
   `conflicts` → `retarget` → `approved` → **`review`**;
3. a `behind N` chip;
4. the expand chevron, pushed right by `ml-auto`.

Everything below `lod === 'full'` sheds the marker strip; the row itself must stay
legible at `compact`.

### 2.3 What is already fetched and never drawn

- **`reviewDecision === 'CHANGES_REQUESTED'`** — falls into the terminal `v-else` and
  renders as neutral `review`. A human read the PR and said no, and the card says
  nothing.
- **`isDraft`** — parsed at `pr-stack-core.ts:211`, consumed by the merge-next predicate
  at `pr-stack-core.ts:335`, and rendered **nowhere**.

Both are in the `PrEntry` the card already receives. Drawing them costs no network call.

### 2.4 The behind count is not what it appears to be

`behindCounts()` (`pr-stack.ts:88`) runs, per node:

```
git -C <repo> rev-list --count <branch>..<base>
```

inside a per-node `try/catch` whose own comment reads _"branch not present locally — no
count, and that is not an error"_. So **a missing chip means "up to date" OR "never
fetched here", and the card cannot tell them apart.** On the observed 10-PR canvas only
3 cards carried a count; the other 7 were unmeasured, not current.

## 3. What is available, and what it costs

### 3.1 Free — same call, same latency

Appending a word to `GH_FIELDS` costs nothing: no extra round trip, no extra rate-limit
point.

| Field                                    | Unit | Answers                                                                                                             |
| ---------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------- |
| `mergeStateStatus`                       | S2   | `CLEAN`/`BEHIND`/`DIRTY`/`BLOCKED`/`UNSTABLE`/`DRAFT`/`HAS_HOOKS`/`UNKNOWN`, computed server-side against real refs |
| `additions`, `deletions`, `changedFiles` | S4   | review cost                                                                                                         |
| `reviewRequests`                         | S5   | pending (unanswered) reviewer requests                                                                              |
| `labels`                                 | S6   | which CI gate this PR opted out of                                                                                  |
| `autoMergeRequest`                       | S7   | will this land without me?                                                                                          |

### 3.2 Not free, but nearly — unresolved review threads

**`gh pr list --json` cannot answer this.** Its complete review-side field set is
`reviews`, `latestReviews`, `reviewDecision`, `reviewRequests`, `comments` — none
carries `isResolved`. `comments` is issue-level; `reviews` is submissions. Thread
resolution exists only on the GraphQL `PullRequest.reviewThreads` connection.

Measured on this repo, 2026-09-03:

```
gh api graphql -f query='
query($owner:String!,$name:String!){
  rateLimit{cost remaining}
  repository(owner:$owner,name:$name){
    pullRequests(first:50, states:OPEN){
      nodes{ number reviewThreads(first:50){ totalCount nodes{ isResolved isOutdated } } }
    }
  }
}' -F owner=<o> -F name=<n>

→ {"cost": 1}
```

**One call, one rate-limit point, every open PR.** Not per card. `gh api graphql` has
precedent in this codebase already: `src/main/review-viewed-store.ts:197`.

## 4. The cross-cutting decision: chip budget and precedence

This is the part that must be settled **before** any unit ships, and it is why S2..S7
all depend on S1.

Seven units all target one flex line on a card that must stay readable at `compact`
zoom. Added naively, each as another `v-else-if`, the row overflows and the ladder
becomes unmaintainable — and worse, each unit would re-litigate its own priority
against the others in template order.

### 4.1 The model

**One status slot, chosen by a pure function.** The status chip is a single slot filled
by one exported function in `pr-stack-format.ts` — not a `v-if` chain in the SFC. It is
unit-testable, it has a docblock stating the precedence, and every later unit changes
_that function_ rather than adding a branch to a template.

Proposed precedence, highest first:

| Rank | State               | Source                          | Why it outranks the next               |
| ---- | ------------------- | ------------------------------- | -------------------------------------- |
| 1    | `conflicts`         | `mergeable === false` / `DIRTY` | nothing can proceed                    |
| 2    | `retarget`          | `baseKind === 'merged'`         | the PR points at a branch that is gone |
| 3    | `changes-requested` | `reviewDecision`                | a human blocked it (S1)                |
| 4    | `blocked`           | `mergeStateStatus` (S2)         | policy blocks it, no human did         |
| 5    | `approved`          | `reviewDecision`                | ready pending mechanics                |
| 6    | `review` (neutral)  | fallback                        | nothing above applies                  |

**Draft is not in this ladder.** A draft's review state is not meaningful, so it is a
_card-level_ state, not a status chip: it belongs on the title row or as a role-bar
treatment beside `roleBarClass()` (`pr-stack-format.ts:37`). Settle the exact placement
in S1 against `design.md` §6.

### 4.2 Additive chips and their LOD budget

Everything that is not the status slot is _additive_ and budgeted by zoom level:

| Chip                          | Unit     | `full`             | `compact` | `far` |
| ----------------------------- | -------- | ------------------ | --------- | ----- |
| CI (`failing`/`running`/`CI`) | existing | ✅                 | ✅        | —     |
| status slot                   | §4.1     | ✅                 | ✅        | —     |
| `behind`                      | S2       | ✅                 | ✅        | —     |
| unresolved threads            | S3       | ✅                 | ✅        | —     |
| auto-merge marker (icon)      | S7       | ✅                 | ✅        | —     |
| `waiting @x`                  | S5       | ✅                 | —         | —     |
| diff size                     | S4       | ✅                 | —         | —     |
| labels                        | S6       | ✅ (max 2, opt-in) | —         | —     |

Rule: **overflow folds into the expand drawer, never off the card entirely.** A signal
that is hidden at `compact` must still be findable at `full` + expanded.

### 4.3 Colour budget

`bg-red-soft`, `bg-green-soft`, `bg-warning/10` and `bg-surface-2` are the four
treatments in play, all existing tokens. Red and green are **reserved for verdicts** —
conflicts, changes-requested, approved, CI. Anything informational (diff size,
waiting-on, labels) uses `bg-surface-2` / `text-text-3`, or it steals attention from the
signals that mean something.

No raw colours. GitHub's per-label hex (S6) is the one place this contract is at real
risk — see §5.6.

## 5. Per unit

### 5.1 S1 — changes-requested + draft (`T273`)

Render-only, zero network. Also lands the §4.1 precedence function and its tests, which
is the actual reason it is first.

**Decide:** where draft lives (title row vs role bar) and whether the neutral `review`
chip survives at all once S5 can say `waiting @x`.

**Test surface:** new `tests/pr-stack-format.test.ts` — none exists today; the current
tests are `pr-stack-core`, `pr-stack-store`, `pr-stack-prefs`, `pr-stack-card-review`.

### 5.2 S2 — `mergeStateStatus` (`T274`)

Fixes §2.4: absence of a behind chip currently reads as "up to date" when it may mean
"not measured".

**Decide** (recorded with reasoning; recommendation in bold):

- **A — keep both.** `mergeStateStatus` decides _whether_ the chip shows; `rev-list`
  enriches it with a magnitude when the branch is local. Chip degrades `5 behind` →
  `behind`. Nothing is lost, the git call stays.
- B — drop `rev-list`. Boolean chip only. Removes a subprocess fan-out over every node
  (a real latency win at 100 PRs) at the cost of the number.
- C — `mergeStateStatus` only for `BLOCKED`/`UNSTABLE`, leave behind as-is. Does not fix
  the honesty bug.

**A** is recommended. Whatever is chosen, the drawer must distinguish _up to date_ from
_could not measure locally_, and dropping `rev-list` is a behaviour removal that belongs
in `CHANGELOG.md` explicitly.

Overlaps to resolve in the §4.1 function, not a second ladder: `DIRTY` vs the existing
`mergeable === false` conflicts chip; `BLOCKED` vs S1's changes-requested.

### 5.3 S3 — unresolved review threads (`T275`)

The one unit that adds a call. See §3.2 for cost.

**Decide — `isOutdated`.** An unresolved thread anchored to a diff hunk that has since
been rewritten is noise, not a pending action: the code it points at no longer exists.
Counting it inflates the chip and trains the operator to ignore it. **Recommendation:**
the chip counts `isResolved === false && isOutdated === false`; the drawer breaks out
outdated threads separately, so nothing is hidden — only deprioritised.

**Bound the pagination and say so.** `pullRequests(first:N)` and `reviewThreads(first:M)`
both truncate _silently_. Pick N and M, state them, and define what the card renders on
truncation (`50+`). `reviewThreads` is oldest-first, so read it with `last:M`: a truncated
count then misses the old, mostly-resolved threads rather than the newest, likeliest-open
ones.

**Absence is not zero.** A repo where the call failed, `gh` is unauthenticated, the
remote is not GitHub, or the rate limit is spent must render **no** thread chip — never
`0 unresolved`, which is a claim the app cannot support.

Concurrency: the call runs alongside `fetchPrs`/`behindCounts`, not serially after them,
so a refresh does not get perceptibly slower.

KPI: `kpis()` (`pr-stack-core.ts:574`) gains `withUnresolvedThreads`, rendered next to
`0 ready to merge` in the canvas header.

### 5.4 S4 — diff size (`T276`)

`+412 −38 · 9 files`, `tabular-nums`, `full` only — it is informational and so the first
thing to shed.

**Decide:** coloured (+green/−red, the GitHub convention) vs muted `text-text-3`.
**Recommendation: muted** — per §4.3, size is not a verdict and must not compete with
the status chip for the red/green budget. Optionally an S/M/L dot at `compact`; argue it
or drop it, do not ship it silently.

Missing data renders nothing — never `+0 −0 · 0 files`.

### 5.5 S5 — waiting on reviewer (`T277`)

Splits the neutral bucket that survives S1 into _nobody was asked_ (next action:
request a reviewer) and _asked, no answer_ (next action: ping, or wait).

`reviewRequests` returns **pending** requests — requests not yet answered — which is
exactly the needed semantics. Shown only when the status slot resolved to neutral: once
a verdict exists the request list is noise, and that gating lives in the §4.1 function.

Handle team reviewers (a different payload shape than users) without crashing.
`latestReviews` is optional extra credit in the same unit: naming who already approved
or rejected, in the drawer.

### 5.6 S6 — labels (`T278`)

Lowest signal, highest noise, and the only unit whose value is entirely repo-dependent —
hence **off by default**, behind a pref in the existing `pr-stack-prefs.ts` /
`PrStackSettingsPane.vue` surface (already covered by `tests/pr-stack-prefs.test.ts`).
No new settings surface.

**Contract risk, called out explicitly:** GitHub returns a per-label hex `color`. Piping
`#RRGGBB` into a `style` attribute violates `CLAUDE.md`'s no-raw-colours rule and
`design.md` §9. **Recommendation:** do not carry the hex into the renderer at all —
parse `labels` as `string[]` of names, render on neutral tokens. The label's text is the
signal. If colour is wanted later it lands in `design.md` first.

Cap at 2 at `full`, 0 below, remainder in the drawer. An allow-list pattern pref beats
all-or-nothing in a repo with 40 labels; consider it.

### 5.7 S7 — auto-merge armed (`T279`)

An armed PR needs **no operator action** — it lands when its conditions clear. Drawing
it like a stuck PR is the opposite of the truth.

Icon marker in the card's top-right beside the age, not a text chip: it is a state of
the card, not a verdict, and it survives `compact` cheaply.

**Decide:** whether `kpis().readyToMerge` **excludes** an armed PR. The KPI is a to-do
count and a self-landing PR is not a to-do — leaning **yes, exclude**. Whichever way,
pin it with a test in `tests/pr-stack-core.test.ts`.

Drawer names the merge method and arming actor: _auto-merge (squash), armed by @x_.

## 6. Contracts every unit must satisfy

Non-negotiable, per `CLAUDE.md`:

- **`CHANGELOG.md`** entry in the same change, under today's `## YYYY-MM-DD`.
- **i18n parity** — every new `prStack.*` key in **both** `en.json` and `pt-BR.json`, or
  `vue-tsc` breaks (`MessageSchema = typeof en`). Existing keys are listed in
  `en.json` under `prStack`.
- **`design.md` §6 first** if a chip needs a variant, token or row-height that does not
  exist — same change, before the implementation.
- **No raw colours, no off-system sizes.** Tailwind utilities backed by `themes.css`.
- **`docs/user/pr-stack.md`** updated wherever the card's readable state changes. S3 also
  notes, in plain English, that it costs one extra GitHub API call. S6 documents its
  toggle.
- **Tests on the pure surface only** (ADR-0001): `pr-stack-core.ts` and
  `pr-stack-format.ts` get unit tests; the `execFile` shell in `pr-stack.ts` stays
  e2e-only.
- **`npm run typecheck` and `npm run build` both pass** before the unit is reported done.
- **`docs/capy-features.md` untouched** — nothing here is agent-facing.

## 7. Open questions

1. Does the neutral `review` chip still earn its slot once S1, S2 and S5 have carved up
   the bucket it used to represent? Possibly it should disappear entirely and neutral =
   no status chip.
2. Should the whole signal set be per-repo configurable rather than only S6? A pref per
   chip is more honest than the fixed LOD budget in §4.2, but it is also seven more
   toggles nobody will find. Default answer: **no** — the §4.2 budget is the design
   decision; S6 is gated because its value is repo-dependent, not because gating is the
   pattern.
3. `--limit 100` on the PR query and `first: 50` on the GraphQL one disagree. Reconcile,
   or accept and document that a >50-PR repo gets thread counts on the first 50 only.
