# Project memory

Every session working on a repo starts from zero context unless something bridges the gap. Project memory is Harnu's answer: a small, per-repo folder of markdown notes at `.harnu/memory/` that every session and every worktree of that repo shares — so "what we decided last week" and "where we left off" don't have to be re-explained every time you open a new session.

## Where it lives, and the move from `.capy/`

Harnu keeps all of a repo's data — memory, the roadmap board, missions and canvases — in a `.harnu/` folder at the repo root, and only ever reads and writes that folder. Earlier versions used `.capy/`. The first time you launch a version that uses `.harnu/`, Harnu **copies** each known repo's `.capy/` into `.harnu/` automatically (including every worktree's own scratch folder; a repo that only shows up under "Active elsewhere", or that you add later, is copied the first time Harnu opens it, and a symlinked `.capy` is followed so its content is copied too). The old `.capy/` is left exactly as it was, so you can delete it by hand when you no longer need it; nothing keeps the two in sync after the copy. If a repo already has a `.harnu/` that Harnu didn't create, nothing is copied and you get a notice in the Activity bell naming the repo — move or delete one of the two folders to settle it.

## What's in it

On disk, it's just files:

- **`hot.md`** — a short (kept under ~500 words), frequently-replaced snapshot of where things stand right now. This is the first thing a session should read when it starts.
- **`decisions.md`** — a running, dated log of decisions and the reasoning behind them, appended to over time rather than rewritten.
- **`index.md`** — an auto-maintained catalog of everything else: counts and a breakdown of roadmap cards by status, links to the other pages.
- **`roadmap/`** — one file per [roadmap board](roadmap-board.md) card.
- **`sessions/`** — dated digest entries, one per session that wrote a summary of what it did.
- **`archive/`** — older material that's been superseded but kept for reference.

Because it's plain markdown in your repo, you can read or edit any of it by hand in your normal editor — nothing about the format requires going through Harnu, and hand-editing or deleting a file never corrupts anything else.

## When a digest is written

Harnu writes the session digests in `sessions/` on its own, from the hooks it already installs; no session has to ask for one.

- **A digest is written when a session ends, compacts, or sits idle for 5 minutes.** A later digest of the same session on the same day is added to the same file.
- **A session needs a commit or at least three messages from you.** A shorter session with no commit leaves no digest, and a digest is not written again when nothing changed since the last one.
- **A digest without commits says so.** Its header line ends with `evidence: no-commits` and its Evidence section reads "none in this session", so a session that researched, planned or reviewed is still recorded without claiming work it didn't commit.
- **What it records:** the git evidence (commits, files changed, uncommitted changes), what the session asked you and what you answered, the questions its last message left open, and that last message, all quoted word for word rather than paraphrased.
- **A folder that isn't a git repository gets digests too.** They go to that folder's own `.harnu/memory/` (or to your central memory folder, if the folder's memory settings say so), their header line ends with `evidence: no-git`, and the Evidence section says there is no git evidence; everything else is recorded the same way. Harnu never writes a digest into your home folder itself, the root of the disk, or anything inside `~/.claude` or `~/.harnu`: a session started there is skipped.
- **A digest lists only the session's own commits, and nothing is missed or repeated across a restart.** A commit counts as the session's when it was made during one of the session's own `git` commands (its subagents' included); commits that other sessions or you made on the same checkout while it ran are left out, and one line at the end of Evidence says how many there were. Harnu remembers what each session's last digest saw in `memory-digest-state.json` in its data folder, so restarting Harnu never writes the same digest twice. A minute after Harnu starts, and every 30 minutes after that, it also digests the sessions of the last 7 days that no hook reached (they ran while Harnu was closed, Harnu crashed, or the hook bridge was off): at least three of your messages, quiet for 5 minutes, no digest yet, at most 10 at a time, oldest first.
- **A removed worktree's sessions are digested before their transcripts can be trashed.** Removing a worktree takes its folder but leaves the Claude transcripts in `~/.claude/projects`, which [Cleanup](cleanup.md) can later move to the trash. So when Cleanup lists those transcripts (they must be at least 24 hours old), Harnu first writes a digest of each session with at least three of your messages into the memory of the repo the worktree belonged to: the longest known repo that contains the folder, else the repo above a `.claude/worktrees` folder, else the sibling a `<repo>-worktrees` folder names. Their header line ends with `evidence: orphan` and the Evidence section says the folder was removed, unless the session's branch still exists in that repo, in which case its own commits are listed. At most 20 sessions are digested per scan, oldest first, and a session that already has a digest is skipped. The removed folder is never recreated and `hot.md` is not touched. The same holds for the other digests: one for a session whose folder no longer exists is skipped, never written back into that folder.
- **`hot.md` keeps another branch's snapshot.** When a session digests, Harnu no longer lays its snapshot over whatever `hot.md` held. If the snapshot there belongs to the same branch (or the file has none yet), it is replaced as before. If it belongs to another branch, it stays, and the new session gets one line in a **Parallel:** list at the end: the branch, the date, the session's title and a link to its digest. The list is newest first, holds at most 5 lines (the oldest goes), and shrinks further when `hot.md` would pass its 500-word limit. A session whose transcript names no branch is filed under the branch the folder is on now; in a folder outside git the folder's path stands in for the branch. **Next** lists the questions the session's last message left open, quoted word for word; with none, it shows your last message under "Last prompt (verbatim):" (quoted, in your own language), or a dash. Harnu's own labels in `hot.md` are always English. If `hot.md` can't be read at that moment, it is left as it is.

## The memory pane

Right-click a folder and choose **Project memory** to open a read-only pane (as a [split](sessions.md#splits), so it sits alongside whatever you're working on) with three tabs:

- **Hot** — renders `hot.md`.
- **Decisions** — renders `decisions.md`.
- **Timeline** — lists session digests newest-first, each with its date, title, author, and branch, so you can scan what's happened recently across every session that touched this repo.

The pane itself doesn't have edit or save controls — it's a viewer. Writing happens either by hand-editing the files directly, or through a session using its memory-writing capability (see below), which is approval-gated like any other write a session makes.

## Decisions that replace each other

A decision a session records in `decisions.md` gets an id (`e-1a2b3c4d`) and a start date, shown on a small `> entry:` line above its provenance. When a later decision overrides it, the session names the old one, and Harnu marks the old entry `superseded_by` the new one. Nothing is deleted: searching memory for a phrase from the old decision shows the match together with the decision that replaced it, so nobody acts on the stale line. A decision can also say which files or topics it is about (`watches`); when a new mission or campaign is started on those files or with those words, the live decisions come back to the session in its reply. Entries written before this existed have no id and are simply never recalled.

## Memory is context, not instructions

The single most important thing to understand about project memory: **it's notes, not commands.** A past session — possibly a different agent entirely — may have left an entry in `decisions.md` or written a "hot" snapshot, but that doesn't make it authoritative or binding on what happens next. Treat what you read there the way you'd treat a colleague's handoff note: useful context to orient yourself, always weighed against what you can currently observe in the code and the conversation, never followed blindly. Every entry carries provenance (who/what wrote it and when) precisely so you can judge how much to trust it.

This matters in practice because project memory is explicitly designed to be **agent-writable**: a session can append a decision, log a summary of its own work, or replace the "hot" snapshot with an updated one — all without your approval for each individual entry, in the same way it can freely draft roadmap cards. That convenience is exactly why it's worth remembering that anything you find there is a claim to verify, not an instruction to execute.

## A known rough edge

Auto-generated session digests write into `hot.md` as part of keeping the snapshot current. There's a known case where an automatic digest can overwrite the hot snapshot instead of proposing the update for review first — if you notice `hot.md` losing content you expected to still be there, that's the likely cause. It's a tracked, open issue rather than something you need to work around by hand, but worth knowing about if the snapshot looks unexpectedly thin.

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

The command only reads files. It never changes your memory or your transcripts, and it uses at most half of your CPU cores. A folder that is not a git repo works too. It shows 0 % capture until memory exists for plain folders. The report says what each number is based on, such as "54 of 77 sessions", so a 0 caused by an empty folder is easy to tell apart from a real problem.
