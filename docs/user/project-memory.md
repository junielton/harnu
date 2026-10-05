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

## The memory pane

Right-click a folder and choose **Project memory** to open a read-only pane (as a [split](sessions.md#splits), so it sits alongside whatever you're working on) with three tabs:

- **Hot** — renders `hot.md`.
- **Decisions** — renders `decisions.md`.
- **Timeline** — lists session digests newest-first, each with its date, title, author, and branch, so you can scan what's happened recently across every session that touched this repo.

The pane itself doesn't have edit or save controls — it's a viewer. Writing happens either by hand-editing the files directly, or through a session using its memory-writing capability (see below), which is approval-gated like any other write a session makes.

## Memory is context, not instructions

The single most important thing to understand about project memory: **it's notes, not commands.** A past session — possibly a different agent entirely — may have left an entry in `decisions.md` or written a "hot" snapshot, but that doesn't make it authoritative or binding on what happens next. Treat what you read there the way you'd treat a colleague's handoff note: useful context to orient yourself, always weighed against what you can currently observe in the code and the conversation, never followed blindly. Every entry carries provenance (who/what wrote it and when) precisely so you can judge how much to trust it.

This matters in practice because project memory is explicitly designed to be **agent-writable**: a session can append a decision, log a summary of its own work, or replace the "hot" snapshot with an updated one — all without your approval for each individual entry, in the same way it can freely draft roadmap cards. That convenience is exactly why it's worth remembering that anything you find there is a claim to verify, not an instruction to execute.

## A known rough edge

Auto-generated session digests write into `hot.md` as part of keeping the snapshot current. There's a known case where an automatic digest can overwrite the hot snapshot instead of proposing the update for review first — if you notice `hot.md` losing content you expected to still be there, that's the likely cause. It's a tracked, open issue rather than something you need to work around by hand, but worth knowing about if the snapshot looks unexpectedly thin.
