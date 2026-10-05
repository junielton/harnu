import { describe, it, expect, beforeEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/**
 * Spawn-time integration for "Claude Boot": this exercises the exact path that
 * runs when a session starts — `pty.ts` calls `resolveClaudeBootArgs(cwd, base)`,
 * which reads `claude-boot.json` off disk, matches the folder by **normalized
 * path**, merges global ⊕ folder, and builds the argv. The pure builder/merge is
 * covered in `claude-args.test.ts`; this pins the glue (file read + path key +
 * round-trip), the part where a normalize mismatch would silently drop config.
 */

const h = vi.hoisted(() => ({ userDataDir: '' }))
vi.mock('electron', () => ({
  app: { getPath: (): string => h.userDataDir },
  ipcMain: { handle: (): void => {} }
}))

import {
  setGlobalConfig,
  setFolderConfig,
  getGlobalConfig,
  getFolderConfig,
  getResolvedConfig,
  resolveClaudeBootArgs,
  listEndpoints,
  saveEndpoint,
  deleteEndpoint
} from '../src/main/claude-config'

/** Thin helper: most assertions only care about the argv, not the env. */
async function args(
  cwd: string | undefined,
  base: string[],
  override?: Parameters<typeof resolveClaudeBootArgs>[2]
): Promise<string[]> {
  return (await resolveClaudeBootArgs(cwd, base, override)).args
}

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

beforeEach(async () => {
  // Fresh userData per test so claude-boot.json never leaks across cases.
  h.userDataDir = await tmpDir('harnu-boot-')
})

describe('resolveClaudeBootArgs — what a session actually launches with', () => {
  it('no config on disk → just the app-managed base args', async () => {
    expect(await args('/some/dir', ['--resume', 'u1'])).toEqual(['--resume', 'u1'])
  })

  it('applies the saved global config to any folder (and to no folder)', async () => {
    await setGlobalConfig({ model: 'opus', chrome: true })
    expect(await args('/any/dir', [])).toEqual(['--model', 'opus', '--chrome'])
    expect(await args(undefined, [])).toEqual(['--model', 'opus', '--chrome'])
  })

  it('per-folder override wins, unset fields inherit global — matched by real path', async () => {
    const folder = await tmpDir('harnu-proj-')
    await setGlobalConfig({ model: 'opus', chrome: true })
    await setFolderConfig(folder, { model: 'sonnet', addDirs: ['/x'] })

    // In THIS folder: folder model overrides, folder add-dir added, global chrome inherited.
    expect(await args(folder, ['--resume', 'u1'])).toEqual([
      '--resume',
      'u1',
      '--model',
      'sonnet',
      '--add-dir',
      '/x',
      '--chrome'
    ])
    // A different folder still gets only the global.
    expect(await args('/other/dir', [])).toEqual(['--model', 'opus', '--chrome'])
  })

  it('a folder false turns off a global-on flag (--no-chrome)', async () => {
    const folder = await tmpDir('harnu-proj-')
    await setGlobalConfig({ chrome: true })
    await setFolderConfig(folder, { chrome: false })
    expect(await args(folder, [])).toEqual(['--no-chrome'])
  })

  it('a folder override round-trips across equivalent path spellings (deterministic key)', async () => {
    const folder = await tmpDir('harnu-proj-')
    // Save with a trailing slash; load/resolve with other equivalent spellings.
    await setFolderConfig(folder + '/', { model: 'sonnet' })
    expect(await getFolderConfig(folder)).toEqual({ model: 'sonnet' })
    expect(await getFolderConfig(folder + '/.')).toEqual({ model: 'sonnet' })
    expect(await args(folder + '/', [])).toEqual(['--model', 'sonnet'])
  })

  it('a per-session override (New session dialog) beats folder and global', async () => {
    const folder = await tmpDir('harnu-proj-')
    await setGlobalConfig({ model: 'opus', effort: 'low' })
    await setFolderConfig(folder, { effort: 'high', chrome: true })
    // session: model beats global, effort beats folder; folder chrome inherited.
    expect(await args(folder, [], { model: 'sonnet', effort: 'max' })).toEqual([
      '--model',
      'sonnet',
      '--effort',
      'max',
      '--chrome'
    ])
  })

  it('an empty/absent session override changes nothing', async () => {
    const folder = await tmpDir('harnu-proj-')
    await setGlobalConfig({ model: 'opus' })
    expect(await args(folder, [], {})).toEqual(['--model', 'opus'])
    expect(await args(folder, [], undefined)).toEqual(['--model', 'opus'])
  })

  it('strips session-breaking flags from a stored extraArgs before spawn', async () => {
    await setGlobalConfig({ extraArgs: '--resume hijack --betas a,b' })
    expect(await args('/d', ['--resume', 'real'])).toEqual(['--resume', 'real', '--betas', 'a,b'])
  })

  it('never emits the provider as a CLI flag (D4 — env only)', async () => {
    const eps = await saveEndpoint({ name: 'LM Studio', baseUrl: 'http://127.0.0.1:1234' })
    await setGlobalConfig({ provider: eps[0].id })
    expect(await args('/d', [])).toEqual([])
  })
})

describe('provider → ANTHROPIC_* env resolution (local-provider-endpoints)', () => {
  it('no provider → empty env (Anthropic default)', async () => {
    await setGlobalConfig({ model: 'opus' })
    expect((await resolveClaudeBootArgs('/d', [])).env).toEqual({})
  })

  it('resolves a referenced endpoint to base URL + model + auth env', async () => {
    const eps = await saveEndpoint({
      name: 'LM Studio',
      baseUrl: 'http://127.0.0.1:1234',
      model: 'local-model',
      authToken: 'sk-local'
    })
    await setGlobalConfig({ provider: eps[0].id })
    expect((await resolveClaudeBootArgs('/d', [])).env).toEqual({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:1234',
      ANTHROPIC_MODEL: 'local-model',
      ANTHROPIC_AUTH_TOKEN: 'sk-local',
      ANTHROPIC_API_KEY: 'sk-local'
    })
  })

  it('a per-scope free-text model overrides the endpoint default model (D5)', async () => {
    const eps = await saveEndpoint({ baseUrl: 'http://127.0.0.1:1234', model: 'endpoint-default' })
    await setGlobalConfig({ provider: eps[0].id, model: 'my-override' })
    const { env } = await resolveClaudeBootArgs('/d', [])
    expect(env.ANTHROPIC_MODEL).toBe('my-override')
  })

  it('a dangling provider reference degrades to the Anthropic default (no env)', async () => {
    await setGlobalConfig({ provider: 'does-not-exist' })
    expect((await resolveClaudeBootArgs('/d', [])).env).toEqual({})
  })

  it('provider cascades — a per-session override points the launch at a local model', async () => {
    const eps = await saveEndpoint({ baseUrl: 'http://127.0.0.1:1234', model: 'local-model' })
    const folder = await tmpDir('harnu-proj-')
    // Global default = Anthropic; the session opts into the local endpoint.
    const { env } = await resolveClaudeBootArgs(folder, [], { provider: eps[0].id })
    expect(env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:1234')
    expect(env.ANTHROPIC_MODEL).toBe('local-model')
  })
})

describe('endpoint registry CRUD', () => {
  it('starts empty, upserts by id, and round-trips through the file', async () => {
    expect(await listEndpoints()).toEqual([])
    const after = await saveEndpoint({ name: 'LM Studio', baseUrl: 'http://127.0.0.1:1234' })
    expect(after).toHaveLength(1)
    expect(after[0]).toMatchObject({ name: 'LM Studio', baseUrl: 'http://127.0.0.1:1234' })
    expect(after[0].id).toBeTruthy()
    expect(await listEndpoints()).toEqual(after)
  })

  it('updates in place when the id matches, appends otherwise', async () => {
    const [a] = await saveEndpoint({ baseUrl: 'http://a' })
    const list = await saveEndpoint({ id: a.id, baseUrl: 'http://a', name: 'Renamed' })
    expect(list).toHaveLength(1)
    expect(list[0].name).toBe('Renamed')
    const grown = await saveEndpoint({ baseUrl: 'http://b' })
    expect(grown).toHaveLength(2)
  })

  it('rejects a draft without a baseUrl (list unchanged)', async () => {
    await saveEndpoint({ baseUrl: 'http://a' })
    const after = await saveEndpoint({ name: 'no url' })
    expect(after).toHaveLength(1)
  })

  it('deletes by id and is idempotent', async () => {
    const [a] = await saveEndpoint({ baseUrl: 'http://a' })
    expect(await deleteEndpoint(a.id)).toEqual([])
    expect(await deleteEndpoint(a.id)).toEqual([]) // no-op
  })
})

describe('getResolvedConfig — inherited pre-fill for a new session', () => {
  it('returns global ⊕ folder (no session layer), folder winning per key', async () => {
    const folder = await tmpDir('harnu-proj-')
    await setGlobalConfig({ model: 'haiku', effort: 'low' })
    await setFolderConfig(folder, { effort: 'high' })
    // model inherited from global; effort overridden by folder.
    expect(await getResolvedConfig(folder)).toEqual({ model: 'haiku', effort: 'high' })
  })

  it('falls back to global-only for an unconfigured folder', async () => {
    await setGlobalConfig({ model: 'haiku' })
    expect(await getResolvedConfig('/no/such/dir')).toEqual({ model: 'haiku' })
  })
})

describe('claude-boot.json persistence round-trip', () => {
  it('round-trips global config', async () => {
    await setGlobalConfig({ effort: 'high' })
    expect(await getGlobalConfig()).toEqual({ effort: 'high' })
  })

  it('round-trips a folder config and prunes it when cleared', async () => {
    const folder = await tmpDir('harnu-proj-')
    await setFolderConfig(folder, { model: 'haiku' })
    expect(await getFolderConfig(folder)).toEqual({ model: 'haiku' })

    await setFolderConfig(folder, {})
    expect(await getFolderConfig(folder)).toEqual({})
    // Pruned folders don't affect resolution.
    expect(await args(folder, [])).toEqual([])
  })
})
