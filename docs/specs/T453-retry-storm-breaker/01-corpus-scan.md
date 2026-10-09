# T453 — Corpus scan: how often retry storms happen on this machine

**Part of:** [`00-spec.md`](00-spec.md) §4 (U-2) · **Scanned:** 2026-10-09T16:31-03:00 · **Machine:**
the operator's workstation

This file is the measurement behind every threshold in the spec. It gives the method, the corpus,
the counts, the labelled false-positive rates, scrubbed examples and the scanner's source, so the
scan can be re-run and checked.

## 1. Method

1. **Corpus.** Every `*.jsonl` under `~/.claude/projects/` (main transcripts and the
   `subagents/` transcripts beside them). The scan is read-only.
2. **Calls.** Each `tool_use` block is joined to the `tool_result` that names its id. A call is
   _failed_ when its result carries `is_error: true`. Ids are de-duplicated across the whole
   corpus, because `--fork-session` and resumes copy history into new files.
3. **Loops.** A loop is one conversation: a transcript file's main rows, or its `isSidechain`
   rows, or one subagent transcript. Counting never crosses a loop, which is the rule the mod
   applies in-session (`agentId`, `00-spec.md` §3.1).
4. **Signatures.** Each call gets an input signature (per-tool normalisation, `00-spec.md` §3.2)
   and each failure gets an error signature (volatile tokens folded, §3.3).
5. **Runs.** A run is a sequence of failures in one loop that share a key, inside a window of 20
   calls and 10 minutes from the previous member. It resets on a success of the same signature
   and, for Bash entries, on a successful `Edit`/`Write`/`MultiEdit`/`NotebookEdit`. Two keys are
   measured:
   - **exact**: same input signature and same error signature;
   - **same-error**: same tool and same error signature, input free.
6. **Exclusions.** Runs whose error is a permission-layer or person outcome are dropped before
   counting (rules X1–X4 of `00-spec.md` §3.4).
7. **Labels.** Every run of length ≥ 2 that survived exclusion (62 exact, 121 same-error) was
   labelled `storm` or `legit` by the rubric in §5, applied by regex over the first error's text
   and then reviewed by hand. No run was left unlabelled.
8. **False-positive rate** at threshold _k_ = legit runs of length ≥ _k_ ÷ all runs of length ≥ _k_.

The rubric is one rater's judgement (this spec's author), regex-assisted. That is a limitation: a
second rater was not available. The rubric is printed in §5 so a reviewer can disagree with a
specific group rather than with the totals.

## 2. Corpus

| Measure                                | Count                   |
| -------------------------------------- | ----------------------- |
| Transcript files                       | 12,184                  |
| Loops                                  | 2,886                   |
| Tool calls (distinct `tool_use` ids)   | 112,674                 |
| Failed calls (`is_error: true`)        | 4,030                   |
| Calls with no result (session ended)   | 80                      |
| Files by month: 2026-07 / 08 / 09 / 10 | 98 / 18 / 7,093 / 4,954 |

A cross-check with a plain `rg -o` over the same tree found 112,073 distinct `tool_use` ids a few
minutes earlier; the live sessions running during the scan account for the difference.

The scanner's first-pass error classes over all 4,030 failures (§7 `classify`; the prototype's
classifier is close but not identical):

| Class        | Count | Class         | Count |
| ------------ | ----- | ------------- | ----- |
| exit-nonzero | 2,237 | invalid-input | 231   |
| other        | 866   | rule-denied   | 153   |
| not-found    | 258   | user-denied   | 111   |
| timeout      | 91    | edit-mismatch | 32    |
| read-first   | 14    | hook-denied   | 32    |
| interrupted  | 5     |               |       |

## 3. Results

### 3.1 Run lengths

After exclusions (X1–X4):

| Run length | exact | same-error |
| ---------- | ----- | ---------- |
| 2          | 39    | 81         |
| 3          | 17    | 27         |
| 4          | 6     | 10         |
| 5          | 0     | 2          |
| 6          | 0     | 1          |
| ≥ 7        | 0     | 0          |

The longest exact run in 112,674 calls is **4**; the longest same-error run is **6**.

Context, before exclusions: plain consecutive failures in a loop, any signature, give runs of
2: 259 · 3: 48 · 4: 18 · 5: 3 · 6: 2 · 8: 1. Strictly consecutive identical failures (nothing in
between) give 2: 17 · 3: 10 · 4: 3.

### 3.2 Window sensitivity

Exact runs before exclusions, by window (length 2 / 3 / 4):

| Window                               | 2   | 3   | 4   |
| ------------------------------------ | --- | --- | --- |
| 10 calls / 5 min, mutation reset     | 43  | 18  | 6   |
| 20 calls / 10 min, mutation reset    | 44  | 18  | 6   |
| 50 calls / 30 min, mutation reset    | 44  | 18  | 6   |
| 20 calls / 10 min, no mutation reset | 46  | 18  | 6   |

The window barely matters: storms are fast. The spec takes 20 calls / 10 minutes.

### 3.3 Timing

Gaps between repeats inside exact runs of length ≥ 3 (n = 54 gaps): p10 2.4 s, **p50 3.8 s**,
p90 15.1 s, p99 54.8 s. One real storm (expired credentials, §6 E2) had gaps of 119 s and 55 s,
so a "repeats far apart are polling" rule would have missed it; the spec does not use time to
exclude (`00-spec.md` §3.4 X5 uses the command instead).

### 3.4 Thresholds and false-positive rates

A trip is a run reaching the threshold. Excluded runs are not trips.

| Rule       | k   | Trips | Storm | Legit | FP rate |
| ---------- | --- | ----- | ----- | ----- | ------- |
| exact      | 2   | 62    | 54    | 8     | 12.9 %  |
| exact      | 3   | 23    | 23    | 0     | 0 %     |
| exact      | 4   | 6     | 6     | 0     | 0 %     |
| exact      | 5   | 0     | 0     | 0     | n/a     |
| same-error | 2   | 121   | 85    | 36    | 29.8 %  |
| same-error | 3   | 40    | 35    | 5     | 12.5 %  |
| same-error | 4   | 13    | 13    | 0     | 0 %     |
| same-error | 5   | 3     | 3     | 0     | 0 %     |
| same-error | 6   | 1     | 1     | 0     | 0 %     |

**What the spec takes:** the notice at exact 3 and same-error 4 (the lowest thresholds with no
false positive), the dialog and Harnu escalation at exact 4 and same-error 5, a refusal of the 5th
identical attempt (never reached in this corpus) and an abort cap after two refused repeats (not
measurable here, `00-spec.md` §5.1).

### 3.5 Where the storms are

- Exact runs ≥ 3: **23** (in 20 transcripts). 21 are `SendMessage` and 2 are `Bash`.
- Same-error runs ≥ 3: 40 (in 33 transcripts): SendMessage 21, Bash 8, MCP tools 5, Agent 3,
  Read 2, TaskOutput 1.
- In subagent loops: 3 of 62 exact runs ≥ 2, and 14 of 121 same-error runs ≥ 2.

### 3.6 What a breaker could have saved here

Calls made after the notice threshold, the most a perfectly obeyed notice could have prevented:

- exact rule, notice at 3: **6 calls**;
- same-error rule, notice at 4: **4 calls** (17 at k = 3).

Against 112,674 calls, that is noise. **The ideation premise, "loops are the single biggest waste
of tokens and wall-clock in unattended runs", is not supported by this corpus.** Storms here are
rare (23 exact runs ≥ 3 in 2,886 loops), short (never past 4 exact or 6 same-error) and fast
(median 3.8 s apart). The spec draws the consequence in `00-spec.md` §0 and OQ-1.

## 4. Live check of the definition

The live runs in [`03-prototype-tests.md`](03-prototype-tests.md) §3 found one class this scan's
first-pass classifier counted wrongly: a headless `ask` that nobody can answer comes back as the
error text `This command requires approval`. It is a permission outcome (X3), not a failure. Two
corpus groups also needed a rule rather than a label: CI polling (X5) and the auto-mode
classifier's transient no-verdict (X3).

## 5. Labelling rubric

A run is a **storm** when the error says the call cannot succeed as made and the model repeated it
without changing what the error names. It is **legit** when repetition was reasonable: polling,
exploring different targets that legitimately miss, or a transient fault. Groups, by the first
error's text (counts are runs of length ≥ 2):

| Group (error text, scrubbed)                                                                                                            | Rule seen in      | Label         |
| --------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------------- |
| `SendMessage was called with input that could not be parsed as JSON`                                                                    | exact, same-error | storm         |
| `Exit code 255 … Token has expired and refresh failed`                                                                                  | exact, same-error | storm         |
| `The working-directory isolation context for this agent was lost`                                                                       | exact, same-error | storm         |
| `This agent/session is isolated in the worktree …, but this command …`                                                                  | exact, same-error | storm         |
| `File content (N tokens) exceeds maximum allowed tokens`                                                                                | exact             | storm         |
| `No changes to make: old_string and new_string are exactly the same`                                                                    | exact, same-error | storm         |
| `PANE_FOLDER_UNKNOWN`, `RECIPIENT_NOT_…_SPAWNED`, `NOT_FOUND: card not found`, `PARENT_NOT_FOUND`                                       | both              | storm         |
| `Browser is already in use`, `Cannot access a chrome-extension URL`                                                                     | exact, same-error | storm         |
| `Agent type '…' not found`, `Concurrent subagent limit reached … Do not retry`, `Failed to create teammate pane`                        | same-error        | storm         |
| `No such tool available`, `Fork is not available inside a forked worker`, `No task found with ID`, `is not running (status: completed)` | same-error        | storm         |
| `rtk find does not support compound predicates`, `Unknown JSON field`, `Invalid arguments for tool …`                                   | same-error        | storm         |
| `outside allowed roots` (browser file access)                                                                                           | same-error        | storm         |
| `Exit code 8 … pending` (`gh pr checks` while CI runs)                                                                                  | exact             | legit         |
| bare `Exit code N`, `N matches for '…'`, `(eval):N: … not found`, `Exit code 144`                                                       | same-error, exact | legit         |
| `Error capturing screenshot … timed out`, `Script injection timed out`, `Runtime.evaluate timed out`                                    | exact, same-error | legit         |
| `Target page, context or browser has been closed`                                                                                       | exact, same-error | legit         |
| `TypeError: Cannot read properties of …` (different scripts)                                                                            | same-error        | legit         |
| `SESSION_NOT_FOUND`, `File does not exist` (different paths), `Requested entity was not found`                                          | same-error        | legit         |
| `File has been modified since read`                                                                                                     | same-error        | legit         |
| `auto mode classifier gave no verdict`, `rate-limited), so auto mode …`                                                                 | both              | excluded (X3) |
| `requested permissions to … but you haven't granted`                                                                                    | same-error        | excluded (X3) |
| `[Tool call interrupted: the session ended …]`                                                                                          | same-error        | excluded (X2) |

## 6. Scrubbed examples

Paths, profile names, executor names and ids are replaced by placeholders. Timing is real.

**E1 — a systemic storm, exact rule, 4 calls, gaps 2 s, 3 s, 5 s.** The orchestrator subscribes to
a peer going idle and emits invalid JSON each time:

```text
SendMessage  {"to": "<executor-name>", "notify_when_idle": true, "summary": "subscribe to spec session idle", "message": }
→ <tool_use_error>InputValidationError: SendMessage was called with input that could not be parsed as JSON. You sent (first 117 of 117 bytes): …
```

This one cause is 21 of the 23 exact storms ≥ 3 and 39 of the 62 exact runs ≥ 2. It matches the
guidance in `docs/harnu-features.md:347` ("subscribe with `SendMessage { to: <name>,
notify_when_idle: true }` and no message"): the model writes the empty `message` as `"message": }`.
See `00-spec.md` §15 F-1.

**E2 — needs a human, exact rule, 3 calls, gaps 119 s, 55 s.**

```text
Bash  export AWS_PROFILE=<profile>; aws sts get-caller-identity 2>&1
→ Exit code 255
  aws: [ERROR]: Error when retrieving token from sso: Token has expired and refresh failed
```

No retry fixes an expired login. In an unattended run this is the case the Harnu escalation exists
for.

**E3 — systemic, exact rule, 3 calls in a subagent, gaps 6 s, 6 s.**

```text
Bash  pwd && git branch --show-current && git rev-parse --show-toplevel .
→ The working-directory isolation context for this agent was lost, so this command would run in the parent session's directory instead of this agent's worktree (<worktree>) …
```

**E4 — same error, different inputs, same-error rule, 5 calls, gaps 2 s each.**

```text
Agent  {subagent_type: "general-purpose", prompt: "<task 1..5>", …}
→ Concurrent subagent limit reached. You can run 20 subagents at once. Do not retry. …
```

**F1 — a false positive at k = 2 that rule X5 removes: CI polling, 2 calls, gap 25 s.**

```text
Bash  cat <task-output-file> 2>/dev/null; gh pr checks <n> 2>&1
→ Exit code 8
  e2e     pending  0  https://github.com/<owner>/<repo>/actions/runs/<id>/job/<id>
  verify  pending  0  https://github.com/<owner>/<repo>/actions/runs/<id>/job/<id>
```

**F2 — transient, excluded by X3.**

```text
mcp__<server>__<tool>  {…}
→ The server-side auto mode classifier gave no verdict (error), so auto mode cannot determine the safety of mcp__<server>__<tool>. This is a transient failure …
```

## 7. Scanner source

Run as `node extract.mjs ~/.claude/projects > calls.ndjson`, then the two analysis scripts over
`calls.ndjson`. Node 22, no dependencies. The scanner's per-tool signatures are the spec's §3.2
table with two differences kept for the record: `Agent` uses the whole input (the prototype keys
on `subagent_type` and `isolation`), and `MultiEdit` is still handled.

### `extract.mjs`

Pass 1: one record per call, in loop order.

```js
// Pass 1: walk ~/.claude/projects/**/*.jsonl and emit one compact record per
// tool call (tool_use joined with its tool_result), in loop order.
// Output: NDJSON to stdout: {loop, i, ts, tool, sig, ok, cls, err, raw}
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import crypto from 'node:crypto'

const ROOT = process.argv[2]
const seenUse = new Set() // global tool_use_id dedupe (forks copy history)

function* walk(d) {
  for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, ent.name)
    if (ent.isDirectory()) yield* walk(p)
    else if (ent.name.endsWith('.jsonl')) yield p
  }
}

const h = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12)
const canon = (v) =>
  v && typeof v === 'object'
    ? Array.isArray(v)
      ? '[' + v.map(canon).join(',') + ']'
      : '{' +
        Object.keys(v)
          .sort()
          .map((k) => JSON.stringify(k) + ':' + canon(v[k]))
          .join(',') +
        '}'
    : JSON.stringify(v)

// Input normalization per tool (the proposed definition, spec §3.1).
export function callSig(tool, input) {
  input = input || {}
  switch (tool) {
    case 'Bash':
      return (
        'Bash:' +
        h(
          String(input.command ?? '')
            .replace(/\s+/g, ' ')
            .trim()
        )
      )
    case 'Edit':
      return 'Edit:' + h(String(input.file_path) + '\0' + String(input.old_string ?? ''))
    case 'MultiEdit':
      return (
        'MultiEdit:' +
        h(String(input.file_path) + '\0' + canon((input.edits || []).map((e) => e.old_string)))
      )
    case 'Read':
      return (
        'Read:' +
        h(
          String(input.file_path) +
            '\0' +
            String(input.offset ?? '') +
            '\0' +
            String(input.limit ?? '')
        )
      )
    case 'Write':
      return 'Write:' + h(String(input.file_path))
    case 'NotebookEdit':
      return 'NotebookEdit:' + h(String(input.notebook_path) + '\0' + String(input.cell_id ?? ''))
    case 'Grep':
    case 'Glob':
      return tool + ':' + h(String(input.pattern) + '\0' + String(input.path ?? ''))
    default: {
      const rest = { ...input }
      delete rest.description
      return tool + ':' + h(canon(rest))
    }
  }
}

function resultText(c) {
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map((b) => (b && b.type === 'text' ? b.text : '')).join('\n')
  return ''
}

// Error classes (spec §3.2). Order matters.
export function classify(text) {
  const t = text.slice(0, 2000)
  if (
    /doesn't want to proceed|user (denied|rejected)|tool use was rejected|The user doesn't want/i.test(
      t
    )
  )
    return 'user-denied'
  if (/^\[Request interrupted|Interrupted by user|interrupted by the user/i.test(t))
    return 'interrupted'
  if (
    /hook (error|blocked)|blocked by (a )?hook|PreToolUse:.*(denied|blocked)|Hook PreToolUse/i.test(
      t
    )
  )
    return 'hook-denied'
  if (
    /Permission to use .* has been denied|permission.*denied by|denied by (your )?permission/i.test(
      t
    )
  )
    return 'rule-denied'
  if (
    /InputValidationError|invalid_type|Required parameter|<tool_use_error>.*(Invalid|validation)/i.test(
      t
    )
  )
    return 'invalid-input'
  if (
    /String to replace not found|old_string.*not found|Found \d+ matches of the string to replace/i.test(
      t
    )
  )
    return 'edit-mismatch'
  if (/File has not been read yet|must read .* before/i.test(t)) return 'read-first'
  if (/does not exist|ENOENT|No such file or directory|File not found/i.test(t)) return 'not-found'
  if (/timed out|timeout|Command timed out/i.test(t)) return 'timeout'
  if (/Exit code \d+/i.test(t)) return 'exit-nonzero'
  return 'other'
}

// Error normalization: what "the same error" compares (spec §3.2).
export function errSig(text) {
  return h(
    text
      .slice(0, 4000)
      .replace(/<\/?tool_use_error>/g, '')
      .replace(/\b[0-9a-f]{7,40}\b/gi, 'H')
      .replace(/\d+(\.\d+)?/g, 'N')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 600)
  )
}

async function scanFile(file, out) {
  const loop = file.slice(ROOT.length + 1)
  const pending = new Map() // tool_use_id -> record
  const order = []
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line.includes('"tool_use"') && !line.includes('"tool_result"')) continue
    let o
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    const c = o?.message?.content
    if (!Array.isArray(c)) continue
    const side = o.isSidechain ? 'side' : 'main'
    for (const b of c) {
      if (b?.type === 'tool_use') {
        if (seenUse.has(b.id)) continue
        seenUse.add(b.id)
        const r = {
          loop: loop + '#' + side,
          ts: o.timestamp,
          tool: b.name,
          sig: callSig(b.name, b.input),
          ok: null
        }
        pending.set(b.id, r)
        order.push(r)
      } else if (b?.type === 'tool_result') {
        const r = pending.get(b.tool_use_id)
        if (!r || r.ok !== null) continue
        const text = resultText(b.content)
        r.ok = !b.is_error
        r.rts = o.timestamp
        if (b.is_error) {
          r.cls = classify(text)
          r.err = errSig(text)
          r.raw = text.slice(0, 300)
        }
      }
    }
  }
  for (const r of order) out.write(JSON.stringify(r) + '\n')
  return order.length
}

if (process.argv[1].endsWith('extract.mjs')) {
  let files = 0,
    calls = 0
  for (const f of walk(ROOT)) {
    files++
    calls += await scanFile(f, process.stdout)
  }
  process.stderr.write(JSON.stringify({ files, calls }) + '\n')
}
```

### `groups.mjs`

Runs under the exact and same-error keys (§3.1, §3.5); writes the runs for labelling.

```js
import fs from 'node:fs'
const rows = fs
  .readFileSync('calls.ndjson', 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l))
const byLoop = new Map()
for (const r of rows) {
  if (!byLoop.has(r.loop)) byLoop.set(r.loop, [])
  byLoop.get(r.loop).push(r)
}
const COUNTABLE = new Set([
  'invalid-input',
  'edit-mismatch',
  'read-first',
  'not-found',
  'timeout',
  'exit-nonzero',
  'other'
])
const t = (s) => Date.parse(s)
function runs(keyOf) {
  const out = []
  for (const [loop, calls] of byLoop) {
    const open = new Map()
    calls.forEach((c, i) => {
      if (c.ok === true) {
        for (const [k, r] of open)
          if (r.tool === c.tool && (keyOf.loose || k.startsWith(c.sig))) {
            out.push(r)
            open.delete(k)
          }
      }
      for (const [k, r] of open) {
        const l = r.calls.at(-1)
        if (i - l.i > 20 || t(c.ts) - t(l.ts) > 600e3) {
          out.push(r)
          open.delete(k)
        }
      }
      if (c.ok === false && COUNTABLE.has(c.cls)) {
        const k = keyOf(c)
        const r = open.get(k)
        if (r) r.calls.push({ ...c, i })
        else open.set(k, { loop, tool: c.tool, calls: [{ ...c, i }] })
      }
    })
    for (const r of open.values()) out.push(r)
  }
  return out.filter((r) => r.calls.length >= 2)
}
const exact = runs((c) => c.sig + '|' + c.err)
const lk = (c) => c.tool + '|' + c.err
lk.loose = true
const loose = runs(lk)
const norm = (s) =>
  (s || '')
    .replace(/\s+/g, ' ')
    .replace(/\/[\w.\/-]+/g, '<p>')
    .replace(/\d+/g, 'N')
    .slice(0, 70)
for (const [name, rs] of [
  ['exact', exact],
  ['loose', loose]
]) {
  const g = {}
  for (const r of rs) {
    const k =
      (r.tool.startsWith('mcp__') ? 'mcp:' + r.tool.split('__')[2] : r.tool) +
      ' :: ' +
      norm(r.calls[0].raw)
    g[k] ??= { n: 0, len: [], div: [] }
    g[k].n++
    g[k].len.push(r.calls.length)
    g[k].div.push(new Set(r.calls.map((c) => c.sig)).size)
  }
  console.log('=== ' + name + ' runs>=2: ' + rs.length)
  for (const [k, v] of Object.entries(g).sort((a, b) => b[1].n - a[1].n))
    console.log(v.n, 'len=' + v.len.join(','), 'inputs=' + v.div.join(','), k)
}
fs.writeFileSync('exact2.json', JSON.stringify(exact))
fs.writeFileSync('loose2.json', JSON.stringify(loose))
```

### `label.mjs`

Labels (§5) and the false-positive table (§3.4).

```js
import fs from 'node:fs'
const EXCLUDE =
  /auto mode cannot determine|rate-limited\), so auto|requested permissions to .* but you haven't granted|doesn't want to proceed|\[Tool call interrupted/
const STORM =
  /could not be parsed as JSON|exceeds maximum allowed tokens|Token has expired|isolation context for this agent was lost|is isolated in the worktree|Agent type '.*' not found|Concurrent subagent limit|Failed to create teammate pane|PANE_FOLDER_UNKNOWN|No changes to make|Browser is already in use|RECIPIENT_NOT_\w+_SPAWNED|No such tool available|Fork is not available inside a forked worker|does not support compound predicates|Unknown JSON field|No task found with ID|is not running \(status|outside allowed roots|PARENT_NOT_FOUND|NOT_FOUND: card not found|Invalid arguments for tool|Cannot access a chrome-extension/
const LEGIT =
  /^Exit code \d+\s*$|matches for '|=== not found|pending\s+\d|captureScreenshot|Script injection timed out|TypeError: Cannot read|Target page, context or browser has been closed|SESSION_NOT_FOUND|File does not exist|Requested entity was not found|Runtime\.evaluate" timed|modified since read|^\[computer:|^Exit code 144/
export function label(raw) {
  const s = (raw || '').trim()
  if (EXCLUDE.test(s)) return 'excluded'
  if (STORM.test(s)) return 'storm'
  if (LEGIT.test(s)) return 'legit'
  return 'UNLABELED'
}
const out = {}
for (const name of ['exact2', 'loose2']) {
  const runs = JSON.parse(fs.readFileSync(name + '.json', 'utf8'))
  const unl = new Set()
  out[name] = {}
  for (const k of [2, 3, 4, 5]) {
    const trips = runs.filter((r) => r.calls.length >= k).map((r) => label(r.calls[0].raw))
    const c = { storm: 0, legit: 0, excluded: 0, UNLABELED: 0 }
    trips.forEach((x) => c[x]++)
    const counted = c.storm + c.legit + c.UNLABELED
    out[name]['k' + k] = {
      ...c,
      trips: counted,
      fpRate: counted ? +(c.legit / counted).toFixed(3) : null
    }
  }
  runs.forEach((r) => {
    if (label(r.calls[0].raw) === 'UNLABELED')
      unl.add(r.tool + ' :: ' + (r.calls[0].raw || '').replace(/\s+/g, ' ').slice(0, 140))
  })
  out[name].unlabeled = [...unl]
  // after exclusions, hist
  const h = {}
  runs
    .filter((r) => label(r.calls[0].raw) !== 'excluded')
    .forEach((r) => {
      const n = r.calls.length
      h[n] = (h[n] || 0) + 1
    })
  out[name].histAfterExclusions = h
}
console.log(JSON.stringify(out, null, 1))
```

### `analyze.mjs`

Window variants (§3.2), gaps (§3.3), per-tool counts.

```js
// Pass 2: runs of identical failing calls under several definitions.
import fs from 'node:fs'

const rows = fs
  .readFileSync(process.argv[2], 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l))
const byLoop = new Map()
for (const r of rows) {
  if (!byLoop.has(r.loop)) byLoop.set(r.loop, [])
  byLoop.get(r.loop).push(r)
}
const COUNTABLE = new Set([
  'invalid-input',
  'edit-mismatch',
  'read-first',
  'not-found',
  'timeout',
  'exit-nonzero',
  'other'
])
const MUTATING = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const t = (s) => (s ? Date.parse(s) : NaN)

const out = { corpus: {}, classes: {}, strict: {}, windowed: {} }
out.corpus.loops = byLoop.size
out.corpus.calls = rows.length
out.corpus.failed = rows.filter((r) => r.ok === false).length
out.corpus.unanswered = rows.filter((r) => r.ok === null).length
for (const r of rows) if (r.ok === false) out.classes[r.cls] = (out.classes[r.cls] || 0) + 1

// Strict: consecutive calls, same sig, all failing with same (cls, err).
const strictRuns = []
for (const [loop, calls] of byLoop) {
  let run = null
  for (const c of calls) {
    const key = c.ok === false && COUNTABLE.has(c.cls) ? c.sig + '|' + c.err : null
    if (key && run && run.key === key) run.calls.push(c)
    else {
      if (run && run.calls.length >= 2) strictRuns.push(run)
      run = key ? { loop, key, calls: [c] } : null
    }
  }
  if (run && run.calls.length >= 2) strictRuns.push(run)
}

// Windowed (proposed): same (sig, err) within the last W calls of the loop and
// T ms; reset by a success of the same sig, or (for Bash) by a successful
// mutating call, or by a user prompt boundary (not visible here, see note).
function windowed(W, T, resetOnMutation) {
  const runs = []
  for (const [loop, calls] of byLoop) {
    const open = new Map() // key -> run
    calls.forEach((c, i) => {
      if (c.ok === true) {
        for (const [k, r] of open) {
          if (k.startsWith(c.sig + '|')) {
            runs.push(r)
            open.delete(k)
          } else if (resetOnMutation && MUTATING.has(c.tool) && r.tool === 'Bash') {
            runs.push(r)
            open.delete(k)
          }
        }
      }
      // expire
      for (const [k, r] of open) {
        const last = r.calls[r.calls.length - 1]
        if (i - last.i > W || t(c.ts) - t(last.ts) > T) {
          runs.push(r)
          open.delete(k)
        }
      }
      if (c.ok === false && COUNTABLE.has(c.cls)) {
        const k = c.sig + '|' + c.err
        const r = open.get(k)
        if (r) r.calls.push({ ...c, i })
        else open.set(k, { loop, key: k, tool: c.tool, calls: [{ ...c, i }] })
      }
    })
    for (const r of open.values()) runs.push(r)
  }
  return runs.filter((r) => r.calls.length >= 2)
}

const hist = (runs) => {
  const hgram = {}
  for (const r of runs) {
    const n = Math.min(r.calls.length, 10)
    hgram[n === 10 ? '10+' : n] = (hgram[n === 10 ? '10+' : n] || 0) + 1
  }
  return hgram
}
out.strict.hist = hist(strictRuns)
const variants = {
  'W10-5m-mut': windowed(10, 5 * 60e3, true),
  'W20-10m-mut': windowed(20, 10 * 60e3, true),
  'W20-10m-nomut': windowed(20, 10 * 60e3, false),
  'W50-30m-mut': windowed(50, 30 * 60e3, true)
}
for (const [k, runs] of Object.entries(variants)) out.windowed[k] = hist(runs)

// Per-tool for the chosen variant
const chosen = variants['W20-10m-mut']
const perTool = {}
for (const r of chosen) {
  const k = r.tool.startsWith('mcp__') ? 'mcp__*' : r.tool
  perTool[k] ??= { runs2: 0, runs3: 0, runs5: 0 }
  perTool[k].runs2++
  if (r.calls.length >= 3) perTool[k].runs3++
  if (r.calls.length >= 5) perTool[k].runs5++
}
out.perToolW20 = perTool
// gaps between consecutive repeats in runs >= 3
const gaps = []
for (const r of chosen)
  if (r.calls.length >= 3)
    for (let j = 1; j < r.calls.length; j++)
      gaps.push((t(r.calls[j].ts) - t(r.calls[j - 1].ts)) / 1000)
gaps.sort((a, b) => a - b)
const q = (p) => gaps[Math.floor(p * (gaps.length - 1))]
out.gapSecondsRuns3 = { n: gaps.length, p10: q(0.1), p50: q(0.5), p90: q(0.9), p99: q(0.99) }
// wasted calls: calls beyond the 2nd in each run (what a k=3 breaker could save at best)
let wasted3 = 0
for (const r of chosen) if (r.calls.length >= 3) wasted3 += r.calls.length - 2
out.callsAfterSecondRepeat = wasted3
fs.writeFileSync(process.argv[3], JSON.stringify(chosen.filter((r) => r.calls.length >= 3)))
console.log(JSON.stringify(out, null, 1))
```

### `loose.mjs`

Plain consecutive failures and the coarser keys (§3.1, context).

```js
import fs from 'node:fs'
const rows = fs
  .readFileSync(process.argv[2], 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l))
const byLoop = new Map()
for (const r of rows) {
  if (!byLoop.has(r.loop)) byLoop.set(r.loop, [])
  byLoop.get(r.loop).push(r)
}
const COUNTABLE = new Set([
  'invalid-input',
  'edit-mismatch',
  'read-first',
  'not-found',
  'timeout',
  'exit-nonzero',
  'other'
])
const t = (s) => Date.parse(s)
// (a) loose key: tool + errSig, input ignored; window 20 calls / 10 min; reset on any success of the same tool
function loose(keyOf) {
  const runs = []
  for (const [loop, calls] of byLoop) {
    const open = new Map()
    calls.forEach((c, i) => {
      if (c.ok === true) {
        for (const [k, r] of open)
          if (r.tool === c.tool) {
            runs.push(r)
            open.delete(k)
          }
      }
      for (const [k, r] of open) {
        const l = r.calls.at(-1)
        if (i - l.i > 20 || t(c.ts) - t(l.ts) > 600e3) {
          runs.push(r)
          open.delete(k)
        }
      }
      if (c.ok === false && COUNTABLE.has(c.cls)) {
        const k = keyOf(c)
        const r = open.get(k)
        if (r) r.calls.push({ ...c, i })
        else open.set(k, { loop, tool: c.tool, calls: [{ ...c, i }] })
      }
    })
    for (const r of open.values()) runs.push(r)
  }
  return runs.filter((r) => r.calls.length >= 2)
}
const hist = (runs) => {
  const h = {}
  for (const r of runs) {
    const n = r.calls.length >= 10 ? '10+' : r.calls.length
    h[n] = (h[n] || 0) + 1
  }
  return h
}
const a = loose((c) => c.tool + '|' + c.err)
const b = loose((c) => c.tool + '|' + c.cls)
console.log('tool+errSig', JSON.stringify(hist(a)))
console.log('tool+class', JSON.stringify(hist(b)))
// (c) plain failure streaks: consecutive failed calls, any signature
const st = {}
for (const calls of byLoop.values()) {
  let n = 0
  for (const c of calls) {
    if (c.ok === false && COUNTABLE.has(c.cls)) n++
    else {
      if (n >= 2) {
        const k = n >= 10 ? '10+' : n
        st[k] = (st[k] || 0) + 1
      }
      n = 0
    }
  }
  if (n >= 2) {
    const k = n >= 10 ? '10+' : n
    st[k] = (st[k] || 0) + 1
  }
}
console.log('consecutive-any', JSON.stringify(st))
fs.writeFileSync('loose3.json', JSON.stringify(a.filter((r) => r.calls.length >= 3)))
// distinct sigs within loose runs >=3 -> how many are exact repeats
for (const r of a.filter((r) => r.calls.length >= 3)) {
  const d = new Set(r.calls.map((c) => c.sig)).size
  const c = r.calls
  const g = c.slice(1).map((x, j) => ((t(x.ts) - t(c[j].ts)) / 1000).toFixed(0))
  console.log(
    r.tool,
    'x' + c.length,
    'distinctInputs=' + d,
    c[0].cls,
    'gaps=' + g.join(','),
    '|',
    (c[0].raw || '').replace(/\s+/g, ' ').slice(0, 120)
  )
}
```
