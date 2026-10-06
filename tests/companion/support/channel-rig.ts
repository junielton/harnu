import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect } from 'vitest'
import { helloSpawnRequest } from '../../../resources/companion/tests/fixtures/hello'
import type { AuditRecord } from '../../../src/main/companion/audit-core'
import {
  createCommandChannel,
  type ChannelDeps,
  type CommandChannel
} from '../../../src/main/companion/command-channel'
import type { ChannelMode } from '../../../src/main/companion/command-gate-core'
import type {
  BootId,
  EndpointFile,
  FeatureId,
  PollRequest
} from '../../../src/main/companion/contract'
import { createCompanionHost } from '../../../src/main/companion/host-core'
import type { CompanionMode } from '../../../src/main/companion/mode'
import type { BindingView } from '../../../src/main/companion/session-table'
import { post } from './client'
import { shortTmp } from './client'

export const ALL_ACT: FeatureId[] = [
  'sense.identity',
  'act.channel',
  'act.turn',
  'act.compact',
  'act.ui'
]

export interface ChannelRigOptions {
  mode?: ChannelMode
  declared?: FeatureId[]
  enable?: FeatureId[]
  interactive?: boolean
  pollHoldMs?: number
  debug?: boolean
  /** Real wall clock for `issuedAt` and every deadline: an L4 run's mod reads the real one. */
  realClock?: boolean
}

/**
 * A real host core over a real socket with the real command channel on it: the world the contract
 * tests of P2W1 need. Time is injected: `epoch` drives `issuedAt` and every deadline, `lease` the
 * monotonic clock of the lease sweep.
 */
export async function channelRig(opts: ChannelRigOptions = {}) {
  const clock = { epoch: 1_790_000_000_000, lease: 1_000 }
  const rows: AuditRecord[] = []
  const state = {
    mode: (opts.mode ?? 'active') as ChannelMode,
    auditFails: false,
    sticky: new Set<string>(),
    failedProofs: [] as { key: string; feature: string }[],
    enabled: opts.enable ?? ALL_ACT,
    enabledFlag: true,
    verbTarget: 'ok' as 'ok' | 'not_found' | 'not_harnu_spawned' | 'operator_owned',
    blockedFolders: new Set<string>()
  }
  const listeners = new Set<() => void>()
  const dir = join(shortTmp('hc-ch-'), 'companion')
  const core = createCompanionHost({
    dir,
    mode: {
      getMode: (): CompanionMode => 'shadow',
      listenerWanted: () => true,
      hydrate: async () => undefined,
      onChange: (fn) => {
        listeners.add(fn)
        return () => void listeners.delete(fn)
      },
      enabled: () => state.enabledFlag
    },
    now: () => (opts.realClock ? performance.now() : clock.lease),
    sessionKeyOf: (o) => (o.kind === 'pty' ? `key:${o.ptyId}` : null),
    log: () => undefined
  })
  await core.register()
  core.facade.setEnablePolicy(() => state.enabled)
  const ep = JSON.parse(readFileSync(join(dir, 'endpoint.json'), 'utf8')) as EndpointFile
  const bootId = (): BootId | null => {
    const l = core.facade.diagnostics().listener
    return l.state === 'listening' ? l.bootId : null
  }
  const deps: ChannelDeps = {
    host: core.facade,
    bootId,
    channelMode: () => state.mode,
    appendAudit: (r) => {
      if (state.auditFails) throw new Error('disk full')
      rows.push(r)
    },
    now: () => (opts.realClock ? Date.now() : clock.epoch),
    isStickyLegacy: (x) => state.sticky.has(x),
    reportFailedProof: (key, feature) => void state.failedProofs.push({ key, feature }),
    agentTarget: () => state.verbTarget,
    folderBlocked: (cwd) => state.blockedFolders.has(cwd),
    pollHoldMs: () => opts.pollHoldMs ?? 25_000,
    debug: opts.debug === true
  }
  // Records every poll the channel is asked to answer (a proxy on `setPollHandler`).
  const polls: PollRequest[] = []
  const recording: ChannelDeps['host'] = {
    ...core.facade,
    bus: core.facade.bus,
    setPollHandler: (fn) =>
      core.facade.setPollHandler((b, req, reply) => {
        polls.push(req)
        fn(b, req, reply)
      })
  }
  const channel: CommandChannel = createCommandChannel({ ...deps, host: recording })

  const sid = helloSpawnRequest.sid
  const connOf = new Map<string, string>()

  async function hello(ptyId = 'pty-1', over: { sid?: string; interactive?: boolean } = {}) {
    const token = core.facade.mintSpawnToken({
      owner: { kind: 'pty', ptyId },
      trust: 'operator',
      cwd: '/work/example-web'
    })!
    const r = await post(ep, 'hello', {
      body: {
        ...helloSpawnRequest,
        sid: over.sid ?? sid,
        cli: { version: '2.1.290' },
        isInteractive: over.interactive ?? opts.interactive ?? true,
        cwd: '/work/example-web',
        declared: opts.declared ?? ALL_ACT,
        spawn: token
      }
    })
    expect(r.json.ok).toBe(true)
    connOf.set(ptyId, r.json.conn)
    return { conn: r.json.conn as string, boot: r.json.bootId as BootId, json: r.json }
  }

  const poll = (conn: string, body: Record<string, unknown> = {}) =>
    post(ep, 'poll', {
      body: { v: 1, sid, conn, sentAt: 1, bootId: bootId(), cursor: 0, ...body }
    })
  const events = (conn: string, evs: unknown[], body: Record<string, unknown> = {}) =>
    post(ep, 'events', { body: { v: 1, sid, conn, sentAt: 1, events: evs, ...body } })
  const view = (ptyId = 'pty-1'): BindingView => core.facade.bindingForSession(`key:${ptyId}`)!

  /** Posts a `command.result` the way the mod would. */
  let seq = 0
  const result = (conn: string, d: Record<string, unknown>) =>
    events(conn, [{ seq: ++seq, t: 'command.result', ts: 1, d }])

  async function close(): Promise<void> {
    channel.dispose()
    await core.close()
  }

  return {
    dir,
    polls,
    clock,
    rows,
    state,
    core,
    ep,
    channel,
    hello,
    poll,
    events,
    result,
    view,
    bootId,
    close,
    setMode: (m: CompanionMode) => {
      void m
    },
    killSwitch: () => {
      state.enabledFlag = false
      for (const l of [...listeners]) l()
    }
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
