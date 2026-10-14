/* eslint-disable @typescript-eslint/no-explicit-any -- a fake engine reads and answers loosely */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkForbidden, checkImports } from '../../scripts/ci/api-surface-scan.mjs'
import { renderCoords } from '../../scripts/ci/render-coords.mjs'

// The generated coordinates are written at staging and gitignored. When this tree has none, the
// test renders them as the `mod` step does, and removes them again afterwards.
const HOOKS = resolve(import.meta.dirname, '..', '..', 'resources', 'companion', 'hooks')
const COORDS = join(HOOKS, 'coords.gen.ts')
const madeCoords = !existsSync(COORDS)
if (madeCoords) {
  writeFileSync(
    COORDS,
    renderCoords({
      RENDEZVOUS_PATH: '/nonexistent/companion/endpoint.json',
      MOD_VERSION: '0.1.0',
      STAGED_AT: 0
    })
  )
}
afterAll(() => {
  if (madeCoords) rmSync(COORDS, { force: true })
})

const { register } = await import('../../resources/companion/hooks/register')

/**
 * T455 W1 AC-3 and AC-7: the `session.append` step, driven through the real `register` with a
 * fake engine (the kit cannot make a `$` call of the mod fail for one row). The step calls
 * `next(e)` FIRST, folds after, and a throw in the fold never touches the stored row; the
 * registration carries `.catch(($, e, next) => next(e))`; every other new step reports a throw
 * as `mod.error` instead of refusing its event (spec §10.2, MOD-1, MOD-3, MOD-4).
 */

interface Reg {
  event: string
  matcher?: any
  fn: (...a: any[]) => Promise<any>
  catchFn?: (...a: any[]) => any
}

let regs: Reg[] = []

function load(): void {
  regs = []
  const on = (event: string, a: any, b?: any): any => {
    const reg: Reg = typeof a === 'function' ? { event, fn: a } : { event, matcher: a, fn: b }
    regs.push(reg)
    const handle = {
      catch(c: (...x: any[]) => any) {
        reg.catchFn = c
        return handle
      }
    }
    return handle
  }
  register(on as never, {} as never)
}

const reg = (event: string): Reg => {
  const r = regs.filter((x) => x.event === event)
  expect(r.length, event).toBe(1)
  return r[0]!
}

/** A fake `$`: every call answers a neutral value; `fail` names the calls that reject. */
function fakeEngine(log: string[], fail: Set<string>): any {
  const answer = (path: string): any => {
    if (path === 'clock.now') return 1_790_000_000_000
    if (path === 'state.get') return { value: undefined, version: 0 }
    if (path === 'state.set') return { isSet: true, version: 1 }
    if (path === 'session.id') return '11111111-1111-4111-8111-111111111111'
    if (path === 'session.version') return { version: '2.1.296' }
    if (path === 'fs.read') throw new Error('ENOENT')
    return undefined
  }
  const timer = { cancel: () => undefined }
  return new Proxy(
    {},
    {
      get: (_t, noun: string) =>
        new Proxy(
          {},
          {
            get: (_u, method: string) => {
              const path = `${noun}.${method}`
              if (path === 'clock.after' || path === 'clock.every') return () => timer
              return async () => {
                log.push(path)
                if (fail.has(path)) throw new Error(`${path} failed`)
                return answer(path)
              }
            }
          }
        )
    }
  )
}

const appendEvent = {
  door: 'prompt',
  origin: { kind: 'composer' },
  uuid: 'row-1',
  message: { type: 'user', role: 'user', content: [{ type: 'text', text: 'hello' }] }
}

beforeEach(() => load())

describe('the session.append step (AC-3)', () => {
  it('is registered once, with a .catch that replays next(e)', async () => {
    const r = reg('session.append')
    expect(r.catchFn).toBeTypeOf('function')
    const next = vi.fn(async (e: any) => ({ uuid: e.uuid, message: e.message }))
    const out = await r.catchFn!({}, appendEvent, next)
    expect(next).toHaveBeenCalledWith(appendEvent)
    expect(out).toEqual({ uuid: 'row-1', message: appendEvent.message })
  })

  it('calls next(e) FIRST, with the event unchanged, and folds the stored row after', async () => {
    const log: string[] = []
    const next = vi.fn(async (e: any) => {
      log.push('next')
      return { uuid: e.uuid, message: e.message }
    })
    await reg('session.append').fn(fakeEngine(log, new Set()), appendEvent, next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(next.mock.calls[0]![0]).toBe(appendEvent)
    expect(log[0]).toBe('next')
    expect(log).toContain('clock.now') // the fold ran, after
  })

  it('a refused plugin append (deny) is relayed and never folded', async () => {
    const log: string[] = []
    const denied = { deny: 'not now' }
    const out = await reg('session.append').fn(
      fakeEngine(log, new Set()),
      { ...appendEvent, door: 'note' },
      async () => denied
    )
    expect(out).toBe(denied)
    expect(log).not.toContain('clock.now')
  })
})

describe('fail open (AC-7)', () => {
  it('a throwing fold step leaves the stored row and next untouched', async () => {
    const stored = { uuid: 'row-1', message: appendEvent.message }
    const next = vi.fn(async () => stored)
    const out = await reg('session.append').fn(
      fakeEngine([], new Set(['clock.now'])),
      appendEvent,
      next
    )
    expect(out).toBe(stored)
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('a malformed stored row does not throw out of the step', async () => {
    const stored = { uuid: 'row-1', message: null }
    const out = await reg('session.append').fn(
      fakeEngine([], new Set()),
      appendEvent,
      async () => stored
    )
    expect(out).toBe(stored)
  })

  it('a throwing title step still lets the prompt through', async () => {
    const result = { ok: true }
    const next = vi.fn(async () => result)
    const out = await reg('classic.UserPromptSubmit').fn(
      fakeEngine([], new Set(['clock.now'])),
      { prompt: 'x', session_title: 'a title', session_id: 's', transcript_path: '/t', cwd: '/c' },
      next
    )
    expect(out).toBe(result)
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('a throwing start step still lets the session start', async () => {
    const result = { ok: true }
    for (const event of ['classic.SessionStart', 'session.start']) {
      load()
      const next = vi.fn(async () => result)
      const out = await reg(event).fn(
        fakeEngine([], new Set(['clock.now', 'state.get', 'state.set', 'session.id'])),
        {
          source: 'startup',
          session_id: '11111111-1111-4111-8111-111111111111',
          transcript_path: '/tmp/example-project/x.jsonl',
          session_title: 'a title',
          cwd: '/tmp/example-project',
          surface: 'terminal',
          isInteractive: true
        },
        next
      )
      expect(out, event).toBe(result)
    }
  })
})

describe('authoring rules (MOD-1, MOD-3, MOD-4)', () => {
  it('at most one on() per event, and no turn.step or star event', () => {
    const names = regs.map((r) => r.event)
    expect(new Set(names).size).toBe(names.length)
    expect(names).not.toContain('turn.step')
    expect(names).not.toContain('*')
    expect(names).toEqual(expect.arrayContaining(['session.append', 'classic.UserPromptSubmit']))
  })

  it('the new lib modules never take or use `$` (the MOD-1 source scan)', () => {
    const files = ['row-fold.ts', 'redact-wire.ts', 'secret-rules.gen.ts'].map((f) => ({
      rel: `hooks/lib/${f}`,
      text: readFileSync(join(HOOKS, 'lib', f), 'utf8')
    }))
    expect(checkForbidden(files)).toEqual([])
    expect(checkImports(files)).toEqual([])
  })
})

const SID = '11111111-1111-4111-8111-111111111111'
const SID_2 = '22222222-2222-4222-8222-222222222222'
const PATH = `/tmp/example-project/${SID}.jsonl`

/**
 * A fake engine with a live host behind it: the rendezvous file, a hello that answers ok, events
 * acknowledged and recorded. `hold` delays every `$.clock.now` (a worker hop the classic handler
 * may await); `failClock` makes it reject. `stateSets` records every `$.state.set` key.
 */
function liveEngine(opts: { hold?: Promise<void>; failClock?: () => boolean } = {}) {
  const posted: any[] = []
  const stateSets: string[] = []
  const timer = { cancel: () => undefined }
  const answer = async (path: string, args: any[]): Promise<any> => {
    switch (path) {
      case 'clock.now':
        if (opts.failClock?.()) throw new Error('clock.now failed')
        if (opts.hold) await opts.hold
        return 1_790_000_000_000
      case 'env.get':
        return args[0] === 'HARNU_SPAWN_TOKEN'
          ? 'sp_00000000-0000-4000-8000-000000000001'
          : undefined
      case 'fs.read':
        return JSON.stringify({
          v: 1,
          transport: 'unix',
          socketPath: '/nonexistent/companion/c.sock',
          token: 'endpoint-token-fixture',
          bootId: 'b_00000000-0000-4000-8000-0000000000b1',
          protoMin: 1,
          protoMax: 1,
          writtenAt: 1
        })
      case 'http.fetch': {
        const route = String(args[0]).split('/').at(-1)
        const body = JSON.parse(args[1].body)
        posted.push({ route, body })
        const reply =
          route === 'hello'
            ? {
                ok: true,
                proto: 1,
                conn: 'c_00000000000000000000000000000001',
                bootId: 'b_00000000-0000-4000-8000-0000000000b1',
                sessionKey: null,
                profile: 'interactive',
                enable: ['sense.identity', 'sense.turn', 'sense.row'],
                config: {}
              }
            : { ok: true, ackSeq: Math.max(0, ...(body.events ?? []).map((e: any) => e.seq)) }
        return { status: 200, ok: true, headers: {}, text: JSON.stringify(reply) }
      }
      case 'state.get':
        return { value: undefined, version: 0 }
      case 'state.set':
        stateSets.push(String(args[0]?.key))
        return { isSet: true, version: 1 }
      case 'session.id':
        return SID
      case 'session.version':
        return { version: '2.1.296' }
      default:
        return undefined
    }
  }
  const $: any = new Proxy(
    {},
    {
      get: (_t, noun: string) =>
        new Proxy(
          {},
          {
            get: (_u, method: string) => {
              const path = `${noun}.${method}`
              if (path === 'clock.after' || path === 'clock.every') return () => timer
              return (...args: any[]) => answer(path, args)
            }
          }
        )
    }
  )
  const events = (): any[] =>
    posted.filter((p) => p.route === 'events').flatMap((p) => p.body.events)
  return { $, posted, stateSets, events }
}

const settleAll = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0))
}
const pass = async (e: any) => e
const START_EVENT = { cwd: '/tmp/example-project', surface: 'terminal', isInteractive: true }

describe('W0 M8: the start facts reach the hello even when the two handlers overlap', () => {
  for (const title of [undefined, 'a renamed session']) {
    it(`classic.SessionStart records before its first await (title: ${title ?? 'none'})`, async () => {
      let release: () => void = () => undefined
      const hold = new Promise<void>((r) => (release = r))
      const x = liveEngine({ hold })
      // the engine dispatches both; session.start does not wait for the classic chain
      const classic = reg('classic.SessionStart').fn(
        x.$,
        {
          source: 'startup',
          session_id: SID,
          transcript_path: PATH,
          cwd: '/tmp/example-project',
          ...(title !== undefined ? { session_title: title } : {})
        },
        pass
      )
      await reg('session.start').fn(x.$, START_EVENT, pass)
      await settleAll()
      const hello = x
        .events()
        .find((e: any) => e.t === 'session.snapshot' && e.d.reason === 'hello')
      expect(hello).toBeDefined()
      expect(hello.d.start).toEqual({ source: 'startup', transcriptPath: PATH })
      release()
      await classic
    })
  }

  it('in the source, noteStart(e) comes before every await of the handler (any await, D5)', () => {
    const src = readFileSync(join(HOOKS, 'register.ts'), 'utf8')
    const at = src.indexOf("on('classic.SessionStart', async ($, e, next) => {")
    expect(at).toBeGreaterThan(0)
    const body = src.slice(at, src.indexOf('return next(e)', at))
    const code = body.replace(/\/\/.*$/gm, '')
    const record = code.indexOf('noteStart(e)')
    const firstAwait = code.search(/\bawait\b/)
    expect(record).toBeGreaterThan(0)
    expect(firstAwait).toBeGreaterThan(record)
  })
})

describe('D4: the T455 steps never skip the identity step of classic.SessionStart', () => {
  it('a rejecting title step on a renamed-session /clear still rebinds and resets the fleet', async () => {
    let clockDown = false
    const x = liveEngine({ failClock: () => clockDown })
    await reg('classic.SessionStart').fn(
      x.$,
      { source: 'startup', session_id: SID, transcript_path: PATH, cwd: '/tmp/example-project' },
      pass
    )
    await reg('session.start').fn(x.$, START_EVENT, pass)
    await settleAll()
    const fleetWritesBefore = x.stateSets.filter((k) => k === 'fleet').length
    clockDown = true // rowTitle's `$.clock.now()` rejects from here on
    const result = { ok: true }
    const out = await reg('classic.SessionStart').fn(
      x.$,
      {
        source: 'clear',
        session_id: SID_2,
        transcript_path: `/tmp/example-project/${SID_2}.jsonl`,
        session_title: 'a renamed session',
        cwd: '/tmp/example-project'
      },
      async () => result
    )
    await settleAll()
    expect(out).toBe(result)
    const rebound = x.events().find((e: any) => e.t === 'session.rebound')
    expect(rebound?.d).toMatchObject({ prevSid: SID, sid: SID_2, cause: 'clear' })
    expect(x.stateSets.filter((k) => k === 'fleet').length).toBeGreaterThan(fleetWritesBefore)
    expect(x.events().some((e: any) => e.t === 'mod.error' && e.d.where === 'session.row')).toBe(
      true
    )
  })
})

describe('F2: the session.append registration leaves the attachment door out', () => {
  it('one registration, every door but attachment (the door that tips the subagent race)', () => {
    const r = reg('session.append')
    expect(r.matcher).toEqual({
      door: [
        'prompt',
        'command',
        'response',
        'tool-result',
        'tool-message',
        'delivery',
        'hook-context',
        'note',
        'compaction',
        'notice'
      ]
    })
  })
})

describe('F3: a failing title step never suppresses the start probe', () => {
  it('a compact SessionStart with a title, while $.clock.now rejects, still sends probe:compact', async () => {
    let clockDown = false
    const x = liveEngine({ failClock: () => clockDown })
    await reg('classic.SessionStart').fn(
      x.$,
      { source: 'startup', session_id: SID, transcript_path: PATH, cwd: '/tmp/example-project' },
      pass
    )
    await reg('session.start').fn(x.$, START_EVENT, pass)
    await settleAll()
    clockDown = true
    await reg('classic.SessionStart').fn(
      x.$,
      {
        source: 'compact',
        session_id: SID,
        transcript_path: PATH,
        session_title: 'a renamed session',
        cwd: '/tmp/example-project'
      },
      pass
    )
    await settleAll()
    const probe = x
      .events()
      .filter((e: any) => e.t === 'session.snapshot' && e.d.reason === 'probe')
      .at(-1)
    expect(probe?.d.start).toEqual({ source: 'compact', transcriptPath: PATH })
  })
})

describe('F6: a register() run again cancels the row timer it leaves behind', () => {
  it('the armed timer is cancelled by the next load', async () => {
    const timers: { cancelled: boolean }[] = []
    const $: any = new Proxy(
      {},
      {
        get: (_t, noun: string) =>
          new Proxy(
            {},
            {
              get: (_u, method: string) => {
                if (noun === 'clock' && (method === 'after' || method === 'every')) {
                  return () => {
                    const t = { cancelled: false, cancel: () => void (t.cancelled = true) }
                    if (method === 'after') timers.push(t)
                    return t
                  }
                }
                return async () => (noun === 'clock' ? 1_790_000_000_000 : undefined)
              }
            }
          )
      }
    )
    await reg('session.append').fn($, appendEvent, async (e: any) => ({
      uuid: e.uuid,
      message: e.message
    }))
    expect(timers.length).toBe(1) // the coalescer armed its debounce
    load() // a hot reload's register() in the same environment
    expect(timers[0]!.cancelled).toBe(true)
  })
})
