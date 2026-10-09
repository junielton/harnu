# T449 — Measurement: repeat Reads on this machine (U-4)

Companion to [`00-spec.md`](00-spec.md) §4. Everything here was measured on 2026-10-09 on the
operator's machine, from its own Claude Code transcripts. The scanner prints aggregates only; no
path, project name or file content leaves it.

## 1. Corpus

| Item                                 | Value                                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------------------ |
| Source                               | `~/.claude/projects/*/*.jsonl` (main loops) and `*/*/subagents/*.jsonl` (subagents)        |
| Transcript files                     | 12,066 (10,803 main loops, 1,263 subagent loops)                                           |
| Size                                 | 3.98 GB                                                                                    |
| Time span                            | 2026-07-15 → 2026-10-09 (55 distinct days with rows)                                       |
| Claude Code versions in rows         | 2.1.210 → 2.1.295                                                                          |
| Loops that called Read at least once | 837 main, 680 subagent                                                                     |
| Read calls                           | 6,954 main + 3,255 subagent = 10,209                                                       |
| Read result kinds (`toolUseResult`)  | text 8,028 · image 2,076 · pdf 1 · parts 1 · unattributed 103 (a row with several results) |
| Compaction boundaries                | 41                                                                                         |
| Bash calls                           | 53,504 main + 16,803 subagent                                                              |

The scan ran before any of the prototype's live runs (`02-prototype.md` §3), so none of their
transcripts are in it.

## 2. Method

1. **One loop at a time.** Each transcript file is one conversation: a main loop or one subagent's.
   A main loop's file and its subagents' files are scanned separately, because a subagent has its
   own history.
2. **Context windows.** A window ends at a `system` row with `subtype: compact_boundary`. A
   `/clear` starts a new file, so it is a boundary by construction. A resume is not split; see
   threats below.
3. **Key.** A Read is keyed by `(file_path, offset, limit, pages)` as the model wrote them.
4. **Repeat.** A Read whose key was already read earlier in the same window, where that earlier
   Read was not cut to its token cap (`truncatedByTokenCap`).
5. **Unchanged repeat.** The model-visible tool_result text of the repeat is byte-identical
   (sha256) to the earlier one; for an image, the image bytes are hashed. Anything else is a
   **changed repeat**. A cross-check compared the numbered lines (`N<tab>text`) instead of the whole
   text, to catch a repeat hidden by a varying reminder: it found **0** extra repeats.
6. **Covered Read.** A ranged Read (`offset` or `limit` set) whose every line is present, with the
   same text, in the latest whole-file Read of that path in the window. The cache of the spec does
   not answer these (different key); they are counted to size the variant that would (§5.2 of the
   spec).
7. **Gap.** Minutes between the earlier result's row and the repeat's call. Claude Code's
   keep-recent micro-compaction clears old tool results only after a long idle (§5.4 and A-1 of the spec),
   so repeats within 60 minutes are the conservative subset.
8. **Tokens.** Characters of the tool_result text divided by a characters-per-token ratio
   measured on the same corpus: for every Read result over 20,000 characters that was the only row
   between two assistant responses, the growth of the request's input
   (`input_tokens + cache_creation_input_tokens + cache_read_input_tokens`) minus the previous
   response's `output_tokens` is taken as that result's tokens. 887 samples; median **2.245**
   characters per token (quartiles 1.726 and 2.461). The growth also holds the reminders the engine
   adds, so the ratio is a lower bound and every token figure below an upper bound.
9. **Bash and Grep/Glob.** For U-2: a Bash call whose exact command string and exact output repeat
   in the same window; the subset whose command starts with `cat`, `head`, `tail`, `sed -n`, `less`,
   `bat` or `nl`. Grep and Glob calls the same way.

## 3. Results

| Measure                                                         | Main loops                                         | Subagents          |
| --------------------------------------------------------------- | -------------------------------------------------- | ------------------ |
| Read tokens, all (upper bound)                                  | ~19.0 M                                            | ~12.9 M            |
| Same-key repeats in one window                                  | 203                                                | 21                 |
| — changed repeats                                               | 192                                                | 12                 |
| — of which after the loop's own Edit/Write of the file          | 88 (~304 k tokens)                                 | —                  |
| **Unchanged text repeats** (what the cache answers)             | **9**                                              | **0**              |
| — their tokens                                                  | **~14.3 k**                                        | 0                  |
| — within 60 minutes of the earlier Read                         | 8 (~13.6 k tokens)                                 | 0                  |
| Unchanged image repeats                                         | 2                                                  | 9                  |
| Covered ranged Reads (not answered by this design)              | 47                                                 | 5                  |
| — their tokens                                                  | ~24.8 k (together)                                 |                    |
| Loops with at least one unchanged repeat (text or image)        | 10 of 1,517 loops that read                        |                    |
| Distribution per such loop                                      | 7 loops × 1, 2 × 2, 1 × 9                          |                    |
| Gap of the 20 timed unchanged repeats                           | median 7.6 min; 7 ≤ 5 min; 19 ≤ 60 min; 1 > 60 min |                    |
| Bash, identical command and output repeated                     | 332 (~12.9 k tokens)                               | 19 (~1.7 k tokens) |
| — file dumps (`cat`, `head`, `sed -n`, …)                       | 6 together, ~158 tokens                            |                    |
| Grep / Glob calls in the whole corpus                           | 23 together (none on the current native build)     |                    |
| Read results of type `file_unchanged` (the engine's own dedupe) | 0                                                  | 0                  |

The sizes of the nine unchanged text repeats, in characters: 87, 87, 509, 1,577, 2,387, 3,304,
6,803, 7,579, 9,708 (32,041 together).

**Reading it.** Over 55 days and 10,209 Reads, the cache would have answered nine, and saved about
14 thousand tokens: **0.08 %** of the tokens Read results put into main-loop context (0.04 % of all
Read tokens). The large pile of re-reads is a different behaviour: re-reading a file after editing
it (88 repeats, ~304 k tokens, twenty times more), where the content did change and nothing can be
deduplicated.

**Threats to validity.** (a) Resumed sessions that kept their file are one window across the resume;
that can only overcount (the mod starts empty after a resume, §5.4 of the spec). (b) Keep-recent
micro-compaction and budget cuts are not in the transcript (reference.md:141), so a repeat counted
here may have followed a cleared result; the 60-minute subset bounds that. (c) The corpus is one
operator's 55 days, dominated by Harnu orchestration sessions and short scheduler ticks; a
different workload (long single-agent refactors) may re-read more. The scanner below is the way to
re-measure on any machine.

## 4. The scanner

Run as `python3 -I scan.py [root]` (default `~/.claude/projects`); it prints one JSON object. It ran
in about 12 seconds over the corpus above.

```python
#!/usr/bin/env python3
"""T449 corpus scan: repeat Reads of an unchanged file within one context window.

Usage: python3 -I scan.py [root]   (default ~/.claude/projects)
Prints aggregate numbers only (no paths), as JSON.

Definitions
- A transcript file is one loop: a main conversation (<root>/<proj>/<sid>.jsonl) or a
  subagent's (<...>/subagents/agent-*.jsonl). Each loop is scanned on its own.
- A context window is the span between two `system/compact_boundary` rows (or file
  start/end). A /clear starts a new file, so it is a window boundary by construction.
- Key of a Read: (file_path, offset or None, limit or None, pages or None).
- A repeat R2 of R1: same key, same window, R1 earlier, R1 answered as text and not
  truncatedByTokenCap.
  - unchanged: the model-visible tool_result text of R2 == that of R1 (sha256).
  - changed: it differs.
- covered: R2 is a ranged Read whose lines are all present, equal, in the latest
  full-file Read of that path in the window (whole file, not truncated).
- gap: wall-clock minutes between R1's result and R2's call (keep-recent microcompact
  clears old tool results only after ~65 min idle, so gap <= 60 is the safe subset).
- Bash repeat: identical command string, identical tool_result text, same window.
- tokens: tool_result chars / CPT, CPT calibrated from usage deltas (see calib).
"""
import glob, hashlib, json, os, re, statistics, sys
from collections import Counter, defaultdict
from datetime import datetime

root = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser('~/.claude/projects')
files = glob.glob(os.path.join(root, '*', '*.jsonl')) + glob.glob(os.path.join(root, '*', '*', 'subagents', '*.jsonl'))

def h(s):
    return hashlib.sha256(s.encode('utf-8', 'replace')).hexdigest()

def ts(d):
    t = d.get('timestamp')
    if not t:
        return None
    try:
        return datetime.fromisoformat(t.replace('Z', '+00:00')).timestamp()
    except Exception:
        return None

def result_text(block):
    c = block.get('content')
    if isinstance(c, str):
        return c, False
    if isinstance(c, list):
        parts, media = [], False
        for b in c:
            if isinstance(b, dict) and b.get('type') == 'text':
                parts.append(b.get('text', ''))
            elif isinstance(b, dict) and b.get('type') in ('image', 'document'):
                media = True
                src = b.get('source') or {}
                parts.append('<media:' + hashlib.sha256(str(src.get('data', '')).encode()).hexdigest() + '>')
        return '\n'.join(parts), media
    return '', False

LINE = re.compile(r'^\s*(\d+)\t(.*)$')
def numbered(text):
    out = {}
    for ln in text.split('\n'):
        m = LINE.match(ln)
        if m:
            out[int(m.group(1))] = m.group(2)
    return out

FILE_DUMP = re.compile(r'^\s*(cat|head|tail|sed\s+-n|less|bat|nl)\b')

S = Counter()
gaps = []
textsizes = []
days = set()
per_loop_unchanged = []
unchanged_chars_by_kind = Counter()
calib = []
read_types = Counter()
repeat_dist = Counter()
sessions_with = set()
versions = Counter()
total_bytes = 0

for f in files:
    is_sub = '/subagents/' in f
    kind = 'sub' if is_sub else 'main'
    try:
        total_bytes += os.path.getsize(f)
        fh = open(f, encoding='utf-8', errors='replace')
    except OSError:
        continue
    S['loops_' + kind] += 1
    window = 0
    uses = {}            # tool_use_id -> (name, input, window, t)
    seen = {}            # key -> (texthash, chars, window, t_result)
    full = {}            # path -> (window, numbered dict)
    bash_seen = {}       # (cmd) -> (hash, window)
    edited = {}          # path -> (window, t) of this loop's last edit
    loop_unchanged = 0
    loop_reads = 0
    last_assistant = {}  # message id -> usage, for calibration
    prev_usage = None
    pending_single = None  # (chars) of a lone Read result awaiting next usage
    for line in fh:
        try:
            d = json.loads(line)
        except Exception:
            continue
        t = d.get('type')
        if d.get('version'):
            versions[d['version']] += 0  # presence only
        if d.get('timestamp'):
            days.add(d['timestamp'][:10])
        if t == 'system' and d.get('subtype') == 'compact_boundary':
            window += 1
            S['compact_boundaries'] += 1
            continue
        m = d.get('message') or {}
        content = m.get('content')
        if t == 'assistant':
            u = m.get('usage') or {}
            tot = (u.get('input_tokens') or 0) + (u.get('cache_creation_input_tokens') or 0) + (u.get('cache_read_input_tokens') or 0)
            if pending_single is not None and prev_usage is not None and tot:
                delta = tot - (prev_usage[0] + prev_usage[1])
                if delta > 300:
                    calib.append(pending_single / delta)
                pending_single = None
            if tot:
                prev_usage = (tot, u.get('output_tokens') or 0)
            if isinstance(content, list):
                for b in content:
                    if isinstance(b, dict) and b.get('type') == 'tool_use':
                        uses[b.get('id')] = (b.get('name'), b.get('input') or {}, window, ts(d))
            continue
        if t != 'user' or not isinstance(content, list):
            continue
        results = [b for b in content if isinstance(b, dict) and b.get('type') == 'tool_result']
        for b in results:
            u = uses.get(b.get('tool_use_id'))
            if not u:
                continue
            name, inp, w0, t_call = u
            text, media = result_text(b)
            tur = d.get('toolUseResult') if len(results) == 1 else None
            if name == 'Read':
                loop_reads += 1
                S['reads_' + kind] += 1
                S['read_chars_' + kind] += len(text)
                rtype = tur.get('type') if isinstance(tur, dict) else ('media' if media else 'unknown')
                read_types[rtype] += 1
                if b.get('is_error'):
                    S['read_errors'] += 1
                    continue
                if media:
                    S['read_media'] += 1
                truncated = isinstance(tur, dict) and isinstance(tur.get('file'), dict) and tur['file'].get('truncatedByTokenCap')
                if truncated:
                    S['read_truncated_by_cap'] += 1
                path = inp.get('file_path')
                key = (path, inp.get('offset'), inp.get('limit'), inp.get('pages'))
                th = h(text) + ('|m' if media else '')
                tr = ts(d)
                if len(results) == 1 and len(text) > 20000 and not media:
                    pending_single = len(text)
                prev = seen.get(key)
                if prev and prev[2] == window:
                    S['repeat_same_key_' + kind] += 1
                    if prev[0] == th:
                        gap = ((t_call or 0) - (prev[3] or 0)) / 60 if t_call and prev[3] else None
                        S['unchanged_' + kind] += 1
                        S['unchanged_chars_' + kind] += len(text)
                        loop_unchanged += 1
                        if media:
                            S['unchanged_media_' + kind] += 1
                        else:
                            S['unchanged_text_' + kind] += 1
                            S['unchanged_text_chars_' + kind] += len(text)
                            if gap is not None and gap <= 60:
                                S['unchanged_text_le60_' + kind] += 1
                                S['unchanged_text_le60_chars_' + kind] += len(text)
                            textsizes.append(len(text))
                        if gap is not None:
                            gaps.append(gap)
                            if gap <= 60:
                                S['unchanged_le60_' + kind] += 1
                                S['unchanged_le60_chars_' + kind] += len(text)
                        sessions_with.add(f)
                    else:
                        S['changed_' + kind] += 1
                        S['changed_chars_' + kind] += len(text)
                        if prev[4] is not None and prev[4] == h(json.dumps(numbered(text))) and numbered(text):
                            S['changed_but_same_lines_' + kind] += 1
                            S['changed_but_same_lines_chars_' + kind] += len(text)
                        ed = edited.get(path)
                        if ed and ed[0] == window and ed[1] >= (prev[3] or 0):
                            S['changed_after_own_edit_' + kind] += 1
                            S['changed_after_own_edit_chars_' + kind] += len(text)
                elif prev:
                    S['repeat_other_window'] += 1
                if not truncated:
                    seen[key] = (th, len(text), window, tr, h(json.dumps(numbered(text))) if not media else None)
                # covered by an earlier full read
                if not media and (inp.get('offset') is not None or inp.get('limit') is not None):
                    fr = full.get(path)
                    if fr and fr[0] == window:
                        lines = numbered(text)
                        if lines and all(fr[1].get(k) == v for k, v in lines.items()):
                            S['covered_' + kind] += 1
                            S['covered_chars_' + kind] += len(text)
                if not media and inp.get('offset') is None and inp.get('limit') is None and not truncated:
                    full[path] = (window, numbered(text))
            elif name in ('Edit', 'Write', 'MultiEdit', 'NotebookEdit'):
                S['edits'] += 1
                edited[(inp.get('file_path') or inp.get('notebook_path'))] = (window, ts(d) or 0)
            elif name == 'Bash':
                cmd = (inp.get('command') or '').strip()
                S['bash_' + kind] += 1
                k = cmd
                th = h(text)
                prev = bash_seen.get(k)
                if prev and prev[1] == window and prev[0] == th and text.strip():
                    S['bash_unchanged_' + kind] += 1
                    S['bash_unchanged_chars_' + kind] += len(text)
                    if FILE_DUMP.match(cmd):
                        S['bash_unchanged_filedump'] += 1
                        S['bash_unchanged_filedump_chars'] += len(text)
                bash_seen[k] = (th, window)
            elif name in ('Grep', 'Glob'):
                S['grepglob_calls'] += 1
                k = (name, json.dumps(inp, sort_keys=True))
                th = h(text)
                prev = bash_seen.get(k)
                if prev and prev[1] == window and prev[0] == th:
                    S['grepglob_unchanged'] += 1
                    S['grepglob_unchanged_chars'] += len(text)
                bash_seen[k] = (th, window)
            if 'file_unchanged' in text or text.startswith('File unchanged since last read'):
                S['builtin_file_unchanged'] += 1
    fh.close()
    if loop_reads:
        S['loops_with_reads_' + kind] += 1
    if loop_unchanged:
        repeat_dist[min(loop_unchanged, 20)] += 1

cpt = statistics.median(calib) if calib else 4.0
q = statistics.quantiles(calib, n=4) if len(calib) > 4 else [cpt, cpt, cpt]
out = {
    'files': len(files),
    'bytes': total_bytes,
    'counts': dict(S),
    'read_result_types': dict(read_types),
    'chars_per_token': {'median': round(cpt, 3), 'q1': round(q[0], 3), 'q3': round(q[2], 3), 'samples': len(calib)},
    'gap_minutes': {
        'n': len(gaps),
        'median': round(statistics.median(gaps), 1) if gaps else None,
        'le5': sum(1 for g in gaps if g <= 5),
        'le60': sum(1 for g in gaps if g <= 60),
        'gt60': sum(1 for g in gaps if g > 60),
    },
    'loops_with_unchanged_repeat': len(sessions_with),
    'unchanged_per_loop_hist_capped20': dict(sorted(repeat_dist.items())),
}
for kind in ('main', 'sub'):
    c = S['unchanged_chars_' + kind]
    out['est_tokens_unchanged_' + kind] = round(c / cpt)
    out['est_tokens_unchanged_le60_' + kind] = round(S['unchanged_le60_chars_' + kind] / cpt)
    out['est_tokens_all_reads_' + kind] = round(S['read_chars_' + kind] / cpt)
for kind in ('main', 'sub'):
    out['est_tokens_unchanged_text_' + kind] = round(S['unchanged_text_chars_' + kind] / cpt)
    out['est_tokens_unchanged_text_le60_' + kind] = round(S['unchanged_text_le60_chars_' + kind] / cpt)
out['unchanged_text_sizes'] = sorted(textsizes)
out['days'] = [min(days), max(days), len(days)] if days else None
out['est_tokens_bash_unchanged'] = round((S['bash_unchanged_chars_main'] + S['bash_unchanged_chars_sub']) / cpt)
out['est_tokens_bash_filedump_unchanged'] = round(S['bash_unchanged_filedump_chars'] / cpt)
out['est_tokens_covered'] = round((S['covered_chars_main'] + S['covered_chars_sub']) / cpt)
print(json.dumps(out, indent=1))
```
