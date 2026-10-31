/**
 * Campaign ch.5a (T597, spec §3.7 + Amendment b) — what the three installed hooks DO when Claude
 * Code fires them: the route handler (pure, deps injected), and the hook bridge's `/steward/…`
 * endpoint over a real loopback server (token guard, text answer, never blocks).
 */
import { describe, it, expect, vi } from 'vitest'
import { handleStewardRoute, type StewardRouteDeps } from '../src/main/steward-routes'
import { startHookServer } from '../src/main/hook-bridge'
import type { Mission } from '../src/main/mission-core'

const OWNER = '11111111-2222-4333-8444-555555555555'
const CHILD = '99999999-2222-4333-8444-555555555555'
const STRANGER = '77777777-2222-4333-8444-555555555555'

function mission(id: string, over: Partial<Mission> = {}): Mission {
  return {
    id,
    slug: id,
    folder: '/repo',
    owner: { sessionId: OWNER, folder: '/repo' },
    status: 'active',
    declaredEnd: { kind: 'code', target: `end of ${id}`, evidence: 'proof' },
    steps: [
      {
        id: 'stp-1',
        ordinal: 1,
        kind: 'custom',
        title: 'Do it',
        verification: 'verifier',
        proof: 'unproven',
        links: [{ kind: 'session', ref: CHILD }],
        blockers: []
      }
    ],
    blockers: [],
    openQuestions: [],
    createdAt: '2026-10-31T08:00:00.000Z',
    updatedAt: '2026-10-31T08:00:00.000Z',
    provenance: { author: 'agent', at: '2026-10-31T08:00:00.000Z' },
    ...over
  }
}

function deps(over: Partial<StewardRouteDeps> = {}): StewardRouteDeps & {
  compactions: Array<[string, string]>
  wakes: Array<[string, string]>
} {
  const compactions: Array<[string, string]> = []
  const wakes: Array<[string, string]> = []
  return {
    compactions,
    wakes,
    stewardedMissions: async () => [
      { mission: mission('mnt-aaaaaaaa'), title: 'Alpha' },
      {
        mission: mission('mnt-bbbbbbbb', { owner: { sessionId: STRANGER, folder: '/repo' } }),
        title: 'Beta'
      }
    ],
    gatesFor: async () => undefined,
    recordCompaction: async (folder, sessionId) => {
      compactions.push([folder, sessionId])
    },
    wake: async (missionId, reason) => {
      wakes.push([missionId, reason])
    },
    ...over
  }
}

describe('AC-5a.5 — SessionStart(compact) prints the Mission Brief for the missions the session owns', () => {
  it("returns the brief of the owner's stewarded mission and nobody else's", async () => {
    const out = await handleStewardRoute(
      'brief',
      { session_id: OWNER, cwd: '/repo', source: 'compact' },
      deps()
    )
    expect(out).toContain('mnt-aaaaaaaa')
    expect(out).toContain('end of mnt-aaaaaaaa')
    expect(out).not.toContain('mnt-bbbbbbbb')
  })

  it('prints nothing for a session that owns no stewarded mission, or for a non-compact start', async () => {
    expect(
      await handleStewardRoute(
        'brief',
        { session_id: CHILD, cwd: '/repo', source: 'compact' },
        deps()
      )
    ).toBe('')
    expect(
      await handleStewardRoute(
        'brief',
        { session_id: OWNER, cwd: '/repo', source: 'startup' },
        deps()
      )
    ).toBe('')
    expect(await handleStewardRoute('brief', { cwd: '/repo', source: 'compact' }, deps())).toBe('')
  })

  it('a closed mission gets no brief', async () => {
    const d = deps({
      stewardedMissions: async () => [
        { mission: mission('mnt-aaaaaaaa', { status: 'closed' }), title: 'A' }
      ]
    })
    expect(
      await handleStewardRoute('brief', { session_id: OWNER, cwd: '/repo', source: 'compact' }, d)
    ).toBe('')
  })

  it('carries the gates when the derive answers, and still prints without them when it throws', async () => {
    const withGates = await handleStewardRoute(
      'brief',
      { session_id: OWNER, cwd: '/repo', source: 'compact' },
      deps({ gatesFor: async () => ({ 'stp-1': { pr: 'running', ci: 'red' } }) })
    )
    expect(withGates).toMatch(/stp-1[^\n]*pr:running[^\n]*ci:red/)
    const broken = await handleStewardRoute(
      'brief',
      { session_id: OWNER, cwd: '/repo', source: 'compact' },
      deps({
        gatesFor: async () => {
          throw new Error('gh is down')
        }
      })
    )
    expect(broken).toContain('mnt-aaaaaaaa')
  })
})

describe('AC-5a.5 + Amendment (b) — PreCompact appends the compaction ledger row', () => {
  it('calls recordMissionCompaction for the session, in its folder', async () => {
    const d = deps()
    expect(await handleStewardRoute('precompact', { session_id: OWNER, cwd: '/repo' }, d)).toBe('')
    expect(d.compactions).toEqual([['/repo', OWNER]])
  })

  it('does nothing without a session id or a folder', async () => {
    const d = deps()
    await handleStewardRoute('precompact', { cwd: '/repo' }, d)
    await handleStewardRoute('precompact', { session_id: OWNER }, d)
    expect(d.compactions).toEqual([])
  })

  it('a failing ledger write never fails the hook', async () => {
    const d = deps({
      recordCompaction: async () => {
        throw new Error('disk full')
      }
    })
    await expect(
      handleStewardRoute('precompact', { session_id: OWNER, cwd: '/repo' }, d)
    ).resolves.toBe('')
  })
})

describe('AC-5a.5 + AC-5a.4 — Stop / SubagentStop of a child wakes its steward', () => {
  it('wakes the steward of every stewarded mission that links the stopping session as a child', async () => {
    const d = deps()
    await handleStewardRoute('wake', { session_id: CHILD, cwd: '/repo' }, d)
    expect(d.wakes).toEqual([
      ['mnt-aaaaaaaa', 'child-idle'],
      ['mnt-bbbbbbbb', 'child-idle']
    ])
  })

  it('does not wake for the owner, a stranger, or a closed mission', async () => {
    const d = deps({
      stewardedMissions: async () => [
        { mission: mission('mnt-aaaaaaaa'), title: 'A' },
        { mission: mission('mnt-cccccccc', { status: 'closed' }), title: 'C' }
      ]
    })
    await handleStewardRoute('wake', { session_id: OWNER, cwd: '/repo' }, d)
    await handleStewardRoute('wake', { session_id: STRANGER, cwd: '/repo' }, d)
    await handleStewardRoute('wake', { session_id: CHILD, cwd: '/repo' }, d)
    expect(d.wakes).toEqual([['mnt-aaaaaaaa', 'child-idle']])
  })
})

describe('the hook bridge serves /steward/<token>/<route>', () => {
  async function serve(handler: (route: string, body: Record<string, unknown>) => Promise<string>) {
    const started = await startHookServer(() => {}, 'tok-abc', { steward: handler })
    return started
  }
  const post = (port: number, p: string, body: unknown): Promise<Response> =>
    fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', body: JSON.stringify(body) })

  it('answers the brief as plain text, passing the hook payload through', async () => {
    const handler = vi.fn(async () => '# Mission Brief — hello')
    const s = await serve(handler)
    try {
      const res = await post(s.port, '/steward/tok-abc/brief', {
        session_id: OWNER,
        source: 'compact'
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toMatch(/text\/plain/)
      expect(await res.text()).toBe('# Mission Brief — hello')
      expect(handler).toHaveBeenCalledWith('brief', { session_id: OWNER, source: 'compact' })
    } finally {
      await s.close()
    }
  })

  it('403 on a wrong token, 404 on an unknown route; neither reaches the handler', async () => {
    const handler = vi.fn(async () => 'x')
    const s = await serve(handler)
    try {
      expect((await post(s.port, '/steward/WRONG/brief', {})).status).toBe(403)
      expect((await post(s.port, '/steward/tok-abc/explode', {})).status).toBe(404)
      expect(handler).not.toHaveBeenCalled()
    } finally {
      await s.close()
    }
  })

  it('a handler that throws still answers 200 with an empty body: a hook must never fail a session', async () => {
    const s = await serve(async () => {
      throw new Error('boom')
    })
    try {
      const res = await post(s.port, '/steward/tok-abc/wake', { session_id: CHILD })
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('')
    } finally {
      await s.close()
    }
  })

  it('with no steward handler registered the route is empty and harmless', async () => {
    const started = await startHookServer(() => {}, 'tok-abc')
    try {
      const res = await post(started.port, '/steward/tok-abc/brief', {})
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('')
    } finally {
      await started.close()
    }
  })
})
