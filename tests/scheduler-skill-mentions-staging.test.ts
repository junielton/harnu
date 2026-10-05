/**
 * T305 §AC-2, §AC-7 — what a scheduler tick can actually reach.
 *
 * BUG-116, measured live on 2026-09-08: a tick sees 13 skills where a session
 * sees 88, because `--setting-sources ''` (correctly) stops Claude Code loading
 * the user and project setting sources, and those are where personal and
 * project skills are discovered. `--plugin-dir` is the ONLY channel left, so the
 * fix is to copy the named skills into it. These tests pin both halves: what the
 * picker offers, and what the tick ends up carrying.
 *
 * Electron's `app` and `node:os`'s `homedir` are mocked so the test owns the
 * resource dir it stages FROM and every directory it writes TO; it never reads
 * the tester's real `~/.claude`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { parseSkillMentions, tickArgv, type Worker } from '../src/main/scheduler-core'

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

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

async function exists(p: string): Promise<boolean> {
  return fs
    .access(p)
    .then(() => true)
    .catch(() => false)
}

/** A skill directory in the flat `<root>/<name>/SKILL.md` layout the CLI reads. */
async function writeSkill(root: string, name: string, description: string): Promise<void> {
  await fs.mkdir(path.join(root, name), { recursive: true })
  await fs.writeFile(
    path.join(root, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nbody of ${name}\n`,
    'utf8'
  )
}

async function seedCatalog(root: string): Promise<void> {
  const base = path.join(root, 'resources', 'skills')
  await fs.mkdir(path.join(base, '.claude-plugin'), { recursive: true })
  await fs.writeFile(
    path.join(base, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'harnu', version: '1.0.0', description: 'test' }),
    'utf8'
  )
  await fs.writeFile(path.join(base, 'CATALOG.md'), '<!-- harnu-skills v1 -->\n', 'utf8')
  for (const name of ['status', 'mission']) {
    await writeSkill(path.join(base, 'skills'), name, `bundled ${name}`)
  }
}

async function setGlobal(enabled: Record<string, boolean>): Promise<void> {
  await fs.writeFile(
    path.join(h.userDataDir, 'bundled-skills.json'),
    JSON.stringify({ version: 1, enabled, userLevelInstall: {} }),
    'utf8'
  )
}

async function load(): Promise<typeof import('../src/main/bundled-skills')> {
  vi.resetModules()
  return import('../src/main/bundled-skills')
}

let projectFolder = ''

beforeEach(async () => {
  h.userDataDir = await tmpDir('harnu-t305-ud-')
  h.appPath = await tmpDir('harnu-t305-app-')
  h.home = await tmpDir('harnu-t305-home-')
  projectFolder = await tmpDir('harnu-t305-repo-')
  await seedCatalog(h.appPath)
  await writeSkill(path.join(h.home, '.claude', 'skills'), 'land-prs', 'personal land-prs')
  await writeSkill(path.join(projectFolder, '.claude', 'skills'), 'deploy', 'project deploy')
})

describe('listAvailableSkills — AC-2', () => {
  it('unions bundled, personal and project skills, each tagged with its origin', async () => {
    const m = await load()
    const list = await m.listAvailableSkills(projectFolder)
    expect(list).toEqual(
      expect.arrayContaining([
        { name: 'status', description: 'bundled status', origin: 'bundled' },
        { name: 'mission', description: 'bundled mission', origin: 'bundled' },
        { name: 'land-prs', description: 'personal land-prs', origin: 'personal' },
        { name: 'deploy', description: 'project deploy', origin: 'project' }
      ])
    )
  })

  it('AC-3: the project half is folder-dependent — another folder, another list', async () => {
    const other = await tmpDir('harnu-t305-other-')
    const m = await load()
    const here = await m.listAvailableSkills(projectFolder)
    const there = await m.listAvailableSkills(other)
    expect(here.some((s) => s.name === 'deploy')).toBe(true)
    expect(there.some((s) => s.name === 'deploy')).toBe(false)
    // The folder-independent halves are unchanged by the move.
    expect(there.some((s) => s.name === 'land-prs' && s.origin === 'personal')).toBe(true)
    expect(there.some((s) => s.name === 'status' && s.origin === 'bundled')).toBe(true)
  })

  it('keeps a shadowed entry so a harnu: mention can still name the bundled skill', async () => {
    await writeSkill(path.join(h.home, '.claude', 'skills'), 'mission', 'personal mission')
    const m = await load()
    const list = await m.listAvailableSkills(projectFolder)
    const missions = list.filter((s) => s.name === 'mission')
    expect(missions.map((s) => s.origin)).toEqual(['personal', 'bundled'])
  })

  it('a directory with no SKILL.md is not a skill', async () => {
    await fs.mkdir(path.join(h.home, '.claude', 'skills', 'not-a-skill'), { recursive: true })
    const m = await load()
    const list = await m.listAvailableSkills(projectFolder)
    expect(list.some((s) => s.name === 'not-a-skill')).toBe(false)
  })

  it('an unreadable ~/.claude/skills costs the personal half, never the call', async () => {
    await fs.rm(path.join(h.home, '.claude'), { recursive: true, force: true })
    const m = await load()
    const list = await m.listAvailableSkills(projectFolder)
    expect(list.some((s) => s.origin === 'personal')).toBe(false)
    expect(list.some((s) => s.origin === 'bundled')).toBe(true)
  })
})

describe('stageSkillsForFolder with mentions — AC-7', () => {
  it('stages exactly the mentioned skills plus the enabled bundled ones', async () => {
    await setGlobal({ status: true })
    const m = await load()
    const staged = await m.stageSkillsForFolder(projectFolder, ['land-prs', 'deploy'])
    expect(staged).not.toBeNull()
    expect([...staged!.enabled].sort()).toEqual(['deploy', 'land-prs', 'status'])
    expect(await exists(path.join(staged!.dir, 'skills', 'land-prs', 'SKILL.md'))).toBe(true)
    expect(await exists(path.join(staged!.dir, 'skills', 'deploy', 'SKILL.md'))).toBe(true)
    expect(await exists(path.join(staged!.dir, 'skills', 'status', 'SKILL.md'))).toBe(true)
    // Never the un-enabled, un-mentioned one.
    expect(await exists(path.join(staged!.dir, 'skills', 'mission'))).toBe(false)
    expect(await exists(path.join(staged!.dir, '.claude-plugin', 'plugin.json'))).toBe(true)
  })

  it('stages a personal skill even when NOTHING bundled is enabled', async () => {
    const m = await load()
    const staged = await m.stageSkillsForFolder(projectFolder, ['land-prs'])
    expect(staged!.enabled).toEqual(['land-prs'])
    expect(staged!.mentioned).toEqual(['land-prs'])
  })

  it('a mention naming a globally-off bundled skill is an explicit request, so it stages', async () => {
    const m = await load()
    const staged = await m.stageSkillsForFolder(projectFolder, ['mission'])
    expect(staged!.enabled).toEqual(['mission'])
  })

  it.each(['harnu:mission', 'capy:mission'])(
    'a %s prefix pins the mention to the bundled skill a personal one shadows',
    async (mention) => {
      await writeSkill(path.join(h.home, '.claude', 'skills'), 'mission', 'personal mission')
      const m = await load()
      const bundled = await m.stageSkillsForFolder(projectFolder, [mention])
      expect(
        await fs.readFile(path.join(bundled!.dir, 'skills', 'mission', 'SKILL.md'), 'utf8')
      ).toContain('bundled mission')
      const personal = await m.stageSkillsForFolder(projectFolder, ['mission'])
      expect(
        await fs.readFile(path.join(personal!.dir, 'skills', 'mission', 'SKILL.md'), 'utf8')
      ).toContain('personal mission')
    }
  )

  it('stages under a harnu/ plugin directory, the CLI namespace', async () => {
    const m = await load()
    const staged = await m.stageSkillsForFolder(projectFolder, ['capy:mission'])
    expect(path.basename(staged!.dir)).toBe('harnu')
  })

  it('a mention nothing answers to is skipped, never fatal', async () => {
    await setGlobal({ status: true })
    const m = await load()
    const staged = await m.stageSkillsForFolder(projectFolder, ['nope', 'dtk:review', 'land-prs'])
    expect(staged!.mentioned).toEqual(['land-prs'])
    expect([...staged!.enabled].sort()).toEqual(['land-prs', 'status'])
  })

  it('a project skill beats a personal one of the same name', async () => {
    await writeSkill(path.join(h.home, '.claude', 'skills'), 'deploy', 'personal deploy')
    const m = await load()
    const staged = await m.stageSkillsForFolder(projectFolder, ['deploy'])
    expect(
      await fs.readFile(path.join(staged!.dir, 'skills', 'deploy', 'SKILL.md'), 'utf8')
    ).toContain('project deploy')
  })

  it('a worker’s mentions never leak into the folder’s plain staged tree', async () => {
    await setGlobal({ status: true })
    const m = await load()
    const worker = await m.stageSkillsForFolder(projectFolder, ['land-prs'])
    const session = await m.stageSkillsForFolder(projectFolder)
    expect(session!.dir).not.toBe(worker!.dir)
    expect(session!.enabled).toEqual(['status'])
    expect(await exists(path.join(session!.dir, 'skills', 'land-prs'))).toBe(false)
  })

  it('does not re-stage when neither the set nor the mentioned skills changed', async () => {
    const m = await load()
    const first = await m.stageSkillsForFolder(projectFolder, ['land-prs'])
    const sentinel = path.join(first!.dir, 'skills', 'land-prs', 'SENTINEL')
    await fs.writeFile(sentinel, 'x', 'utf8')
    await m.stageSkillsForFolder(projectFolder, ['land-prs'])
    expect(await exists(sentinel)).toBe(true)
  })

  it('re-stages when a mentioned skill is edited on disk', async () => {
    const m = await load()
    const first = await m.stageSkillsForFolder(projectFolder, ['land-prs'])
    const sentinel = path.join(first!.dir, 'skills', 'land-prs', 'SENTINEL')
    await fs.writeFile(sentinel, 'x', 'utf8')
    const src = path.join(h.home, '.claude', 'skills', 'land-prs', 'SKILL.md')
    await fs.writeFile(src, '---\nname: land-prs\ndescription: edited\n---\n\nv2\n', 'utf8')
    await fs.utimes(src, new Date(), new Date(Date.now() + 60_000))
    await m.stageSkillsForFolder(projectFolder, ['land-prs'])
    expect(await exists(sentinel)).toBe(false)
  })

  it('an interactive spawn is byte-identical to before: no mentions, same directory', async () => {
    await setGlobal({ status: true })
    const m = await load()
    const staged = await m.stageSkillsForFolder(projectFolder)
    expect(staged!.dir).toBe(m.stagedPluginDir(projectFolder))
    expect(staged!.mentioned).toEqual([])
  })
})

describe('a tick carrying mentions still runs lean — AC-7', () => {
  function worker(prompt: string): Worker {
    return {
      id: 'w1',
      name: 'w',
      enabled: true,
      prompt,
      folder: '/repo',
      everyMinutes: 5,
      runOnBoot: false,
      model: 'haiku',
      effort: 'low',
      mode: 'observe',
      timeoutSeconds: 300,
      carryLastResult: false,
      failureStreak: 0
    }
  }

  it("still passes --setting-sources '' — the operator's hooks must not fire in a tick", () => {
    const argv = tickArgv(worker('run /land-prs'), { pluginDir: '/staged/harnu' })
    const i = argv.indexOf('--setting-sources')
    expect(i).toBeGreaterThan(-1)
    expect(argv[i + 1]).toBe('')
    expect(argv[argv.indexOf('--plugin-dir') + 1]).toBe('/staged/harnu')
  })

  it('the mention stays literally in the prompt the model reads', () => {
    const argv = tickArgv(worker('run /land-prs'), {})
    expect(argv[argv.length - 1]).toBe('run /land-prs')
    expect(parseSkillMentions(argv[argv.length - 1])).toEqual(['land-prs'])
  })
})
