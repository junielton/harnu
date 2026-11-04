// T1 spike: turn a `claude plugin eval --keep-temp --json` result into the doc-reader comparison.
//
//   node summarize.mjs <eval.json> <outDir> <model> <runs> <minLines>
//
// plugin eval reports one `costUsd` per run. The per-model split (main model vs the Haiku
// doc-reader) only exists in each run's trace, on the final `result` line's `modelUsage`. This
// reads every trace, writes usage.json, and writes summary.md: per case and per arm, the mean
// score, cost, main-model tokens and Haiku tokens, with the deltas next to the quality change.
// It also counts, per run, the main model's Agent calls and the reads the gate refused, so the
// routing behind the numbers can be reproduced from the traces.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { basename, join } from 'node:path'

const [evalPath, outDir, model, runs, minLines] = process.argv.slice(2)
const variantFile = join(outDir, 'variant.txt')
const variant = existsSync(variantFile)
  ? readFileSync(variantFile, 'utf8').replace('variant:', '').trim()
  : 'gate'
const withArm =
  variant === 'agent-only'
    ? 'offers the Haiku doc-reader agent with no read gate (nothing enforces it)'
    : 'loads the read gate and the Haiku doc-reader'
const result = JSON.parse(readFileSync(evalPath, 'utf8'))

/** The gate's refusal, as the main model sees it in a tool_result (see gate-core.ts `deny`). */
const GATE_DENIAL = /^PreToolUse:\w+ hook error: .* lines of documentation \(threshold \d+\)/s

/**
 * One trace's last `result` modelUsage, plus the main model's Agent calls and gate refusals.
 * Only events with `parent_tool_use_id: null` are the main model's; the rest are a subagent's.
 * `null` when the trace is missing.
 */
function readTrace(tracePath) {
  if (!tracePath || !existsSync(tracePath)) return null
  let modelUsage = null
  let agentCalls = 0
  let gateBlocks = 0
  for (const line of readFileSync(tracePath, 'utf8').split('\n')) {
    let ev
    try {
      ev = JSON.parse(line)
    } catch {
      continue // blank or not JSON
    }
    if (ev.type === 'result' && ev.modelUsage) modelUsage = ev.modelUsage
    if (ev.parent_tool_use_id != null || !Array.isArray(ev.message?.content)) continue
    for (const part of ev.message.content) {
      if (ev.type === 'assistant' && part.type === 'tool_use' && part.name === 'Agent') agentCalls++
      if (ev.type === 'user' && part.type === 'tool_result' && part.is_error) {
        const text = typeof part.content === 'string' ? part.content : JSON.stringify(part.content)
        if (GATE_DENIAL.test(text)) gateBlocks++
      }
    }
  }
  return { modelUsage, agentCalls, gateBlocks }
}

const isHaiku = (id) => /haiku/i.test(id)
/** Everything the model had to read: fresh input, cache writes and cache reads. */
const inTokens = (u) =>
  (u.inputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0) + (u.cacheReadInputTokens ?? 0)

const usage = []
for (const c of result.cases ?? []) {
  for (const [arm, armRuns] of Object.entries(c.arms ?? {})) {
    armRuns.forEach((run, i) => {
      // run.sh copies each trace to <outDir>/traces/ and deletes the sandbox, so a re-run of this
      // script on a saved result reads the copy.
      const kept = join(outDir, 'traces', `${c.name}-${arm}-${i}.jsonl`)
      const trace = readTrace(existsSync(run.tracePath ?? '') ? run.tracePath : kept)
      const mu = trace?.modelUsage ?? null
      const split = { main: { in: 0, out: 0, usd: 0 }, haiku: { in: 0, out: 0, usd: 0 } }
      for (const [id, u] of Object.entries(mu ?? {})) {
        // With a non-Haiku main model, every Haiku token is the doc-reader's (or a judge's; judges
        // are billed separately as judgeCostUsd and are not in the run's trace).
        const side = isHaiku(id) && !isHaiku(model) ? split.haiku : split.main
        side.in += inTokens(u)
        side.out += u.outputTokens ?? 0
        side.usd += u.costUSD ?? 0
      }
      usage.push({
        case: c.name,
        arm,
        run: i,
        score: run.score ?? null,
        turns: run.turns ?? null,
        costUsd: run.costUsd ?? null,
        durationSeconds: run.durationSeconds ?? null,
        error: run.error ?? null,
        traced: mu !== null,
        agentCalls: trace?.agentCalls ?? null,
        gateBlocks: trace?.gateBlocks ?? null,
        ...split
      })
    })
  }
}
writeFileSync(join(outDir, 'usage.json'), JSON.stringify(usage, null, 2) + '\n')

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN)
const sd = (xs) => {
  if (xs.length < 2) return 0
  const m = mean(xs)
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1))
}
/** Total over the runs that were traced, or NaN when none was. */
const sumOf = (rows, f) => {
  const xs = pick(rows, f)
  return xs.length ? xs.reduce((a, b) => a + b, 0) : NaN
}
const pick = (rows, f) => rows.map(f).filter((x) => typeof x === 'number' && Number.isFinite(x))
const fmtK = (n) => (Number.isFinite(n) ? `${(n / 1000).toFixed(1)}k` : '–')
const fmt$ = (n) => (Number.isFinite(n) ? `$${n.toFixed(3)}` : '–')
const fmtP = (n) => (Number.isFinite(n) ? `${n >= 0 ? '+' : ''}${(n * 100).toFixed(0)}%` : '–')
const fmtN = (n) => (Number.isFinite(n) ? String(n) : '–')
const fmtS = (n) => (Number.isFinite(n) ? n.toFixed(2) : '–')

function armStats(rows) {
  return {
    n: rows.length,
    score: mean(pick(rows, (r) => r.score)),
    cost: mean(pick(rows, (r) => r.costUsd)),
    costSd: sd(pick(rows, (r) => r.costUsd)),
    mainIn: mean(pick(rows, (r) => r.main.in)),
    haikuIn: mean(pick(rows, (r) => r.haiku.in)),
    secs: mean(pick(rows, (r) => r.durationSeconds)),
    turns: mean(pick(rows, (r) => r.turns)),
    agentCalls: sumOf(rows, (r) => r.agentCalls),
    gateBlocks: sumOf(rows, (r) => r.gateBlocks)
  }
}

const caseNames = [...new Set(usage.map((u) => u.case))]
const lines = []
// The run's date, from run.sh's timestamped output dir, so a re-summary keeps it.
const runDate =
  /^\d{4}-\d{2}-\d{2}/.exec(basename(outDir))?.[0] ?? new Date().toISOString().slice(0, 10)
lines.push(`# doc-reader A/B (${variant}): ${runDate}`)
lines.push('')
lines.push(
  `Main model \`${model}\`, ${runs} run(s) per case per arm, gate threshold ${minLines} lines. ` +
    `"without" is plugin eval's no-plugin baseline; "with" ${withArm}. ` +
    'Cost is the whole run (main model and Haiku), excluding grader cost. Main-in counts every input token the main model read, cache reads included.'
)
lines.push('')
lines.push(
  '| case | score without → with | cost without → with (Δ) | main-in without → with (Δ) | haiku-in (with) | gate blocks / agent calls (with, all runs) | secs without → with |'
)
lines.push('|---|---|---|---|---|---|---|')
const totals = { without: [], with: [] }
for (const name of caseNames) {
  const w0 = armStats(usage.filter((u) => u.case === name && u.arm === 'without'))
  const w1 = armStats(usage.filter((u) => u.case === name && u.arm === 'with'))
  totals.without.push(w0)
  totals.with.push(w1)
  lines.push(
    `| ${name} | ${fmtS(w0.score)} → ${fmtS(w1.score)} | ${fmt$(w0.cost)} → ${fmt$(w1.cost)} (${fmtP(w1.cost / w0.cost - 1)}) | ` +
      `${fmtK(w0.mainIn)} → ${fmtK(w1.mainIn)} (${fmtP(w1.mainIn / w0.mainIn - 1)}) | ${fmtK(w1.haikuIn)} | ${fmtN(w1.gateBlocks)} / ${fmtN(w1.agentCalls)} | ${w0.secs.toFixed(0)} → ${w1.secs.toFixed(0)} |`
  )
}
const sum = (arr, k) => arr.reduce((a, s) => a + (Number.isFinite(s[k]) ? s[k] : 0), 0)
const c0 = sum(totals.without, 'cost')
const c1 = sum(totals.with, 'cost')
const m0 = sum(totals.without, 'mainIn')
const m1 = sum(totals.with, 'mainIn')
lines.push(
  `| **all cases (sum of means)** | ${fmtS(mean(totals.without.map((s) => s.score)))} → ${fmtS(mean(totals.with.map((s) => s.score)))} | ` +
    `${fmt$(c0)} → ${fmt$(c1)} (${fmtP(c1 / c0 - 1)}) | ${fmtK(m0)} → ${fmtK(m1)} (${fmtP(m1 / m0 - 1)}) | ${fmtK(sum(totals.with, 'haikuIn'))} | ${sum(totals.with, 'gateBlocks')} / ${sum(totals.with, 'agentCalls')} | |`
)
lines.push('')
const untraced = usage.filter((u) => !u.traced).length
const errored = usage.filter((u) => u.error).length
lines.push(
  'Score counts only the answer graders. A `tool_used` grader marked `arm: with-only` is reported in eval.json with `scored: false` and never lowers the score; routing shows in the gate blocks / agent calls column.'
)
lines.push('')
lines.push(
  `Runs: ${usage.length}. Without a trace (no per-model split): ${untraced}. Errored: ${errored}.`
)
lines.push('')
writeFileSync(join(outDir, 'summary.md'), lines.join('\n'))
process.stdout.write(lines.join('\n') + '\n')
