/**
 * T217 §9.2 — the staging shell, against a real filesystem.
 *
 * "Per-skill on/off is expressed by what gets staged" is the load-bearing claim of
 * the whole feature: an OFF skill is never copied, so the session cannot see it
 * even in principle. That claim is only true if this shell actually copies the
 * enabled subset and only the enabled subset — which is what this file pins.
 *
 * Electron's `app` and `node:os`'s `homedir` are mocked so the test owns both the
 * resource directory it stages FROM and every directory it writes TO; it never
 * touches the tester's real `~/.claude`.
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

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

async function exists(p: string): Promise<boolean> {
  return fs
    .access(p)
    .then(() => true)
    .catch(() => false)
}

/** A fake `resources/skills/` tree with four good entries and one malformed one. */
async function seedCatalog(root: string): Promise<void> {
  const base = path.join(root, 'resources', 'skills')
  await fs.mkdir(path.join(base, '.claude-plugin'), { recursive: true })
  await fs.writeFile(
    path.join(base, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'harnu', version: '1.0.0', description: 'test' }),
    'utf8'
  )
  await fs.writeFile(path.join(base, 'CATALOG.md'), '<!-- harnu-skills v1 -->\n', 'utf8')
  for (const name of ['a', 'b', 'c', 'd']) {
    await fs.mkdir(path.join(base, 'skills', name), { recursive: true })
    await fs.writeFile(
      path.join(base, 'skills', name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: skill ${name}\n---\n\nbody of ${name}\n`,
      'utf8'
    )
  }
  // A fifth entry with no frontmatter at all: it must drop itself, not the catalog.
  await fs.mkdir(path.join(base, 'skills', 'broken'), { recursive: true })
  await fs.writeFile(path.join(base, 'skills', 'broken', 'SKILL.md'), '# no frontmatter\n', 'utf8')
}

/** Fresh module registry per test — the catalog is cached for the app's lifetime. */
async function load(): Promise<typeof import('../src/main/bundled-skills')> {
  vi.resetModules()
  return import('../src/main/bundled-skills')
}

beforeEach(async () => {
  h.userDataDir = await tmpDir('harnu-skills-ud-')
  h.appPath = await tmpDir('harnu-skills-app-')
  h.home = await tmpDir('harnu-skills-home-')
  await seedCatalog(h.appPath)
})

/** Turn skills on globally by writing the prefs file the shell reads. */
async function setGlobal(enabled: Record<string, boolean>): Promise<void> {
  await fs.writeFile(
    path.join(h.userDataDir, 'bundled-skills.json'),
    JSON.stringify({ version: 1, enabled, userLevelInstall: {} }),
    'utf8'
  )
}

describe('readBundledCatalog', () => {
  it('reads every parseable entry and drops only the malformed one', async () => {
    const m = await load()
    const catalog = await m.readBundledCatalog()
    expect(catalog.map((s) => s.name)).toEqual(['a', 'b', 'c', 'd'])
    expect(catalog[0].description).toBe('skill a')
  })

  it('degrades to an empty catalog when resources/skills is unreadable', async () => {
    await fs.rm(path.join(h.appPath, 'resources'), { recursive: true, force: true })
    const m = await load()
    expect(await m.readBundledCatalog()).toEqual([])
  })
})

describe('stageSkillsForFolder', () => {
  it('stages exactly the enabled subset and nothing else', async () => {
    await setGlobal({ a: true, c: true })
    const m = await load()
    const staged = await m.stageSkillsForFolder('/repo/one')
    expect(staged).not.toBeNull()
    expect(staged!.enabled).toEqual(['a', 'c'])
    expect(await exists(path.join(staged!.dir, 'skills', 'a', 'SKILL.md'))).toBe(true)
    expect(await exists(path.join(staged!.dir, 'skills', 'c', 'SKILL.md'))).toBe(true)
    expect(await exists(path.join(staged!.dir, 'skills', 'b'))).toBe(false)
    expect(await exists(path.join(staged!.dir, 'skills', 'd'))).toBe(false)
    // The plugin manifest travels with it, or the CLI would reject the directory.
    expect(await exists(path.join(staged!.dir, '.claude-plugin', 'plugin.json'))).toBe(true)
  })

  it('stages NOTHING and returns null on a fresh install (default OFF)', async () => {
    const m = await load()
    expect(await m.stageSkillsForFolder('/repo/one')).toBeNull()
  })

  it('does not re-stage when the stamp is unchanged', async () => {
    await setGlobal({ a: true })
    const m = await load()
    const first = await m.stageSkillsForFolder('/repo/one')
    // A sentinel inside the staged tree survives a skipped re-stage and is wiped
    // by a real one — a directly observable "did it copy again?".
    const sentinel = path.join(first!.dir, 'skills', 'a', 'SENTINEL')
    await fs.writeFile(sentinel, 'x', 'utf8')
    await m.stageSkillsForFolder('/repo/one')
    expect(await exists(sentinel)).toBe(true)
  })

  it('re-stages when the enabled set changes, and the removed skill is gone', async () => {
    await setGlobal({ a: true, b: true })
    const m = await load()
    const first = await m.stageSkillsForFolder('/repo/one')
    expect(await exists(path.join(first!.dir, 'skills', 'b'))).toBe(true)

    await setGlobal({ a: true })
    const second = await m.stageSkillsForFolder('/repo/one')
    expect(second!.enabled).toEqual(['a'])
    expect(await exists(path.join(second!.dir, 'skills', 'a'))).toBe(true)
    expect(await exists(path.join(second!.dir, 'skills', 'b'))).toBe(false)
  })

  it('re-stages when the stamp is stale, e.g. after an app update bumped the marker', async () => {
    await setGlobal({ a: true })
    const m = await load()
    const first = await m.stageSkillsForFolder('/repo/one')
    const sentinel = path.join(first!.dir, 'skills', 'a', 'SENTINEL')
    await fs.writeFile(sentinel, 'x', 'utf8')

    // `BUNDLED_SKILLS_VERSION` is embedded at BUILD time (the `?raw` catalog doc),
    // so an app update is observed here as a stamp that no longer matches — write
    // exactly the stamp a previous app version would have left behind.
    await fs.writeFile(path.join(first!.dir, '.stamp'), 'v0:a\n', 'utf8')
    await m.stageSkillsForFolder('/repo/one')
    expect(await exists(sentinel)).toBe(false)
    expect(await exists(path.join(first!.dir, 'skills', 'a', 'SKILL.md'))).toBe(true)
  })

  it('carries the shipped catalog marker as BUNDLED_SKILLS_VERSION', async () => {
    const m = await load()
    // Embedded from the REAL resources/skills/CATALOG.md at build time, not from
    // the fake tree above — a missing marker would silently degrade to 'v0' and
    // stop re-staging after an app update, so pin that it parses.
    expect(m.BUNDLED_SKILLS_VERSION).toMatch(/^v[1-9]\d*$/)
  })

  it('removes a previously staged tree once everything is turned off', async () => {
    await setGlobal({ a: true })
    const m = await load()
    const first = await m.stageSkillsForFolder('/repo/one')
    expect(await exists(first!.dir)).toBe(true)

    await setGlobal({ a: false })
    expect(await m.stageSkillsForFolder('/repo/one')).toBeNull()
    expect(await exists(first!.dir)).toBe(false)
  })

  it('keeps two folders independent — a different enabled set per folder', async () => {
    await setGlobal({ a: true })
    const m = await load()
    const one = await m.stageSkillsForFolder('/repo/one')
    const two = await m.stageSkillsForFolder('/repo/two')
    expect(one!.dir).not.toBe(two!.dir)
  })

  it('is fail-soft: an unreadable catalog yields no staged dir, never a throw', async () => {
    await setGlobal({ a: true })
    await fs.rm(path.join(h.appPath, 'resources'), { recursive: true, force: true })
    const m = await load()
    await expect(m.stageSkillsForFolder('/repo/one')).resolves.toBeNull()
  })
})

describe('per-folder override (AC-3) through the real projects.json store', () => {
  /** Write a `projects.json` record carrying per-folder skill overrides. */
  async function setFolderOverrides(
    folder: string,
    skills: Record<string, boolean>
  ): Promise<void> {
    await fs.writeFile(
      path.join(h.userDataDir, 'projects.json'),
      JSON.stringify({
        version: 1,
        projects: [{ path: folder, alias: 'f', addedAt: '2026-08-22', worktrees: [], skills }]
      }),
      'utf8'
    )
  }

  it('a folder OFF beats a global ON — the skill is not staged there', async () => {
    const folder = await tmpDir('harnu-skills-folder-')
    await setGlobal({ a: true, b: true })
    await setFolderOverrides(folder, { a: false })
    const m = await load()
    const staged = await m.stageSkillsForFolder(folder)
    expect(staged!.enabled).toEqual(['b'])
    expect(await exists(path.join(staged!.dir, 'skills', 'a'))).toBe(false)
  })

  it('a folder ON beats a global OFF — the skill IS staged there', async () => {
    const folder = await tmpDir('harnu-skills-folder-')
    await setGlobal({ a: false })
    await setFolderOverrides(folder, { a: true })
    const m = await load()
    const staged = await m.stageSkillsForFolder(folder)
    expect(staged!.enabled).toEqual(['a'])
  })

  it('an unset folder key inherits the global value', async () => {
    const folder = await tmpDir('harnu-skills-folder-')
    await setGlobal({ a: true })
    await setFolderOverrides(folder, { b: false })
    const m = await load()
    expect((await m.stageSkillsForFolder(folder))!.enabled).toEqual(['a'])
  })

  it('writes NOTHING inside the folder itself (AC-3, second half)', async () => {
    const folder = await tmpDir('harnu-skills-folder-')
    await setGlobal({ a: true })
    await setFolderOverrides(folder, { a: true })
    const m = await load()
    const args = await m.injectBundledSkillArgs([], folder)
    expect(args).toContain('--plugin-dir')
    // Not `.claude/`, not a dotfile, not anything: the folder is untouched.
    expect(await fs.readdir(folder)).toEqual([])
    // And the staged tree lives outside it.
    expect(args[1].startsWith(folder)).toBe(false)
  })
})

describe('injectBundledSkillArgs', () => {
  it('appends --plugin-dir pointing at the staged tree when something is on', async () => {
    await setGlobal({ a: true })
    const m = await load()
    const args = await m.injectBundledSkillArgs(['--resume', 'x'], '/repo/one')
    expect(args.slice(0, 2)).toEqual(['--resume', 'x'])
    expect(args[2]).toBe('--plugin-dir')
    expect(args[3]).toBe(m.stagedPluginDir('/repo/one'))
  })

  it('leaves argv untouched when nothing is on (the default install)', async () => {
    const m = await load()
    expect(await m.injectBundledSkillArgs(['--resume', 'x'], '/repo/one')).toEqual([
      '--resume',
      'x'
    ])
  })
})

describe('setUserLevelInstall — "Also outside Capy"', () => {
  it("installs the flat ~/.claude/skills/<name>/SKILL.md plus Capy's own stamp", async () => {
    const m = await load()
    expect(await m.setUserLevelInstall('a', true)).toEqual({ ok: true, installed: true })
    const dir = path.join(h.home, '.claude', 'skills', 'a')
    expect(await exists(path.join(dir, 'SKILL.md'))).toBe(true)
    expect(await exists(path.join(dir, '.harnu-managed.json'))).toBe(true)
    expect(await exists(path.join(dir, '.capy-managed.json'))).toBe(false)
    const stamp = JSON.parse(await fs.readFile(path.join(dir, '.harnu-managed.json'), 'utf8'))
    expect(stamp.managedBy).toBe('harnu')
    expect(stamp.skill).toBe('a')
  })

  describe('a directory carrying the legacy Capy stamp (.capy-managed.json)', () => {
    const legacyDir = async (): Promise<string> => {
      const dir = path.join(h.home, '.claude', 'skills', 'a')
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, 'SKILL.md'), 'old capy copy', 'utf8')
      await fs.writeFile(
        path.join(dir, '.capy-managed.json'),
        JSON.stringify({ managedBy: 'capy', skill: 'a', version: 1 }),
        'utf8'
      )
      return dir
    }

    it('is ours, not occupied: re-staging overwrites it and replaces the old stamp', async () => {
      const dir = await legacyDir()
      const m = await load()
      expect(await m.setUserLevelInstall('a', true)).toEqual({ ok: true, installed: true })
      expect(await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8')).not.toBe('old capy copy')
      expect(await exists(path.join(dir, '.capy-managed.json'))).toBe(false)
      const stamp = JSON.parse(await fs.readFile(path.join(dir, '.harnu-managed.json'), 'utf8'))
      expect(stamp.managedBy).toBe('harnu')
    })

    it('is removed on uninstall like a current install', async () => {
      const dir = await legacyDir()
      const m = await load()
      expect(await m.setUserLevelInstall('a', false)).toEqual({ ok: true, installed: false })
      expect(await exists(dir)).toBe(false)
    })
  })

  it('REFUSES rather than overwriting a directory Capy did not create', async () => {
    const dir = path.join(h.home, '.claude', 'skills', 'a')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'SKILL.md'), 'the user, not Capy', 'utf8')

    const m = await load()
    expect(await m.setUserLevelInstall('a', true)).toEqual({ ok: false, reason: 'occupied' })
    expect(await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8')).toBe('the user, not Capy')
  })

  it('removes only its own install', async () => {
    const m = await load()
    await m.setUserLevelInstall('a', true)
    expect(await m.setUserLevelInstall('a', false)).toEqual({ ok: true, installed: false })
    expect(await exists(path.join(h.home, '.claude', 'skills', 'a'))).toBe(false)
  })

  it("leaves the user's own directory alone when asked to remove", async () => {
    const dir = path.join(h.home, '.claude', 'skills', 'a')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'SKILL.md'), 'the user, not Capy', 'utf8')

    const m = await load()
    await m.setUserLevelInstall('a', false)
    expect(await exists(path.join(dir, 'SKILL.md'))).toBe(true)
  })

  it('refuses a name that is not in the catalog', async () => {
    const m = await load()
    expect(await m.setUserLevelInstall('../escape', true)).toEqual({
      ok: false,
      reason: 'unknown-skill'
    })
  })
})

describe('scanSkillCollisions', () => {
  it('flags a personal skill of the same name', async () => {
    await fs.mkdir(path.join(h.home, '.claude', 'skills', 'b'), { recursive: true })
    const m = await load()
    expect(await m.scanSkillCollisions()).toEqual(['b'])
  })

  it('flags a personal command of the same name', async () => {
    await fs.mkdir(path.join(h.home, '.claude', 'commands'), { recursive: true })
    await fs.writeFile(path.join(h.home, '.claude', 'commands', 'c.md'), 'x', 'utf8')
    const m = await load()
    expect(await m.scanSkillCollisions()).toEqual(['c'])
  })

  it('is empty when the operator has no ~/.claude at all', async () => {
    const m = await load()
    expect(await m.scanSkillCollisions()).toEqual([])
  })
})

describe('cleanStaleLegacyStaging (AC-3b — pre-rename `<hash>/capy` staging dirs)', () => {
  it('removes a stale legacy plugin dir, keeps the current one and unrelated entries', async () => {
    const root = path.join(h.userDataDir, 'skills')
    const stale = path.join(root, 'abc123', 'capy', 'skills', 'a')
    const current = path.join(root, 'abc123', 'harnu', 'skills', 'a')
    await fs.mkdir(stale, { recursive: true })
    await fs.mkdir(current, { recursive: true })
    await fs.writeFile(path.join(root, 'abc123', 'capy', '.stamp'), 'v1', 'utf8')
    await fs.writeFile(path.join(root, 'stray-file'), 'keep', 'utf8')
    const m = await load()
    expect(await m.cleanStaleLegacyStaging()).toBe(1)
    expect(await exists(path.join(root, 'abc123', 'capy'))).toBe(false)
    expect(await exists(current)).toBe(true)
    expect(await exists(path.join(root, 'stray-file'))).toBe(true)
  })

  it('is a no-op (and never throws) when there is no staging root yet', async () => {
    const m = await load()
    expect(await m.cleanStaleLegacyStaging()).toBe(0)
  })
})
