# 001-bound-filesystem-fanout-at-startup: cap concurrent file scrapes, never `Promise.all` an unbounded set

**Category:** performance (startup / filesystem fan-out)
**Discovered in:** AppImage "won't open / froze the PC" investigation, `ad93c6c` (Jun 2026)
**Status:** active

## The bug

A packaged build failed to open on a large machine and once froze the whole
desktop. The user's `~/.claude/projects/` held ~6500 JSONL transcripts (~1.2 GB),
and only 5 of 62 slugs had a `sessions-index.json` — so 57 slugs (~999 top-level
`*.jsonl`) hit the expensive scrape path. `scanFolders()` did
`Promise.all(slugs.map(...))`, and each index-less slug did
`Promise.all(jsonlNames.map(...))`, each opening a read stream and
`JSON.parse`-ing up to 2 MB. Nested, that fanned out into **~999 simultaneous
read streams + parses on the main-process event loop**. `foldersLoad` never
resolved promptly → the renderer never got its first model → blank window
("won't open"), with a memory/FD burst that could hang the desktop.

## Root cause

An un-throttled `Promise.all` over a set whose size scales with **user data**,
not with a fixed bound. On a small dataset it's a blip; at hundreds of multi-MB
files it pins the event loop, spikes RSS (every chunk + parsed object alive at
once under `Promise.all`), and risks `EMFILE`. The git-probe path already capped
its fan-out (`MAX_CONCURRENCY=8`) — the JSONL scan didn't.

## The fix (and why)

Funnel every per-file scrape through a global semaphore so total files-in-flight
is bounded regardless of slug/file count. Peak RSS on the real dataset dropped to
a bounded ~680 MB and the window paints promptly.

```ts
// src/main/claude-reader.ts
const SCRAPE_CONCURRENCY = 8
let scrapeActive = 0
const scrapeQueue: Array<() => void> = []
function withScrapeSlot<T>(fn: () => Promise<T>): Promise<T> {
  /* acquire → run → release → drain queue */
}

// at the fan-out site:
await Promise.all(
  jsonlNames.map((name) =>
    withScrapeSlot(async () => {
      /* stat + scrape */
    })
  )
)
```

## How to detect in reviews

1. `git grep -n "Promise.all" src/main` — flag any `Promise.all(xs.map(...))`
   where `xs` is a directory listing, a session list, or any **user-data-sized**
   array doing I/O or `JSON.parse` per item. Bound it (semaphore / chunked
   `MAX_CONCURRENCY`) or it's a latent freeze on a big install.
2. Nested fan-out is worse: a bounded outer loop calling an unbounded inner
   `Promise.all` still multiplies. The cap must be **global**, not per-call.
3. Anything heavy on the path the renderer `await`s at boot (`foldersLoad` →
   `scanFolders`) blocks first paint. Heavy work must be bounded and ideally
   yield, so `ready-to-show` isn't starved.

## Related

- `src/main/claude-reader.ts` (`withScrapeSlot`, `scanFolders`, `readProjectFromJsonls`)
- `src/main/git-probe.ts` (`MAX_CONCURRENCY`) — the prior-art cap this mirrors
- `synthetic-sessions/002-missing-sessions-index` — why so many slugs hit the scrape path
