/**
 * Missions v4 · S-10 · the card's three mission system fields (spec "A step is a board card when it
 * is dispatched": `roadmap-core.ts` gains `mission`, `milestone` and `step`, which `update_card`
 * refuses). Additive: a card without them reads and writes exactly as before.
 */
import { describe, expect, it } from 'vitest'
import {
  buildNewCardContent,
  CARD_CONTROLLED_FIELDS,
  CARD_EDITABLE_FIELDS,
  parseCard,
  planCardSet,
  updateFrontmatterFields
} from '../src/main/roadmap-core'

const PROVENANCE = { author: 'agent', at: '2026-11-14T10:00:00Z' } as const

describe('the mission fields are controlled', () => {
  it('update_card refuses mission, milestone and step with CONTROLLED_FIELD, not UNKNOWN_FIELD', () => {
    for (const field of ['mission', 'milestone', 'step']) {
      const plan = planCardSet({ set: { [field]: 'x' }, hasSession: false, isClosed: false })
      expect(plan).toEqual({ ok: false, code: 'CONTROLLED_FIELD', fields: [field] })
    }
  })

  it('names every refused field when a call mixes them with an editable one', () => {
    const plan = planCardSet({
      set: { title: 'New', mission: 'mnt-0000abcd', step: 'stp-1' },
      hasSession: false,
      isClosed: false
    })
    expect(plan).toEqual({ ok: false, code: 'CONTROLLED_FIELD', fields: ['mission', 'step'] })
  })

  it('keeps the fields out of the editable list and keeps the old controlled ones', () => {
    for (const field of ['mission', 'milestone', 'step']) {
      expect(CARD_CONTROLLED_FIELDS).toContain(field)
      expect(CARD_EDITABLE_FIELDS as readonly string[]).not.toContain(field)
    }
    for (const field of ['status', 'session', 'executedIn', 'approved', 'approvedBodyHash']) {
      expect(CARD_CONTROLLED_FIELDS).toContain(field)
    }
  })

  it('still reports a made-up field as UNKNOWN_FIELD', () => {
    const plan = planCardSet({ set: { madeUpField: 'x' }, hasSession: false, isClosed: false })
    expect(plan).toEqual({ ok: false, code: 'UNKNOWN_FIELD', fields: ['madeUpField'] })
  })
})

describe('the mission fields round-trip through the file', () => {
  it('a new card carries them when given and parseCard reads them back', () => {
    const content = buildNewCardContent({
      slug: 'T1-load-test-files',
      id: 'T1',
      title: 'Load the test files',
      body: 'Body.',
      provenance: PROVENANCE,
      mission: 'mnt-0a1b2c3d',
      milestone: 'mls-2',
      step: 'stp-5'
    })
    const card = parseCard(content, 'T1-load-test-files')
    expect(card.mission).toBe('mnt-0a1b2c3d')
    expect(card.milestone).toBe('mls-2')
    expect(card.step).toBe('stp-5')
    expect(card.status).toBe('backlog')
  })

  it('a card with no mission has none of the three, and its file has no such line', () => {
    const content = buildNewCardContent({
      slug: 'T2-plain',
      id: 'T2',
      title: 'Plain',
      body: 'Body.',
      provenance: PROVENANCE
    })
    const card = parseCard(content, 'T2-plain')
    expect(card.mission).toBeUndefined()
    expect(card.milestone).toBeUndefined()
    expect(card.step).toBeUndefined()
    expect(content).not.toMatch(/^(mission|milestone|step):/m)
  })

  it('a mission without milestones writes no milestone line', () => {
    const content = buildNewCardContent({
      slug: 'T3-no-milestone',
      id: 'T3',
      title: 'No milestone',
      body: 'Body.',
      provenance: PROVENANCE,
      mission: 'mnt-0a1b2c3d',
      step: 'stp-1'
    })
    expect(content).not.toMatch(/^milestone:/m)
    expect(parseCard(content, 'T3-no-milestone').milestone).toBeUndefined()
  })

  it('a hand-written blank or null value reads as absent, never a throw', () => {
    const content = '---\nid: T4\ntitle: T\nstatus: backlog\nmission: null\nstep:\n---\nBody\n'
    const card = parseCard(content, 'T4')
    expect(card.mission).toBeUndefined()
    expect(card.step).toBeUndefined()
  })

  it('stamping the fields on an existing card leaves its other lines and its body untouched', () => {
    const original = buildNewCardContent({
      slug: 'T5-existing',
      id: 'T5',
      title: 'Existing',
      body: 'Keep this body.',
      provenance: PROVENANCE
    })
    const stamped = updateFrontmatterFields(original, {
      mission: 'mnt-0a1b2c3d',
      milestone: 'mls-1',
      step: 'stp-2'
    })
    const card = parseCard(stamped, 'T5-existing')
    expect(card.step).toBe('stp-2')
    expect(card.provenance.author).toBe('agent')
    expect(card.body).toContain('Keep this body.')
  })
})
