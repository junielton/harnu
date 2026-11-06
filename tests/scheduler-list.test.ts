import { describe, it, expect } from 'vitest'
import {
  FOLDER_HUES,
  TICK_COUNT,
  buildFolderGroups,
  chipCounts,
  defaultSelectionId,
  filterEntries,
  folderHue,
  folderInitial,
  matchesSearch,
  nextDueAt,
  runTicks,
  stateFilterFor,
  upNext,
  upNextSummaryOf,
  type ListEntry
} from '../src/renderer/src/components/scheduler-list'
import { workerState } from '../src/renderer/src/components/scheduler-format'
import type { Run, RunStatus, Worker } from '../src/main/scheduler-core'

const MIN = 60_000
const NOW = 10_000_000

function worker(id: string, over: Partial<Worker> = {}): Worker {
  return {
    id,
    name: `worker-${id}`,
    enabled: true,
    prompt: 'check the thing',
    folder: '/org/alpha',
    everyMinutes: 30,
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

function run(workerId: string, status: RunStatus, startedAt: number): Run {
  return {
    workerId,
    startedAt,
    endedAt: startedAt + 1000,
    durationMs: 1000,
    status,
    result: '',
    terminalReason: '',
    numTurns: 1,
    costUsd: 0,
    tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 },
    denials: []
  }
}

/** Build a list entry the way the view does. */
function entry(
  w: Worker,
  opts: { running?: boolean; runs?: Run[]; nowMs?: number } = {}
): ListEntry {
  const runs = opts.runs ?? []
  const running = opts.running ?? false
  const nextAt = nextDueAt(w, runs)
  return {
    worker: w,
    runs,
    running,
    nextAt,
    state: workerState(w, {
      running,
      nextAt,
      lastStatus: runs[runs.length - 1]?.status
    })
  }
}

const info = (path: string): { name: string; branch: string | null } => ({
  name: path.split('/').pop() || '—',
  branch: path.endsWith('alpha') ? 'main' : null
})

describe('folderHue (AC-7 — stable per path)', () => {
  it('draws only from the six-slot pool', () => {
    expect([...FOLDER_HUES]).toEqual([
      'blue',
      'magenta',
      'cyan',
      'yellow',
      'bright-red',
      'bright-blue'
    ])
  })

  it('is FNV-1a(path) % 6 — pinned vectors', () => {
    // FNV-1a("") = 0x811c9dc5 -> 1 (mod 6); FNV-1a("a") = 0xe40c292c -> 4 (mod 6)
    expect(folderHue('')).toBe('magenta')
    expect(folderHue('a')).toBe('bright-red')
  })

  it('is stable across calls and independent of anything but the path', () => {
    expect(folderHue('/org/www')).toBe(folderHue('/org/www'))
    for (const p of ['/x', '/org/a', '/org/b', '/org/portal', '~/y']) {
      expect(FOLDER_HUES).toContain(folderHue(p))
    }
  })
})

describe('folderInitial', () => {
  it('is the first letter, uppercased', () => {
    expect(folderInitial('www · org-a')).toBe('W')
    expect(folderInitial('harnu')).toBe('H')
  })
  it('falls back to a dot for an empty name', () => {
    expect(folderInitial('')).toBe('·')
  })
})

describe('runTicks (AC-5)', () => {
  it('maps status to tick kind, oldest left, newest right', () => {
    const runs = [
      run('a', 'ok', 1),
      run('a', 'error', 2),
      run('a', 'timeout', 3),
      run('a', 'ok', 4)
    ]
    expect(runTicks(runs, false).slice(-4)).toEqual(['ok', 'error', 'timeout', 'ok'])
  })

  it('pads on the left with empty slots up to ten', () => {
    const ticks = runTicks([run('a', 'ok', 1)], false)
    expect(ticks).toHaveLength(TICK_COUNT)
    expect(ticks.slice(0, 9)).toEqual(Array(9).fill('none'))
    expect(ticks[9]).toBe('ok')
  })

  it('keeps only the latest ten runs', () => {
    const runs = Array.from({ length: 14 }, (_, i) => run('a', i < 4 ? 'error' : 'ok', i))
    const ticks = runTicks(runs, false)
    expect(ticks).toHaveLength(10)
    expect(ticks.every((t) => t === 'ok')).toBe(true)
  })

  it('a live tick takes the rightmost slot as `running` and pushes the oldest out', () => {
    const runs = Array.from({ length: 10 }, (_, i) => run('a', i === 0 ? 'error' : 'ok', i))
    const ticks = runTicks(runs, true)
    expect(ticks).toHaveLength(10)
    expect(ticks[9]).toBe('running')
    expect(ticks[0]).toBe('ok') // the oldest (error) fell off
  })

  it('shows skipped and stopped runs as neutral slots, not as failures', () => {
    expect(runTicks([run('a', 'skipped', 1), run('a', 'stopped', 2)], false).slice(-2)).toEqual([
      'none',
      'none'
    ])
  })

  it('a worker that never ran is ten empty slots', () => {
    expect(runTicks([], false)).toEqual(Array(10).fill('none'))
  })
})

describe('nextDueAt', () => {
  it('is the last run start plus the cadence, 0 when it never ran', () => {
    expect(nextDueAt(worker('a'), [run('a', 'ok', 1000), run('a', 'ok', 5000)])).toBe(
      5000 + 30 * MIN
    )
    expect(nextDueAt(worker('a'), [])).toBe(0)
  })
})

describe('state filters (AC-3)', () => {
  it('Failing is failed + disabled; Off is only off', () => {
    expect(stateFilterFor('failed')).toBe('failing')
    expect(stateFilterFor('disabled')).toBe('failing')
    expect(stateFilterFor('off')).toBe('off')
    expect(stateFilterFor('waiting')).toBe('waiting')
    expect(stateFilterFor('running')).toBe('running')
  })

  const entries = [
    entry(worker('w1')), // waiting
    entry(worker('w2'), { running: true }),
    entry(worker('w3'), { runs: [run('w3', 'error', 1)] }), // failed
    entry(worker('w4', { enabled: false, failureStreak: 3 })), // disabled
    entry(worker('w5', { enabled: false })) // off
  ]

  it('chipCounts counts per chip and All is the total', () => {
    expect(chipCounts(entries)).toEqual({ all: 5, running: 1, failing: 2, waiting: 1, off: 1 })
  })

  it('filterEntries by chip keeps only that state; `all` keeps everything', () => {
    const ids = (f: Parameters<typeof filterEntries>[1]['filter']): string[] =>
      filterEntries(entries, { query: '', filter: f, folderName: () => 'alpha' }).map(
        (e) => e.worker.id
      )
    expect(ids('all')).toEqual(['w1', 'w2', 'w3', 'w4', 'w5'])
    expect(ids('failing')).toEqual(['w3', 'w4'])
    expect(ids('off')).toEqual(['w5'])
    expect(ids('running')).toEqual(['w2'])
    expect(ids('waiting')).toEqual(['w1'])
  })
})

describe('search (AC-3)', () => {
  const w = worker('a', { name: 'PR Review Watcher', prompt: 'List open pull requests' })
  it('matches name, folder name, folder path and prompt, case-insensitively', () => {
    expect(matchesSearch(w, 'portal', 'review')).toBe(true)
    expect(matchesSearch(w, 'portal', 'PORTAL')).toBe(true)
    expect(matchesSearch(w, 'portal', '/org/alpha')).toBe(true)
    expect(matchesSearch(w, 'portal', 'pull requests')).toBe(true)
  })
  it('does not match anything else, and a blank query matches all', () => {
    expect(matchesSearch(w, 'portal', 'deploy')).toBe(false)
    expect(matchesSearch(w, 'portal', '   ')).toBe(true)
  })
  it('chip and search combine', () => {
    const list = [entry(worker('x', { name: 'deploy' })), entry(worker('y', { name: 'other' }))]
    const out = filterEntries(list, { query: 'deploy', filter: 'all', folderName: () => 'f' })
    expect(out.map((e) => e.worker.id)).toEqual(['x'])
  })
  it('chip counts follow the search', () => {
    const list = [entry(worker('x', { name: 'deploy' })), entry(worker('y', { name: 'other' }))]
    const searched = filterEntries(list, { query: 'deploy', filter: 'all', folderName: () => 'f' })
    expect(chipCounts(searched).all).toBe(1)
  })
})

describe('buildFolderGroups (AC-1, AC-6)', () => {
  it('groups by folder and counts on / off / running / failing / waiting', () => {
    const groups = buildFolderGroups(
      [
        entry(worker('a', { folder: '/org/alpha' })),
        entry(worker('b', { folder: '/org/alpha', enabled: false })),
        entry(worker('c', { folder: '/org/alpha' }), { runs: [run('c', 'error', NOW - MIN)] }),
        entry(worker('d', { folder: '/org/beta' }), { running: true })
      ],
      info
    )
    const alpha = groups.find((g) => g.path === '/org/alpha')!
    expect(alpha.total).toBe(3)
    expect(alpha.on).toBe(2)
    expect(alpha.off).toBe(1)
    expect(alpha.failing).toBe(1)
    expect(alpha.running).toBe(0)
    expect(alpha.branch).toBe('main')
    expect(alpha.initial).toBe('A')
    const beta = groups.find((g) => g.path === '/org/beta')!
    expect(beta.running).toBe(1)
    expect(beta.branch).toBeNull()
  })

  it('keeps folders alphabetical by name, then path — running or failing never moves a folder (AC-10)', () => {
    const groups = buildFolderGroups(
      [
        entry(worker('1', { folder: '/org/zeta' })),
        entry(worker('2', { folder: '/org/beta' })),
        entry(worker('3', { folder: '/org/gamma' }), { running: true }),
        entry(worker('4', { folder: '/org/omega' }), { runs: [run('4', 'timeout', 1)] }),
        entry(worker('5', { folder: '/org/alpha' }))
      ],
      info
    )
    expect(groups.map((g) => g.name)).toEqual(['alpha', 'beta', 'gamma', 'omega', 'zeta'])
  })

  it('breaks a name tie by path (AC-10)', () => {
    const groups = buildFolderGroups(
      [
        entry(worker('1', { folder: '/org-b/www' })),
        entry(worker('2', { folder: '/org-a/www' }), { running: true })
      ],
      info
    )
    expect(groups.map((g) => g.path)).toEqual(['/org-a/www', '/org-b/www'])
  })

  it('a folder keeps its place when a worker starts running or fails (AC-10)', () => {
    const idle = [
      entry(worker('1', { folder: '/org/alpha' })),
      entry(worker('2', { folder: '/org/zeta' }))
    ]
    const busy = [
      entry(worker('1', { folder: '/org/alpha' })),
      entry(worker('2', { folder: '/org/zeta' }), { running: true })
    ]
    expect(buildFolderGroups(busy, info).map((g) => g.path)).toEqual(
      buildFolderGroups(idle, info).map((g) => g.path)
    )
  })

  it('sorts a pinned worker first inside its folder, by pinnedAt, then storage order (AC-6)', () => {
    const groups = buildFolderGroups(
      [
        entry(worker('a')),
        entry(worker('b', { pinnedAt: 300 })),
        entry(worker('c')),
        entry(worker('d', { pinnedAt: 100 }))
      ],
      info
    )
    expect(groups[0].entries.map((e) => e.worker.id)).toEqual(['d', 'b', 'a', 'c'])
  })

  it('sorts enabled workers above off workers inside a folder (AC-9)', () => {
    const groups = buildFolderGroups(
      [
        entry(worker('a', { enabled: false })),
        entry(worker('b')),
        entry(worker('c', { enabled: false })),
        entry(worker('d'))
      ],
      info
    )
    expect(groups[0].entries.map((e) => e.worker.id)).toEqual(['b', 'd', 'a', 'c'])
  })

  it('pins sort first inside each band: pinned on, on, pinned off, off (AC-9)', () => {
    const groups = buildFolderGroups(
      [
        entry(worker('a', { enabled: false })),
        entry(worker('b', { enabled: false, pinnedAt: 50 })),
        entry(worker('c')),
        entry(worker('d', { pinnedAt: 200 })),
        entry(worker('e', { pinnedAt: 100 })),
        entry(worker('f', { enabled: false, pinnedAt: 10 }))
      ],
      info
    )
    expect(groups[0].entries.map((e) => e.worker.id)).toEqual(['e', 'd', 'c', 'f', 'b', 'a'])
  })

  it('running, waiting and failing never move a row — only enabled and pinnedAt do (AC-9)', () => {
    const idle = [entry(worker('a')), entry(worker('b')), entry(worker('c'))]
    const busy = [
      entry(worker('a')),
      entry(worker('b'), { running: true }),
      entry(worker('c'), { runs: [run('c', 'error', 1)] })
    ]
    const ids = (list: ListEntry[]): string[] =>
      buildFolderGroups(list, info)[0].entries.map((e) => e.worker.id)
    expect(ids(busy)).toEqual(ids(idle))
    expect(ids(busy)).toEqual(['a', 'b', 'c'])
  })

  it('a pinned OFF worker still lives in its folder, not in a separate group (AC-6)', () => {
    const groups = buildFolderGroups([entry(worker('a', { enabled: false, pinnedAt: 1 }))], info)
    expect(groups).toHaveLength(1)
    expect(groups[0].entries[0].state).toBe('off')
  })

  it('summary: running now > next in X > nothing scheduled', () => {
    const run1 = buildFolderGroups([entry(worker('a'), { running: true })], info)[0]
    expect(run1.summary).toEqual({ kind: 'running' })

    const next = buildFolderGroups(
      [
        entry(worker('a'), { runs: [run('a', 'ok', NOW - 10 * MIN)] }), // due in 20m
        entry(worker('b'), { runs: [run('b', 'ok', NOW - 25 * MIN)] }) // due in 5m
      ],
      info
    )[0]
    expect(next.summary).toEqual({ kind: 'next', nextAt: NOW + 5 * MIN })

    const none = buildFolderGroups([entry(worker('a', { enabled: false }))], info)[0]
    expect(none.summary).toEqual({ kind: 'none' })
  })

  it('health proportions sum to 1 and follow the states', () => {
    const g = buildFolderGroups(
      [
        entry(worker('a')),
        entry(worker('b')),
        entry(worker('c'), { runs: [run('c', 'error', 1)] }),
        entry(worker('d', { enabled: false }))
      ],
      info
    )[0]
    expect(g.health).toEqual({ running: 0, failing: 0.25, waiting: 0.5, off: 0.25 })
  })

  it('carries a stable hue class per path', () => {
    const g = buildFolderGroups([entry(worker('a'))], info)[0]
    expect(g.hue).toBe(folderHue('/org/alpha'))
  })
})

describe('defaultSelectionId', () => {
  it('is the first row of the first folder in display order', () => {
    const groups = buildFolderGroups(
      [
        entry(worker('a', { folder: '/org/zeta' })),
        entry(worker('b', { folder: '/org/alpha' })),
        entry(worker('c', { folder: '/org/alpha', pinnedAt: 1 }))
      ],
      info
    )
    expect(defaultSelectionId(groups)).toBe('c')
  })
  it('follows the fixed folder order — a running folder further down is not selected (AC-10)', () => {
    const groups = buildFolderGroups(
      [
        entry(worker('a', { folder: '/org/alpha' })),
        entry(worker('z', { folder: '/org/zeta' }), { running: true })
      ],
      info
    )
    expect(defaultSelectionId(groups)).toBe('a')
  })
  it('lands on the first enabled worker when the stored first one is off (AC-9)', () => {
    const groups = buildFolderGroups(
      [entry(worker('off', { enabled: false })), entry(worker('on'))],
      info
    )
    expect(defaultSelectionId(groups)).toBe('on')
  })
  it('is null for an empty list', () => {
    expect(defaultSelectionId([])).toBeNull()
  })
})

describe('upNext (AC-4)', () => {
  it('lists the next four due runs across folders, running first, then soonest', () => {
    const list = [
      entry(worker('a', { folder: '/org/f1' }), { runs: [run('a', 'ok', NOW - 20 * MIN)] }), // 10m
      entry(worker('b', { folder: '/org/f2' }), { runs: [run('b', 'ok', NOW - 29 * MIN)] }), // 1m
      entry(worker('c', { folder: '/org/f3' }), { running: true }),
      entry(worker('d', { folder: '/org/f4' }), { runs: [run('d', 'ok', NOW - 5 * MIN)] }), // 25m
      entry(worker('e', { folder: '/org/f5' }), { runs: [run('e', 'ok', NOW - 28 * MIN)] }), // 2m
      entry(worker('f', { folder: '/org/f6' }), { runs: [run('f', 'ok', NOW - 1 * MIN)] }) // 29m
    ]
    const out = upNext(list, NOW, 4)
    expect(out.map((u) => u.worker.id)).toEqual(['c', 'b', 'e', 'a'])
    expect(out[0].now).toBe(true)
    expect(out[1].now).toBe(false)
    expect(out[1].inMs).toBe(MIN)
  })

  it('never lists off or auto-disabled workers, and an overdue worker reads as now', () => {
    const list = [
      entry(worker('a', { enabled: false })),
      entry(worker('b', { enabled: false, failureStreak: 3 })),
      entry(worker('c'), { runs: [run('c', 'ok', NOW - 90 * MIN)] })
    ]
    const out = upNext(list, NOW)
    expect(out.map((u) => u.worker.id)).toEqual(['c'])
    expect(out[0].now).toBe(true)
  })

  it('a run due in under a second already reads as now, never "0s"', () => {
    const out = upNext([entry(worker('a'), { runs: [run('a', 'ok', NOW - 30 * MIN + 400)] })], NOW)
    expect(out[0].now).toBe(true)
    expect(out[0].inMs).toBe(0)
  })

  it('a failed-but-armed worker is still due', () => {
    const out = upNext([entry(worker('a'), { runs: [run('a', 'error', NOW - 10 * MIN)] })], NOW)
    expect(out).toHaveLength(1)
  })

  it('the collapsed strip summarises the single next run', () => {
    const out = upNext([entry(worker('c', { name: 'Delivery watchdog' }), { running: true })], NOW)
    expect(upNextSummaryOf(out)).toBe(out[0])
    expect(upNextSummaryOf([])).toBeNull()
  })
})
