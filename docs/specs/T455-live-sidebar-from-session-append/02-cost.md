# T455 — Measured cost of today's live-session path (§8 of the spec, U-5)

Measured on the operator's machine, against the Harnu instance that was running, **read-only**:
nothing was attached to, signalled or restarted. 2026-10-09: runs 1–4 at 16:27–16:40, run 5 at
17:12–17:17 local time (UTC−3).

**Revised after verification round 1.** Round 1 read the cold opens of run 4 as caused by appends.
That was wrong:

- The 9,387-file project dir is the **home directory's** (sessions started in `~`), not Harnu's main
  checkout, whose project dir holds 21 transcripts.
- A verifier saw two windows in which Harnu opened all 9,375 transcripts of that dir with **zero**
  appends in it, and one 10,818-file whole-corpus sweep.

The cold opens are a sweep with its own trigger, outside the live-session path. They are now
reported as such (§8.4) and claimed as no part of T455's gain. Round 1's single latency figure
did not reproduce either (the verifier got p90 12 ms and 100 ms). Run 5 replaces both with a
per-reader attribution.

## 8.1 The machine and the load

| Fact                                         | Value                                                                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Harnu build                                  | the installed AppImage (main pid uptime ~1.9 h at the start)                                                                    |
| Live `claude` children of Harnu main         | 28 (orchestrator, executors and dispatched sessions of this mission)                                                            |
| Transcript corpus under `~/.claude/projects` | 10,797–10,858 top-level `*.jsonl` in 449–471 project dirs; one dir (the home directory's, sessions started in `~`) holds ~9,380 |
| chokidar inotify watches held by Harnu main  | 13,902 on one inotify fd (`grep -c '^inotify wd' /proc/<pid>/fdinfo/<fd>`)                                                      |
| Lifetime averages (`ps`, before sampling)    | main 8.8 % CPU, renderer 19.9 % CPU; main `rchar` 184,756,173,338 bytes over 6,869 s (~25.6 MiB/s)                              |
| Kernel                                       | Linux 7.0, `kernel.yama.ptrace_scope = 1` (no `strace`/`perf` attach to a non-child; no root for `bpftrace`)                    |

`ptrace_scope = 1` rules out per-syscall attribution. Attribution is therefore done with inotify
(which file was opened, and when), timing against the code's known cadences, and a
`/proc/<pid>/fd` sampler (who held the file open).

## 8.2 Method

Four read-only probes, all in Python with no third-party module (scripts in §8.6):

1. **`sample.py <main> <renderer> 60`** — one 60 s window.
   - Deltas of `utime + stime` for Harnu main and the renderer (`/proc/<pid>/stat`).
   - Deltas of main's `rchar` and `syscr` (`/proc/<pid>/io`).
   - Voluntary + involuntary context switches summed over main's threads (a wake-up proxy).
   - Its **own** inotify watch (`IN_MODIFY | IN_OPEN | IN_ACCESS`, non-recursive) on every project
     dir, counting per top-level `*.jsonl`: appends (`IN_MODIFY`, written by `claude`) and opens
     and reads by any reader.
2. **`slugs.py 60`** — the same watch, grouped by project dir: distinct cold files opened (opened,
   never appended) in dirs that had an append versus dirs that did not.
3. **`fdattr.py 120`** — every 10 ms, which of the user's processes holds a
   `~/.claude/projects/**/*.jsonl` open (`readlink /proc/<pid>/fd/*`).
4. **`attr.py 60`** (run 5) — **per-reader attribution.** Every open of a transcript `claude`
   appended to during the window is put in one class, checked in this order:
   - **sweep**: ≥ 50 other transcripts were opened within ±1 s of it;
   - **tail**: ≤ 50 ms after an append to that same file. This is the watcher's offset read: its
     `change` handler reads at once (`claude-watcher.ts:1181-1264`, `:418-432`).
   - **pass**: everything else, i.e. the fleet model's slug pass (≤ 1 per 2,000 ms per slug,
     `fleet-model.ts:66`, `:173-192`) or another non-immediate reader.

   For pass-class opens it also reports the gap to the previous pass-class open of the same file,
   so the 2 s cadence is seen rather than assumed.

Caveats, stated once:

- Inotify events carry no pid. Opens are attributed to Harnu main by `fdattr.py`: over 2,376
  samples in 120 s, the only process ever seen holding a transcript open was Harnu main.
- They are also attributed through main's own `syscr` and `rchar`, and by assuming a `claude`
  process does not read its own transcript after boot (assumption **A-M1**).
- `rchar` also counts PTY and socket reads.
- The class boundaries of `attr.py` are timing rules, not stack traces. A slug pass that happens to
  land within 50 ms of an append counts as tail, and a renderer reload's `foldersLoad` counts as
  pass. The gap distribution (§8.4) is the check that the pass class is mostly the slug pass.
- The executor's own probe sessions (03-prototype.md) ran during run 3 and created four small
  transcripts in a scratch dir.

## 8.3 Raw results

Run 1 (3 × 60 s; its byte-growth field was buggy and is omitted):

| Window | main CPU | renderer CPU | main read MiB/s | main read syscalls/s | main ctx switches/s | files appended | appends | opens  | reads   | cold files opened |
| ------ | -------- | ------------ | --------------- | -------------------- | ------------------- | -------------- | ------- | ------ | ------- | ----------------- |
| 1      | 8.66 %   | 32.54 %      | 45.3            | 2,278                | 2,034               | 13             | 118     | 82,353 | 312,282 | 10,778            |
| 2      | 10.25 %  | 43.04 %      | 67.4            | 2,813                | 2,469               | 13             | 127     | 31,583 | 167,862 | 10,781            |
| 3      | 12.95 %  | 30.84 %      | 46.6            | 3,120                | 3,422               | 15             | 172     | 6,876  | 38,289  | 3,191             |

Run 2 (2 × 60 s) and run 3 (3 × 60 s). The last column is round 1's mixed "append → next open of
any kind" figure, kept for the record and withdrawn as a cost (§8.4):

| Window | main CPU | renderer CPU | main read MiB/s | read syscalls/s | ctx switches/s | appended files / appends | bytes appended | opens  | reads   | distinct opened / corpus | live-file opens / reads | append → next open p50 / p90 / max (ms) |
| ------ | -------- | ------------ | --------------- | --------------- | -------------- | ------------------------ | -------------- | ------ | ------- | ------------------------ | ----------------------- | --------------------------------------- |
| 2.1    | 9.22 %   | 23.71 %      | 0.7             | 1,209           | 1,977          | 11 / 142                 | 1,429,081      | 9,997  | 10,720  | 9,576 / 10,797           | —                       | —                                       |
| 2.2    | 12.90 %  | 31.55 %      | 64.3            | 6,092           | 2,365          | 14 / 155                 | 1,122,628      | 17,605 | 396,385 | 10,798 / 10,795          | —                       | —                                       |
| 3.1    | 14.72 %  | 24.62 %      | 96.3            | 5,224           | 3,433          | 17 / 130                 | 1,833,329      | 24,740 | 609,765 | 10,806 / 10,801          | 399 / 7,795             | 0 / 1,484 / 3,504                       |
| 3.2    | 17.62 %  | 29.87 %      | 28.7            | 4,636           | 3,393          | 20 / 176                 | 890,636        | 3,777  | 18,590  | 3,238 / 10,809           | 484 / 983               | 1 / 250 / 6,402 (2 never reopened)      |
| 3.3    | 16.68 %  | 26.96 %      | 23.6            | 2,522           | 3,887          | 14 / 162                 | 2,553,541      | 3,694  | 18,313  | 3,242 / 10,815           | 455 / 855               | 1 / 215 / 3,711                         |

Run 4 (`slugs.py`, 3 × 60 s), where the cold opens happened. The home directory's dir did get
appends in 4.1 and 4.3, but the verifier's windows show the same sweep of that dir with none, so
the correlation below is coincidence, not cause:

| Window | dirs with an append | cold files opened in those dirs | of which in the home directory's dir | dirs with no append but opened | cold files opened there |
| ------ | ------------------- | ------------------------------- | ------------------------------------ | ------------------------------ | ----------------------- |
| 4.1    | 14                  | 2,806                           | 2,792                                | 169                            | 414                     |
| 4.2    | 11                  | 0                               | —                                    | 0                              | 0                       |
| 4.3    | 12                  | 2,801                           | 2,790                                | 173                            | 418                     |

Run 5 (`attr.py`, 5 × 60 s, 17:12–17:17), per reader:

| Window | live files | appends | tail opens (/append) | pass opens (/append) | sweep opens (/append) | tail: open after append p50 / p90 / max (ms) | pass: open after last append p50 / p90 (ms) | pass: gap to the previous pass open of the same file p50 / p90 (ms) | all transcript opens in window |
| ------ | ---------- | ------- | -------------------- | -------------------- | --------------------- | -------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------- | ------------------------------ |
| 5.1    | 15         | 146     | 227 (1.55)           | 168 (1.15)           | 0                     | 0 / 2 / 41                                   | 356 / 5,557                                 | 2,091 / 7,811                                                       | 402                            |
| 5.2    | 11         | 130     | 202 (1.55)           | 171 (1.32)           | 0                     | 0 / 2 / 47                                   | 565 / 5,241                                 | 2,000 / 9,110                                                       | 375                            |
| 5.3    | 10         | 81      | 121 (1.49)           | 106 (1.31)           | 0                     | 0 / 2 / 17                                   | 294 / 4,721                                 | 1,721 / 6,973                                                       | 229                            |
| 5.4    | 12         | 82      | 59 (0.72)            | 64 (0.78)            | 121 (1.48)            | 0 / 2 / 7                                    | 308 / 8,167                                 | 952 / 7,965                                                         | 20,962                         |
| 5.5    | 9          | 104     | 104 (1.00)           | 87 (0.84)            | 122 (1.17)            | 0 / 2 / 29                                   | 258 / 5,950                                 | 2,124 / 18,907                                                      | 11,524                         |
| total  | —          | 543     | 713                  | 596                  | 243                   | —                                            | —                                           | —                                                                   | —                              |

## 8.4 What the numbers say

1. **Two readers reopen every live transcript.**
   - **The tail.** The watcher's tail opens it within 2 ms of the write (p90 2 ms in all five
     windows): 0.72–1.55 opens per append. More than one per append means `claude` writes a row in
     more than one `write`, and the tail reads after each.
   - **The pass class.** It opens the file 0.78–1.32 times per append. Its median gap between
     opens of the same file is 2,000–2,124 ms in the three windows without a sweep: the slug-pass
     cadence of `fleet-model.ts:66`. The 952 ms of window 5.4 sits beside a sweep, which hides part
     of the pass and shortens the visible gaps.
   - **The split.** In the sweep-free windows the pass class is **45 %** of the live-transcript
     opens (445 of 995). That class is what T455 removes for an owned session. The tail stays
     (§7.2 of the spec).
2. **The model lags the transcript.** The first pass-class open after a live session's last append
   comes at p50 258–565 ms and p90 4.7–8.2 s. That is how stale `get_fleet`'s and the folder
   model's view of a running session is, today, before the next reload. The push carries the same
   facts within ≤ 500 ms (≤ 2 s worst).
3. **Sweeps are a separate bug.**
   - In 5 of 8 windows of runs 1–3 and 2 of 5 of run 5, Harnu main opened the whole corpus
     (9,576–10,806 distinct transcripts) or the whole home-directory dir: up to 609,765 reads and
     96 MiB/s in a minute.
   - The verifiers saw the same with no append in the swept dir. Nothing here ties the sweeps to
     the live-session path.
   - The orchestrator cards them separately. A-M2 of round 1 is withdrawn from T455.
4. **Round 1's single latency figure is withdrawn.** "Append → next open of any kind" (p90
   215–1,484 ms in run 3; 12 ms and 100 ms in the verifier's runs) mixes the tail and the pass, so
   it moves with their share. Items 1 and 2 replace it.
5. **Context only.** Main sat at 7.2–17.6 % CPU and 1,282–3,887 context switches/s (the
   verifier's windows included), and the renderer at 22.4–43.0 %. BUG-146 measured main ~13 % and
   the renderer ~29 % on a smaller corpus. These totals include everything Harnu does (28 PTYs
   streaming into xterm, the MCP server, the companion host, the sweeps). They are not the
   live-session path alone and are not claimed as T455's gain.

## 8.5 The gain, as numbers to beat

What T455 removes for a session whose `row` family is owned (§7 of the spec), and what the W6
performance gate re-measures with `attr.py`:

| Cost today (measured, run 5)                                                                  | After T455, for an owned session                                     |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| pass-class reopens: 0.78–1.32 per append, 45 % of live-transcript opens in sweep-free windows | **0**                                                                |
| tail-class reopens: 0.72–1.55 per append, p90 2 ms                                            | unchanged (± 20 %): the tail is every other family's legacy input    |
| model view of a live session: p50 258–565 ms, p90 4.7–8.2 s after its last append             | `modified` / `status` / prompts from the push: ≤ 500 ms, ≤ 2 s worst |
| one post-migration full `foldersLoad` per new session (`stores/sessions.ts:4967-4989`)        | none for a claimed row (§6 of the spec)                              |
| sweeps                                                                                        | no claim: a separate bug                                             |

The cost T455 adds inside each session was measured by the engine's own debug log on Claude Code
2.1.296 for the prototype (03-prototype.md §P.3):

- the `session.append` hook settles in **0.3–1.8 ms** per row (26 rows; one outlier at 9.5 ms);
- `session.start` 20.8 ms, `turn.complete` 3.8 ms;
- **4 HTTP POSTs for a two-tool-call turn of 26 rows**.

## 8.6 Scripts

`sample.py` (the final version used for run 3; runs 1 and 2 used earlier cuts without the
latency and amplification fields):

```python
#!/usr/bin/env python3
"""Read-only cost sampler for T455 U-5.

Samples, over WINDOW seconds, without touching the observed processes:
  - CPU ticks (utime+stime, all threads) of Harnu main + renderer, from /proc/<pid>/stat
  - read() volume of Harnu main (/proc/<pid>/io rchar, syscr)
  - context switches (wake-up proxy) summed over Harnu main's threads
  - inotify events on every ~/.claude/projects/<slug>/ dir, per *.jsonl file:
      IN_MODIFY (an append by claude), IN_OPEN and IN_ACCESS (a reader opened / read the file)
  - growth in bytes of every *.jsonl touched during the window

Usage: sample.py <main_pid> <renderer_pid> <window_s>
"""
import ctypes, ctypes.util, os, struct, sys, time, glob, json, select

MAIN, REND, WINDOW = int(sys.argv[1]), int(sys.argv[2]), float(sys.argv[3])
HZ = os.sysconf('SC_CLK_TCK')
PROJ = os.path.expanduser('~/.claude/projects')

def ticks(pid):
    with open(f'/proc/{pid}/stat') as f:
        parts = f.read().rsplit(')', 1)[1].split()
    return int(parts[11]) + int(parts[12])  # utime, stime (fields 14, 15)

def io(pid):
    d = {}
    with open(f'/proc/{pid}/io') as f:
        for line in f:
            k, v = line.split(':')
            d[k] = int(v)
    return d

def ctxt(pid):
    tot = 0
    for t in glob.glob(f'/proc/{pid}/task/*/status'):
        try:
            with open(t) as f:
                for line in f:
                    if line.startswith(('voluntary_ctxt_switches', 'nonvoluntary_ctxt_switches')):
                        tot += int(line.split()[1])
        except FileNotFoundError:
            pass
    return tot

libc = ctypes.CDLL(ctypes.util.find_library('c'), use_errno=True)
IN_ACCESS, IN_MODIFY, IN_OPEN = 0x1, 0x2, 0x20
fd = libc.inotify_init1(os.O_NONBLOCK)
wds = {}
for d in glob.glob(PROJ + '/*/'):
    wd = libc.inotify_add_watch(fd, d.encode(), IN_ACCESS | IN_MODIFY | IN_OPEN)
    if wd >= 0:
        wds[wd] = d

counts = {}  # path -> {modify, open, access}
times = {}  # path -> [(t, kind)]
def drain():
    while True:
        try:
            buf = os.read(fd, 1 << 16)
        except BlockingIOError:
            return
        i = 0
        while i < len(buf):
            wd, mask, cookie, ln = struct.unpack_from('iIII', buf, i)
            name = buf[i + 16:i + 16 + ln].rstrip(b'\0').decode(errors='replace')
            i += 16 + ln
            if not name.endswith('.jsonl'):
                continue
            p = wds.get(wd, '?') + name
            c = counts.setdefault(p, {'modify': 0, 'open': 0, 'access': 0})
            now = time.monotonic()
            if mask & IN_MODIFY: times.setdefault(p, []).append((now, 'm'))
            if mask & IN_OPEN: times.setdefault(p, []).append((now, 'o'))
            if mask & IN_MODIFY: c['modify'] += 1
            if mask & IN_OPEN: c['open'] += 1
            if mask & IN_ACCESS: c['access'] += 1

def size(p):
    try:
        return os.stat(p).st_size
    except FileNotFoundError:
        return 0

live_before = {p: size(p) for p in glob.glob(PROJ + '/*/*.jsonl')}
t0 = time.time(); m0, r0 = ticks(MAIN), ticks(REND); io0 = io(MAIN); c0 = ctxt(MAIN)
end = t0 + WINDOW
while time.time() < end:
    select.select([fd], [], [], 0.5)
    drain()
t1 = time.time(); m1, r1 = ticks(MAIN), ticks(REND); io1 = io(MAIN); c1 = ctxt(MAIN)
drain()
dt = t1 - t0
growth = sum(max(0, size(p) - live_before[p]) for p, c in counts.items() if c['modify'] and p in live_before)
mod_files = [p for p, c in counts.items() if c['modify']]
out = {
    'window_s': round(dt, 1),
    'watched_dirs': len(wds),
    'jsonl_corpus_files': len(live_before),
    'distinct_jsonl_opened': len([p for p, c in counts.items() if c['open']]),
    'main_cpu_pct': round(100 * (m1 - m0) / HZ / dt, 2),
    'renderer_cpu_pct': round(100 * (r1 - r0) / HZ / dt, 2),
    'main_rchar_MiB_s': round((io1['rchar'] - io0['rchar']) / dt / 2**20, 3),
    'main_read_syscalls_s': round((io1['syscr'] - io0['syscr']) / dt, 1),
    'main_ctxt_switches_s': round((c1 - c0) / dt, 1),
    'jsonl_files_appended': len(mod_files),
    'jsonl_modify_events': sum(c['modify'] for c in counts.values()),
    'jsonl_open_events': sum(c['open'] for c in counts.values()),
    'jsonl_access_events': sum(c['access'] for c in counts.values()),
    'jsonl_bytes_appended': growth,
    'files_opened_without_append': len([p for p, c in counts.items() if c['open'] and not c['modify']]),
}
live = [p for p, c in counts.items() if c['modify']]
out['live_files_opens'] = sum(counts[p]['open'] for p in live)
out['live_files_reads'] = sum(counts[p]['access'] for p in live)
delays = []; unread = 0
for p in live:
    ev = times.get(p, [])
    for i, (t, k) in enumerate(ev):
        if k != 'm' or (i + 1 < len(ev) and ev[i + 1][1] == 'm'):
            continue  # only the last append of a burst
        nxt = next((t2 for t2, k2 in ev[i + 1:] if k2 == 'o'), None)
        if nxt is None or nxt - t > 10: unread += 1
        else: delays.append(round((nxt - t) * 1000))
delays.sort()
q = lambda f: delays[min(len(delays) - 1, int(f * len(delays)))] if delays else None
out['append_bursts_to_open_ms'] = {'n': len(delays), 'p50': q(0.5), 'p90': q(0.9), 'max': delays[-1] if delays else None, 'not_reopened_within_10s': unread}
print(json.dumps(out))
```

`slugs.py`:

```python
#!/usr/bin/env python3
"""Read-only: per project dir, distinct cold JSONLs opened vs whether the dir had an append, over WINDOW s."""
import ctypes, ctypes.util, os, struct, sys, time, glob, json, select, collections
WINDOW = float(sys.argv[1]); PROJ = os.path.expanduser('~/.claude/projects')
libc = ctypes.CDLL(ctypes.util.find_library('c'), use_errno=True)
fd = libc.inotify_init1(os.O_NONBLOCK); wds = {}
for d in glob.glob(PROJ + '/*/'):
    wd = libc.inotify_add_watch(fd, d.encode(), 0x2 | 0x20)
    if wd >= 0: wds[wd] = d
opened = collections.defaultdict(set); appended = collections.defaultdict(set); first_open = {}
t0 = time.time()
while time.time() < t0 + WINDOW:
    select.select([fd], [], [], 0.5)
    try: buf = os.read(fd, 1 << 16)
    except BlockingIOError: continue
    i = 0
    while i < len(buf):
        wd, mask, _, ln = struct.unpack_from('iIII', buf, i); name = buf[i+16:i+16+ln].rstrip(b'\0').decode(errors='replace'); i += 16 + ln
        if not name.endswith('.jsonl'): continue
        d = os.path.basename(wds[wd].rstrip('/'))
        if mask & 0x2: appended[d].add(name)
        if mask & 0x20: opened[d].add(name)
sizes = {os.path.basename(d.rstrip('/')): len(glob.glob(d + '*.jsonl')) for d in wds.values()}
rows = []
for d in set(opened) | set(appended):
    cold = opened[d] - appended[d]
    rows.append({'dir_files': sizes.get(d, 0), 'live': len(appended[d]), 'cold_opened': len(cold)})
live_dirs = [r for r in rows if r['live']]; cold_only = [r for r in rows if not r['live']]
print(json.dumps({'window_s': WINDOW, 'dirs_with_append': len(live_dirs),
  'cold_opened_in_dirs_with_append': sum(r['cold_opened'] for r in live_dirs),
  'files_in_dirs_with_append': sum(r['dir_files'] for r in live_dirs),
  'dirs_without_append_but_opened': len(cold_only),
  'cold_opened_in_dirs_without_append': sum(r['cold_opened'] for r in cold_only),
  'per_live_dir': sorted(([r['dir_files'], r['live'], r['cold_opened']] for r in live_dirs), reverse=True)}))
```

`fdattr.py`:

```python
#!/usr/bin/env python3
"""Read-only: which processes hold a ~/.claude/projects/*.jsonl open, sampled every 10 ms."""
import os, sys, time, glob, collections, json
DUR = float(sys.argv[1]); PROJ = os.path.expanduser('~/.claude/projects/')
def name(pid):
    try:
        a = open(f'/proc/{pid}/cmdline','rb').read().split(b'\0')
        return os.path.basename(a[0].decode()) + (' ' + a[1].decode()[:20] if len(a) > 1 and a[1] else '')
    except Exception: return '?'
pids = [p for p in os.listdir('/proc') if p.isdigit()]
mine = []
for p in pids:
    try:
        if os.stat(f'/proc/{p}').st_uid == os.getuid(): mine.append(p)
    except Exception: pass
hits = collections.Counter(); files = collections.defaultdict(set); samples = 0
end = time.time() + DUR
while time.time() < end:
    samples += 1
    for p in mine:
        try:
            for fd in os.listdir(f'/proc/{p}/fd'):
                try: t = os.readlink(f'/proc/{p}/fd/{fd}')
                except OSError: continue
                if t.startswith(PROJ) and t.endswith('.jsonl'):
                    hits[p] += 1; files[p].add(t)
        except Exception: pass
    time.sleep(0.01)
print(json.dumps({'samples': samples, 'by_pid': [{'pid': p, 'proc': name(p), 'hits': n, 'distinct_files': len(files[p])} for p, n in hits.most_common(10)]}))
```

`fdattr.py` output for the 120 s that overlapped run 2:
`{"samples": 2376, "by_pid": [{"pid": "<harnu main>", "proc": "harnu", "hits": 9, "distinct_files": 9}]}`.

`attr.py` (run 5; also the W6 performance gate's script):

```python
#!/usr/bin/env python3
"""Read-only: attribute every open of a live transcript to a reader, by timing, over WINDOW s.

A live transcript is one `claude` appended to during the window (IN_MODIFY). Each IN_OPEN of it
is classified:
  sweep  - at least SWEEP_MIN other transcripts were opened within +-SWEEP_WIN_MS of it
           (a whole-dir or whole-corpus scan, not caused by this file's append)
  tail   - within TAIL_MS after an append to this same file (the watcher's offset read,
           claude-watcher.ts change handler: no debounce before the read)
  pass   - anything else (the fleet model's slug pass, <= 1 per 2000 ms per slug,
           fleet-model.ts:66; or another on-demand reader)
For `pass` opens it also reports the gap to the previous `pass` open of the same file, so the
2000 ms cadence can be seen rather than assumed.

Usage: attr.py <window_s>
"""
import ctypes, ctypes.util, os, struct, sys, time, glob, json, select, bisect

WINDOW = float(sys.argv[1])
TAIL_MS, SWEEP_WIN_MS, SWEEP_MIN = 50, 1000, 50
PROJ = os.path.expanduser('~/.claude/projects')
libc = ctypes.CDLL(ctypes.util.find_library('c'), use_errno=True)
fd = libc.inotify_init1(os.O_NONBLOCK)
wds = {}
for d in glob.glob(PROJ + '/*/'):
    wd = libc.inotify_add_watch(fd, d.encode(), 0x2 | 0x20)  # IN_MODIFY | IN_OPEN
    if wd >= 0:
        wds[wd] = d

events = []  # (t_ms, kind, path)
t0 = time.monotonic()
while time.monotonic() < t0 + WINDOW:
    select.select([fd], [], [], 0.25)
    try:
        buf = os.read(fd, 1 << 16)
    except BlockingIOError:
        continue
    now = (time.monotonic() - t0) * 1000
    i = 0
    while i < len(buf):
        wd, mask, _, ln = struct.unpack_from('iIII', buf, i)
        name = buf[i + 16:i + 16 + ln].rstrip(b'\0').decode(errors='replace')
        i += 16 + ln
        if not name.endswith('.jsonl'):
            continue
        p = wds.get(wd, '?') + name
        if mask & 0x2:
            events.append((now, 'm', p))
        if mask & 0x20:
            events.append((now, 'o', p))

opens_all = sorted(t for t, k, _ in events if k == 'o')
live = {p for _, k, p in events if k == 'm'}
mods = {}
for t, k, p in events:
    if k == 'm':
        mods.setdefault(p, []).append(t)

def others_near(t):
    lo = bisect.bisect_left(opens_all, t - SWEEP_WIN_MS)
    hi = bisect.bisect_right(opens_all, t + SWEEP_WIN_MS)
    return hi - lo - 1

cls = {'tail': 0, 'pass': 0, 'sweep': 0}
tail_delay, pass_delay, pass_gap = [], [], []
last_pass = {}
for t, k, p in events:
    if k != 'o' or p not in live:
        continue
    ms = mods.get(p, [])
    j = bisect.bisect_right(ms, t) - 1
    since = t - ms[j] if j >= 0 else None
    if others_near(t) >= SWEEP_MIN:
        cls['sweep'] += 1
    elif since is not None and since <= TAIL_MS:
        cls['tail'] += 1
        tail_delay.append(round(since))
    else:
        cls['pass'] += 1
        if since is not None:
            pass_delay.append(round(since))
        if p in last_pass:
            pass_gap.append(round(t - last_pass[p]))
        last_pass[p] = t

def q(xs):
    if not xs:
        return None
    xs = sorted(xs)
    pick = lambda f: xs[min(len(xs) - 1, int(f * len(xs)))]
    return {'n': len(xs), 'p10': pick(0.1), 'p50': pick(0.5), 'p90': pick(0.9), 'max': xs[-1]}

appends = sum(len(v) for v in mods.values())
print(json.dumps({
    'window_s': WINDOW,
    'live_files': len(live),
    'appends': appends,
    'live_opens': cls,
    'opens_per_append': {k: round(v / appends, 2) if appends else None for k, v in cls.items()},
    'tail_open_after_append_ms': q(tail_delay),
    'pass_open_after_last_append_ms': q(pass_delay),
    'pass_gap_same_file_ms': q(pass_gap),
    'all_opens_in_window': len(opens_all),
}))
```
