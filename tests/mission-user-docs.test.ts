/**
 * Missions v4, S-36 (AC-85): the user guide describes missions on one page.
 *
 * `docs/user/missions.md` is the page: its headings are the ones a person looks for (the dropdown,
 * the acceptance criteria, the records written by earlier versions). The agent-control
 * page points at it and no longer carries a campaign, a steward or a merge-batch section, and the
 * roadmap page says a card can be a step. Since Mission dropdown S-7 (AC-25) the page describes the dropdown the
 * Topbar pill opens and no pane.
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
  it('the guide describes the dropdown', () => {
    const h = headings(MISSIONS)
    for (const wanted of [
      'The dropdown',
      'The pill',
      'Opening the dropdown',
      'What the dropdown shows',
      'Your next step',
      'The tree',
      'An open step',
      'A session with no mission',
      'Closing a mission',
      'A sample mission',
      'Acceptance criteria',
      'Records from earlier versions'
    ])
      expect(h, `a "${wanted}" heading on missions.md`).toContain(wanted)
    // Second-level headings, in the order a person meets them.
    const level2 = MISSIONS.split('\n')
      .filter((l) => /^## /.test(l))
      .map((l) => l.slice(3).trim())
    expect(level2.indexOf('The dropdown')).toBeGreaterThan(-1)
    expect(level2.indexOf('The dropdown')).toBeLessThan(level2.indexOf('Acceptance criteria'))
    expect(level2.indexOf('Acceptance criteria')).toBeLessThan(
      level2.indexOf('Records from earlier versions')
    )

    // No pane: not a heading, not a sentence, and the hand-off the pane carried is gone with it.
    expect(h).not.toContain('The pane')
    expect(h).not.toContain('Hand-off')
    const flat = MISSIONS.replace(/\s+/g, ' ')
    expect(flat).not.toMatch(/Mission pane|The pane|the pane|helper stack, next to your session/)
    expect(flat).not.toMatch(/Continue in a new session|The Sessions line/)
    // What the pill and the dropdown do, in the words of the screen.
    expect(flat).toMatch(/No mission/)
    expect(flat).toMatch(/Esc puts the focus back on the pill/)
    expect(flat).toMatch(/leaves the Topbar and cannot be reopened/)
    expect(flat).toMatch(/How to close it/)

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
    // Every record opens in the dropdown; the popover is gone from what a person is told.
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
    // The dropdown draws no hand-off: the page says so rather than pointing at a button that is not there.
    expect(flat).toMatch(/no button to hand it to a new session/)
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
    // The v4 dropdown has no "Mark verified" button.
    for (const file of ['missions.md', 'agent-control.md'])
      expect(read(file), file).not.toContain('Mark verified')
  })

  it('the missions page says the pill, the chip and the dropdown show one mission (S-35 delta 1)', () => {
    const flat = MISSIONS.replace(/\s+/g, ' ')
    expect(flat).toMatch(/pill, the (sidebar )?chip and the dropdown always show the same mission/)
    expect(flat).toMatch(/waiting on you[^.]*(else|and when none is)[^.]*changed last/i)
    expect(flat).toMatch(/mission you chose in the dropdown wins/i)
    expect(flat).toMatch(/leads the mission it names/i)
    expect(flat).toMatch(/Close the mission/)
    // When the leader's session is not loaded, the click shows a notice that names the mission (S-37).
    expect(flat).toMatch(/Can’t open “\{title\}” from here/)
    expect(flat).toMatch(
      /Its owner session isn’t open in this window\. Open that session, then use its Mission pill/
    )
    expect(flat).not.toMatch(/older Missions review/i)
  })

  it("the missions page says only what main's code does (S-36 delta 2)", () => {
    const flat = MISSIONS.replace(/\s+/g, ' ')
    // The real ask of a mission that is ready to close, not the sample mission's.
    expect(flat).toMatch(/Close the mission: every step is done/)
    expect(flat).toMatch(/Close the mission: the session says it is ready/)
    expect(flat).not.toMatch(/Everything is done\. Look it over/)
    // The next-step card is one card: a Done when to approve and a request to join each have their own buttons.
    expect(flat).toMatch(/\*\*Approve\*\* and \*\*Decline\*\*/)
    expect(flat).toMatch(/\*\*Allow\*\* and \*\*Deny\*\*/)
    // A session that only works on several missions gets the newest written, not the one waiting on you.
    expect(flat).toMatch(/only works on several missions[^.]*changed last, whatever waits on you/)
    // A delivery plan gets a new id; a single mission keeps its own.
    expect(flat).toMatch(/delivery plan becomes one new mission with a new id/)
    expect(flat).not.toMatch(/with the same id/)
    // Activity, as head does it (S-37): every mission waiting gets its own row; the review that took the rest is gone.
    expect(flat).toMatch(/Every mission that waits on you gets its own row, however many/)
    expect(flat).not.toMatch(/Review all/)
  })
})
