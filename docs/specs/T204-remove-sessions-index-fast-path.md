# T204 — Remove the dead `sessions-index.json` fast path

**Date:** 2026-08-05 · **Status:** specified (not implemented) · **Card:** `.capy/memory/roadmap/T204-delete-the-dead-sessions-index-json-fast-path-claude-code.md`
**Sibling:** [`T200-cli-version-detection.md`](./T200-cli-version-detection.md) — lists this same read as "pure dead-I/O removal" and explicitly makes it a separate card.

## 0. Verdict up front

**The deletion premise holds, with one correction to the card's wording.** The file is not
absent — **5 of 323** project dirs still carry a `sessions-index.json`, all written between
2026-01-27 and 2026-02-04 (nothing since; the machine has written thousands of JSONLs in the
six months after). **No successor artefact replaced it**: the only other non-`.jsonl` file
found anywhere under `~/.claude/projects/` is `bridge-pointer.json` (3 dirs), which carries a
cloud-bridge session/environment id and nothing session-index-shaped. So this stays a
**delete**, not a repoint.

The card's "so on any current CLI the fast path is dead code" is _almost_ right. It is dead in
the sense that no CLI writes the file — but on a slug that still has a **non-empty** legacy
file the fast path still **fires and wins**, and it returns the frozen February session list
instead of scraping the JSONLs. Two such dirs exist on this machine and 100% of their 29
entries point at JSONLs that no longer exist. That is the argument for deleting rather than
keeping the read "just in case".

## 1. Goal

Delete the `sessions-index.json` read, its two shape interfaces, its mapper and its branch, so
the JSONL scrape is the single, visible session-discovery path. Ignore any legacy file left on
disk rather than honouring it.

## 2. Evidence — what is actually in `~/.claude/projects/<slug>/` today

Machine: `junielton`, CLI **2.1.222** (`claude --version`), 2026-08-05. 323 slug dirs.

```
$ find ~/.claude/projects -name 'sessions-index.json'          → 5 files
$ find ~/.claude/projects -maxdepth 2 -type f ! -name '*.jsonl' -printf '%f\n' | sort | uniq -c
      5 sessions-index.json
      3 bridge-pointer.json
```

Every one of the 5, with its mtime, entry count and how many of its entries still have a JSONL:

| slug                                  | mtime            | entries | entries whose `fullPath` exists | `originalPath` dir exists |
| ------------------------------------- | ---------------- | ------- | ------------------------------- | ------------------------- |
| `-home-junielton`                     | 2026-01-27 16:52 | 0       | —                               | yes                       |
| `-home-u-scripts`                     | 2026-01-29 09:01 | 0       | —                               | yes                       |
| `-home-u-scripts-whisper`             | 2026-01-29 10:28 | 0       | —                               | yes                       |
| `-home-u-Workspace-me-example-app`    | 2026-01-29 19:16 | 18      | **0 / 18**                      | **no**                    |
| `-home-u-Workspace-org-acme-acme-web` | 2026-02-04 10:37 | 11      | **0 / 11**                      | **no**                    |

A live project dir (`-home-u-Workspace-me-capy`, 354 entries, newest JSONL from
today) contains **only** `<uuid>.jsonl` files and `<uuid>/` subagent dirs — no index, no
successor. Same for `-home-junielton` (38 776 JSONLs, index frozen at January with `entries: []`).

Shape of the legacy file (verbatim, `-home-u-scripts`):

```json
{ "version": 1, "entries": [], "originalPath": "/home/u/scripts" }
```

**Successor: none.** `bridge-pointer.json` is `{"sessionId","environmentId","source"}` — the
cloud-bridge pointer, already ignored by the watcher (`claude-watcher.ts:649-651`).

**On the "≥ 2.1.152" claim.** The CC changelog Capy polls (`~/.claude/cache/changelog.md`,
5 314 lines) has **no** entry under 2.1.152 mentioning the session index; the only related line
is under **2.1.30** — _"Improved memory usage for `--resume` … by replacing the session index
with lightweight stat-based loading and progressive enrichment."_ So the exact version boundary
in the card, in `claude-reader.ts:362` and in `docs/lessons/synthetic-sessions/002` is
**unsourced prose**, inherited from the B-8 investigation. What _is_ verified is the outcome:
no `sessions-index.json` has been written on this machine since 2026-02-04, across 323 slugs and
six months of daily use. Fix the version claim to "the current CLI (verified 2.1.222) does not
write it" when the code comments are touched.

## 3. Current behaviour, verified

Two-tier read, `src/main/claude-reader.ts:1213-1220`:

```ts
const project =
  (await readProjectIndex(rootDir, slug)) ?? (await readProjectFromJsonls(rootDir, slug, gen))
```

`readProjectIndex` (`:287-358`) returns `null` — falling through to the scrape — when the file
is missing (`:292-295`), unparseable (`:298-301`), missing `originalPath`/`entries` (`:303-306`)
or has `entries.length === 0` (`:317-319`). It returns a `ProjectEntry` **only** for a file with
≥ 1 entry, and then the JSONLs in that slug are never opened.

**The two paths do NOT produce the same data.** The index path is strictly poorer
(`toSessionEntry`, `:244-280`) vs the scrape (`readProjectFromJsonls`, `:844-880`):

| Field                                                       | Index fast path                                               | JSONL scrape                                               |
| ----------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------- |
| `transcriptState` / `awaySummary` / `stagnation` / `ctxPct` | hardcoded `'unknown'` / `''` / zeros / `null` (`:270-274`)    | derived from the transcript (T91)                          |
| `teamName` / `agentName`                                    | `''` (`:277-278`)                                             | parsed (T99)                                               |
| `bridged`                                                   | `false` (`:266`)                                              | real, from the header                                      |
| `resumable`                                                 | inferred `messageCount > 0` (`:265`)                          | `turnCount > 0`, counted                                   |
| `summary`                                                   | index `summary`                                               | `customTitle \|\| aiTitle` (honours `/rename`)             |
| `whatsHappening`                                            | `firstPrompt` (`:273`)                                        | `pickWhatsHappening(taskSummary, lastPrompt, firstPrompt)` |
| SDK sessions (`entrypoint !== 'cli'`)                       | **not filtered** — the index has no `entrypoint` (`:321-328`) | filtered (`:842`)                                          |
| Sessions created after the index was written                | **invisible**                                                 | listed                                                     |
| Sessions whose JSONL was deleted                            | **listed as ghosts**                                          | absent                                                     |
| `modified` / `fileMtime`                                    | frozen at index-write time                                    | live `fs.stat`                                             |

`attachSubagents` runs after either path (`:1217`), so subagents are unaffected.

**Live blast radius today:** the two non-empty indexes yield 29 ghost sessions whose folders no
longer exist on disk. They stop short of the sidebar only because `existsSync` stamps
`diskExists: false` (`:1235-1238`) and `classifyFolder` forces such a folder to `'stale'`
(`folder-zones.ts:165`, BUG-56 D5). Had those folders still existed, the frozen list would be
what the user saw — the exact failure `docs/lessons/synthetic-sessions/002` was written about.

Other index touchpoints:

- `src/main/session-ops.ts:96-127` — on session delete, best-effort **rewrites** the index if it
  exists. Currently the only writer of the file on this machine.
- `src/main/claude-watcher.ts:156,165,180,212-215,647,674-685,782,840` — classifies the file,
  debounces, emits `claude:index:updated` → `onIndexUpdated` (`preload/index.ts:1427`) →
  `sessions.ts:4535`. Plus `readSeedProjects` (`:266-314`) parses the index; production passes
  `skipSeed: true` (`src/main/index.ts:718`), so that parse is already dead outside tests.

## 4. Decision

**Delete. Do not honour a stale legacy file.**

Rationale, in order of weight:

1. Honouring it is not neutral — it **wins** over the scrape and freezes the slug's session list
   at whatever the ≤ 2.0 CLI last wrote. It is a data-_loss_ branch, not a data-_preservation_ one.
2. The only information a legacy index holds that the JSONLs do not is a row for a JSONL that has
   been deleted. Such a row is unusable: `fullPath` doesn't exist, so `claude --resume` fails.
   Rendering it is a ghost, not a rescue. Measured: **29/29** entries on this machine are exactly
   that case.
3. A user who downgrades the CLI is still covered — an old CLI writes the JSONL _and_ the index;
   the scrape reads the JSONL.
4. The index path is poorer on 8 fields (§3) and cannot filter SDK sessions, so every slug it
   serves is a slug with degraded fleet state.

**In scope:** `claude-reader.ts` — `SessionsIndexFile` (`:212-217`), `SessionIndexEntry`
(`:219-232`), `tryParseJSON` (`:234-241`), `toSessionEntry` (`:243-280`), `readProjectIndex`
(`:282-358`), the `??` branch (`:1216`), and the doc comments at `:87`, `:362`, `:741`, `:793`,
`:907`, `:1177-1183`. All three helpers are private and have **no other caller** (verified by
grep across `src/` and `tests/`). Plus `session-ops.ts:96-127` — the writeback, now that nothing
reads what it writes.

**Out of scope, flagged:** the watcher's `index` classification, the `claude:index:updated` IPC
channel, `onIndexUpdated`, its renderer subscription and `readSeedProjects`' index parse. Once
the `session-ops` writeback goes, that event can no longer fire from any source — but removing
it touches preload API + renderer store + 5 test files, which is not a `complexity: trivial`
card. **Recommendation: raise a follow-up card** ("retire the `index:updated` watcher event")
rather than smuggling it in here. Keeping it for one more release is harmless: it is a
never-firing subscription, not a wrong-data path.

**Alternatives rejected:**

- _Keep the read, invert the precedence (scrape first, index only to fill gaps)._ Costs exactly
  the code the card exists to delete, and there are no gaps to fill (§4.2).
- _Keep the read behind the T200 CLI-version gate._ T200 itself lists this row as "pure dead-I/O
  removal"; gating dead I/O on a version probe is more machinery, not less.
- _Delete the legacy files from disk._ Out of scope — Capy does not own `~/.claude/projects/`,
  and ignoring a file is cheaper and safer than deleting a user's file.

**Open question (non-blocking):** the `2.1.152` version number is unsourced (§2). Either drop it
from the surviving comments or replace it with "verified against CC 2.1.222".

## 5. Acceptance

- `grep -rn "sessions-index" src/main/claude-reader.ts src/main/session-ops.ts` returns nothing.
- `scanFoldersUncached` calls `readProjectFromJsonls` unconditionally; no `??` two-tier read.
- A slug with JSONLs **and** a non-empty legacy `sessions-index.json` yields exactly the same
  `FolderEntry[]` as the same slug without the file — sessions come from the JSONLs, and
  transcript-truth fields are populated on both.
- A slug with a legacy index and **zero** JSONLs yields no folder (today: 29 ghost rows).
- No crash, no warning, no read attempt on the legacy file.
- One fewer failed `readFile` per slug per full scan (323 on this machine).
- `npm run typecheck` and `npm run test:coverage` pass (`/local-ci`).

## 6. Test plan

| Test                                                                                           | File                                                                             | Asserts                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Replace** `splits a worktree slug with sessions-index.json (fast path) into per-cwd folders` | `tests/claude-reader.test.ts:558-616`                                            | Rewrite the two index fixtures as JSONL fixtures; keep the assertion (root + worktree split into 2 per-cwd folders). The per-cwd split is real coverage; only the fixture format was index-shaped. |
| **New** `a legacy sessions-index.json is ignored — sessions come from the JSONLs`              | `tests/claude-reader.test.ts`                                                    | Temp slug with 2 `<uuid>.jsonl` **and** an index listing only 1 stale session. Expect both JSONL sessions, and the index-only id absent.                                                           |
| **New** `a slug with only a legacy sessions-index.json and no JSONL yields no folder`          | `tests/claude-reader.test.ts`                                                    | Temp slug with the 18-entry example-app-shaped index and zero JSONLs → `scanFolders` returns `[]`.                                                                                                 |
| **New** `a corrupt sessions-index.json does not break the scan`                                | `tests/claude-reader.test.ts`                                                    | Slug with `sessions-index.json` = `"{{{"` plus one valid JSONL → the JSONL session is returned, no throw.                                                                                          |
| **Unchanged, must stay green**                                                                 | `tests/claude-reader-truth.test.ts`                                              | Already asserts the scrape path (`no sessions-index.json`); after the change it is the only path. Update its header comment.                                                                       |
| **Unchanged**                                                                                  | `tests/claude-reader-cache.test.ts`, `tests/claude-reader-derive.test.ts`        | Header-cache generation/prune behaviour — no index involvement.                                                                                                                                    |
| **Comment-only edits**                                                                         | `tests/fleet-model-core.test.ts:188-190`, `tests/sessions-store.test.ts:862-866` | Both only _mention_ the index in prose; the `fullPath: ''` hole they cover is still reachable, so keep the tests and reword the comments.                                                          |
| **Session delete**                                                                             | `tests/session-ops*.test.ts` (if the writeback is covered)                       | Deleting a session unlinks the JSONL and returns `ok: true`; no index write.                                                                                                                       |

No test exists solely to cover the index path, so nothing is deleted outright — one is rewritten.

## 7. Contracts touched

| Contract                | Applies?       | Reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CHANGELOG.md`          | **No**         | Pure internal refactor. The output of `scanFolders` is byte-identical for every slug on any current CLI (no index → the fast path already returns `null`). The only behaviour difference is on a slug with a non-empty legacy index, where the fix removes ghost rows — and on this machine those rows are already suppressed as `'stale'` by BUG-56 D5, so nothing a user sees changes. The perf gain (one avoided `readFile` per slug) is real but not perceptible. **If a reviewer disagrees on the ghost-row point, add a one-line `### Fixed`** — that's the only branch where a user could notice. |
| `docs/capy-features.md` | **No**         | No MCP verb, no ACK shape, no grant/confirm semantics, no UI affordance the agent should offer. The doc never mentioned the index.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `docs/user/`            | **No**         | No new component, no new top-level `src/main/` file, no `tool-catalog.ts` change. The CI gate (`user-docs-gate.mjs`) only fires on those three; this diff touches neither.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `design.md`             | **No**         | No renderer file changes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| i18n parity             | **No**         | No new strings.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| English-only            | **Yes**        | Spec, comments and test names in English.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `docs/lessons/`         | **Yes (edit)** | `synthetic-sessions/002-missing-sessions-index.md` documents the two-tier fix being removed. Add a dated "Superseded by T204" note — the _lesson_ (never assume a Claude-side disk artefact exists) survives; the code sample no longer matches `main`.                                                                                                                                                                                                                                                                                                                                                  |

## 8. Definition of done

- [ ] `readProjectIndex`, `toSessionEntry`, `tryParseJSON`, `SessionsIndexFile`, `SessionIndexEntry` deleted from `claude-reader.ts`.
- [ ] `scanFoldersUncached:1216` calls `readProjectFromJsonls` directly; the `??` is gone.
- [ ] Doc comments at `claude-reader.ts:87,362,741,793,907,1177-1183` reworded — no "fast path", no unsourced `2.1.152`.
- [ ] `session-ops.ts:96-127` index writeback removed; the delete handler ends after the `unlink`.
- [ ] `tests/claude-reader.test.ts:558` rewritten onto JSONL fixtures; 3 new tests added (§6).
- [ ] Comment-only edits in `tests/fleet-model-core.test.ts` and `tests/sessions-store.test.ts`.
- [ ] `docs/lessons/synthetic-sessions/002-missing-sessions-index.md` marked superseded.
- [ ] Follow-up card raised: retire the `claude:index:updated` watcher event + `readSeedProjects` index parse.
- [ ] No `CHANGELOG.md` entry (justified in §7); PR carries `no-awareness` + `no-user-docs`.
- [ ] `/local-ci` green (format, typecheck, lint, coverage).
