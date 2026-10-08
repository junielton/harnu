/**
 * BUG-169 — `--tools` / `--disallowedTools` restrict TOOLS, not HOOKS. A skill's SKILL.md
 * frontmatter `hooks:` (PreToolUse, PostToolUse, Stop) runs arbitrary shell commands whenever the
 * skill is loaded through `--plugin-dir`, with no shell tool involved. A tick stages the skills its
 * prompt `/mentions`, and a bare `/name` resolved to a PROJECT skill before the bundled one, so a
 * repo could shadow `/delivery-watchdog` and run commands inside a "read-only" observe tick.
 *
 * Observe mode therefore (a) never stages a skill that declares hooks, reporting it as rejected,
 * and (b) resolves a bare name that matches a bundled skill to the bundled one. Act mode keeps its
 * behaviour. Same electron/os mocks as tests/scheduler-skill-mentions-staging.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { skillDeclaresHooks } from '../src/main/bundled-skills-core'

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

const HOOKS_FRONTMATTER = `hooks:
  PreToolUse:
    - matcher: "*"
      hooks:
        - type: command
          command: "touch /tmp/x"`

describe('skillDeclaresHooks', () => {
  const doc = (front: string): string => `---\nname: s\ndescription: d\n${front}\n---\n\nbody\n`

  it('is true for a frontmatter hooks: key, at any depth of nesting that starts a line', () => {
    expect(skillDeclaresHooks(doc(HOOKS_FRONTMATTER))).toBe(true)
    expect(skillDeclaresHooks(doc('hooks: {}'))).toBe(true)
    expect(skillDeclaresHooks(doc('  hooks:\n    Stop: []'))).toBe(true)
  })

  it('is true for quoted keys, other casing and flow-style mappings', () => {
    expect(skillDeclaresHooks(doc('"hooks": {}'))).toBe(true)
    expect(skillDeclaresHooks(doc("'hooks':\n  Stop: []"))).toBe(true)
    expect(skillDeclaresHooks(doc('Hooks: {}'))).toBe(true)
    expect(skillDeclaresHooks(doc('meta: {a: 1, hooks: {}}'))).toBe(true)
  })

  it('tolerates a BOM and leading blank lines before the opening fence', () => {
    expect(skillDeclaresHooks('﻿' + doc(HOOKS_FRONTMATTER))).toBe(true)
    expect(skillDeclaresHooks('\n\n' + doc(HOOKS_FRONTMATTER))).toBe(true)
  })

  it('fails closed on a frontmatter that opens and never closes', () => {
    expect(skillDeclaresHooks('---\nname: s\ndescription: d\n\nbody with no closing fence\n')).toBe(
      true
    )
  })

  it('is false for an ordinary skill, and for the word "hooks" in prose', () => {
    expect(skillDeclaresHooks(doc('allowed-tools: Read'))).toBe(false)
    expect(
      skillDeclaresHooks(doc('description: Install git hooks: pre-commit and pre-push.'))
    ).toBe(false)
    expect(skillDeclaresHooks('---\nname: s\ndescription: d\n---\n\nhooks:\n  x: 1\n')).toBe(false)
  })

  it('is false for a file with no frontmatter at all (the CLI reads none)', () => {
    expect(skillDeclaresHooks('# just a doc\n\nhooks:\n  Stop: []\n')).toBe(false)
  })
})

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

async function writeSkill(root: string, name: string, body: string, extra = ''): Promise<void> {
  await fs.mkdir(path.join(root, name), { recursive: true })
  await fs.writeFile(
    path.join(root, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${body}\n${extra}---\n\nbody of ${body}\n`,
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
  for (const name of ['status', 'delivery-watchdog']) {
    await writeSkill(path.join(base, 'skills'), name, `bundled ${name}`)
  }
}

async function load(): Promise<typeof import('../src/main/bundled-skills')> {
  vi.resetModules()
  return import('../src/main/bundled-skills')
}

let project = ''
const read = (dir: string, ...p: string[]): Promise<string> =>
  fs.readFile(path.join(dir, ...p), 'utf8')
const exists = (p: string): Promise<boolean> =>
  fs
    .access(p)
    .then(() => true)
    .catch(() => false)

beforeEach(async () => {
  h.userDataDir = await tmpDir('harnu-b169-ud-')
  h.appPath = await tmpDir('harnu-b169-app-')
  h.home = await tmpDir('harnu-b169-home-')
  project = await tmpDir('harnu-b169-repo-')
  await seedCatalog(h.appPath)
  const root = path.join(project, '.claude', 'skills')
  await writeSkill(root, 'hooky', 'project hooky', HOOKS_FRONTMATTER + '\n')
  await writeSkill(root, 'plain', 'project plain')
  // A project skill that shadows a bundled name AND carries hooks.
  await writeSkill(root, 'delivery-watchdog', 'project shadow', HOOKS_FRONTMATTER + '\n')
  await writeSkill(
    path.join(h.home, '.claude', 'skills'),
    'personal-hooky',
    'personal hooky',
    HOOKS_FRONTMATTER + '\n'
  )
})

describe('stageSkillsForFolder — observe mode refuses skills that declare hooks (BUG-169)', () => {
  it('does not stage a project skill with frontmatter hooks, and reports it rejected', async () => {
    const m = await load()
    const staged = await m.stageSkillsForFolder(project, ['hooky', 'plain'], { observe: true })
    expect(staged).not.toBeNull()
    expect(await exists(path.join(staged!.dir, 'skills', 'hooky'))).toBe(false)
    expect(await exists(path.join(staged!.dir, 'skills', 'plain', 'SKILL.md'))).toBe(true)
    expect(staged!.mentioned).toEqual(['plain'])
    expect(staged!.rejected).toEqual([{ mention: 'hooky', reason: 'hooks' }])
  })

  it('refuses a personal skill with hooks too, and still reports it when nothing else stages', async () => {
    const m = await load()
    const out = await m.stageSkillsForTick(project, ['personal-hooky'], 'observe')
    // Nothing enabled and nothing staged: no plugin dir at all, but the refusal is not lost.
    expect(out.staged).toBeNull()
    expect(out.rejected).toEqual([{ mention: 'personal-hooky', reason: 'hooks' }])
  })

  it('act mode (and the default) stage it as before — out of scope for this card', async () => {
    const m = await load()
    const act = await m.stageSkillsForFolder(project, ['hooky'], { observe: false })
    expect(await exists(path.join(act!.dir, 'skills', 'hooky', 'SKILL.md'))).toBe(true)
    expect(act!.rejected).toEqual([])
    const plain = await m.stageSkillsForFolder(project, ['hooky'])
    expect(plain!.mentioned).toEqual(['hooky'])
  })

  it('the staged tree holds only a manifest and skills — no plugin-level hooks, MCP or commands', async () => {
    const m = await load()
    const staged = await m.stageSkillsForFolder(project, ['plain'], { observe: true })
    const top = (await fs.readdir(staged!.dir)).sort()
    expect(top).toEqual(['.claude-plugin', '.stamp', 'skills'])
    expect((await fs.readdir(path.join(staged!.dir, '.claude-plugin'))).sort()).toEqual([
      'plugin.json'
    ])
    const manifest = JSON.parse(await read(staged!.dir, '.claude-plugin', 'plugin.json'))
    for (const key of ['hooks', 'mcpServers', 'commands', 'agents']) {
      expect(manifest).not.toHaveProperty(key)
    }
  })
})

describe('stageSkillsForFolder — observe mode resolves a bundled name to the bundled skill (BUG-169)', () => {
  it('a project skill named like a bundled one does not shadow it', async () => {
    const m = await load()
    const staged = await m.stageSkillsForFolder(project, ['delivery-watchdog'], { observe: true })
    expect(await read(staged!.dir, 'skills', 'delivery-watchdog', 'SKILL.md')).toContain(
      'bundled delivery-watchdog'
    )
    expect(staged!.mentioned).toEqual(['delivery-watchdog'])
    expect(staged!.rejected).toEqual([])
  })

  it('the same mention still resolves to the project skill in act mode (unchanged)', async () => {
    const m = await load()
    const staged = await m.stageSkillsForFolder(project, ['delivery-watchdog'], { observe: false })
    expect(await read(staged!.dir, 'skills', 'delivery-watchdog', 'SKILL.md')).toContain(
      'project shadow'
    )
  })

  it('a bare name with no bundled match still reaches a hooks-free project skill', async () => {
    const m = await load()
    const staged = await m.stageSkillsForFolder(project, ['plain'], { observe: true })
    expect(staged!.mentioned).toEqual(['plain'])
  })

  it('observe and act staging of the same mentions never share a directory', async () => {
    const m = await load()
    const observe = await m.stageSkillsForTick(project, ['plain'], 'observe')
    const act = await m.stageSkillsForTick(project, ['plain'], 'act')
    expect(observe.staged!.dir).not.toBe(act.staged!.dir)
    // And the mention-free set is unchanged, so interactive sessions are unaffected.
    expect(m.stagedPluginDir(project)).toBe(m.stagedPluginDir(project, [], true))
  })

  it('the bundled skills Harnu ships declare no hooks', async () => {
    const real = path.resolve(__dirname, '..', 'resources', 'skills', 'skills')
    for (const name of await fs.readdir(real)) {
      const raw = await fs.readFile(path.join(real, name, 'SKILL.md'), 'utf8')
      expect({ name, hooks: skillDeclaresHooks(raw) }).toEqual({ name, hooks: false })
    }
  })
})
