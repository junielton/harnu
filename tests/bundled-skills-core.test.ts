/**
 * T217 §9.1 — the pure rules behind bundled skills.
 *
 * The one that matters is `resolveSkillEnabled` + `enabledSkillNames`: the staged
 * set IS the session's catalog, so a cascade bug is directly a skill the operator
 * switched off still being invocable. AC-2's negative half and AC-3 are both
 * decided here, plus the argv rule that an EMPTY enabled set emits no
 * `--plugin-dir` at all.
 */
import { describe, it, expect } from 'vitest'
import {
  insertPluginDirArg,
  detectSkillCollisions,
  enabledSkillNames,
  folderStageKey,
  parseBundledSkillsVersion,
  parseSkillFrontmatter,
  resolveSkillEnabled,
  stageStamp,
  type BundledSkill
} from '../src/main/bundled-skills-core'

const CATALOG: BundledSkill[] = [
  { name: 'a', description: 'skill a' },
  { name: 'b', description: 'skill b' },
  { name: 'c', description: 'skill c' },
  { name: 'd', description: 'skill d' }
]

describe('resolveSkillEnabled — the tri-state cascade', () => {
  it('defaults to OFF when neither scope sets it (AC-1)', () => {
    expect(resolveSkillEnabled({}, {}, 'mission')).toBe(false)
    expect(resolveSkillEnabled(undefined, undefined, 'mission')).toBe(false)
  })

  it('inherits the global value when the folder key is absent', () => {
    expect(resolveSkillEnabled({ mission: true }, {}, 'mission')).toBe(true)
    expect(resolveSkillEnabled({ mission: false }, {}, 'mission')).toBe(false)
  })

  it('an explicit folder false BEATS a global true (AC-3)', () => {
    expect(resolveSkillEnabled({ mission: true }, { mission: false }, 'mission')).toBe(false)
  })

  it('an explicit folder true BEATS a global false (AC-3)', () => {
    expect(resolveSkillEnabled({ mission: false }, { mission: true }, 'mission')).toBe(true)
  })

  it('treats an explicitly-undefined folder key as unset, not as false', () => {
    expect(resolveSkillEnabled({ mission: true }, { mission: undefined }, 'mission')).toBe(true)
  })

  it('scopes per skill — one override never leaks onto a sibling', () => {
    const global = { a: true, b: true }
    const folder = { a: false }
    expect(resolveSkillEnabled(global, folder, 'a')).toBe(false)
    expect(resolveSkillEnabled(global, folder, 'b')).toBe(true)
  })
})

describe('enabledSkillNames', () => {
  it('returns only the enabled entries, in catalog order', () => {
    expect(enabledSkillNames(CATALOG, { a: true, c: true }, {})).toEqual(['a', 'c'])
  })

  it('is empty on a fresh install', () => {
    expect(enabledSkillNames(CATALOG, {}, {})).toEqual([])
  })

  it('applies the folder override on top of the global one', () => {
    expect(enabledSkillNames(CATALOG, { a: true, b: true }, { b: false, d: true })).toEqual([
      'a',
      'd'
    ])
  })
})

describe('insertPluginDirArg', () => {
  it('emits NO --plugin-dir when nothing is enabled', () => {
    expect(insertPluginDirArg(['--resume', 'x'], '/staged', [])).toEqual(['--resume', 'x'])
  })

  it('emits the flag exactly once when something is enabled', () => {
    expect(insertPluginDirArg(['--resume', 'x'], '/staged', ['a'])).toEqual([
      '--resume',
      'x',
      '--plugin-dir',
      '/staged'
    ])
  })

  it('is idempotent — never doubles its own directory', () => {
    const once = insertPluginDirArg([], '/staged', ['a'])
    expect(insertPluginDirArg(once, '/staged', ['a'])).toEqual(once)
  })

  it("leaves a user's own --plugin-dir alone and adds Capy's beside it", () => {
    expect(insertPluginDirArg(['--plugin-dir', '/mine'], '/staged', ['a'])).toEqual([
      '--plugin-dir',
      '/mine',
      '--plugin-dir',
      '/staged'
    ])
  })

  it('emits nothing when the staged dir is empty (a failed staging)', () => {
    expect(insertPluginDirArg(['--resume'], '', ['a'])).toEqual(['--resume'])
  })

  it('does not mutate the input argv', () => {
    const args = ['--resume']
    insertPluginDirArg(args, '/staged', ['a'])
    expect(args).toEqual(['--resume'])
  })
})

describe('parseSkillFrontmatter', () => {
  it('reads name + description', () => {
    const raw = '---\nname: mission\ndescription: Run one coordination tick.\n---\n\n# Mission\n'
    expect(parseSkillFrontmatter(raw)).toEqual({
      name: 'mission',
      description: 'Run one coordination tick.'
    })
  })

  it('strips surrounding quotes from a quoted description', () => {
    const raw = '---\nname: mission\ndescription: "Run a tick: read, act, report."\n---\nbody\n'
    expect(parseSkillFrontmatter(raw)?.description).toBe('Run a tick: read, act, report.')
  })

  it('folds an indented continuation line into the description', () => {
    const raw = '---\nname: mission\ndescription: Run one tick\n  over dispatched work.\n---\nx\n'
    expect(parseSkillFrontmatter(raw)?.description).toBe('Run one tick over dispatched work.')
  })

  it('drops an entry with no frontmatter block (per-entry fail-soft)', () => {
    expect(parseSkillFrontmatter('# Mission\n\nno frontmatter here')).toBeNull()
  })

  it('drops an entry with an unterminated frontmatter block', () => {
    expect(parseSkillFrontmatter('---\nname: mission\ndescription: x\n')).toBeNull()
  })

  it('drops an entry missing name or description', () => {
    expect(parseSkillFrontmatter('---\nname: mission\n---\nbody')).toBeNull()
    expect(parseSkillFrontmatter('---\ndescription: only a description\n---\nbody')).toBeNull()
  })

  it('drops an entry whose name disagrees with its directory', () => {
    const raw = '---\nname: something-else\ndescription: d\n---\nbody'
    expect(parseSkillFrontmatter(raw, 'mission')).toBeNull()
    expect(parseSkillFrontmatter(raw, 'something-else')).not.toBeNull()
  })
})

describe('parseBundledSkillsVersion', () => {
  it('reads the marker', () => {
    expect(parseBundledSkillsVersion('<!-- harnu-skills v7 (2026-08-22) -->\n# Catalog')).toBe('v7')
  })

  it('still reads the pre-rename capy-skills marker', () => {
    expect(parseBundledSkillsVersion('<!-- capy-skills v7 (2026-08-22) -->\n# Catalog')).toBe('v7')
  })

  it('falls back to v0 when the marker is missing', () => {
    expect(parseBundledSkillsVersion('# Catalog with no marker')).toBe('v0')
  })

  it('is case-insensitive on the marker name', () => {
    expect(parseBundledSkillsVersion('<!--  Capy-Skills   v12  -->')).toBe('v12')
  })
})

describe('stageStamp', () => {
  it('changes when the catalog version changes (re-stage after an app update)', () => {
    expect(stageStamp('v1', ['a'])).not.toBe(stageStamp('v2', ['a']))
  })

  it('changes when the enabled set changes (re-stage after a toggle)', () => {
    expect(stageStamp('v1', ['a'])).not.toBe(stageStamp('v1', ['a', 'b']))
  })

  it('is order-independent, so a reordered set does not force a needless re-stage', () => {
    expect(stageStamp('v1', ['b', 'a'])).toBe(stageStamp('v1', ['a', 'b']))
  })
})

describe('folderStageKey', () => {
  it('is stable for the same folder', () => {
    expect(folderStageKey('/repo/a')).toBe(folderStageKey('/repo/a'))
  })

  it('differs per folder, so two folders can hold different enabled sets', () => {
    expect(folderStageKey('/repo/a')).not.toBe(folderStageKey('/repo/b'))
  })

  it('is filesystem-safe and leaks no path', () => {
    const key = folderStageKey('/home/someone/secret project')
    expect(key).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('detectSkillCollisions', () => {
  it('flags a personal skill directory of the same name', () => {
    expect(detectSkillCollisions(CATALOG, ['b'], [])).toEqual(['b'])
  })

  it('flags a personal command file of the same name, .md stripped', () => {
    expect(detectSkillCollisions(CATALOG, [], ['c.md'])).toEqual(['c'])
  })

  it('returns nothing when the operator has no matching personal content', () => {
    expect(detectSkillCollisions(CATALOG, ['unrelated'], ['other.md'])).toEqual([])
  })

  it('never reports a name twice when both a skill and a command collide', () => {
    expect(detectSkillCollisions(CATALOG, ['a'], ['a.md'])).toEqual(['a'])
  })
})
