#!/usr/bin/env python3
"""T455 W0, A-S1 corpus: top-level transcripts whose first `entrypoint` is `cli` (the sessions the
reader lists) holding at least MIN_CALLS `tool_use` blocks (enough to ever be stagnant).

Usage: s1-select.py recent <n> <out>    the n most recently modified
       s1-select.py largest <n> <days> <out>   the n largest modified in the last <days> days
Writes one path per line to <out> (a scratch file, never committed); prints counts only.
"""
import glob, json, os, sys, time

MIN_CALLS = 8
PROJ = os.path.expanduser('~/.claude/projects')
mode, n = sys.argv[1], int(sys.argv[2])
files = glob.glob(PROJ + '/*/*.jsonl')
if mode == 'recent':
    out = sys.argv[3]
    files.sort(key=os.path.getmtime, reverse=True)
else:
    days, out = float(sys.argv[3]), sys.argv[4]
    cutoff = time.time() - days * 86400
    files = [f for f in files if os.path.getmtime(f) >= cutoff]
    files.sort(key=os.path.getsize, reverse=True)


def eligible(path):
    entry, calls = None, 0
    with open(path, 'rb') as fh:
        for raw in fh:
            if entry is None and b'"entrypoint"' in raw:
                try:
                    entry = json.loads(raw).get('entrypoint')
                except ValueError:
                    pass
                if entry is not None and entry != 'cli':
                    return False
            calls += raw.count(b'"type":"tool_use"')
    return entry == 'cli' and calls >= MIN_CALLS


picked, scanned = [], 0
for f in files:
    if len(picked) >= n:
        break
    scanned += 1
    if eligible(f):
        picked.append(f)
open(out, 'w').write('\n'.join(picked) + '\n')
print(json.dumps({'takenAt': time.strftime('%Y-%m-%dT%H:%M:%S%z'), 'corpusTopLevelTranscripts': len(glob.glob(PROJ + '/*/*.jsonl')),
                  'mode': mode, 'picked': len(picked), 'scanned': scanned}))
