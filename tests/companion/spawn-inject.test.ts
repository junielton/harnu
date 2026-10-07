import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseClaudeVersion } from '../../src/main/claude-cli-version'
import {
  applyCompanionArgv,
  applyCompanionEnv,
  createCompanionSpawnProvider,
  tickEnv,
  trustFor,
  type CompanionSpawnPlan,
  type SpawnInjectDeps
} from '../../src/main/companion/spawn-inject'

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/nowhere', getPath: () => '/nowhere' }
}))

const CEILING = '2.1.289'
const DIR = '/ud/companion/0.1.0/harnu-companion'

function deps(over: Partial<SpawnInjectDeps> = {}): SpawnInjectDeps {
  return {
    getMode: () => 'shadow',
    cliVersion: () => parseClaudeVersion('2.1.287 (Claude Code)'),
    ceiling: CEILING,
    isSideloadBlocked: () => false,
    ensureStaged: vi.fn(async () => DIR),
    mintSpawnToken: vi.fn(() => 'sp_minted'),
    releaseSpawn: vi.fn(),
    pinStagedDir: () => {},
    ...over
  }
}

const ctx = { cwd: '/work', trust: 'operator' as const }

describe('the spawn provider', () => {
  it('returns a plan for shadow mode on a supported CLI', async () => {
    const d = deps()
    const plan = await createCompanionSpawnProvider(d).provider(ctx)
    expect(plan?.pluginDir).toBe(DIR)
    expect(d.mintSpawnToken).not.toHaveBeenCalled() // only when claude is really about to spawn
  })

  it('returns null for mode off without staging anything', async () => {
    const d = deps({ getMode: () => 'off' })
    expect(await createCompanionSpawnProvider(d).provider(ctx)).toBeNull()
    expect(d.ensureStaged).not.toHaveBeenCalled()
  })

  it('unknown version: no mod, no await', async () => {
    // No version in the cache: the provider answers null at once and never probes or stages.
    const d = deps({ cliVersion: () => null })
    expect(await createCompanionSpawnProvider(d).provider(ctx)).toBeNull()
    expect(d.ensureStaged).not.toHaveBeenCalled()
  })

  it('refuses a CLI below the minimum, injects on ok and above', async () => {
    const below = deps({ cliVersion: () => parseClaudeVersion('2.1.286') })
    expect(await createCompanionSpawnProvider(below).provider(ctx)).toBeNull()
    const above = deps({ cliVersion: () => parseClaudeVersion('2.1.300') })
    expect((await createCompanionSpawnProvider(above).provider(ctx))?.pluginDir).toBe(DIR)
  })

  it('returns null when sideload is blocked or staging failed', async () => {
    expect(
      await createCompanionSpawnProvider(deps({ isSideloadBlocked: () => true })).provider(ctx)
    ).toBeNull()
    expect(
      await createCompanionSpawnProvider(deps({ ensureStaged: async () => null })).provider(ctx)
    ).toBeNull()
  })

  it('never lets a failing dependency reach the spawn: it answers null', async () => {
    const boom = deps({
      ensureStaged: async () => {
        throw new Error('disk on fire')
      }
    })
    expect(await createCompanionSpawnProvider(boom).provider(ctx)).toBeNull()
  })
})

describe('minting and the spawn record', () => {
  it('mints with the owner, trust and cwd, and records the directory per owner until release', async () => {
    const d = deps()
    const inj = createCompanionSpawnProvider(d)
    const plan = (await inj.provider({ cwd: '/w', trust: 'agent' }))!
    const owner = { kind: 'pty' as const, ptyId: 'p1' }
    expect(plan.mintToken(owner)).toBe('sp_minted')
    expect(d.mintSpawnToken).toHaveBeenCalledWith({ owner, trust: 'agent', cwd: '/w' })
    expect(inj.recordedDirs()).toEqual([DIR])
    inj.release(owner, 'pty-exit')
    expect(inj.recordedDirs()).toEqual([])
    expect(d.releaseSpawn).toHaveBeenCalledWith(owner, 'pty-exit')
    // an owner that never recorded (mode off, notice command) releases nothing
    inj.release({ kind: 'pty', ptyId: 'never' }, 'pty-exit')
    expect(d.releaseSpawn).toHaveBeenCalledTimes(1)
  })

  it('records the directory even when the host minted nothing (the process still holds it)', async () => {
    const inj = createCompanionSpawnProvider(deps({ mintSpawnToken: () => null }))
    const plan = (await inj.provider(ctx))!
    expect(plan.mintToken({ kind: 'pty', ptyId: 'p2' })).toBeNull()
    expect(inj.recordedDirs()).toEqual([DIR])
  })

  it('registers the records as a stage pin', async () => {
    const pin = vi.fn()
    const inj = createCompanionSpawnProvider(deps({ pinStagedDir: pin }))
    expect(pin).toHaveBeenCalledTimes(1)
    const plan = (await inj.provider(ctx))!
    plan.mintToken({ kind: 'pty', ptyId: 'p3' })
    expect(pin.mock.calls[0][0]()).toEqual([DIR])
  })
})

describe('applyCompanionArgv', () => {
  const plan: CompanionSpawnPlan = { pluginDir: DIR, mintToken: () => null }

  it('mode off is byte-identical (no plan: the same array content)', () => {
    const argv = ['--resume', 'u', '--plugin-dir', '/skills', '--', 'prompt']
    expect(applyCompanionArgv(argv, null)).toEqual(argv)
    expect(applyCompanionArgv(argv, null)).not.toBe(argv)
  })

  it('puts the companion first, before the user dir and the separator', () => {
    expect(applyCompanionArgv(['--plugin-dir', '/u', '--', 'p'], plan)).toEqual([
      '--plugin-dir',
      DIR,
      '--plugin-dir',
      '/u',
      '--',
      'p'
    ])
  })
})

describe('applyCompanionEnv', () => {
  const owner = { kind: 'pty' as const, ptyId: 'p9' }

  it('mode off is byte-identical to today', () => {
    const before = { PATH: '/bin', HOME: '/h', CLAUDE_CODE_NO_FLICKER: '1' }
    const env = { ...before }
    const r = applyCompanionEnv(env, { plan: null, owner, dirMissing: false })
    expect(env).toEqual(before)
    expect(Object.keys(env)).toEqual(Object.keys(before))
    expect(r.minted).toBe(false)
  })

  it('an inherited token is never forwarded', () => {
    // a Harnu launched from inside a Harnu session inherits a spent token
    const stale = { PATH: '/bin', HARNU_SPAWN_TOKEN: 'sp_spent' }
    const withPlan = { ...stale }
    applyCompanionEnv(withPlan, {
      plan: { pluginDir: DIR, mintToken: () => 'sp_fresh' },
      owner,
      dirMissing: false
    })
    expect(withPlan.HARNU_SPAWN_TOKEN).toBe('sp_fresh')

    const nothingMinted = { ...stale }
    applyCompanionEnv(nothingMinted, {
      plan: { pluginDir: DIR, mintToken: () => null },
      owner,
      dirMissing: false
    })
    expect('HARNU_SPAWN_TOKEN' in nothingMinted).toBe(false)

    const noPlan = { ...stale }
    applyCompanionEnv(noPlan, { plan: null, owner, dirMissing: false })
    expect('HARNU_SPAWN_TOKEN' in noPlan).toBe(false)
  })

  it('no mint for the missing-directory notice', () => {
    const mint = vi.fn(() => 'sp_x')
    const env: Record<string, string> = { PATH: '/bin' }
    const r = applyCompanionEnv(env, {
      plan: { pluginDir: DIR, mintToken: mint },
      owner,
      dirMissing: true
    })
    expect(mint).not.toHaveBeenCalled()
    expect(r.minted).toBe(false)
    expect('HARNU_SPAWN_TOKEN' in env).toBe(false)
  })

  it('reports a mint so the exit path knows to release', () => {
    const env: Record<string, string> = {}
    expect(
      applyCompanionEnv(env, {
        plan: { pluginDir: DIR, mintToken: () => 'sp_y' },
        owner,
        dirMissing: false
      }).minted
    ).toBe(true)
  })
})

describe('trustFor', () => {
  it('maps the spawn shape to a trust class', () => {
    expect(trustFor({})).toBe('operator')
    expect(trustFor({ readOnly: true })).toBe('read-only')
    expect(trustFor({ agentControlled: true })).toBe('agent')
    expect(trustFor({ spawnedBy: 'agent' })).toBe('agent')
    expect(trustFor({ spawnedBy: 'operator' })).toBe('operator')
    // read-only wins: a deliberately weaker session is never upgraded by who started it
    expect(trustFor({ readOnly: true, agentControlled: true })).toBe('read-only')
  })
})

describe('the default wiring never spawns a process', () => {
  beforeEach(() => vi.resetModules())

  it('answers null from a cold version cache without touching child_process', async () => {
    const execFile = vi.fn()
    const spawn = vi.fn()
    vi.doMock('node:child_process', () => ({ execFile, spawn }))
    vi.doMock('child_process', () => ({ execFile, spawn }))
    vi.doMock('electron', () => ({
      app: { isPackaged: false, getAppPath: () => '/nowhere', getPath: () => '/nowhere' }
    }))
    vi.doMock('../../src/main/companion/mode', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../../src/main/companion/mode')>()),
      getCompanionMode: () => 'shadow' as const
    }))
    const mod = await import('../../src/main/companion/spawn-inject')
    expect(await mod.companionSpawnProvider({ cwd: '/w', trust: 'operator' })).toBeNull()
    expect(execFile).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })
})

describe('tickEnv', () => {
  it('leaves the env alone when there is nothing to add or strip', () => {
    expect(tickEnv({ PATH: '/bin' }, null)).toBeUndefined()
  })

  it('adds the minted token and never forwards an inherited one', () => {
    expect(tickEnv({ PATH: '/bin' }, 'sp_t')).toEqual({ PATH: '/bin', HARNU_SPAWN_TOKEN: 'sp_t' })
    expect(tickEnv({ PATH: '/bin', HARNU_SPAWN_TOKEN: 'sp_spent' }, 'sp_t')).toEqual({
      PATH: '/bin',
      HARNU_SPAWN_TOKEN: 'sp_t'
    })
    const stripped = tickEnv({ PATH: '/bin', HARNU_SPAWN_TOKEN: 'sp_spent' }, null)
    expect(stripped).toEqual({ PATH: '/bin' })
  })
})
