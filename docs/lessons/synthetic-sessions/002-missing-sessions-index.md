# 002-missing-sessions-index: never assume `sessions-index.json` exists

**Category:** synthetic-sessions
**Discovered in:** `5da9bcf` (B-8 — JSONL fallback for Claude 2.1.152+, May 2026)
**Status:** active

## The bug

`claude-reader.ts#scanProjects()` originally read every project from
`~/.claude/projects/<slug>/sessions-index.json`. If the file was missing
or empty, the project was silently skipped:

```ts
// Old code path
if (idx.entries.length === 0) return null
```

**Symptom:** om2tab folder had 19 JSONLs on disk (the user's live work),
but the sidebar showed `om2tab` with **0 sessions**. The B-6 / B-7
synth-vanishing bugs were a symptom of this same underlying gap:
reconciliation couldn't find a real entry in `disk` because
`scanProjects` had filtered the whole project out.

## Root cause

**Claude Code 2.1.152+ stopped writing `sessions-index.json` on session
creation.** On the dev machine, only 5 out of 76 project slugs had the
index — all legacy slugs from Claude ≤ 2.0. Every newer project had:

- A populated `~/.claude/projects/<slug>/` directory
- Many `<uuid>.jsonl` files
- No `sessions-index.json`

Our reader treated the absence of the index as "no sessions exist". The
reader was making a 2.0-era assumption that no longer held.

## The fix (and why)

Two-tier lookup with a fallback that scrapes the JSONLs directly:

```ts
async function scanProjects(opts: ReadOptions = {}): Promise<ProjectEntry[]> {
  // ...
  const results = await Promise.all(
    slugs.map(async (slug) => {
      const fromIndex = await readProjectIndex(rootDir, slug)
      if (fromIndex) return fromIndex // legacy fast path
      return readProjectFromJsonls(rootDir, slug) // 2.1.152+ fallback
    })
  )
  // ...
}
```

`readProjectFromJsonls` reads the first ~32KB of each `*.jsonl` to
extract the fields we'd otherwise have gotten from the index (sessionId,
cwd, gitBranch, customTitle). Slightly slower but covers the 2.1.152+
disk format.

After B-8 shipped, the dev machine went from showing 2 projects to 55.
om2tab's 19 sessions became visible.

## How to detect in reviews

When reviewing main-process code that reads `~/.claude/projects/`:

1. **Look for `sessions-index.json` references** — if the code path
   doesn't have a JSONL fallback, it's broken for Claude 2.1.152+.
2. **Look for `idx.entries.length === 0` style early-returns** — they
   silently lose data when the index is empty or stale.
3. **Check that the JSONL scrape doesn't open the entire file** — 32KB
   read with `fs.open + read` is ~free; reading the full file would
   blow up on long sessions.

## How to detect in production

If a user reports "my project shows 0 sessions even though I just used
it":

```bash
ls ~/.claude/projects/<slug>/*.jsonl | wc -l            # actual JSONLs on disk
ls ~/.claude/projects/<slug>/sessions-index.json 2>&1   # index file (may not exist)
```

If JSONL count is non-zero but the sidebar shows 0, the reader fallback
isn't running. Either the dev server wasn't rebuilt after B-8 landed, or
a regression re-introduced the index-only assumption.

## Future drift

Claude Code may change its disk format again. The principles to keep:

1. **Use the JSONL as the source of truth.** Each line carries cwd,
   gitBranch, sessionId. The index file is an optimization.
2. **Stat the JSONL for fileMtime, created (use ctime/birthtime).** Don't
   rely on the index for timestamps.
3. **Tail-read** for `custom-title` lines that may be far past the
   32KB head window (separate enhancement, deferred).

## Related

- `src/main/claude-reader.ts#readProjectFromJsonls` — canonical fallback
- `memories/task/003/run-2026-05-27.md` — B-8 timeline
- `superpowers:systematic-debugging` — the bug was found by adding
  `console.log` in `scanProjects` and noticing om2tab was filtered out
  silently
