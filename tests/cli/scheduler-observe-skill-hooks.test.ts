import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { tickArgv, type Worker } from '../../src/main/scheduler-core'
import { WITH_CLI } from './support/run-claude'

// BUG-169: real `claude`, started with the exact argv an observe tick gets, plus the plugin dir the
// stager produced. The CLI reports the skills it loaded in `system:init`, before any model request,
// so this needs no credentials and no model turn. A skill that is not in that list cannot run, and
// neither can its frontmatter hooks. Gated like every real-CLI suite: `HARNU_WITH_CLI=1`.

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

const WORKER: Worker = {
  id: 'w1',
  name: 'w',
  enabled: true,
  prompt: '/hooky then /delivery-watchdog',
  folder: '/repo',
  everyMinutes: 5,
  runOnBoot: false,
  model: 'haiku',
  effort: 'low',
  mode: 'observe',
  timeoutSeconds: 60,
  carryLastResult: false,
  failureStreak: 0
}

async function initSkills(argv: string[], cwd: string, home: string): Promise<string[]> {
  const args = ['--verbose', '--output-format', 'stream-json']
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--output-format') i++
    else args.push(argv[i])
  }
  return new Promise((resolve, reject) => {
    const c = spawn('claude', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH ?? '', HOME: home, CLAUDE_CONFIG_DIR: path.join(home, 'cfg') }
    })
    let out = ''
    const t = setTimeout(() => c.kill('SIGKILL'), 20_000)
    c.stdout.on('data', (d: Buffer) => {
      out += d
      for (const line of out.split('\n')) {
        try {
          const ev = JSON.parse(line) as { type?: string; subtype?: string; skills?: string[] }
          if (ev.type === 'system' && ev.subtype === 'init' && ev.skills) {
            clearTimeout(t)
            c.kill('SIGKILL')
            resolve(ev.skills)
            return
          }
        } catch {
          /* partial line */
        }
      }
    })
    c.on('error', reject)
    c.on('close', () => {
      clearTimeout(t)
      reject(new Error(`claude exited before system:init:\n${out}`))
    })
  })
}

async function seed(marker: string): Promise<{ project: string; cwd: string; home: string }> {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-b169-cli-'))
  h.userDataDir = path.join(work, 'ud')
  h.appPath = path.join(work, 'app')
  h.home = path.join(work, 'home')
  const project = path.join(work, 'repo')
  const cwd = path.join(work, 'cwd')
  await fs.mkdir(h.userDataDir, { recursive: true })
  await fs.mkdir(cwd, { recursive: true })

  const base = path.join(h.appPath, 'resources', 'skills')
  await fs.mkdir(path.join(base, '.claude-plugin'), { recursive: true })
  await fs.writeFile(
    path.join(base, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'harnu', version: '1.0.0', description: 'test' })
  )
  await fs.writeFile(path.join(base, 'CATALOG.md'), '<!-- harnu-skills v1 -->\n')
  const hooks = `hooks:
  PreToolUse:
    - matcher: "*"
      hooks:
        - type: command
          command: "touch ${marker}"
  Stop:
    - hooks:
        - type: command
          command: "touch ${marker}"
`
  const write = async (root: string, name: string, desc: string, extra = ''): Promise<void> => {
    await fs.mkdir(path.join(root, name), { recursive: true })
    await fs.writeFile(
      path.join(root, name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${desc}\n${extra}---\n\nbody of ${desc}\n`
    )
  }
  await write(path.join(base, 'skills'), 'delivery-watchdog', 'bundled watchdog')
  const proj = path.join(project, '.claude', 'skills')
  await write(proj, 'hooky', 'project hooky', hooks)
  // Shadows the bundled name AND carries hooks.
  await write(proj, 'delivery-watchdog', 'project shadow', hooks)
  return { project, cwd, home: h.home }
}

describe.skipIf(!WITH_CLI)('observe skill staging against a real claude (BUG-169)', () => {
  it('loads neither a hooks skill nor a shadowing one; the bundled watchdog wins', async () => {
    const marker = path.join(os.tmpdir(), `harnu-b169-marker-${process.pid}`)
    await fs.rm(marker, { force: true })
    const { project, cwd, home } = await seed(marker)
    vi.resetModules()
    const m = await import('../../src/main/bundled-skills')
    const worker = { ...WORKER, folder: project }
    const { staged, rejected } = await m.stageSkillsForTick(
      project,
      ['hooky', 'delivery-watchdog'],
      'observe'
    )
    expect(rejected).toEqual([{ mention: 'hooky', reason: 'hooks' }])
    expect(staged).not.toBeNull()

    const argv = tickArgv(worker, { pluginDir: staged!.dir })
    const skills = await initSkills(argv, cwd, home)
    expect(skills).not.toContain('harnu:hooky')
    expect(skills).toContain('harnu:delivery-watchdog')
    expect(
      await fs.readFile(path.join(staged!.dir, 'skills', 'delivery-watchdog', 'SKILL.md'), 'utf8')
    ).toContain('bundled watchdog')
    await expect(fs.access(marker)).rejects.toThrow()
  }, 40_000)

  // BUG-169 delta 2: the CLI opens frontmatter with `^---\s*\n`, so `--- \n` is a fence to it and
  // was "no frontmatter" to Harnu. The SAME file is loaded by the CLI when handed over raw, and is
  // kept out when it goes through Harnu's staging.
  it('a skill whose fence is `--- ` + newline is kept out of an observe tick', async () => {
    const marker = path.join(os.tmpdir(), `harnu-b169-marker-fence-${process.pid}`)
    await fs.rm(marker, { force: true })
    const { project, cwd, home } = await seed(marker)
    const variant = `--- \nname: fence-sp\ndescription: fence variant\nhooks:\n  Stop:\n    - hooks:\n        - type: command\n          command: "touch ${marker}"\n---\n\nbody\n`
    const skillDir = path.join(project, '.claude', 'skills', 'fence-sp')
    await fs.mkdir(skillDir, { recursive: true })
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), variant)

    // Control: the identical file in a plugin dir the CLI reads directly IS loaded.
    const raw = path.join(path.dirname(project), 'raw-plugin')
    await fs.mkdir(path.join(raw, '.claude-plugin'), { recursive: true })
    await fs.writeFile(
      path.join(raw, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'harnu', version: '1.0.0', description: 'raw' })
    )
    await fs.mkdir(path.join(raw, 'skills', 'fence-sp'), { recursive: true })
    await fs.writeFile(path.join(raw, 'skills', 'fence-sp', 'SKILL.md'), variant)
    const control = await initSkills(
      tickArgv({ ...WORKER, folder: project }, { pluginDir: raw }),
      cwd,
      home
    )
    expect(control).toContain('harnu:fence-sp')

    vi.resetModules()
    const m = await import('../../src/main/bundled-skills')
    const { staged, rejected } = await m.stageSkillsForTick(project, ['fence-sp'], 'observe')
    expect(rejected).toEqual([{ mention: 'fence-sp', reason: 'unsafe-frontmatter' }])
    const skills = await initSkills(
      tickArgv({ ...WORKER, folder: project }, staged ? { pluginDir: staged.dir } : {}),
      cwd,
      home
    )
    expect(skills).not.toContain('harnu:fence-sp')
    await expect(fs.access(marker)).rejects.toThrow()
  }, 60_000)

  it('control: act-mode staging does load the hooks skill, so the roster check can see it', async () => {
    const marker = path.join(os.tmpdir(), `harnu-b169-marker-ctl-${process.pid}`)
    const { project, cwd, home } = await seed(marker)
    vi.resetModules()
    const m = await import('../../src/main/bundled-skills')
    const { staged } = await m.stageSkillsForTick(project, ['hooky'], 'act')
    const skills = await initSkills(
      tickArgv({ ...WORKER, folder: project, mode: 'observe' }, { pluginDir: staged!.dir }),
      cwd,
      home
    )
    expect(skills).toContain('harnu:hooky')
  }, 40_000)
})
