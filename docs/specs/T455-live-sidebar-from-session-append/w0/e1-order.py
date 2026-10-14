#!/usr/bin/env python3
"""A-E1: compare the uuids session.append raised (probe log) with the rows of the JSONL(s).

Usage: e1_order.py <probe.json> — prints counts only (no text). For every session id seen in the
probe, main rows (agentId null) are matched against <sid>.jsonl and subagent rows against
<sid>/subagents/agent-<agentId>.jsonl.
"""
import collections, glob, json, os, sys

PROJ = os.path.expanduser('~/.claude/projects')
log = json.load(open(sys.argv[1]))
apps = [e for e in log if e['ev'] == 'session.append']


def jsonl_uuids(path):
    out = []
    for line in open(path, errors='replace'):
        try:
            o = json.loads(line)
        except ValueError:
            continue
        if isinstance(o, dict) and isinstance(o.get('uuid'), str):
            out.append((o['uuid'], o.get('type')))
    return out


groups = collections.OrderedDict()
for e in apps:
    key = (e['sidNow'], e.get('agentId'))
    groups.setdefault(key, []).append(e)

for (sid, agent), rows in groups.items():
    if agent:
        cands = glob.glob(f'{PROJ}/*/{sid}/subagents/agent-{agent}.jsonl')
    else:
        cands = glob.glob(f'{PROJ}/*/{sid}.jsonl')
    if not cands:
        print({'sid': sid[:8], 'agent': bool(agent), 'appended': len(rows), 'file': 'missing'})
        continue
    file_rows = jsonl_uuids(cands[0])
    file_ids = [u for u, _ in file_rows]
    pos = {u: i for i, u in enumerate(file_ids)}
    appended = [e['uuid'] for e in rows]
    found = [u for u in appended if u in pos]
    missing = [e for e in rows if e['uuid'] not in pos]
    order_ok = all(pos[a] < pos[b] for a, b in zip(found, found[1:]))
    app_set = set(appended)
    never_appended = collections.Counter(t for u, t in file_rows if u not in app_set)
    print(json.dumps({
        'sid': sid[:8], 'subagent': bool(agent), 'appended': len(appended), 'in_file': len(found),
        'same_order': order_ok,
        'missing_from_file': [(e['door'], e.get('name')) for e in missing],
        'file_rows_with_uuid': len(file_ids), 'file_rows_never_appended_by_type': dict(never_appended),
        'doors': dict(collections.Counter(e['door'] for e in rows)),
    }))
