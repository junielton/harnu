#!/usr/bin/env python3
"""A-P1 / Q6: who authored the prompt rows of recent transcripts, and which of them the CLI's own
`last-prompt` line names. Aggregates only; no prompt text is printed.

Usage: p1_origin.py <n_transcripts>   (the n most recently modified top-level transcripts whose
first entrypoint is `cli`, i.e. the sessions Harnu's reader lists)
"""
import collections, glob, json, os, re, sys

N = int(sys.argv[1])
PROJ = os.path.expanduser('~/.claude/projects')
files = sorted(glob.glob(PROJ + '/*/*.jsonl'), key=os.path.getmtime, reverse=True)


def norm(s):
    return re.sub(r'\s+', ' ', s or '').strip()


def text_of(msg):
    c = (msg or {}).get('content')
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        if any(isinstance(b, dict) and b.get('type') == 'tool_result' for b in c):
            return None
        return '\n'.join(b.get('text', '') for b in c if isinstance(b, dict) and b.get('type') == 'text')
    return None


def klass(o, text):
    og = o.get('origin')
    if isinstance(og, dict) and og.get('kind'):
        return og['kind']
    if text.lstrip().startswith(('<command-name>', '<local-command', '<command-message>')):
        return 'command(unstamped)'
    if o.get('isMeta'):
        return 'meta(unstamped)'
    return 'unstamped'


rows_by_class = collections.Counter()
meta_by_class = collections.Counter()
lp_named = collections.Counter()           # class of the prompt row the last-prompt text names
lp_skip = collections.Counter()            # newest prompt row was machine, line names an earlier one
lp_follow = collections.Counter()          # newest prompt row was machine, line names it
lp_unmatched = 0
lp_lines = 0
used = 0
sessions_with = collections.Counter()
for f in files:
    if used >= N:
        break
    try:
        lines = open(f, errors='replace').read().splitlines()
    except OSError:
        continue
    entry = None
    prompts = []  # (class, normtext)
    seen = set()
    for line in lines:
        try:
            o = json.loads(line)
        except ValueError:
            continue
        if not isinstance(o, dict):
            continue
        if entry is None and isinstance(o.get('entrypoint'), str):
            entry = o['entrypoint']
            if entry != 'cli':
                break
        t = o.get('type')
        if t == 'user' and not o.get('isSidechain') and not o.get('toolUseResult') and not o.get('isCompactSummary'):
            text = text_of(o.get('message'))
            if text is None or not text.strip():
                continue
            k = klass(o, text)
            rows_by_class[k] += 1
            if o.get('isMeta'):
                meta_by_class[k] += 1
            seen.add(k)
            prompts.append((k, norm(text)))
        elif t == 'last-prompt' and isinstance(o.get('lastPrompt'), str) and o['lastPrompt'].strip():
            lp_lines += 1
            want = norm(o['lastPrompt'])[:40]
            hit = None
            for k, txt in reversed(prompts):
                if want and (txt.startswith(want) or want in txt[:400]):
                    hit = k
                    break
            if hit is None:
                lp_unmatched += 1
                continue
            lp_named[hit] += 1
            newest = prompts[-1][0] if prompts else None
            if newest and newest not in ('human', 'unstamped'):
                if newest == hit and prompts[-1][1].startswith(want):
                    lp_follow[newest] += 1
                else:
                    lp_skip[newest] += 1
    if entry != 'cli':
        continue
    used += 1
    for k in seen:
        sessions_with[k] += 1

print(json.dumps({
    'transcripts': used,
    'prompt_rows_by_origin': dict(rows_by_class.most_common()),
    'of_which_isMeta': dict(meta_by_class.most_common()),
    'sessions_containing_origin': dict(sessions_with.most_common()),
    'last_prompt_lines_with_text': lp_lines,
    'last_prompt_names_row_of_origin': dict(lp_named.most_common()),
    'last_prompt_unmatched': lp_unmatched,
    'newest_row_machine__line_names_earlier_row': dict(lp_skip.most_common()),
    'newest_row_machine__line_names_it': dict(lp_follow.most_common()),
}, indent=1))
