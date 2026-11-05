// The pause planner and executor behind the Docker slot (autonomous cleanup U3.5, AC-3, AC-5): the
// facts it gathers, the stacks it leaves alone, refusals versus real failures, and one Activity line
// per pause.

import { describe, expect, it } from 'vitest'
import {
  createParkPlanner,
  pauseOutcomeToDocker,
  type ParkPlannerDeps
} from '../src/main/gc/park-cycle'
import { defaultGcPrefs, type GcPrefs } from '../src/main/gc/gc-prefs'
import type { StackActivity } from '../src/main/containers/docker-activity-core'
import type { PauseDecision, PauseOutcome } from '../src/main/containers/park-core'
import type { PausedRecord, Tombstone } from '../src/main/containers/containers-wire'
import { HOUR, NOW, available, containerRow, stackRow, WT } from './containers-fixtures'
import { bundle } from './gc-fixtures'

const record: PausedRecord = {
  project: 'shop',
  workingDir: WT,
  configFiles: [],
  profiles: [],
  envFile: null,
  hasBuild: false,
  ports: [8080],
  restoreCommand: 'docker compose -p shop --project-directory /wt up -d',
  pausedAt: NOW
}
const pausedOk: PauseOutcome = {
  ok: true,
  outcome: 'paused',
  record,
  tombstone: {} as Tombstone
}
const refused = (code: Extract<PauseOutcome, { ok: false }>['code']): PauseOutcome => ({
  ok: false,
  outcome: 'refused',
  code,
  message: `refused: ${code}`
})

const quiet = (project: string, over: Partial<StackActivity> = {}): StackActivity => ({
  project,
  cpuPercent: 0,
  netBytes: 0,
  blockBytes: 0,
  ioBytesPerSec: 0,
  restarted: false,
  active: false,
  ...over
})

const idleStack = (
  id = 'shop',
  over: Parameters<typeof stackRow>[0] extends infer T ? Partial<T> : never = {}
) =>
  stackRow({
    id,
    verdict: 'zombie',
    lastSessionActivityAt: NOW - 3 * HOUR,
    lastContainerEventAt: NOW - 4 * HOUR,
    containers: [containerRow({ id: `${id}-c1`, startedAt: NOW - 4 * HOUR, ports: [8080] })],
    ...over
  })

interface Rig {
  deps: ParkPlannerDeps
  paused: Array<{ d: PauseDecision; actor: string }>
  lines: Array<{ title: string; body: string }>
  reads: { activity: number; established: number }
}

function rig(over: Partial<ParkPlannerDeps> = {}, prefs: GcPrefs = defaultGcPrefs()): Rig {
  const r: Rig = {
    deps: undefined as never,
    paused: [],
    lines: [],
    reads: { activity: 0, established: 0 }
  }
  r.deps = {
    prefs: () => prefs,
    bundles: () => [bundle(WT, 'review', { stackIds: ['shop'] })],
    snapshot: async () => available([idleStack()]),
    journal: async () => [],
    activity: async () => {
      r.reads.activity++
      return [quiet('shop')]
    },
    paneUrls: () => [],
    established: async () => {
      r.reads.established++
      return new Map()
    },
    pause: async (d, actor) => {
      r.paused.push({ d, actor })
      return pausedOk
    },
    activityLine: (n) => r.lines.push(n),
    now: () => NOW,
    ...over
  }
  return r
}

describe('plan', () => {
  it('plans one park action for an idle stack, with the reason', async () => {
    const r = rig()
    expect(await createParkPlanner(r.deps).plan()).toEqual([
      { kind: 'park', id: 'shop', reason: 'idle 3 h' }
    ])
  })

  it('owns only the park kind', () => {
    const p = createParkPlanner(rig().deps)
    expect(p.owns('park')).toBe(true)
    expect(p.owns('prune-network')).toBe(false)
    expect(p.owns('remove-orphan')).toBe(false)
  })

  it.each([
    ['the snapshot is unavailable', { snapshot: async () => null }],
    [
      'docker is down',
      {
        snapshot: async () => ({
          ...available([]),
          dockerAvailable: false as const,
          dockerError: 'down'
        })
      }
    ],
    ['the journal cannot be read (the hourly cap is unknowable)', { journal: async () => null }],
    ['the CPU/IO read failed', { activity: async () => null }],
    ['the connection probe failed', { established: async () => null }]
  ] as Array<[string, Partial<ParkPlannerDeps>]>)('plans nothing when %s', async (_n, over) => {
    expect(await createParkPlanner(rig(over).deps).plan()).toEqual([])
  })

  it('reads nothing slow when no stack could be paused', async () => {
    const r = rig({
      snapshot: async () => available([idleStack('main', { verdict: 'protected' })])
    })
    expect(await createParkPlanner(r.deps).plan()).toEqual([])
    expect(r.reads).toEqual({ activity: 0, established: 0 })
  })

  it('leaves alone a stack that is not running, not compose, or has no linked worktree bundle', async () => {
    const notRunning = idleStack('cold', {
      containers: [containerRow({ running: false, startedAt: NOW - 4 * HOUR })]
    })
    const standalone = idleStack('lone', { kind: 'container', project: null })
    const unlinked = idleStack('stray')
    const r = rig({
      snapshot: async () => available([notRunning, standalone, unlinked]),
      activity: async () => [quiet('cold'), quiet('stray')]
    })
    expect(await createParkPlanner(r.deps).plan()).toEqual([])
  })

  it('resolves the linked bundle through shared stacks too, and any busy bundle keeps the stack', async () => {
    const r = rig({
      bundles: () => [
        bundle(WT, 'review', { stackIds: ['shop'] }),
        bundle('/ws/other', 'in-use', { sharedStackIds: ['shop'], session: 'working' })
      ]
    })
    expect(await createParkPlanner(r.deps).plan()).toEqual([])
  })

  it.each([
    ['keep', { keep: true }],
    ['neverClean', { neverClean: true }]
  ])('a %s mark protects the stack (C7)', async (_n, mark) => {
    const r = rig({ bundles: () => [bundle(WT, 'review', { stackIds: ['shop'], ...mark })] })
    expect(await createParkPlanner(r.deps).plan()).toEqual([])
  })

  it('a pane on one of its ports keeps it running', async () => {
    const r = rig({ paneUrls: () => ['http://localhost:8080/'] })
    expect(await createParkPlanner(r.deps).plan()).toEqual([])
  })

  it('an established connection to one of its ports keeps it running', async () => {
    const r = rig({ established: async () => new Map([[8080, 2]]) })
    expect(await createParkPlanner(r.deps).plan()).toEqual([])
  })

  it('a connection to some other port does not', async () => {
    const r = rig({ established: async () => new Map([[5432, 2]]) })
    expect(await createParkPlanner(r.deps).plan()).toHaveLength(1)
  })

  it('honours the hourly cap from the journal and the thresholds from the prefs', async () => {
    const used = Array.from({ length: 6 }, (_, i) => ({
      at: NOW - (i + 1) * 60_000,
      actor: 'autopilot' as const,
      verb: 'stop' as const,
      stacks: [
        {
          stack: `old${i}`,
          name: `old${i}`,
          path: null,
          containerIds: [],
          freed: { ramBytes: 0, ports: [], volumes: [], volumeBytes: 0 },
          paused: record
        }
      ],
      restoreHint: null
    }))
    expect(await createParkPlanner(rig({ journal: async () => used }).deps).plan()).toEqual([])

    const base = defaultGcPrefs()
    const slow = { ...base, docker: { ...base.docker, idleHours: 5 } }
    expect(await createParkPlanner(rig({}, slow).deps).plan()).toEqual([])
  })
})

describe('execute', () => {
  it('pauses the planned stack as the autopilot, bound to the facts it was decided on', async () => {
    const r = rig()
    const p = createParkPlanner(r.deps)
    const [action] = await p.plan()
    expect(await p.execute(action!)).toEqual({ ok: true })
    expect(r.paused).toEqual([
      {
        d: { stack: 'shop', containerIds: ['shop-c1'], verdict: 'zombie', idle: 'idle 3 h' },
        actor: 'autopilot'
      }
    ])
  })

  it('writes exactly one Activity line per pause, with the reason and the restore command', async () => {
    const r = rig()
    const p = createParkPlanner(r.deps)
    await p.execute((await p.plan())[0]!)
    expect(r.lines).toEqual([
      {
        title: 'Workspace cleanup',
        body: `Paused \`shop\` — idle 3 h · bring back: \`${record.restoreCommand}\``
      }
    ])
  })

  it.each([
    'CHANGED_SINCE_DECIDED',
    'NOT_PAUSABLE',
    'CONFIRM_ONLY',
    'CONFIG_UNREADABLE',
    'STACK_NOT_FOUND',
    'NOT_COMPOSE',
    'DOCKER_UNAVAILABLE'
  ] as const)(
    '%s is a refusal: it never trips the kill switch and writes no line',
    async (code) => {
      const r = rig({ pause: async () => refused(code) })
      const p = createParkPlanner(r.deps)
      expect(await p.execute((await p.plan())[0]!)).toMatchObject({ ok: false, refusal: true })
      expect(r.lines).toEqual([])
    }
  )

  it('a confirm-only stack is a refusal too', async () => {
    const r = rig({
      pause: async () => ({
        ok: false,
        outcome: 'confirm-required',
        code: 'CONFIRM_ONLY',
        message: 'db has an anonymous volume'
      })
    })
    const p = createParkPlanner(r.deps)
    expect(await p.execute((await p.plan())[0]!)).toEqual({
      ok: false,
      reason: 'db has an anonymous volume',
      refusal: true
    })
  })

  it('DOWN_FAILED is a real failure and writes no line', async () => {
    const r = rig({
      pause: async () => ({
        ok: false,
        outcome: 'failed',
        code: 'DOWN_FAILED',
        message: 'docker compose down failed: boom'
      })
    })
    const p = createParkPlanner(r.deps)
    const out = await p.execute((await p.plan())[0]!)
    expect(out).toEqual({ ok: false, reason: 'docker compose down failed: boom' })
    expect(r.lines).toEqual([])
  })

  it('JOURNAL_FAILED is a real failure, but the way back is still written to Activity', async () => {
    const r = rig({
      pause: async () => ({
        ok: false,
        outcome: 'failed',
        code: 'JOURNAL_FAILED',
        message: 'the stack is paused but the journal write failed',
        record
      })
    })
    const p = createParkPlanner(r.deps)
    const out = await p.execute((await p.plan())[0]!)
    expect(out).toMatchObject({ ok: false })
    expect(out).not.toHaveProperty('refusal')
    expect(r.lines).toHaveLength(1)
    expect(r.lines[0]!.body).toContain(record.restoreCommand)
  })

  it('an action it never planned is refused without calling pause', async () => {
    const r = rig()
    const out = await createParkPlanner(r.deps).execute({ kind: 'park', id: 'ghost', reason: 'x' })
    expect(out).toMatchObject({ ok: false, refusal: true })
    expect(r.paused).toEqual([])
  })

  it('a decision is used once: a second execute of the same action is refused', async () => {
    const r = rig()
    const p = createParkPlanner(r.deps)
    const [action] = await p.plan()
    await p.execute(action!)
    expect(await p.execute(action!)).toMatchObject({ ok: false, refusal: true })
    expect(r.paused).toHaveLength(1)
  })
})

describe('pauseOutcomeToDocker', () => {
  it('maps ok, refusals and failures', () => {
    expect(pauseOutcomeToDocker(pausedOk)).toEqual({ ok: true })
    expect(pauseOutcomeToDocker(refused('NOT_PAUSABLE'))).toMatchObject({ refusal: true })
  })
})
