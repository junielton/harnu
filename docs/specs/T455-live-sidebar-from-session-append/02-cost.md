# T455 — Measured cost of today's live-session path (§8 of the spec, U-5)

Measured on the operator's machine, against the Harnu instance that was running, **read-only**:
nothing was attached to, signalled or restarted. 2026-10-09, 16:27–16:40 local time (UTC−3).

## 8.1 The machine and the load

| Fact                                         | Value                                                                                                           |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Harnu build                                  | the installed AppImage (main pid uptime ~1.9 h at the start)                                                    |
| Live `claude` children of Harnu main         | 28 (orchestrator, executors and dispatched sessions of this mission)                                            |
| Transcript corpus under `~/.claude/projects` | 10,797–10,815 top-level `*.jsonl` in 449–454 project dirs; one dir (the Harnu repo's main checkout) holds 9,387 |
| chokidar inotify watches held by Harnu main  | 13,902 on one inotify fd (`grep -c '^inotify wd' /proc/<pid>/fdinfo/<fd>`)                                      |
| Lifetime averages (`ps`, before sampling)    | main 8.8 % CPU, renderer 19.9 % CPU; main `rchar` 184,756,173,338 bytes over 6,869 s (~25.6 MiB/s)              |
| Kernel                                       | Linux 7.0, `kernel.yama.ptrace_scope = 1` (no `strace`/`perf` attach to a non-child; no root for `bpftrace`)    |

`ptrace_scope = 1` rules out per-syscall attribution, so attribution is done with inotify (which
file was opened, and when) plus a `/proc/<pid>/fd` sampler (who held it open).

## 8.2 Method

Three read-only probes, all in Python with no third-party module (scripts in §8.6):

1. **`sample.py <main> <renderer> 60`** — one 60 s window. Deltas of `utime + stime` for Harnu
   main and the renderer (`/proc/<pid>/stat`), of main's `rchar` and `syscr` (`/proc/<pid>/io`), and
   of voluntary + involuntary context switches summed over main's threads (a wake-up proxy). It
   puts its **own** inotify watch (`IN_MODIFY | IN_OPEN | IN_ACCESS`, non-recursive) on every
   project dir and counts, per top-level `*.jsonl`: appends (`IN_MODIFY`, written by `claude`),
   opens and reads by any reader. For each append that ends a burst it measures the delay to the
   next open of the same file.
2. **`slugs.py 60`** — the same inotify watch, grouped by project dir: distinct cold files opened
   (opened, never appended) in dirs that had an append versus dirs that did not.
3. **`fdattr.py 120`** — every 10 ms, which of the user's processes holds a
   `~/.claude/projects/**/*.jsonl` open (`readlink /proc/<pid>/fd/*`).

Caveats, stated once: inotify events carry no pid, so opens are attributed to Harnu main by
`fdattr.py` (over 2,376 samples in 120 s, the only process ever seen holding a transcript open
was Harnu main) and by main's own `syscr` / `rchar`; a `claude` process does not read its own
transcript after boot (assumption **A-M1**). `rchar` also counts PTY and socket reads. The
executor's own probe sessions (03-prototype.md) ran during run 3 and created four small
transcripts in a scratch dir.

## 8.3 Raw results

Run 1 (3 × 60 s; its byte-growth field was buggy and is omitted):

| Window | main CPU | renderer CPU | main read MiB/s | main read syscalls/s | main ctx switches/s | files appended | appends | opens  | reads   | cold files opened |
| ------ | -------- | ------------ | --------------- | -------------------- | ------------------- | -------------- | ------- | ------ | ------- | ----------------- |
| 1      | 8.66 %   | 32.54 %      | 45.3            | 2,278                | 2,034               | 13             | 118     | 82,353 | 312,282 | 10,778            |
| 2      | 10.25 %  | 43.04 %      | 67.4            | 2,813                | 2,469               | 13             | 127     | 31,583 | 167,862 | 10,781            |
| 3      | 12.95 %  | 30.84 %      | 46.6            | 3,120                | 3,422               | 15             | 172     | 6,876  | 38,289  | 3,191             |

Run 2 (2 × 60 s) and run 3 (3 × 60 s, with latency and live-file amplification):

| Window | main CPU | renderer CPU | main read MiB/s | read syscalls/s | ctx switches/s | appended files / appends | bytes appended | opens  | reads   | distinct opened / corpus | live-file opens / reads | append → next open p50 / p90 / max (ms) |
| ------ | -------- | ------------ | --------------- | --------------- | -------------- | ------------------------ | -------------- | ------ | ------- | ------------------------ | ----------------------- | --------------------------------------- |
| 2.1    | 9.22 %   | 23.71 %      | 0.7             | 1,209           | 1,977          | 11 / 142                 | 1,429,081      | 9,997  | 10,720  | 9,576 / 10,797           | —                       | —                                       |
| 2.2    | 12.90 %  | 31.55 %      | 64.3            | 6,092           | 2,365          | 14 / 155                 | 1,122,628      | 17,605 | 396,385 | 10,798 / 10,795          | —                       | —                                       |
| 3.1    | 14.72 %  | 24.62 %      | 96.3            | 5,224           | 3,433          | 17 / 130                 | 1,833,329      | 24,740 | 609,765 | 10,806 / 10,801          | 399 / 7,795             | 0 / 1,484 / 3,504                       |
| 3.2    | 17.62 %  | 29.87 %      | 28.7            | 4,636           | 3,393          | 20 / 176                 | 890,636        | 3,777  | 18,590  | 3,238 / 10,809           | 484 / 983               | 1 / 250 / 6,402 (2 never reopened)      |
| 3.3    | 16.68 %  | 26.96 %      | 23.6            | 2,522           | 3,887          | 14 / 162                 | 2,553,541      | 3,694  | 18,313  | 3,242 / 10,815           | 455 / 855               | 1 / 215 / 3,711                         |

Run 4 (`slugs.py`, 3 × 60 s) — where the cold opens happen:

| Window | dirs with an append | cold files opened in those dirs | of which in the 9,387-file dir (its appends) | dirs with no append but opened | cold files opened there |
| ------ | ------------------- | ------------------------------- | -------------------------------------------- | ------------------------------ | ----------------------- |
| 4.1    | 14                  | 2,806                           | 2,792 (2 appended files)                     | 169                            | 414                     |
| 4.2    | 11                  | 0                               | — (no append in that dir)                    | 0                              | 0                       |
| 4.3    | 12                  | 2,801                           | 2,790 (1 appended file)                      | 173                            | 418                     |

## 8.4 What the numbers say

1. **Each append is read about three times.** Live files were opened 399 / 484 / 455 times for
   130 / 176 / 162 appends: **2.6–3.1 opens per append**. That is the watcher's offset tail, the
   reader's fold and the fleet model's slug pass, each reading the same bytes (01-inventory.md
   §3.3). The median append is reopened within 1 ms (the watcher); p90 is 215–1,484 ms (the 2 s
   slug-pass cadence of `fleet-model.ts:66`).
2. **An append in a big project dir costs ~2,800 cold opens a minute.** In all three windows,
   one or two appends in the 9,387-file dir came with 2,790–2,792 _other_ transcripts of that dir
   opened; the one window without an append there had **zero** cold opens anywhere. The only code
   that reaches cold files of a slug on an append is the slug pass (`claude-reader.ts:1572-1626`).
   Why its (mtime, size) header cache (`:1008-1012`) does not spare those files is not established
   here (assumption **A-M2**, the first thing the W0 spike instruments; `claude-reader.ts` already
   counts `fileOpens` and `jsonlBytesRead` for its tests).
3. **Whole-corpus sweeps also happen.** In 5 of 8 sampler windows Harnu main opened
   9,576–10,806 distinct transcripts (essentially the whole corpus) with up to 609,765 reads and
   96 MiB/s. Their trigger is **not attributed** by this method. Candidates: a full `foldersLoad`
   after a membership change (new sessions were being created throughout, including this
   executor's probes) and the post-migration backfill (`stores/sessions.ts:4967-4989`), which is
   itself a full load. T455 removes the backfill for claimed rows (§6 of the spec); it does not
   claim the rest.
4. **Context:** main sat at 8.7–17.6 % CPU and 1,977–3,887 context switches/s, the renderer at
   23.7–43.0 %. BUG-146 measured main ~13 % and renderer ~29 % on a smaller corpus (324 slugs,
   9,345 JSONLs). These totals include everything Harnu does (28 PTYs streaming into xterm, the
   MCP server, the companion host); they are not the live-session path alone and are not claimed
   as T455's gain.

## 8.5 The gain, as numbers to beat

What T455 removes for a session whose `row` family is active (§7 of the spec), and what the W6
gate re-measures with the same scripts:

| Cost today (measured)                                 | After T455 (target)                                                        |
| ----------------------------------------------------- | -------------------------------------------------------------------------- |
| 2.6–3.1 transcript opens per append of a live session | ≤ 1 (the watcher's `change` is ignored for an owned path; title is pushed) |
| ~2,800 cold-file opens/min per active big project dir | 0 caused by an owned session's appends (no slug pass on its appends)       |
| append → sidebar: p90 215–1,484 ms, max 6.4 s         | push → host: one coalescing window (≤ 500 ms) + one Unix-socket POST       |
| one post-migration full `foldersLoad` per new session | none for a claimed row (§6)                                                |

The cost T455 adds inside each session, measured by the engine's own debug log on Claude Code
2.1.296 for the prototype (03-prototype.md §P.3): `session.append` hook settles in **0.3–1.8 ms**
per row (26 rows; one outlier at 9.5 ms), `session.start` 20.8 ms, `turn.complete` 3.8 ms, and
**4 HTTP POSTs for a two-tool-call turn of 26 rows**.

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
