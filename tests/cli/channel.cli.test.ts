import { afterEach, describe, expect, it } from 'vitest'
import { channelRig } from '../companion/support/channel-rig'
import { uiText } from '../../src/main/companion/command-gate-core'
import { startFakeHost, type FakeHost, type RecordedRequest } from './support/fake-host'
import { startInteractive, type Interactive } from './support/run-interactive'
import { WITH_CLI } from './support/run-claude'

// P2W1 L4: a real, interactive `claude` on a pseudo-terminal, hermetic, no model turn. Interactive
// is the one profile that polls. Gated like every real-CLI suite: `HARNU_WITH_CLI=1`.

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

const ENABLE = ['sense.identity', 'act.channel', 'act.turn', 'act.compact', 'act.ui']
const CONFIG = {
  flushMs: 250,
  batchMaxEvents: 32,
  batchMaxBytes: 65_536,
  ringMax: 256,
  pollHoldMs: 25_000,
  askHoldMs: 20_000,
  heartbeatMs: 10_000
}
const bodyOf = (r: RecordedRequest): Record<string, unknown> => JSON.parse(r.body || '{}')
const resultsOf = (fake: FakeHost): { cmd: string; ok: boolean }[] =>
  fake.requests
    .filter((r) => r.route === '/v1/events')
    .flatMap((r) => (bodyOf(r).events as { t: string; d: { cmd: string; ok: boolean } }[]) ?? [])
    .filter((e) => e.t === 'command.result')
    .map((e) => e.d)

describe.skipIf(!WITH_CLI)('the command channel against a real interactive claude (L4)', () => {
  it('reload keeps one loop and the dedupe set', async () => {
    const cmd = {
      cmd: 'cmd_00000000000000000000000000000001',
      n: 1,
      name: 'ui.toast',
      args: { text: uiText('channel-ok') },
      issuedAt: Date.now(),
      expiresAt: Date.now() + 600_000
    }
    let polls = 0
    // An adversarial host: it re-sends the same command on the first three polls, whatever the
    // cursor says, and holds every later poll for 4 s.
    const fake = await startFakeHost((req) => {
      if (req.route === '/v1/hello') {
        return {
          kind: 'ok',
          body: {
            ok: true,
            proto: 1,
            conn: `c_${'a'.repeat(32)}`,
            bootId: 'b_fake',
            sessionKey: 'row:pty-1',
            profile: 'interactive',
            enable: ENABLE,
            config: CONFIG
          }
        }
      }
      if (req.route === '/v1/events') {
        const evs = (bodyOf(req).events as { seq: number }[]) ?? []
        return { kind: 'ok', body: { ok: true, ackSeq: Math.max(0, ...evs.map((e) => e.seq)) } }
      }
      if (req.route === '/v1/poll') {
        polls++
        return polls <= 3
          ? { kind: 'ok', body: { ok: true, commands: [cmd] }, delayMs: 100 }
          : { kind: 'ok', body: { ok: true, commands: [] }, delayMs: 4_000 }
      }
      return { kind: 'ok' }
    })
    cleanups.push(() => fake.stop())
    const ix: Interactive = await startInteractive({
      rendezvous: fake.endpointPath,
      spawnToken: 'sp_00000000-0000-4000-8000-0000000000aa'
    })
    cleanups.push(() => ix.stop())

    await ix.until('the command to be answered', () => resultsOf(fake).length >= 1)
    await ix.until(
      'a held poll',
      () => fake.requests.filter((r) => r.route === '/v1/poll').length >= 4
    )
    const hellosBefore = fake.requests.filter((r) => r.route === '/v1/hello').length

    await ix.touchMod() // a hot reload: the module is evaluated again, `$.state` stays
    await ix.until('the reload', async () =>
      /hooks module harnu-companion@inline reloaded/.test(await ix.debug())
    )
    await ix.until(
      'a resume hello',
      () => fake.requests.filter((r) => r.route === '/v1/hello').length > hellosBefore
    )
    expect(
      bodyOf(fake.requests.filter((r) => r.route === '/v1/hello').at(-1)!).resume
    ).toBeDefined()
    // the loop restarted: polls keep arriving, and the old poll was closed with the old module
    const pollsAfterReload = (): number =>
      fake.requests.filter((r) => r.route === '/v1/poll').length
    const seen = pollsAfterReload()
    await ix.until('polls after the reload', () => pollsAfterReload() > seen)
    await new Promise((r) => setTimeout(r, 1_500))
    expect(fake.open(), 'exactly one poll is held after the reload').toBe(1)

    // the host kept re-sending the command, yet it ran once and was answered once
    expect(resultsOf(fake).filter((r) => r.cmd === cmd.cmd)).toEqual([{ cmd: cmd.cmd, ok: true }])
    const debug = await ix.debug()
    expect(debug.match(/\$\.ui\.toast \(harnu-companion\): Harnu mod channel check/g)?.length).toBe(
      1
    )
    expect(debug).not.toMatch(/hook skipped|did not load/i)
  }, 90_000)

  it('host restart drops the queue', async () => {
    const rig = await channelRig({ realClock: true, pollHoldMs: 2_000 })
    cleanups.push(() => rig.close())
    const token = rig.core.facade.mintSpawnToken({
      owner: { kind: 'pty', ptyId: 'pty-1' },
      trust: 'operator',
      cwd: '/tmp/example-project'
    })
    if (!token) throw new Error('no spawn token: the listener is not up')
    const hellos: string[] = []
    rig.core.facade.bus.on('hello', (_b, kind) => void hellos.push(kind))
    const ix = await startInteractive({
      rendezvous: `${rig.dir}/endpoint.json`,
      spawnToken: token
    })
    cleanups.push(() => ix.stop())

    await ix.until('a parked poll', () => rig.channel.inspect().parked === 1)
    const sent = rig.channel.enqueue({
      sessionKey: 'key:pty-1',
      name: 'ui.toast',
      args: { text: uiText('channel-ok') },
      cause: { kind: 'operator', gesture: 'diagnostics.ping' }
    })
    if (!sent.ok) throw new Error(`refused: ${sent.reason}`)
    expect(
      await Promise.race([sent.settled, new Promise((r) => setTimeout(r, 10_000, 'timeout'))])
    ).toMatchObject({
      state: 'resulted',
      ok: true
    })
    await ix.until('the cursor to cover it', () => rig.polls.some((p) => p.cursor >= 1))
    const bootBefore = rig.bootId()

    await rig.core.restartListener() // a new boot id; the table, and the mod's conn, stay
    const bootAfter = rig.bootId()
    expect(bootAfter).not.toBe(bootBefore)
    await ix.until('a resume hello', () => hellos.includes('resume'))
    await ix.until('a poll under the new boot', () => rig.polls.some((p) => p.bootId === bootAfter))
    // the cursor of the old boot is not carried over: the first poll under the new boot is at 0
    const first = rig.polls.find((p) => p.bootId === bootAfter)
    expect(first?.cursor).toBe(0)
    expect(rig.channel.inspect().live).toBe(0)
    // and the command that ran before the restart does not run again
    const debug = await ix.debug()
    expect(debug.match(/\$\.ui\.toast \(harnu-companion\)/g)?.length).toBe(1)
  }, 90_000)
})
