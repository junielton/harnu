// U3.6 AC-5/AC-6 (cycle half): the report-only Docker cycle records the LIST of what it would do
// (kind, target, reason), not only a count, and the notice describes what Docker autonomy now does.

import { describe, expect, it } from 'vitest'
import { createCycleState } from '../src/main/gc/gc-cycle'
import {
  heldDockerReport,
  reportItemsOf,
  runDockerCycle,
  type DockerAction,
  type DockerCycleDeps
} from '../src/main/gc/docker-cycle'
import { defaultGcPrefs, withDockerAcknowledged, type GcPrefs } from '../src/main/gc/gc-prefs'
import { DOCKER_REPORT_ITEMS_MAX } from '../src/main/gc/gc-wire'

const plan3: DockerAction[] = [
  { kind: 'prune-network', id: 'n1', reason: 'empty network n1' },
  { kind: 'remove-orphan', id: 'o1', reason: 'worktree gone' },
  { kind: 'park', id: 'p1', reason: 'idle 3 h' }
]

function rig(
  prefs: GcPrefs,
  actions: DockerAction[]
): {
  deps: DockerCycleDeps
  notices: Array<{ title: string; body: string }>
} {
  const notices: Array<{ title: string; body: string }> = []
  return {
    notices,
    deps: {
      prefs: () => prefs,
      plan: async () => actions,
      execute: async () => ({ ok: true }),
      lock: async (work) => ({ ok: true, value: await work() }),
      disableDocker: async () => {},
      notify: (n) => notices.push(n),
      now: () => 0
    }
  }
}

describe('the report-only list (U3.6 AC-5)', () => {
  it('maps each action to a kind, a target and a reason', () => {
    expect(reportItemsOf(plan3)).toEqual([
      { kind: 'network', target: 'n1', reason: 'empty network n1' },
      { kind: 'orphan', target: 'o1', reason: 'worktree gone' },
      { kind: 'pause', target: 'p1', reason: 'idle 3 h' }
    ])
  })

  it('names a network by its name, not its 64-character id', () => {
    const id = `net:${'ab12'.repeat(16)}`
    expect(
      reportItemsOf([
        { kind: 'prune-network', id, reason: 'Removed empty network `app_default` — no containers' }
      ])[0]!.target
    ).toBe('app_default')
    // no name in the reason: the id without its prefix, shortened like `docker network ls`
    expect(reportItemsOf([{ kind: 'prune-network', id, reason: 'empty' }])[0]!.target).toBe(
      'ab12'.repeat(3)
    )
  })

  it('a report-only cycle records the list and still acts on nothing', async () => {
    const r = rig(defaultGcPrefs(), plan3)
    const rec = await runDockerCycle(r.deps, createCycleState())
    expect(rec).toMatchObject({ mode: 'report', found: 3, acted: 0 })
    expect(rec.items).toEqual(reportItemsOf(plan3))
  })

  it('an acknowledged cycle carries no list', async () => {
    const r = rig(withDockerAcknowledged(defaultGcPrefs()), plan3)
    expect((await runDockerCycle(r.deps, createCycleState())).items).toEqual([])
  })

  it('caps the list but not the count', async () => {
    const many = Array.from({ length: DOCKER_REPORT_ITEMS_MAX + 20 }, (_, i) => ({
      kind: 'prune-network' as const,
      id: `n${i}`,
      reason: 'empty'
    }))
    const rec = await runDockerCycle(rig(defaultGcPrefs(), many).deps, createCycleState())
    expect(rec.found).toBe(many.length)
    expect(rec.items).toHaveLength(DOCKER_REPORT_ITEMS_MAX)
  })

  it('off and paused records carry an empty list', async () => {
    const off = { ...defaultGcPrefs(), docker: { ...defaultGcPrefs().docker, enabled: false } }
    expect((await runDockerCycle(rig(off, plan3).deps, createCycleState())).items).toEqual([])
  })
})

describe('the report notice is truthful (U3.6 AC-6)', () => {
  it('says networks and orphan stacks are removed, idle stacks paused, no volume removed', async () => {
    const r = rig(defaultGcPrefs(), plan3)
    await runDockerCycle(r.deps, createCycleState())
    const body = r.notices[0]!.body
    expect(body).toMatch(/3 Docker items would be handled/)
    expect(body).toMatch(/remove empty networks and orphan stacks/i)
    expect(body).toMatch(/pause idle stacks/i)
    expect(body).toMatch(/No volume is ever removed/)
    expect(body).not.toMatch(/stacks paused, never removed with their volumes/)
  })

  it('names only what the plan holds', async () => {
    const r = rig(defaultGcPrefs(), [plan3[2]!])
    await runDockerCycle(r.deps, createCycleState())
    const body = r.notices[0]!.body
    expect(body).toMatch(/pause idle stacks/i)
    expect(body).not.toMatch(/remove empty networks/i)
  })
})

describe('the held report: only a pass that planned replaces it (U3.6 AC-5)', () => {
  const lockedRig = (prefs: GcPrefs, actions: DockerAction[]) => {
    const r = rig(prefs, actions)
    r.deps.lock = async () => ({ ok: false, reason: 'locked', holder: null })
    return r
  }

  it('a planning report cycle holds the list, with its source and the true count', async () => {
    const state = createCycleState()
    await runDockerCycle(rig(defaultGcPrefs(), plan3).deps, state)
    expect(state.dockerReport).toEqual({
      at: 0,
      source: 'cycle',
      found: 3,
      items: reportItemsOf(plan3)
    })
  })

  it('a locked cycle record never replaces a list that has items', async () => {
    const state = createCycleState()
    await runDockerCycle(rig(defaultGcPrefs(), plan3).deps, state)
    const held = state.dockerReport
    const rec = await runDockerCycle(lockedRig(defaultGcPrefs(), plan3).deps, state)
    expect(rec).toMatchObject({ mode: 'report', locked: true, items: [] })
    expect(state.dockerReport).toBe(held)
  })

  it('off and the global pause never replace it', async () => {
    const state = createCycleState()
    await runDockerCycle(rig(defaultGcPrefs(), plan3).deps, state)
    const held = state.dockerReport
    const off = { ...defaultGcPrefs(), docker: { ...defaultGcPrefs().docker, enabled: false } }
    await runDockerCycle(rig(off, []).deps, state)
    await runDockerCycle(rig({ ...defaultGcPrefs(), pauseAutonomous: true }, []).deps, state)
    expect(state.dockerReport).toBe(held)
  })

  it('a newer planning report replaces an older one, even with fewer items', async () => {
    const state = createCycleState()
    await runDockerCycle(rig(defaultGcPrefs(), plan3).deps, state)
    await runDockerCycle(rig(defaultGcPrefs(), [plan3[0]!]).deps, state)
    expect(state.dockerReport?.items).toEqual(reportItemsOf([plan3[0]!]))
  })

  it('an acknowledged (acting) cycle clears it', async () => {
    const state = createCycleState()
    await runDockerCycle(rig(defaultGcPrefs(), plan3).deps, state)
    await runDockerCycle(rig(withDockerAcknowledged(defaultGcPrefs()), []).deps, state)
    expect(state.dockerReport).toBeNull()
  })

  it('heldDockerReport shows it only while unacknowledged', () => {
    const state = createCycleState()
    state.dockerReport = { at: 1, source: 'watcher', found: 1, items: [] }
    expect(heldDockerReport(state, defaultGcPrefs())).toBe(state.dockerReport)
    expect(heldDockerReport(state, withDockerAcknowledged(defaultGcPrefs()))).toBeNull()
  })
})
