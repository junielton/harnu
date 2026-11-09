/**
 * Target checkouts and the commands run inside them.
 *
 * Everything runs under `nice -n 19` with the single-thread variables (the CPU
 * rule of the spec). A checkout holds the pinned commit's history and nothing
 * else: a clone of the whole mirror would leave the commits after the pin, the
 * upstream fix among them, one `git log --all` away from a contestant.
 *
 * A coded error's `message` is safe for a holdout terminal: it holds no URL, id or
 * command output. `detail` holds the underlying output, for a private log.
 */
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { constants } from 'node:os'
import { join } from 'node:path'
import { cleanEnv } from '../mission-behavior/harnu.mjs'
import { escalate } from '../mission-behavior/procs.mjs'
import { limits } from './limits.mjs'

const CPU_ENV = { GOMAXPROCS: '1', PYTEST_ADDOPTS: '-p no:xdist', npm_config_jobs: '1' }

const GIT_ID = [
  '-c',
  'user.name=bakeoff',
  '-c',
  'user.email=bakeoff@example.invalid',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'core.hooksPath=/dev/null'
]

/** The child environment: the caller's additions cannot lift the CPU caps. */
function childEnv(extra) {
  const env = { ...cleanEnv(), ...extra, ...CPU_ENV }
  // Set inside a git hook; they would point a child's `git` at another repository.
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[k]
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

/** Run `argv` niced, in its own process group, bounded by `timeoutMs`. Never rejects. */
function runNiced(argv, cwd, { timeoutMs, env }) {
  const started = Date.now()
  return new Promise((done) => {
    const child = spawn('nice', ['-n', '19', ...argv], {
      cwd,
      env: childEnv(env),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d))
    child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d))

    const timer = setTimeout(() => {
      timedOut = true
      // Destroying the pipes frees us from a daemon that left the group and still holds them.
      void escalate([groupOf(child.pid)]).then(() => {
        child.stdout.destroy()
        child.stderr.destroy()
      })
    }, timeoutMs)

    child.once('error', (err) => {
      clearTimeout(timer)
      done({
        exitCode: 127,
        stdout,
        stderr: stderr + err.message,
        timedOut,
        ms: Date.now() - started
      })
    })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      const exitCode = code ?? 128 + (constants.signals[signal] ?? 0)
      done({ exitCode, stdout, stderr, timedOut, ms: Date.now() - started })
    })
  })
}

/**
 * Run one problem command with `sh -c` in `cwd`.
 *
 * @param {string} cmd
 * @param {string} cwd
 * @param {{ timeoutMs?: number, env?: Record<string, string> }} options `env` is added to the cleaned environment
 * @returns {Promise<{ exitCode: number, stdout: string, stderr: string, timedOut: boolean, ms: number }>}
 */
export function runProblemCommand(cmd, cwd, { timeoutMs = limits.commandMs, env = {} } = {}) {
  return runNiced(['sh', '-c', cmd], cwd, { timeoutMs, env })
}

const coded = (code, message, detail) => ({ code, message, detail })

/** `git` in `cwd`; never prompts for credentials, which would hang an unattended round. */
function git(cwd, ...args) {
  return runNiced(['git', ...GIT_ID, ...args], cwd, {
    timeoutMs: limits.commandMs,
    env: { GIT_TERMINAL_PROMPT: '0' }
  })
}

/** Run git commands in order; stop at the first failure and return its output. */
async function gitSteps(cwd, steps) {
  for (const args of steps) {
    const r = await git(cwd, ...args)
    if (r.exitCode !== 0) return r.stderr
  }
  return null
}

const hasCommit = async (mirror, commit) =>
  (await git(mirror, 'cat-file', '-e', `${commit}^{commit}`)).exitCode === 0

/**
 * The bare mirror holding `commit`, fetched on first use. It is built aside and
 * renamed in, so a concurrent unit never sees a partial one.
 *
 * @returns {Promise<{ mirror: string } | { failure: string }>}
 */
async function ensureMirror(repo, commit, cacheRoot) {
  const mirrors = join(cacheRoot, 'mirrors')
  const mirror = join(mirrors, `${createHash('sha256').update(repo).digest('hex')}.git`)
  mkdirSync(mirrors, { recursive: true })

  if (!existsSync(mirror)) {
    const aside = `${mirror}.tmp-${randomUUID()}`
    const failure = await gitSteps(mirrors, [
      ['clone', '-q', '--mirror', repo, aside],
      // Lets a checkout fetch the pin alone, even when no ref points at it.
      ['-C', aside, 'config', 'uploadpack.allowAnySHA1InWant', 'true']
    ])
    if (failure !== null) {
      rmSync(aside, { recursive: true, force: true })
      return { failure }
    }
    try {
      renameSync(aside, mirror)
    } catch {
      // A concurrent unit got there first; its mirror is as good as this one.
      rmSync(aside, { recursive: true, force: true })
    }
  }

  if (await hasCommit(mirror, commit)) return { mirror }
  // A mirror from an earlier pin: refresh it once. The check decides, not fetch's
  // exit code, since a concurrent fetch can fail on a lock after the commit landed.
  const fetched = await git(mirror, 'fetch', '-q', '--prune', 'origin')
  if (await hasCommit(mirror, commit)) return { mirror }
  return { failure: fetched.stderr || 'the commit is not in the mirror' }
}

async function checkoutPinned(target, dest, cacheRoot) {
  const ensured = await ensureMirror(target.repo, target.commit, cacheRoot)
  if ('failure' in ensured) return ensured.failure
  return gitSteps(dest, [
    ['init', '-q', '-b', 'main'],
    // No FETCH_HEAD: it would tell a contestant where the mirror lives.
    ['fetch', '-q', '--no-tags', '--no-write-fetch-head', ensured.mirror, target.commit],
    ['checkout', '-q', '-B', 'main', target.commit]
  ])
}

function checkoutInline(problem, dest) {
  cpSync(join(problem.dir, problem.target.inline), dest, { recursive: true })
  return gitSteps(dest, [
    ['init', '-q', '-b', 'main'],
    // `-f`: the commit holds all of source/, whatever a .gitignore inside it says.
    ['add', '-A', '-f', '.'],
    ['commit', '-q', '--allow-empty', '-m', 'target']
  ])
}

/**
 * Create a checkout of a problem's target at `dest`, which must be empty or absent.
 *
 * @param {object} problem reads `target`, `setup`, and `dir` for an inline target
 * @param {string} dest
 * @param {{ cacheRoot: string, setup?: boolean }} options `setup` false skips `problem.setup`
 * @returns {Promise<{ dir: string, commit: string } | { code: string, message: string, detail: string }>}
 */
export async function checkoutTarget(problem, dest, { cacheRoot, setup = true }) {
  const failed = (detail) => coded('CHECKOUT_FAILED', 'The target checkout failed.', detail)
  let failure
  try {
    if (existsSync(dest) && readdirSync(dest).length > 0)
      return failed('the destination is not empty')
    mkdirSync(dest, { recursive: true })
    failure =
      'inline' in problem.target
        ? await checkoutInline(problem, dest)
        : await checkoutPinned(problem.target, dest, cacheRoot)
  } catch (err) {
    failure = String(err)
  }
  if (failure !== null) return failed(failure)

  const head = await git(dest, 'rev-parse', 'HEAD')
  if (head.exitCode !== 0) return failed(head.stderr)

  if (setup) {
    for (const [i, cmd] of problem.setup.entries()) {
      const r = await runProblemCommand(cmd, dest, { timeoutMs: limits.commandMs })
      if (r.exitCode !== 0) {
        const why = r.timedOut ? 'timed out' : `exited ${r.exitCode}`
        const message = `Setup command ${i + 1} of ${problem.setup.length} ${why}.`
        return coded('SETUP_FAILED', message, r.stdout + r.stderr)
      }
    }
  }
  return { dir: dest, commit: head.stdout.trim() }
}
