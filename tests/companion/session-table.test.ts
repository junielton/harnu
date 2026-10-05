import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  SessionTable,
  type Binding,
  type EnablePolicy,
  type SpawnMeta,
  type SpawnOwner
} from '../../src/main/companion/session-table'
import {
  LEASE_TTL_MS,
  SPAWN_REDEEM_WINDOW_MS,
  type Conn,
  type HelloRequest
} from '../../src/main/companion/contract'
import { helloSpawnRequest } from '../../resources/companion/tests/fixtures/hello'
import { createCompanionHost } from '../../src/main/companion/host-core'

let t = 0
let n = 0
let table: SessionTable
const owner: SpawnOwner = { kind: 'pty', ptyId: 'pty-1' }
const meta: SpawnMeta = { owner, trust: 'operator', cwd: '/tmp/example-project' }
const enableIdentity: EnablePolicy = () => ['sense.identity']

function fresh(sessionKeyOf?: (o: SpawnOwner) => string | null): SessionTable {
  t = 1000
  n = 0
  return new SessionTable({
    now: () => t,
    mintConn: () => `c_${(++n).toString(16).padStart(32, '0')}` as Conn,
    mintToken: () => `sp_00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` as never,
    sessionKeyOf
  })
}

function spawnHello(over: Partial<HelloRequest> = {}, policy: EnablePolicy = enableIdentity) {
  const token = table.mint(meta)
  const out = table.hello({ ...helloSpawnRequest, ...over, spawn: token }, policy)
  if (!out.ok) throw new Error(`hello refused: ${out.code}`)
  return { token, binding: out.binding }
}

function resume(conn: Conn, policy: EnablePolicy = enableIdentity) {
  const { spawn: _spawn, ...rest } = helloSpawnRequest
  return table.hello({ ...rest, resume: { conn } }, policy)
}

beforeEach(() => {
  table = fresh()
})

describe('spawn-token ledger', () => {
  it('spawn token is one-time (conformance row 2)', () => {
    const { token, binding } = spawnHello()
    expect(table.resolve(binding.conn)).toBe(binding)
    table.touch(binding) // the first request that carries the conn
    const again = table.hello({ ...helloSpawnRequest, spawn: token }, enableIdentity)
    expect(again).toEqual({ ok: false, code: 'UNAUTHORIZED' })
  })

  it('lost hello response is recoverable (conformance row 3)', () => {
    const { token, binding } = spawnHello()
    const first = binding.conn
    // the mod never saw the response and never used the conn: it redeems again
    const again = table.hello({ ...helloSpawnRequest, spawn: token }, enableIdentity)
    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(again.binding.key).toBe(binding.key)
    expect(again.binding.conn).not.toBe(first)
    expect(table.resolve(first)).toBe('STALE_CONN')
    expect(table.resolve(again.binding.conn)).toBe(again.binding)
  })

  it('refuses an unknown, released or expired token', () => {
    expect(
      table.hello({ ...helloSpawnRequest, spawn: 'sp_nope' as never }, enableIdentity)
    ).toEqual({
      ok: false,
      code: 'UNAUTHORIZED'
    })
    const released = table.mint({ ...meta, owner: { kind: 'pty', ptyId: 'pty-2' } })
    table.release({ kind: 'pty', ptyId: 'pty-2' }, 'spawn-aborted')
    expect(table.hello({ ...helloSpawnRequest, spawn: released }, enableIdentity)).toEqual({
      ok: false,
      code: 'UNAUTHORIZED'
    })
    const stale = table.mint({ ...meta, owner: { kind: 'pty', ptyId: 'pty-3' } })
    t += SPAWN_REDEEM_WINDOW_MS + 1
    expect(table.hello({ ...helloSpawnRequest, spawn: stale }, enableIdentity)).toEqual({
      ok: false,
      code: 'UNAUTHORIZED'
    })
  })

  it('a hello with neither spawn nor resume is refused by the table', () => {
    const { spawn: _spawn, ...rest } = helloSpawnRequest
    expect(table.hello(rest, enableIdentity)).toEqual({ ok: false, code: 'UNAUTHORIZED' })
  })

  it('takes trust and cwd from the spawn, never from the request', () => {
    const { binding } = spawnHello({ cwd: '/somewhere/else' })
    expect(binding.trust).toBe('operator')
    const view = table.viewOf(binding)
    expect(view.trust).toBe('operator')
    expect(table.spawnRecord(owner)?.cwd).toBe('/tmp/example-project')
  })

  it('counts pending spawns and exposes a token-free spawn record', () => {
    const token = table.mint(meta)
    expect(table.pendingSpawns()).toBe(1)
    const rec = table.spawnRecord(owner)
    expect(rec).toEqual({ cwd: meta.cwd, trust: 'operator', state: 'minted' })
    expect(JSON.stringify(rec)).not.toContain(token)
    table.hello({ ...helloSpawnRequest, spawn: token }, enableIdentity)
    expect(table.pendingSpawns()).toBe(0)
    expect(table.spawnRecord(owner)?.state).toBe('redeemed')
    expect(table.spawnRecord({ kind: 'pty', ptyId: 'nobody' })).toBeNull()
  })

  it('a request on the conn spends the token; release records why', () => {
    const { binding } = spawnHello()
    table.touch(binding)
    expect(table.spawnRecord(owner)?.state).toBe('spent')
    table.release(owner, 'pty-exit')
    expect(table.spawnRecord(owner)).toMatchObject({
      state: 'released',
      releasedReason: 'pty-exit'
    })
  })
})

describe('resume', () => {
  it('resume rotates conn and keeps the binding', () => {
    const { binding } = spawnHello()
    table.touch(binding)
    binding.seq = { last: 9 }
    t += 5000
    const out = resume(binding.conn)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.kind).toBe('resume')
    expect(out.binding).toBe(binding)
    expect(binding.conn).not.toBe(binding.prevConn)
    expect(binding.seq).toEqual({ last: 0 }) // seq restarts at 1
    expect(binding.connUsed).toBe(false)
    expect(binding.lastRequestAt).toBe(t) // advanced, never rewound
  })

  it('lost resume response is recoverable once', () => {
    const { binding } = spawnHello()
    table.touch(binding)
    const c1 = binding.conn
    const first = resume(c1)
    expect(first.ok).toBe(true)
    const c2 = binding.conn
    // the response carrying c2 was lost: the mod resumes again with the conn it still holds
    const second = resume(c1)
    expect(second.ok).toBe(true)
    expect(binding.conn).not.toBe(c2)
    const c3 = binding.conn
    table.touch(binding) // any request on the current conn
    // now the previous conn is no longer recoverable
    expect(resume(c2)).toEqual({ ok: false, code: 'UNKNOWN_SESSION' })
    expect(table.resolve(c3)).toBe(binding)
  })

  it('a conn that matches nothing is UNKNOWN_SESSION on hello and STALE_CONN elsewhere', () => {
    spawnHello()
    expect(resume('c_ffffffffffffffffffffffffffffffff' as Conn)).toEqual({
      ok: false,
      code: 'UNKNOWN_SESSION'
    })
    expect(table.resolve('c_ffffffffffffffffffffffffffffffff' as Conn)).toBe('STALE_CONN')
  })

  it('a resume on a closed binding is UNKNOWN_SESSION', () => {
    const { binding } = spawnHello()
    const conn = binding.conn
    table.release(owner, 'pty-exit')
    expect(resume(conn)).toEqual({ ok: false, code: 'UNKNOWN_SESSION' })
  })

  it('does not rebind on a resume that carries another sid', () => {
    const { binding } = spawnHello()
    table.touch(binding)
    const { spawn: _s, ...rest } = helloSpawnRequest
    const out = table.hello(
      { ...rest, sid: '22222222-2222-4222-8222-222222222222', resume: { conn: binding.conn } },
      enableIdentity
    )
    expect(out.ok).toBe(true)
    expect(binding.sid).toBe(helloSpawnRequest.sid)
  })
})

describe('enable policy', () => {
  it('only ever enables a subset of declared, and the policy never sees a conn', () => {
    let seen = ''
    const { binding } = spawnHello({ declared: ['sense.identity'] }, (b) => {
      seen = JSON.stringify(b)
      return ['sense.identity', 'act.prompt']
    })
    expect(binding.enabled).toEqual(['sense.identity'])
    expect(seen).not.toContain(binding.conn)
    expect(seen).not.toContain('"conn"')
  })

  it('the default of a policy returning nothing is an inert binding', () => {
    const { binding } = spawnHello({}, () => [])
    expect(binding.enabled).toEqual([])
  })
})

describe('lease', () => {
  it('lease expiry and single edge (conformance row 21)', () => {
    const { binding } = spawnHello()
    table.touch(binding)
    expect(table.leaseOf(binding)).toBe('live')
    t += LEASE_TTL_MS - 1
    expect(table.leaseOf(binding)).toBe('live')
    expect(table.sweep()).toEqual([])
    t += 1
    expect(table.leaseOf(binding)).toBe('lost')
    expect(table.sweep()).toEqual([binding])
    expect(binding.leaseLostAt).toBe(t)
    t += 60_000
    expect(table.sweep()).toEqual([]) // the edge fires once
  })

  it('a parked request keeps the lease live', () => {
    const { binding } = spawnHello()
    const release = table.hold(table.viewOf(binding))
    t += LEASE_TTL_MS * 5
    expect(binding.parked).toBe(1)
    expect(table.leaseOf(binding)).toBe('live')
    expect(table.sweep()).toEqual([])
    release()
    release() // idempotent
    expect(binding.parked).toBe(0)
    // releasing counts as the last answered request: one full TTL from now
    expect(table.leaseOf(binding)).toBe('live')
    t += LEASE_TTL_MS
    expect(table.leaseOf(binding)).toBe('lost')
  })

  it('an inert binding is never swept as lost (contract §11.3)', () => {
    const { binding } = spawnHello({}, () => [])
    t += LEASE_TTL_MS * 3
    expect(table.sweep()).toEqual([])
    expect(binding.leaseLostAt).toBeNull()
  })

  it('resume from suspend grants one TTL of grace', () => {
    const a = spawnHello().binding
    const b = (() => {
      const token = table.mint({ ...meta, owner: { kind: 'pty', ptyId: 'pty-b' } })
      const out = table.hello({ ...helloSpawnRequest, spawn: token }, enableIdentity)
      if (!out.ok) throw new Error('hello')
      return out.binding
    })()
    t += LEASE_TTL_MS * 10 // the machine slept
    expect(table.leaseOf(a)).toBe('lost')
    table.grace(LEASE_TTL_MS)
    expect(table.sweep()).toEqual([])
    expect(table.leaseOf(a)).toBe('live')
    expect(table.leaseOf(b)).toBe('live')
    // grace is one TTL, not forever
    t += LEASE_TTL_MS
    expect(table.sweep().sort((x, y) => x.key - y.key)).toEqual([a, b])
  })

  it('grace never rewinds a binding that spoke later, and skips closed or ended ones', () => {
    const { binding } = spawnHello()
    t += 100
    table.touch(binding)
    table.grace(1000)
    expect(binding.lastRequestAt).toBe(t) // not pulled backwards
    table.end(binding, 'exit')
    t += 50_000
    table.grace(LEASE_TTL_MS)
    expect(table.leaseOf(binding)).toBe('lost')
  })
})

describe('end and release', () => {
  it('pty exit closes the binding', () => {
    const { binding } = spawnHello()
    table.touch(binding)
    const conn = binding.conn
    const released = table.release(owner, 'pty-exit')
    expect(released).toBe(binding)
    expect(binding.state).toBe('closed')
    expect(table.resolve(conn)).toBe('STALE_CONN')
    expect(table.leaseOf(binding)).toBe('lost')
    expect(table.release(owner, 'pty-exit')).toBeNull() // a second release finds nothing live
  })

  it('release before any hello closes nothing and returns null', () => {
    table.mint(meta)
    expect(table.release(owner, 'spawn-aborted')).toBeNull()
  })

  it('end marks the lease lost at once and the conn stale', () => {
    const { binding } = spawnHello()
    table.touch(binding)
    table.end(binding, 'exit')
    expect(binding.state).toBe('ended')
    expect(table.leaseOf(binding)).toBe('lost')
    expect(table.resolve(binding.conn)).toBe('STALE_CONN')
    expect(table.sweep()).toEqual([]) // an ended binding is not a lease edge
  })
})

describe('revoke, rebind, proof', () => {
  it('revoke empties enabled, makes the conn stale, and a resume is accepted', () => {
    const { binding } = spawnHello()
    table.touch(binding)
    const conn = binding.conn
    table.revoke(table.viewOf(binding))
    expect(binding.revoked).toBe(true)
    expect(binding.enabled).toEqual([])
    expect(table.resolve(conn)).toBe('STALE_CONN')
    const out = resume(conn, () => [])
    expect(out.ok).toBe(true)
    expect(binding.revoked).toBe(false)
    expect(binding.enabled).toEqual([])
    expect(binding.conn).not.toBe(conn)
  })

  it('rebind changes the sid and nothing else', () => {
    const { binding } = spawnHello()
    const conn = binding.conn
    table.rebind(binding, '33333333-3333-4333-8333-333333333333')
    expect(binding.sid).toBe('33333333-3333-4333-8333-333333333333')
    expect(binding.conn).toBe(conn)
  })

  it('markProven and revokeProof edit the proven set once per feature', () => {
    const { binding } = spawnHello()
    const view = table.viewOf(binding)
    table.markProven(view, 'sense.identity')
    table.markProven(view, 'sense.identity')
    expect(binding.proven).toEqual(['sense.identity'])
    table.revokeProof(view, 'sense.identity')
    table.revokeProof(view, 'sense.identity')
    expect(binding.proven).toEqual([])
  })

  it('a view of a binding that is gone is ignored by the writers', () => {
    const { binding } = spawnHello()
    const view = { ...table.viewOf(binding), key: 9999 }
    expect(() => table.revoke(view)).not.toThrow()
    expect(() => table.markProven(view, 'x.y')).not.toThrow()
    expect(binding.revoked).toBe(false)
  })
})

describe('views', () => {
  it('a view carries no conn and no spawn token, and resolves the session key', () => {
    table = fresh((o) => (o.kind === 'pty' ? `key-of-${o.ptyId}` : null))
    const { token, binding } = spawnHello()
    const json = JSON.stringify(table.view())
    expect(json).not.toContain(token)
    expect(json).not.toContain(binding.conn)
    expect(table.view()[0].sessionKey).toBe('key-of-pty-1')
    expect(table.view()[0].lease).toBe('live')
  })

  it('a tick binding is keyed tick:<workerId>:<runId> without a PTY', () => {
    const tick: SpawnOwner = { kind: 'tick', workerId: 'w1', runId: 'r9' }
    const token = table.mint({ owner: tick, trust: 'tick', cwd: '/tmp/x' })
    const out = table.hello({ ...helloSpawnRequest, spawn: token }, enableIdentity)
    if (!out.ok) throw new Error('hello')
    expect(table.viewOf(out.binding).sessionKey).toBe('tick:w1:r9')
    expect(table.viewOf(out.binding).trust).toBe('tick')
  })

  it('the profile follows isInteractive', () => {
    expect(spawnHello({ isInteractive: false }).binding.profile).toBe('headless')
    const token = table.mint({ ...meta, owner: { kind: 'pty', ptyId: 'pty-i' } })
    const out = table.hello({ ...helloSpawnRequest, spawn: token }, enableIdentity)
    if (!out.ok) throw new Error('hello')
    expect(out.binding.profile).toBe('interactive')
  })
})

describe('stamp verification (P2W5 consumer)', () => {
  const sha = (s: string): string => createHash('sha256').update(s).digest('hex')

  function stampFor(binding: Binding, nonce: string, tool: string) {
    return {
      handle: sha(`harnu-stamp-handle\n${binding.conn}`).slice(0, 12),
      mac: sha(`harnu-stamp-v1\n${binding.conn}\n${nonce}\n${tool}`).slice(0, 32)
    }
  }

  it('verifies once, then reports a replay; a wrong mac or handle never verifies', () => {
    const { binding } = spawnHello()
    const { handle, mac } = stampFor(binding, 'n1', 'mcp__harnu__get_fleet')
    const ok = table.verifyStamp(handle, 'n1', 'mcp__harnu__get_fleet', mac)
    expect(ok).toMatchObject({ verdict: 'verified' })
    expect(table.verifyStamp(handle, 'n1', 'mcp__harnu__get_fleet', mac)).toMatchObject({
      verdict: 'replayed'
    })
    expect(table.verifyStamp(handle, 'n2', 'mcp__harnu__get_fleet', 'f'.repeat(32))).toMatchObject({
      verdict: 'bad-mac'
    })
    // a bad mac does not burn the nonce
    const good = stampFor(binding, 'n2', 'mcp__harnu__get_fleet')
    expect(table.verifyStamp(good.handle, 'n2', 'mcp__harnu__get_fleet', good.mac)).toMatchObject({
      verdict: 'verified'
    })
    expect(table.verifyStamp('000000000000', 'n3', 't', mac)).toBe('unknown-binding')
    const result = table.verifyStamp(handle, 'n9', 't', 'x') as { binding: object }
    expect(JSON.stringify(result.binding)).not.toContain(binding.conn)
  })
})

describe('host down', () => {
  it('host down mints nothing', async () => {
    // a listener that failed to start: every spawn is a legacy spawn
    const host = createCompanionHost({
      dir: '/nowhere',
      mode: {
        getMode: () => 'shadow',
        listenerWanted: () => true,
        hydrate: async () => undefined,
        onChange: () => () => undefined
      },
      start: async () => {
        throw Object.assign(new Error('listen EACCES'), { code: 'EACCES' })
      },
      log: () => undefined
    })
    await host.register()
    expect(host.facade.mintSpawnToken(meta)).toBeNull()
    expect(host.facade.diagnostics().listener).toEqual({ state: 'failed', reason: 'EACCES' })
    expect(host.facade.diagnostics().pendingSpawns).toBe(0)
    expect(host.facade.spawnRecord(owner)).toBeNull() // nothing was recorded either
    await host.close()
  })
})
