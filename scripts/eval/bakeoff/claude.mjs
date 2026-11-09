/**
 * The bake-off's one way to run `claude -p`.
 *
 * Unlike `mission-behavior/agent.mjs`, every prompt travels over stdin (a judge's bundle
 * can exceed the argument-length limit) and sessions persist, because a turn is resumed
 * with `--resume`. So transcripts land in the projects directory and are moved out.
 *
 * Children run niced, in their own process group, so a deadline also ends what a
 * session's `Bash` started.
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync
} from 'node:fs'
import { constants, homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { cleanEnv } from '../mission-behavior/harnu.mjs'
import { escalate } from '../mission-behavior/procs.mjs'
import { limits } from './limits.mjs'
import { sumUsage } from './usage.mjs'

const CPU_ENV = { GOMAXPROCS: '1', PYTEST_ADDOPTS: '-p no:xdist', npm_config_jobs: '1' }
const MODEL_ALIASES = new Set(['opus', 'sonnet', 'haiku'])
const STDERR_TAIL_CHARS = 64 * 1024

/** Children still running, each `{ sessionId, kill, interrupted }`. */
const running = new Set()
let interrupted = false

const projectsRoot = () =>
  process.env.HARNU_BAKEOFF_CLAUDE_PROJECTS || join(homedir(), '.claude', 'projects')

/** A role's environment: none of it may name the private holdout, whatever `Bash` prints. */
function childEnv() {
  const env = cleanEnv(CPU_ENV)
  for (const k of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'HARNU_BAKEOFF_HOLDOUT',
    'HARNU_BAKEOFF_WORK'
  ]) {
    delete env[k]
  }
  return env
}

/** A kill target for the process group of a child started with `detached: true`. */
function groupOf(pid) {
  return {
    label: `process group ${pid}`,
    alive: () => {
      try {
        process.kill(-pid, 0)
        return true
      } catch (e) {
        return e.code === 'EPERM'
      }
    },
    send: (signal) => {
      try {
        process.kill(-pid, signal)
      } catch {
        /* gone */
      }
    }
  }
}

function claudeArgs({ model, maxTurns, tools, addDirs, sessionId, resume }) {
  const args = [
    '-p',
    '--model',
    model,
    '--max-turns',
    String(maxTurns),
    '--output-format',
    'stream-json',
    '--verbose',
    '--setting-sources',
    'project'
  ]
  if (tools.length > 0) args.push('--tools', tools.join(','), '--allowedTools', tools.join(','))
  else args.push('--tools', '')
  for (const dir of addDirs) args.push('--add-dir', dir)
  if (resume) args.push('--resume', resume)
  else args.push('--session-id', sessionId)
  return args
}

/**
 * Run one `claude -p` invocation to its end. Never rejects.
 *
 * `status` is `result` when the stream held a `result` event, else `error`, a killed turn
 * included. `interrupted` (beside the fields of the spec) tells a `killAll` from a deadline:
 * an interrupted run is not retried.
 *
 * @param {object} options `{ role, prompt, cwd, model, tools, addDirs, sessionId, resume, deadlineMs, maxTurns, streamPath }`
 * @returns {Promise<{ status: 'result' | 'error', resultText: string, sessionId: string, killed: boolean, exitCode: number | null, ms: number, interrupted: boolean }>}
 */
export function runClaude(options) {
  const { role, prompt, cwd, tools = [], addDirs = [], deadlineMs, streamPath } = options
  const id = options.resume ?? options.sessionId
  if (interrupted) {
    return Promise.resolve({
      status: 'error',
      resultText: '',
      sessionId: id,
      killed: false,
      exitCode: null,
      ms: 0,
      interrupted: true
    })
  }

  const bin = process.env.HARNU_BAKEOFF_CLAUDE_BIN || 'claude'
  const argv = claudeArgs({ ...options, tools, addDirs })
  const started = Date.now()
  mkdirSync(dirname(streamPath), { recursive: true })

  return new Promise((resolve) => {
    const child = spawn('nice', ['-n', '19', bin, ...argv], {
      cwd,
      env: childEnv(),
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const out = createWriteStream(streamPath)
    out.on('error', () => {})
    // A child that dies before reading its prompt must not take the harness with it.
    child.stdin.on('error', () => {})

    let buffered = ''
    let stderr = ''
    let final = null
    let streamSession = null
    let killed = false
    let settled = false

    const self = {
      sessionId: id,
      interrupted: false,
      kill: async () => {
        killed = true
        if (child.pid === undefined) return
        await escalate([groupOf(child.pid)])
        // Frees us from a daemon that left the group and still holds the pipes.
        child.stdout.destroy()
        child.stderr.destroy()
      }
    }
    running.add(self)
    const timer = setTimeout(() => void self.kill(), deadlineMs)

    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      out.write(chunk)
      buffered += chunk
      let nl
      while ((nl = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, nl)
        buffered = buffered.slice(nl + 1)
        let event
        try {
          event = JSON.parse(line)
        } catch {
          continue
        }
        if (typeof event.session_id === 'string') streamSession = event.session_id
        if (event.type === 'result') final = event
      }
    })
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS)
    })

    const finish = (exitCode) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      running.delete(self)
      // stderr is one JSON line at the end, so the stream stays parseable line by line.
      const tail =
        stderr === '' ? '' : `${JSON.stringify({ type: 'stderr', role, text: stderr })}\n`
      out.end(tail, () =>
        resolve({
          status: final === null ? 'error' : 'result',
          resultText: typeof final?.result === 'string' ? final.result : '',
          sessionId: streamSession ?? id,
          killed,
          exitCode,
          ms: Date.now() - started,
          interrupted: self.interrupted
        })
      )
    }
    child.once('error', (err) => {
      stderr += err.message
      finish(null)
    })
    child.once('close', (code, signal) => finish(code ?? 128 + (constants.signals[signal] ?? 0)))
    child.stdin.end(prompt)
  })
}

/**
 * Kill every running child, for Ctrl-C. From here on `runClaude` starts nothing, so a unit
 * between two turns cannot open another session while the round is shutting down.
 *
 * @returns {Promise<string[]>} the killed session ids
 */
export async function killAll() {
  interrupted = true
  const children = [...running]
  for (const child of children) child.interrupted = true
  await Promise.all(children.map((child) => child.kill()))
  return children.map((child) => child.sessionId)
}

/** Allow sessions again after `killAll`, for a `resume` in the same process. */
export function resetInterrupted() {
  interrupted = false
}

/** Rename, or copy and delete when `dest` is on another filesystem or already exists. */
function move(src, dest) {
  mkdirSync(dirname(dest), { recursive: true })
  try {
    renameSync(src, dest)
  } catch (err) {
    if (!['EXDEV', 'ENOTEMPTY', 'EEXIST'].includes(err.code)) throw err
    cpSync(src, dest, { recursive: true, force: true, verbatimSymlinks: true })
    rmSync(src, { recursive: true, force: true })
  }
}

/**
 * Move each session's transcript and sub-agent transcripts out of the projects directory.
 * The session's directory moves whole, so nothing of it stays behind; a project directory
 * is removed only when that leaves it empty.
 *
 * @param {(string | null | undefined)[]} sessionIds
 * @param {string} destDir the caller's role directory
 * @returns {{ moved: string[] }}
 */
export function moveTranscripts(sessionIds, destDir) {
  const root = projectsRoot()
  let projects
  try {
    projects = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory())
  } catch {
    return { moved: [] }
  }
  const moved = []
  for (const id of sessionIds) {
    if (!id) continue
    let found = false
    for (const project of projects) {
      const dir = join(root, project.name)
      const transcript = join(dir, `${id}.jsonl`)
      const sessionDir = join(dir, id)
      const here = [
        [transcript, join(destDir, `${id}.jsonl`)],
        [sessionDir, join(destDir, id)]
      ].filter(([src]) => existsSync(src))
      if (here.length === 0) continue
      found = true
      for (const [src, dest] of here) move(src, dest)
      try {
        rmdirSync(dir)
      } catch {
        /* it holds something else, or it is already gone */
      }
    }
    if (found) moved.push(id)
  }
  return { moved }
}

function initModel(streamPath) {
  for (const line of readFileSync(streamPath, 'utf8').split('\n')) {
    try {
      const event = JSON.parse(line)
      if (event.type === 'system' && event.subtype === 'init' && event.model) return event.model
    } catch {
      /* not an event */
    }
  }
  return null
}

/** One probe, in a throwaway directory: it never runs inside the repo and leaves nothing. */
async function probe(alias, opts) {
  const dir = mkdtempSync(join(opts.tmpRoot ?? tmpdir(), 'bakeoff-probe-'))
  try {
    const sessionId = randomUUID()
    const streamPath = join(dir, 'stream.jsonl')
    await runClaude({
      role: 'probe',
      prompt: 'ok',
      cwd: dir,
      model: alias,
      tools: [],
      addDirs: [],
      sessionId,
      deadlineMs: limits.invocationMs.operator,
      maxTurns: 1,
      streamPath
    })
    const transcripts = join(dir, 'transcripts')
    moveTranscripts([sessionId], transcripts)
    return { model: initModel(streamPath), usage: sumUsage(transcripts) }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Turn model names into full ids, with one probe per distinct alias.
 *
 * @param {string[]} names `opus`, `sonnet` and `haiku` are aliases, anything else a full id
 * @param {{ tmpRoot?: string }} [opts]
 * @returns {Promise<{ ids: Record<string, string>, probes: object[] } | { code: string, message: string }>}
 */
export async function resolveModel(names, opts = {}) {
  const ids = {}
  const probes = []
  for (const name of new Set(names)) {
    if (!MODEL_ALIASES.has(name)) {
      ids[name] = name
      continue
    }
    const { model, usage } = await probe(name, opts)
    if (model === null) {
      return { code: 'MODEL_UNRESOLVED', message: `The model alias ${name} did not resolve.` }
    }
    ids[name] = model
    probes.push(usage)
  }
  return { ids, probes }
}
