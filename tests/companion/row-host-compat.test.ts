import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EventPayloads } from '../../resources/companion/hooks/contract'
import { helloSpawnRequest } from '../../resources/companion/tests/fixtures/hello'
import { type EndpointFile } from '../../src/main/companion/contract'
import {
  rolloutView,
  setCompanionCliGate,
  setCompanionPrefsPath
} from '../../src/main/companion/companion-prefs'
import {
  createEnablePolicy,
  registerP1FeaturePolicies,
  resetFeaturePoliciesForTests
} from '../../src/main/companion/feature-policy'
import { createIdentityAdapter } from '../../src/main/companion/identity-adapter'
import { createTaskStateAdapter } from '../../src/main/companion/ingest/task-state-adapter'
import {
  getCompanionMode,
  hydrateCompanionMode,
  listenerWanted,
  onModeChange
} from '../../src/main/companion/mode'
import { gateForCli } from '../../src/main/companion/enable-policy'
import { post } from './support/client'
import { createCompanionHost, shortTmp, tick } from './support/host-rig'

/**
 * T455 W1 AC-8: a mod built by W1, talking to TODAY's host (no `row` adapter, no `sense.row`
 * policy: those are W2's). The host code is the real one, unchanged: its server, its production
 * enable policy and the two adapters that read `session.snapshot` / `session.rebound`.
 *
 * What must hold: the hello succeeds; `sense.row` is simply not enabled; a `session.row`, a
 * snapshot with `start` and a rebound with `transcriptPath` are accepted (an unknown event type is
 * counted as `unknown`, never as a malformed batch); nothing is revoked or degraded.
 */

const SID = helloSpawnRequest.sid
const SID_2 = '22222222-2222-4222-8222-222222222222'
const owner = { kind: 'pty', ptyId: 'pty-1' } as const
const CLI = '2.1.290'

/** What the W1 mod declares when every hook registered (register.ts, `declared`). */
const W1_DECLARED = [
  'sense.identity',
  'act.channel',
  'act.compact',
  'act.ui',
  'act.turn',
  'sense.turn',
  'sense.attention',
  'sense.subagent',
  'sense.usage',
  'sense.row',
  'sense.mods'
]

const dirs: string[] = []
const closers: (() => Promise<void> | void)[] = []

beforeEach(() => {
  const d = shortTmp('hc-row-')
  dirs.push(d)
  setCompanionPrefsPath(join(d, 'companion-prefs.json'))
  setCompanionCliGate('ok')
  resetFeaturePoliciesForTests()
  registerP1FeaturePolicies()
})

afterEach(async () => {
  for (const c of closers.splice(0)) await c()
  setCompanionPrefsPath(null)
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function todaysHost() {
  const dir = join(shortTmp('hc-row-'), 'companion')
  dirs.push(join(dir, '..'))
  const host = createCompanionHost({
    dir,
    mode: {
      getMode: getCompanionMode,
      listenerWanted,
      hydrate: hydrateCompanionMode,
      onChange: onModeChange,
      enabled: () => rolloutView().enabled
    },
    sessionKeyOf: (o) => (o.kind === 'pty' ? `key:${o.ptyId}` : null),
    log: () => undefined
  })
  closers.push(() => host.close())
  await host.register()
  // the production wiring of host.ts: the P1W4 enable policy, then the two adapters that read
  // the events W1 extends
  host.facade.setEnablePolicy(createEnablePolicy({ rollout: rolloutView, ceiling: CLI }))
  const taskState = createTaskStateAdapter({
    host: host.facade,
    ingest: () => undefined,
    currentState: () => undefined,
    recordFact: () => undefined
  })
  closers.push(() => taskState.dispose())
  const identity = createIdentityAdapter({
    host: host.facade,
    getMode: getCompanionMode,
    gateOf: (b) => gateForCli(b.cliVersion, CLI),
    push: () => undefined
  })
  closers.push(() => identity.dispose())
  const ep = JSON.parse(readFileSync(join(dir, 'endpoint.json'), 'utf8')) as EndpointFile
  return { host, identity, ep }
}

const row = (over: Partial<EventPayloads['session.row']> = {}): EventPayloads['session.row'] => ({
  fold: 1,
  firstPrompt: 'list the files',
  lastPrompt: '/hello world',
  lastAssistant: 'Finished.',
  title: null,
  toolCalls: 1,
  subagentToolCalls: 0,
  userRows: 2,
  lastRowAt: 1_790_000_000_500,
  lastUuid: 'row-0001',
  ...over
})

const snapshot = (): EventPayloads['session.snapshot'] => ({
  reason: 'hello',
  activeTurnId: null,
  openAttention: [],
  runningSubagents: 0,
  probes: { classic: true, toolCheck: false },
  start: { source: 'startup', transcriptPath: `/tmp/example-project/${SID}.jsonl` }
})

describe('W1 mod against the current host (AC-8)', () => {
  it('hello succeeds, sense.row is not enabled, the new events are accepted, nothing is revoked', async () => {
    const x = await todaysHost()
    const token = x.host.facade.mintSpawnToken({
      owner,
      trust: 'operator',
      cwd: '/tmp/example-project'
    })!
    const hello = await post(x.ep, 'hello', {
      body: { ...helloSpawnRequest, cli: { version: CLI }, spawn: token, declared: W1_DECLARED }
    })
    expect(hello.json.ok).toBe(true)
    expect(hello.json.enable).toContain('sense.identity')
    expect(hello.json.enable).not.toContain('sense.row') // no policy row for it: not enabled
    const conn = hello.json.conn as string
    const enabledBefore = [...hello.json.enable].sort()
    const env = (sid: string) => ({ v: 1, sid, conn, sentAt: 1 })

    // one batch with every W1 addition, as a mod would send it if a host enabled sense.row
    const first = await post(x.ep, 'events', {
      body: {
        ...env(SID),
        events: [
          { seq: 1, t: 'session.snapshot', ts: 1, d: snapshot() },
          { seq: 2, t: 'session.row', ts: 2, d: row() },
          { seq: 3, t: 'session.row', ts: 3, d: row({ firstPrompt: null, title: 'renamed' }) },
          {
            seq: 4,
            t: 'session.row',
            ts: 4,
            d: {
              fold: 1,
              toolCalls: 0,
              subagentToolCalls: 0,
              userRows: 0,
              lastRowAt: null,
              lastUuid: null
            }
          }
        ]
      }
    })
    expect(first.json).toEqual({ ok: true, ackSeq: 4 })
    await tick()

    // a /clear: the rebound carries the new conversation's transcript path
    const rebound: EventPayloads['session.rebound'] = {
      prevSid: SID,
      sid: SID_2,
      cause: 'clear',
      transcriptPath: `/tmp/example-project/${SID_2}.jsonl`
    }
    const second = await post(x.ep, 'events', {
      body: {
        ...env(SID),
        events: [
          { seq: 5, t: 'session.rebound', ts: 5, d: rebound },
          { seq: 6, t: 'session.row', ts: 6, d: row({ userRows: 3 }) }
        ]
      }
    })
    expect(second.json.ok).toBe(true)
    expect(second.json.ackSeq).toBe(6)
    await tick()

    // the rebound was applied: the extra field did not make the identity adapter refuse it
    expect(x.identity.claims().map((c) => c.sid)).toEqual([SID_2])

    // more rows under the new id, many times over: still accepted, never revoked
    for (let seq = 7; seq < 17; seq++) {
      const r = await post(x.ep, 'events', {
        body: { ...env(SID_2), events: [{ seq, t: 'session.row', ts: seq, d: row() }] }
      })
      expect(r.json).toEqual({ ok: true, ackSeq: seq })
    }
    await tick()

    const b = x.host.facade.diagnostics().bindings.find((d) => d.sid === SID_2)
    expect(b).toBeDefined()
    expect(b!.state).toBe('bound')
    expect(b!.lease).toBe('live')
    expect([...b!.enabled].sort()).toEqual(enabledBefore)
    expect(b!.declared).toContain('sense.row')
    // `session.row` has no registered reader today: counted unknown, delivered nowhere
    expect(b!.counters.unknown).toBe(14)
    expect(b!.counters.refused).toBe(0)
    expect(x.host.facade.getBinding(SID_2)?.proven).toContain('sense.identity')

    // and a re-hello (a reload) is answered as before
    const { spawn: _s, ...resumeBase } = { ...helloSpawnRequest, sid: SID_2, cli: { version: CLI } }
    const again = await post(x.ep, 'hello', {
      body: { ...resumeBase, declared: W1_DECLARED, resume: { conn } }
    })
    expect(again.json.ok).toBe(true)
    expect([...again.json.enable].sort()).toEqual(enabledBefore)
  })
})
