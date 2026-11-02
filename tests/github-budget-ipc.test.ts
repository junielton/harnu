/**
 * T611 U1 AC-8 — prefs persisted in `userData/github-budget-prefs.json` (normalized on the way in and
 * out), the `github-budget:snapshot` / `:prefs` / `:setPrefs` handlers, the pushed
 * `github-budget:changed` event, and the typed preload surface.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs, readFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const h = vi.hoisted(() => ({
  userData: '',
  handlers: new Map<string, (...a: unknown[]) => unknown>(),
  sent: [] as Array<{ channel: string; payload: unknown }>,
  probeBody: '',
  loginOut: 'octocat' as string | Error
}))

vi.mock('electron', () => ({
  app: { getPath: (): string => h.userData },
  ipcMain: {
    handle: (ch: string, fn: (...a: unknown[]) => unknown): void => {
      h.handlers.set(ch, fn)
    }
  },
  BrowserWindow: {
    getAllWindows: (): unknown[] => [
      {
        isDestroyed: (): boolean => false,
        webContents: {
          send: (channel: string, payload: unknown) => h.sent.push({ channel, payload })
        }
      }
    ]
  }
}))
vi.mock('../src/main/gh-runner', () => ({
  isGhThrottled: (): boolean => false,
  runGh: async (args: string[]): Promise<{ stdout: string; stderr: string }> => {
    if (args[0] === 'api' && args[1] === 'user') {
      if (h.loginOut instanceof Error) throw h.loginOut
      return { stdout: `${h.loginOut}\n`, stderr: '' }
    }
    throw new Error(`unexpected gh call ${args.join(' ')}`)
  },
  runGhBudgetProbe: async (): Promise<{ stdout: string; stderr: string }> => {
    if (!h.probeBody) throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' })
    return { stdout: h.probeBody, stderr: '' }
  }
}))

const body = (graphqlRemaining: number): string =>
  JSON.stringify({
    resources: {
      core: {
        limit: 5000,
        remaining: 4900,
        used: 100,
        reset: Math.floor(Date.now() / 1000) + 1800
      },
      graphql: {
        limit: 5000,
        remaining: graphqlRemaining,
        used: 5000 - graphqlRemaining,
        reset: Math.floor(Date.now() / 1000) + 1800
      }
    }
  })

const call = async <T>(ch: string, ...args: unknown[]): Promise<T> =>
  (await h.handlers.get(ch)!({}, ...args)) as T

beforeEach(async () => {
  h.userData = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-ghbudget-'))
  h.handlers.clear()
  h.sent.length = 0
  h.probeBody = body(4000)
  h.loginOut = 'octocat'
  vi.resetModules()
})

afterEach(async () => {
  const m = await import('../src/main/github-budget')
  m.stopGithubBudget()
})

async function boot(): Promise<void> {
  const m = await import('../src/main/github-budget')
  m.registerGithubBudget()
  // The first poll lands asynchronously after the prefs load.
  await vi.waitFor(async () => {
    const snap = await call<{ status: string; sampledAt: number | null }>('github-budget:snapshot')
    expect(snap.sampledAt).not.toBeNull()
  })
}

describe('github-budget IPC (AC-8)', () => {
  it('registers snapshot, prefs and setPrefs', async () => {
    await boot()
    expect([...h.handlers.keys()].sort()).toEqual([
      'github-budget:prefs',
      'github-budget:setPrefs',
      'github-budget:snapshot'
    ])
  })

  it('snapshot returns both buckets, the tighter one and the throttle state', async () => {
    await boot()
    const snap = await call<{
      status: string
      tighter: string
      rest: { bucket: { remaining: number } }
      graphql: { bucket: { remaining: number } }
      throttle: { state: string; threshold: number }
    }>('github-budget:snapshot')
    expect(snap).toMatchObject({
      status: 'ok',
      tighter: 'graphql',
      rest: { bucket: { remaining: 4900 } },
      graphql: { bucket: { remaining: 4000 } },
      throttle: { state: 'normal', threshold: 15 }
    })
  })

  it('carries the gh login on the snapshot (AC-8b)', async () => {
    await boot()
    await vi.waitFor(async () => {
      expect((await call<{ login: string | null }>('github-budget:snapshot')).login).toBe('octocat')
    })
  })

  it('has a null login when the lookup fails, and still serves the budget', async () => {
    h.loginOut = new Error('HTTP 403')
    await boot()
    const snap = await call<{ login: string | null; status: string }>('github-budget:snapshot')
    expect(snap).toMatchObject({ login: null, status: 'ok' })
  })

  it('reports `unavailable` when gh is missing', async () => {
    h.probeBody = ''
    const m = await import('../src/main/github-budget')
    m.registerGithubBudget()
    await vi.waitFor(async () => {
      const snap = await call<{ status: string; login: string | null }>('github-budget:snapshot')
      expect(snap.status).toBe('unavailable')
      expect(snap.login).toBeNull() // null while gh is missing or signed out (AC-8b)
    })
  })

  it('prefs read as the defaults when there is no file, and setPrefs normalizes then persists', async () => {
    await boot()
    expect(await call('github-budget:prefs')).toEqual({
      version: 1,
      threshold: 15,
      checkDelivered: false,
      pausePrStackWhenLow: true,
      notify: true
    })
    const saved = await call<{ threshold: number; checkDelivered: boolean }>(
      'github-budget:setPrefs',
      { threshold: 24, checkDelivered: true, junk: 1 }
    )
    expect(saved).toMatchObject({ threshold: 25, checkDelivered: true })
    const onDisk = JSON.parse(
      readFileSync(path.join(h.userData, 'github-budget-prefs.json'), 'utf8')
    )
    expect(onDisk).toEqual(saved)
    expect(onDisk).not.toHaveProperty('junk')
    expect(await call('github-budget:prefs')).toEqual(saved)
  })

  it('a corrupt prefs file reads as the defaults', async () => {
    await fs.writeFile(path.join(h.userData, 'github-budget-prefs.json'), '{not json', 'utf8')
    await boot()
    expect(await call('github-budget:prefs')).toMatchObject({
      threshold: 15,
      checkDelivered: false
    })
  })

  it('applies the saved prefs to the live tracker and pushes a change event', async () => {
    h.probeBody = body(900) // 18 % left
    await boot()
    expect(
      (await call<{ throttle: { state: string } }>('github-budget:snapshot')).throttle.state
    ).toBe('normal')
    h.sent.length = 0
    await call('github-budget:setPrefs', { threshold: 25 })
    const snap = await call<{ throttle: { state: string; threshold: number } }>(
      'github-budget:snapshot'
    )
    expect(snap.throttle).toMatchObject({ state: 'low', threshold: 25 })
    const pushed = h.sent.filter((s) => s.channel === 'github-budget:changed')
    expect(pushed.length).toBeGreaterThan(0)
    expect((pushed.at(-1)!.payload as { throttle: { state: string } }).throttle.state).toBe('low')
    // The tracker singleton now reads the saved prefs (checkDelivered feeds the mission derive).
    const t = await import('../src/main/github-budget-tracker')
    expect(t.checkDeliveredMissions()).toBe(false)
    await call('github-budget:setPrefs', { checkDelivered: true })
    expect(t.checkDeliveredMissions()).toBe(true)
  })
})

describe('typed preload surface (AC-8)', () => {
  const src = readFileSync(path.resolve(__dirname, '../src/preload/index.ts'), 'utf8')
  it('exposes snapshot, prefs, setPrefs and the pushed event, typed from the core', () => {
    expect(src).toContain("ipcRenderer.invoke('github-budget:snapshot')")
    expect(src).toContain("ipcRenderer.invoke('github-budget:prefs')")
    expect(src).toContain("ipcRenderer.invoke('github-budget:setPrefs', prefs)")
    expect(src).toContain("ipcRenderer.on('github-budget:changed', handler)")
    expect(src).toMatch(/githubBudgetSnapshot: \(\): Promise<GithubBudgetSnapshot>/)
    expect(src).toMatch(
      /githubBudgetSetPrefs: \(prefs: GithubBudgetPrefs\): Promise<GithubBudgetPrefs>/
    )
    expect(src).toMatch(/onGithubBudgetChanged: \(cb: \(snapshot: GithubBudgetSnapshot\) => void\)/)
  })
})
