# Sidebar-liveness bench (2026-10-02)

The scripts behind §1 of
[`docs/specs/2026-10-02-sidebar-liveness.md`](../../../docs/specs/2026-10-02-sidebar-liveness.md)
and the before/after evidence for its AC-30 (plus the non-gating numbers for AC-1, -2,
-7, -18, -19, -23). The raw results under `results/` are the baseline taken at
`e06b84a7`; `results/before-*` is the re-run on the `feat/sidebar-liveness` head (the
AC-30 BEFORE baseline).

**Build-independent.** `measure.mjs` and `rescan.mjs` set conditional breakpoints
("logpoints") in the built `out/main/index.js`. `locate.mjs` finds each logpoint line by
pattern, so any rebuild works. A pattern that stops matching **throws** — update the
pattern, never guess a line (U3a moved the `claude:session:updated` and
`claude:subagent:updated` sends into the watcher's coalescer; `sessUpd` now points at its
flush and counts both channels by `ev.channel`). Run from the repo root so
`out/main/index.js` resolves, or pass another path to `loadBundle()`.

**Process labels.** Per-process CPU is labelled with Electron's own process type from
`app.getAppMetrics()` — `Browser` (main), `Tab` (renderer), `GPU`, `Utility`. The
baseline's `/proc/<pid>/cmdline` guess labelled the GPU process `zygote` (spec §1.1);
the raw `results/syn-*.json` and `run-*.json` files still carry that old label.

## Files

| File          | What it does                                                                                                                                                                     |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `locate.mjs`  | `locateLine` / `locateLogpoints` — pattern-located logpoint lines for the built main bundle.                                                                                     |
| `procs.mjs`   | `app.getAppMetrics()` process types + `/proc` CPU ticks; shared ports (`PAGE_PORT`/`NODE_PORT`, default 9347/9348).                                                              |
| `cdp.mjs`     | Minimal CDP client (Node 22 built-in `WebSocket`) + `.cpuprofile` summarizer (self time, inclusive time for named functions).                                                    |
| `measure.mjs` | `cpu \| instr \| profile <seconds>` — per-process CPU from `/proc`, renderer event counters, main-process logpoint counters (`instr`), main + renderer CPU profiles (`profile`). |
| `gpu.mjs`     | GPU-on run (no page CDP): measures CPU with animations on, injects `animation:none` through the main inspector (`webContents.insertCSS`), measures again, restores.              |
| `fixture.mjs` | `build <HOME> <WORKDIR>` — synthetic fleet (31 slugs, 1,000 JSONLs, one heavy slug with 300 transcripts + 400 subagents). `load <HOME> <WORKDIR> <s>` — 8 appends/s.             |
| `ttr.mjs`     | Time-to-row: writes a `claude`-shaped JSONL (`existing-slug`, `new-slug`) or runs `git worktree add` (`worktree`) and polls the sessions store.                                  |
| `probe.mjs`   | Evaluates one expression in the page (store inspection).                                                                                                                         |
| `rescan.mjs`  | Times `sessions.rescan()` and counts full scans.                                                                                                                                 |

## Running it (isolated — never against the operator's instance)

Run everything from the repo root. Pick ports nobody else holds (`ss -lptn`); the scripts
read `PAGE_PORT` (default 9347) and `NODE_PORT` (default 9348). Tear down only the PIDs
you started.

Guard rails: `measure`, `rescan` and `gpu` refuse to attach (`assertIsolated` in `procs.mjs`) when the
instance's main process runs with the account's real `HOME`; `ttr` requires `FH`.

```bash
export PATH="$HOME/.local/share/mise/installs/node/22/bin:$PATH"
B=scripts/dev/liveness-bench
FH=<scratch>/fh WD=<scratch>/wd UD=<scratch>/ud      # fake HOME, workdir, userData
export PAGE_PORT=9347 NODE_PORT=9348 FH OUTDIR=<scratch>/results
mkdir -p "$FH" "$WD/heavy" "$UD" "$OUTDIR"
(cd "$WD/heavy" && git init -q && git commit -q --allow-empty -m init)  # the `worktree` scenario's repo

npx electron-vite build
python3 -m http.server 5187 --bind 127.0.0.1 -d out/renderer &
node $B/fixture.mjs build "$FH" "$WD"
HOME="$FH" ELECTRON_RENDERER_URL=http://127.0.0.1:5187 \
  node_modules/.bin/electron out/main/index.js --inspect=$NODE_PORT \
  --user-data-dir="$UD" --remote-debugging-port=$PAGE_PORT --no-sandbox \
  --disable-background-timer-throttling --disable-renderer-backgrounding \
  --disable-backgrounding-occluded-windows &
```

`--remote-debugging-port` forces dev mode, which disables GPU acceleration
(`src/main/index.ts:28-39`). **For GPU-on numbers (`gpu.mjs`, AC-23) launch a second
instance WITHOUT `--remote-debugging-port`** (keep `--inspect`) — with it, the pulse-dot
cost shows up as renderer software raster instead of GPU-process work.

### AC-30 checklist (before/after evidence)

Run on the same machine, the same synthetic fixture, once on the `feat/sidebar-liveness`
head (BEFORE) and once on the finished integration branch (AFTER). Record p50/p95 and CPU
and compare against spec §1.2.

| Step | Command                                                                          | Reports                                                                                     |
| ---- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 1    | `node $B/measure.mjs cpu 20`                                                     | idle CPU per `getAppMetrics` type                                                           |
| 2    | `for i in 1..10: node $B/ttr.mjs existing-slug "$WD/heavy" 20`                   | `msToStore` / `msToSidebar` (null = no row within 20 s); p50/p95                            |
| 3    | `for i in 1..10: mkdir "$WD/new$i"; node $B/ttr.mjs new-slug "$WD/new$i" 20`     | same, new folder                                                                            |
| 4    | `for i in 1..5: node $B/ttr.mjs worktree "$WD/heavy" "$WD/wt$i" 20`              | `msToStore` for a bare `git worktree add`                                                   |
| 5    | `node $B/fixture.mjs load "$FH" "$WD" 110 &` then `node $B/measure.mjs instr 60` | passes/s, ms per pass, subagent header reads, `session:updated` events/s + bytes/event, CPU |
| 6    | `node $B/rescan.mjs`                                                             | `rescan()` resolve time, full scans per Rescan                                              |
| 7    | GPU-on instance, load running: `node $B/gpu.mjs 30`                              | main / renderer / GPU CPU, animations on / off / on                                         |

`measure.mjs profile 60` additionally writes main + renderer `.cpuprofile` files to
`$OUTDIR` and prints their summaries.

## Results

| File                             | Dataset   | Notes                                                                                                                                                    |
| -------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `results/BEFORE.md` + `before-*` | synthetic | AC-30 BEFORE baseline on the `feat/sidebar-liveness` head (this harness)                                                                                 |
| `results/after-u3b-instr.json`   | synthetic | `instr` on the U3b branch (U0+U1+U2+U3a+U3b, `d450ef84`), 8 appends/s, 60 s — AC-17 non-gating evidence: 0.5 slug passes/s vs 2.0 in `before-instr.json` |
| `results/syn-idle.json`          | synthetic | no load, animations off                                                                                                                                  |
| `results/syn-instr.json`         | synthetic | 8 appends/s, animations off, logpoint counters                                                                                                           |
| `results/syn-prof.json`          | synthetic | 8 appends/s, CPU profile summaries                                                                                                                       |
| `results/syn-gpu.txt`            | synthetic | GPU on, 8 appends/s, animations on / off / on                                                                                                            |
| `results/run-cpu-2.json`         | real      | light load, animations on (GPU off)                                                                                                                      |
| `results/run-cpu-noanim.json`    | real      | same, animations off                                                                                                                                     |
| `results/run-instr-1.json`       | real      | light load, counters                                                                                                                                     |
| `results/run-instr-noanim.json`  | real      | subagent-heavy load, counters (27.7 MB `session:updated`)                                                                                                |
| `results/run-prof-*.json`        | real      | CPU profile summaries                                                                                                                                    |

Real-dataset results contain no paths or slug names — only counts, timings and
bundle-relative function names.
