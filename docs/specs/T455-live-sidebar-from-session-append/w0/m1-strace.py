#!/usr/bin/env python3
"""T455 W0, A-M1: which opens of a session's own transcript does the traced `claude` tree make?

Reads an `strace -f` log of `openat,open` (optionally `execve,clone,clone3,fork,vfork`, and `-tt`
timestamps). For every open of a ~/.claude/projects/**/*.jsonl it prints counts by file prefix,
opener (a thread of the traced `claude` process, a child process, or `unattributed` when the log
holds no clone calls), kind (append / read / path) and success, split at the file's first
successful append-open. Paths are reduced to an 8-char basename prefix; no content is read.

With `--inotify <events.json>` (from m1-inotify.py, recorded on the same project dir during the
same run, and a `-tt` log) it also attributes every IN_OPEN the way attr.py counts it: each
IN_OPEN is matched one-to-one to the nearest claude open of the same file within TOL_MS (else it is
another process's open, e.g. Harnu's), and classed exactly as attr.py classes it: `tail` when the
file's newest IN_MODIFY stamped at or before it is <= 50 ms old, else `pass` (no sweep can occur
on one quiet dir).

Usage: m1-strace.py <strace.log> [--inotify <events.json>]
"""
import bisect, collections, datetime, json, re, sys

TOL_MS, TAIL_MS = 20.0, 50.0
log_path = sys.argv[1]
ino_path = sys.argv[sys.argv.index('--inotify') + 1] if '--inotify' in sys.argv else None
lines = open(log_path, errors='replace').read().splitlines()
TS = re.compile(r'^\d\d:\d\d:\d\d\.\d+$')
timed = len(lines[0].split(None, 2)) > 2 and bool(TS.match(lines[0].split(None, 2)[1]))
has_clone = any(re.search(r'\b(clone3?|v?fork)\(', l) for l in lines[:20000])
root = lines[0].split()[0]
thread_of = {root: root}
exe = {root: 'claude'}
pending = {}
rows = []  # (order, ts, name, who, kind, ok)
for n, l in enumerate(lines):
    if timed:
        parts = l.split(None, 2)
        if len(parts) < 3:
            continue
        tid, ts, rest = parts
    else:
        parts = l.split(None, 1)
        if len(parts) < 2:
            continue
        (tid, rest), ts = parts, None
    if rest.endswith('<unfinished ...>'):
        pending[tid] = rest[: -len('<unfinished ...>')]
        continue
    m = re.match(r'<\.\.\. (\w+) resumed>(.*)', rest)
    if m:
        rest = pending.pop(tid, m.group(1) + '(') + m.group(2)
    m = re.match(r'(clone3?|fork|vfork)\((.*)\)\s*=\s*(\d+)', rest)
    if m:
        child = m.group(3)
        if 'CLONE_THREAD' in m.group(2):
            thread_of[child] = thread_of.get(tid, tid)
        else:
            thread_of[child] = child
        continue
    m = re.match(r'execve\("([^"]+)"', rest)
    if m and '= 0' in rest:
        exe[thread_of.get(tid, tid)] = m.group(1).rsplit('/', 1)[1]
        continue
    m = re.search(r'open(?:at)?\((?:AT_FDCWD, )?"([^"]*/\.claude/projects/[^"]*\.jsonl)", ([A-Z_|]+).*= (-?\d+)', rest)
    if not m:
        continue
    path, flags, ret = m.groups()
    if not has_clone:
        who = 'unattributed'
    else:
        proc = thread_of.get(tid, '?')
        who = 'claude-thread' if proc == root else f'child:{exe.get(proc, "?")}'
    kind = 'append' if 'O_APPEND' in flags else ('write' if 'O_WRONLY' in flags or 'O_RDWR' in flags else ('path' if 'O_PATH' in flags else 'read'))
    name = path.rsplit('/', 1)[1][:8] + ('(sub)' if '/subagents/' in path else '')
    rows.append((n, ts, name, who, kind, not ret.startswith('-')))

first_write = {}
for n, ts, name, who, kind, ok in rows:
    if kind == 'append' and ok:
        first_write.setdefault(name, n)
c = collections.Counter(
    (name, who, kind, 'ok' if ok else 'failed', 'before-first-append' if name not in first_write or n < first_write[name] else 'after')
    for n, ts, name, who, kind, ok in rows
)
out = {'timestamps': timed, 'cloneTraced': has_clone, 'opens': [[*k, v] for k, v in sorted(c.items())]}

if ino_path and timed:
    events = json.load(open(ino_path))
    day = datetime.datetime.fromtimestamp(events[0]['t']).date() if events else datetime.date.today()

    def epoch(ts):
        h, m_, s = ts.split(':')
        return datetime.datetime.combine(day, datetime.time(int(h), int(m_))).timestamp() + float(s)

    own = collections.defaultdict(list)  # file prefix -> [(t, kind)]
    for n, ts, name, who, kind, ok in rows:
        if ok and kind in ('append', 'read') and who in ('claude-thread', 'unattributed'):
            own[name].append([epoch(ts), kind, False])
    # attr.py's own rule: the newest IN_MODIFY of the file stamped at or before the open's stamp
    # (`bisect_right`), so a modify read in the same inotify batch as the open counts as before it.
    mods = collections.defaultdict(list)
    for e in events:
        if e['kind'] == 'm':
            mods[e['name'][:8]].append(e['t'])
    for v in mods.values():
        v.sort()
    tally = collections.Counter()
    modify = collections.Counter({f: len(v) for f, v in mods.items()})
    for e in sorted(events, key=lambda e: e['t']):
        f = e['name'][:8]
        if e['kind'] == 'm':
            continue
        j = bisect.bisect_right(mods[f], e['t']) - 1
        since = (e['t'] - mods[f][j]) * 1000 if j >= 0 else None
        cls = 'tail' if since is not None and since <= TAIL_MS else 'pass'
        best = None
        for o in own.get(f, []):
            if not o[2] and abs(o[0] - e['t']) * 1000 <= TOL_MS and (best is None or abs(o[0] - e['t']) < abs(best[0] - e['t'])):
                best = o
        if best:
            best[2] = True
            tally[(f, cls, 'claude-' + best[1])] += 1
        else:
            tally[(f, cls, 'other')] += 1
    unmatched_own = collections.Counter((f, o[1]) for f, os_ in own.items() for o in os_ if not o[2])
    out['inotify'] = {
        'inModifyByFile': dict(modify),
        'inOpenByFileClassOpener': [[*k, v] for k, v in sorted(tally.items())],
        'claudeOpensWithNoIN_OPENwithinTol': [[*k, v] for k, v in sorted(unmatched_own.items())],
    }
print(json.dumps(out, indent=1))
