/**
 * One contestant run: the session, the simulated operator it talks to, and what is
 * collected when it ends. The bounds are the Limits table of the spec, read through
 * `limits.mjs`; the loop itself is "The contestant loop" there.
 */
import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkoutTarget, runProblemCommand } from './checkout.mjs'
import { moveTranscripts, runClaude } from './claude.mjs'
import { resolveTool } from './contestants.mjs'
import { limits } from './limits.mjs'
import { countSubAgents, sumUsage } from './usage.mjs'

const CONTESTANT_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'Task']
const OPERATOR_GONE =
  'The operator is unavailable. Answer from your best judgement, finish the artifact and reply ' +
  'ARTIFACT DONE: <paths>.'
const QUESTION_MARKER = /^QUESTION TO OPERATOR:[ \t]*/m
const DONE_MARKER = /^ARTIFACT DONE:/m
const NUDGE_SEPARATOR = '<!-- stray-nudge -->'
/** The contestant's view of its method: a path no absolute location of the harness shows in. */
const TOOL_DIR_FROM_CLONE = '../tool'

const PROMPTS = join(dirname(fileURLToPath(import.meta.url)), 'prompts')

function contestantPrompts() {
  const [first, nudge] = readFileSync(join(PROMPTS, 'contestant.md'), 'utf8').split(NUDGE_SEPARATOR)
  return { first: first.trim(), nudge: nudge.trim() }
}

/** Fills `{{NAME}}` in one pass: text pasted in from a value is never itself expanded. */
const fill = (template, values) =>
  template.replace(/\{\{([A-Z_]+)\}\}/g, (whole, name) => values[name] ?? whole)

function parseOperatorReply(reply) {
  const answer = /^ANSWER:[ \t]*([\s\S]*)$/m.exec(reply)
  // A reply that broke the form still goes back whole: the alternative is discarding the run.
  if (!answer) return { entries: 'none', answer: reply.trim() }
  const entries = /^ENTRIES:[ \t]*(.*)$/m.exec(reply)
  return { entries: entries?.[1].trim() ?? 'none', answer: answer[1].trim() }
}

function logExchange(path, k, question, { entries, answer }) {
  const gap = k > 1 ? '\n' : ''
  const section = `## Exchange ${k}\n\nQuestion:\n${question}\n\nEntries: ${entries}\n\nAnswer:\n${answer}\n`
  appendFileSync(path, gap + section)
}

const streamFiles = (unitDir) =>
  readdirSync(unitDir)
    .filter((name) => /^stream-\d+\.jsonl$/.test(name))
    .map((name) => join(unitDir, name))

function addUsage(a, b) {
  return {
    input: a.input + b.input,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cacheRead: a.cacheRead + b.cacheRead,
    output: a.output + b.output,
    total: a.total + b.total
  }
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const aside = `${path}.tmp-${randomUUID()}`
  writeFileSync(aside, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(aside, path)
}

/** Everything one attempt leaves in the unit directory, removed before the next one. */
function clearAttempt(unitDir) {
  for (const name of ['clone', 'operator', 'transcripts', 'artifact', 'operator-log.md']) {
    rmSync(join(unitDir, name), { recursive: true, force: true })
  }
  for (const stream of streamFiles(unitDir)) rmSync(stream, { force: true })
}

function nextDiscardNumber(unitDir) {
  const root = join(unitDir, 'discarded')
  if (!existsSync(root)) return 1
  return Math.max(0, ...readdirSync(root).map((n) => Number.parseInt(n, 10) || 0)) + 1
}

/** Moves an attempt's evidence aside and appends its usage to the unit's own file. */
function discardAttempt(ctx, sessions) {
  const { unitDir, problem, contestant, repeat } = ctx
  const dest = join(unitDir, 'discarded', String(nextDiscardNumber(unitDir)))
  const contestantDir = join(dest, 'contestant')
  const operatorDir = join(dest, 'operator')
  moveTranscripts([sessions.contestant], contestantDir)
  moveTranscripts([sessions.operator], operatorDir)
  mkdirSync(dest, { recursive: true })
  for (const stream of streamFiles(unitDir)) {
    renameSync(stream, join(dest, stream.slice(unitDir.length + 1)))
  }
  const file = join(unitDir, 'contestant', 'discarded.json')
  const entries = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : []
  entries.push({
    unit: `${problem.id}/${contestant.id}/r${repeat}/contestant`,
    phase: 'contestant',
    contestant: contestant.id,
    usage: addUsage(sumUsage(contestantDir), sumUsage(operatorDir))
  })
  writeJsonAtomic(file, entries)
}

/** Drives one attempt's turns; returns its outcome and counters. */
async function runTurns(ctx, sessions, prompts) {
  const { unitDir, contestant, model, operatorModel } = ctx
  const clone = join(unitDir, 'clone')
  const operatorDir = join(unitDir, 'operator')
  const logPath = join(unitDir, 'operator-log.md')
  const runDeadline = Date.now() + limits.runMs
  const startedAt = Date.now()
  const c = {
    contestantTurns: 0,
    operatorTurns: 0,
    strayReplies: 0,
    operatorSessionId: null,
    wallMs: 0
  }
  let invocation = 0

  const invoke = (options, invocationLimit) => {
    invocation += 1
    return runClaude({
      ...options,
      deadlineMs: Math.max(1, Math.min(invocationLimit, runDeadline - Date.now())),
      streamPath: join(unitDir, `stream-${invocation}.jsonl`)
    })
  }

  /** What a turn that produced no reply means: the run deadline outranks a retry. */
  const failedTurn = (turn) => {
    if (turn.interrupted) return { status: 'interrupted', ...c }
    return { status: Date.now() >= runDeadline ? 'incomplete' : 'error', ...c }
  }

  let prompt = prompts.first
  let questions = 0
  for (;;) {
    if (Date.now() >= runDeadline) return { status: 'incomplete', ...c }

    const turn = await invoke(
      {
        role: 'contestant',
        prompt,
        cwd: clone,
        model,
        tools: CONTESTANT_TOOLS,
        addDirs: [join(unitDir, 'tool')],
        maxTurns: limits.maxTurns.contestant,
        ...(c.contestantTurns === 0
          ? { sessionId: sessions.contestant }
          : { resume: sessions.contestant })
      },
      limits.invocationMs.contestant
    )
    if (turn.status === 'error') return failedTurn(turn)
    c.contestantTurns += 1
    c.wallMs = Date.now() - startedAt

    const asked = QUESTION_MARKER.exec(turn.resultText)
    if (asked) {
      questions += 1
      if (questions > limits.operatorExchanges + 1) return { status: 'incomplete', ...c }
      if (questions === limits.operatorExchanges + 1) {
        prompt = OPERATOR_GONE
        continue
      }
      const question = turn.resultText.slice(asked.index + asked[0].length).trim()
      const first = c.operatorTurns === 0
      const reply = await invoke(
        {
          role: 'operator',
          prompt: first ? fill(prompts.operator, { QUESTION: question }) : question,
          cwd: operatorDir,
          model: operatorModel,
          tools: [],
          addDirs: [],
          maxTurns: limits.maxTurns.operator,
          ...(first ? { sessionId: sessions.operator } : { resume: sessions.operator })
        },
        limits.invocationMs.operator
      )
      if (first) c.operatorSessionId = sessions.operator
      if (reply.status === 'error') return failedTurn(reply)
      c.operatorTurns += 1
      const parsed = parseOperatorReply(reply.resultText)
      logExchange(logPath, c.operatorTurns, question, parsed)
      prompt = parsed.answer
      continue
    }

    if (DONE_MARKER.test(turn.resultText)) return { status: 'done', ...c }

    c.strayReplies += 1
    if (c.strayReplies >= limits.strayReplies) return { status: 'incomplete', ...c }
    prompt = prompts.nudge
  }
}

/** Every file added or modified relative to the pinned commit, committed by the session or not. */
async function changedFiles(clone, commit) {
  await runProblemCommand('git add -A', clone)
  const diff = await runProblemCommand(
    `git diff --cached --name-status --no-renames -z ${commit}`,
    clone
  )
  if (diff.exitCode !== 0) return []
  const fields = diff.stdout.split('\0')
  const paths = []
  for (let i = 0; i + 1 < fields.length; i += 2) {
    if (fields[i] !== 'D') paths.push(fields[i + 1])
  }
  return paths.sort()
}

function collectArtifact(unitDir, paths) {
  for (const path of paths) {
    cpSync(join(unitDir, 'clone', path), join(unitDir, 'artifact', path), {
      recursive: true,
      verbatimSymlinks: true
    })
  }
}

function globToRegExp(glob) {
  let source = ''
  for (let i = 0; i < glob.length; i++) {
    if (glob.startsWith('**/', i)) {
      source += '(?:.*/)?'
      i += 2
    } else if (glob[i] === '*') {
      source += '[^/]*'
    } else {
      source += glob[i].replace(/[.+?^${}()|[\]\\/]/g, '\\$&')
    }
  }
  return new RegExp(`^${source}$`)
}

function specCounts(unitDir, artifact, glob) {
  const regexp = globToRegExp(glob)
  const path = artifact.find((p) => regexp.test(p))
  if (path === undefined) return { specLines: 0, specWords: 0 }
  const text = readFileSync(join(unitDir, 'artifact', path), 'utf8')
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return { specLines: lines.length, specWords: text.match(/\S+/g)?.length ?? 0 }
}

/**
 * Run one contestant to its end and write `contestant.json`.
 *
 * Returns that object. Two cases write no file, so a resume runs the unit again: a tool or
 * checkout that could not be prepared (the coded error is returned) and a `killAll`, which
 * returns `{ status: 'interrupted' }` after discarding the attempt.
 *
 * @param {object} args `{ problem, contestant, repeat, unitDir, roots, skillRef, answerSheetPath, model, operatorModel }`
 * @returns {Promise<object>}
 */
export async function runContestant(args) {
  const { problem, contestant, unitDir, roots, skillRef, answerSheetPath } = args
  const toolDir = join(unitDir, 'tool')
  mkdirSync(unitDir, { recursive: true })
  rmSync(toolDir, { recursive: true, force: true })
  const tool = await resolveTool(contestant, {
    skillRef,
    repo: roots.repo,
    cacheRoot: roots.cache,
    dest: toolDir
  })
  if ('code' in tool) return tool

  const request = readFileSync(join(problem.dir, 'request.md'), 'utf8')
  const { first, nudge } = contestantPrompts()
  const firstPrompt = fill(first, {
    TOOL_DIR: TOOL_DIR_FROM_CLONE,
    ENTRY: contestant.entry,
    STOP_POINT: contestant.stopPoint,
    REQUEST: request.trim()
  })

  const maxAttempts = 1 + limits.retries.noResult
  for (let attempt = 1; ; attempt++) {
    clearAttempt(unitDir)
    const checkout = await checkoutTarget(problem, join(unitDir, 'clone'), {
      cacheRoot: roots.cache,
      setup: false
    })
    if ('code' in checkout) return checkout

    const operatorDir = join(unitDir, 'operator')
    mkdirSync(operatorDir, { recursive: true })
    const sheetCopy = join(operatorDir, 'answer-sheet.md')
    cpSync(answerSheetPath, sheetCopy)
    const operator = fill(readFileSync(join(PROMPTS, 'operator.md'), 'utf8').trim(), {
      ANSWER_SHEET: readFileSync(sheetCopy, 'utf8').trim(),
      QUESTION: '{{QUESTION}}'
    })

    const sessions = { contestant: randomUUID(), operator: randomUUID() }
    const prompts = { first: firstPrompt, nudge, operator }
    const outcome = await runTurns({ ...args }, sessions, prompts)

    if (outcome.status === 'interrupted') {
      discardAttempt(args, sessions)
      return { status: 'interrupted' }
    }
    if (outcome.status === 'error' && attempt < maxAttempts) {
      discardAttempt(args, sessions)
      continue
    }
    return finishRun(args, sessions, outcome, checkout.commit)
  }
}

async function finishRun(args, sessions, outcome, commit) {
  const { unitDir, contestant } = args
  const transcripts = (role) => join(unitDir, 'transcripts', role)
  moveTranscripts([sessions.contestant], transcripts('contestant'))
  moveTranscripts([sessions.operator], transcripts('operator'))

  const artifact = await changedFiles(join(unitDir, 'clone'), commit)
  collectArtifact(unitDir, artifact)

  const result = {
    status: outcome.status === 'error' ? 'failed' : outcome.status,
    sessionId: sessions.contestant,
    operatorSessionId: outcome.operatorSessionId,
    contestantTurns: outcome.contestantTurns,
    operatorTurns: outcome.operatorTurns,
    strayReplies: outcome.strayReplies,
    subAgents: countSubAgents(streamFiles(unitDir)),
    wallMs: outcome.wallMs,
    usage: {
      contestant: sumUsage(transcripts('contestant')),
      operator: sumUsage(transcripts('operator'))
    },
    artifact,
    ...specCounts(unitDir, artifact, contestant.specFile)
  }
  writeJsonAtomic(join(unitDir, 'contestant.json'), result)
  return result
}
