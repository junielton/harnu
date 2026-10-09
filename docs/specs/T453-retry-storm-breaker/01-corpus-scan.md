# T453 — Corpus scan: how often retry storms happen on this machine

**Part of:** [`00-spec.md`](00-spec.md) §4 (U-2) · **Scanned:** 2026-10-09T17:22-03:00 (round 2) ·
**Machine:** the operator's workstation

This file is the measurement behind every threshold in the spec: the method, the corpus, the
counts, the labelled false-positive rates with their uncertainty, scrubbed examples, and the
scanner's source, so the scan can be re-run and checked.

**Round 2 replaces round 1.** Round 1 (commit `1f08dc2`) used a scanner with its own copy of the
rules. Round 2 replays every transcript through the prototype's own `hooks/core.ts`
([`04-detector-core.md`](04-detector-core.md)), so what is measured is exactly what the mod would
do. It also applies the round-2 rules (structural polling, server waits, any possibly-mutating
success resets, more permission texts) and skips the probe sessions this spec ran (§1). The two
rounds disagree where the rules changed; §7 lists what moved.

## 1. Method

1. **Corpus.** Every `*.jsonl` under `~/.claude/projects/` (main transcripts and the `subagents/`
   transcripts beside them). Read-only. **Skipped:** every project directory whose slug starts with
   `-tmp-` (a session whose working directory was under `/tmp`), which is where this spec's live
   probes, the T389 smoke repos and other verifiers' throwaway repos ran: 253 files.
2. **Replay.** Each file is read in order. A `tool_use` is remembered by id; when its
   `tool_result` arrives, the call is ticked into its loop and passed to `core.ts`: a success to
   `recordSuccess`, a failure to `exclusion` and then `recordFailure`. This is the same sequence
   the mod's two `session.append` hooks run (`02-prototype.md` §5). Ids are de-duplicated across
   the corpus, because `--fork-session` and resumes copy history into new files.
3. **Loops.** A transcript file's main rows, its `isSidechain` rows, or one subagent transcript.
4. **Runs.** A run is one ledger entry from creation to its last failure: identity `(loop, key,
since)`, length = its final count. The two keys are `exact` (same input and error signatures) and
   `same-error` (same tool and error signature).
5. **What the scan cannot see.** The mod also excludes a call by its `tool.check` verdict (X3) and
   by its own refusals (X4). The transcript does not record verdicts, so the scan relies on X3's
   text rules alone. It therefore counts at least as many failures as the mod would, never fewer.
6. **Labels.** Every run of length ≥ 2 is labelled `storm`, `legit` or `unknown` by the rubric in
   §5, applied by regex over the run's first error text. `unknown` is reported, never counted as a
   storm: the false-positive rate is legit ÷ (storm + legit).
7. **Uncertainty.** Beside every rate, a one-sided 95 % upper bound (Clopper-Pearson). With 0 false
   positives in _n_ trips that bound is about 3/_n_ (the rule of three).

**Two limits.** The labels are one rater's (this spec's author), regex-assisted. And **at k ≥ 3 the
exact-rule labels are close to tautological**: the rubric calls a run a storm when the error says the
call cannot succeed as made and the model repeated it unchanged. An exact run of three is that by
construction, unless it is polling or a transient fault, which the exclusions already remove. The
labels carry real information at k = 2 and for the same-error rule, where inputs differ.

## 2. Corpus

| Measure                                | Count   |
| -------------------------------------- | ------- |
| Transcript files scanned               | 12,049  |
| Probe files skipped (`-tmp-` projects) | 253     |
| Loops                                  | 2,795   |
| Tool calls (distinct `tool_use` ids)   | 114,475 |
| Failed calls (`is_error: true`)        | 4,008   |
| Not counted: permission layer (X3)     | 221     |
| Not counted: polling (X5)              | 332     |
| Not counted: the person refused (X1)   | 105     |
| Not counted: interrupted (X2)          | 22      |
| Not counted: waiting for a server (X7) | 1       |

The corpus is live: a re-run minutes later found 115,066 calls and one more same-error run of
length 2, and nothing else moved.

**What polling (X5) removed (332):** 290 `Bash` calls (a `sleep` command word 245, `gh pr checks`
43, `gh run view` 2) and 42 read-verb MCP calls answering "not found / not ready" (design-tool reads
20, Harnu's `get_session` returning `SESSION_NOT_FOUND` while a session spawns 17, others 5). A bare
`while`/`until` loop is not polling (`… | while read f`): the first replay counted it as polling and
excluded 9 such calls, so it was dropped from the rule.

## 3. Results

### 3.1 Run lengths

| Run length | exact | same-error |
| ---------- | ----- | ---------- |
| 2          | 19    | 47         |
| 3          | 13    | 19         |
| 4          | 4     | 5          |
| 5          | 2     | 2          |
| 6          | 0     | 1          |
| ≥ 7        | 0     | 0          |

The longest exact run in 114,475 calls is **5**; the longest same-error run is **6**.

### 3.2 Timing

Gaps between repeats inside exact runs of length ≥ 3 (n = 46): p10 2.2 s, **p50 3.3 s**, p90 6.5 s,
max 7.8 s. Storms are fast; no time rule is used.

### 3.3 Thresholds, false-positive rates and their bounds

A trip is a run reaching the threshold.

| Rule       | k   | Trips | Storm | Legit | Unknown | FP rate | FP upper bound (95 %) |
| ---------- | --- | ----- | ----- | ----- | ------- | ------- | --------------------- |
| exact      | 2   | 38    | 35    | 3     | 0       | 7.9 %   | 19.2 %                |
| exact      | 3   | 19    | 19    | 0     | 0       | 0 %     | **14.6 %**            |
| exact      | 4   | 6     | 6     | 0     | 0       | 0 %     | 39.3 %                |
| exact      | 5   | 2     | 2     | 0     | 0       | 0 %     | 77.6 %                |
| same-error | 2   | 74    | 61    | 13    | 0       | 17.6 %  | 26.5 %                |
| same-error | 3   | 27    | 26    | 1     | 0       | 3.7 %   | 16.4 %                |
| same-error | 4   | 8     | 8     | 0     | 0       | 0 %     | **31.2 %**            |
| same-error | 5   | 3     | 3     | 0     | 0       | 0 %     | 63.2 %                |
| same-error | 6   | 1     | 1     | 0     | 0       | 0 %     | 95.0 %                |

**Read this as:** no false positive was observed at the chosen thresholds, but the corpus is too
small to say more than "at most about 15 %" for the notice (exact 3) and "at most about 30–40 %" for
the dialog and the refusal. That is why every rung tells before it acts, and why the default level is
`notice` (`00-spec.md` §10.1).

### 3.4 Where the storms are

- Exact runs ≥ 3: **19**: `SendMessage` 16, `Agent` 3. Exact runs ≥ 4: 6 (`SendMessage` 3,
  `Agent` 3).
- `SendMessage` alone: 27 of 38 exact runs ≥ 2, 16 of 19 runs ≥ 3, 3 of 6 runs ≥ 4 (§6 E1).
- In subagent loops: 7 runs of length ≥ 2, either rule.

### 3.5 What a breaker could have saved

Calls made after a threshold, the most a perfectly obeyed notice there could have prevented:

| Notice at        | Calls after it |
| ---------------- | -------------- |
| exact 2          | 27             |
| **exact 3**      | **8**          |
| **same-error 4** | **4**          |

Round 1 reported "6 calls" and its script printed "30": the 6 was calls after the 3rd failure of
exact runs after exclusions, and the 30 was calls after the **2nd** failure of all exact runs before
exclusions. Round 2 reports both thresholds on one basis: 8 at exact 3, 27 at exact 2.

**Against 114,475 calls, that is noise.** The ideation premise, "loops are the single biggest waste
of tokens and wall-clock in unattended runs", is not supported by this corpus: storms are rare (19
exact runs ≥ 3 in 2,795 loops), short (never past 5 exact or 6 same-error) and fast (median 3.3 s).
Most of them have one engine-side cause (§6 E1). `00-spec.md` §0 and OQ-1 draw the consequence.

## 4. Live checks of the definition

The live runs in [`03-prototype-tests.md`](03-prototype-tests.md) §3 found what a text-only scan
could not: a headless `ask` comes back as `This command requires approval` (run 1), which X3 now
lists. The first round-2 replay found two more refusal texts the rules missed: the auto-mode
classifier's `Permission for this action was denied …` and a `PreToolUse:<Tool> hook error` from
Harnu's orchestrator guard. Both are X3 now.

## 5. Labelling rubric

A run is a **storm** when the error says the call cannot succeed as made and the model repeated it
without changing what the error names. It is **legit** when repetition was reasonable: exploring
different targets that legitimately miss, or a transient fault. Groups, by the run's first error
(scrubbed):

| Group (error text)                                                                                                              | Label |
| ------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `SendMessage was called with input that could not be parsed as JSON`                                                            | storm |
| `Concurrent subagent limit reached … Do not retry`, `Agent type '…' not found`, `Failed to create teammate pane`                | storm |
| `Token has expired and refresh failed`, `isolation context for this agent was lost`, `is isolated in the worktree …`            | storm |
| `File content (N tokens) exceeds maximum allowed tokens`, `No changes to make: old_string and new_string are exactly the same`  | storm |
| `PANE_FOLDER_UNKNOWN`, `RECIPIENT_NOT_…_SPAWNED`, `NOT_FOUND: card not found`, `PARENT_NOT_FOUND`                               | storm |
| `Browser is already in use`, `Cannot access a chrome-extension URL`, `outside allowed roots`                                    | storm |
| `No such tool available`, `Fork is not available inside a forked worker`, `No task found with ID`, `is not running (status: …)` | storm |
| `rtk find does not support compound predicates`, `Unknown JSON field`, `Invalid arguments for tool …`                           | storm |
| bare `Exit code N`, `N matches for '…'`, `(eval):N: … not found`, `Exit code 144`                                               | legit |
| `Error capturing screenshot … timed out`, `Script injection timed out`, `Runtime.evaluate timed out`, `browser has been closed` | legit |
| `TypeError: Cannot read properties of …` (different scripts), `File has been modified since read`                               | legit |
| `SESSION_NOT_FOUND`, `File does not exist` (different paths), `Requested entity was not found`                                  | legit |

## 6. Scrubbed examples

Paths, names and ids are placeholders. Timing is from the transcripts.

**E1 — the dominant cause, exact rule, 4 calls, gaps 2 s, 3 s, 5 s.** The orchestrator subscribes to
a peer going idle and sends invalid JSON each time:

```text
SendMessage  {"to": "<executor-name>", "notify_when_idle": true, "summary": "subscribe to spec session idle", "message": }
→ <tool_use_error>InputValidationError: SendMessage was called with input that could not be parsed as JSON. You sent (first 117 of 117 bytes): …
```

Across the whole corpus (not only runs) there are **146** such failures (distinct `tool_use` ids,
found in 50 transcript files counting fork copies), **all** with `notify_when_idle: true` and an
empty message: 53 written `"message": }` and 93 written `"message": ,`. The cause is in the engine,
not in any one prompt: the `SendMessage` tool's schema lists `message` as **required**, while the
same tool's description says "Omit `message` for a pure subscription" and its `notify_when_idle`
field says "Without a message (omit it)". `docs/harnu-features.md:347` only repeats that advice.
`00-spec.md` §15 F-1.

**E2 — "Do not retry", exact rule, 5 calls, gaps 3, 2, 2, 2 s.**

```text
Agent  {subagent_type: "general-purpose", prompt: "<task 1..5>", …}
→ Concurrent subagent limit reached. You can run 20 subagents at once. Do not retry. …
```

**E3 — an unknown agent type, exact rule, 5 calls, gaps 7, 7, 7, 6 s.**

```text
Agent  {subagent_type: "<plugin-agent-type>", prompt: "<review unit 1..5>", …}
→ Agent type '<plugin-agent-type>' not found. Available agents: claude, claude-code-guide, …
```

**E4 — same error, different inputs, same-error rule, 6 calls.**

```text
mcp__harnu__update_card  {folder: "<repo>", slug: "<guess 1..6>", …}
→ NOT_FOUND: card not found
```

**F1 — repetition that is not a storm: CI polling, now excluded by X5 (`gh pr checks` command word).**

```text
Bash  cat <task-output-file> 2>/dev/null; gh pr checks <n> 2>&1
→ Exit code 8
  e2e     pending  0  https://github.com/<owner>/<repo>/actions/runs/<id>/job/<id>
```

**F2 — transient, excluded by X3.**

```text
mcp__<server>__<tool>  {…}
→ The server-side auto mode classifier gave no verdict (error), so auto mode cannot determine the safety of mcp__<server>__<tool>. This is a transient failure …
```

## 7. What moved between rounds

| Round 1                                                            | Round 2                                     | Why                                                                                                   |
| ------------------------------------------------------------------ | ------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 23 exact runs ≥ 3 (SendMessage 21, Bash 2)                         | 19 (SendMessage 16, Agent 3)                | probe and smoke sessions under `/tmp` skipped; `Agent` keyed on type and isolation (§3.2 of the spec) |
| E2 "expired SSO token" ×3 was a storm                              | runs of 1                                   | the model ran other, possibly mutating commands between attempts, which now reset (R2)                |
| E3 "isolation context lost" ×3                                     | not in the corpus                           | it came from a T389 smoke repo under `/tmp`                                                           |
| `label.mjs` counted unlabelled runs as storms; missed two X3 texts | `unknown` reported apart; X3 texts complete | verifier finding                                                                                      |
| 0 % false positives reported bare                                  | with a 95 % upper bound                     | verifier finding                                                                                      |

## 8. Scanner source

Run as `node --experimental-strip-types scan2.mjs ~/.claude/projects <path>/hooks/core.ts`, then
`node label2.mjs runs2.json`. Node 22.22, no dependencies. The definition is not in these scripts:
it is `core.ts`, printed whole in [`04-detector-core.md`](04-detector-core.md).

### `scan2.mjs`

The replay (§1). It imports the prototype's `core.ts`; the definition lives there.

```js
// Round 2 scan: replays every transcript through the prototype's own hooks/core.ts, the way the
// mod sees it in-session (tool_use, then its tool_result), so the counts measure the spec's
// definition exactly. Run: node --experimental-strip-types scan2.mjs <projects-dir> <core.ts>
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

const [ROOT, CORE] = process.argv.slice(2)
const core = await import(path.resolve(CORE))

// Probe sessions this spec ran live sit in /tmp-rooted projects: never part of the corpus.
const isProbe = (dir) => dir.startsWith('-tmp-')

function* walk(d) {
  for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, ent.name)
    if (ent.isDirectory()) yield* walk(p)
    else if (ent.name.endsWith('.jsonl')) yield p
  }
}

const textOf = (c) =>
  typeof c === 'string'
    ? c
    : Array.isArray(c)
      ? c.map((b) => (b?.type === 'text' ? b.text : '')).join('\n')
      : ''

const seenUse = new Set()
const corpus = { files: 0, skippedProbeFiles: 0, loops: new Set(), calls: 0, failed: 0 }
const excluded = {}
const excludedDetail = {}
const runs = new Map() // runId -> { rule, tool, count, first, at: [] , loop }

for (const file of walk(ROOT)) {
  const rel = file.slice(ROOT.length + 1)
  if (isProbe(rel.split(path.sep)[0])) {
    corpus.skippedProbeFiles++
    continue
  }
  corpus.files++
  const ledger = core.emptyLedger()
  const pending = new Map()
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
    const loop = rel + (o.isSidechain ? '#side' : '#main')
    const now = Date.parse(o.timestamp ?? '') || 0
    for (const b of c) {
      if (b?.type === 'tool_use') {
        if (seenUse.has(b.id)) continue
        seenUse.add(b.id)
        pending.set(b.id, { tool: b.name, input: b.input })
        continue
      }
      if (b?.type !== 'tool_result') continue
      const call = pending.get(b.tool_use_id)
      if (!call) continue
      pending.delete(b.tool_use_id)
      corpus.calls++
      corpus.loops.add(loop)
      core.tick(ledger, loop)
      if (!b.is_error) {
        core.recordSuccess(ledger, loop, call.tool, call.input, now)
        continue
      }
      corpus.failed++
      const text = textOf(b.content)
      const why = core.exclusion(call.tool, call.input, text)
      if (why) {
        excluded[why] = (excluded[why] ?? 0) + 1
        if (why === 'poll' || why === 'server-wait') {
          const word =
            call.tool === 'Bash'
              ? (core
                  .commandWords(String(call.input?.command ?? ''))
                  .map((c) => (c.looped ? 'loop:' : '') + c.argv.slice(0, 3).join(' '))
                  .find((w) =>
                    /^loop:|^(sleep|watch|wait)|^gh (pr checks|run)|^kubectl|^(curl|wget|nc)/.test(
                      w
                    )
                  ) ?? '?')
              : call.tool
          const k =
            why +
            ' | ' +
            call.tool.replace(/^mcp__([^_]+)__/, 'mcp:') +
            ' | ' +
            word.replace(/[0-9]+/g, 'N').slice(0, 40)
          excludedDetail[k] = (excludedDetail[k] ?? 0) + 1
        }
        continue
      }
      core.recordFailure(ledger, loop, call.tool, call.input, text, now)
      const sig = core.callSig(call.tool, call.input)
      const err = core.errSig(text)
      for (const e of ledger.entries[loop] ?? []) {
        if (e.key !== `exact:${sig}|${err}` && e.key !== `same-error:${call.tool}|${err}`) continue
        const id = `${loop}|${e.key}|${e.since}`
        const r = runs.get(id) ?? {
          rule: e.rule,
          tool: call.tool,
          count: 0,
          first: text.slice(0, 300),
          at: [],
          loop
        }
        r.count = e.count
        r.at.push(now)
        runs.set(id, r)
      }
    }
  }
}

const all = [...runs.values()]
fs.writeFileSync('runs2.json', JSON.stringify(all))
const summary = {
  corpus: { ...corpus, loops: corpus.loops.size },
  excluded,
  excludedDetail: Object.fromEntries(
    Object.entries(excludedDetail)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25)
  ),
  hist: {}
}
for (const rule of ['exact', 'same-error']) {
  const h = {}
  for (const r of all.filter((x) => x.rule === rule && x.count >= 2)) {
    const k = r.count >= 7 ? '7+' : String(r.count)
    h[k] = (h[k] ?? 0) + 1
  }
  summary.hist[rule] = h
}
console.log(JSON.stringify(summary, null, 1))
```

### `label2.mjs`

Labels (§5), the false-positive table with its upper bounds (§3.3), and §3.2, §3.4, §3.5.

```js
// Round 2 labels over runs2.json (scan2.mjs). A run is labelled by its first error's text.
// `unknown` is never counted as a storm: the false-positive rate is legit / (storm + legit),
// with unknowns reported beside it, and a one-sided 95 % upper bound (Clopper-Pearson).
import fs from 'node:fs'

const STORM =
  /could not be parsed as JSON|exceeds maximum allowed tokens|Token has expired|isolation context for this agent was lost|is isolated in the worktree|Agent type '.*' not found|Concurrent subagent limit|Failed to create teammate pane|PANE_FOLDER_UNKNOWN|No changes to make|Browser is already in use|RECIPIENT_NOT_\w+_SPAWNED|No such tool available|Fork is not available inside a forked worker|does not support compound predicates|Unknown JSON field|No task found with ID|is not running \(status|outside allowed roots|PARENT_NOT_FOUND|NOT_FOUND: card not found|Invalid arguments for tool|Cannot access a chrome-extension/
const LEGIT =
  /^Exit code \d+\s*$|matches for '|=== not found|pending\s+\d|captureScreenshot|Script injection timed out|TypeError: Cannot read|Target page, context or browser has been closed|SESSION_NOT_FOUND|File does not exist|Requested entity was not found|Runtime\.evaluate" timed|modified since read|^\[computer:|^Exit code 144/

export const label = (first) => {
  const s = (first ?? '').trim()
  if (STORM.test(s)) return 'storm'
  if (LEGIT.test(s)) return 'legit'
  return 'unknown'
}

// One-sided 95 % upper bound on a binomial proportion with x events in n trials.
function upper95(x, n) {
  if (n === 0) return null
  const cdf = (p) => {
    let sum = 0
    let term = Math.pow(1 - p, n)
    for (let k = 0; k <= x; k++) {
      sum += term
      term *= ((n - k) / (k + 1)) * (p / (1 - p))
    }
    return sum
  }
  let lo = x / n
  let hi = 1
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    if (cdf(mid) > 0.05) lo = mid
    else hi = mid
  }
  return +hi.toFixed(3)
}

const runs = JSON.parse(fs.readFileSync(process.argv[2] ?? 'runs2.json', 'utf8'))
const out = {}
for (const rule of ['exact', 'same-error']) {
  out[rule] = {}
  for (const k of [2, 3, 4, 5, 6]) {
    const t = runs.filter((r) => r.rule === rule && r.count >= k)
    const c = { storm: 0, legit: 0, unknown: 0 }
    for (const r of t) c[label(r.first)]++
    const n = c.storm + c.legit
    out[rule]['k' + k] = {
      trips: t.length,
      ...c,
      fp: n ? +(c.legit / n).toFixed(3) : null,
      fpUpper95: upper95(c.legit, n)
    }
  }
  out[rule].unknownGroups = [
    ...new Set(
      runs
        .filter((r) => r.rule === rule && r.count >= 2 && label(r.first) === 'unknown')
        .map((r) => r.tool + ' :: ' + r.first.replace(/\s+/g, ' ').slice(0, 110))
    )
  ]
}
// Where the storms are, and what a perfectly obeyed notice could have saved.
const tools = {}
for (const r of runs.filter((r) => r.rule === 'exact' && r.count >= 3)) {
  const t = r.tool.startsWith('mcp__') ? 'mcp' : r.tool
  tools[t] = (tools[t] ?? 0) + 1
}
const after = (rule, k) =>
  runs.filter((r) => r.rule === rule && r.count > k).reduce((a, r) => a + r.count - k, 0)
out.exactRuns3ByTool = tools
out.callsAfter = {
  exact3: after('exact', 3),
  exact2: after('exact', 2),
  sameError4: after('same-error', 4)
}
out.sendMessageExact = {
  ge2: runs.filter(
    (r) => r.rule === 'exact' && r.count >= 2 && /could not be parsed as JSON/.test(r.first)
  ).length,
  ge3: runs.filter(
    (r) => r.rule === 'exact' && r.count >= 3 && /could not be parsed as JSON/.test(r.first)
  ).length,
  ge4: runs.filter(
    (r) => r.rule === 'exact' && r.count >= 4 && /could not be parsed as JSON/.test(r.first)
  ).length
}
out.subagentLoops = runs.filter(
  (r) => r.count >= 2 && (r.loop.includes('/subagents/') || r.loop.endsWith('#side'))
).length
const gaps = []
for (const r of runs.filter((r) => r.rule === 'exact' && r.count >= 3))
  for (let j = 1; j < r.at.length; j++)
    if (r.at[j] && r.at[j - 1]) gaps.push((r.at[j] - r.at[j - 1]) / 1000)
gaps.sort((a, b) => a - b)
const q = (p) => gaps[Math.floor(p * (gaps.length - 1))]
out.gapSeconds = { n: gaps.length, p10: q(0.1), p50: q(0.5), p90: q(0.9), max: gaps.at(-1) }
console.log(JSON.stringify(out, null, 1))
```
