// A scan that ran while the Docker daemon was down saw no stacks because it could see none, not
// because there were none. Such a bundle must never be cleaned on that "no stacks": the operator's
// rule is that nothing alive is ever deleted. Both the autopilot and a manual clean refuse it, with
// no override, until a scan that saw Docker says otherwise. No Docker CLI at all is different: with
// no Docker there is nothing to stop, so those bundles clean as before.

import { describe, expect, it } from 'vitest'
import { withDockerBlind, type WorktreeBundle } from '../src/main/gc/bundle-core'
import { planCycle } from '../src/main/gc/autopilot-core'
import { createForcedGcOps } from '../src/main/gc/gc-forced-ops'
import { defaultGcPrefs } from '../src/main/gc/gc-prefs'
import { createGcOps, DockerUnavailableError } from '../src/main/gc/gc-shell'
import { runBundle } from '../src/main/gc/pipeline-core'
import { bundle, DAY, NOW, reapItem } from './gc-fixtures'
import { WT, worldFor } from './helpers/gc-world'

const stackless = (over: Partial<WorktreeBundle> = {}): WorktreeBundle => ({
  ...bundle(WT, 'ready', { stackIds: [], ownedVolumes: [], lastSignOfLifeAt: NOW - 10 * DAY }),
  item: reapItem(WT),
  ...over
})

const daemonDown = (): Promise<never> =>
  Promise.reject(new DockerUnavailableError('Cannot connect to the Docker daemon'))
const daemonUp = async (): Promise<{ stacks: never[] }> => ({ stacks: [] })
const cliAbsent = daemonUp // no CLI: listStacks resolves "no stacks", which is true

describe('withDockerBlind', () => {
  it('marks every bundle and leaves the input alone', () => {
    const a = stackless()
    const out = withDockerBlind([a])
    expect(out[0].dockerBlind).toBe(true)
    expect(a.dockerBlind).toBeUndefined()
  })
})

describe('a blind scan is refused by the reprobe, in the autopilot and in a manual clean', () => {
  const opts = { removeVolumes: false }
  const blind = (): WorktreeBundle => withDockerBlind([stackless()])[0]

  for (const [name, listStacks] of [
    ['the daemon is still down', daemonDown],
    ['the daemon is up again by clean time', daemonUp]
  ] as const) {
    it(`autopilot ops: refused as scan-blind when ${name}`, async () => {
      const ops = createGcOps(worldFor(blind(), { listStacks }))
      expect(await ops.reprobe(blind())).toEqual({ ok: false, reason: 'scan-blind' })
      const r = await runBundle(blind(), ops, opts)
      expect(r).toMatchObject({ ok: false, haltedAt: 'reprobe', error: 'scan-blind' })
    })

    it(`manual (forced) ops: refused as scan-blind when ${name}`, async () => {
      const b = { ...blind(), bucket: 'review' as const }
      const ops = createForcedGcOps(worldFor(b, { listStacks }))
      const r = await runBundle(b, ops, { ...opts, confirmReview: true })
      expect(r).toMatchObject({ ok: false, haltedAt: 'reprobe', error: 'scan-blind' })
    })
  }

  it('the autopilot does not plan it, so a blind scan never spends the cycle cap', () => {
    const plan = planCycle([blind()], {
      ...defaultGcPrefs(),
      autopilot: true,
      firstReportAcknowledged: true
    })
    expect(plan.toClean).toEqual([])
    expect(plan.found).toBe(0)
  })
})

describe('a scan that saw Docker, or saw no Docker at all, still cleans', () => {
  const opts = { removeVolumes: false }

  it('scan up with no stack, daemon down at clean time: cleans', async () => {
    const b = stackless()
    const r = await runBundle(b, createGcOps(worldFor(b, { listStacks: daemonDown })), opts)
    expect(r).toMatchObject({ ok: true, haltedAt: null })
  })

  it('scan up with a stack, daemon down at clean time: refused as docker-unavailable', async () => {
    const b = stackless({ stackIds: ['app'] })
    const r = await runBundle(b, createGcOps(worldFor(b, { listStacks: daemonDown })), opts)
    expect(r).toMatchObject({ ok: false, haltedAt: 'reprobe', error: 'docker-unavailable' })
  })

  it('no Docker CLI at all (nothing to stop): cleans', async () => {
    const b = stackless()
    const r = await runBundle(b, createGcOps(worldFor(b, { listStacks: cliAbsent })), opts)
    expect(r).toMatchObject({ ok: true, haltedAt: null })
  })
})
