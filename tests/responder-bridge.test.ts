import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { request } from 'node:http'
import { startHookServer, type BridgeEvent } from '../src/main/hook-bridge'
import { ResolverRegistry, getShadowLog, clearShadowLog } from '../src/main/responder-registry'
import type { HookDecision, Resolver, ResponderMode } from '../src/main/responder-dispatch'

/**
 * Integration tests for the dispatch branch wired into the live bridge (spec
 * §5.3). Real localhost POSTs (mirrors hook-bridge.test.ts). Proves: off = legacy
 * observer, shadow never decides (but runs + logs), active serializes, and
 * fail-open on throw / deadline. The observation path stays intact in every mode.
 */

function post(
  port: number,
  path: string,
  body: unknown
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }
      },
      (res) => {
        let text = ''
        res.on('data', (c) => (text += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }))
      }
    )
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

const denyResolver = (id = 'deny'): Resolver => ({
  id,
  priority: 10,
  resolve: () => ({ permissionDecision: 'deny', reason: 'nope', by: id }) as HookDecision
})

describe('responder dispatch wired into the bridge', () => {
  let close: (() => Promise<void>) | null = null
  beforeEach(() => clearShadowLog())
  afterEach(async () => {
    if (close) await close()
    close = null
  })

  it('mode off (and no opts) answers 200 {} and never runs a resolver', async () => {
    const reg = new ResolverRegistry()
    let called = false
    reg.register({ id: 'spy', priority: 10, resolve: () => ((called = true), null) })
    const started = await startHookServer(() => {}, 'tok', {
      getMode: () => 'off',
      registry: reg
    })
    close = started.close
    const res = await post(started.port, '/hook/tok/PreToolUse/_', {
      session_id: 'S1',
      tool_name: 'Bash'
    })
    expect(res.status).toBe(200)
    expect(res.text).toBe('{}')
    expect(called).toBe(false)
  })

  it('legacy positional call (no opts) stays a pure observer', async () => {
    const started = await startHookServer(() => {}, 'tok')
    close = started.close
    const res = await post(started.port, '/hook/tok/PreToolUse/_', {
      session_id: 'S1',
      tool_name: 'Bash'
    })
    expect(res.text).toBe('{}')
  })

  it('mode shadow runs the resolver, never decides, and pushes one ShadowEntry', async () => {
    const reg = new ResolverRegistry()
    let called = false
    reg.register({
      id: 'deny',
      priority: 10,
      resolve: () => ((called = true), { permissionDecision: 'deny', by: 'deny' } as HookDecision)
    })
    const started = await startHookServer(() => {}, 'tok', {
      getMode: () => 'shadow',
      registry: reg
    })
    close = started.close
    const res = await post(started.port, '/hook/tok/PreToolUse/_', {
      session_id: 'S1',
      tool_name: 'Bash'
    })
    expect(res.text).toBe('{}') // shadow NEVER decides
    expect(called).toBe(true)
    const log = getShadowLog()
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({ sessionId: 'S1', event: 'PreToolUse', by: 'deny' })
    expect(log[0].summary).toBe('PreToolUse→deny (deny)')
  })

  it('does not push a ShadowEntry in active or off', async () => {
    for (const mode of ['active', 'off'] as ResponderMode[]) {
      const reg = new ResolverRegistry()
      reg.register(denyResolver())
      const started = await startHookServer(() => {}, 'tok', { getMode: () => mode, registry: reg })
      await post(started.port, '/hook/tok/PreToolUse/_', { session_id: 'S1', tool_name: 'Bash' })
      await started.close()
    }
    expect(getShadowLog()).toHaveLength(0)
  })

  it('mode active serializes the decision the CC obeys', async () => {
    const reg = new ResolverRegistry()
    reg.register(denyResolver())
    const started = await startHookServer(() => {}, 'tok', {
      getMode: () => 'active',
      registry: reg
    })
    close = started.close
    const res = await post(started.port, '/hook/tok/PreToolUse/_', {
      session_id: 'S1',
      tool_name: 'Bash'
    })
    const o = JSON.parse(res.text)
    expect(o.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(o.hookSpecificOutput.permissionDecisionReason).toBe('nope')
  })

  it('mode active does not route a non-dispatchable event (Stop)', async () => {
    const reg = new ResolverRegistry()
    let called = false
    reg.register({ id: 'spy', priority: 10, resolve: () => ((called = true), null) })
    const started = await startHookServer(() => {}, 'tok', {
      getMode: () => 'active',
      registry: reg
    })
    close = started.close
    const res = await post(started.port, '/hook/tok/Stop/_', { session_id: 'S1' })
    expect(res.text).toBe('{}')
    expect(called).toBe(false)
  })

  it('fails open (200 {}) when a resolver throws in active', async () => {
    const reg = new ResolverRegistry()
    reg.register({
      id: 'boom',
      priority: 10,
      resolve: () => {
        throw new Error('boom')
      }
    })
    const started = await startHookServer(() => {}, 'tok', {
      getMode: () => 'active',
      registry: reg
    })
    close = started.close
    const res = await post(started.port, '/hook/tok/PreToolUse/_', {
      session_id: 'S1',
      tool_name: 'Bash'
    })
    expect(res.status).toBe(200)
    expect(res.text).toBe('{}')
  })

  it('fails open by deadline before a slow resolver settles', async () => {
    const reg = new ResolverRegistry()
    reg.register({
      id: 'slow',
      priority: 10,
      // Ignores the signal and settles late — the deadline must win.
      resolve: () =>
        new Promise<HookDecision | null>((res) =>
          setTimeout(() => res({ permissionDecision: 'deny', by: 'slow' }), 200)
        )
    })
    const started = await startHookServer(() => {}, 'tok', {
      getMode: () => 'active',
      registry: reg,
      deadlineMs: 20
    })
    close = started.close
    const t0 = Date.now()
    const res = await post(started.port, '/hook/tok/PreToolUse/_', {
      session_id: 'S1',
      tool_name: 'Bash'
    })
    const elapsed = Date.now() - t0
    expect(res.text).toBe('{}')
    expect(elapsed).toBeLessThan(150) // responded at the deadline, not at 200ms
  })

  it('keeps observation intact in every mode (onEvent still fires)', async () => {
    for (const mode of ['off', 'shadow', 'active'] as ResponderMode[]) {
      const events: BridgeEvent[] = []
      const reg = new ResolverRegistry()
      reg.register(denyResolver())
      const started = await startHookServer((e) => events.push(e), 'tok', {
        getMode: () => mode,
        registry: reg
      })
      await post(started.port, '/hook/tok/PreToolUse/_', { session_id: 'S1', tool_name: 'Bash' })
      await started.close()
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ sessionId: 'S1', event: 'PreToolUse' })
    }
  })

  it('routes purely by URL/token — no sentinel inspected (lesson 002)', async () => {
    // The server has no access to settings.json; routing is token + isDispatchable.
    // A correct token dispatches regardless of any _om2tab sentinel state.
    const reg = new ResolverRegistry()
    reg.register(denyResolver())
    const started = await startHookServer(() => {}, 'tok', {
      getMode: () => 'active',
      registry: reg
    })
    close = started.close
    const ok = await post(started.port, '/hook/tok/PreToolUse/_', {
      session_id: 'S1',
      tool_name: 'Bash'
    })
    expect(JSON.parse(ok.text).hookSpecificOutput.permissionDecision).toBe('deny')
    const bad = await post(started.port, '/hook/WRONG/PreToolUse/_', { session_id: 'S1' })
    expect(bad.status).toBe(403)
  })
})
