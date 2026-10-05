/**
 * T305 — `/skill` mentions in a worker's prompt.
 *
 * The load-bearing claim of the feature is that the staged set is a VIEW of the
 * prompt string and is never stored beside it. That is only true if both halves
 * of the app derive it the same way from the same text, so this file runs main's
 * parser and the renderer's copy over one shared corpus and asserts they agree.
 */
import { describe, it, expect } from 'vitest'
import { newWorker, parseSkillMentions as parseMain } from '../src/main/scheduler-core'
import {
  filterSkills,
  insertMention,
  mentionChips,
  mentionTrigger,
  parseSkillMentions as parseRenderer,
  pickerSkills
} from '../src/renderer/src/components/scheduler-mentions'
import type { AvailableSkill } from '../src/main/bundled-skills'

/** Every shape the two parsers must agree on. */
const CORPUS = [
  '',
  'no mentions here',
  'run /land-prs now',
  '/land-prs',
  'use /capy:mission then /dtk:review',
  'look at src/main/scheduler-core.ts and docs/user/scheduler.md',
  'read a/b/c then run /status',
  'run /land-prs twice: /land-prs',
  'finish with /land-prs.',
  'a slash/skill is not a mention',
  'trailing slash / alone',
  'newline\n/mission works too',
  'tab\t/status works too',
  '/UPPER-case_skill.v2'
]

describe('parseSkillMentions — main and renderer never drift', () => {
  for (const text of CORPUS) {
    it(`agrees on ${JSON.stringify(text)}`, () => {
      expect(parseRenderer(text)).toEqual(parseMain(text))
    })
  }
})

describe('parseSkillMentions', () => {
  it('finds a mention at a word boundary', () => {
    expect(parseMain('run /land-prs now')).toEqual(['land-prs'])
    expect(parseMain('/land-prs')).toEqual(['land-prs'])
  })

  it('AC-1: a slash inside a path is not a mention', () => {
    expect(parseMain('look at src/main/scheduler-core.ts and docs/user/scheduler.md')).toEqual([])
    expect(parseMain('a/b/c')).toEqual([])
  })

  it('accepts a namespace', () => {
    expect(parseMain('use /capy:mission then /dtk:review')).toEqual(['capy:mission', 'dtk:review'])
  })

  it('de-duplicates, keeping first-appearance order', () => {
    expect(parseMain('run /b then /a then /b')).toEqual(['b', 'a'])
  })

  it('does not swallow sentence punctuation', () => {
    expect(parseMain('finish with /land-prs.')).toEqual(['land-prs'])
  })

  it('AC-5: nothing about a mention is stored on a Worker', () => {
    expect(Object.keys(newWorker('w1'))).not.toContain('skills')
  })
})

describe('mentionTrigger — AC-1', () => {
  it('opens on a slash at the start of the field', () => {
    expect(mentionTrigger('/', 1)).toEqual({ start: 0, query: '' })
  })

  it('opens on a slash after whitespace, and carries what follows it', () => {
    expect(mentionTrigger('run /lan', 8)).toEqual({ start: 4, query: 'lan' })
    expect(mentionTrigger('run\n/lan', 8)).toEqual({ start: 4, query: 'lan' })
  })

  it('stays SHUT on a slash inside a path', () => {
    expect(mentionTrigger('src/', 4)).toBeNull()
    expect(mentionTrigger('src/main/', 9)).toBeNull()
    expect(mentionTrigger('docs/user/sched', 15)).toBeNull()
  })

  it('dismisses on a space', () => {
    expect(mentionTrigger('run /land-prs ', 14)).toBeNull()
  })

  it('dismisses on a character a skill id cannot contain', () => {
    expect(mentionTrigger('run /land!', 10)).toBeNull()
  })

  it('reads the token the caret is inside, not the last one in the field', () => {
    expect(mentionTrigger('/a and /b', 2)).toEqual({ start: 0, query: 'a' })
  })
})

describe('insertMention — AC-4', () => {
  it('puts the literal skill name into the prompt text', () => {
    const text = 'run /lan'
    const trigger = mentionTrigger(text, 8)!
    const next = insertMention(text, trigger, 8, 'land-prs')
    expect(next.text).toBe('run /land-prs ')
    expect(next.text).toContain('land-prs')
    expect(next.caret).toBe(next.text.length)
  })

  it('keeps whatever followed the caret', () => {
    const text = 'run /lan then stop'
    const next = insertMention(text, mentionTrigger(text, 8)!, 8, 'land-prs')
    expect(next.text).toBe('run /land-prs  then stop')
  })

  it('the inserted text parses back to the picked skill', () => {
    const next = insertMention('/mis', mentionTrigger('/mis', 4)!, 4, 'capy:mission')
    expect(parseMain(next.text)).toEqual(['capy:mission'])
  })
})

const SKILLS: AvailableSkill[] = [
  { name: 'land-prs', description: '', origin: 'personal' },
  { name: 'mission', description: '', origin: 'personal' },
  { name: 'mission', description: '', origin: 'bundled' },
  { name: 'status', description: '', origin: 'bundled' },
  { name: 'deploy', description: '', origin: 'project' }
]

describe('pickerSkills / filterSkills', () => {
  it('collapses a shadowed name to one row, most specific first', () => {
    const rows = pickerSkills(SKILLS)
    expect(rows.filter((r) => r.name === 'mission')).toHaveLength(1)
    expect(rows.find((r) => r.name === 'mission')?.origin).toBe('personal')
  })

  it('ranks prefix matches ahead of contains matches', () => {
    const rows = filterSkills(
      [
        { name: 'unrelated-status', description: '', origin: 'bundled' },
        { name: 'status', description: '', origin: 'bundled' }
      ],
      'stat'
    )
    expect(rows.map((r) => r.name)).toEqual(['status', 'unrelated-status'])
  })
})

describe('mentionChips — AC-5, AC-6', () => {
  it('tags each mention with the origin it would actually be staged from', () => {
    expect(mentionChips('run /land-prs and /deploy', SKILLS)).toEqual([
      { mention: 'land-prs', origin: 'personal' },
      { mention: 'deploy', origin: 'project' }
    ])
  })

  it('AC-6: a mention nothing answers to is reported, never dropped', () => {
    expect(mentionChips('run /nope', SKILLS)).toEqual([{ mention: 'nope' }])
    expect(mentionChips('run /dtk:review', SKILLS)).toEqual([{ mention: 'dtk:review' }])
  })

  it('a harnu: prefix still resolves a bundled skill a personal one shadows', () => {
    expect(mentionChips('/harnu:mission', SKILLS)).toEqual([
      { mention: 'harnu:mission', origin: 'bundled' }
    ])
    expect(mentionChips('/mission', SKILLS)).toEqual([{ mention: 'mission', origin: 'personal' }])
  })

  it('the legacy capy: prefix is an alias of harnu: (persisted prompts keep their chip)', () => {
    expect(mentionChips('/capy:mission', SKILLS)).toEqual([
      { mention: 'capy:mission', origin: 'bundled' }
    ])
    expect(mentionChips('/capy:nope', SKILLS)).toEqual([{ mention: 'capy:nope' }])
  })

  it('AC-5: the chip set is derived — deleting the text deletes the chip', () => {
    expect(mentionChips('run /land-prs', SKILLS)).toHaveLength(1)
    expect(mentionChips('run ', SKILLS)).toHaveLength(0)
  })

  it('AC-5: a hand-typed name gains a chip with no picker involved', () => {
    expect(mentionChips('/deploy', SKILLS)).toEqual([{ mention: 'deploy', origin: 'project' }])
  })
})
