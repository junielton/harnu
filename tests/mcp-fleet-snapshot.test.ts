import { describe, it, expect } from 'vitest'

/**
 * T7: pure `buildFleetSnapshot` — the redacted projection an MCP agent reads via
 * `harnu_fleet_status`. Mirrors the fleet-board factory/decorate-sort pattern, but
 * the disclosure contract is stricter: with `redactPaths`, NO absolute paths
 * leak (folders collapse to a stable alias + repoId), and a transcript / last
 * PTY line is NEVER projected — only `taskState` (hook FSM) + `status` (store).
 */
import {
  buildFleetSnapshot,
  filterFleetSnapshot,
  DEFAULT_FLEET_LIMIT,
  type FleetFolderInput,
  type FleetSessionInput,
  type FleetSnapshot,
  type FleetSessionSnapshot
} from '../src/main/mcp/fleet-snapshot'

/** Factory for a folder slice; `over` wins over the defaults. */
const folder = (
  path: string,
  over: Partial<Omit<FleetFolderInput, 'path'>> = {}
): FleetFolderInput => {
  const f: FleetFolderInput = { path }
  if (over.repoId !== undefined) f.repoId = over.repoId
  if (over.gitBranch !== undefined) f.gitBranch = over.gitBranch
  if (over.isMainWorktree !== undefined) f.isMainWorktree = over.isMainWorktree
  return f
}

/** Factory for a session slice; mirrors fleet-board's `bs`. */
const sess = (
  sessionId: string,
  folderPath: string,
  over: Partial<Omit<FleetSessionInput, 'sessionId' | 'folderPath'>> = {}
): FleetSessionInput => {
  const s: FleetSessionInput = {
    sessionId,
    folderPath,
    status: over.status ?? 'idle',
    isSidechain: over.isSidechain ?? false,
    modified: over.modified ?? ''
  }
  if (over.lastLine !== undefined) s.lastLine = over.lastLine
  if (over.transcript !== undefined) s.transcript = over.transcript
  if (over.orchestrator !== undefined) s.orchestrator = over.orchestrator
  if (over.hibernated !== undefined) s.hibernated = over.hibernated
  if (over.peer !== undefined) s.peer = over.peer
  return s
}

const baseInput = {
  folders: [] as FleetFolderInput[],
  sessions: [] as FleetSessionInput[],
  taskStates: {} as Record<string, import('../src/main/hook-state').TaskState>,
  inflightAgentSessions: [] as FleetSessionInput[]
}

const redacted = { redactPaths: true, denyFolders: [] as string[] }

describe('buildFleetSnapshot — empty', () => {
  it('empty input → {folders:[],sessions:[]}', () => {
    expect(buildFleetSnapshot(baseInput, redacted)).toEqual({ folders: [], sessions: [] })
  })
})

describe('buildFleetSnapshot — redaction (no absolute paths / transcript / lastLine)', () => {
  it('redactPaths → alias + repoId only, never an absolute path key', () => {
    const out = buildFleetSnapshot(
      {
        ...baseInput,
        folders: [
          folder('/home/u/secret-repo', { repoId: 'r1', gitBranch: 'main', isMainWorktree: true })
        ]
      },
      redacted
    )
    expect(out.folders).toHaveLength(1)
    const f = out.folders[0]
    expect(f.alias).toBe('secret-repo')
    expect(f.repoId).toBe('r1')
    expect(f.gitBranch).toBe('main')
    expect(f.isMainWorktree).toBe(true)
    // No absolute-path key, and the absolute string appears nowhere in the JSON.
    expect('path' in f).toBe(false)
    expect(JSON.stringify(out)).not.toContain('/home/u/secret-repo')
  })

  it('session redaction → folderAlias only, never folderPath, never transcript/lastLine bytes', () => {
    const out = buildFleetSnapshot(
      {
        ...baseInput,
        folders: [folder('/home/u/secret-repo')],
        sessions: [
          sess('s1', '/home/u/secret-repo', {
            lastLine: 'super secret last pty line',
            transcript: 'whole conversation transcript'
          })
        ]
      },
      redacted
    )
    const s = out.sessions[0]
    expect(s.folderAlias).toBe('secret-repo')
    expect('folderPath' in s).toBe(false)
    expect('lastLine' in s).toBe(false)
    expect('transcript' in s).toBe(false)
    const json = JSON.stringify(out)
    expect(json).not.toContain('/home/u/secret-repo')
    expect(json).not.toContain('super secret last pty line')
    expect(json).not.toContain('whole conversation transcript')
  })

  it('redactPaths:false attaches the absolute path on folders', () => {
    const out = buildFleetSnapshot(
      { ...baseInput, folders: [folder('/home/u/repo')] },
      { redactPaths: false, denyFolders: [] }
    )
    expect(out.folders[0].path).toBe('/home/u/repo')
    expect(out.folders[0].alias).toBe('repo')
  })
})

describe('buildFleetSnapshot — taskState (FSM) + status (store)', () => {
  it('merges taskState from the hook-FSM map and keeps status from the session', () => {
    const out = buildFleetSnapshot(
      {
        ...baseInput,
        folders: [folder('/r')],
        sessions: [sess('s1', '/r', { status: 'active' }), sess('s2', '/r', { status: 'idle' })],
        taskStates: { s1: 'needs-input' }
      },
      redacted
    )
    const byId = Object.fromEntries(out.sessions.map((s) => [s.sessionId, s]))
    expect(byId.s1.taskState).toBe('needs-input')
    expect(byId.s1.status).toBe('active')
    // s2 has no hook truth yet → taskState undefined, status preserved.
    expect(byId.s2.taskState).toBeUndefined()
    expect(byId.s2.status).toBe('idle')
  })

  it('projects a folder-terminal (shell) session with its screen-derived taskState (W6.2)', () => {
    // server.ts adds renderer-reported `shellterm-*` sessions to the inputs, and
    // their screen state is merged into `taskStates` (getScreenStates). Here we
    // pin that such a session projects exactly like a Claude one — cross-agent
    // fleet visibility, no transcript/lastLine.
    const out = buildFleetSnapshot(
      {
        ...baseInput,
        folders: [folder('/r')],
        sessions: [sess('shellterm-codex', '/r', { status: 'active' })],
        taskStates: { 'shellterm-codex': 'working' }
      },
      redacted
    )
    expect(out.sessions[0].sessionId).toBe('shellterm-codex')
    expect(out.sessions[0].taskState).toBe('working')
    expect(out.sessions[0].folderAlias).toBe('r')
    expect('transcript' in out.sessions[0]).toBe(false)
    expect('lastLine' in out.sessions[0]).toBe(false)
  })

  it('carries isSidechain + modified through (does not filter sidechains)', () => {
    const out = buildFleetSnapshot(
      {
        ...baseInput,
        folders: [folder('/r')],
        sessions: [sess('side', '/r', { isSidechain: true, modified: '2026-06-01T00:00:00.000Z' })]
      },
      redacted
    )
    expect(out.sessions.map((s) => s.sessionId)).toEqual(['side'])
    expect(out.sessions[0].isSidechain).toBe(true)
    expect(out.sessions[0].modified).toBe('2026-06-01T00:00:00.000Z')
  })
})

describe('buildFleetSnapshot — failureReason (BUG-64: a stuck session is visible, not "active")', () => {
  it('projects failureReason alongside a failed taskState', () => {
    const out = buildFleetSnapshot(
      {
        ...baseInput,
        folders: [folder('/r')],
        sessions: [sess('synthetic-a', '/r', { status: 'active' })],
        taskStates: { 'synthetic-a': 'failed' },
        failureReasons: { 'synthetic-a': 'prompt_undelivered' }
      },
      redacted
    )
    expect(out.sessions[0].taskState).toBe('failed')
    expect(out.sessions[0].failureReason).toBe('prompt_undelivered')
    // The activity-status axis is untouched — the fix is on taskState, mirroring
    // exactly how the renderer's own store represents this failure.
    expect(out.sessions[0].status).toBe('active')
  })

  it('omits failureReason entirely when absent (no field is projected, not a redacted false)', () => {
    const out = buildFleetSnapshot(
      {
        ...baseInput,
        folders: [folder('/r')],
        sessions: [sess('s1', '/r')],
        taskStates: { s1: 'working' }
      },
      redacted
    )
    expect('failureReason' in out.sessions[0]).toBe(false)
  })

  it('omits failureReason when the failureReasons input is not supplied at all (back-compat)', () => {
    const out = buildFleetSnapshot(
      { ...baseInput, folders: [folder('/r')], sessions: [sess('s1', '/r')] },
      redacted
    )
    expect('failureReason' in out.sessions[0]).toBe(false)
  })

  it('an inflight (unmaterialized) session also carries its failureReason (BUG-64 headline case)', () => {
    const out = buildFleetSnapshot(
      {
        ...baseInput,
        folders: [folder('/r')],
        sessions: [],
        inflightAgentSessions: [sess('synthetic-stuck', '/r', { status: 'active' })],
        taskStates: { 'synthetic-stuck': 'failed' },
        failureReasons: { 'synthetic-stuck': 'prompt_undelivered' }
      },
      redacted
    )
    expect(out.sessions).toHaveLength(1)
    expect(out.sessions[0].inflight).toBe(true)
    expect(out.sessions[0].taskState).toBe('failed')
    expect(out.sessions[0].failureReason).toBe('prompt_undelivered')
  })
})

describe('buildFleetSnapshot — orchestrator marker (T98)', () => {
  it('projects orchestrator:true only for an armed session', () => {
    const out = buildFleetSnapshot(
      {
        ...baseInput,
        folders: [folder('/r')],
        sessions: [sess('s1', '/r', { orchestrator: true }), sess('s2', '/r')]
      },
      redacted
    )
    const byId = Object.fromEntries(out.sessions.map((s) => [s.sessionId, s]))
    expect(byId.s1.orchestrator).toBe(true)
    expect(byId.s2.orchestrator).toBeUndefined()
  })
})

describe('buildFleetSnapshot — agentControllable is the INVERSE of a block', () => {
  it('marks folders/sessions controllable unless their folder is blocked', () => {
    const out = buildFleetSnapshot(
      {
        ...baseInput,
        folders: [folder('/allowed'), folder('/blocked')],
        sessions: [sess('a', '/allowed'), sess('b', '/blocked')]
      },
      { redactPaths: true, denyFolders: ['/blocked'] }
    )
    const fByAlias = Object.fromEntries(out.folders.map((f) => [f.alias, f]))
    expect(fByAlias.allowed.agentControllable).toBe(true)
    expect(fByAlias.blocked.agentControllable).toBe(false)
    const sById = Object.fromEntries(out.sessions.map((s) => [s.sessionId, s]))
    expect(sById.a.agentControllable).toBe(true)
    expect(sById.b.agentControllable).toBe(false)
  })

  it('with NO blocks, every folder/session is controllable (the default posture)', () => {
    // The bug this pins: while `agentControllable` was allowlist-derived, a folder the
    // gate would happily act in reported `false`, and a well-behaved agent read that
    // and stood down. The flag must not tell an agent to stand down in a folder that
    // is, in fact, actionable.
    const out = buildFleetSnapshot(
      {
        ...baseInput,
        folders: [folder('/a'), folder('/b')],
        sessions: [sess('a', '/a'), sess('b', '/b')]
      },
      { redactPaths: true }
    )
    expect(out.folders.every((f) => f.agentControllable)).toBe(true)
    expect(out.sessions.every((s) => s.agentControllable)).toBe(true)
  })

  it('a block covers the SUBTREE — a worktree of a blocked repo is not controllable', () => {
    const out = buildFleetSnapshot(
      {
        ...baseInput,
        folders: [folder('/repo/.claude/worktrees/wt'), folder('/other')],
        sessions: [sess('a', '/repo/.claude/worktrees/wt')]
      },
      { redactPaths: true, denyFolders: ['/repo'] }
    )
    const fByAlias = Object.fromEntries(out.folders.map((f) => [f.alias, f]))
    expect(fByAlias.wt.agentControllable).toBe(false)
    expect(fByAlias.other.agentControllable).toBe(true)
    expect(out.sessions[0].agentControllable).toBe(false)
  })
})

describe('buildFleetSnapshot — in-flight agent-created sessions (read-after-write)', () => {
  it('merges not-yet-migrated agent sessions and flags them inflight', () => {
    const out = buildFleetSnapshot(
      {
        ...baseInput,
        folders: [folder('/r')],
        sessions: [sess('disk1', '/r')],
        inflightAgentSessions: [sess('synthetic-xyz', '/r', { status: 'active' })],
        taskStates: { 'synthetic-xyz': 'working' }
      },
      redacted
    )
    const byId = Object.fromEntries(out.sessions.map((s) => [s.sessionId, s]))
    expect(Object.keys(byId).sort()).toEqual(['disk1', 'synthetic-xyz'])
    expect(byId['synthetic-xyz'].inflight).toBe(true)
    expect(byId['synthetic-xyz'].taskState).toBe('working')
    expect(byId.disk1.inflight).toBe(false)
  })

  it('a migrated session (same id on disk) wins over its inflight twin (no dup)', () => {
    const out = buildFleetSnapshot(
      {
        ...baseInput,
        folders: [folder('/r')],
        sessions: [sess('s1', '/r', { status: 'idle', modified: '2026-06-02T00:00:00.000Z' })],
        inflightAgentSessions: [
          sess('s1', '/r', { status: 'active', modified: '2026-06-01T00:00:00.000Z' })
        ]
      },
      redacted
    )
    expect(out.sessions).toHaveLength(1)
    expect(out.sessions[0].inflight).toBe(false)
    expect(out.sessions[0].status).toBe('idle')
    expect(out.sessions[0].modified).toBe('2026-06-02T00:00:00.000Z')
  })
})

describe('buildFleetSnapshot — deterministic stable ordering', () => {
  it('orders folders by path asc and sessions by (folder, modified desc, id)', () => {
    const out = buildFleetSnapshot(
      {
        ...baseInput,
        folders: [folder('/home/u/zeta'), folder('/home/u/alpha'), folder('/home/u/mid')],
        sessions: [
          sess('s3', '/home/u/zeta', { modified: '2026-06-01T00:00:00.000Z' }),
          sess('s1', '/home/u/alpha', { modified: '2026-06-20T00:00:00.000Z' }),
          sess('s2', '/home/u/alpha', { modified: '2026-06-21T00:00:00.000Z' })
        ]
      },
      redacted
    )
    expect(out.folders.map((f) => f.alias)).toEqual(['alpha', 'mid', 'zeta'])
    expect(out.sessions.map((s) => s.sessionId)).toEqual(['s2', 's1', 's3'])
  })

  it('invalid/empty modified sinks to the end within a folder group', () => {
    const out = buildFleetSnapshot(
      {
        ...baseInput,
        folders: [folder('/r')],
        sessions: [
          sess('old', '/r', { modified: '2026-06-01T10:00:00.000Z' }),
          sess('bad', '/r', { modified: '' }),
          sess('new', '/r', { modified: '2026-06-20T10:00:00.000Z' })
        ]
      },
      redacted
    )
    expect(out.sessions.map((s) => s.sessionId)).toEqual(['new', 'old', 'bad'])
  })

  it('is fully deterministic — shuffled input yields identical output', () => {
    const mk = (
      folders: FleetFolderInput[],
      sessions: FleetSessionInput[]
    ): ReturnType<typeof buildFleetSnapshot> =>
      buildFleetSnapshot({ ...baseInput, folders, sessions }, redacted)
    const t = '2026-06-10T10:00:00.000Z'
    const a = mk(
      [folder('/b'), folder('/a')],
      [sess('y', '/a', { modified: t }), sess('x', '/a', { modified: t }), sess('z', '/b')]
    )
    const b = mk(
      [folder('/a'), folder('/b')],
      [sess('z', '/b'), sess('x', '/a', { modified: t }), sess('y', '/a', { modified: t })]
    )
    expect(a).toEqual(b)
    // ties broken by sessionId asc → x before y.
    expect(a.sessions.map((s) => s.sessionId)).toEqual(['x', 'y', 'z'])
  })

  it('does not mutate its inputs', () => {
    const folders = [folder('/b'), folder('/a')]
    const sessions = [sess('s2', '/b'), sess('s1', '/a')]
    const inflight = [sess('s3', '/a')]
    const snap = JSON.parse(JSON.stringify({ folders, sessions, inflight }))
    buildFleetSnapshot(
      { ...baseInput, folders, sessions, inflightAgentSessions: inflight },
      redacted
    )
    expect({ folders, sessions, inflight }).toEqual(snap)
  })
})

describe('filterFleetSnapshot (T44 S3 — bounded, filtered fleet)', () => {
  const NOW = Date.parse('2026-07-03T12:00:00Z')
  const iso = (minAgo: number): string => new Date(NOW - minAgo * 60_000).toISOString()
  const sess = (over: Partial<FleetSessionSnapshot>): FleetSessionSnapshot => ({
    sessionId: 's',
    folderAlias: 'f',
    status: 'active',
    isSidechain: false,
    modified: iso(0),
    agentControllable: false,
    inflight: false,
    ...over
  })
  const snap = (sessions: FleetSessionSnapshot[]): FleetSnapshot => ({ folders: [], sessions })

  it('activeOnly keeps only working / needs-input', () => {
    const r = filterFleetSnapshot(
      snap([
        sess({ sessionId: 'a', taskState: 'working' }),
        sess({ sessionId: 'b', taskState: 'idle' }),
        sess({ sessionId: 'c', taskState: 'needs-input' }),
        sess({ sessionId: 'd' })
      ]),
      { activeOnly: true, now: NOW }
    )
    expect(r.sessions.map((x) => x.sessionId).sort()).toEqual(['a', 'c'])
  })

  it('sinceMinutes keeps only sessions within the window', () => {
    const r = filterFleetSnapshot(
      snap([
        sess({ sessionId: 'new', modified: iso(5) }),
        sess({ sessionId: 'old', modified: iso(120) })
      ]),
      { sinceMinutes: 60, now: NOW }
    )
    expect(r.sessions.map((x) => x.sessionId)).toEqual(['new'])
  })

  it('orders most-recent-first and caps at limit, reporting truncation (no silent cap)', () => {
    const r = filterFleetSnapshot(
      snap([
        sess({ sessionId: 'a', modified: iso(30) }),
        sess({ sessionId: 'b', modified: iso(10) }),
        sess({ sessionId: 'c', modified: iso(20) })
      ]),
      { limit: 2, now: NOW }
    )
    expect(r.sessions.map((x) => x.sessionId)).toEqual(['b', 'c'])
    expect(r.truncated).toEqual({ shown: 2, total: 3 })
  })

  it('applies DEFAULT_FLEET_LIMIT when no limit is given', () => {
    const many = Array.from({ length: DEFAULT_FLEET_LIMIT + 5 }, (_, i) =>
      sess({ sessionId: `s${i}`, modified: iso(i) })
    )
    const r = filterFleetSnapshot(snap(many), { now: NOW })
    expect(r.sessions).toHaveLength(DEFAULT_FLEET_LIMIT)
    expect(r.truncated).toEqual({ shown: DEFAULT_FLEET_LIMIT, total: DEFAULT_FLEET_LIMIT + 5 })
  })

  it('omits truncated when nothing is dropped', () => {
    const r = filterFleetSnapshot(snap([sess({ sessionId: 'a' })]), { now: NOW })
    expect(r.truncated).toBeUndefined()
    expect(r.sessions).toHaveLength(1)
  })
})

describe('buildFleetSnapshot — the T215 peer address (§3.7)', () => {
  it('projects { pid, socket } when the session has a resolved peer', () => {
    const out = buildFleetSnapshot(
      {
        ...baseInput,
        folders: [folder('/home/u/repo')],
        sessions: [
          sess('s1', '/home/u/repo', {
            peer: { pid: 758734, socket: '/run/user/1000/cc-socks/758734.sock' }
          })
        ]
      },
      redacted
    )
    expect(out.sessions[0].peer).toEqual({
      pid: 758734,
      socket: '/run/user/1000/cc-socks/758734.sock'
    })
  })

  it('OMITS peer entirely when none resolved (absence is not "dead")', () => {
    const out = buildFleetSnapshot(
      { ...baseInput, folders: [folder('/home/u/repo')], sessions: [sess('s1', '/home/u/repo')] },
      redacted
    )
    expect(out.sessions[0].peer).toBeUndefined()
    expect('peer' in out.sessions[0]).toBe(false)
  })

  it('runs the socket path through the transcript redactor: a home-rooted socket is aliased to ~', () => {
    // The macOS/`CLAUDE_CODE_TMPDIR` shape. Without this the snapshot — which
    // redacts every other path — would leak the OS username in the one field
    // it discloses.
    const out = buildFleetSnapshot(
      {
        ...baseInput,
        folders: [folder('/home/u/repo')],
        sessions: [
          sess('s1', '/home/u/repo', {
            peer: { pid: 42, socket: '/home/u/.cache/tmp/cc-socks/42.sock' }
          })
        ]
      },
      { ...redacted, home: '/home/u' }
    )
    expect(out.sessions[0].peer).toEqual({ pid: 42, socket: '~/.cache/tmp/cc-socks/42.sock' })
    expect(JSON.stringify(out)).not.toContain('junielton')
  })

  it('leaves the common Linux runtime socket untouched (no home segment to alias)', () => {
    const out = buildFleetSnapshot(
      {
        ...baseInput,
        folders: [folder('/home/u/repo')],
        sessions: [
          sess('s1', '/home/u/repo', {
            peer: { pid: 7, socket: '/run/user/1000/cc-socks/7.sock' }
          })
        ]
      },
      { ...redacted, home: '/home/u' }
    )
    expect(out.sessions[0].peer?.socket).toBe('/run/user/1000/cc-socks/7.sock')
  })

  it('never projects a transcript/lastLine alongside the peer', () => {
    const out = buildFleetSnapshot(
      {
        ...baseInput,
        folders: [folder('/home/u/repo')],
        sessions: [
          sess('s1', '/home/u/repo', {
            lastLine: 'secret line',
            transcript: 'secret transcript',
            peer: { pid: 7, socket: '/run/user/1000/cc-socks/7.sock' }
          })
        ]
      },
      redacted
    )
    expect(JSON.stringify(out)).not.toContain('secret')
  })
})
