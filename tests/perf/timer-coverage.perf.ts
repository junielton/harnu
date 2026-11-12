/**
 * Every `setInterval` in `src/main` has a perf decision (T697, performance contract P3/P8).
 *
 * A periodic job is either measured by a case in `cases.ts` (`COVERED`) or listed in `UNCOVERED` with
 * the reason it is not yet. Adding a timer, or a second one in a listed file, fails this test until
 * someone makes that choice in the same diff: that is what keeps the suite's list of jobs from rotting.
 * The job registry (a separate card) replaces this file-level list with a declaration per job.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ALL_CASES } from './cases'

const SRC = join(__dirname, '..', '..', 'src', 'main')

/** file → [timer count, the case ids that measure it]. */
const COVERED: Record<string, [number, string[]]> = {
  'your-move/ipc.ts': [1, ['main/your-move-gate-tick', 'main/your-move-mid-turn-sweep']],
  'pty.ts': [1, ['main/hibernation-mission-owners', 'main/main-checkout-root']]
}

const NO_FLEET_INPUT =
  'polls one remote endpoint or one small file: cost does not grow with the fleet'
const FOLLOW_UP = 'not measured yet: needs its own case (job-registry follow-up)'

/** file → [timer count, why it has no case]. */
const UNCOVERED: Record<string, [number, string]> = {
  'updater.ts': [1, NO_FLEET_INPUT],
  'usage.ts': [1, NO_FLEET_INPUT],
  'claude-status.ts': [1, NO_FLEET_INPUT],
  'claude-changelog.ts': [1, NO_FLEET_INPUT],
  'statusline.ts': [1, NO_FLEET_INPUT],
  'monitor/loop-probe.ts': [
    1,
    'the stall monitor heartbeat: its overhead is measured in tests/perf/monitor-overhead.perf.ts'
  ],
  'monitor/stall-watchdog.ts': [
    1,
    'the watchdog worker poll (a separate thread): its overhead is measured in tests/perf/monitor-overhead.perf.ts'
  ],
  'monitor/sampler.ts': [
    2,
    'the monitor itself: its overhead is measured in tests/perf/monitor-overhead.perf.ts'
  ],
  'companion/host-core.ts': [1, 'lease sweep over the live sessions only (15)'],
  'companion/external-host.ts': [1, 'lease sweep over the live sessions only (15)'],
  'companion/command-channel.ts': [1, 'sweep over the live sessions only (15)'],
  'companion/host.ts': [
    2,
    'ledger tick and a 30 s intercept refresh over the live sessions only (15)'
  ],
  'companion/review-selection-tracker.ts': [1, 'one refresh per open review pane'],
  'browser/view-host.ts': [1, 'sweep over the open browser panes (at most 4 per folder)'],
  'fleet-model.ts': [1, `degraded-watcher poll of the whole fleet scan; ${FOLLOW_UP}`],
  'memory-digest.ts': [1, `digest catch-up over every repo's memory; ${FOLLOW_UP}`],
  'companion/mission-state.ts': [1, `reads every open mission; ${FOLLOW_UP}`],
  'scheduler-shell.ts': [1, `scheduler ticker over every worker; ${FOLLOW_UP}`],
  'containers/containers-ipc.ts': [1, `docker scan (child processes); ${FOLLOW_UP}`],
  'gc/capacity-watcher.ts': [1, `docker network capacity (child processes); ${FOLLOW_UP}`],
  'reaper/reaper-ipc.ts': [
    1,
    `cleanup scan over every worktree (git child processes); ${FOLLOW_UP}`
  ]
}

function listTs(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...listTs(full))
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(full)
  }
  return out
}

function timersByFile(): Record<string, number> {
  const found: Record<string, number> = {}
  for (const file of listTs(SRC)) {
    const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
    const count = (text.match(/\bsetInterval\s*\(/g) ?? []).length
    if (count > 0) found[relative(SRC, file)] = count
  }
  return found
}

describe('every periodic main-process job has a perf decision', () => {
  const found = timersByFile()
  const known = {
    ...Object.fromEntries(Object.entries(COVERED).map(([f, [n]]) => [f, n])),
    ...Object.fromEntries(Object.entries(UNCOVERED).map(([f, [n]]) => [f, n]))
  }

  it('no setInterval is unclassified or has gone missing from its listing', () => {
    expect(found).toEqual(known)
  })

  it('a covered file names cases that exist', () => {
    const ids = new Set(ALL_CASES.map((c) => c.id))
    for (const [file, [, cases]] of Object.entries(COVERED)) {
      for (const id of cases) expect(ids.has(id), `${file} → ${id}`).toBe(true)
    }
  })

  it('a file is never both covered and uncovered', () => {
    for (const f of Object.keys(COVERED)) expect(UNCOVERED[f]).toBeUndefined()
  })
})
