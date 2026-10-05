import { describe, it, expect, vi } from 'vitest'
import {
  isDispatchable,
  parseHookRequest,
  runResolvers,
  serializeDecision,
  describeDecision,
  gateAction,
  type HookDecision,
  type Resolver,
  type RampScope
} from '../src/main/responder-dispatch'

/**
 * Pure-core tests for the hook responder dispatch substrate (spec §5.1). No
 * electron/IPC/server — only the risk logic, mirroring tests/hook-state.test.ts.
 */

function resolver(id: string, priority: number, resolve: Resolver['resolve']): Resolver {
  return { id, priority, resolve }
}

describe('isDispatchable', () => {
  it('returns true for the three always-dispatchable events', () => {
    expect(isDispatchable('PreToolUse')).toBe(true)
    expect(isDispatchable('PermissionRequest')).toBe(true)
    expect(isDispatchable('UserPromptSubmit')).toBe(true)
  })

  it('routes Notification only with the permission_prompt matcher', () => {
    expect(isDispatchable('Notification', 'permission_prompt')).toBe(true)
    expect(isDispatchable('Notification', 'idle_prompt')).toBe(false)
    expect(isDispatchable('Notification')).toBe(false)
  })

  it('returns false for observed-only / unknown events', () => {
    expect(isDispatchable('Stop')).toBe(false)
    expect(isDispatchable('SessionEnd')).toBe(false)
    expect(isDispatchable('StopFailure')).toBe(false)
    expect(isDispatchable('Xyz')).toBe(false)
  })
})

describe('parseHookRequest', () => {
  it('extracts snake_case tool_name / tool_input', () => {
    const r = parseHookRequest(
      'PreToolUse',
      undefined,
      { tool_name: 'Bash', tool_input: { cmd: 'ls' } },
      'S1'
    )
    expect(r.toolName).toBe('Bash')
    expect(r.toolInput).toEqual({ cmd: 'ls' })
    expect(r.sessionId).toBe('S1')
    expect(r.event).toBe('PreToolUse')
  })

  it('tolerates the camelCase toolName variant', () => {
    const r = parseHookRequest('PreToolUse', undefined, { toolName: 'Bash' }, 'S1')
    expect(r.toolName).toBe('Bash')
  })

  it('extracts the prompt for UserPromptSubmit', () => {
    const r = parseHookRequest('UserPromptSubmit', undefined, { prompt: 'oi' }, 'S1')
    expect(r.prompt).toBe('oi')
  })

  it('leaves optionals undefined on an empty body and never throws', () => {
    const r = parseHookRequest('PreToolUse', undefined, {}, 'S1')
    expect(r.toolName).toBeUndefined()
    expect(r.toolInput).toBeUndefined()
    expect(r.prompt).toBeUndefined()
    expect(r.raw).toEqual({})
  })

  it('does not throw on a malformed body (non-object tool_input)', () => {
    const r = parseHookRequest('PreToolUse', undefined, { tool_input: 42 }, 'S1')
    expect(r.toolInput).toBeUndefined()
    expect(r.raw).toEqual({ tool_input: 42 })
  })

  it('carries the matcher through', () => {
    const r = parseHookRequest('Notification', 'permission_prompt', {}, 'S1')
    expect(r.matcher).toBe('permission_prompt')
  })
})

const REQ = parseHookRequest('PreToolUse', undefined, { tool_name: 'Bash' }, 'S1')

describe('runResolvers — order and short-circuit', () => {
  it('runs by ascending priority and stops at the first non-null decision', async () => {
    const spy20 = vi.fn(() => ({ permissionDecision: 'allow' as const, by: 'r20' }))
    const resolvers = [
      resolver('r20', 20, spy20),
      resolver('r10', 10, () => ({ permissionDecision: 'deny', by: 'r10' }))
    ]
    const ctrl = new AbortController()
    const d = await runResolvers(REQ, resolvers, ctrl.signal)
    expect(d?.by).toBe('r10')
    expect(spy20).not.toHaveBeenCalled()
  })

  it('continues past abstentions and returns null when all abstain', async () => {
    const spy20 = vi.fn(() => null)
    const resolvers = [resolver('r10', 10, () => null), resolver('r20', 20, spy20)]
    const ctrl = new AbortController()
    const d = await runResolvers(REQ, resolvers, ctrl.signal)
    expect(d).toBeNull()
    expect(spy20).toHaveBeenCalledTimes(1)
  })
})

describe('runResolvers — throw = fail-open abstention', () => {
  it('treats a throwing resolver as null, calls onError, continues, never rejects', async () => {
    const onError = vi.fn()
    const boom = new Error('boom')
    const resolvers = [
      resolver('r10', 10, () => {
        throw boom
      }),
      resolver('r20', 20, () => ({ permissionDecision: 'deny' as const, by: 'r20' }))
    ]
    const ctrl = new AbortController()
    const d = await runResolvers(REQ, resolvers, ctrl.signal, onError)
    expect(d?.by).toBe('r20')
    expect(onError).toHaveBeenCalledWith('r10', boom)
  })

  it('treats an async rejection as null too', async () => {
    const onError = vi.fn()
    const resolvers = [resolver('r10', 10, async () => Promise.reject(new Error('async boom')))]
    const ctrl = new AbortController()
    await expect(runResolvers(REQ, resolvers, ctrl.signal, onError)).resolves.toBeNull()
    expect(onError).toHaveBeenCalled()
  })
})

describe('runResolvers — deadline/abort is a HARD ceiling', () => {
  it('(a) resolves null when a signal-aware resolver settles on abort', async () => {
    const ctrl = new AbortController()
    const resolvers = [
      resolver(
        'slow',
        10,
        (_req, signal) =>
          new Promise<HookDecision | null>((res) => {
            signal.addEventListener('abort', () => res(null), { once: true })
          })
      )
    ]
    setTimeout(() => ctrl.abort(), 10)
    await expect(runResolvers(REQ, resolvers, ctrl.signal)).resolves.toBeNull()
  })

  it('(b) resolves null at abort even when the resolver IGNORES the signal and never settles', async () => {
    const ctrl = new AbortController()
    const resolvers = [
      // Misbehaved: never settles, ignores the signal entirely.
      resolver('hang', 10, () => new Promise<HookDecision | null>(() => {}))
    ]
    const start = Date.now()
    setTimeout(() => ctrl.abort(), 10)
    const d = await runResolvers(REQ, resolvers, ctrl.signal)
    const elapsed = Date.now() - start
    expect(d).toBeNull()
    // Settled at the abort (~10ms), NOT waiting on the hung resolver.
    expect(elapsed).toBeLessThan(200)
  })

  it('returns null immediately if the signal is already aborted', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const spy = vi.fn(() => ({ permissionDecision: 'deny' as const, by: 'x' }))
    const d = await runResolvers(REQ, [resolver('x', 10, spy)], ctrl.signal)
    expect(d).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('serializeDecision — per-event mapping', () => {
  it('maps PreToolUse permissionDecision + reason → hookSpecificOutput', () => {
    const out = serializeDecision('PreToolUse', {
      permissionDecision: 'deny',
      reason: 'x',
      by: 's'
    })
    const o = JSON.parse(out)
    expect(o.hookSpecificOutput.hookEventName).toBe('PreToolUse')
    expect(o.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(o.hookSpecificOutput.permissionDecisionReason).toBe('x')
  })

  it('maps UserPromptSubmit additionalContext → hookSpecificOutput', () => {
    const out = serializeDecision('UserPromptSubmit', { additionalContext: 'ctx', by: 'b' })
    const o = JSON.parse(out)
    expect(o.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit')
    expect(o.hookSpecificOutput.additionalContext).toBe('ctx')
  })

  it('maps updatedInput / displayContent top-level', () => {
    expect(
      JSON.parse(serializeDecision('PreToolUse', { updatedInput: { a: 1 }, by: 'b' })).updatedInput
    ).toEqual({ a: 1 })
    expect(
      JSON.parse(serializeDecision('PreToolUse', { displayContent: 'd', by: 'b' })).displayContent
    ).toBe('d')
  })
})

describe('serializeDecision — by never leaks to the wire', () => {
  it('omits the by field entirely', () => {
    const out = serializeDecision('PreToolUse', { permissionDecision: 'deny', by: 'sentinel' })
    expect(out).not.toContain('"by"')
    expect(JSON.parse(out)).not.toHaveProperty('by')
  })
})

describe('serializeDecision — fail-open and totality', () => {
  it('null → {}', () => {
    expect(serializeDecision('PreToolUse', null)).toBe('{}')
  })

  it('drops fields invalid for the event (additionalContext on PreToolUse) → {}', () => {
    expect(serializeDecision('PreToolUse', { additionalContext: 'x', by: 'b' })).toBe('{}')
  })

  it('is total — any input parses back as JSON', () => {
    for (const ev of ['PreToolUse', 'PermissionRequest', 'UserPromptSubmit', 'Weird']) {
      const out = serializeDecision(ev, { permissionDecision: 'ask', by: 'b' })
      expect(() => JSON.parse(out)).not.toThrow()
    }
  })
})

describe('describeDecision', () => {
  it('summarizes a permission decision deterministically', () => {
    expect(describeDecision('PreToolUse', { permissionDecision: 'deny', by: 'sentinel' })).toBe(
      'PreToolUse→deny (sentinel)'
    )
  })

  it('summarizes an additionalContext injection', () => {
    const s = describeDecision('UserPromptSubmit', { additionalContext: '…', by: 'brief' })
    expect(s).toContain('UserPromptSubmit')
    expect(s).toContain('+context')
    expect(s).toContain('brief')
  })

  it('is deterministic for the same input', () => {
    const d: HookDecision = { permissionDecision: 'allow', by: 'r' }
    expect(describeDecision('PreToolUse', d)).toBe(describeDecision('PreToolUse', d))
  })
})

describe('gateAction (T30 per-folder trust ramp)', () => {
  const scope = (over: Partial<RampScope> = {}): RampScope => ({
    mode: 'active',
    trustAll: false,
    interceptFolders: new Set<string>(),
    ...over
  })
  const ON = '/home/u/repo'

  it('off mode → ignore (pure observer, no preview)', () => {
    expect(gateAction(scope({ mode: 'off' }), true, ON)).toBe('ignore')
  })

  it('a non-gated event → ignore regardless of mode', () => {
    expect(gateAction(scope({ mode: 'active', trustAll: true }), false, ON)).toBe('ignore')
    expect(gateAction(scope({ mode: 'shadow' }), false, ON)).toBe('ignore')
  })

  it('shadow mode → always preview (fleet-wide, never park)', () => {
    expect(gateAction(scope({ mode: 'shadow' }), true, ON)).toBe('preview')
    expect(gateAction(scope({ mode: 'shadow' }), true, null)).toBe('preview')
  })

  it('active + folder on the ramp → park', () => {
    expect(gateAction(scope({ interceptFolders: new Set([ON]) }), true, ON)).toBe('park')
  })

  it('active + folder OFF the ramp → preview (never blocked off-ramp)', () => {
    expect(gateAction(scope({ interceptFolders: new Set(['/other']) }), true, ON)).toBe('preview')
    expect(gateAction(scope(), true, ON)).toBe('preview') // empty ramp
  })

  it('active + trustAll → park every folder regardless of the ramp', () => {
    expect(gateAction(scope({ trustAll: true }), true, ON)).toBe('park')
    expect(gateAction(scope({ trustAll: true }), true, '/anything')).toBe('park')
  })

  it('active + unattributable folder (null) without trustAll → preview (fail-safe)', () => {
    expect(gateAction(scope({ interceptFolders: new Set([ON]) }), true, null)).toBe('preview')
  })

  it('active + null folder WITH trustAll → park (trustAll is folder-agnostic)', () => {
    expect(gateAction(scope({ trustAll: true }), true, null)).toBe('park')
  })
})
