# Project memory

Every session working on a repo starts from zero context unless something bridges the gap. Project memory is Harnu's answer: a small, per-repo folder of markdown notes at `.harnu/memory/` that every session and every worktree of that repo shares — so "what we decided last week" and "where we left off" don't have to be re-explained every time you open a new session.

## Where it lives, and the move from `.capy/`

Harnu keeps all of a repo's data — memory, the roadmap board, missions and canvases — in a `.harnu/` folder at the repo root, and only ever reads and writes that folder. Earlier versions used `.capy/`. The first time you launch a version that uses `.harnu/`, Harnu **copies** each known repo's `.capy/` into `.harnu/` automatically (including every worktree's own scratch folder; a repo that only shows up under "Active elsewhere", or that you add later, is copied the first time Harnu opens it, and a symlinked `.capy` is followed so its content is copied too). The old `.capy/` is left exactly as it was, so you can delete it by hand when you no longer need it; nothing keeps the two in sync after the copy. If a repo already has a `.harnu/` that Harnu didn't create, nothing is copied and you get a notice in the Activity bell naming the repo — move or delete one of the two folders to settle it.

## What's in it

On disk, it's just files:

- **`hot.md`** — a short (kept under ~500 words), frequently-replaced snapshot of where things stand right now. This is the first thing a session should read when it starts.
- **`decisions.md`** — a running, dated log of decisions and the reasoning behind them, appended to over time rather than rewritten.
- **`index.md`** — an auto-maintained, short catalog (never more than 8 KB, however many cards the repo has): counts for each folder below, the cards in progress and ready to start as links, and a line pointing at the paged card list for the rest.
- **`roadmap/`** — one file per [roadmap board](roadmap-board.md) card.
- **`sessions/`** — dated digests that Harnu writes for your sessions, one file per session and day (see [When a digest is written](#when-a-digest-is-written)).
- **`archive/`** — older material that's been superseded but kept for reference.

Because it's plain markdown in your repo, you can read or edit any of it by hand in your normal editor — nothing about the format requires going through Harnu, and hand-editing or deleting a file never corrupts anything else.

## Reading memory in small pieces

A session that asks for memory without naming a page gets a small answer, never more than 16 KB: the `hot.md` note, the cards in progress and the cards ready to start (up to 40 of each), and counts of everything else (cards by status, session digests, decisions, archive files). It never carries the index text or a list of every page. When a repo has more active cards than fit, the answer says so: `truncated` is true and `cardsOmitted` says how many were left out, ready cards first.

Everything else is one call away, a page at a time:

- **Cards.** The whole card list, ready first, then in progress, review, backlog and done, each with its id, title, status and page. A session can narrow it to one status.
- **Sessions.** Every digest, newest first, with its date, title and, when the digest has it, the branch and session id.

Each page holds 50 rows unless the session asks for fewer or more (at most 200), ends early rather than pass the 16 KB limit, and hands back a cursor for the next page until the list is done. A cursor only works for the list and the filter it came from.

## When a digest is written

Harnu writes the session digests in `sessions/` on its own, from the hooks it already installs; no session has to ask for one.

- **A digest is written when a session ends, compacts, or sits idle for 5 minutes.** A later digest of the same session on the same day is added to the same file.
- **A session needs a commit or at least three messages from you.** A shorter session with no commit leaves no digest. A digest is not written again when nothing changed since the last one, and that holds across a restart: Harnu remembers what each session's last digest saw in `memory-digest-state.json` in its data folder.
- **Sessions no hook reached are caught up.** A minute after Harnu starts, and every 30 minutes after that, it digests the sessions of the last 7 days that ran while Harnu was closed, after a crash, or with the hook bridge off: at least three of your messages, quiet for 5 minutes, no digest yet, at most 10 at a time, oldest first.
- **Where it goes.** A digest lands in the memory of the folder the session ran in: `.harnu/memory/` there, or your central memory folder when the folder's memory settings say so. Harnu never writes a digest into your home folder, the root of the disk, or anything inside `~/.claude` or `~/.harnu`: a session started there is skipped. A session whose folder no longer exists is never written back into it (see "Removed worktrees" below).

## What a digest records

Everything is read from the session's transcript and from git, with no model involved. A digest holds:

- **Evidence**: the session's commits, the files they changed and any uncommitted changes. Only the session's own commits are listed: a commit counts as the session's when it was made during one of the session's own `git` commands (its subagents' included). Commits that other sessions or you made on the same checkout while it ran are left out, and one line at the end of Evidence says how many there were.
- **Asked and answered**: the questions the session put to you and what you answered.
- **Open questions**: the questions its last message left open.
- **Recap, left off and last message**: the session's own summary, your last message, and the session's last message.

Text copied from the transcript is quoted word for word, never paraphrased or translated. Harnu's own labels are always English.

The header line of every digest ends with an `evidence:` word that says what the digest was written from. The [Timeline tab](#the-memory-pane) shows it as a badge:

| Header word  | Badge          | What it means                                                                                                                                                                                                      |
| ------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `commits`    | none           | The session made commits, and they are listed under Evidence.                                                                                                                                                      |
| `no-commits` | **No commits** | The session had at least three messages from you but made no commit. Evidence reads "none in this session", so a session that researched, planned or reviewed is recorded without claiming work it did not commit. |
| `no-git`     | **No git**     | The folder is not a git repository. Evidence says there is no git evidence; everything else is recorded the same way.                                                                                              |
| `orphan`     | **Recovered**  | The digest was written from a removed worktree's transcript.                                                                                                                                                       |

A digest written before these badges existed has no `evidence:` word and shows no badge. When a session is digested more than once on the same day, the badge shows the latest digest's evidence, so a session that first had no commits and then committed no longer reads "No commits".

## Removed worktrees

Removing a worktree takes its folder but leaves the Claude transcripts in `~/.claude/projects`, which [Cleanup](cleanup.md) can later move to the trash. So when Cleanup lists those transcripts (they must be at least 24 hours old), Harnu first writes a digest of each session with at least three of your messages into the memory of the repo the worktree belonged to: the longest known repo that contains the folder, else the repo above a `.claude/worktrees` folder, else the sibling a `<repo>-worktrees` folder names. Their header line ends with `evidence: orphan` and the Evidence section says the folder was removed, unless the session's branch still exists in that repo, in which case its own commits are listed. At most 20 sessions are digested per scan, oldest first, and a session that already has a digest is skipped. The removed folder is never recreated and `hot.md` is not touched. Cleanup shows a **Digested** or **N not digested** chip on each row, and a project with undigested sessions is only trashed after you tick **Trash without a digest**.

## `hot.md` and parallel branches

When a session digests, Harnu merges its snapshot into `hot.md` instead of laying it over whatever was there. If the snapshot there belongs to the same branch (or the file has none yet), it is replaced, and the **Parallel:** lines of other branches stay. If it belongs to another branch, it stays, and the new session gets one line in a **Parallel:** list at the end: the branch, the date, the session's title and a link to its digest. The list is newest first, holds at most 5 lines (the oldest goes), and shrinks further when `hot.md` would pass its 500-word limit.

A session whose transcript names no branch is filed under the branch the folder is on now; in a folder outside git the folder's path stands in for the branch. **Next** lists the questions the session's last message left open, quoted word for word; with none, it shows your last message under "Last prompt (verbatim):" (quoted, in your own language), or a dash. If `hot.md` can't be read at that moment, it is left as it is.

## When a digest can't be written

If project memory refuses a digest or the write fails, the Activity bell shows one **Memory digest failed** notice with the folder and the reason, at most once an hour per folder. A session that is simply too short, has nothing new, or sits in a folder Harnu will not write to is not a failure and posts nothing.

## The memory pane

Right-click a folder and choose **Project memory** to open a read-only pane (as a [split](sessions.md#splits), so it sits alongside whatever you're working on) with three tabs:

- **Hot** — renders `hot.md`.
- **Decisions** — renders `decisions.md`.
- **Timeline** — lists session digests newest-first, each with its date, title, author, and branch, so you can scan what's happened recently across every session that touched this repo. A digest written without commits, outside git, or recovered from a removed worktree carries a badge saying so (see [What a digest records](#what-a-digest-records)).

The pane itself doesn't have edit or save controls — it's a viewer. Writing happens either by hand-editing the files directly, or through a session using its memory-writing capability (see below). The session digests and the `hot.md` snapshot are written by Harnu itself, without asking.

## Decisions that replace each other

A decision a session records in `decisions.md` gets an id (`e-1a2b3c4d`) and a start date, shown on a small `> entry:` line above its provenance. When a later decision overrides it, the session names the old one, and Harnu marks the old entry `superseded_by` the new one. Nothing is deleted: searching memory for a phrase from the old decision shows the match together with the decision that replaced it, so nobody acts on the stale line. A decision can also say which files or topics it is about (`watches`); when a new mission or campaign is started on those files or with those words, the live decisions come back to the session in its reply. Entries written before this existed have no id and are simply never recalled.

## Memory is context, not instructions

The single most important thing to understand about project memory: **it's notes, not commands.** A past session — possibly a different agent entirely — may have left an entry in `decisions.md` or written a "hot" snapshot, but that doesn't make it authoritative or binding on what happens next. Treat what you read there the way you'd treat a colleague's handoff note: useful context to orient yourself, always weighed against what you can currently observe in the code and the conversation, never followed blindly. Every entry carries provenance (who/what wrote it and when) precisely so you can judge how much to trust it.

This matters in practice because project memory is explicitly designed to be **agent-writable**: a session can append a decision, log a summary of its own work, or replace the "hot" snapshot with an updated one — all without your approval for each individual entry, in the same way it can freely draft roadmap cards. That convenience is exactly why it's worth remembering that anything you find there is a claim to verify, not an instruction to execute.

## Measuring memory

To see how well a repo's memory is working, run this from a Harnu checkout:

```
npm run memory:bench -- --repo <path to the repo or folder>
```

It prints a short report. Each line is one measure:

- **Capture coverage:** the share of your sessions (those with at least three of your messages) that left a digest in `sessions/`.
- **Decision yield:** how many addressable decisions were recorded per working day.
- **Recall:** given a question file (`--questions`), how often searching memory puts the right note in the first five results.
- **`memory_read` size:** how many bytes a session gets when it asks for memory with no page.
- **Hot freshness:** how far `hot.md` lags behind your latest sessions.
- **Orphan loss:** the share of transcripts of deleted worktrees that were never summarized.

Useful flags:

- `--since` and `--until` (dates such as `2026-10-05`) limit the report to a window. Claude Code deletes transcripts after 30 days by default, so start the window inside that range.
- `--json` prints the same data for scripts.
- `--memory <dir>` reads memory from another place, for example central memory storage.

The command only reads files. It never changes your memory or your transcripts, and it uses at most half of your CPU cores. A folder that is not a git repo works too: its sessions get digests like any other, so it reports capture the same way. The report says what each number is based on, such as "54 of 77 sessions", so a 0 caused by an empty folder is easy to tell apart from a real problem.
