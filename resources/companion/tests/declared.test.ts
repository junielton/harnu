/* eslint-disable @typescript-eslint/no-explicit-any -- the shim `on` and fake `$` are loosely typed */
import { expect, test } from 'claude-code/testing'
import { register } from '../hooks/register'
import { FIXTURE_SID, FIXTURE_SPAWN } from './fixtures/hello'
import { endpointText, helloOk } from './support/rig'

/**
 * U2a-ii-AC-3 end to end: the hello a real `register` sends declares `act.context` and `ui.band`
 * only when the `ui.render` registration took. The test harness always loads the hook, so a
 * failing registration is simulated at the one seam a mod has with the CLI: the `on` it is given.
 * `register` runs for real against that shim, then the captured `session.start` hook runs against a
 * small fake `$` that answers the hello and nothing else.
 */

const START = { cwd: '/tmp/example-project', surface: 'terminal', isInteractive: true }
const NOW = 1_790_000_000_000

/** Runs `register` with an `on` that throws for the names in `failing`; returns the hello body. */
async function helloDeclared(failing: string[], cliVersion = '2.1.305'): Promise<any> {
  const handlers = new Map<string, (...a: any[]) => unknown>()
  const on = (name: string, a: unknown, b?: unknown): void => {
    if (failing.includes(name)) throw new Error(`unknown event ${name}`)
    handlers.set(name, (typeof a === 'function' ? a : b) as (...x: any[]) => unknown)
  }
  register(on as never)

  const state = new Map<string, unknown>()
  const hellos: any[] = []
  const $ = {
    state: {
      get: async (ref: { key: string }) => ({ value: state.get(ref.key), version: 0 }),
      set: async (ref: { key: string }, value: unknown) => {
        state.set(ref.key, value)
        return { isSet: true, version: 1 }
      }
    },
    env: { get: async () => FIXTURE_SPAWN },
    session: { id: async () => FIXTURE_SID, version: async () => ({ version: cliVersion }) },
    fs: { read: async () => endpointText() },
    http: {
      fetch: async (url: string, init: { body: string }) => {
        const route = url.slice(url.lastIndexOf('/') + 1)
        const body = JSON.parse(init.body)
        if (route === 'hello') {
          hellos.push(body)
          return { status: 200, ok: true, headers: {}, text: JSON.stringify(helloOk().body) }
        }
        const ack = Math.max(0, ...((body.events ?? []) as { seq: number }[]).map((e) => e.seq))
        return {
          status: 200,
          ok: true,
          headers: {},
          text: JSON.stringify({ ok: true, ackSeq: ack })
        }
      }
    },
    clock: {
      now: async () => NOW,
      every: () => ({ cancel: () => undefined }),
      after: () => ({ cancel: () => undefined }),
      sleep: async () => undefined
    }
  }
  const start = handlers.get('session.start')
  if (start === undefined) throw new Error('session.start is not registered')
  await start($, START, async (e: { cwd: string }) => ({ cwd: e.cwd }))
  expect(hellos).toHaveLength(1)
  return hellos[0]
}

test('control: with every hook registered, the hello declares act.context and ui.band', async () => {
  const hello = await helloDeclared([])
  expect(hello.declared).toEqual(expect.arrayContaining(['act.context', 'ui.band']))
})

test('ui.render fails to register: the hello declares neither act.context nor ui.band', async () => {
  const hello = await helloDeclared(['ui.render'])
  expect(hello.declared).not.toContain('act.context')
  expect(hello.declared).not.toContain('ui.band')
  // the rest of the mod is untouched by the missing band hook
  expect(hello.declared).toEqual(
    expect.arrayContaining(['sense.identity', 'act.channel', 'sense.turn'])
  )
})

test('a CLI below minCli (no AbovePrompt hook to register) declares neither feature', async () => {
  // 2.1.287 is `minCli`. The mod learns of an old CLI only through its refused registration; the
  // host does not inject below the floor at all, so this is the second line of defence.
  const hello = await helloDeclared(['ui.render'], '2.1.280')
  expect(hello.cli.version).toBe('2.1.280')
  expect(hello.declared).not.toContain('act.context')
  expect(hello.declared).not.toContain('ui.band')
})

test('the base set missing (session.end fails to register) declares neither feature either', async () => {
  const hello = await helloDeclared(['session.end'])
  expect(hello.declared).not.toContain('act.context')
  expect(hello.declared).not.toContain('ui.band')
  expect(hello.declared).not.toContain('act.channel')
})
