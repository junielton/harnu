/**
 * T2: staging the doc-reader feature, against a real filesystem. The feature is OFF by default,
 * stages an agent plus an http hook when on, and is never staged into an `observe` tick (or a
 * steward, which stages in observe mode): they have no `Agent` tool to follow a refused read.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const h = vi.hoisted(() => ({ userDataDir: '', appPath: '', home: '' }))

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: (): string => h.userDataDir,
    getAppPath: (): string => h.appPath
  },
  ipcMain: { handle: (): void => {} }
}))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof os>()
  return { ...actual, homedir: (): string => h.home, default: { ...actual, homedir: () => h.home } }
})

const exists = (p: string): Promise<boolean> =>
  fs
    .access(p)
    .then(() => true)
    .catch(() => false)

async function seed(root: string): Promise<void> {
  const base = path.join(root, 'resources', 'skills')
  await fs.mkdir(path.join(base, '.claude-plugin'), { recursive: true })
  await fs.writeFile(path.join(base, '.claude-plugin', 'plugin.json'), '{"name":"harnu"}', 'utf8')
  await fs.writeFile(path.join(base, 'CATALOG.md'), '<!-- harnu-skills v1 -->\n', 'utf8')
  await fs.mkdir(path.join(base, 'skills', 'a'), { recursive: true })
  await fs.writeFile(
    path.join(base, 'skills', 'a', 'SKILL.md'),
    '---\nname: a\ndescription: skill a\n---\n',
    'utf8'
  )
  // The real feature entry, so the test stages what ships.
  await fs.cp(
    path.join(__dirname, '..', 'resources', 'skills', 'features'),
    path.join(base, 'features'),
    { recursive: true }
  )
}

async function setGlobal(enabled: Record<string, boolean>): Promise<void> {
  await fs.writeFile(
    path.join(h.userDataDir, 'bundled-skills.json'),
    JSON.stringify({ version: 1, enabled, userLevelInstall: {} }),
    'utf8'
  )
}

async function load(
  endpoint: { port: number; token: string } | null = { port: 4321, token: 'tok' }
): Promise<typeof import('../src/main/bundled-skills')> {
  vi.resetModules()
  const m = await import('../src/main/bundled-skills')
  m.setDocReaderEndpointProvider(() => endpoint)
  return m
}

const hookFile = (dir: string): string => path.join(dir, 'hooks', 'hooks.json')
const agentFile = (dir: string): string => path.join(dir, 'agents', 'doc-reader.md')

beforeEach(async () => {
  h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-dr-ud-'))
  h.appPath = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-dr-app-'))
  h.home = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-dr-home-'))
  await seed(h.appPath)
})

describe('doc-reader in the catalog', () => {
  it('is listed as a feature, after the skills', async () => {
    const m = await load()
    const catalog = await m.readBundledCatalog()
    expect(catalog.map((c) => [c.name, c.kind])).toEqual([
      ['a', undefined],
      ['doc-reader', 'feature']
    ])
  })

  it('cannot be installed outside Harnu, nor picked as a worker /mention', async () => {
    const m = await load()
    expect(await m.setUserLevelInstall('doc-reader', true)).toEqual({
      ok: false,
      reason: 'unknown-skill'
    })
    expect((await m.listAvailableSkills('')).map((s) => s.name)).not.toContain('doc-reader')
  })
})

describe('staging the doc-reader', () => {
  it('stages nothing while it is off (the default)', async () => {
    const m = await load()
    expect(await m.stageSkillsForFolder('/repo/one')).toBeNull()
    await setGlobal({ a: true })
    const staged = await m.stageSkillsForFolder('/repo/one')
    expect(staged!.enabled).toEqual(['a'])
    expect(await exists(hookFile(staged!.dir))).toBe(false)
    expect(await exists(agentFile(staged!.dir))).toBe(false)
  })

  it('stages the agent and the http hook when on, with no skill copy of its own', async () => {
    await setGlobal({ 'doc-reader': true })
    const m = await load()
    const staged = await m.stageSkillsForFolder('/repo/one')
    expect(staged!.enabled).toEqual(['doc-reader'])
    expect(await fs.readFile(agentFile(staged!.dir), 'utf8')).toContain('model: haiku')
    const hooks = JSON.parse(await fs.readFile(hookFile(staged!.dir), 'utf8'))
    expect(hooks.hooks.PreToolUse[0].matcher).toBe('Read|Bash')
    expect(hooks.hooks.PreToolUse[0].hooks[0]).toMatchObject({
      type: 'http',
      url: 'http://127.0.0.1:4321/docread/tok/350'
    })
    expect(await exists(path.join(staged!.dir, 'skills', 'doc-reader'))).toBe(false)
    expect(await exists(path.join(staged!.dir, '.claude-plugin', 'plugin.json'))).toBe(true)
  })

  it('is never staged into an observe tick', async () => {
    await setGlobal({ 'doc-reader': true, a: true })
    const m = await load()
    const tick = await m.stageSkillsForTick('/repo/one', ['a'], 'observe')
    expect(tick.staged!.enabled).not.toContain('doc-reader')
    expect(await exists(hookFile(tick.staged!.dir))).toBe(false)
    expect(await exists(agentFile(tick.staged!.dir))).toBe(false)
    // With nothing else enabled an observe tick stages nothing at all.
    await setGlobal({ 'doc-reader': true })
    expect(await m.stageSkillsForFolder('/repo/one', [], { observe: true })).toBeNull()
  })

  it('stages nothing for it while the Hook Bridge is down', async () => {
    await setGlobal({ 'doc-reader': true })
    const m = await load(null)
    expect(await m.stageSkillsForFolder('/repo/one')).toBeNull()
  })

  it('re-stages when the bridge moves (a Harnu restart) so the hook never points at a dead port', async () => {
    await setGlobal({ 'doc-reader': true })
    const first = await (await load({ port: 1111, token: 'a' })).stageSkillsForFolder('/repo/one')
    const second = await (await load({ port: 2222, token: 'b' })).stageSkillsForFolder('/repo/one')
    expect(second!.dir).toBe(first!.dir)
    expect(await fs.readFile(hookFile(second!.dir), 'utf8')).toContain('127.0.0.1:2222/docread/b/')
  })

  it("bakes the folder's own threshold into the hook URL", async () => {
    await setGlobal({ 'doc-reader': true })
    const m = await load()
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-dr-folder-'))
    const { setUserProjectDocReaderMinLines } = await import('../src/main/user-projects')
    await setUserProjectDocReaderMinLines(folder, 600)
    const staged = await m.stageSkillsForFolder(folder)
    expect(await fs.readFile(hookFile(staged!.dir), 'utf8')).toContain('/docread/tok/600')
    await setUserProjectDocReaderMinLines(folder, null)
    const back = await m.stageSkillsForFolder(folder)
    expect(await fs.readFile(hookFile(back!.dir), 'utf8')).toContain('/docread/tok/350')
  })
})
