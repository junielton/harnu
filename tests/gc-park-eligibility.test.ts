// Which stacks Cleanup pauses on its own, and when (autonomous cleanup U3.5, design §4 U3 "Park",
// C7, AC-U3b, risks 10 and 11). One case per rule, per idle signal and per hysteresis limit.

import { describe, expect, it } from 'vitest'
import {
  pauseActivityLine,
  paneTargetsPort,
  parkVerdict,
  pausesInLastHour,
  planPauses,
  type ParkCandidate,
  type ParkFacts,
  type ParkRefusal
} from '../src/main/gc/park-eligibility-core'
import type { StackActivity } from '../src/main/containers/docker-activity-core'
import type { Tombstone } from '../src/main/containers/containers-wire'
import { HOUR, NOW, containerRow, stackRow } from './containers-fixtures'

const MIN = 60_000
const quiet = (over: Partial<StackActivity> = {}): StackActivity => ({
  project: 'shop',
  cpuPercent: 0.1,
  netBytes: 0,
  blockBytes: 0,
  ioBytesPerSec: 0,
  restarted: false,
  active: false,
  ...over
})

/** A zombie stack idle for 3 h, started long ago, with every other signal quiet. */
const facts = (over: Partial<ParkFacts> = {}): ParkFacts => ({
  stack: stackRow({
    id: 'shop',
    verdict: 'zombie',
    lastSessionActivityAt: NOW - 3 * HOUR,
    lastContainerEventAt: NOW - 4 * HOUR,
    containers: [containerRow({ startedAt: NOW - 4 * HOUR, ports: [8080] })]
  }),
  sessions: [],
  protectedMark: false,
  activity: quiet(),
  paneUrls: [],
  established: 0,
  ...over
})

const ctx = { now: NOW, idleHours: 2, minAgeMinutes: 30 }

const refusal = (f: ParkFacts, c = ctx): ParkRefusal | null => {
  const v = parkVerdict(f, c)
  return v.eligible ? null : v.reason
}

describe('parkVerdict — eligible', () => {
  it('an idle zombie with every signal quiet is eligible, with how long it was idle', () => {
    expect(parkVerdict(facts(), ctx)).toEqual({
      eligible: true,
      idleMs: 3 * HOUR,
      since: NOW - 3 * HOUR
    })
  })

  it('a pending stack (idle, not yet a zombie) is eligible too', () => {
    const f = facts()
    expect(refusal({ ...f, stack: { ...f.stack, verdict: 'pending' } })).toBe(null)
  })
})

describe('parkVerdict — the verdict and the sessions', () => {
  it.each(['active', 'protected', 'orphan', 'unknown'] as const)(
    'a %s stack is never paused',
    (verdict) => {
      const f = facts()
      expect(refusal({ ...f, stack: { ...f.stack, verdict } })).toBe('not-pausable')
    }
  )

  it.each(['working', 'needs-input'] as const)(
    'a linked session that is %s keeps the stack running',
    (presence) => {
      expect(refusal(facts({ sessions: ['none', presence] }))).toBe('session-busy')
    }
  )

  it('an open-idle or absent session does not refuse by itself', () => {
    expect(refusal(facts({ sessions: ['open-idle', 'none'] }))).toBe(null)
  })
})

describe('parkVerdict — what protects a stack (C7)', () => {
  it('a keep or neverClean mark protects, however long it has been idle', () => {
    expect(refusal(facts({ protectedMark: true }))).toBe('protected')
  })

  it('an open PR does not protect: the facts carry no PR at all', () => {
    expect(Object.keys(facts())).not.toContain('pr')
    expect(refusal(facts())).toBe(null)
  })
})

describe('parkVerdict — container, browser and host signals (risk 10)', () => {
  it('CPU/IO activity keeps the stack running', () => {
    expect(refusal(facts({ activity: quiet({ cpuPercent: 40, active: true }) }))).toBe('active')
  })

  it('activity that could not be read refuses: a missing fact is never a pass', () => {
    expect(refusal(facts({ activity: null }))).toBe('activity-unknown')
  })

  it('a Harnu browser pane on one of its published ports keeps it running', () => {
    expect(refusal(facts({ paneUrls: ['http://localhost:8080/admin'] }))).toBe('browser-pane')
  })

  it('a pane on some other port or host does not', () => {
    expect(
      refusal(facts({ paneUrls: ['http://localhost:3000/', 'https://example.com:8080/'] }))
    ).toBe(null)
  })

  it('an established host connection to a published port keeps it running', () => {
    expect(refusal(facts({ established: 1 }))).toBe('connection')
  })

  it('connections that could not be read refuse', () => {
    expect(refusal(facts({ established: null }))).toBe('connections-unknown')
  })
})

describe('paneTargetsPort', () => {
  it.each([
    ['http://localhost:8080/', true],
    ['http://127.0.0.1:8080/x?y=1', true],
    ['http://[::1]:8080/', true],
    ['http://0.0.0.0:8080/', true],
    ['http://localhost/', false],
    ['http://localhost:9999/', false],
    ['https://example.com:8080/', false],
    ['not a url', false],
    ['about:blank', false]
  ])('%s → %s for [8080]', (url, expected) => {
    expect(paneTargetsPort(url, [8080])).toBe(expected)
  })

  it('a default-port URL targets a published 80 or 443', () => {
    expect(paneTargetsPort('http://localhost/', [80])).toBe(true)
    expect(paneTargetsPort('https://localhost/', [443])).toBe(true)
    expect(paneTargetsPort('http://localhost/', [443])).toBe(false)
  })
})

describe('parkVerdict — the idle clock', () => {
  it('idle is the newest of session activity and the container clock', () => {
    const f = facts()
    const sessionNewer = { ...f.stack, lastSessionActivityAt: NOW - HOUR }
    expect(refusal({ ...f, stack: sessionNewer })).toBe('too-recent')
    expect(parkVerdict({ ...f, stack: sessionNewer }, { ...ctx, idleHours: 0.5 })).toMatchObject({
      eligible: true,
      idleMs: HOUR
    })
    const containerNewer = { ...f.stack, lastContainerEventAt: NOW - 30 * MIN }
    expect(refusal({ ...f, stack: containerNewer })).toBe('too-recent')
  })

  it('a stack with no known clock at all is never paused', () => {
    const f = facts()
    expect(
      refusal({
        ...f,
        stack: { ...f.stack, lastSessionActivityAt: null, lastContainerEventAt: null }
      })
    ).toBe('unknown-age')
  })

  it('exactly at the threshold is idle enough', () => {
    const f = facts()
    const s = { ...f.stack, lastSessionActivityAt: NOW - 2 * HOUR, lastContainerEventAt: null }
    expect(refusal({ ...f, stack: s })).toBe(null)
  })
})

describe('parkVerdict — minimum age since the last up (AC-2)', () => {
  const started = (ago: number) => {
    const f = facts()
    return {
      ...f,
      stack: { ...f.stack, containers: [containerRow({ startedAt: NOW - ago, ports: [8080] })] }
    }
  }

  it('a stack started 10 min ago is not paused, even if its clock is old', () => {
    expect(refusal(started(10 * MIN))).toBe('too-young')
  })

  it('31 minutes after the last up it can be paused', () => {
    expect(refusal(started(31 * MIN))).toBe(null)
  })

  it('the newest start among the containers counts (a stack brought back by hand)', () => {
    const f = facts()
    const s = {
      ...f.stack,
      containers: [
        containerRow({ startedAt: NOW - 5 * HOUR, ports: [8080] }),
        containerRow({ startedAt: NOW - 5 * MIN, ports: [] })
      ]
    }
    expect(refusal({ ...f, stack: s })).toBe('too-young')
  })

  it('no known start time refuses', () => {
    const f = facts()
    const s = { ...f.stack, containers: [containerRow({ startedAt: null, ports: [8080] })] }
    expect(refusal({ ...f, stack: s })).toBe('unknown-age')
  })
})

const pause = (at: number, over: Partial<Tombstone> = {}, paused = true): Tombstone => ({
  at,
  actor: 'autopilot',
  verb: 'stop',
  stacks: [
    {
      stack: 'old',
      name: 'old',
      path: '/x',
      containerIds: ['c'],
      freed: { ramBytes: 0, ports: [], volumes: [], volumeBytes: 0 },
      ...(paused
        ? {
            paused: {
              project: 'old',
              workingDir: '/x',
              configFiles: [],
              profiles: [],
              envFile: null,
              hasBuild: false,
              ports: [],
              restoreCommand: 'docker compose up -d',
              pausedAt: at
            }
          }
        : {})
    }
  ],
  restoreHint: null,
  ...over
})

describe('pausesInLastHour (AC-2, risk 11)', () => {
  it('counts the autopilot pauses inside the hour and nothing else', () => {
    const journal = [
      pause(NOW - 59 * MIN),
      pause(NOW - 61 * MIN),
      pause(NOW - 10 * MIN, { actor: 'operator' }),
      pause(NOW - 10 * MIN, {}, false),
      pause(NOW - 5 * MIN, { verb: 'remove' })
    ]
    expect(pausesInLastHour(journal, NOW)).toBe(1)
  })

  it('counts a multi-stack entry once per paused stack', () => {
    const t = pause(NOW - MIN)
    const two = { ...t, stacks: [t.stacks[0]!, { ...t.stacks[0]!, stack: 'other' }] }
    expect(pausesInLastHour([two], NOW)).toBe(2)
  })
})

describe('planPauses', () => {
  const candidate = (id: string, idleHours: number): ParkCandidate => {
    const f = facts()
    return {
      ...f,
      stack: {
        ...f.stack,
        id,
        name: id,
        lastSessionActivityAt: NOW - idleHours * HOUR,
        lastContainerEventAt: null
      },
      decision: { stack: id, containerIds: [`${id}-c`], verdict: 'zombie' }
    }
  }
  const input = (candidates: ParkCandidate[], journal: Tombstone[] = [], max = 6) => ({
    candidates,
    journal,
    now: NOW,
    idleHours: 2,
    minAgeMinutes: 30,
    maxParksPerHour: max
  })

  it('pauses the longest-idle stack first', () => {
    const plan = planPauses(input([candidate('a', 3), candidate('b', 9), candidate('c', 5)]))
    expect(plan.pauses.map((p) => p.decision.stack)).toEqual(['b', 'c', 'a'])
    expect(plan.pauses[0]).toMatchObject({ idleMs: 9 * HOUR, reason: 'idle 9 h' })
  })

  it('with 5 of 6 pauses already used this hour, only one more is planned', () => {
    const journal = [1, 2, 3, 4, 5].map((n) => pause(NOW - n * MIN))
    const plan = planPauses(input([candidate('a', 3), candidate('b', 9)], journal))
    expect(plan.pauses.map((p) => p.decision.stack)).toEqual(['b'])
    expect(plan.skipped).toEqual([{ stack: 'a', reason: 'hourly-cap' }])
  })

  it('with the cap reached nothing is planned; the pause waits for the next hour', () => {
    const journal = [1, 2].map((n) => pause(NOW - n * MIN))
    const plan = planPauses(input([candidate('a', 3)], journal, 2))
    expect(plan.pauses).toEqual([])
    expect(plan.skipped).toEqual([{ stack: 'a', reason: 'hourly-cap' }])
  })

  it('an ineligible stack is skipped with its refusal and never counts against the cap', () => {
    const busy = { ...candidate('busy', 9), activity: quiet({ active: true }) }
    const plan = planPauses(input([busy, candidate('a', 3)], [], 1))
    expect(plan.pauses.map((p) => p.decision.stack)).toEqual(['a'])
    expect(plan.skipped).toEqual([{ stack: 'busy', reason: 'active' }])
  })
})

describe('pauseActivityLine (AC-5)', () => {
  it('names the project, how long it was idle and how to bring it back', () => {
    expect(
      pauseActivityLine({
        name: 'shop',
        idleMs: 3 * HOUR,
        restoreCommand: 'docker compose -p shop up -d'
      })
    ).toEqual({
      title: 'Workspace cleanup',
      body: 'Paused `shop` — idle 3 h · bring back: `docker compose -p shop up -d`'
    })
  })

  it('says minutes under an hour', () => {
    expect(pauseActivityLine({ name: 's', idleMs: 40 * MIN, restoreCommand: 'x' }).body).toContain(
      'idle 40 min'
    )
  })
})
