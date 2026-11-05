# Autonomous Cleanup — risk review (2026-10-27)

Three read-only agents (git/worktrees, Docker/runtime, agent/concurrency) measured this machine and read
the Cleanup code. Bottom line: **autonomy is viable, but "recoverable" is false in specific, fixable
places.** Each fix below turns a claim into a fact.

## Measured on this machine

| Measure                                                                              | Value                                                 |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| Repos / worktrees                                                                    | 53 / 247 (197 linked)                                 |
| Linked worktrees with gitignored-but-valuable files (`.env*`, `*.sql`, `.harnu/out`) | **113** (246 MiB)                                     |
| …of those that are clean + pushed (would pass deterministic proof)                   | **42**                                                |
| Linked `.env*` that differ from the main checkout's copy                             | 91 / 172                                              |
| Linked worktrees with commits on no remote                                           | **126 / 197**                                         |
| Repos with no remote at all                                                          | 16                                                    |
| Detached linked worktrees / with commits on no remote                                | 60 / 47 (Harnu 22/22)                                 |
| Stash entries / pointing at deleted branches                                         | 40 / 19                                               |
| OS trash (Harnu entries)                                                             | 4.8 GB, 83 entries                                    |
| Compose stacks / running orphans                                                     | 33 / **6** (draft said 3)                             |
| Anonymous volumes                                                                    | **0 / 71** (all DBs on named volumes)                 |
| Containers with no volume (mailpit)                                                  | 13                                                    |
| Orphan named volumes from dead project names                                         | 19                                                    |
| Cross-repo host-port collisions                                                      | 2 (`:8020`, `:8011`)                                  |
| Stopped stacks whose network is already gone                                         | 9 / 9 (`docker start` fails; only `compose up` works) |

## Risks, ranked

### Lost forever

1. **Gitignored files survive only in the OS trash.** The wip archive excludes ignored files
   (`archive-shell.ts:153-157`). Once the trash is emptied — by Cleanup's own "Empty trash"
   (`trash-shell.ts:466`) or the desktop's trash limit — `.env`, dumps and `.harnu/out` are gone.
   _Fix:_ snapshot ignored files outside dep dirs (size-capped tarball under `refs/archive` or app
   data) before trashing; emptying the trash is never autonomous.
2. **Publishing private/client code.** My earlier idea — the agent pushes stranded commits to a
   backup ref or opens a draft PR — sends WIP (and possibly secrets) to a remote; this repo is public
   and ADR-0017 shows a public push is permanent. _Fix:_ agents never push or open PRs.
3. **Archives are local and time-limited.** `refs/archive/**` lives on one disk; `archiveAutoExpire`
   - `git gc` prune it (`gc-cycle.ts:233-241`). _Fix:_ no autonomous `git gc`; no auto-expire of
     agent-action archives; "expires on" in the digest.
4. **Prompt injection turns an opinion into a deletion.** The only check on a "safe" verdict is a
   non-empty evidence string (`opinion-core.ts:476`). A commit message can forge it. _Fix:_ the LLM
   proposes, git proves — only proof-verified verdicts execute.
5. **Wrong "content landed" verdict.** T189 field data: 14 of 27 blocked worktrees held real
   un-landed work. The advisor sees a 3000-char diffstat, no git (`opinion-core.ts:75-77, 527-537`).
   _Fix:_ same as 4; partial → dehydrate, never remove.
6. **Orphaned stashes / detached commits.** Stashes are repo-wide and never archived.
   _Fix:_ copy stash commits naming the branch into `refs/archive/<branch>/stash-N`; detached stays
   out of deterministic autonomy.

### Breaks work / stalls an unattended run

7. **Parked session resumes into a missing folder.** The parked registry is in memory only
   (`hibernation.ts:20`); after a restart a parked session reads idle. 48 linked worktrees have
   transcripts touched in the last 7 days. _Fix:_ persist the parked registry; transcript-age floor
   (e.g. 14 days) as a hard gate for removal.
8. **A parked stack's port is taken.** Allocators only avoid their own repo's ports.
   _Fix:_ record ports at park; treat "port is allocated" as a capacity blocker.
9. **Harnu's own restore path is wrong after `down`.** The journal hint is `docker start <ids>`
   (`containers-journal.ts:100`). _Fix:_ park hint = `docker compose -p P --project-directory WD up -d`.
10. **Idle session ≠ unused stack.** Manual QA in a browser, host Vite, background tests.
    _Fix:_ idle = max(session, container CPU/IO, Harnu browser panes, listeners on its ports).
11. **Mass parking / thrash.** The draft's D1 premise was wrong: `active` comes from bucket
    `in-use` (open PR, grace, keep), not from "process alive" — reordering makes most live work
    parkable. _Fix:_ hysteresis, min age since last `up`, cap parks per hour.
12. **Stale data on reuse.** Allocators reuse the lowest free number; kept volumes are named after
    the project, so a new `ext-NN` boots on the old branch's Redis/MySQL. _Fix:_ journal kept volumes;
    warn when a live project mounts a volume older than its worktree.
13. **Keep marks evaporate on fate change** (`gc-keep.ts:19-32`). _Fix:_ stale keep → review, never
    auto-eligible.
14. **Deps fail to regenerate** (private registry auth, offline). _Fix:_ dry-run resolve before
    dehydrate; auto-rehydrate when a session opens.

### Cost and trust

15. **Token burn and data egress.** `unsure` verdicts are re-asked every hour (`opinion-core.ts:900`);
    every call sends repo content to Anthropic. _Fix:_ cache by facts hash, daily token cap, client
    repos opt-in.
16. **Recovery only on paper.** `refs/archive` is invisible in `git branch`; restoring 30 worktrees is
    30 installs. _Fix:_ in-app digest with one-click restore per line; tombstone rows.
17. **Races.** Verdict → action takes minutes. _Fix:_ bind verdicts to a facts hash, re-probe before
    acting; per-repo lock (two Harnu instances via `--user-data-dir`).

## Guardrails that make autonomy acceptable

1. No outward actions by agents: no push, PR or remote delete.
2. The LLM proposes, git proves. Unproven → dehydrate/park, never remove.
3. Read-only agent roster (`--tools Read,Grep,Glob`); never Scheduler `act`.
4. Snapshot gitignored files before any removal; emptying the trash and `git gc` are never autonomous.
5. Facts-hash binding + re-probe; persisted parked registry; per-repo lock.
6. Caps, cooldowns, negative caching, failure-streak kill switch, global pause.
7. Rollout: report-only week → dehydrate/park only → removal after the operator reviews the hit rate.
8. In-app morning digest with one-click restore per line.

## Already well guarded (keep)

Dirty/unpushed re-probe at execution (`executor-core.ts:200-221`); wip archive via `commit-tree`
(`archive-shell.ts`); trash-or-nothing, `branch -d` unless proven (`executor-core.ts:332-379`);
lease-guarded remote deletes; dehydrate's four guards; `docker rm` never forced, never `-v`;
`unknown` stacks always refused; only ENOENT proves a worktree gone; fingerprint-verified trash purge.
