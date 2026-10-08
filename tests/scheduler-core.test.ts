import { describe, it, expect } from 'vitest'
import {
  capResult,
  dueWorkers,
  newWorker,
  nextRunAt,
  nextFailureState,
  resolveNotifyOn,
  runNotificationText,
  shouldNotifyRun,
  RUN_RESULT_LIMIT,
  OBSERVE_MCP_ALLOW,
  OBSERVE_MCP_DENY,
  type Run,
  type RunStatus,
  type Worker
} from '../src/main/scheduler-core'

const T0 = Date.parse('2026-09-07T14:00:00.000Z')

function worker(over: Partial<Worker> = {}): Worker {
  return {
    id: 'w1',
    name: 'PR watcher',
    enabled: true,
    prompt: 'check for new PRs',
    folder: '/repo',
    everyMinutes: 5,
    runOnBoot: false,
    model: 'haiku',
    effort: 'low',
    mode: 'observe',
    timeoutSeconds: 300,
    carryLastResult: false,
    failureStreak: 0,
    ...over
  }
}

// The security lists must hold under BOTH tool-name prefixes: `mcp__harnu__` is
// what a tick registers now, `mcp__capy__` is the pre-rename form that a stale
// prompt, a saved rule or a legacy-named server could still present.
const PREFIXES = ['mcp__harnu__', 'mcp__capy__'] as const

const ALLOWED_VERBS = [
  'memory_read',
  'memory_query',
  'get_fleet',
  'get_session',
  'list_worktrees',
  'list_containers',
  'list_cleanup',
  'mission_get',
  'mission_list',
  'create_card',
  'update_card',
  'notify'
]

const DENIED_VERBS = [
  'create_session',
  'create_worktree',
  'spawn_terminal',
  'submit_manifest',
  'adopt_folder',
  'remove_folder',
  'move_card',
  'delete_card',
  'message_session',
  'memory_append',
  'draw_canvas',
  'create_worker',
  'list_workers',
  'orchestrator_arm',
  'orchestrator_disarm',
  'stop_containers',
  'start_containers',
  'remove_containers',
  'release_worktree',
  'mission_create',
  'mission_add_step',
  'mission_update_step',
  'mission_link_child',
  'mission_log',
  'mission_set_blocker',
  'mission_clear_blocker',
  'mission_set_end',
  'mission_verify_step',
  'mission_request_close',
  'mission_import_legacy',
  'mission_add_check'
]

describe('observe-mode MCP allowlist', () => {
  it.each(PREFIXES)('lets an observe tick list containers (T328) — %s', (prefix) => {
    expect(OBSERVE_MCP_ALLOW).toContain(`${prefix}list_containers`)
    expect(OBSERVE_MCP_DENY).not.toContain(`${prefix}list_containers`)
  })

  it.each(PREFIXES)(
    'lets an observe tick read the cleanup list but not release (T445) — %s',
    (prefix) => {
      expect(OBSERVE_MCP_ALLOW).toContain(`${prefix}list_cleanup`)
      expect(OBSERVE_MCP_DENY).not.toContain(`${prefix}list_cleanup`)
      expect(OBSERVE_MCP_DENY).toContain(`${prefix}release_worktree`)
      expect(OBSERVE_MCP_ALLOW).not.toContain(`${prefix}release_worktree`)
    }
  )

  it.each(PREFIXES)('denies every Containers action to an observe tick (T329) — %s', (prefix) => {
    for (const op of ['stop_containers', 'start_containers', 'remove_containers']) {
      expect(OBSERVE_MCP_DENY).toContain(`${prefix}${op}`)
      expect(OBSERVE_MCP_ALLOW).not.toContain(`${prefix}${op}`)
    }
  })

  it.each(PREFIXES)('lets an observe tick read missions (T369) — %s', (prefix) => {
    for (const op of ['mission_get', 'mission_list']) {
      expect(OBSERVE_MCP_ALLOW).toContain(`${prefix}${op}`)
      expect(OBSERVE_MCP_DENY).not.toContain(`${prefix}${op}`)
    }
  })

  it.each(PREFIXES)('denies every mission write to an observe tick (T369) — %s', (prefix) => {
    const writes = [
      'mission_create',
      'mission_add_step',
      'mission_update_step',
      'mission_link_child',
      'mission_log',
      'mission_set_blocker',
      'mission_clear_blocker',
      'mission_set_end',
      'mission_verify_step',
      'mission_request_close',
      'mission_import_legacy',
      'mission_add_check'
    ]
    for (const op of writes) {
      expect(OBSERVE_MCP_DENY).toContain(`${prefix}${op}`)
      expect(OBSERVE_MCP_ALLOW).not.toContain(`${prefix}${op}`)
    }
  })

  it('never names a verb as both allowed and denied', () => {
    expect(OBSERVE_MCP_ALLOW.filter((v) => OBSERVE_MCP_DENY.includes(v))).toEqual([])
  })

  // AC-3: the lists are generated from one verb list per side, so the two
  // prefixes can never drift apart. Pinned EXACTLY (not just "contains"), so an
  // observe worker neither loses an allowed verb nor gains a denied one under
  // either prefix — and a verb added to one list but not both fails here.
  it('allows exactly the allowed verbs, under both prefixes and nothing else', () => {
    const expected = PREFIXES.flatMap((p) => ALLOWED_VERBS.map((v) => `${p}${v}`))
    expect([...OBSERVE_MCP_ALLOW].sort()).toEqual([...expected].sort())
  })

  it('denies exactly the denied verbs, under both prefixes and nothing else', () => {
    const expected = PREFIXES.flatMap((p) => DENIED_VERBS.map((v) => `${p}${v}`))
    expect([...OBSERVE_MCP_DENY].sort()).toEqual([...expected].sort())
  })

  it('lists every verb under both prefixes symmetrically (no one-sided entry)', () => {
    for (const list of [OBSERVE_MCP_ALLOW, OBSERVE_MCP_DENY]) {
      const bare = (prefix: string): string[] =>
        list.filter((v) => v.startsWith(prefix)).map((v) => v.slice(prefix.length))
      expect(bare('mcp__capy__').sort()).toEqual(bare('mcp__harnu__').sort())
    }
  })

  it('has no duplicate entries', () => {
    expect(new Set(OBSERVE_MCP_ALLOW).size).toBe(OBSERVE_MCP_ALLOW.length)
    expect(new Set(OBSERVE_MCP_DENY).size).toBe(OBSERVE_MCP_DENY.length)
  })
})

describe('nextRunAt', () => {
  it('adds the cadence to the last run', () => {
    expect(nextRunAt(worker(), T0)).toBe(T0 + 5 * 60_000)
  })

  it('a worker that never ran is due immediately', () => {
    expect(nextRunAt(worker(), undefined)).toBe(0)
  })
})

describe('dueWorkers', () => {
  it('returns a worker whose cadence has elapsed', () => {
    const w = worker()
    expect(dueWorkers([w], { w1: T0 }, [], T0 + 5 * 60_000)).toEqual([w])
  })

  it('does not return one whose cadence has not elapsed', () => {
    expect(dueWorkers([worker()], { w1: T0 }, [], T0 + 60_000)).toEqual([])
  })

  it('never returns a disabled worker', () => {
    expect(dueWorkers([worker({ enabled: false })], {}, [], T0)).toEqual([])
  })

  it('skips a worker that is already running — no queueing', () => {
    expect(dueWorkers([worker()], { w1: T0 }, ['w1'], T0 + 10 * 60_000)).toEqual([])
  })

  it('honours the global ceiling of 2 concurrent ticks', () => {
    const ws = [worker({ id: 'a' }), worker({ id: 'b' }), worker({ id: 'c' })]
    expect(dueWorkers(ws, {}, ['x'], T0).map((w) => w.id)).toEqual(['a'])
  })

  it('returns nothing when the ceiling is already full', () => {
    expect(dueWorkers([worker()], {}, ['x', 'y'], T0)).toEqual([])
  })
})

describe('nextFailureState', () => {
  it('a success resets the streak', () => {
    expect(nextFailureState(2, 'ok')).toEqual({ streak: 0, disable: false })
  })

  it('the third consecutive failure disables the worker', () => {
    expect(nextFailureState(2, 'error')).toEqual({ streak: 3, disable: true })
  })

  it('a timeout counts as a failure', () => {
    expect(nextFailureState(0, 'timeout')).toEqual({ streak: 1, disable: false })
  })

  it('an operator stop is not a failure and does not touch the streak', () => {
    expect(nextFailureState(2, 'stopped')).toEqual({ streak: 2, disable: false })
  })

  it('a skipped tick is not a failure either', () => {
    expect(nextFailureState(1, 'skipped')).toEqual({ streak: 1, disable: false })
  })
})

/**
 * Regression: a worker began ticking before it was ever configured.
 *
 * `scheduler:save` used to arm a new worker (`enabled: true`) and `nextRunAt`
 * reports a never-run worker as due at `0`, so the very next 30s beat spawned
 * `claude -p ''` against the empty prompt the form opens with. That errors, and
 * three errors disable a worker — so it switched itself off inside 90 seconds,
 * while the operator was still typing its name.
 *
 * Two independent gates close it, and both are asserted here: a worker with no
 * prompt is never due, and a new worker is not armed in the first place.
 */
describe('dueWorkers — a worker nobody has finished configuring', () => {
  it('never returns a worker whose prompt is empty', () => {
    expect(dueWorkers([worker({ prompt: '' })], {}, [], T0)).toEqual([])
  })

  it('never returns a worker whose prompt is only whitespace', () => {
    expect(dueWorkers([worker({ prompt: '   \n\t ' })], {}, [], T0)).toEqual([])
  })

  it('does not return a brand-new worker — armed, never run, nothing typed', () => {
    const fresh = { ...newWorker('w1'), enabled: true }
    expect(dueWorkers([fresh], {}, [], T0)).toEqual([])
  })

  it('does not let a blank worker consume a concurrency slot', () => {
    const blank = worker({ id: 'a', prompt: '' })
    const real = worker({ id: 'b' })
    expect(dueWorkers([blank, real], {}, [], T0).map((w) => w.id)).toEqual(['b'])
  })

  // Control: the gate must not cost the feature it sits next to. A configured
  // worker with no recorded run is still due immediately — that is the whole
  // point of `nextRunAt` returning 0, and it must survive the fix.
  it('still returns an armed worker the moment it HAS a prompt', () => {
    const ready = { ...newWorker('w1'), enabled: true, prompt: 'check for new PRs' }
    expect(dueWorkers([ready], {}, [], T0)).toEqual([ready])
  })
})

describe('newWorker', () => {
  it('is born disarmed — creating is not arming', () => {
    expect(newWorker('w1').enabled).toBe(false)
  })

  it('is born with nothing to run', () => {
    expect(newWorker('w1').prompt).toBe('')
  })

  it('carries the id it was given', () => {
    expect(newWorker('abc').id).toBe('abc')
  })
})

// ── T304: the per-run notification setting ──────────────────────────────────

/** Every terminal status a tick can end in, so no state is silently untested. */
const ALL_STATUSES: RunStatus[] = ['ok', 'error', 'timeout', 'skipped', 'stopped']

describe('resolveNotifyOn', () => {
  it('defaults a brand-new worker to silent', () => {
    expect(newWorker('w1').notifyOn).toBe('silent')
    expect(resolveNotifyOn(newWorker('w1'))).toBe('silent')
  })

  it('resolves a worker persisted before the field to silent', () => {
    // The whole additive claim: an existing `schedulers.json` has no `notifyOn`,
    // and reading one must not turn a quiet worker into a chatty one.
    expect(resolveNotifyOn({ notifyOn: undefined })).toBe('silent')
  })

  it('resolves a value that is not one of the three to silent', () => {
    expect(resolveNotifyOn({ notifyOn: 'loud' as never })).toBe('silent')
  })

  it('has exactly three states', () => {
    const seen = new Set(
      (['silent', 'failure', 'every'] as const).map((v) => resolveNotifyOn({ notifyOn: v }))
    )
    expect([...seen].sort()).toEqual(['every', 'failure', 'silent'])
  })
})

describe('shouldNotifyRun', () => {
  it('silent notifies about no tick at all — the terminal cases stay elsewhere', () => {
    for (const status of ALL_STATUSES) {
      expect(shouldNotifyRun({ notifyOn: 'silent' }, status)).toBe(false)
    }
  })

  it('a worker with no setting at all behaves exactly like silent', () => {
    for (const status of ALL_STATUSES) {
      expect(shouldNotifyRun({ notifyOn: undefined }, status)).toBe(false)
    }
  })

  it('on failure: error and timeout notify', () => {
    expect(shouldNotifyRun({ notifyOn: 'failure' }, 'error')).toBe(true)
    expect(shouldNotifyRun({ notifyOn: 'failure' }, 'timeout')).toBe(true)
  })

  it('on failure: a successful tick stays quiet', () => {
    expect(shouldNotifyRun({ notifyOn: 'failure' }, 'ok')).toBe(false)
  })

  it('on failure: stopped is an operator action, not a failure', () => {
    // Same posture `nextFailureState` takes — pressing Stop must not read back
    // as the worker misbehaving.
    expect(shouldNotifyRun({ notifyOn: 'failure' }, 'stopped')).toBe(false)
    expect(nextFailureState(0, 'stopped').disable).toBe(false)
  })

  it('on failure: skipped never ran, so there is nothing to report', () => {
    expect(shouldNotifyRun({ notifyOn: 'failure' }, 'skipped')).toBe(false)
  })

  it('every run: a completed tick notifies, in success and in failure', () => {
    expect(shouldNotifyRun({ notifyOn: 'every' }, 'ok')).toBe(true)
    expect(shouldNotifyRun({ notifyOn: 'every' }, 'error')).toBe(true)
    expect(shouldNotifyRun({ notifyOn: 'every' }, 'timeout')).toBe(true)
  })

  it('every run: a skipped tick still does NOT notify — it never ran', () => {
    expect(shouldNotifyRun({ notifyOn: 'every' }, 'skipped')).toBe(false)
  })

  it('every run: stopped stays inert too', () => {
    expect(shouldNotifyRun({ notifyOn: 'every' }, 'stopped')).toBe(false)
  })
})

function run(over: Partial<Run> = {}): Run {
  return {
    workerId: 'w1',
    startedAt: 1,
    endedAt: 2,
    durationMs: 1,
    status: 'ok',
    result: '',
    terminalReason: '',
    numTurns: 0,
    costUsd: 0,
    tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 },
    denials: [],
    ...over
  }
}

describe('runNotificationText', () => {
  it('leads with what the worker said when it succeeded', () => {
    expect(runNotificationText(run({ result: 'PR 292 opened' }))).toBe('PR 292 opened')
  })

  it('says so plainly when a successful tick said nothing', () => {
    expect(runNotificationText(run())).toBe('Finished with no result.')
  })

  it('leads with why when it failed', () => {
    const text = runNotificationText(run({ status: 'error', terminalReason: 'unparseable' }))
    expect(text).toBe('error (unparseable)')
  })

  it('falls back to the status when the process gave no reason', () => {
    expect(runNotificationText(run({ status: 'timeout' }))).toBe('timeout (timeout)')
  })

  it('is a glance, never a transcript', () => {
    const text = runNotificationText(run({ result: 'x'.repeat(5000) }))
    expect(text.length).toBeLessThanOrEqual(240)
  })
})

describe('capResult', () => {
  it('leaves an ordinary result alone', () => {
    expect(capResult('PR 292 opened')).toBe('PR 292 opened')
  })

  it('caps a chatty one at the stored limit', () => {
    expect(capResult('x'.repeat(RUN_RESULT_LIMIT + 500))).toHaveLength(RUN_RESULT_LIMIT)
  })
})
