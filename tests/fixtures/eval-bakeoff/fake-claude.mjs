#!/usr/bin/env node
/**
 * A stand-in for `claude -p`, used by the bake-off's tests so they never call a model.
 *
 * Environment:
 * - FAKE_CLAUDE_SCENARIO     path of a JSON array with one entry per invocation, consumed in order:
 *                            { reply, writes: [{ path, content }], noResult, hangMs, messageId }
 * - HARNU_BAKEOFF_CLAUDE_PROJECTS  where transcripts go; also holds the array's cursor
 * - FAKE_CLAUDE_LOG          optional: one JSON line { cwd, argv } per invocation
 * - FAKE_CLAUDE_PROMPT_LOG   optional: one JSON line { prompt } per invocation, in the same order
 * - FAKE_CLAUDE_ENV_LOG      optional: one JSON line { env: [names] } per invocation, names only
 * - FAKE_CLAUDE_DELAY_MS     optional: extra wait before the first output
 *
 * The transcript is written before any wait, like the real CLI's, which writes as it goes: a
 * session killed mid-wait leaves its transcript and usage behind. Past the end of the array the
 * fake prints to stderr and exits 3 with no `result` event.
 */
import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const STALE_LOCK_MS = 5_000
const USAGE = {
  input_tokens: 100,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens: 10
}

const argv = process.argv.slice(2)
const cwd = process.cwd()
const projects = process.env.HARNU_BAKEOFF_CLAUDE_PROJECTS

function flag(name) {
  const i = argv.indexOf(name)
  return i === -1 ? undefined : argv[i + 1]
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

async function readStdin() {
  let text = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) text += chunk
  return text
}

/** The next index of the scenario array, taken under an exclusive lock file. */
function claimIndex() {
  mkdirSync(projects, { recursive: true })
  const cursor = join(projects, '.fake-claude-cursor')
  const lock = `${cursor}.lock`
  for (;;) {
    try {
      closeSync(openSync(lock, 'wx'))
      break
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      try {
        if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) unlinkSync(lock)
      } catch {
        /* its holder just released it */
      }
      sleepSync(2)
    }
  }
  try {
    let index = 0
    try {
      index = Number.parseInt(readFileSync(cursor, 'utf8'), 10) || 0
    } catch {
      /* first invocation */
    }
    writeFileSync(cursor, String(index + 1))
    return index
  } finally {
    unlinkSync(lock)
  }
}

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`)
}

/** Logged after the transcript is on disk, so a test that sees the line can kill the session. */
function logInvocation(prompt) {
  if (process.env.FAKE_CLAUDE_LOG) {
    appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify({ cwd, argv })}\n`)
  }
  if (process.env.FAKE_CLAUDE_PROMPT_LOG) {
    appendFileSync(process.env.FAKE_CLAUDE_PROMPT_LOG, `${JSON.stringify({ prompt })}\n`)
  }
  if (process.env.FAKE_CLAUDE_ENV_LOG) {
    const names = Object.keys(process.env).sort()
    appendFileSync(process.env.FAKE_CLAUDE_ENV_LOG, `${JSON.stringify({ env: names })}\n`)
  }
}

async function main() {
  const prompt = await readStdin()
  const scenario = JSON.parse(readFileSync(process.env.FAKE_CLAUDE_SCENARIO, 'utf8'))
  const index = claimIndex()
  const entry = scenario[index]
  if (entry === undefined) {
    logInvocation(prompt)
    process.stderr.write(`fake-claude: no scenario entry at index ${index}\n`)
    process.exitCode = 3
    return
  }

  for (const { path, content } of entry.writes ?? []) {
    const target = resolve(cwd, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
  }

  const sessionId = flag('--session-id') ?? flag('--resume') ?? randomUUID()
  const reply = entry.reply ?? ''
  const message = {
    id: entry.messageId ?? `msg_${randomUUID()}`,
    role: 'assistant',
    content: [{ type: 'text', text: reply }],
    usage: USAGE
  }
  const projectDir = join(projects, cwd.replace(/[^a-zA-Z0-9]/g, '-'))
  // The real CLI leaves an empty `memory/` in every project directory it touches.
  mkdirSync(join(projectDir, 'memory'), { recursive: true })
  appendFileSync(
    join(projectDir, `${sessionId}.jsonl`),
    `${JSON.stringify({ type: 'assistant', sessionId, message })}\n`
  )
  logInvocation(prompt)

  await sleep(entry.hangMs ?? 0)
  await sleep(Number.parseInt(process.env.FAKE_CLAUDE_DELAY_MS ?? '', 10) || 0)

  const model = entry.noResult || !flag('--model') ? undefined : `fake-${flag('--model')}`
  emit({ type: 'system', subtype: 'init', session_id: sessionId, model })
  emit({ type: 'assistant', session_id: sessionId, message })
  if (!entry.noResult) {
    emit({
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: sessionId,
      result: reply,
      usage: USAGE
    })
  }
}

await main()
