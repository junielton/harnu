---
status: draft
tier: complex
prd: docs/prds/T618-project-memory-upgrade.md
adr: docs/adr/0024-project-memory-architecture.md
---

# Memory U1: capture every session

_Chapter 2 of campaign `cmp-021a1d43` (project memory upgrade). Product requirements: PRD T618 §3.1
and §4. Architecture: ADR-0024 (b) capture is involuntary, (e) the benchmark is the acceptance
instrument. Evidence: `docs/studies/2026-11-04-memory-audit.md` §2 and §5 U1. The benchmark this
chapter is graded by is specified in `docs/specs/2026-11-04-memory-benchmark/spec.md` (campaign
chapter 1, step 2, written in parallel); its metric names are cited verbatim. Critic pass:
`docs/specs/2026-11-04-memory-u1-capture/critics.md`._

## Problem

The auto-digest engine (`src/main/memory-digest.ts`, pure core `src/main/mcp/digest-core.ts`)
writes `sessions/<date>-<id8>.md` and replaces `hot.md` when a session ends, completes, or sits
idle for 5 minutes (`LONG_IDLE_MS`, `memory-digest.ts:65`). Measured on this repo on 2026-11-04
(study §2), it leaves most work unrecorded:

- **The only gate is a commit.** `isRelevantWork` is relevant only for `commitCount >= minCommits`
  with `DEFAULT_DIGEST_RELEVANCE = { minCommits: 1 }` (`digest-core.ts:72-96`). A research,
  planning, review or debugging session leaves nothing.
- **Non-git folders leave nothing.** `gatherGitEvidence` returns the empty evidence when
  `git rev-parse HEAD` fails (`memory-digest.ts:121-130`), so the commit gate refuses. The memory
  root is not the obstacle: `resolveMemoryCheckout` already falls back to the folder itself
  (`src/main/mcp/memory-core.ts:76-85`), so a non-git folder would get `<folder>/.harnu/memory/`.
  The audit measured one non-git folder with 8 sessions and 0 bytes of memory.
- **Commits are attributed to every session on the checkout.** Without an in-run baseline the
  engine takes every commit on `HEAD` since the session's `created` time, with no upper bound
  (`memory-digest.ts:139-142`), so two sessions on one checkout each claim the other's commits.
- **Dedup is in memory only.** `SessionDigestState.lastDigestedHead` lives in a `Map`
  (`memory-digest.ts:74-80`, `214-216`); a restart forgets it.
- **`hot.md` is replaced by whichever session digests last** (`applyHot`,
  `memory-digest.ts:383-417`), with the raw last prompt as **Next** (`buildHotProposal`,
  `digest-core.ts:392-417`). Two sessions on two branches overwrite each other, and an operator
  prompt in Portuguese lands in a file the project contract says is written in the app language.
- **Transcripts of removed worktrees are trashed unsummarized.** Cleanup lists a
  `~/.claude/projects/<slug>/` folder whose every transcript names a gone folder
  (`planOrphanTranscripts`, `src/main/gc/gc-orphan-transcripts.ts:141-200`) and trashes it on the
  operator's click (`cleanTranscripts` in `src/main/gc/gc-manual.ts:509-545`, then
  `trashTranscriptsRecorded`, `gc-orphan-trash.ts:33`). Nothing digests it first.
- **`PreCompact` is not observed.** The global hook set (`EVENT_SPECS`,
  `src/main/hook-installer.ts:41-51`) has no `PreCompact`; only a stewarded mission's folder-local
  hook posts it, to the steward route (`src/main/steward-hooks.ts:59`), never to the digest engine.
- **The engine cannot be tested.** `memory-digest.ts` imports `responder-registry.ts`, which imports
  Electron, so its control flow (triggers, dedup, reading) has no unit test; ADR-0001 marks it
  e2e-only. This chapter changes that flow, so it first moves into an injectable module.
- **The user guide is stale.** `docs/user/project-memory.md` says memory writes are approval-gated
  and describes the hot overwrite as "a known rough edge"; BUG-26 removed the gate, and the stale
  comments sit in `digest-core.ts:20-21` and `384-390` too.

The request, atomized. R-1 to R-5 are the operator's own sentences as the campaign card lists them;
R-6 to R-13 come from PRD §3.1, PRD §4, ADR-0024 and the chapter card:

- R-1 Sessions that do not commit leave nothing; every session with at least three user turns must leave a digest.
- R-2 Non-git folders leave nothing; they must get memory too, with the git probe skipped and the transcript recap kept.
- R-3 Worktree transcripts are orphaned and lost; an orphan transcript must get a digest in its owning repo's memory before Cleanup can trash it.
- R-4 Decisions made in a session are lost; the digest must carry what the session decided, as far as a deterministic, model-free extraction can see it.
- R-5 `hot.md` is overwritten by the last session; it must stop being overwritten blindly.
- R-6 The engine remembers what it digested across a restart, and a commit is attributed to the session that made it.
- R-7 `hot.md` and digests are written in the app language.
- R-8 Capture does not depend on an agent calling a verb; hook events, including `PreCompact`, drive it.
- R-9 The capture entry point stays "a hook event reaches the hook bridge", so a later adapter for another CLI (T545) only adds an installer.
- R-10 The operator can see that chapter 2 is done: the digest rows and a notice when a digest fails.
- R-11 The chapter is accepted by the benchmark: `capture_coverage` at least 0.95 for git and for non-git folders, `orphan_loss` 0, no other metric regressed without a recorded reason.
- R-12 The absorbed cards (T521, T196, T263, T265) are each closed, folded or deferred, with the reason.
- R-13 The user guide's stale claims are corrected.

### Definitions the slices share

The user-turn rule and the "has a digest" rule must agree with the benchmark spec's M1 rules; AC-33
checks both on the shared fixture. If the merged benchmark spec words either rule differently, the
benchmark wins and an Amendments row records the change before S-1 is dispatched.

`memory-digest.ts` has a private, unexported `interface GitEvidence` (line 107); S-1's exported
`GitEvidence` in `digest-core.ts` does not collide with it, and S-2 deletes the private one when
`gatherGitEvidence` moves.

- **Parsed line.** A transcript line that `JSON.parse` accepts and that yields an object. Other
  lines are skipped by the scan. Only the reader (`readTranscriptFacts`) applies the length limit: a
  line longer than 1,048,576 UTF-8 bytes (newline excluded) is dropped before parsing and counts for
  nothing. `scanTranscriptLines` itself has no length limit.
- **Timestamp.** `Date.parse` of a parsed line's `timestamp` field; a line without a finite one has
  no timestamp. Stored timestamps are normalised with `new Date(ms).toISOString()`.
- **User turn.** A parsed line with `type === "user"`, `isSidechain !== true`, `isMeta !== true` and
  `isCompactSummary !== true` that has operator text. Its operator text is `message.content` when
  that is a string; when it is an array with no `{ type: "tool_result" }` block, it is the `text` of
  every `{ type: "text" }` block joined with a newline; otherwise there is none. It is a turn when
  that text, trimmed, is non-empty and starts with none of `<local-command-`, `<command-`,
  `[Request interrupted`. Image-only content has no operator text.
- **Last assistant message.** Assistant lines are `type === "assistant"` with `isSidechain !== true`.
  Claude Code writes one line per content block, and the lines of one message share `message.id`.
  A line's text is the `text` of its `{ type: "text" }` blocks joined with `\n\n`. A line that holds
  at least one text block either extends the current last message (its `message.id` is a non-empty
  string equal to `lastAssistantId`: its text is appended after `\n\n`) or replaces it (any other
  id; a line without a `message.id` always replaces, and `lastAssistantId` becomes `null`). A line
  without a text block (a `tool_use` only) changes nothing. Lines of other kinds between them do not
  break a message.
- **Git-mutating call.** A `{ type: "tool_use", name: "Bash" }` block of an assistant line (sidechain
  or not) whose `input.command` matches `GIT_MUTATING` (below). A call whose line has no
  timestamp is ignored. It is paired with the user line holding the `tool_result` block whose
  `tool_use_id` equals its `id`. Its window is `[start − 2,000 ms, end + 5,000 ms]`, where start is
  the call line's timestamp and end the result line's timestamp, or start when the result line has
  none. False positives (`git log --grep=commit`) are accepted: a window only matters when a
  commit's committer time falls inside it.
- **Asked-and-answered pair.** A `{ type: "tool_use", name: "AskUserQuestion" }` block on a
  non-sidechain assistant line, paired by id with the non-sidechain user line whose `tool_result`
  block has its `tool_use_id` and whose top-level `toolUseResult.answers` is a plain object (not an
  array, not `null`). A result whose id matches no pending ask yields nothing. Each key is a question
  and its value the answer, in key order: an array value is joined with `, `, another non-string
  value is `String(value)`. Question and answer are trimmed, then a pair with an empty question or
  answer (or a `null` or `undefined` answer) is dropped, then each side is cut. A result without
  `answers` (a rejected call) yields no pair. Pairs are kept in the order their results appear; the
  last 10 are kept.
- **Open questions.** Computed from the last assistant message's text, of which only the last
  65,536 code points are used. Remove fenced blocks: a line whose trimmed start is three backticks
  or three tildes opens one, the next such line closes it, an unclosed one runs to the end. Replace
  each match of `INLINE_CODE` (below) with one space. Collect every match of `QUESTION`, trim each,
  drop a match that is empty, is only `?`, or contains `://`, cut each to 300, drop exact duplicates
  of the cut text keeping the later, and keep the last 5. The three regexes of this section:

  ```ts
  const GIT_MUTATING = /\bgit\b[^\n]*\b(commit|merge|rebase|cherry-pick|revert|am|pull)\b/
  const INLINE_CODE = /`+[^`]*`+/g
  const QUESTION = /[^.!?\n]*\?(?=\s|$)/g
  const NEWLINES = /\s*\r?\n\s*/g // collapsed to one space in one-line items
  ```

- **Cut.** By Unicode code points (`Array.from`): a text longer than `n` keeps its first `n − 1`
  code points followed by `…`. The scan applies every cut, so the stored facts are bounded: 300 per
  question, per answer and per open question, 1,500 for the last message (its head is kept).
- **Verbatim block.** Text copied from the transcript (a prompt, an answer, a question, a summary,
  a message) is never translated and is rendered as a markdown blockquote: each line prefixed with
  `> `, an empty line rendered as `>`. In a one-line item (a pair, an open question) every match of
  `NEWLINES` is first replaced with one space.
- **Evidence token.** The digest's third line (after the `# ` title and a blank line) is the header
  line; it ends with `· evidence: <kind>_`, where the kind is `commits`, `no-commits`, `no-git` or
  `orphan`. The Memory pane and the benchmark tell digests apart by it without parsing the body.
- **Owning repo** (of a gone folder). The longest path in the known repo list (`repoPaths` of the
  orphan gather) that contains the folder and still exists. Else, when the folder contains
  `/.claude/worktrees/`, the path before it, if it exists and is a git checkout. Else, when the
  parent folder is named `<repo>-worktrees` or `<repo>.worktrees`, the sibling
  `<grandparent>/<repo>`, if it exists and is a git checkout. Else none. A git checkout is a folder
  where `git rev-parse --git-common-dir` succeeds. The gone folder itself is never an answer.
- **Has a digest.** A session has a digest in a memory dir when `<memoryDir>/sessions/` holds a file
  whose name matches `^\d{4}-\d{2}-\d{2}-<first 8 characters of the session id>\.md$`.
- **Test names.** A proof `test:<file>::<name>` names the exact `it(...)` title in that file, under
  any `describe`.

### Formats the slices build to

S-1 adds every new symbol below beside the old ones and calls none of them, so the build and the
behaviour are unchanged. S-2 switches the engine over and deletes `isRelevantWork`, `formatDigest`,
`DEFAULT_DIGEST_RELEVANCE`, `DigestRelevanceConfig`, `DigestEndReason` and their tests.

**The pure transcript scan** (`src/main/mcp/digest-transcript.ts`, S-1, no I/O, no clock):

```ts
export interface TranscriptFacts {
  userTurns: number
  firstAt: string | null // first parsed line with a timestamp, normalised ISO
  lastAt: string | null // last parsed line with a timestamp, normalised ISO
  gitCalls: { startMs: number; endMs: number }[] // closed windows, widened, in result-line order
  asked: { question: string; answer: string }[] // see the definition
  openQuestions: string[] // of the current last assistant message
  lastAssistantText: string // its text, cut to 1,500
  lastAssistantId: string | null
  lastAssistantTail: string // the last 65,536 code points of its uncut text
  pending: { id: string; kind: 'git' | 'ask'; startMs: number | null }[] // calls with no result yet
}
export function emptyFacts(): TranscriptFacts
export function isUserTurn(entry: Record<string, unknown>): boolean
/** Folds lines into a copy of `facts`. scan(A) then scan(B) deep-equals scan(A + B). */
export function scanTranscriptLines(
  lines: Iterable<string>,
  facts?: TranscriptFacts
): TranscriptFacts
/** gitCalls plus each pending git call as [startMs − 2,000, nowMs + 5,000]; the whole list
 *  stably sorted by startMs. */
export function gitWindows(
  facts: TranscriptFacts,
  nowMs: number
): { startMs: number; endMs: number }[]
```

`pending` holds only git-mutating calls (`kind: 'git'`, raw `startMs`, never null) and
AskUserQuestion calls (`kind: 'ask'`, `startMs` may be null); other tools are not tracked.

**Shared types** (`digest-core.ts`, S-1):

```ts
export type GitEvidence =
  | {
      kind: 'repo'
      head: string | null
      commits: DigestCommit[]
      fileStats: DigestFileStat[]
      dirtyCount: number
    }
  | { kind: 'not-a-repo' }
  | { kind: 'unavailable' } // the folder is gone (orphan); S-5
export type DigestReason = 'ended' | 'idle' | 'compact' | 'catch-up' | 'orphan'
export interface DigestGate {
  minCommits: number
  minUserTurns: number
}
export const DIGEST_GATE: DigestGate = { minCommits: 1, minUserTurns: 3 }
```

**The trigger** (`digest-core.ts`, S-1):
`digestTriggerFor(edge: { event: string; taskState: string }): 'digest-ended' | 'digest-compact' | 'arm-idle' | 'cancel-idle' | 'none'`,
checked in this order: `event === 'PreCompact'` gives `digest-compact`; `event === 'SessionEnd'`
gives `digest-ended`; `taskState === 'completed'` gives `digest-ended`; `taskState` `working` or
`needs-input` gives `cancel-idle`; `taskState === 'idle'` gives `arm-idle`; anything else
(`failed`, `stopped`, an unknown value) gives `none`.

**The planner** (`digest-core.ts`, S-1):

```ts
export interface DigestPlanInput {
  facts: TranscriptFacts
  git: GitEvidence
  last: { head: string | null; userTurns: number } | null // what this session's previous digest saw
  orphan?: boolean // true for a transcript whose folder is gone (S-5)
  gate?: DigestGate
}
export type DigestPlan =
  | { action: 'skip'; reason: 'insufficient' | 'unchanged' }
  | {
      action: 'write'
      evidence: 'commits' | 'no-commits' | 'no-git' | 'orphan'
      relevance: 'commits' | 'turns'
    }
export function planDigest(input: DigestPlanInput): DigestPlan
```

The order is fixed. First the gate: let `n` be `git.commits.length` for `repo`, else 0; relevance
is `commits` when `n >= minCommits`, else `turns` when `facts.userTurns >= minUserTurns`, else the
plan is skip `insufficient`. Then dedup: when `last` is not null, the head (`git.head` for `repo`,
else `null`) equals `last.head`, and `facts.userTurns` equals `last.userTurns`, the plan is skip
`unchanged`. Otherwise it is `write`, with evidence `orphan` when `orphan` is true or the git kind
is `unavailable` (whatever else holds), `no-git` for `not-a-repo`, `commits` when `n` is at least
one, and `no-commits` otherwise. The planner sees no
MCP verb, no memory module and no file path.

**The digest body** (`renderDigest`, `digest-core.ts`, S-1):

```ts
export interface DigestRenderInput {
  date: string // YYYY-MM-DD, passed in
  title: string // cut to 200 code points by renderDigest
  branch?: string // ignored when git.kind is 'not-a-repo'
  sessionShort: string
  reason: DigestReason
  plan: Extract<DigestPlan, { action: 'write' }>
  git: GitEvidence
  facts: TranscriptFacts
  awaySummary?: string
  taskSummary?: string
  lastPrompt?: string
  otherCommits?: number // S-4
}
export function renderDigest(input: DigestRenderInput): string
```

The parts, in this order, are separated by exactly one blank line; a section is its `## ` heading,
a blank line, then its content; a section with nothing to show is left out whole; the result ends
with one newline:

1. `# <title>`.
2. The header line (template below), where the verb is `ended`, `went idle`, `compacted`,
   `caught up` or `recovered from a removed folder` for the five reasons, and the branch part is
   present when `branch` is non-empty and `git.kind` is not `not-a-repo`.
3. `## Evidence`, by kind. `commits`: the lines today's `formatDigest` writes after its
   `## Evidence` heading (the commit list, the files line, the uncommitted line), unchanged.
   `no-commits`: `**Commits (0)** — none in this session`, then today's uncommitted line when
   `dirtyCount` is above zero. `no-git`: `_Not a git repository: no git evidence._`. `orphan`:
   `_The folder was removed; git evidence is not available._` when `git.kind` is `unavailable`;
   when `git.kind` is `repo` (S-5 found the branch), the same lines as `commits`, while the header
   token stays `orphan`. S-1 builds and tests both cases. From S-4 on, when `otherCommits` is above zero, a last line:
   `_<n> other commits landed on this checkout during the session (not attributed to it)._`
4. `## Asked and answered`: one line per pair, `> - **Q:** <question> — **A:** <answer>`.
5. `## Open questions`: one line per question, `> - <question>`.
6. `## Recap`: today's label line `_The session's own summary — context, not verified fact:_`, a
   blank line, then the first non-empty of `awaySummary`, `taskSummary`, `lastPrompt` as a verbatim
   block (today's chain and 1,500 cap).
7. `## Left off`: `lastPrompt` (today's 500 cap) as a verbatim block, left out when the trimmed
   `lastPrompt` equals the trimmed recap source text (both before any cap).
8. `## Last message`: `facts.lastAssistantText` as a verbatim block, left out when it, trimmed,
   equals the trimmed recap source text (before the recap's cap).

```text
_Session `<id8>` · branch `<branch>` · <verb> · auto-digest · evidence: <kind>_
```

(Without a branch, the ` · branch ...` part is absent.) The whole is at most
`MEMORY_ENTRY_MAX_CHARS` (8,000, `memory-core.ts:39`), the cap `appendMemoryEntry` checks on the
entry alone. While it is longer, the lowest remaining section among 8, 7, 6, 5, 4 has its content
replaced by `_…cut to fit_` (heading kept). The title, header and Evidence are never cut; with the
title capped at 200 and Evidence capped by `DIGEST_COMMIT_CAP` and `DIGEST_FILE_CAP`, they fit.
`renderDigest` is pure: the same input gives the same bytes.

The fixture session `a1000003` (below) renders exactly as shown with this full input:
`date: '2026-11-03'`, `title: 'Session a1000003'`, `branch: 'main'`, `sessionShort: 'a1000003'`,
`reason: 'ended'`, `plan: { action: 'write', evidence: 'no-commits', relevance: 'turns' }`,
`git: { kind: 'repo', head: 'f'.repeat(40), commits: [], fileStats: [], dirtyCount: 0 }`,
`facts: scanTranscriptLines(transcriptLines(a1000003, { repo: '/r', plain: '/p', gone: '/g' }).main)`,
no `awaySummary`, `taskSummary`, `lastPrompt` or `otherCommits`:

```markdown
# Session a1000003

_Session `a1000003` · branch `main` · ended · auto-digest · evidence: no-commits_

## Evidence

**Commits (0)** — none in this session

## Asked and answered

> - **Q:** Which storage should the cache use? — **A:** file
> - **Q:** Ship behind a flag? — **A:** yes, later

## Open questions

> - Should we also migrate old entries?
> - Do you want a CHANGELOG entry?

## Last message

> Migrated the cache to file storage. Should we also migrate old entries? Do you want a CHANGELOG entry? See `cache?.ts` and https://example.com/?q=1.
```

**The reader and git** (`src/main/mcp/digest-io.ts`, S-2, Node only, no Electron; imports the types
from `digest-core.ts`):

- `readTranscriptFacts(path: string, from?: { offset: number; facts: TranscriptFacts }): Promise<{ facts: TranscriptFacts; offset: number }>`
  reads with `fs.createReadStream` from `offset` (default 0), splits on `\n` itself, discards the
  bytes of a line past the limit until its newline without keeping them, does not parse a trailing
  line that has no newline yet (the returned offset stops before it), and feeds complete lines to
  `scanTranscriptLines`. It never throws: an unreadable file returns the input facts and offset.
- `readTranscriptTruth(path)`, moved unchanged from `memory-digest.ts:168-198`.
- `gatherGitEvidence(folder: string, sinceUnixSec: number, baselineHead: string | null, rev?: string): Promise<GitEvidence>`,
  moved from `memory-digest.ts:121-160`. When `git -C <folder> rev-parse --is-inside-work-tree`
  fails (any error, a missing folder included) it returns `not-a-repo` and runs no other git
  command. A repo without a commit is `{ kind: 'repo', head: null, commits: [], fileStats: [],
dirtyCount }`. Otherwise it selects commits exactly as today (`commitsAfter` the baseline head,
  else `commitsSince` the given time, no upper bound) on `rev` (default `HEAD`). S-4 narrows the
  selection; until then two sessions on one checkout both list every commit since their start, as
  the fixture table's S-2 column says.

**The engine** (`src/main/mcp/digest-engine.ts`, S-2). Today's `DigestEngine` moves here with its
I/O injected; `LONG_IDLE_MS` moves with it and `memory-digest.ts` re-exports it. `memory-digest.ts`
keeps only the wiring: `registerDigestEngine`, `closeDigestEngine`, the real deps, the shadow log.

```ts
export interface EngineSession {
  transcriptPath: string
  folder: string
  branch?: string
  created?: string // SessionEntry.created
  summary?: string
  whatsHappening?: string
  firstPrompt?: string
}
export interface DigestEngineDeps {
  resolveSession(id: string): Promise<EngineSession | null>
  readFacts(
    path: string,
    from?: { offset: number; facts: TranscriptFacts }
  ): Promise<{ facts: TranscriptFacts; offset: number }>
  readTruth(path: string): Promise<ReturnType<typeof deriveTranscriptTruth>>
  gatherGit(folder: string, sinceUnixSec: number, baselineHead: string | null): Promise<GitEvidence>
  writeDigest(
    folder: string,
    page: string,
    entry: string,
    sessionId: string
  ): Promise<{ ok: boolean; error?: string; detail?: string }>
  writeHot(
    folder: string,
    sessionId: string,
    branch: string | undefined,
    title: string,
    hot: string
  ): Promise<void>
  now(): number
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
}
export function createDigestEngine(deps: DigestEngineDeps): {
  /** Returns the digest's promise for a digest trigger (callers may ignore it), else undefined. */
  onTaskEdge(ev: HookTaskEvent): Promise<void> | undefined
  digestNow(sessionId: string, reason: DigestReason): Promise<void>
  close(): void
}
```

`onTaskEdge` reads only `ev.sessionId`, `ev.event` and `ev.taskState` (fields `HookTaskEvent` has
today) and passes `{ event, taskState }` to `digestTriggerFor`. It reacts to every edge it receives,
not only to state changes, exactly as today's `onTaskEdge`: a repeated `idle` edge (a `Notification`
while idle, say) re-arms the timer, and a repeated `completed` edge digests again, which the planner
turns into `unchanged`. Per trigger: `digest-ended` and `digest-compact` clear the session's idle
timer and return `digestNow` with `ended` or `compact`; `arm-idle` clears the timer and arms a new
one that calls `digestNow` with `idle` after `LONG_IDLE_MS`; `cancel-idle` clears it; `none` does
nothing. Timer handling runs even while a digest is in flight. A session's state is `{ timer?,
scan?: { offset, facts }, last?: { head: string | null; userTurns: number } }`.

`digestNow(id, reason)` does these steps, in order:

1. If a digest of `id` is in flight, return (the in-flight set, as today); else mark it in flight
   and clear the mark when done, whatever happens.
2. `resolveSession(id)`; `null` returns.
3. `readFacts(transcriptPath, state.scan)`; store the result as `state.scan` (the next digest of this
   session resumes from it).
4. `gatherGit(folder, since, state.last?.head ?? null)`, where `since` is `facts.firstAt` in unix
   seconds, else `created` in unix seconds, else `now() / 1000 − 86,400`.
5. `planDigest({ facts, git, last: state.last ?? null })`; a skip returns.
6. `readTruth(transcriptPath)`; the title is the first non-empty of `pickTitle(truth.titles)`,
   `summary`, `whatsHappening`, `truth.titles.taskSummary`, `firstPrompt`, `Session <id8>` (today's
   chain, `memory-digest.ts:290-296`).
7. `renderDigest` with `date = formatMemoryDate(now())`, `awaySummary`, `taskSummary` and
   `lastPrompt` from the truth.
8. `writeDigest(folder, 'sessions/<date>-<id8>', entry, id)`. When it is not `ok`, log
   `[memory-digest] digest write refused (<error>): <detail>` and return.
9. Set `state.last = { head, userTurns: facts.userTurns }`, where head is `git.head` for `repo`,
   else `null`.
10. `writeHot` with today's `buildHotProposal` (until S-7), from the date, title, branch, the commits
    (`repo` commits, else none), the last prompt, the away summary and the digest page.

A thrown error anywhere is logged `[memory-digest] digest failed` and swallowed, as today. A second
digest of the same session on the same day appends to the same `sessions/<date>-<id8>` page (pages
under `sessions/` are append-mode, `memory-core.ts:300-320`) under its own provenance stamp.

The hub forwards every admitted hook event to its observers, including events that leave the task
state unchanged (`ingest` in `src/main/detect/task-state-hub.ts` builds a `HookTaskEvent` for every
applied event), so `PreCompact` reaches the engine once it is installed; AC-39 drives that path
through the real hub (`resetHubForTests`, `configureHub({ isHibernated: () => false })`,
`addTaskEventObserver`, then `ingest` of a `PreCompact` event with `source: 'hook'` and a window
getter returning `null`), with no change to the hub. The hook body's
`transcript_path`, `trigger` and `custom_instructions` are not used: the bridge does not forward
them, and the engine resolves the transcript from the session id.

**The persisted state** (S-4), `<userData>/memory-digest-state.json`, written atomically (write
`<file>.tmp`, then rename), replaces the in-memory `scan` and `last`:

```json
{
  "version": 1,
  "sessions": {
    "<sessionId>": {
      "lastDigestAt": 1730721600000,
      "last": { "head": null, "userTurns": 7 },
      "scan": { "offset": 81234, "facts": {} }
    }
  }
}
```

`last.head` is a 40-character sha or `null`; `scan.facts` is a `TranscriptFacts`. Entries whose
`lastDigestAt` is older than 30 days are pruned on load. A file that does not parse, or has another
`version`, is read as empty and logged once; it never throws.

### The shared fixture

The fixture is declared, not hand-written: `tests/fixtures/memory-u1/sessions.json` holds the table
below, and `tests/helpers/memory-u1-fixture.ts` turns it into transcripts. S-1 ships both (S-1 needs
only `transcriptLines`); S-2 adds `buildMemoryU1Home`.

```ts
export interface FixtureSession {
  id: string // full session id
  folder: 'repo' | 'plain' | 'gone'
  startMin: number // minutes after T
  endMin: number
  turns: number
  gitCalls: { atMin: number; subject: string; subagent?: boolean }[]
  ask?: { atMin: number; answers: Record<string, string | string[]> }
  lastText?: string
}
/** The transcript lines of one session (and of its subagent file), with placeholders resolved. */
export function transcriptLines(
  s: FixtureSession,
  paths: { repo: string; plain: string; gone: string }
): { main: string[]; subagent: string[] }
/** Builds a temp home: the git repo with its commits, the plain folder, the projects tree. */
export function buildMemoryU1Home(tmp: string): Promise<{
  home: string // <tmp>/home, the benchmark's --home
  repo: string // <tmp>/repo
  plain: string // <tmp>/plain
  gone: string // <tmp>/repo/.claude/worktrees/feature-x, never created
  sessions: FixtureSession[]
  transcriptOf(id: string): string // absolute path of the main transcript
  subagentsOf(id: string): string[] // absolute paths of its subagent transcripts
}>
```

`sessions.json` is `{ "T": "2026-11-01T10:00:00.000Z", "sessions": FixtureSession[] }`, the ten
rows of the table in table order; the plan columns are not stored (they are the tests'
expectations). T is that instant; the replay clock is T + 2 days (`2026-11-03`). Every line carries
`sessionId`, `uuid` (`<id8>-<n>` in the main file and `<id8>-s<n>` in the subagent file, n counting
from 1 in each), `cwd` (the folder's path), `timestamp` (on every line except the main file's line 1, the summary
line; every subagent line has one), and `gitBranch` (`main` in
`repo`, `feature-x` in `gone`, absent in `plain`). A `tool_use` id is `toolu_<id8>_<n>`, with the
`n` of the line that carries it. The flagged noise lines (`isMeta`, `isSidechain`,
`isCompactSummary`) carry text that would otherwise be a turn, so only the flag excludes them. `transcriptLines` writes, for a
session with start S and end E:

1. A `{ "type": "summary", "summary": "fixture" }` line with no timestamp.
2. An `isMeta: true` user line (a noise line) at S.
3. For each turn k from 1 to `turns`: a user line with string content `turn <k> of <id8>` at S + (k − 1) × 10 min, and an assistant line with one text block `reply <k>` and `message.id` `<id8>-r<k>` 30 s later.
4. After turn 1, at S + 1 min, S + 1 min + 1 s, and so on: an assistant `Read` `tool_use` and its `tool_result` user line; an `isSidechain: true` user line; an `isCompactSummary: true` user line; an image-only user line; a user line `<local-command-stdout>ok</local-command-stdout>`. None is a turn.
   Exact contents: the `tool_result` line's `message.content` is
   `[{ "type": "tool_result", "tool_use_id": "toolu_<id8>_<n>", "content": "ok" }]`; the image-only
   line's is `[{ "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "iVBORw0KGgo=" } }]`;
   the local-command line's is the string `<local-command-stdout>ok</local-command-stdout>`; the
   `isMeta`, `isSidechain` and `isCompactSummary` lines' is the string `noise <id8>`.
5. For each git call: an assistant `Bash` `tool_use` with command `git commit -m "<subject>"` at the given minute, and its `tool_result` user line (`ok`) 2 s later; in the subagent file instead when `subagent` is true.
6. For `ask`: an assistant `AskUserQuestion` `tool_use` whose input lists the questions, and 1 min later the user line with the `tool_result` and `toolUseResult: { answers }`.
7. At E: an assistant line with one text block, `lastText` or `done <id8>`, and `message.id` `<id8>-end`.

Lines are emitted in timestamp order. The subagent file holds `isSidechain: true` lines only. Every
git command the helper runs is isolated from the machine's configuration: environment
`GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1`, and `-c commit.gpgsign=false
-c core.hooksPath=/dev/null`; `git init` gets `--template=` (empty). The helper creates the repo with
`git init -b main`, author and committer `fixture
<fixture@example.com>`, an initial commit `chore: init` at T − 1 day, and then one commit per git call
in time order, each adding a file `<subject>.txt`, with `GIT_AUTHOR_DATE` and `GIT_COMMITTER_DATE`
set to the call time + 1 s. It writes each main transcript to
`<home>/.claude/projects/<slugOfPath(folder)>/<id>.jsonl` and each subagent file to
`<home>/.claude/projects/<slug>/<id>/subagents/agent-1.jsonl` (`slugOfPath`,
`src/main/gc/gc-transcripts.ts`), and sets every file's mtime to E. Each file is its lines joined with `\n` followed by a trailing
`\n`, as Claude Code writes JSONL, so the reader parses the last line too. No `.git` directory is committed
under `tests/`.

| id8        | folder | start, end (min) | turns | git calls (min, subject)    | other                                                                                      | S-2 plan                    | final plan                      |
| ---------- | ------ | ---------------- | ----- | --------------------------- | ------------------------------------------------------------------------------------------ | --------------------------- | ------------------------------- |
| `a1000001` | repo   | 0, 40            | 4     | 15 `c1`                     | —                                                                                          | write commits (c1 to c4)    | write commits (c1), 0 other     |
| `a1000002` | repo   | 120, 150         | 3     | —                           | —                                                                                          | write no-commits            | write no-commits                |
| `a1000003` | repo   | 180, 250         | 7     | —                           | ask at 185: the two answers shown in the example; `lastText` is the example's last message | write no-commits            | write no-commits                |
| `a1000004` | repo   | 270, 285         | 2     | —                           | —                                                                                          | skip insufficient           | skip insufficient               |
| `a1000005` | repo   | 50, 90           | 3     | 65 `c2`; 80 `c4` (subagent) | —                                                                                          | write commits (c2, c3, c4)  | write commits (c2, c4), 1 other |
| `a1000006` | repo   | 52, 90           | 3     | 75 `c3`                     | same checkout as `a1000005`                                                                | write commits (c2, c3, c4)  | write commits (c3), 2 other     |
| `a1000007` | plain  | 300, 330         | 3     | —                           | —                                                                                          | skip (no-git deferred, S-3) | write no-git                    |
| `a1000008` | plain  | 360, 375         | 2     | —                           | —                                                                                          | skip insufficient           | skip insufficient               |
| `a1000009` | gone   | 420, 480         | 5     | —                           | branch `feature-x` is never created                                                        | not replayed                | write orphan, by the S-5 gather |
| `a100000a` | gone   | 510, 515         | 1     | —                           | —                                                                                          | not replayed                | not counted (one turn)          |

The full ids are `<id8>-0000-4000-8000-000000000000`. The `ask` answers are
`{ "Which storage should the cache use?": "file", "Ship behind a flag?": ["yes", "later"] }`. The
expected sets are: git `capture_coverage` denominator `a1000001`, `a1000002`, `a1000003`, `a1000005`,
`a1000006`; non-git denominator `a1000007`; orphans `a1000009` (and `a100000a`, which has no turn
count to matter). Subagent files are not sessions.

**The replay** (`tests/memory-u1-capture-bench.test.ts`, S-2) drives the real engine: it builds the
home with `buildMemoryU1Home` in a directory made by `mkdtemp(join(os.tmpdir(), 'memory-u1-'))`
(every test using the helper does the same; the helper throws when
`git -C <plain> rev-parse --is-inside-work-tree` succeeds, so the plain folder is never inside a
work tree), then `createDigestEngine` with the real `readTranscriptFacts`,
`readTranscriptTruth` and `gatherGitEvidence`; `resolveSession` from the fixture table (folder path,
transcript path, `branch: 'main'` for `repo`); `writeDigest` calling `appendMemoryEntry({ memoryDir:
memoryDirFor(folder), page, entry, author: 'agent', sessionId, now })` (`memoryDirFor`,
`memory-core.ts:87`); `writeHot` doing nothing; `now` returning the replay clock; timers unused. It
calls `digestNow(id, 'ended')` once per `repo` and `plain` session, in order of end time, and never
for `gone` sessions (from S-5, one orphan gather digests those). It then scores `<tmp>/home` with
the scorecard function that `scripts/memory-bench-core.mjs` exports (stp-2) and reads
`capture_coverage` (git and non-git, each with its numerator and denominator counts) and
`orphan_loss`. The function's name, its arguments and the key paths of those values (and of
per-session ids, when the scorecard exposes them) are copied from the merged benchmark spec into an
Amendments row before S-2 is dispatched; S-2 is blocked until that row exists. Later slices add deps to the engine
(S-3 `memoryCheckout`, S-4 `subagentTranscripts`, S-8 `notify`); the replay passes the real or
fixture value for each.

### Absorbed cards

| Card | Disposition                                                                                                                                                                                                                                                                                |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| T521 | **Folded, partly.** S-5 adds its precondition: an orphan transcript is digested into its owning repo's memory before it can be trashed, and an undigested one needs an explicit confirm. The autopilot toggle that would trash orphans unattended stays in T521, which now depends on S-5. |
| T196 | **Deferred, stays in the backlog.** U1 makes new sessions leave a trace and S-4's catch-up sweep reaches back 7 days (D-9); seeding a repo's memory from its git log and docs at adoption is a different job. It can reuse chapter 4's proposal path once that exists.                     |
| T263 | **Deferred to chapter 4 (U3).** Distilling digests into lessons is a model's job. U1's contribution: every digest carries an evidence token and an asked-and-answered section the worker can select by.                                                                                    |
| T265 | **Deferred to chapter 4 (U3).** Its signals become the worker's inputs. U1's contribution: a no-commit session now has a digest (evidence `no-commits`), so "done without a commit" is readable from memory instead of invisible.                                                          |
| T195 | **Chapter 2 half closed here** (PRD §7): S-2 captures at `PreCompact`. The typed handoff injected at `SessionStart` is chapter 3.                                                                                                                                                          |
| T413 | **Chapter 2 half closed here** (PRD §7): the compaction digest is the `compact` trigger. Re-injection is chapter 3; the companion-mod recap stays with T389.                                                                                                                               |

## Goals

- G-1 Every session with at least three user turns, in a git repo or not, leaves a digest when it ends, compacts, goes idle for 5 minutes, or is found later by the catch-up sweep.
- G-2 A digest says what the session itself did: only its own commits, what it asked and was answered, what it left open.
- G-3 A removed worktree's sessions survive as digests in the owning repo's memory before Cleanup can trash their transcripts.
- G-4 `hot.md` no longer loses another branch's state to the last session that digested.
- G-5 The benchmark shows the chapter worked: `capture_coverage` at least 0.95 for git and non-git folders, `orphan_loss` 0.

### Observability

What the operator sees when chapter 2 is done, so it is visibly done (R-10):

- **Memory pane, Timeline tab.** Every digest row shows its evidence token as a badge: "No commits",
  "No git", "Recovered" (orphan). A commit-backed digest, and any digest written before this
  chapter, shows no badge. S-8.
- **Cleanup, Other leftovers, transcripts of removed folders.** Each row shows "Digested" when every
  counted session has a digest in the owning repo's memory, or "N not digested" otherwise; the
  confirm dialog asks for an explicit choice before trashing an undigested project. S-6.
- **Activity bell.** A digest that cannot be written (the memory write was refused, or threw) posts
  one notice, "Memory digest failed", naming the folder and the reason, at most once per folder per
  hour. A skipped digest (too few turns, nothing new, an unsafe root) is not a failure and posts
  nothing. S-8.
- **The benchmark report.** S-9 commits the before/after scorecard.

**Non-goals:**

- NG-1 Anything a model writes: typed decision, gotcha or rule pages, consolidation, weekly rollups. That is chapter 4 (U3). U1's extraction is structural and deterministic. (R-4)
- NG-2 Anything injected at session start, the typed handoff, and the tiered `memory_read`. That is chapter 3 (U2). S-7 is deliberately minimal because chapter 3 replaces `hot.md` with the derived handoff.
- NG-3 Other CLIs (T545). The entry point stays a hook POST to the loopback bridge, folded into an edge `{ sessionId, event }` that the engine resolves to a transcript; the planner takes nothing else, so an adapter only adds an installer. (R-9)
- NG-4 Translating operator or model text. Verbatim text stays verbatim and fenced (R-7, D-8).
- NG-5 Backfilling history older than the catch-up window (T196).
- NG-6 A per-folder capture opt-out (ADR-0024 lists it as a likely follow-up).
- NG-7 A new MCP verb or a change to an existing verb's arguments or ACK. Nothing here is agent-facing; `docs/harnu-features.md` is not touched.

**Anti-goals:**

- A digest engine that makes a hook wait. The hook response path stays `200 {}` and the digest runs after it, off the request.
- A digest written under a folder that is gone, which would re-create a removed worktree's directory.
- A non-git digest written into the home directory or under `~/.claude` or `~/.harnu`, which would collide with Claude Code's data or with ADR-0024's global memory layer.
- A digest that claims another session's commits as evidence.
- Cleanup refusing with no way forward (the project's "no dead ends" rule): an undigested orphan can still be trashed, by an explicit, informed choice.

## Slices

Nine slices, one PR each, stacked in order (S-1 to S-9). S-1 to S-5, S-7 and S-8 all edit
`digest-core.ts` or the engine, so no two of them can run side by side; S-6 (renderer) could run
beside S-7 but stays in the stack. The card's suggested S-1 is split in two (S-1 pure core, S-2
engine and wiring): the engine first has to move out of the Electron-bound `memory-digest.ts` to be
testable, and the two together would pass the ~500-line budget. Each slice that changes behaviour
adds its `CHANGELOG.md` entry (AC-28). No slice adds a file directly under `src/main/` (new files go
under `src/main/mcp/` or `src/main/gc/`), so the user-docs gate is not triggered by a new
main-process file. `docs/user/project-memory.md` gets a "When a digest is written" section in S-2
(AC-38), which S-3, S-4 and S-5 each extend by one bullet, and S-8 rewrites the stale parts (AC-27).
An open D-n gating a slice does not block it: the slice builds the default, and a later different
answer is an Amendments row with a delta.

### S-1 · Pure core: transcript scan, planner, trigger, digest body

- depends-on: —
- substrate: worktree
- files-may-touch: `src/main/mcp/digest-transcript.ts` (new), `src/main/mcp/digest-core.ts`, `tests/digest-transcript.test.ts` (new), `tests/digest-plan-seam.test.ts` (new), `tests/mcp-digest-core.test.ts`, `tests/helpers/memory-u1-fixture.ts` (new), `tests/fixtures/memory-u1/sessions.json` (new)
- produces: transcript-scan, digest-planner, digest-render, digest-trigger, memory-u1-sessions
- consumes: existing:digest-core
- gated-by: D-1, D-2
- acs: AC-1, AC-3, AC-4, AC-6, AC-7, AC-34, AC-37

What changes: `digest-transcript.ts` (the scan, `isUserTurn`, `gitWindows`); in `digest-core.ts`,
the new types, `planDigest`, `digestTriggerFor` and `renderDigest`, beside the old symbols, which
stay until S-2. The stale comments go: the module header lines that say the hot snapshot is a
proposal waiting for Approval Inbox review (`digest-core.ts:20-21`) and the same claim in the
comment above `buildHotProposal` (`digest-core.ts:384-390`); only the comments change, not the
function. The fixture table and `transcriptLines` land here. Nothing calls the new functions, so the
slice changes no behaviour and needs no CHANGELOG entry.

### S-2 · Engine: turn gate live, full-transcript read, `PreCompact`

- depends-on: S-1
- substrate: worktree
- files-may-touch: `src/main/mcp/digest-engine.ts` (new), `src/main/mcp/digest-io.ts` (new), `src/main/mcp/digest-core.ts`, `src/main/memory-digest.ts`, `src/main/hook-installer.ts`, `tests/digest-engine.test.ts` (new), `tests/digest-io.test.ts` (new), `tests/mcp-digest-core.test.ts`, `tests/hook-installer.test.ts`, `tests/memory-u1-capture-bench.test.ts` (new), `tests/helpers/memory-u1-fixture.ts`, `docs/user/project-memory.md`, `CHANGELOG.md`
- produces: digest-engine, transcript-reader, precompact-capture, memory-u1-home, capture-bench-test
- consumes: transcript-scan, digest-planner, digest-render, digest-trigger, memory-u1-sessions, campaign:memory-bench-core (stp-2's `scripts/memory-bench-core.mjs`, merged)
- gated-by: D-1
- acs: AC-2, AC-5, AC-8, AC-28, AC-33, AC-35, AC-36, AC-38, AC-39

What changes: the engine moves to `digest-engine.ts` with the deps above; `memory-digest.ts`
supplies the real ones: `resolveSession` over `scanFolders()` mapping `SessionEntry` (`fullPath`,
`projectPath`, `gitBranch`, `created`, `summary`, `whatsHappening`, `firstPrompt`);
`readTranscriptFacts`, `readTranscriptTruth` and `gatherGitEvidence` from `digest-io.ts`;
`writeDigest` and `writeHot` through `resolveMemoryLocation` and `appendMemoryEntry` with today's
arguments (`memory-digest.ts:315-325`, `392-402`); the shadow-log entry after a hot write as today.
The old `isRelevantWork`, `formatDigest`, `DEFAULT_DIGEST_RELEVANCE`, `DigestRelevanceConfig` and
`DigestEndReason` are deleted with their tests; on 2026-11-04 they are referenced only in
`digest-core.ts`, `memory-digest.ts` and `tests/mcp-digest-core.test.ts` (`git grep`), all in this
slice's files. Until S-3, after step 5 the engine also returns when
the plan's evidence is `no-git`, logging `[memory-digest] skipped: not a git repository`; it sets no
`last` and writes no hot. `hook-installer.ts` adds `{ event: 'PreCompact', tag: '_' }` to
`EVENT_SPECS` with no `settingsMatcher`, so both manual and automatic compactions post. No bridge
change: `startHookServer` takes the event name from the URL path with no allowlist, `PreCompact`
folds to an unchanged task state (`reduceTaskState`, `src/main/hook-state.ts`), and `isDispatchable`
(`src/main/responder-dispatch.ts`) returns false for it. The install path strips Harnu's own
handlers by token and re-adds the full set, so an existing install gains the handler at the next
boot. The steward's folder-local `PreCompact` hook (`steward-hooks.ts:59`) is a separate handler on
a separate route and is untouched. The user guide's new section says, in four bullets: a digest is
written when a session ends, compacts, or sits idle for 5 minutes; a session needs a commit or at
least three messages from you; a digest without commits says so; what it records (evidence, what
was asked and answered, open questions, the last message).

### S-3 · Non-git folders

- depends-on: S-2
- substrate: worktree
- files-may-touch: `src/main/mcp/digest-engine.ts`, `src/main/mcp/digest-core.ts`, `src/main/memory-digest.ts`, `tests/digest-engine.test.ts`, `tests/mcp-digest-core.test.ts`, `tests/memory-u1-capture-bench.test.ts`, `docs/user/project-memory.md`, `CHANGELOG.md`
- produces: non-git-digest
- consumes: digest-engine, memory-u1-home, capture-bench-test
- gated-by: D-3
- acs: AC-9, AC-10, AC-11, AC-28

What changes: the S-2 early return goes, so `no-git` plans are written. The memory dir is the one
`resolveMemoryLocation(folder)` returns today (it goes through `resolveMemoryDir`): the folder's own
`.harnu/memory/`, or the central root when the folder's effective config says central (D-3). A new
pure guard in `digest-core.ts`, `digestTargetAllowed(checkout: string, home: string): boolean`, is
false for a checkout equal to `home` or to the filesystem root, or inside `<home>/.claude` or
`<home>/.harnu`. The engine gains the dep `memoryCheckout(folder): Promise<string>` (the real one
returns `resolveMemoryLocation(folder).checkout`) and checks the guard for every plan, git or not,
between steps 5 and 6, returning with the log line `[memory-digest] skipped: unsafe memory root
<path>`. The guard lives in the digest engine only, so the `memory_*` verbs keep their behaviour
(NG-7).

### S-4 · Per-session commit attribution, persisted state, catch-up sweep

- depends-on: S-3
- substrate: worktree
- files-may-touch: `src/main/mcp/digest-attribution.ts` (new), `src/main/mcp/digest-state.ts` (new), `src/main/mcp/digest-engine.ts`, `src/main/mcp/digest-io.ts`, `src/main/mcp/digest-core.ts`, `src/main/memory-digest.ts`, `tests/digest-attribution.test.ts` (new), `tests/digest-state.test.ts` (new), `tests/digest-engine.test.ts`, `tests/memory-u1-capture-bench.test.ts`, `docs/user/project-memory.md`, `CHANGELOG.md`
- produces: commit-attribution, digest-state, catch-up-sweep
- consumes: transcript-scan, digest-engine, memory-u1-home
- gated-by: D-5, D-9
- acs: AC-12, AC-13, AC-14, AC-15, AC-28

What changes: `digest-attribution.ts` exports
`attributeCommits(candidates: DigestCommit[], windows: { startMs: number; endMs: number }[]): { mine: DigestCommit[]; others: number }`:
a candidate is the session's when `committedAt × 1000` falls inside any window, ends included; the
rest are counted in `others`. The candidates are the commits the S-2 selection returns whose
committer time also lies in `[firstAt − 2 s, lastAt + 5 s]`. The windows are `gitWindows(facts,
now)` of the session's own transcript merged with those of each of its subagent transcripts, which
the new engine dep `subagentTranscripts(sessionId): Promise<string[]>` lists
(`<slug>/<sessionId>/subagents/*.jsonl`; each read with `readTranscriptFacts`). `mine` replaces the
`repo` evidence's commits before planning, and `others` is passed to `renderDigest` as
`otherCommits` (D-5). `digest-state.ts` holds the pure parse, serialize, prune and catch-up
selection; `memory-digest.ts` reads the file at registration and writes it after every successful
digest, and the engine's `scan` and `last` come from it. The catch-up sweep runs once 60 s after
registration and then every 30 minutes, from the fleet model (`scanFolders()`, the cached read): it
selects sessions whose transcript mtime is within the last 7 days (D-9) and at least `LONG_IDLE_MS`
ago, with at least `minUserTurns` user turns (counted with `readTranscriptFacts`), no state entry,
and no digest in the memory dir `resolveMemoryLocation` gives; sorted oldest mtime first; at most 10
per pass; each passed to `digestNow` with `catch-up`, one after another. It covers sessions that ran
while Harnu was closed, a crash, and an operator who turned the hook bridge off.

### S-5 · Orphan transcripts are digested before Cleanup can trash them

- depends-on: S-4
- substrate: worktree
- files-may-touch: `src/main/gc/gc-orphan-digest.ts` (new), `src/main/gc/gc-orphan-transcripts.ts`, `src/main/gc/gc-orphan-shell.ts`, `src/main/gc/gc-manual.ts`, `src/main/gc/gc-ipc.ts`, `src/main/gc/gc-wire.ts`, `src/main/mcp/digest-engine.ts`, `src/main/memory-digest.ts`, `tests/gc-orphans-digest.test.ts` (new), `tests/gc-orphans-transcripts.test.ts`, `tests/gc-manual-clean.test.ts`, `tests/memory-u1-capture-bench.test.ts`, `docs/user/cleanup.md`, `docs/user/project-memory.md`, `CHANGELOG.md`
- produces: orphan-digest, orphan-digest-state
- consumes: digest-engine, commit-attribution, digest-state, memory-u1-home
- gated-by: D-4, D-6
- acs: AC-16, AC-17, AC-18, AC-19, AC-28

What changes: `gc-orphan-digest.ts` exports
`ownerRepoFor(folder: string, repoPaths: readonly string[], probe: { exists(p: string): Promise<boolean>; isCheckout(p: string): Promise<boolean> }): Promise<string | null>`
(the "owning repo" definition) and `digestOrphans(items, deps)`, the gather step. The engine gains
`digestTranscriptInto({ sessionId, transcriptPath, memoryFolder, branch })`: it runs steps 3 to 10
with reason `orphan` and `orphan: true` passed to `planDigest`, git `{ kind: 'unavailable' }` (or, when `branch` resolves in the owning repo,
`git -C <owner> rev-parse --verify <branch>`, the S-4 attribution over
`gatherGitEvidence(owner, since, null, branch)`), the title chain without the session fields, and
writes into `resolveMemoryLocation(memoryFolder)`; it skips the hot write and never touches the gone
folder. In `realOrphanSource` (`gc-orphan-shell.ts`), after `planOrphanTranscripts` lists the items,
`digestOrphans` digests each item's sessions that have at least `minUserTurns` user turns and no
digest in the owner's memory, at most 20 per gather across all items, oldest mtime first (D-4: at
gather time; a project becomes an orphan only after `ORPHAN_QUIET_MS`, 24 hours,
`gc-orphan-transcripts.ts`). The branch is the transcript's `gitBranch`. `OrphanTranscriptItem` gains
`digest: { done: number; total: number; home: string | null }`: `total` counts sessions with at
least `minUserTurns` user turns, `done` those with a digest, `home` the owning repo (`null`: none). In
`gc-manual.ts`'s `cleanTranscripts`, after the existing checks and the fresh gather, an item with
`done < total` is refused `needs-undigested-confirmation` unless its id is in a new
`confirmedUndigested` set, carried on the clean request exactly like `confirmedNotFound`. Because the
refusal reads the fresh gather, a digest that landed meanwhile lifts it (D-6).

### S-6 · Cleanup shows what was digested

- depends-on: S-5
- substrate: worktree
- files-may-touch: `src/renderer/src/components/CleanupOtherItems.vue`, `src/renderer/src/components/CleanupTranscriptsConfirmDialog.vue`, `src/renderer/src/components/CleanupView.vue`, `src/renderer/src/lib/gc-orphans.ts`, `src/renderer/src/i18n/en.json`, `src/renderer/src/i18n/pt-BR.json`, `design.md`, `tests/cleanup-orphan-transcripts.test.ts`, `docs/user/cleanup.md`, `CHANGELOG.md`
- produces: orphan-digest-ui
- consumes: orphan-digest-state
- acs: AC-20, AC-21, AC-28

What changes: each transcripts row gets a chip after the existing memory chip (the
`data-testid="orphan-memory"` span in `CleanupOtherItems.vue`): "Digested" when `done === total` and
`total > 0`, "N not digested" when `done < total` (the memory chip's warning tokens), nothing when
`total === 0`. The confirm dialog lists how many sessions are not digested and where digests went
(`home`), and shows a checkbox, "Trash without a digest", that must be ticked before Trash is
enabled when any selected item has `done < total`; ticking it puts those ids in
`confirmedUndigested`. If design.md §6 has no green chip variant, S-6 adds it to design.md first
(the design contract). Both locale files get every new key.

### S-7 · `hot.md` stops being overwritten blindly

- depends-on: S-6
- substrate: worktree
- files-may-touch: `src/main/mcp/digest-core.ts`, `src/main/mcp/digest-engine.ts`, `src/main/memory-digest.ts`, `tests/mcp-digest-core.test.ts`, `tests/digest-engine.test.ts`, `docs/user/project-memory.md`, `CHANGELOG.md`
- produces: hot-merge
- consumes: digest-planner, digest-engine
- gated-by: D-8
- acs: AC-22, AC-23, AC-28

What changes: `buildHotProposal` becomes
`mergeHot({ current: string | null; currentKey: string | null; next: HotProposalInput; nextKey: string }): string`,
pure. The key is the branch, or the folder path for a non-git folder. The engine gains the dep
`readHot(folder): Promise<string | null>` and takes `currentKey` from the file's first provenance
stamp (`parseProvenanceLine`, `memory-core.ts`; its `branch`, else `null`). Same key, no current hot,
or a null current key: today's replace. Different key: the current body is kept and a
`**Parallel:**` list at its end gets one line for the new key,
``- `<key>` · <date> · <title> → [[sessions/<slug>]]``, replacing an older line for the same key;
newest first, at most 5 lines, the oldest dropped; while the whole is over `HOT_MAX_WORDS` (500),
the oldest parallel line is dropped. **Next** is the open questions (one bullet each, as a verbatim
block) when there are any, else the label `Last prompt (verbatim):` followed by the last prompt as a
verbatim block, else `—`; it is never the bare last prompt. Every label Harnu writes in `hot.md`
comes from one exported constant table in `digest-core.ts` (`MEMORY_LABELS`, English; D-8). The hot
write keeps its shadow-log entry. Chapter 3 replaces all of this with the derived handoff (NG-2).

### S-8 · Observability and the user guide

- depends-on: S-7
- substrate: worktree
- files-may-touch: `src/main/mcp/memory-core.ts`, `src/main/mcp/digest-core.ts`, `src/main/mcp/digest-engine.ts`, `src/main/memory-digest.ts`, `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/src/components/MemoryPane.vue`, `src/renderer/src/i18n/en.json`, `src/renderer/src/i18n/pt-BR.json`, `design.md`, `tests/mcp-memory-digest.test.ts`, `tests/mcp-digest-core.test.ts`, `tests/digest-engine.test.ts`, `docs/user/project-memory.md`, `CHANGELOG.md`
- produces: evidence-badges, digest-failure-notice
- consumes: digest-engine, non-git-digest, orphan-digest
- acs: AC-24, AC-25, AC-26, AC-27, AC-28

What changes: `DigestMeta` (`memory-core.ts`, the interface after `DIGEST_NAME`) gains
`evidence?: 'commits' | 'no-commits' | 'no-git' | 'orphan'`, parsed by `parseDigestMeta` from the
header token; a digest without the token has none and renders as today. `MemoryPane.vue`'s timeline
row shows the badge. The failure notice: a pure
`shouldNotifyDigestFailure(lastNoticeAt: number | undefined, nowMs: number): boolean` (true when
undefined or at least 3,600,000 ms ago) in `digest-core.ts`, applied per folder; the engine gains the
dep `notify(folder: string, reason: string): void`, called at step 8's refusal and on a thrown write.
`memory-digest.ts` gains `setDigestNoticeBridge(bridge)`, which `index.ts` calls right after
`registerCommandBridge` (the bridge is created after `registerDigestEngine` today, `index.ts:726` and
`753`), and posts `notify.push` with `{ folderPath, title: 'Memory digest failed', description:
<reason>, kind: 'warning' }`, the shape `scheduler-shell.ts:337` uses. `src/preload/index.ts` is
touched only if the `DigestMeta` type re-export needs it. In `docs/user/project-memory.md`, the
approval-gate sentence in "The memory pane", the "A known rough edge" section, and "one per session
that wrote a summary" under "What's in it" go; the badges are explained.

### S-9 · Acceptance measurement

- depends-on: S-8
- substrate: session
- files-may-touch: `docs/reports/` (one new file, `<date>-memory-u1-acceptance.md`), `docs/specs/2026-11-04-memory-u1-capture/spec.md` (an Amendments row only)
- produces: u1-acceptance-report
- consumes: campaign:memory-bench-cli (stp-2's `npm run memory:bench`)
- gated-by: D-7
- acs: AC-29, AC-30, AC-31, AC-32

What changes: nothing in code. Seven days after S-8 is merged and running in the operator's build,
run `npm run memory:bench -- --repo . --since <S-8 merge date> --json` and the same for the non-git
folder the audit measured, and commit the markdown scorecard with the command lines, the commit sha
and a delta table against `docs/reports/2026-11-04-memory-bench-baseline.md` (stp-2's baseline) in
the A/B form the benchmark spec defines.

## Acceptance criteria

Every test named below is new or extended in the slice that owns the AC. Fixture tests use the
shared fixture and its helper.

| id    | statement                                                                                                                                                                                                                                                                                                                                                                                                                                                      | proof                                                                                                                          | refines/inherits | covers     |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------- | ---------- |
| AC-1  | `planDigest` follows the stated order: 0 commits and 3 user turns writes with relevance `turns`; 0 commits and 2 turns skips `insufficient`; 1 commit and 1 turn writes with relevance `commits`; a matching `last` skips `unchanged`; an insufficient session with a matching `last` skips `insufficient`; with `orphan: true` a `repo` session with commits writes evidence `orphan`.                                                                        | test:tests/mcp-digest-core.test.ts::planDigest gates on commits or three user turns                                            | —                | R-1        |
| AC-2  | `readTranscriptFacts` on each fixture transcript returns the table's user-turn count: tool-result lines, `isMeta`, `isSidechain`, `isCompactSummary`, image-only and `<local-command-` lines are not turns.                                                                                                                                                                                                                                                    | test:tests/digest-io.test.ts::counts fixture user turns                                                                        | —                | R-1, R-11  |
| AC-3  | `renderDigest` renders the fixture session `a1000003` byte for byte as the example in Formats, and the same input twice gives identical bytes.                                                                                                                                                                                                                                                                                                                 | test:tests/mcp-digest-core.test.ts::renders the a1000003 example digest                                                        | —                | R-1        |
| AC-4  | On `transcriptLines` output, `scanTranscriptLines` yields `a1000003`'s two pairs and two open questions and `a1000005`'s window around minute 65; scanning in two parts split at any line deep-equals one scan; on inline lines, each cut (300, 1,500) and the 10-pair and 5-question limits hold.                                                                                                                                                             | test:tests/digest-transcript.test.ts::extracts pairs, questions and git windows incrementally                                  | —                | R-4        |
| AC-5  | `installHooks` over a settings file holding a foreign hook and a Harnu block built without `PreCompact` leaves exactly one Harnu `PreCompact` handler posting to `/hook/<token>/PreCompact/_`, keeps the foreign hook, and duplicates no handler.                                                                                                                                                                                                              | test:tests/hook-installer.test.ts::installs a PreCompact handler                                                               | —                | R-8, R-9   |
| AC-6  | `digestTriggerFor` returns `digest-compact` for `PreCompact` with any task state, `digest-ended` for `SessionEnd` with `working`, `digest-ended` for `completed`, `cancel-idle` for `working` and `needs-input`, `arm-idle` for `idle`, and `none` for `failed` and `stopped`.                                                                                                                                                                                 | test:tests/mcp-digest-core.test.ts::digestTriggerFor maps hook edges                                                           | —                | R-8        |
| AC-7  | `tests/digest-plan-seam.test.ts` reads its own source and asserts its imports are only `vitest`, `node:fs`, `node:path`, `digest-transcript.ts`, `digest-core.ts` and the fixture helper, then gets a `write` plan for `a1000002` from `scanTranscriptLines` and `planDigest` with a hand-built `GitEvidence`.                                                                                                                                                 | test:tests/digest-plan-seam.test.ts::plans from a transcript and git evidence alone                                            | —                | R-8, R-9   |
| AC-8  | After the replay, the benchmark's `capture_coverage` for git folders is at least 0.95.                                                                                                                                                                                                                                                                                                                                                                         | test:tests/memory-u1-capture-bench.test.ts::git capture_coverage is at least 0.95                                              | —                | R-1, R-11  |
| AC-9  | For a `not-a-repo` session the engine runs no git command after the first probe and writes a digest whose third line ends with `· evidence: no-git_` and has no branch part.                                                                                                                                                                                                                                                                                   | test:tests/digest-engine.test.ts::writes a non-git digest                                                                      | —                | R-2        |
| AC-10 | `digestTargetAllowed` is false for the home directory, `/`, and paths inside `<home>/.claude` and `<home>/.harnu`, true for an ordinary folder under the home directory; the engine writes nothing for a refused one.                                                                                                                                                                                                                                          | test:tests/mcp-digest-core.test.ts::digestTargetAllowed refuses unsafe roots                                                   | —                | R-2        |
| AC-11 | After the replay, the benchmark's `capture_coverage` for non-git folders is at least 0.95.                                                                                                                                                                                                                                                                                                                                                                     | test:tests/memory-u1-capture-bench.test.ts::non-git capture_coverage is at least 0.95                                          | —                | R-2, R-11  |
| AC-12 | On the fixture, `a1000005` is attributed c2 and c4 (c4 through its subagent transcript) and `a1000006` only c3; `a1000001` only c1.                                                                                                                                                                                                                                                                                                                            | test:tests/digest-attribution.test.ts::attributes commits to the session that made them                                        | —                | R-6        |
| AC-13 | `a1000006`'s digest lists only c3 under Evidence and ends Evidence with `_2 other commits landed on this checkout during the session (not attributed to it)._`; `a1000005`'s says 1.                                                                                                                                                                                                                                                                           | test:tests/digest-attribution.test.ts::unattributed commits are context, not evidence                                          | —                | R-6        |
| AC-14 | The state round-trips; after a reload a session whose head and user-turn count match its record plans `unchanged`; a scan resumed from the stored offset and facts deep-equals a full scan; a corrupt or wrong-version file reads as empty without throwing; entries older than 30 days are pruned.                                                                                                                                                            | test:tests/digest-state.test.ts::dedup and scan offset survive a reload                                                        | —                | R-6        |
| AC-15 | The catch-up selection returns only sessions modified within 7 days and at least 5 minutes ago, with at least 3 user turns, no state entry and no digest; oldest first; at most 10.                                                                                                                                                                                                                                                                            | test:tests/digest-state.test.ts::catch-up selects quiet undigested sessions                                                    | —                | R-8, R-11  |
| AC-16 | `ownerRepoFor` returns the longest existing known repo containing the folder, else the `.claude/worktrees` parent, else the `<repo>-worktrees` sibling, else `null`, never the gone folder or a path under it; after `digestTranscriptInto` the gone folder still does not exist.                                                                                                                                                                              | test:tests/gc-orphans-digest.test.ts::resolves the owning repo and never writes under the gone folder                          | —                | R-3        |
| AC-17 | A gather digests `a1000009` into `<repo>/.harnu/memory/sessions/` with `evidence: orphan`, does not count `a100000a`, reports `digest: { done: 1, total: 1, home: <repo> }`, caps at 20 per gather, and a second gather writes nothing.                                                                                                                                                                                                                        | test:tests/gc-orphans-digest.test.ts::digests orphan sessions at gather time                                                   | —                | R-3        |
| AC-18 | `cleanTranscripts` refuses an item with `done < total` as `needs-undigested-confirmation` unless its id is in `confirmedUndigested`, and trashes it when it is.                                                                                                                                                                                                                                                                                                | test:tests/gc-manual-clean.test.ts::refuses an undigested project unless confirmed                                             | —                | R-3        |
| AC-19 | After the replay and one gather, the benchmark's `orphan_loss` is 0.                                                                                                                                                                                                                                                                                                                                                                                           | test:tests/memory-u1-capture-bench.test.ts::orphan_loss is zero                                                                | —                | R-3, R-11  |
| AC-20 | A transcripts row shows the "Digested" chip when every counted session is digested and the "N not digested" chip otherwise, after the memory chip.                                                                                                                                                                                                                                                                                                             | capture:cleanup-view@orphan-transcripts-mixed-digest                                                                           | —                | R-3, R-10  |
| AC-21 | The confirm dialog keeps Trash disabled for a selection holding an undigested item until "Trash without a digest" is ticked, and then sends those ids in `confirmedUndigested`.                                                                                                                                                                                                                                                                                | test:tests/cleanup-orphan-transcripts.test.ts::undigested items need an explicit choice                                        | —                | R-3        |
| AC-22 | `mergeHot` replaces for the same key, a null current key or no current hot; for a different key it keeps the body and upserts one `**Parallel:**` line (newest first, at most 5); the result is never over 500 words.                                                                                                                                                                                                                                          | test:tests/mcp-digest-core.test.ts::mergeHot keeps another branch's snapshot                                                   | —                | R-5        |
| AC-23 | In `hot.md`, every text copied from the transcript is a verbatim block, every label is a value of `MEMORY_LABELS`, and **Next** is never the bare last prompt.                                                                                                                                                                                                                                                                                                 | test:tests/mcp-digest-core.test.ts::hot fences verbatim text and uses the label table                                          | —                | R-7        |
| AC-24 | `parseDigestMeta` reads `evidence` for all four kinds and leaves it undefined for a digest without the token.                                                                                                                                                                                                                                                                                                                                                  | test:tests/mcp-memory-digest.test.ts::parses the digest evidence token                                                         | —                | R-10       |
| AC-25 | The Memory pane timeline shows "No commits", "No git" and "Recovered" badges on the matching rows and no badge on a commit-backed or older digest.                                                                                                                                                                                                                                                                                                             | capture:memory-pane@timeline-evidence-badges                                                                                   | —                | R-10       |
| AC-26 | `shouldNotifyDigestFailure` allows one notice per folder per hour; a refused or thrown digest write calls the engine's `notify` once with the folder and the reason; a skipped plan never calls it.                                                                                                                                                                                                                                                            | test:tests/digest-engine.test.ts::notifies a digest failure once per folder per hour                                           | —                | R-10       |
| AC-27 | `docs/user/project-memory.md` no longer says memory writes are approval-gated or carries "A known rough edge", and explains each badge.                                                                                                                                                                                                                                                                                                                        | record:user-doc                                                                                                                | —                | R-13       |
| AC-28 | Each slice that changes behaviour has a `CHANGELOG.md` entry under its merge date.                                                                                                                                                                                                                                                                                                                                                                             | record:changelog                                                                                                               | —                | R-10       |
| AC-29 | Over the 7 days after S-8 is running, this repo's `capture_coverage` for git folders is at least 0.95, in the committed acceptance report.                                                                                                                                                                                                                                                                                                                     | record:report                                                                                                                  | AC-8             | R-1, R-11  |
| AC-30 | Over the same window, the audit's non-git folder's `capture_coverage` is above 0, and the report states it against the 0.95 target.                                                                                                                                                                                                                                                                                                                            | record:report                                                                                                                  | AC-11            | R-2, R-11  |
| AC-31 | In the same report, `orphan_loss` is 0 for orphans with an owning repo, and orphans with no owning repo are counted on their own line.                                                                                                                                                                                                                                                                                                                         | record:report                                                                                                                  | AC-19            | R-3, R-11  |
| AC-32 | The report gives every benchmark metric's delta against the 2026-11-04 baseline, and names each regression with the open decision or amendment that accepts it.                                                                                                                                                                                                                                                                                                | record:report                                                                                                                  | —                | R-11, R-12 |
| AC-33 | On the fixture after the replay, the scorecard's git and non-git `capture_coverage` denominators count 5 and 1 sessions (the expected sets' sizes by `isUserTurn`) and their numerators equal the number of those sessions that have a digest by this spec's rule; when the scorecard exposes per-session ids, the id sets are compared instead of the counts.                                                                                                 | test:tests/memory-u1-capture-bench.test.ts::user-turn and digest rules agree with the benchmark                                | —                | R-1, R-11  |
| AC-34 | `digest-core.ts` no longer says the hot snapshot waits for an Approval Inbox decision.                                                                                                                                                                                                                                                                                                                                                                         | script:node -e "process.exit(require('fs').readFileSync('src/main/mcp/digest-core.ts','utf8').includes('Approval Inbox')?1:0)" | —                | R-13       |
| AC-35 | With fakes, awaiting each promise `onTaskEdge` returns before the next edge: a `PreCompact` edge writes once; two `SessionEnd` edges write once (`readFacts` and `gatherGit` are called twice, `writeDigest` once: the second plans `unchanged`); `working` cancels the idle digest; `idle` writes once after `LONG_IDLE_MS` on the fake timer; a digest trigger while a digest is in flight (a `readFacts` fake held open) causes no second `readFacts` call. | test:tests/digest-engine.test.ts::drives digests from hook edges                                                               | —                | R-8        |
| AC-36 | `readTranscriptFacts` scans a transcript larger than 256 KiB from its first line, drops a line over 1 MiB without counting it, leaves a trailing line without a newline for the next read, and returns the input unchanged for an unreadable file.                                                                                                                                                                                                             | test:tests/digest-io.test.ts::reads a whole transcript within the line limit                                                   | —                | R-1        |
| AC-37 | In a digest, every pair, open question, recap, left-off text and last message is a verbatim block, and over 8,000 characters sections are cut from 8 up to 4 with `_…cut to fit_`, never the title, header or Evidence; an `orphan` plan with `repo` git renders the commit lines under the token `orphan`.                                                                                                                                                    | test:tests/mcp-digest-core.test.ts::fences verbatim text and cuts to fit                                                       | —                | R-4, R-7   |
| AC-38 | `docs/user/project-memory.md` has a "When a digest is written" section with the S-2 bullets.                                                                                                                                                                                                                                                                                                                                                                   | record:user-doc                                                                                                                | —                | R-1, R-8   |
| AC-39 | Through the real hub (`ingest` of a `PreCompact` event with `source: 'hook'`, the engine's `onTaskEdge` registered with `addTaskEventObserver`), the engine with fake deps writes one digest with reason `compact`.                                                                                                                                                                                                                                            | test:tests/digest-engine.test.ts::a PreCompact hook event reaches the engine through the hub                                   | —                | R-8, R-9   |

Every atom lands: R-1 (AC-1, AC-2, AC-3, AC-8, AC-29, AC-33, AC-36, AC-38), R-2 (AC-9, AC-10, AC-11,
AC-30), R-3 (AC-16 to AC-21, AC-31), R-4 (AC-4, AC-37; the rest is NG-1), R-5 (AC-22; the rest is
NG-2), R-6 (AC-12 to AC-14), R-7 (AC-23, AC-37; NG-4, D-8), R-8 (AC-5, AC-6, AC-7, AC-15, AC-35,
AC-38, AC-39), R-9 (AC-5, AC-7, AC-39; NG-3), R-10 (AC-20, AC-24 to AC-28), R-11 (AC-2, AC-8, AC-11, AC-15, AC-19,
AC-29 to AC-33), R-12 (the Absorbed cards table, AC-32), R-13 (AC-27, AC-34).

## Open decisions

Resolve one at a time. A resolved row is also recorded as one line in project memory
(`memory_append` to `decisions`): `D-n · <question> · chosen: <option> · <date>`. An unanswered
decision is never read as declined: the gated slice builds the default, and a later different answer
is an Amendments row with a delta to the affected executor.

| id  | question                                                                                                                      | options                                                                                                                                                                                                                | default                                                                                                      | status |
| --- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------ |
| D-1 | How many user turns make a no-commit session worth a digest (gates S-1, S-2)?                                                 | 1 · 3 · 5                                                                                                                                                                                                              | 3, the PRD §3.1 number and the M1 denominator, so coverage and the gate count the same set                   | open   |
| D-2 | What does the model-free recap extract (gates S-1)?                                                                           | (a) structural only: asked-and-answered pairs, open questions from the last message, the CLI's own summaries, the last message · (b) (a) plus keyword lines ("decided", "chose") · (c) the last message only, as today | (a): language-independent and deterministic; keyword lists break on a Portuguese session                     | open   |
| D-3 | Where does a non-git folder's memory live (gates S-3)?                                                                        | (a) the folder's own `.harnu/memory/`, or the central root when its config says so (what `resolveMemoryLocation` already returns) · (b) always under a central root in Harnu's data dir                                | (a), with S-3's unsafe-root guard                                                                            | open   |
| D-4 | When is an orphan's transcript digested (gates S-5)?                                                                          | (a) at Cleanup gather time, before the row is shown · (b) when Harnu itself removes the worktree · (c) both                                                                                                            | (a): it also covers worktrees removed outside Harnu; `ORPHAN_QUIET_MS` (24 h) leaves time                    | open   |
| D-5 | How is a commit attributed to a session (gates S-4)?                                                                          | (a) committer time inside the session's own git-mutating tool-call windows · (b) author email plus the session window · (c) the commit hash parsed from the tool output                                                | (a): (b) cannot tell two sessions of one operator apart; (c) fails on quiet and filtered output (critics.md) | open   |
| D-6 | What happens to an orphan that cannot be digested, no owning repo or a failed write (gates S-5, S-6)?                         | (a) trashable only after an explicit "Trash without a digest" choice, and counted in the report · (b) a fallback "unhomed" memory under Harnu's data dir · (c) never trashable from Cleanup                            | (a): no dead end, no new memory location                                                                     | open   |
| D-7 | U1 writes more digests, so `memory_read_default_bytes` and `index_bytes` grow until chapter 3 slims them; accept (gates S-9)? | (a) accept and report the delta until chapter 3 · (b) cap the page-id list inside U1                                                                                                                                   | (a): capping is chapter 3's job (PRD §3.2), and U1 must not change `memory_read`                             | open   |
| D-8 | Which language are Harnu's labels in when the app language is not English (gates S-7)?                                        | (a) English (`MEMORY_LABELS`) until a memory label set exists for that locale · (b) add a label set per locale in this chapter                                                                                         | (a): the app language is English today; verbatim text is fenced either way                                   | open   |
| D-9 | How far back does the catch-up sweep look (gates S-4)?                                                                        | 7 days · 30 days · none (hooks only)                                                                                                                                                                                   | 7 days, the acceptance window; anything older is T196                                                        | open   |

## Amendments · Deviations

Append-only after approval. Never edit the sections above once the first card is dispatched;
record the change here and send the affected executor a delta. Before S-2 is dispatched, a row here
records the benchmark scorecard function, its arguments and the key paths of `capture_coverage`
(git, non-git, with their numerator and denominator counts, and per-session ids when exposed) and
`orphan_loss`, copied from the merged benchmark spec.

| date | kind | what changed | by  |
| ---- | ---- | ------------ | --- |
