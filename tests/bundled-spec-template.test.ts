/**
 * BUG-260 — the `spec` skill travels with its own copy of `docs/specs/TEMPLATE.md`, so authoring
 * works in a repo that has no `docs/specs/` of its own (the T601 S-10 bake-off had to copy the
 * template by hand). Three things are graded: the copy exists and equals the repo template, the
 * real staging shell carries it into a session's tool folder, and SKILL.md resolves the repo's
 * own template first and the staged one second.
 */
import { existsSync, promises as fs, readFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { it, expect, vi } from 'vitest'

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

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const SKILL_DIR = path.join(REPO_ROOT, 'resources', 'skills', 'skills', 'spec')
const REPO_TEMPLATE = path.join(REPO_ROOT, 'docs', 'specs', 'TEMPLATE.md')
const SKILL_TEMPLATE = path.join(SKILL_DIR, 'TEMPLATE.md')

it('the skill ships a TEMPLATE.md identical to docs/specs/TEMPLATE.md', () => {
  expect(existsSync(SKILL_TEMPLATE)).toBe(true)
  expect(readFileSync(SKILL_TEMPLATE, 'utf8')).toBe(readFileSync(REPO_TEMPLATE, 'utf8'))
})

it('staging an enabled spec skill carries TEMPLATE.md into the tool folder', async () => {
  const tmp = (p: string): Promise<string> => fs.mkdtemp(path.join(os.tmpdir(), p))
  h.userDataDir = await tmp('harnu-spec-tpl-ud-')
  h.appPath = await tmp('harnu-spec-tpl-app-')
  h.home = await tmp('harnu-spec-tpl-home-')

  const res = path.join(REPO_ROOT, 'resources', 'skills')
  const base = path.join(h.appPath, 'resources', 'skills')
  await fs.mkdir(path.join(base, '.claude-plugin'), { recursive: true })
  await fs.copyFile(
    path.join(res, '.claude-plugin', 'plugin.json'),
    path.join(base, '.claude-plugin', 'plugin.json')
  )
  await fs.copyFile(path.join(res, 'CATALOG.md'), path.join(base, 'CATALOG.md'))
  await fs.cp(SKILL_DIR, path.join(base, 'skills', 'spec'), { recursive: true })
  await fs.writeFile(
    path.join(h.userDataDir, 'bundled-skills.json'),
    JSON.stringify({ version: 1, enabled: { spec: true }, userLevelInstall: {} }),
    'utf8'
  )

  vi.resetModules()
  const m = await import('../src/main/bundled-skills')
  const staged = await m.stageSkillsForFolder(await tmp('harnu-spec-tpl-folder-'))
  expect(staged?.enabled).toEqual(['spec'])
  const stagedTemplate = path.join(staged!.dir, 'skills', 'spec', 'TEMPLATE.md')
  expect(existsSync(stagedTemplate)).toBe(true)
  expect(readFileSync(stagedTemplate, 'utf8')).toBe(readFileSync(REPO_TEMPLATE, 'utf8'))
})

it("SKILL.md resolves the repo's own template first and the staged one second", () => {
  const skill = readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8').replace(/\s+/g, ' ')
  const own = skill.indexOf("the repo's own `docs/specs/TEMPLATE.md`")
  const staged = skill.indexOf('the `TEMPLATE.md` beside this skill')
  expect(own, 'names the repo template').toBeGreaterThan(-1)
  expect(staged, 'names the staged template').toBeGreaterThan(-1)
  expect(own).toBeLessThan(staged)
  // The staged copy is the fallback, not an equal: the text between the two names says so.
  expect(skill.slice(own, staged)).toMatch(/\b(has one|exists|when it has|if it has)\b/)
  expect(skill.slice(own, staged)).toMatch(/\botherwise\b/)
})
