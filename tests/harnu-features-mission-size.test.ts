/**
 * Missions v4, S-36 (AC-84; AC-77's awareness-doc clause): the awareness doc's mission text.
 *
 * `docs/harnu-features.md` is prepended to every session's system prompt, so every word of it is paid
 * on every turn of every session. v3 grew its mission, campaign and steward text to about 9,700 words;
 * v4 replaces all of it with ONE section, `## Missions`, of at most 2,000 words.
 *
 * **How this test separates the mission text from the verb index.** The section is cut from the
 * `## Missions` heading to the next `## ` heading. The verb index (the paragraph from "The core verbs
 * are available from the first turn:" to "Resources:", which `harnu-features-verb-roster.test.ts`
 * requires to name every catalog verb, campaign verbs included until they leave the catalog) sits in the
 * `**MCP verbs (when enabled).**` paragraph near the top of the file, outside the section, so it is
 * neither counted in the 2,000 words nor held to the wording rules.
 *
 * Planted faults (each makes the named assertion red): add "steward" or "merge batch" to the section;
 * add a `(S-26)` or `(BUG-253)` tag to it; pad it past 2,000 words; put back "operator blocker, not a
 * handoff"; drop the `## Missions` heading.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const DOC = readFileSync(join(__dirname, '..', 'docs', 'harnu-features.md'), 'utf8')

const INDEX_START = 'The core verbs are available from the first turn:'
const INDEX_END = 'Resources:'

/** The sixteen verbs of the v4 model (the spec's fate table). */
const V4_VERBS = [
  'mission_create',
  'mission_get',
  'mission_list',
  'mission_add_milestone',
  'mission_add_step',
  'mission_update_step',
  'mission_add_ac',
  'mission_link',
  'mission_log',
  'mission_set_blocker',
  'mission_clear_blocker',
  'mission_set_done_when',
  'mission_settle_ac',
  'mission_request_close',
  'mission_attach',
  'rebase_stack'
]

/** From the `## Missions` heading to the next `## ` heading (or the end of the file). */
function missionSection(doc: string): string {
  const lines = doc.split('\n')
  const start = lines.findIndex((l) => /^## Missions\s*$/.test(l))
  if (start === -1) return ''
  const end = lines.findIndex((l, i) => i > start && /^## /.test(l))
  return lines.slice(start, end === -1 ? undefined : end).join('\n')
}

const words = (text: string): number => text.split(/\s+/).filter(Boolean).length

/** The doc without its verb index, for the checks that apply to the prose only. */
function withoutIndex(doc: string): string {
  const start = doc.indexOf(INDEX_START)
  const end = doc.indexOf(INDEX_END, start)
  return start === -1 || end === -1 ? doc : doc.slice(0, start) + doc.slice(end)
}

describe('the awareness doc mission text (AC-84)', () => {
  it('mission text stays short', () => {
    // The marker was v145 on the base; this slice bumps it.
    const marker = /^<!-- harnu-features v(\d+) \((\d{4}-\d{2}-\d{2})\) -->/.exec(DOC)
    expect(marker, 'the first line is the version marker').not.toBeNull()
    expect(Number(marker![1])).toBeGreaterThanOrEqual(146)

    // One section, exactly one heading of that name.
    expect(DOC.split('\n').filter((l) => /^## Missions\s*$/.test(l))).toHaveLength(1)
    const section = missionSection(DOC)
    expect(section, 'a `## Missions` section').not.toBe('')
    expect(words(section)).toBeLessThanOrEqual(2000)
    // Not a stub either: it carries the whole model, so a section that lost its content is also red.
    expect(words(section)).toBeGreaterThan(900)

    // No campaign, steward, merge-batch or lineage-tag wording in the section.
    expect(section).not.toMatch(/campaign/i)
    expect(section).not.toMatch(/steward/i)
    expect(section).not.toMatch(/merge[ -]batch/i)
    // Lineage tags: the slice, bug, task, decision and chapter labels the v3 text carried.
    expect(section).not.toMatch(/\b(S-\d+|BUG-\d+|T\d{3,}|C\d-\d+|D-\d+|ch\.\s?\d+)\b/)
    expect(section).not.toMatch(/Missions v4/)

    // The hand-off is the operator's, and the leader never switches itself (AC-77, decision 17).
    const flat = section.replace(/\s+/g, ' ')
    expect(flat).toMatch(/hand-off/i)
    expect(flat).toMatch(
      /only the operator (starts|decides)[^.]*hand-off|hand-off[^.]*(is|belongs to) the operator/i
    )
    expect(flat).toMatch(/never switch (yourself|itself)|never switches itself/i)
    expect(flat).not.toMatch(/operator blocker, not a hand-?off/i)

    // Decision 11: an ordinary session's id is a claim, and the kind of caller comes from the transport.
    expect(flat).toMatch(/self-declared/i)
    expect(flat).toMatch(/nothing authenticates/i)
    expect(flat).toMatch(/transport/i)
  })

  it('the section names the sixteen v4 verbs and none the v4 model removed', () => {
    const section = missionSection(DOC)
    // A verb is named bare or with its arguments: `mission_link` or `mission_link({ … })`.
    for (const verb of V4_VERBS) expect(section, verb).toMatch(new RegExp(`\`${verb}[\`({]`))
    // The v3-only verbs are in the verb index until the catalog drops them, never in the mission text.
    for (const verb of [
      'mission_link_child',
      'mission_verify_step',
      'mission_add_check',
      'mission_set_end',
      'mission_transfer_owner',
      'mission_import_legacy'
    ])
      expect(section, verb).not.toContain(verb)
  })

  it('the section carries the proactive rule, the writing contract and the dispatch binding', () => {
    const flat = missionSection(DOC).replace(/\s+/g, ' ')
    expect(flat).toMatch(/without asking/i)
    expect(flat).toContain('`missionHint`')
    // The contract is a table with its caps.
    expect(missionSection(DOC)).toMatch(/^\|.*Rule.*\|/m)
    for (const cap of ['60', '45', '50', '90', '70']) expect(flat, `the cap ${cap}`).toContain(cap)
    // Scoped roles and the dispatch binding.
    expect(flat).toMatch(/worker/)
    expect(flat).toMatch(/verifier/)
    expect(flat).toMatch(/observer/)
    expect(flat).toMatch(/SCOPE_STEP/)
    expect(flat).toMatch(/`card`/)
  })

  it('the verb index is outside the section', () => {
    const start = DOC.indexOf(INDEX_START)
    expect(start).toBeGreaterThan(-1)
    const section = missionSection(DOC)
    expect(section).not.toContain(INDEX_START)
    expect(DOC.indexOf(section)).toBeGreaterThan(start)
  })
})

describe('the rest of the awareness doc agrees (AC-84, AC-97, S-36 carried findings)', () => {
  it('no retired phrase survives and no verb is named that the model does not have', () => {
    const prose = withoutIndex(DOC)
    for (const phrase of [
      'campaign map',
      'merge batch',
      'Mission popover',
      'Campaign popover',
      'Pause steward',
      'steward tick'
    ])
      expect(prose, phrase).not.toContain(phrase)
    // A campaign verb or a v3-only verb is named only in the index (until S-39 and S-40 remove it).
    expect(prose).not.toMatch(/`campaign_[a-z_]+`/)
    expect(prose).not.toMatch(
      /`mission_(link_child|verify_step|add_check|set_end|transfer_owner|import_legacy)`/
    )
  })

  it('the awareness doc no longer sends the operator to a "Mark verified" button', () => {
    // The v4 pane has no such button: an "Approve spec" criterion is settled with Mark done.
    expect(DOC).not.toContain('Mark verified')
  })

  it('the bundled-skills text speaks v4', () => {
    const start = DOC.indexOf('**Bundled skills — OFF until switched on.**')
    const end = DOC.indexOf('**Nothing is on by default**', start)
    expect(start).toBeGreaterThan(-1)
    const part = DOC.slice(start, end).replace(/\s+/g, ' ')
    expect(part).not.toMatch(/speak Mission v3|campaign_create|Ch\. N\/M|delivery map/i)
    expect(part).not.toMatch(/operator blocker, not a hand-?off/i)
  })

  it("the section says only what main's code does (S-36 delta 2)", () => {
    const flat = missionSection(DOC).replace(/\s+/g, ' ')
    // `mission_create` makes a new mission; it never converts a record.
    expect(flat).toContain('`mission_create` never converts')
    expect(flat).not.toMatch(/`mission_create` or `mission_add_step` carrying/)
    // A delivery plan gets a new id; a single mission keeps its own.
    expect(flat).not.toMatch(/under the same id/)
    expect(flat).toMatch(/new `mnt-` id/)
    // `clearsWhen` ends a step blocker only.
    expect(flat).toMatch(/`clearsWhen`[^|]*ends a step blocker/)
    // A state word is refused only as a whole title; an internal word anywhere.
    expect(flat).not.toMatch(/No internal or state word in a title, ask or criterion/)
    expect(flat).toMatch(/a title is never only a state word/)
  })
})
