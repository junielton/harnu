// The composition point of the Docker slot (autonomous cleanup U3.5, design C1, §5): the garbage
// planner (U3.3) and the pause planner (U3.5) sit side by side behind the slot's one `plan` and
// `execute`. The slot's report-only first cycle lists would-pause stacks and acts on nothing.

import { describe, expect, it } from 'vitest'
import { createCycleState } from '../src/main/gc/gc-cycle'
import {
  composeDockerPlanners,
  runDockerCycle,
  type DockerAction,
  type DockerCycleDeps,
  type DockerOutcome,
  type DockerPlanner
} from '../src/main/gc/docker-cycle'
import { defaultGcPrefs, withDockerAcknowledged, type GcPrefs } from '../src/main/gc/gc-prefs'

const park = (id: string, reason = 'idle 3 h'): DockerAction => ({ kind: 'park', id, reason })
const prune = (id: string): DockerAction => ({
  kind: 'prune-network',
  id,
  reason: 'empty network'
})

function planner(
  kinds: DockerAction['kind'][],
  actions: DockerAction[],
  run: (a: DockerAction) => DockerOutcome = () => ({ ok: true })
): DockerPlanner & { executed: string[] } {
  const executed: string[] = []
  return {
    executed,
    owns: (k) => kinds.includes(k),
    plan: async () => actions,
    execute: async (a) => {
      executed.push(a.id)
      return run(a)
    }
  }
}

const acked = (over: Partial<GcPrefs['docker']> = {}): GcPrefs => {
  const p = withDockerAcknowledged(defaultGcPrefs())
  return { ...p, docker: { ...p.docker, ...over } }
}

function deps(prefs: GcPrefs, planners: DockerPlanner[]) {
  const notices: Array<{ title: string; body: string }> = []
  let disabled = 0
  const d: DockerCycleDeps = {
    prefs: () => prefs,
    ...composeDockerPlanners(planners),
    lock: async (work) => ({ ok: true, value: await work() }),
    disableDocker: async () => {
      disabled++
    },
    notify: (n) => notices.push(n),
    now: () => 0
  }
  return { d, notices, disabled: () => disabled }
}

describe('composeDockerPlanners', () => {
  it('plans in planner order: garbage first, then pauses', async () => {
    const garbage = planner(['prune-network', 'remove-orphan'], [prune('n1')])
    const pause = planner(['park'], [park('shop')])
    const { plan } = composeDockerPlanners([garbage, pause])
    expect((await plan()).map((a) => a.id)).toEqual(['n1', 'shop'])
  })

  it('executes an action in the planner that owns its kind, and nowhere else', async () => {
    const garbage = planner(['prune-network'], [])
    const pause = planner(['park'], [])
    const { execute } = composeDockerPlanners([garbage, pause])
    expect(await execute(park('shop'))).toEqual({ ok: true })
    expect(pause.executed).toEqual(['shop'])
    expect(garbage.executed).toEqual([])
  })

  it('an action nobody owns is a refusal, never a failure', async () => {
    const { execute } = composeDockerPlanners([planner(['park'], [])])
    expect(await execute(prune('n1'))).toMatchObject({ ok: false, refusal: true })
  })

  it('a planner that throws contributes nothing and does not hide the others', async () => {
    const broken: DockerPlanner = {
      owns: () => true,
      plan: async () => {
        throw new Error('docker went away')
      },
      execute: async () => ({ ok: true })
    }
    const { plan } = composeDockerPlanners([broken, planner(['park'], [park('shop')])])
    expect((await plan()).map((a) => a.id)).toEqual(['shop'])
  })
})

describe('the Docker slot with the pause planner', () => {
  it('the report-only first cycle lists the would-pause stacks with their reason and acts on nothing', async () => {
    const pause = planner(['park'], [park('shop', 'idle 3 h'), park('blog', 'idle 9 h')])
    const r = deps(defaultGcPrefs(), [pause])
    const record = await runDockerCycle(r.d, createCycleState())
    expect(record).toMatchObject({ mode: 'report', found: 2, acted: 0 })
    expect(pause.executed).toEqual([])
    expect(r.notices).toHaveLength(1)
    expect(r.notices[0]!.body).toContain('shop (idle 3 h)')
    expect(r.notices[0]!.body).toContain('blog (idle 9 h)')
  })

  it('after the acknowledgement it pauses', async () => {
    const pause = planner(['park'], [park('shop')])
    const r = deps(acked(), [pause])
    const record = await runDockerCycle(r.d, createCycleState())
    expect(record).toMatchObject({ mode: 'act', found: 1, acted: 1 })
    expect(pause.executed).toEqual(['shop'])
  })

  it('a refusal is reported but never counts toward the kill switch', async () => {
    const pause = planner(['park'], [park('a'), park('b'), park('c')], () => ({
      ok: false,
      reason: 'the stack changed since decided',
      refusal: true
    }))
    const r = deps(acked({ failureLimit: 2 }), [pause])
    const state = createCycleState()
    const record = await runDockerCycle(r.d, state)
    expect(record).toMatchObject({ refused: 3, failed: 0, paused: false })
    expect(state.dockerStreak).toBe(0)
    expect(r.disabled()).toBe(0)
  })

  it('real failures count, and the switch turns itself off at the limit', async () => {
    const pause = planner(['park'], [park('a'), park('b'), park('c')], () => ({
      ok: false,
      reason: 'docker compose down failed'
    }))
    const r = deps(acked({ failureLimit: 2 }), [pause])
    const record = await runDockerCycle(r.d, createCycleState())
    expect(record).toMatchObject({ failed: 2, paused: true })
    expect(pause.executed).toEqual(['a', 'b'])
    expect(r.disabled()).toBe(1)
  })

  it('the per-cycle cap and the global pause are honoured', async () => {
    const pause = planner(['park'], [park('a'), park('b'), park('c')])
    const capped = deps(acked({ maxPerCycle: 2 }), [pause])
    expect(await runDockerCycle(capped.d, createCycleState())).toMatchObject({
      acted: 2,
      deferred: 1
    })
    const paused = deps({ ...acked(), pauseAutonomous: true }, [planner(['park'], [park('x')])])
    expect(await runDockerCycle(paused.d, createCycleState())).toMatchObject({
      mode: 'paused',
      found: 0
    })
  })
})
