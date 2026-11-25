#!/usr/bin/env node
/**
 * Wraps the fake `claude` to record what only the process itself can see: its niceness, its
 * environment, what its working directory holds when it starts and ends, and when.
 *
 * Environment:
 * - S5_OBSERVE_LOG    one JSON line per event: { event: start | end, pid, cwd, argv, files, nice, env, t, barrierMet }
 * - S5_FAKE_CLAUDE    the fake to run
 * - S5_BARRIER_DIR, S5_BARRIER_COUNT   optional: the first COUNT sessions wait for each other, so a
 *                     test proves sessions overlap without betting on timing
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { getPriority } from 'node:os'
import { join, relative } from 'node:path'

const BARRIER_TIMEOUT_MS = 60_000
const argv = process.argv.slice(2)
const cwd = process.cwd()

function filesUnder(dir) {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...filesUnder(full))
    else found.push(relative(cwd, full))
  }
  return found.sort()
}

function log(event, extra = {}) {
  const line = {
    event,
    pid: process.pid,
    cwd,
    argv,
    files: filesUnder(cwd),
    t: Date.now(),
    ...extra
  }
  appendFileSync(process.env.S5_OBSERVE_LOG, `${JSON.stringify(line)}\n`)
}

/** True when this session held a barrier slot and every slot filled in time. */
async function awaitBarrier() {
  const dir = process.env.S5_BARRIER_DIR
  const count = Number.parseInt(process.env.S5_BARRIER_COUNT ?? '', 10)
  if (!dir || !Number.isInteger(count)) return null
  mkdirSync(dir, { recursive: true })
  let held = false
  for (let slot = 0; slot < count && !held; slot++) {
    try {
      mkdirSync(join(dir, `slot-${slot}`))
      held = true
    } catch {
      /* taken */
    }
  }
  if (!held) return null
  const slots = Array.from({ length: count }, (_, slot) => join(dir, `slot-${slot}`))
  const deadline = Date.now() + BARRIER_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (slots.every((slot) => existsSync(slot))) return true
    await new Promise((done) => setTimeout(done, 20))
  }
  return false
}

const { GOMAXPROCS, PYTEST_ADDOPTS, npm_config_jobs } = process.env
log('start', { nice: getPriority(), env: { GOMAXPROCS, PYTEST_ADDOPTS, npm_config_jobs } })
const barrierMet = await awaitBarrier()

const child = spawn(process.execPath, [process.env.S5_FAKE_CLAUDE, ...argv], { stdio: 'inherit' })
child.on('close', (code, signal) => {
  log('end', { barrierMet })
  process.exitCode = code ?? (signal ? 1 : 0)
})
