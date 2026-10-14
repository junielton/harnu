#!/usr/bin/env python3
"""T455 W0, B1: without strace, how many of the IN_OPENs attr.py counts on a live transcript are the
writer's own append-opens?

`claude` opens its transcript for every write (O_APPEND, one IN_OPEN then one IN_MODIFY; W0 §4
run 3: 25 append-opens, 25 IN_MODIFY). So each IN_MODIFY's own open is the newest IN_OPEN of the
same file stamped at most SIG_MS before it. This prints, from an m1-inotify.py recording, how many
IN_OPENs carry that signature and how attr.py classes them (`tail`: the file's newest IN_MODIFY
stamped at or before the open is <= 50 ms old, else `pass`), next to every other IN_OPEN.

Usage: m1-appendopen.py <events.json>
"""
import bisect, collections, json, sys

SIG_MS, TAIL_MS = 5.0, 50.0
events = sorted(json.load(open(sys.argv[1])), key=lambda e: e['t'])
mods = collections.defaultdict(list)
opens = collections.defaultdict(list)
for i, e in enumerate(events):
    (mods if e['kind'] == 'm' else opens)[e['name']].append((e['t'], i))
own = set()
for f, ms in mods.items():
    os_ = opens.get(f, [])
    for t, i in ms:
        # newest open of the file at or before this modify (in stream order), within SIG_MS
        cand = [(to, io) for to, io in os_ if io < i and (t - to) * 1000 <= SIG_MS and (to, io) not in own]
        if cand:
            own.add(max(cand, key=lambda x: x[1]))
tally = collections.Counter()
for f, os_ in opens.items():
    mt = sorted(t for t, _ in mods.get(f, []))
    for to, io in os_:
        j = bisect.bisect_right(mt, to) - 1
        since = (to - mt[j]) * 1000 if j >= 0 else None
        cls = 'tail' if since is not None and since <= TAIL_MS else 'pass'
        tally[(cls, 'append-open signature' if (to, io) in own else 'other')] += 1
m = sum(len(v) for v in mods.values())
print(json.dumps({
    'inModify': m,
    'inOpen': sum(len(v) for v in opens.values()),
    'byClass': {f'{k[0]} / {k[1]}': v for k, v in sorted(tally.items())},
    'perAppend': {f'{k[0]} / {k[1]}': round(v / m, 2) for k, v in sorted(tally.items())} if m else {},
}, indent=1))
