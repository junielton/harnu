import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  PARK_BUSY_DATA,
  PARK_FREE_DATA,
  PARK_MALFORMED_DATA,
  PARK_QUERY_ARGS,
  PARK_UNKNOWN_KIND_DATA
} from '../resources/companion/tests/fixtures/park'
import type { AuditRecord, CommandAuditRecord } from '../src/main/companion/audit-core'
import { registerChannelPolicies } from '../src/main/companion/command-channel'
import {
  COMMAND_NAMES,
  checkOrigin,
  gateRowFor,
  profileRefusal,
  resetGateRowsForTests,
  shadowRefusal,
  validateArgs
} from '../src/main/companion/command-gate-core'
import type { CommandOutcome } from '../src/main/companion/command-types'
import {
  resetPrefsKeysForTests,
  setCompanionCliGate,
  setCompanionPrefsPath,
  setPrefsKey,
  prefsKey
} from '../src/main/companion/companion-prefs'
import type { FeatureId } from '../src/main/companion/contract'
import {
  computeEnable,
  registerP1FeaturePolicies,
  resetFeaturePoliciesForTests
} from '../src/main/companion/feature-policy'
import type { BindingView } from '../src/main/companion/session-table'
import {
  PARK_QUERY_TTL_MS,
  createLegacyParkFacts,
  createParkCoordinator,
  createParkQuery,
  parkQueryAnswer,
  registerParkPrefsKey,
  registerParkQueryPolicies,
  type ParkCoordinator,
  type ParkNegotiation
} from '../src/main/park-coordinator'
import {
  DEFAULT_NEGOTIATION,
  NEG_QUERY_WAIT_MS,
  type Answer,
  type ParkSnapshot
} from '../src/main/park-negotiation-core'
import { ALL_ACT, channelRig, sleep } from './companion/support/channel-rig'

/**
 * T456 W2 — `park.query` on the host (spec §5.2, §5.4, §9.2): the gate row and the feature
 * `act.park` (AC-W2-9), the shadow refusal through the real gate (AC-T456-8), the reading of the
 * mod's answer, and every failure row of §9.2 ending at legacy facts, then today's park
 * (AC-W2-12). The channel is the real one, over a real socket (`channelRig`).
 */

const KEY = 'key:pty-1'
const PARK_ACT: FeatureId[] = [...ALL_ACT, 'act.park']

const open: { close(): Promise<void> }[] = []
afterEach(async () => {
  for (const r of open.splice(0)) await r.close()
  resetGateRowsForTests()
  registerParkQueryPolicies()
})
const rig = async (o: Parameters<typeof channelRig>[0] = {}) => {
  const r = await channelRig({ declared: PARK_ACT, enable: PARK_ACT, ...o })
  open.push(r)
  return r
}
type Rig = Awaited<ReturnType<typeof rig>>

const cmdRows = (rows: AuditRecord[]): CommandAuditRecord[] =>
  rows.filter((r): r is CommandAuditRecord => r.kind === 'command')

// ---- a coordinator whose `ask` is the real park.query over the rig's channel -----------------

interface World {
  coordinator: ParkCoordinator
  parked: Array<{ key: string; negotiation: ParkNegotiation | null }>
  facts: ReturnType<typeof createLegacyParkFacts>
}

function world(r: Rig): World {
  const facts = createLegacyParkFacts()
  const parked: World['parked'] = []
  const snaps = new Map<string, ParkSnapshot>([
    [
      KEY,
      { ptyId: 'pty-1', isSelected: false, lastFocusedAt: 0, lastActivityAt: 0, lastPromptAt: null }
    ]
  ])
  const coordinator = createParkCoordinator({
    now: () => 10 * 60 * 60_000,
    snapshot: (k) => snaps.get(k) ?? null,
    hibernate: (k, negotiation) => {
      parked.push({ key: k, negotiation })
      snaps.delete(k)
    },
    parkMode: () => 'ask',
    bounds: () => ({
      maxDeclines: DEFAULT_NEGOTIATION.maxDeclines,
      maxDeferMs: DEFAULT_NEGOTIATION.maxDeferMs,
      pressureFloorMb: DEFAULT_NEGOTIATION.pressureFloorMb
    }),
    memAvailableMb: () => null,
    facts,
    ask: createParkQuery((req) => r.channel.enqueue(req))
  })
  open.push({ close: async () => coordinator.dispose() })
  return { coordinator, parked, facts }
}

/** One legacy main `Stop` with one cron: the legacy facts say busy (AC-T456-5's shape). */
const legacyCron = (w: World): void =>
  w.facts.noteHookBody(
    KEY,
    'Stop',
    { background_tasks: [], session_crons: [{ recurring: true }] },
    0
  )

// ---- the gate row and the feature (AC-W2-9) -------------------------------------------------

describe('the gate row: internal cause `park` only (spec §5.2, SEC-5c)', () => {
  it('park.query is in the host’s closed command set', () => {
    expect(COMMAND_NAMES).toContain('park.query')
  })

  it('names the feature act.park and admits only the coordinator', () => {
    expect(gateRowFor('park.query')?.feature).toBe('act.park')
    expect(
      checkOrigin('park.query', { kind: 'internal', subsystem: 'park' }, { debug: false }).ok
    ).toBe(true)
    for (const cause of [
      { kind: 'internal', subsystem: 'arbitration' },
      { kind: 'internal', subsystem: 'prefs' },
      { kind: 'operator', gesture: 'diagnostics.ping' },
      { kind: 'operator', gesture: 'debug' },
      { kind: 'verb', verb: 'message_session' }
    ] as const) {
      expect(checkOrigin('park.query', cause, { debug: true }).ok, JSON.stringify(cause)).toBe(
        false
      )
    }
  })

  it('takes exactly a cause, and nothing else (no text, no path: SEC-5a)', () => {
    for (const cause of ['cap', 'sweep', 'manual']) {
      expect(validateArgs('park.query', { cause }).ok).toBe(true)
    }
    for (const bad of [{}, { cause: 'idle' }, { cause: 'sweep', path: '/etc' }, null, 'sweep']) {
      expect(validateArgs('park.query', bad).ok, JSON.stringify(bad)).toBe(false)
    }
    expect(validateArgs('park.query', PARK_QUERY_ARGS).ok).toBe(true)
  })

  it('is interactive only', () => {
    expect(profileRefusal('interactive', 'park.query')).toBeNull()
    expect(profileRefusal('headless', 'park.query')).toBe('HEADLESS')
    expect(profileRefusal('external', 'park.query')).toBe('EXTERNAL')
  })

  it('is not observe-only: shadow refuses it MODE_SHADOW, active admits it', () => {
    expect(shadowRefusal('shadow', 'park.query', PARK_QUERY_ARGS)).toBe('MODE_SHADOW')
    expect(shadowRefusal('off', 'park.query', PARK_QUERY_ARGS)).toBe('FEATURE_OFF')
    expect(shadowRefusal('active', 'park.query', PARK_QUERY_ARGS)).toBeNull()
  })

  it('the contract keeps park.query out of the observe-only list', () => {
    const contract = readFileSync(
      join(__dirname, '../docs/specs/T389-companion-mod/01-contract.md'),
      'utf8'
    )
    const line = contract.split('\n').find((l) => l.includes('**Observe-only commands**')) ?? ''
    const para = contract.slice(contract.indexOf(line), contract.indexOf(line) + 400)
    expect(para).not.toContain('park.query')
    expect(contract).toMatch(/\| `act\.park` +\| actuator/)
  })
})

describe('the feature act.park: key `park` = ask AND key `channel` = active (ARB-6b)', () => {
  const binding = {
    key: 1,
    owner: null,
    trust: 'operator',
    sid: 's',
    sessionKey: 'k',
    cwd: '/work/x',
    profile: 'interactive',
    cliVersion: '2.1.290',
    modVersion: '0.1.0',
    declared: [],
    enabled: [],
    proven: [],
    lease: 'live',
    state: 'bound',
    helloAfterSpawnMs: 0
  } as BindingView
  const rollout = {
    enabled: true,
    cliGate: 'ok',
    families: {},
    allFolders: true,
    rampFolders: new Set<string>()
  } as never
  const enable = (): string[] =>
    computeEnable(['act.channel', 'act.park'], {
      profile: 'interactive',
      folder: '/work/x',
      rollout,
      trust: 'operator',
      binding
    })

  beforeEach(() => {
    setCompanionPrefsPath(null)
    resetPrefsKeysForTests()
    resetFeaturePoliciesForTests()
    registerP1FeaturePolicies()
    registerChannelPolicies()
    registerParkPrefsKey()
    registerParkQueryPolicies()
    setCompanionCliGate('ok')
  })
  afterEach(() => {
    setCompanionCliGate('ok')
    resetPrefsKeysForTests()
    resetFeaturePoliciesForTests()
    registerP1FeaturePolicies()
    registerChannelPolicies()
    registerParkPrefsKey()
    registerParkQueryPolicies()
  })

  it('the default install (channel shadow) does not enable it: facts only', () => {
    expect(enable()).toEqual(['act.channel'])
  })

  it('channel active with park ask enables it', () => {
    setPrefsKey('channel', 'active')
    expect(enable()).toEqual(['act.channel', 'act.park'])
  })

  it('park facts or off never enables it, even with the channel active', () => {
    setPrefsKey('channel', 'active')
    setPrefsKey('park', 'facts')
    expect(enable()).toEqual(['act.channel'])
    setPrefsKey('park', 'off')
    expect(enable()).toEqual(['act.channel'])
  })

  it('a CLI above the tested ceiling caps park at facts and the channel at shadow (ARB-7b)', () => {
    setPrefsKey('channel', 'active')
    setPrefsKey('park', 'ask')
    setCompanionCliGate('above')
    expect(prefsKey('park')).toBe('facts')
    expect(prefsKey('channel')).toBe('shadow')
    expect(enable()).toEqual(['act.channel'])
  })
})

// ---- the answer, read as untrusted input -----------------------------------------------------

describe('parkQueryAnswer: the mod’s answer is untrusted (SEC-3b)', () => {
  const resulted = (data: unknown, ok = true): CommandOutcome => ({
    state: 'resulted',
    ok,
    ...(data !== undefined ? { data } : {})
  })

  it('a busy answer keeps the reason kinds and the hint, nothing else', () => {
    expect(parkQueryAnswer(resulted(PARK_BUSY_DATA))).toEqual({
      kind: 'busy',
      reasons: [
        'turn',
        'permission',
        'background-task',
        'background-subagent',
        'scheduled-wakeup',
        'remote-surface'
      ],
      retryAfterMs: 120_000,
      counts: {
        turn: 1,
        permission: 1,
        'background-task': 2,
        'background-subagent': 1,
        'scheduled-wakeup': 1,
        'remote-surface': 1
      }
    })
  })

  it('counts are display-only, untrusted and clamped to 1..256', () => {
    const a = parkQueryAnswer(
      resulted({
        busy: [
          { kind: 'background-task', count: 10_000, types: ['shell'] },
          { kind: 'permission', count: -3 },
          { kind: 'scheduled-wakeup', count: 'many', recurring: 0 }
        ]
      })
    )
    expect(a).toEqual({
      kind: 'busy',
      reasons: ['background-task', 'permission', 'scheduled-wakeup'],
      counts: { 'background-task': 256, permission: 1, 'scheduled-wakeup': 1 }
    })
  })

  it('busy: [] is free', () => {
    expect(parkQueryAnswer(resulted(PARK_FREE_DATA))).toEqual({ kind: 'free' })
  })

  it('an unknown reason kind is dropped (a newer mod); with nothing else it is free', () => {
    expect(parkQueryAnswer(resulted(PARK_UNKNOWN_KIND_DATA))).toEqual({ kind: 'free' })
  })

  it('malformed data, a refusal, no data and every non-result read as silent', () => {
    for (const d of PARK_MALFORMED_DATA) {
      expect(parkQueryAnswer(resulted(d)), JSON.stringify(d)).toEqual({ kind: 'silent' })
    }
    expect(parkQueryAnswer(resulted(undefined))).toEqual({ kind: 'silent' })
    for (const code of [
      'CMD_FAILED',
      'CMD_PRECONDITION',
      'CMD_EXPIRED',
      'CMD_UNSUPPORTED',
      'FEATURE_DISABLED'
    ] as const) {
      expect(parkQueryAnswer({ state: 'resulted', ok: false, code })).toEqual({ kind: 'silent' })
    }
    expect(parkQueryAnswer({ state: 'expired' })).toEqual({ kind: 'silent' })
    expect(parkQueryAnswer({ state: 'lost' })).toEqual({ kind: 'silent' })
    expect(parkQueryAnswer({ state: 'dropped', why: 'revoked', delivered: true })).toEqual({
      kind: 'silent'
    })
    expect(parkQueryAnswer(null)).toEqual({ kind: 'silent' })
  })

  it('a hint that is not a finite non-negative number is dropped, not trusted', () => {
    for (const retryAfterMs of [-1, Number.NaN, 'soon', Infinity]) {
      expect(
        parkQueryAnswer(resulted({ busy: [{ kind: 'turn' }], retryAfterMs })),
        String(retryAfterMs)
      ).toEqual({ kind: 'busy', reasons: ['turn'], counts: { turn: 1 } })
    }
  })
})

// ---- the enqueue, and AC-T456-8 through the real gate ------------------------------------------

describe('createParkQuery over the real command channel', () => {
  it('enqueues park.query with the internal cause `park`, a 5 s TTL and no text', async () => {
    const r = await rig()
    const { conn } = await r.hello()
    const w = world(r)
    const pending = w.coordinator.requestPark(KEY, 'sweep')
    await sleep(10)
    const polled = await r.poll(conn)
    const [c] = polled.json.commands as {
      cmd: string
      name: string
      args: unknown
      issuedAt: number
      expiresAt: number
    }[]
    expect(c?.name).toBe('park.query')
    expect(c?.args).toEqual({ cause: 'sweep' })
    expect(PARK_QUERY_TTL_MS).toBe(NEG_QUERY_WAIT_MS)
    expect((c?.expiresAt ?? 0) - (c?.issuedAt ?? 0)).toBe(PARK_QUERY_TTL_MS)
    const decision = cmdRows(r.rows).find((x) => x.name === 'park.query' && x.phase === 'decision')
    expect(decision).toMatchObject({
      decision: 'queued',
      cause: { kind: 'internal', subsystem: 'park' }
    })
    await r.result(conn, { cmd: c?.cmd, ok: true, data: PARK_FREE_DATA })
    expect((await pending).kind).toBe('parked')
  })

  it('channel active, key ask: a busy answer defers the session (negotiated)', async () => {
    const r = await rig()
    const { conn } = await r.hello()
    const w = world(r)
    const pending = w.coordinator.requestPark(KEY, 'sweep')
    await sleep(10)
    const [c] = (await r.poll(conn)).json.commands as { cmd: string }[]
    await r.result(conn, {
      cmd: c?.cmd,
      ok: true,
      data: { busy: [{ kind: 'remote-surface', surfaces: ['mobile'] }] }
    })
    const out = await pending
    expect(out.kind).toBe('declined')
    if (out.kind === 'declined') expect(out.episode.reasons).toEqual(['remote-surface'])
    expect(w.parked).toEqual([])
  })

  it('AC-T456-8: in shadow the coordinator’s park.query is refused MODE_SHADOW and decided on legacy facts', async () => {
    // A binding enabled while the channel was active, then the operator set it back to shadow.
    const r = await rig({ mode: 'shadow' })
    await r.hello()
    const w = world(r)
    legacyCron(w)
    const out = await w.coordinator.requestPark(KEY, 'sweep')
    const refusal = cmdRows(r.rows).find((x) => x.name === 'park.query')
    expect(refusal).toMatchObject({ phase: 'decision', decision: 'MODE_SHADOW' })
    expect(r.channel.inspect().live).toBe(0) // never queued, never sent
    expect(out.kind).toBe('declined') // the legacy cron fact held it
    if (out.kind === 'declined') expect(out.episode.reasons).toEqual(['scheduled-wakeup'])
  })

  it('AC-T456-8: in shadow with no legacy fact it is today’s park, ledger silent', async () => {
    const r = await rig({ mode: 'shadow' })
    await r.hello()
    const w = world(r)
    const out = await w.coordinator.requestPark(KEY, 'sweep')
    expect(cmdRows(r.rows).find((x) => x.name === 'park.query')?.decision).toBe('MODE_SHADOW')
    expect(out.kind).toBe('parked')
    expect(w.parked[0]?.negotiation).toMatchObject({ why: 'silent', declines: 0 })
  })
})

// ---- every failure row of spec §9.2 ends at legacy facts, then today's park (AC-W2-12) -------

describe('fail-open: silent → legacy facts → park (spec §5.4, §9.2)', () => {
  /** Each row twice: with a legacy fact it is deferred on that fact, without one it is parked. */
  async function bothWays(
    make: () => Promise<Rig>,
    drive: (r: Rig, w: World, conn: string | null) => Promise<void> = async () => undefined,
    hello = true
  ): Promise<void> {
    for (const withFact of [true, false]) {
      const r = await make()
      const conn = hello ? (await r.hello()).conn : null
      const w = world(r)
      if (withFact) legacyCron(w)
      const pending = w.coordinator.requestPark(KEY, 'sweep')
      await drive(r, w, conn)
      const out = await pending
      if (withFact) {
        expect(out.kind, 'with a legacy fact').toBe('declined')
        if (out.kind === 'declined') expect(out.episode.reasons).toEqual(['scheduled-wakeup'])
      } else {
        expect(out.kind, 'with no legacy fact').toBe('parked')
        expect(w.parked[0]?.negotiation?.why).toBe('silent')
      }
    }
  }

  it('NO_BINDING (mod absent: old CLI, mode off, --bare, legacy hooks)', async () => {
    await bothWays(() => rig(), undefined, false)
  })

  it('FEATURE_OFF (channel key off)', async () => {
    await bothWays(async () => {
      const r = await rig()
      r.state.mode = 'off'
      return r
    })
  })

  it('FEATURE_OFF (act.park not enabled for the binding: key park not ask at hello)', async () => {
    await bothWays(() => rig({ enable: ALL_ACT }))
  })

  it('MODE_SHADOW', async () => {
    await bothWays(() => rig({ mode: 'shadow' }))
  })

  it('runParkQuery threw: the mod answers CMD_FAILED', async () => {
    await bothWays(
      () => rig(),
      async (r, _w, conn) => {
        await sleep(10)
        const [c] = (await r.poll(conn!)).json.commands as { cmd: string }[]
        await r.result(conn!, { cmd: c?.cmd, ok: false, code: 'CMD_FAILED', message: 'boom' })
      }
    )
  })

  it('the mod did not enable it: FEATURE_DISABLED', async () => {
    await bothWays(
      () => rig(),
      async (r, _w, conn) => {
        await sleep(10)
        const [c] = (await r.poll(conn!)).json.commands as { cmd: string }[]
        await r.result(conn!, { cmd: c?.cmd, ok: false, code: 'FEATURE_DISABLED' })
      }
    )
  })

  it('no answer within NEG_QUERY_WAIT_MS', { timeout: 20_000 }, async () => {
    await bothWays(
      () => rig(),
      async (r, _w, conn) => {
        await sleep(10)
        await r.poll(conn!) // delivered, and the mod never answers
      }
    )
  })

  it('the kill switch turned off mid-question: dropped, revoked', async () => {
    await bothWays(
      () => rig(),
      async (r, _w, conn) => {
        await sleep(10)
        await r.poll(conn!)
        r.killSwitch()
      }
    )
  })

  it('an answer that is not shaped like one', async () => {
    await bothWays(
      () => rig(),
      async (r, _w, conn) => {
        await sleep(10)
        const [c] = (await r.poll(conn!)).json.commands as { cmd: string }[]
        await r.result(conn!, { cmd: c?.cmd, ok: true, data: { busy: 'turn' } })
      }
    )
  })

  it('a send that throws is silent too', async () => {
    const ask = createParkQuery(() => {
      throw new Error('channel exploded')
    })
    await expect(ask(KEY, 'sweep')).resolves.toEqual({ kind: 'silent' } satisfies Answer)
  })

  it('with no channel configured the app’s default send is NO_BINDING: silent', async () => {
    await expect(createParkQuery()(KEY, 'sweep')).resolves.toEqual({ kind: 'silent' })
  })
})

// ---- the app wiring ----------------------------------------------------------------------------

describe('pty.ts hands the coordinator the real park.query', () => {
  it('the coordinator is built with ask: createParkQuery()', () => {
    const src = readFileSync(join(__dirname, '../src/main/pty.ts'), 'utf8')
    const block = src.slice(src.indexOf('parkCoordinator = createParkCoordinator('))
    const end = block.indexOf('\n  })')
    expect(block.slice(0, end)).toMatch(/ask: createParkQuery\(\)/)
  })
})
