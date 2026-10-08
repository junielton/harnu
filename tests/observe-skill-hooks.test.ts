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

describe('skillDeclaresHooks — forms that hide the key (BUG-169 delta 1)', () => {
  const doc = (front: string): string => `---\nname: s\ndescription: d\n${front}\n---\n\nbody\n`

  // (a) the token, in any spelling the lexer could still read as the key
  it.each([
    ['upper case', 'HOOKS: {}'],
    ['single quoted', "'hooks': {}"],
    ['double quoted', '"hooks": {}'],
    ['nested', 'meta:\n  hooks:\n    Stop: []'],
    ['flow nested', 'meta: {x: [{hooks: {}}]}'],
    ['escaped letter', '"h\\x6fooks": {}'],
    ['unicode escape', '"\\u0068ooks": {}'],
    ['line-folded key', '"ho\\\nooks": {}']
  ])('(a) refuses %s', (_name, front) => {
    expect(skillDeclaresHooks(doc(front))).toBe(true)
  })

  // (b) YAML features that can name a key without writing it. None of these spells the token, so
  // they are refused by the structural rule, not by (a).
  it.each([
    ['an explicit ? key', '? [a, b]\n: v'],
    ['an explicit ? key, scalar', '? plain\n: v'],
    ['a tag', 'x: !!str y'],
    ['a custom tag', 'x: !thing y'],
    ['an anchor', 'a: &anc {k: v}'],
    ['an alias', 'a: &anc v\nb: *anc'],
    ['a merge key', 'base: &b {k: v}\n<<: *b'],
    ['a backslash escape in a flow mapping', '{"a\\tb": 1}'],
    ['a double-quoted escape', 'x: "a\\tb"']
  ])('(b) refuses %s', (_name, front) => {
    expect(skillDeclaresHooks(doc(front))).toBe(true)
  })

  // (c) not a clean strict parse with the YAML library the repo already uses
  it.each([
    ['an unclosed flow sequence', 'x: [a, b'],
    ['a duplicate key', 'name: other'],
    ['a tab for indentation', 'x:\n\ty: 1'],
    ['a second document (after a document-end marker)', 'x: 1\n...\ny: 2'],
    ['a bare scalar instead of a mapping', 'just a string']
  ])('(c) refuses %s', (_name, front) => {
    expect(skillDeclaresHooks(doc(front))).toBe(true)
  })

  it('still accepts an ordinary skill header', () => {
    expect(
      skillDeclaresHooks(
        doc('allowed-tools: Read, Grep\nmodel: haiku\ntags:\n  - delivery\n  - status')
      )
    ).toBe(false)
  })
})

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

  it('is false for an ordinary skill, and for hooks in the BODY (the CLI reads only the frontmatter)', () => {
    expect(skillDeclaresHooks(doc('allowed-tools: Read'))).toBe(false)
    expect(skillDeclaresHooks('---\nname: s\ndescription: d\n---\n\nhooks:\n  x: 1\n')).toBe(false)
  })

  // BUG-169 delta 1: conservative on purpose. A skill that mentions the word in its description is
  // refused too; it still works in an act worker, and a false positive costs a re-word, a false
  // negative costs a command running in a read-only tick.
  it('refuses the word hooks anywhere in the frontmatter, prose included', () => {
    expect(
      skillDeclaresHooks(doc('description: Install git hooks: pre-commit and pre-push.'))
    ).toBe(true)
    expect(skillDeclaresHooks(doc('tags: [git, HOOKS]'))).toBe(true)
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

  // Bundled skills are Harnu's own and are not run through the observe check. This pins the
  // premise that makes that safe: none of them mentions hooks in its header. (Several fail js-yaml's
  // strict parse, e.g. an unquoted description containing ": ", which the CLI reads leniently, so the
  // strict rule is deliberately not applied to them.)
  it('the bundled skills Harnu ships never mention hooks in their frontmatter', async () => {
    const real = path.resolve(__dirname, '..', 'resources', 'skills', 'skills')
    for (const name of await fs.readdir(real)) {
      const raw = await fs.readFile(path.join(real, name, 'SKILL.md'), 'utf8')
      const header = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)?.[1] ?? ''
      expect({ name, mentionsHooks: /hooks/i.test(header) }).toEqual({ name, mentionsHooks: false })
    }
  })
})

// ── BUG-169 delta 1: what an observe tick copies, and how ────────────────────

describe('observe staging — file layout and the check/copy gap (BUG-169 delta 1)', () => {
  const skillsRoot = (): string => path.join(project, '.claude', 'skills')
  const stagedSkill = (dir: string, name: string): string => path.join(dir, 'skills', name)

  async function plain(name: string, extra?: (dir: string) => Promise<void>): Promise<void> {
    const dir = path.join(skillsRoot(), name)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(
      path.join(dir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: plain ${name}\n---\n\nbody ${name}\n`
    )
    await extra?.(dir)
  }

  it('refuses a skill whose SKILL.md is a symlink', async () => {
    await plain('linked')
    const real = path.join(h.userDataDir, 'elsewhere.md')
    await fs.writeFile(real, '---\nname: linked\ndescription: x\n---\nbody\n')
    await fs.rm(path.join(skillsRoot(), 'linked', 'SKILL.md'))
    await fs.symlink(real, path.join(skillsRoot(), 'linked', 'SKILL.md'))
    const m = await load()
    const out = await m.stageSkillsForTick(project, ['linked'], 'observe')
    expect(out.rejected).toEqual([{ mention: 'linked', reason: 'unsafe-layout' }])
    expect(out.staged).toBeNull()
  })

  it('refuses a skill with a symlink anywhere inside it', async () => {
    await plain('nested-link', async (dir) => {
      await fs.mkdir(path.join(dir, 'refs'))
      await fs.symlink('/etc/hosts', path.join(dir, 'refs', 'hosts'))
    })
    const m = await load()
    const out = await m.stageSkillsForTick(project, ['nested-link'], 'observe')
    expect(out.rejected).toEqual([{ mention: 'nested-link', reason: 'unsafe-layout' }])
  })

  it('refuses a skill that contains a hooks directory or a hooks.json, at any depth', async () => {
    await plain('layout-a', async (dir) => {
      await fs.mkdir(path.join(dir, 'hooks'))
      await fs.writeFile(path.join(dir, 'hooks', 'hooks.json'), '{}')
    })
    await plain('layout-b', async (dir) => {
      await fs.mkdir(path.join(dir, 'a', 'b'), { recursive: true })
      await fs.writeFile(path.join(dir, 'a', 'b', 'Hooks.JSON'), '{}')
    })
    const m = await load()
    const out = await m.stageSkillsForTick(project, ['layout-a', 'layout-b'], 'observe')
    expect(out.rejected.map((r) => [r.mention, r.reason])).toEqual([
      ['layout-a', 'unsafe-layout'],
      ['layout-b', 'unsafe-layout']
    ])
  })

  it('skips dot-files and dot-directories (.claude-plugin/, .mcp.json, .claude/) instead of copying them', async () => {
    await plain('dotty', async (dir) => {
      await fs.mkdir(path.join(dir, '.claude-plugin'))
      await fs.writeFile(path.join(dir, '.claude-plugin', 'plugin.json'), '{"hooks":{}}')
      await fs.writeFile(path.join(dir, '.mcp.json'), '{"mcpServers":{}}')
      await fs.mkdir(path.join(dir, '.claude'))
      await fs.writeFile(path.join(dir, '.claude', 'settings.json'), '{"hooks":{}}')
      await fs.mkdir(path.join(dir, 'refs'))
      await fs.writeFile(path.join(dir, 'refs', 'notes.md'), 'kept')
    })
    const m = await load()
    const out = await m.stageSkillsForTick(project, ['dotty'], 'observe')
    expect(out.rejected).toEqual([])
    const copied = stagedSkill(out.staged!.dir, 'dotty')
    expect((await fs.readdir(copied)).sort()).toEqual(['SKILL.md', 'refs'])
    expect(await read(copied, 'refs', 'notes.md')).toBe('kept')
  })

  it('refuses a skill with a non-regular file (a FIFO would hang a copy)', async () => {
    await plain('fifo', async (dir) => {
      const { execFileSync } = await import('node:child_process')
      execFileSync('mkfifo', [path.join(dir, 'pipe')])
    })
    const m = await load()
    const out = await m.stageSkillsForTick(project, ['fifo'], 'observe')
    expect(out.rejected).toEqual([{ mention: 'fifo', reason: 'unsafe-layout' }])
  })

  it('refuses an oversized skill rather than copying it', async () => {
    await plain('huge', async (dir) => {
      await fs.writeFile(path.join(dir, 'blob.bin'), Buffer.alloc(3 * 1024 * 1024))
    })
    const m = await load()
    const out = await m.stageSkillsForTick(project, ['huge'], 'observe')
    expect(out.rejected).toEqual([{ mention: 'huge', reason: 'unsafe-layout' }])
  })

  // The check and the copy used to be two separate reads of the same file. The bytes that were
  // checked must be the bytes that are staged, whatever happens to the file in between.
  it('stages exactly the bytes it checked, even if SKILL.md is swapped right after the check', async () => {
    await plain('swapme')
    const file = path.join(skillsRoot(), 'swapme', 'SKILL.md')
    const checked = await fs.readFile(file, 'utf8')
    const evil = `---\nname: swapme\ndescription: evil\n${HOOKS_FRONTMATTER}\n---\n\nevil\n`
    const m = await load()
    // The first thing the builder does after resolving and checking is create the temp tree.
    const real = fs.mkdir.bind(fs)
    const spy = vi
      .spyOn(fs, 'mkdir')
      .mockImplementation(async (...a: Parameters<typeof fs.mkdir>) => {
        await fs.writeFile(file, evil)
        return real(...a)
      })
    try {
      const out = await m.stageSkillsForTick(project, ['swapme'], 'observe')
      expect(out.rejected).toEqual([])
      expect(await read(stagedSkill(out.staged!.dir, 'swapme'), 'SKILL.md')).toBe(checked)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('observe resolution — case variants of a bundled name (BUG-169 delta 1)', () => {
  it.each(['Status', 'STATUS', 'sTaTuS'])(
    '/%s resolves to the bundled skill, not a project one',
    async (mention) => {
      // A project skill that differs from the bundled name only by case.
      await writeSkill(path.join(project, '.claude', 'skills'), 'Status', 'project Status')
      const m = await load()
      const out = await m.stageSkillsForTick(project, [mention], 'observe')
      expect(out.rejected).toEqual([])
      expect(await read(out.staged!.dir, 'skills', 'status', 'SKILL.md')).toContain(
        'bundled status'
      )
      expect(await exists(path.join(out.staged!.dir, 'skills', 'Status'))).toBe(false)
    }
  )

  it('the harnu: prefix is case-insensitive in observe too', async () => {
    const m = await load()
    const out = await m.stageSkillsForTick(project, ['Harnu:Delivery-Watchdog'], 'observe')
    expect(await read(out.staged!.dir, 'skills', 'delivery-watchdog', 'SKILL.md')).toContain(
      'bundled delivery-watchdog'
    )
  })

  it('act mode keeps its exact-case behaviour', async () => {
    await writeSkill(path.join(project, '.claude', 'skills'), 'Status', 'project Status')
    const m = await load()
    const out = await m.stageSkillsForTick(project, ['Status'], 'act')
    expect(await read(out.staged!.dir, 'skills', 'Status', 'SKILL.md')).toContain('project Status')
  })
})
