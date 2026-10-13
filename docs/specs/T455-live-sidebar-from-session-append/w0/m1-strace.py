#!/usr/bin/env python3
"""A-M1: from `strace -f -tt -e trace=openat,open,execve,clone,clone3,fork,vfork`, list every open of a
~/.claude/projects/**/*.jsonl by the traced tree, classified as main-process thread vs child process,
and by flags (read vs append). Prints paths reduced to their basename prefix; no content."""
import re, sys, collections

lines = open(sys.argv[1], errors='replace').read().splitlines()
root = lines[0].split()[0]
thread_of = {root: root}   # tid -> owning process pid
exe = {root: 'claude'}
first_write = {}
rows = []
pending = {}
for l in lines:
    parts = l.split(None, 2)
    if len(parts) < 3:
        continue
    tid, ts, rest = parts
    # Join a call strace split across '<unfinished ...>' / '<... x resumed>'.
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
            exe[child] = exe.get(thread_of.get(tid, tid), '?') + '>fork'
        continue
    m = re.match(r'execve\("([^"]+)"', rest)
    if m and '= 0' in rest:
        exe[thread_of.get(tid, tid)] = m.group(1).rsplit('/', 1)[1]
        continue
    m = re.search(r'open(?:at)?\((?:AT_FDCWD, )?"([^"]*/\.claude/projects/[^"]*\.jsonl)", ([A-Z_|]+).*= (-?\d+)', rest)
    if not m:
        continue
    path, flags, ret = m.groups()
    proc = thread_of.get(tid, '?')
    who = 'claude-thread' if proc == root else f'child:{exe.get(proc, "?")}'
    kind = 'append' if 'O_APPEND' in flags else ('write' if 'O_WRONLY' in flags or 'O_RDWR' in flags else ('path' if 'O_PATH' in flags else 'read'))
    name = path.rsplit('/', 1)[1][:8] + ('(sub)' if '/subagents/' in path else '')
    ok = not ret.startswith('-')
    if kind == 'append' and ok:
        first_write.setdefault(name, ts)
    rows.append((ts, name, who, kind, ok))

c = collections.Counter((n, w, k, ok, 'before-first-write' if n not in first_write or ts < first_write[n] else 'after') for ts, n, w, k, ok in rows)
for k, v in sorted(c.items()):
    print(v, k)
print('reads after first write (ts):')
for ts, n, w, k, ok in rows:
    if k == 'read' and ok and n in first_write and ts >= first_write[n]:
        print(' ', ts, n, w)
