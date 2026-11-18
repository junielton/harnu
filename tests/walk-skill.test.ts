/**
 * Guided walks · S-6 — the bundled `walk` skill (AC-44, AC-48).
 *
 * Two claims, both about what a session is told and what it can reach:
 *  - the skill ships ON by default (D-21), names its plain-sentence triggers and `/walk`, is staged into a new
 *    session of a fresh install, and can still be switched off in Settings → Skills;
 *  - the end-of-feature offer is three options in chat, once per finished feature, never automatic (D-20), and a
 *    session with the skill off never offers, because the offer exists nowhere else.
 *
 * The real `resources/skills/` tree is staged (nothing is faked but Electron and the home directory), so a rename
 * of the skill, a missing reference file or a catalog row that drifted from the description fails here.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  SKILL_DEFAULTS,
  parseSkillFrontmatter,
  resolveSkillEnabled
} from '../src/main/bundled-skills-core'

const REPO = path.resolve(import.meta.dirname, '..')
const SKILLS = path.join(REPO, 'resources', 'skills')
const WALK_DIR = path.join(SKILLS, 'skills', 'walk')
const read = (...p: string[]): string => readFileSync(path.join(...p), 'utf8')
/** Collapse Prettier's line wrapping so a sentence matches whatever its breaks. */
const flat = (s: string): string => s.replace(/\s+/g, ' ')

const h = vi.hoisted(() => ({
  userDataDir: '',
  appPath: '',
  home: '',
  handlers: new Map<string, (...a: unknown[]) => unknown>()
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: (): string => h.userDataDir,
    getAppPath: (): string => h.appPath
  },
  ipcMain: {
    handle: (channel: string, fn: (...a: unknown[]) => unknown): void => {
      h.handlers.set(channel, fn)
    }
  }
}))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof os>()
  return { ...actual, homedir: (): string => h.home, default: { ...actual, homedir: () => h.home } }
})

async function load(): Promise<typeof import('../src/main/bundled-skills')> {
  vi.resetModules()
  return import('../src/main/bundled-skills')
}

beforeEach(async () => {
  h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'walk-skill-ud-'))
  h.home = await fs.mkdtemp(path.join(os.tmpdir(), 'walk-skill-home-'))
  h.appPath = REPO // the REAL resources/skills tree
  h.handlers.clear()
})

const skill = (): string => read(WALK_DIR, 'SKILL.md')
const frontmatter = () => parseSkillFrontmatter(skill(), 'walk')

describe('the walk skill', () => {
  it('ships on by default and names its triggers', async () => {
    // --- the skill itself: a readable name and a description with the plain sentences and the command form
    const fm = frontmatter()
    expect(fm, 'walk/SKILL.md has a readable frontmatter').not.toBeNull()
    expect(fm!.name).toBe('walk')
    const d = flat(fm!.description)
    for (const trigger of [
      '/walk',
      '/harnu:walk',
      'walk me through what we just built',
      'test PR #48 with me'
    ])
      expect(d, `the description names "${trigger}"`).toContain(trigger)
    expect(d).toMatch(/in their own language/i)

    // --- its catalog row is its description, and the catalog marker moved with it
    const catalog = read(SKILLS, 'CATALOG.md')
    const row = new RegExp('^\\|\\s*`walk`\\s*\\|\\s*(.*?)\\s*\\|\\s*$', 'm').exec(catalog)?.[1]
    expect(row, 'CATALOG.md has a row for walk').toBeDefined()
    expect(flat(row!)).toBe(d)

    // --- the default map and the cascade: on when nobody chose, off when the operator says so
    expect(SKILL_DEFAULTS.walk).toBe(true)
    expect(resolveSkillEnabled({}, {}, 'walk')).toBe(true)
    expect(resolveSkillEnabled({ walk: false }, {}, 'walk')).toBe(false)

    // --- a new session of a fresh install stages it (no prefs file exists in this userData)
    const m = await load()
    const staged = await m.stageSkillsForFolder('/repo/with-no-mission')
    expect(staged, 'a fresh install stages something').not.toBeNull()
    expect(staged!.enabled).toContain('walk')
    for (const file of ['SKILL.md', path.join('references', 'panel-contract.md')])
      expect(existsSync(path.join(staged!.dir, 'skills', 'walk', file)), file).toBe(true)
    // the argv a spawn gets carries the plugin dir that holds it
    const args = await m.injectBundledSkillArgs(['--resume', 'x'], '/repo/with-no-mission')
    expect(args[args.indexOf('--plugin-dir') + 1]).toBe(staged!.dir)

    // --- Settings → Skills shows it ON, and the pane's own switch turns it OFF for good
    const view = await m.readBundledSkillsView()
    expect(view.catalog.map((s) => s.name)).toContain('walk')
    expect(view.enabled.walk).toBe(true)
    m.registerBundledSkillsHandlers()
    await h.handlers.get('bundledSkills:setGlobal')!({}, 'walk', false)
    expect((await m.readBundledSkillsView()).enabled.walk).toBe(false)
    const off = await m.stageSkillsForFolder('/repo/with-no-mission')
    expect(off === null || !off.enabled.includes('walk'), 'switched off: not staged').toBe(true)
    expect(
      await m.injectBundledSkillArgs(['--resume', 'x'], '/repo/with-no-mission')
    ).not.toContain(path.join(h.userDataDir, 'skills'))
  })

  it('the offer is three options in chat, once per feature and never automatic', async () => {
    const offer = flat(
      /## Offer a walk when a feature is done([\s\S]*?)(?=\n## )/.exec(skill())![1]
    )

    // exactly the three options, by their labels, through AskUserQuestion
    expect(offer).toContain('`AskUserQuestion`')
    for (const label of ['Walk me through it', 'Test it end to end', 'Not now'])
      expect(offer, label).toContain(`**${label}**`)
    expect(offer).toMatch(/exactly three options/)
    expect(offer).toMatch(/\(a `learn` walk\)/)
    expect(offer).toMatch(/\(a `check` walk\)/)
    // one line, once per finished feature, never for a trivial change, never starting one on its own
    expect(offer).toMatch(/Once per finished feature/)
    expect(offer).toMatch(/in one line/)
    expect(offer).toMatch(/never for a trivial change/i)
    expect(offer).toMatch(/never starting one on your own/i)
    // Not now snoozes the offer for that feature in the session's own context, and is not asked again
    expect(offer).toMatch(/"Not now" snoozes the offer for that feature in your own context/)
    expect(offer).toMatch(/do not ask again for it/)
    // a session with the skill off never offers; and the offer is the only AskUserQuestion of the skill
    expect(offer).toMatch(/A session with this skill off never offers/)
    expect(offer).toMatch(/the only time this skill uses `AskUserQuestion`/)

    // the offer lives in the walk skill and nowhere else, so a session with it off cannot offer
    const offerSentence = /Test it end to end/
    const others = readdirSync(path.join(SKILLS, 'skills'))
      .filter((n) => n !== 'walk')
      .flatMap((n) => {
        const dir = path.join(SKILLS, 'skills', n)
        return readdirSync(dir, { recursive: true, withFileTypes: true })
          .filter((e) => e.isFile() && e.name.endsWith('.md'))
          .map((e) => path.join(e.parentPath, e.name))
      })
    expect(others.length).toBeGreaterThan(5)
    for (const f of others)
      expect(offerSentence.test(readFileSync(f, 'utf8')), path.relative(SKILLS, f)).toBe(false)

    // ...and with the skill switched off nothing of it is staged into the session
    await fs.writeFile(
      path.join(h.userDataDir, 'bundled-skills.json'),
      JSON.stringify({ version: 1, enabled: { walk: false }, userLevelInstall: {} })
    )
    const m = await load()
    const staged = await m.stageSkillsForFolder('/repo/with-no-mission')
    expect(staged === null || !existsSync(path.join(staged.dir, 'skills', 'walk'))).toBe(true)
  })

  // BUG-293: a command or a URL written into prose cannot be copied or clicked.
  it('teaches where a command, a value and a URL go (AC-1)', () => {
    const panel = flat(read(WALK_DIR, 'references', 'panel-contract.md'))
    const rule = /\*\*Commands, values and URLs have a home\.\*\*([\s\S]*?)(?=\n- \*\*|\n## )/.exec(
      read(WALK_DIR, 'references', 'panel-contract.md')
    )
    expect(rule, 'the panel contract has the "Commands, values and URLs" rule').not.toBeNull()
    const text = flat(rule![1])
    // a command the operator types or pastes: one `block` per step
    expect(text).toMatch(/command[^.]*goes in `do\[\]\.block`/)
    expect(text).toMatch(/one block per step/)
    // a short value: a backtick chip in the text
    expect(text).toMatch(/short value[^.]*backtick/)
    // a URL: `where.links`, and never inside the text
    expect(text).toMatch(/URL[^.]*`where\.links`/)
    expect(text).toMatch(/Neither[^.]*ever written inside `text`/)
    // the validator refuses it, so the contract says what happens
    expect(panel).toMatch(/URL_IN_PROSE/)
    // `undo` carries commands as chips too
    expect(text).toMatch(/`undo`/)
  })

  it('shows a do step with a block and an undo with a command (AC-4)', () => {
    const raw = read(WALK_DIR, 'references', 'panel-contract.md')
    const json = /```json\n([\s\S]*?)```/.exec(raw)?.[1]
    expect(json, 'the contract carries a worked JSON example').toBeDefined()
    const example = JSON.parse(json!) as {
      do: { text: string; block?: { text: string } }[]
      undo: string
    }
    expect(example.do.some((d) => typeof d.block?.text === 'string')).toBe(true)
    expect(/`[^`]+`/.test(example.undo), 'the example undo holds a command as a chip').toBe(true)
    // and the example practices the rule: no URL in any prose field
    const prose = [...example.do.map((d) => d.text), example.undo]
    for (const t of prose) expect(t).not.toMatch(/https?:\/\//)
  })
})
