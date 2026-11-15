/**
 * Missions v4, S-36 (AC-85): the user guide describes missions on one page.
 *
 * `docs/user/missions.md` is the page: its four headings are the ones a person looks for (the pane,
 * the acceptance criteria, the hand-off, the records written by earlier versions). The agent-control
 * page points at it and no longer carries a campaign, a steward or a merge-batch section, and the
 * roadmap page says a card can be a step.
 *
 * Planted faults (each makes the named assertion red): rename a heading; link nothing from the
 * agent-control page; put a `## Tracking a whole delivery as a campaign` heading back; drop the
 * roadmap sentence; write "its popover" back into the missions page.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const USER = join(__dirname, '..', 'docs', 'user')
const read = (name: string): string => readFileSync(join(USER, name), 'utf8')

const headings = (md: string): string[] =>
  md
    .split('\n')
    .filter((l) => /^#{1,6} /.test(l))
    .map((l) => l.replace(/^#+\s+/, '').trim())

const MISSIONS = read('missions.md')
const AGENT_CONTROL = read('agent-control.md')
const ROADMAP = read('roadmap-board.md')

describe('the user guide covers missions (AC-85)', () => {
  it('the missions page covers the pane, the criteria and the hand-off', () => {
    const h = headings(MISSIONS)
    for (const wanted of [
      'The pane',
      'Acceptance criteria',
      'Hand-off',
      'Records from earlier versions'
    ])
      expect(h, `a "${wanted}" heading on missions.md`).toContain(wanted)
    // Second-level headings, in the order a person meets them.
    const level2 = MISSIONS.split('\n')
      .filter((l) => /^## /.test(l))
      .map((l) => l.slice(3).trim())
    expect(level2.indexOf('The pane')).toBeGreaterThan(-1)
    expect(level2.indexOf('The pane')).toBeLessThan(level2.indexOf('Acceptance criteria'))
    expect(level2.indexOf('Acceptance criteria')).toBeLessThan(level2.indexOf('Hand-off'))
    expect(level2.indexOf('Hand-off')).toBeLessThan(level2.indexOf('Records from earlier versions'))

    // The agent-control page links to it, and has no campaign, steward or merge-batch section.
    expect(AGENT_CONTROL).toMatch(/\]\(missions\.md(#[a-z0-9-]+)?\)/)
    for (const heading of headings(AGENT_CONTROL))
      expect(heading, `agent-control.md heading "${heading}"`).not.toMatch(
        /campaign|steward|merge[ -]batch/i
      )
    expect(AGENT_CONTROL).not.toMatch(/merge[ -]batch|Merge \{?n\}? in order/i)

    // The roadmap page says a card can be a step.
    expect(ROADMAP).toMatch(/a card can be a step/i)
    expect(ROADMAP).toMatch(/Dispatch/)
  })

  it('the missions page says what is true after the cut-over', () => {
    const flat = MISSIONS.replace(/\s+/g, ' ')
    // Every record opens in the pane; the popover is gone from what a person is told.
    expect(flat).not.toMatch(/keep(s)? (their|its|own) pill and (their|its) popover/i)
    expect(flat).not.toMatch(/opens the popover/i)
    expect(flat).not.toMatch(/still a v3 mission/i)
    expect(flat).not.toMatch(/cannot yet create a (version 4|v4) mission/i)
    // The old record is shown through a converted view; the first door use writes a v4 copy.
    expect(flat).toMatch(/version 3/)
    expect(flat).toMatch(/copy/i)
    expect(flat).toMatch(/never (changes|touches|rewrites)|byte/i)
    // A session that leads several missions, and an unreadable file.
    expect(flat).toMatch(/This session leads \d+ missions|leads (several|more than one)/i)
    expect(flat).toMatch(/can't be read|cannot be read/i)
    // The hand-off belongs to the operator.
    expect(flat).toMatch(/Continue in a new session/)
  })

  it('no user page uses a retired phrase or points at a button that does not exist', () => {
    for (const file of readdirSync(USER).filter((f) => f.endsWith('.md'))) {
      const text = read(file)
      for (const phrase of [
        'campaign map',
        'merge batch',
        'Mission popover',
        'Campaign popover',
        'Pause steward',
        'steward tick'
      ])
        expect(text, `${file}: "${phrase}"`).not.toContain(phrase)
    }
    // The v4 pane has no "Mark verified" button.
    for (const file of ['missions.md', 'agent-control.md'])
      expect(read(file), file).not.toContain('Mark verified')
  })
})
