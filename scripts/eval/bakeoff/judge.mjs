/**
 * One judge of one contestant run: a fresh, tool-less session per attempt that sees the score
 * sheet, the atoms and an anonymized bundle, and nothing else. "Judging" in
 * `docs/specs/2026-11-07-bakeoff-harness/spec.md` is the contract.
 */
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assignLabels, buildBundle } from './anonymize.mjs'
import { moveTranscripts, runClaude } from './claude.mjs'
import { limits } from './limits.mjs'
import { sumUsage } from './usage.mjs'

const SCORE_SHEET = join(dirname(fileURLToPath(import.meta.url)), 'prompts', 'score-sheet.md')
const VERDICTS = new Set(['covered', 'partial', 'contradicted', 'missing'])
const CREDIT = { covered: 1, partial: 0.5 }
const FENCE_OPEN = /^\s*```(\S*)\s*$/
const FENCE_CLOSE = /^\s*```\s*$/
const SEPARATOR = /^:?-+:?$/

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStrings = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string')

function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  const aside = `${path}.tmp-${randomUUID()}`
  writeFileSync(aside, text)
  renameSync(aside, path)
}

const writeJsonAtomic = (path, value) => writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`)

/** The first-column cells of the table whose first column is `id`. */
function atomIdsOf(markdown) {
  const ids = []
  let inTable = false
  for (const line of markdown.split('\n')) {
    if (!line.trim().startsWith('|')) {
      inTable = false
      continue
    }
    const first = line.trim().replace(/^\|/, '').split('|')[0].trim()
    if (first === 'id') inTable = true
    else if (inTable && !SEPARATOR.test(first)) ids.push(first)
  }
  return ids
}

/**
 * The text of the reply's one `json` block, or null. Fences are found line by line, so
 * backticks inside a JSON string never open or close one.
 */
function jsonBlock(reply) {
  const lines = reply.split('\n')
  let block = null
  for (let i = 0; i < lines.length; i++) {
    const open = FENCE_OPEN.exec(lines[i])
    if (!open) continue
    const close = lines.findIndex((line, k) => k > i && FENCE_CLOSE.test(line))
    if (close === -1) return null
    if (open[1] === 'json') {
      if (block !== null) return null
      block = { from: i + 1, to: close }
    }
    i = close
  }
  if (block === null) return null
  if (lines.slice(block.to + 1).some((line) => line.trim() !== '')) return null
  return lines.slice(block.from, block.to).join('\n')
}

function isValidReply(parsed, label) {
  if (!isObject(parsed) || parsed.spec !== label) return false
  if (!isObject(parsed.atoms)) return false
  if (!Object.values(parsed.atoms).every((verdict) => VERDICTS.has(verdict))) return false
  if (![parsed.decisions_left, parsed.contradictions, parsed.builder_guesses].every(isStrings)) {
    return false
  }
  const ac = parsed.acceptance_criteria
  if (!isObject(ac) || !Number.isInteger(ac.total) || !Number.isInteger(ac.executable)) return false
  if (ac.executable < 0 || ac.executable > ac.total) return false
  return typeof parsed.notes === 'string'
}

/** The reply's parsed block when it is valid by the schema of Judging, else null. */
function parseReply(reply, label) {
  const text = jsonBlock(reply)
  if (text === null) return null
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  return isValidReply(parsed, label) ? parsed : null
}

/**
 * @param {object} parsed a valid reply
 * @param {string[]} atomIds the ids of `atoms.md`; one the judge omitted counts `missing`
 * @returns {{ coverage: number, coverageMax: number, decisionsLeft: number, contradictions: number, acTotal: number, acExecutable: number, builderGuesses: number }}
 */
export function scoreReply(parsed, atomIds) {
  return {
    coverage: atomIds.reduce((sum, id) => sum + (CREDIT[parsed.atoms[id]] ?? 0), 0),
    coverageMax: atomIds.length,
    decisionsLeft: parsed.decisions_left.length,
    contradictions: parsed.contradictions.length,
    acTotal: parsed.acceptance_criteria.total,
    acExecutable: parsed.acceptance_criteria.executable,
    builderGuesses: parsed.builder_guesses.length
  }
}

/**
 * The root above `rounds/<round-id>/units/<problem>/<contestant>/r<k>`. Claude Code puts the
 * working directory in its system prompt, so a judge running under the unit directory would
 * read the contestant's id there; each session runs under this root instead.
 */
const workRootOf = (unitDir) => resolve(unitDir, '../../../../../..')

/** Only this judge writes `discarded/<k>/<role>`, so its numbering cannot race another unit's. */
function nextAttempt(unitDir, role) {
  const root = join(unitDir, 'discarded')
  if (!existsSync(root)) return 1
  const taken = readdirSync(root)
    .filter((k) => existsSync(join(root, k, role)))
    .map((k) => Number.parseInt(k, 10) || 0)
  return Math.max(0, ...taken) + 1
}

/** Moves one attempt's evidence aside and appends its usage to the unit's own file. */
function discardAttempt({ unitDir, role, unit, contestantId, streamPath }, sessionId) {
  const dest = join(unitDir, 'discarded', String(nextAttempt(unitDir, role)))
  const transcripts = join(dest, role)
  mkdirSync(transcripts, { recursive: true })
  moveTranscripts([sessionId], transcripts)
  if (existsSync(streamPath)) renameSync(streamPath, join(dest, `${role}.stream.jsonl`))

  const file = join(unitDir, role, 'discarded.json')
  const entries = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : []
  entries.push({ unit, phase: 'judge', contestant: contestantId, usage: sumUsage(transcripts) })
  writeJsonAtomic(file, entries)
}

/**
 * Run one judge of one contestant run and write `judge-<n>.json`.
 *
 * A `killAll` returns `{ status: 'interrupted' }` and writes no file, so a resume runs it again.
 *
 * @param {object} args `{ problem, contestant, repeat, n, unitDir, artifactDir, tells, seed, contestantIds, model }`
 * @returns {Promise<object>} the `judge-<n>.json` object
 */
export async function runJudge(args) {
  const {
    problem,
    contestant,
    repeat,
    n,
    unitDir,
    artifactDir,
    tells,
    seed,
    contestantIds,
    model
  } = args
  const contestantId = contestant.id ?? contestant
  const role = `judge-${n}`
  const atoms = readFileSync(join(problem.dir, 'hidden/atoms.md'), 'utf8')
  const atomIds = atomIdsOf(atoms)

  const labels = assignLabels(seed, problem.id, repeat, contestantIds)
  const label = Object.keys(labels).find((key) => labels[key] === contestantId)
  writeJsonAtomic(join(dirname(dirname(unitDir)), `labels-r${repeat}.json`), labels)

  const finish = (fields) => {
    const result = { label, ...fields }
    writeJsonAtomic(join(unitDir, `${role}.json`), result)
    return result
  }

  const bundle = buildBundle(artifactDir, tells)
  if (bundle === '') {
    return finish({
      status: 'not-run',
      reason: 'empty-artifact',
      raw: null,
      parsed: null,
      scores: {
        coverage: 0,
        coverageMax: atomIds.length,
        decisionsLeft: null,
        contradictions: null,
        acTotal: null,
        acExecutable: null,
        builderGuesses: null
      },
      usage: sumUsage(join(unitDir, 'transcripts', role))
    })
  }

  const judgeDir = join(unitDir, role)
  mkdirSync(judgeDir, { recursive: true })
  const bundleText = `Bundle label: ${label}\n${bundle}`
  writeFileSync(join(judgeDir, 'bundle.md'), bundleText)
  const prompt = [readFileSync(SCORE_SHEET, 'utf8'), atoms, bundleText]
    .map((part) => part.trim())
    .join('\n\n')

  const transcripts = join(unitDir, 'transcripts', role)
  rmSync(transcripts, { recursive: true, force: true })
  const streamPath = join(unitDir, `${role}.stream.jsonl`)
  const unit = `${problem.id}/${contestantId}/r${repeat}/${role}`
  const context = { unitDir, role, unit, contestantId, streamPath }

  const maxAttempts = 1 + limits.retries.invalidJudgeReply
  for (let attempt = 1; ; attempt++) {
    const sessionId = randomUUID()
    const cwd = join(workRootOf(unitDir), 'judge-cwd', randomUUID())
    mkdirSync(cwd, { recursive: true })
    writeFileSync(join(cwd, 'bundle.md'), bundleText)
    let turn
    try {
      turn = await runClaude({
        role,
        prompt,
        cwd,
        model,
        tools: [],
        addDirs: [],
        sessionId,
        deadlineMs: limits.invocationMs.judge,
        maxTurns: limits.maxTurns.judge,
        streamPath
      })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
    if (turn.interrupted) {
      discardAttempt(context, sessionId)
      return { status: 'interrupted' }
    }

    // A turn with no `result` event has an empty reply, so it lands here as an invalid one.
    const parsed = parseReply(turn.resultText, label)
    if (parsed === null && attempt < maxAttempts) {
      discardAttempt(context, sessionId)
      continue
    }

    moveTranscripts([sessionId], transcripts)
    return finish({
      status: parsed === null ? 'not-run' : 'done',
      reason: parsed === null ? 'invalid-reply' : null,
      raw: turn.resultText,
      parsed,
      scores: parsed === null ? null : scoreReply(parsed, atomIds),
      usage: sumUsage(transcripts)
    })
  }
}
