import { expect, test } from 'claude-code/testing'
import { toAdmitted, USES_LIST_MAX } from '../hooks/lib/admitted'
import { START, defaultScript, helloOk, installRig, must } from './support/rig'

// P4W1 part B (AC-P4W1-17): the one `plugin.register` hook of the companion. It observes the
// modules admitted AFTER it and never refuses (MOD-3, SEC-9f spirit). The engine raises the real
// event for every inline plugin the test loads beside the companion.

const withMods = (route: string, body: unknown) =>
  route === 'hello'
    ? helloOk(['sense.identity', 'sense.mods'])
    : defaultScript(route as never, body, 1)

const admitted = (rig: { events(): { t: string; d: unknown }[] }) =>
  rig.events().filter((e) => e.t === 'mod.admitted')

// An inline plugin whose only job is to leave a mark when it is loaded: `session.start` runs only
// for a module that joined the chain, so the mark proves the companion did not refuse it. A
// module's `register` closes over nothing of this file, so each plugin spells its own name.
const TOKEN_CHART = {
  name: 'token-chart',
  register(on: import('claude-code').On) {
    on('session.start', async ($, e, next) => {
      await $.state.set({ plugin: 'token-chart', key: 'ran' }, true)
      return next(e)
    })
  }
}
const plain = (name: string) => ({
  name,
  register(on: import('claude-code').On) {
    on('prompt.submit', async (_$, e, next) => next(e))
  }
})

test('observes, never refuses', { plugins: [TOKEN_CHART] }, async ($, on) => {
  const seen: unknown[] = []
  // The bottom hook stands for the engine, which allows.
  on('plugin.register', async (_$, e) => {
    seen.push(e)
    return { allow: true as const }
  })
  const rig = installRig(on, { script: withMods })
  await $.session.start(START)
  await rig.clock.settle()
  // the engine saw the event, and the inline module joined: the companion allowed it
  expect(seen.map((e) => (e as { name: string }).name)).toContain('token-chart')
  expect(rig.state.get('ran')).toBe(true)
  const events = admitted(rig)
  expect(events.length).toBe(1)
  const d = must(events[0]).d as Record<string, unknown>
  expect(d.name).toBe('token-chart')
  expect(d.tier).toBe('user')
  expect(d.provenance).toMatch(/^token-chart@/)
  expect(typeof d.root).toBe('string')
  expect((d.uses as { events: string[] }).events).toContain('session.start')
})

test(
  'a refusal from beneath is passed up unchanged and nothing is queued',
  { plugins: [TOKEN_CHART] },
  async ($, on) => {
    // a managed-style judge beneath the companion: it lets the companion in and refuses the rest
    on('plugin.register', async (_$, e) =>
      e.name === 'harnu-companion' ? { allow: true as const } : { refuse: 'managed only' }
    )
    const rig = installRig(on, { script: withMods })
    // The engine surfaces the refusal as the load's error: the companion passed the verdict of
    // the judge beneath it up untouched, and nothing was queued for the module it refused.
    let verdict = ''
    try {
      await $.session.start(START)
    } catch (err) {
      verdict = String(err)
    }
    await rig.clock.settle()
    expect(verdict).toContain('refused by test: managed only')
    expect(rig.state.get('ran')).toBeUndefined()
    expect(admitted(rig).length).toBe(0)
  }
)

test(
  'a feature the host did not enable sends nothing',
  { plugins: [TOKEN_CHART] },
  async ($, on) => {
    on('plugin.register', async () => ({ allow: true as const }))
    const rig = installRig(on) // enable: sense.identity only
    await $.session.start(START)
    await rig.clock.settle()
    expect(rig.of('hello').length).toBe(1)
    expect(admitted(rig).length).toBe(0)
  }
)

test('a session not spawned by Harnu sends nothing', { plugins: [TOKEN_CHART] }, async ($, on) => {
  on('plugin.register', async () => ({ allow: true as const }))
  const rig = installRig(on, { script: withMods, token: false })
  await $.session.start(START)
  await rig.clock.settle()
  expect(rig.sent.length).toBe(0) // dormant: no hello, so no admission leaves the process
  expect(rig.state.get('ran')).toBe(true) // and the module still joined
})

test('declares sense.mods once its hook registered', async ($, on) => {
  on('plugin.register', async () => ({ allow: true as const }))
  const rig = installRig(on)
  await $.session.start(START)
  await rig.clock.settle()
  expect(must(rig.of('hello')[0]).body.declared).toEqual(['sense.identity', 'sense.mods'])
})

test(
  'admissions keep their arrival order',
  { plugins: [plain('one'), plain('two'), plain('three')] },
  async ($, on) => {
    on('plugin.register', async () => ({ allow: true as const }))
    const rig = installRig(on, { script: withMods })
    await $.session.start(START)
    await rig.clock.settle()
    const names = admitted(rig).map((e) => (e.d as { name: string }).name)
    expect(names).toEqual(['one', 'two', 'three'])
  }
)

test('toAdmitted: a module with no env and no state gets empty lists', () => {
  const d = toAdmitted({
    name: 'plain',
    tier: 'append',
    root: '/work/mods/plain',
    provenance: 'plain@skills-dir',
    uses: { events: ['session.start'], calls: [] }
  } as never)
  expect(d).toEqual({
    name: 'plain',
    tier: 'append',
    root: '/work/mods/plain',
    provenance: 'plain@skills-dir',
    uses: {
      events: ['session.start'],
      calls: [],
      env: { reads: [], writes: [] },
      state: { reads: [], writes: [] }
    }
  })
})

test('toAdmitted: keeps version, state keys and env names', () => {
  const d = toAdmitted({
    name: 'token-chart',
    tier: 'user',
    root: '/work/mods/token-chart',
    version: '0.3.1',
    provenance: 'token-chart@inline',
    uses: {
      events: ['prompt.submit'],
      calls: ['http.fetch'],
      env: { reads: ['HOME'], writes: [] },
      state: { reads: [{ plugin: 'token-chart', key: 'seen' }], writes: [] }
    }
  } as never)
  expect(d?.version).toBe('0.3.1')
  expect(d?.uses.env.reads).toEqual(['HOME'])
  expect(d?.uses.state.reads).toEqual([{ plugin: 'token-chart', key: 'seen' }])
})

test('toAdmitted: a malformed input is not an admission', () => {
  expect(toAdmitted(null as never)).toBeNull()
  expect(toAdmitted({ name: 'x' } as never)).toBeNull()
  expect(
    toAdmitted({
      name: 'x',
      tier: 'user',
      root: '/r',
      provenance: 'x@inline',
      uses: { events: 'nope', calls: null }
    } as never)
  ).toBeNull()
  expect(
    toAdmitted({
      name: 'x',
      tier: 'core',
      root: '/r',
      provenance: 'x@inline',
      uses: { events: [], calls: [] }
    } as never)
  ).toBeNull()
})

test('toAdmitted: lists are bounded so one admission always fits a batch', () => {
  const many = Array.from({ length: 500 }, (_, i) => `event.${i}`)
  const d = toAdmitted({
    name: 'big',
    tier: 'user',
    root: '/r',
    provenance: 'big@inline',
    uses: { events: many, calls: many }
  } as never)
  expect(d?.uses.events.length).toBe(USES_LIST_MAX)
  expect(d?.uses.calls.length).toBe(USES_LIST_MAX)
  expect(JSON.stringify(d).length).toBeLessThan(32_768)
})
