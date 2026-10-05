import { describe, it, expect, vi } from 'vitest'
import {
  planDehydrate,
  normalizeEphemeralEntry,
  deriveHydration,
  emptyHydrationFile,
  normalizeHydrationFile,
  withDehydrated,
  withRehydrated,
  withReconciled,
  parseTrackedStatus,
  diffFingerprints,
  parseDuMulti,
  dehydrateItem,
  rehydrateItem,
  toSetupOutcome,
  manifestFactsFor,
  type EphemeralEntryFacts,
  type DehydrateDeps,
  type RehydrateDeps,
  type TrackedFingerprint
} from '../src/main/reaper/dehydrate-core'
import type { ReapItem } from '../src/main/reaper/reaper-core'

/**
 * T250 — the pure core of dehydration. The four guards are the whole feature,
 * so every refusal path is a table row here, and the executor's re-probes are
 * exercised against fakes that change their answer between scan and click.
 */

function dir(p: string, over: Partial<EphemeralEntryFacts> = {}): EphemeralEntryFacts {
  return { path: p, presence: 'dir', contained: true, ignored: true, tracked: false, ...over }
}

function wtItem(over: Partial<ReapItem> = {}): ReapItem {
  return {
    id: 'wt-1',
    repoPath: '/repo',
    kind: 'worktree',
    branch: 'feat/x',
    path: '/repo/.claude/worktrees/feat-x',
    hidden: false,
    ageDays: 30,
    diskBytes: null,
    checkpoints: [],
    verdict: 'blocked',
    blockers: ['dirty'],
    needsRemoteDelete: false,
    untracked: [],
    justifiedBy: null,
    hydration: null,
    ...over
  }
}

describe('normalizeEphemeralEntry', () => {
  it.each([
    ['node_modules', 'node_modules'],
    ['node_modules/', 'node_modules'],
    ['  vendor  ', 'vendor'],
    ['packages/app/node_modules', 'packages/app/node_modules']
  ])('keeps a plain relative path: %s', (raw, want) => {
    expect(normalizeEphemeralEntry(raw)).toBe(want)
  })

  it.each([
    '',
    '.',
    '..',
    '../x',
    'a/../b',
    '/abs',
    'C:/x',
    '.git',
    '.git/hooks',
    'a\\b',
    '*',
    'x/**'
  ])('refuses an entry that could reach outside the plain tree: %j', (raw) => {
    expect(normalizeEphemeralEntry(raw)).toBeNull()
  })
})

describe('planDehydrate — the four guards', () => {
  const eph = ['node_modules', 'vendor', '.venv', 'venv']
  const plan = (entries: EphemeralEntryFacts[], sessionLive = false, ephemeral = eph) =>
    planDehydrate({ sessionLive, ephemeral, entries })

  it('removes a listed, ignored, untracked directory in an idle worktree', () => {
    expect(plan([dir('node_modules')])).toEqual({ removable: ['node_modules'], skipped: [] })
  })

  it.each<[string, Partial<EphemeralEntryFacts>, string]>([
    // AC-3 — a project that commits vendor/: git does not ignore it and tracks it.
    ['committed vendor/', { ignored: false, tracked: true }, 'tracked'],
    // Force-added files under an ignored dir: guard 3 catches what guard 2 misses.
    ['ignored but force-added', { ignored: true, tracked: true }, 'tracked'],
    ['not ignored, not tracked', { ignored: false, tracked: false }, 'not-ignored'],
    ['check-ignore failed', { ignored: null }, 'probe-failed'],
    ['ls-files failed', { tracked: null }, 'probe-failed'],
    ['a seeded symlink', { presence: 'symlink' }, 'symlink'],
    ['a file, not a dir', { presence: 'other' }, 'not-directory'],
    ['lstat failed', { presence: 'unreadable' }, 'probe-failed'],
    ['parent escapes via symlink', { contained: false }, 'unsafe-path']
  ])('skips %s', (_label, over, reason) => {
    expect(plan([dir('vendor', over)])).toEqual({
      removable: [],
      skipped: [{ path: 'vendor', reason }]
    })
  })

  // AC-4 — guard 4 in the pure core, not left to the renderer's `active` filter.
  it('returns skip-with-reason session-live for a live-session candidate, even with every other guard green', () => {
    expect(plan([dir('node_modules'), dir('vendor')], true)).toEqual({
      removable: [],
      skipped: [
        { path: 'node_modules', reason: 'session-live' },
        { path: 'vendor', reason: 'session-live' }
      ]
    })
  })

  it('guard 1: a directory not listed as ephemeral is never removable, whatever its facts', () => {
    expect(plan([dir('dist'), dir('target'), dir('.next')])).toEqual({ removable: [], skipped: [] })
  })

  it('build outputs are not in the default list — they opt in per project', () => {
    expect(plan([dir('dist')], false, ['dist']).removable).toEqual(['dist'])
  })

  it('an absent entry is neither removable nor a skip — there is nothing to explain', () => {
    expect(plan([dir('node_modules', { presence: 'absent' })])).toEqual({
      removable: [],
      skipped: []
    })
  })

  it('names an unsafe manifest entry instead of acting on it', () => {
    expect(plan([], false, ['../outside', 'node_modules']).skipped).toEqual([
      { path: '../outside', reason: 'unsafe-path' }
    ])
  })

  it('a trailing slash in the manifest matches the probed entry', () => {
    expect(plan([dir('node_modules')], false, ['node_modules/']).removable).toEqual([
      'node_modules'
    ])
  })

  it('a nested entry goes with its removable ancestor, not twice', () => {
    expect(
      plan([dir('node_modules'), dir('node_modules/.cache')], false, [
        'node_modules',
        'node_modules/.cache'
      ]).removable
    ).toEqual(['node_modules'])
  })
})

describe('hydration records and derived row state', () => {
  const noPlan = { removable: [], skipped: [] }

  it('reads dehydrated only when Harnu recorded it AND the removed paths are still gone', () => {
    const file = withDehydrated(emptyHydrationFile(), '/wt', ['node_modules'], 1)
    const d = deriveHydration({
      record: file.worktrees['/wt'],
      entries: [dir('node_modules', { presence: 'absent' })],
      plan: noPlan,
      canRehydrate: true,
      stillChanged: [],
      reclaimableBytes: null
    })
    expect(d.info.state).toBe('dehydrated')
    expect(d.dehydrationStale).toBe(false)
  })

  it('a never-installed checkout is hydrated with nothing to do — not "dehydrated"', () => {
    const d = deriveHydration({
      record: undefined,
      entries: [dir('node_modules', { presence: 'absent' })],
      plan: noPlan,
      canRehydrate: true,
      stillChanged: [],
      reclaimableBytes: null
    })
    expect(d.info).toMatchObject({ state: 'hydrated', removable: [] })
  })

  it('an operator install brings it back to hydrated and flags the record stale', () => {
    const file = withDehydrated(emptyHydrationFile(), '/wt', ['node_modules'], 1)
    const d = deriveHydration({
      record: file.worktrees['/wt'],
      entries: [dir('node_modules')],
      plan: { removable: ['node_modules'], skipped: [] },
      canRehydrate: true,
      stillChanged: [],
      reclaimableBytes: 42
    })
    expect(d.info.state).toBe('hydrated')
    expect(d.info.reclaimableBytes).toBe(42)
    expect(d.dehydrationStale).toBe(true)
  })

  it('a successful rehydrate clears the dehydrated state and keeps the files it changed', () => {
    let file = withDehydrated(emptyHydrationFile(), '/wt', ['node_modules'], 1)
    file = withRehydrated(file, '/wt', ['package-lock.json'], true, 2)
    expect(file.worktrees['/wt']).toEqual({
      dehydratedAt: null,
      removed: [],
      rehydratedAt: 2,
      rehydrateChanged: ['package-lock.json']
    })
  })

  it('a failed rehydrate keeps the row owing a rehydrate', () => {
    let file = withDehydrated(emptyHydrationFile(), '/wt', ['node_modules'], 1)
    file = withRehydrated(file, '/wt', [], false, 2)
    expect(file.worktrees['/wt'].dehydratedAt).toBe(1)
    expect(file.worktrees['/wt'].removed).toEqual(['node_modules'])
  })

  it('reconciliation drops a committed lockfile and removes an empty record', () => {
    let file = withRehydrated(emptyHydrationFile(), '/wt', ['package-lock.json'], true, 2)
    file = withReconciled(file, '/wt', { dehydrationStale: false, stillChanged: [] })
    expect(file.worktrees['/wt']).toBeUndefined()
  })

  it('a second dehydration widens the removed set', () => {
    let file = withDehydrated(emptyHydrationFile(), '/wt', ['node_modules'], 1)
    file = withDehydrated(file, '/wt', ['vendor'], 2)
    expect(file.worktrees['/wt'].removed).toEqual(['node_modules', 'vendor'])
  })

  it('normalizes junk to an empty file', () => {
    expect(normalizeHydrationFile(null)).toEqual(emptyHydrationFile())
    expect(normalizeHydrationFile({ worktrees: [] })).toEqual(emptyHydrationFile())
    expect(
      normalizeHydrationFile({ worktrees: { '/a': { dehydratedAt: 'x', removed: [1] } } })
    ).toEqual(emptyHydrationFile())
  })
})

describe('tracked-set fingerprint helpers', () => {
  it('parseTrackedStatus keeps tracked records and skips untracked, ignored and rename sources', () => {
    const out = parseTrackedStatus(' M src/a.ts\0?? notes.md\0R  new.ts\0old.ts\0!! dist\0')
    expect([...out.entries()]).toEqual([
      ['src/a.ts', ' M'],
      ['new.ts', 'R ']
    ])
  })

  it('diffFingerprints names every path whose state or content moved', () => {
    const before: TrackedFingerprint = new Map([
      ['a', ' M:1'],
      ['b', ' M:2']
    ])
    const after: TrackedFingerprint = new Map([
      ['a', ' M:1'],
      ['b', ' M:3'],
      ['package-lock.json', ' M:9']
    ])
    expect(diffFingerprints(before, after)).toEqual(['b', 'package-lock.json'])
    expect(diffFingerprints(before, before)).toEqual([])
  })
})

describe('parseDuMulti', () => {
  it('reads each child and sums the root remainder into the total', () => {
    const out = ['300003\t/wt/node_modules', '2\t/wt/vendor', '27183\t/wt', ''].join('\0')
    const r = parseDuMulti(out, '/wt', ['/wt/node_modules', '/wt/vendor'])
    expect(r.total).toBe(327188)
    expect(r.byPath.get('/wt/node_modules')).toBe(300003)
  })

  it('reports no total when the root line is missing — never a partial sum', () => {
    const r = parseDuMulti('300003\t/wt/node_modules\0', '/wt', ['/wt/node_modules'])
    expect(r.total).toBeNull()
  })
})

// ---- the executor -----------------------------------------------------------

function fakeDehydrateDeps(over: Partial<DehydrateDeps> = {}): {
  deps: DehydrateDeps
  removed: string[]
  calls: string[]
} {
  const removed: string[] = []
  const calls: string[] = []
  const deps: DehydrateDeps = {
    isSessionLive: vi.fn(async () => {
      calls.push('session')
      return false
    }),
    readManifest: vi.fn(async () => ({ ephemeral: ['node_modules', 'vendor'], setup: ['npm ci'] })),
    probeEntries: vi.fn(async (_wt: string, entries: readonly string[]) => {
      calls.push('probe')
      return entries.map((p) => dir(p, p === 'vendor' ? { ignored: false, tracked: true } : {}))
    }),
    trackedFingerprint: vi.fn(async () => new Map([['src/a.ts', ' M:abc']])),
    removeDir: vi.fn(async (p: string) => {
      calls.push('remove')
      removed.push(p)
    }),
    recordDehydrated: vi.fn(async () => undefined),
    ...over
  }
  return { deps, removed, calls }
}

describe('dehydrateItem', () => {
  it('removes only what passes every guard and records it', async () => {
    const { deps, removed } = fakeDehydrateDeps()
    const r = await dehydrateItem(wtItem(), deps)
    expect(r.ok).toBe(true)
    expect(removed).toEqual(['/repo/.claude/worktrees/feat-x/node_modules'])
    expect(r.skipped).toEqual([{ path: 'vendor', reason: 'tracked' }])
    expect(deps.recordDehydrated).toHaveBeenCalledWith('/repo/.claude/worktrees/feat-x', [
      'node_modules'
    ])
  })

  // AC-4 — the execution path re-probes guard 4; the scan's row is not trusted.
  it('re-probes the session at execution time and refuses when one started since the scan', async () => {
    const { deps, removed } = fakeDehydrateDeps({ isSessionLive: vi.fn(async () => true) })
    const scanned = wtItem({
      hydration: {
        state: 'hydrated',
        removable: ['node_modules'],
        skipped: [],
        reclaimableBytes: 10,
        canRehydrate: true,
        rehydrateChanged: []
      }
    })
    const r = await dehydrateItem(scanned, deps)
    expect(r.ok).toBe(false)
    expect(removed).toEqual([])
    expect(r.skipped).toContainEqual({ path: 'node_modules', reason: 'session-live' })
    expect(deps.isSessionLive).toHaveBeenCalledWith('/repo/.claude/worktrees/feat-x')
  })

  it('checks the session as the LAST step before removing anything', async () => {
    const { deps, calls } = fakeDehydrateDeps()
    await dehydrateItem(wtItem(), deps)
    expect(calls.indexOf('session')).toBeGreaterThan(calls.indexOf('probe'))
    expect(calls.indexOf('session')).toBeLessThan(calls.indexOf('remove'))
  })

  it('fails closed when the session probe itself fails', async () => {
    const { deps, removed } = fakeDehydrateDeps({
      isSessionLive: vi.fn(async () => {
        throw new Error('fleet unavailable')
      })
    })
    const r = await dehydrateItem(wtItem(), deps)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/session re-probe failed/)
    expect(removed).toEqual([])
  })

  it('re-probes guards 2 and 3: a directory tracked since the scan is refused', async () => {
    const { deps, removed } = fakeDehydrateDeps({
      probeEntries: vi.fn(async () => [dir('node_modules', { tracked: true })])
    })
    const r = await dehydrateItem(wtItem(), deps)
    expect(removed).toEqual([])
    expect(r.skipped).toEqual([{ path: 'node_modules', reason: 'tracked' }])
  })

  it('a refusal on an active row never reaches the session probe or a removal', async () => {
    const { deps, removed } = fakeDehydrateDeps()
    const r = await dehydrateItem(wtItem({ verdict: 'active' }), deps)
    expect(r.ok).toBe(false)
    expect(removed).toEqual([])
  })

  it('reports a per-path failure as an outcome and still removes the rest', async () => {
    const { deps, removed } = fakeDehydrateDeps({
      readManifest: vi.fn(async () => ({ ephemeral: ['node_modules', '.venv'], setup: [] })),
      probeEntries: vi.fn(async (_wt: string, e: readonly string[]) => e.map((p) => dir(p))),
      removeDir: vi.fn(async (p: string) => {
        if (p.endsWith('node_modules')) throw new Error('EPERM: operation not permitted')
        removed.push(p)
      })
    })
    const r = await dehydrateItem(wtItem(), deps)
    expect(r.ok).toBe(false)
    expect(r.failed).toEqual([{ path: 'node_modules', error: 'EPERM: operation not permitted' }])
    expect(r.removed).toEqual(['.venv'])
    expect(removed).toHaveLength(1)
  })

  it('fails loudly if the tracked set moved during the removal', async () => {
    let n = 0
    const { deps } = fakeDehydrateDeps({
      trackedFingerprint: vi.fn(async () => new Map([['src/a.ts', n++ === 0 ? ' M:1' : ' M:2']]))
    })
    const r = await dehydrateItem(wtItem(), deps)
    expect(r.ok).toBe(false)
    expect(r.trackedChanged).toEqual(['src/a.ts'])
  })

  it('reaches detached worktrees — no branch, no merge signal needed', async () => {
    const { deps, removed } = fakeDehydrateDeps()
    const r = await dehydrateItem(
      wtItem({ kind: 'detached-worktree', branch: undefined, blockers: ['detached-head'] }),
      deps
    )
    expect(r.ok).toBe(true)
    expect(removed).toHaveLength(1)
  })

  it('refuses a kind with no checkout', async () => {
    const { deps } = fakeDehydrateDeps()
    const r = await dehydrateItem(wtItem({ kind: 'local-branch', path: undefined }), deps)
    expect(r.ok).toBe(false)
    expect(deps.probeEntries).not.toHaveBeenCalled()
  })
})

// ---- rehydrate ----------------------------------------------------------------

function fakeRehydrateDeps(over: Partial<RehydrateDeps> = {}): RehydrateDeps {
  return {
    isSessionLive: vi.fn(async () => false),
    readManifest: vi.fn(async () => ({ ephemeral: ['node_modules'], setup: ['npm ci'] })),
    preflightShell: vi.fn(async () => undefined),
    runSetupStep: vi.fn(async () => ({ ok: true as const })),
    setupPath: vi.fn(async () => '/usr/local/bin:/usr/bin'),
    trackedFingerprint: vi.fn(async () => new Map()),
    recordRehydrated: vi.fn(async () => undefined),
    ...over
  }
}

describe('rehydrateItem', () => {
  it('refuses plainly when the manifest declares no setup', async () => {
    const deps = fakeRehydrateDeps({
      readManifest: vi.fn(async () => ({ ephemeral: ['node_modules'], setup: [] }))
    })
    const r = await rehydrateItem(wtItem(), deps)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/no setup step/)
    expect(deps.runSetupStep).not.toHaveBeenCalled()
  })

  it('refuses a folder in use without running anything', async () => {
    const deps = fakeRehydrateDeps({ isSessionLive: vi.fn(async () => true) })
    const r = await rehydrateItem(wtItem(), deps)
    expect(r.ok).toBe(false)
    expect(deps.runSetupStep).not.toHaveBeenCalled()
  })

  // AC-2 — the install rewrote a tracked lockfile: named, not hidden.
  it('names the tracked files the install modified', async () => {
    let n = 0
    const deps = fakeRehydrateDeps({
      trackedFingerprint: vi.fn(async () =>
        n++ === 0 ? new Map() : new Map([['package-lock.json', ' M:9']])
      )
    })
    const r = await rehydrateItem(wtItem(), deps)
    expect(r).toMatchObject({ ok: true, changedTracked: ['package-lock.json'] })
    expect(deps.recordRehydrated).toHaveBeenCalledWith(
      '/repo/.claude/worktrees/feat-x',
      ['package-lock.json'],
      true
    )
  })

  // AC-5 — create_worktree's WORKTREE_PROVISION_FAILED vocabulary, reused.
  it('reports a failed step as WORKTREE_PROVISION_FAILED with stage, step, command, kind, binary and path', async () => {
    const deps = fakeRehydrateDeps({
      readManifest: vi.fn(async () => ({
        ephemeral: ['vendor'],
        setup: ['npm ci', 'composer install']
      })),
      runSetupStep: vi.fn(async (cmd: string) =>
        cmd === 'composer install'
          ? { ok: false as const, kind: 'binary-missing' as const, binary: 'composer' }
          : { ok: true as const }
      )
    })
    const r = await rehydrateItem(wtItem(), deps)
    expect(r.ok).toBe(false)
    expect(r.failure).toMatchObject({
      error: 'WORKTREE_PROVISION_FAILED',
      stage: 'setup',
      step: { index: 2, total: 2 },
      command: 'composer install',
      kind: 'binary-missing',
      binary: 'composer',
      path: '/usr/local/bin:/usr/bin'
    })
    expect(r.failure!.message).toContain('composer: command not found')
    expect(r.failure!.message).toContain('PATH used: /usr/local/bin:/usr/bin')
    expect(r.failure).not.toHaveProperty('rolledBack')
    expect(deps.recordRehydrated).toHaveBeenCalledWith('/repo/.claude/worktrees/feat-x', [], false)
  })

  it('classifies a raw execFile rejection thrown by a step', async () => {
    const deps = fakeRehydrateDeps({
      runSetupStep: vi.fn(async () => {
        throw Object.assign(new Error('boom'), { code: 127, stderr: 'sh: 1: pnpm: not found' })
      })
    })
    const r = await rehydrateItem(wtItem(), deps)
    expect(r.failure).toMatchObject({ kind: 'binary-missing', binary: 'pnpm' })
  })
})

describe('manifestFactsFor — a degraded manifest fails closed', () => {
  const resolved = (source: string) => ({
    ephemeral: ['node_modules', 'vendor', '.venv', 'venv'],
    setup: ['npm ci'],
    source
  })

  it('passes a parsed manifest through', () => {
    expect(manifestFactsFor(resolved('worktree-md'), true)).toEqual({
      ephemeral: ['node_modules', 'vendor', '.venv', 'venv'],
      setup: ['npm ci']
    })
  })

  it('a repo with no manifest at all uses the default list', () => {
    expect(manifestFactsFor(resolved('default'), false).ephemeral).toHaveLength(4)
  })

  it('a WORKTREE.md that failed to parse removes nothing and claims no setup', () => {
    // resolveManifest degrades a malformed file to the built-in default; for a
    // removal that default could WIDEN a list the author had narrowed.
    expect(manifestFactsFor(resolved('default'), true)).toEqual({ ephemeral: [], setup: [] })
  })
})

describe('toSetupOutcome', () => {
  it('trusts an already-classified ManifestCommandFailure', () => {
    expect(
      toSetupOutcome({ classification: { kind: 'timeout' }, rawStderr: '' }, 'npm ci')
    ).toMatchObject({ ok: false, kind: 'timeout' })
  })

  it('classifies an exit code into command-failed with the code', () => {
    expect(toSetupOutcome({ code: 3, stderr: 'nope' }, 'exit 3')).toMatchObject({
      ok: false,
      kind: 'command-failed',
      exitCode: 3,
      stderr: 'nope'
    })
  })
})
