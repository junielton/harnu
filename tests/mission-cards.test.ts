/**
 * Missions v4 · S-10 · AC-28 and AC-29 — a dispatched step is a board card.
 *
 * `src/main/missions/cards.ts` is the pure half: it decides whether a step has a card, builds or binds
 * that card, writes the step's criteria into it as one marked block that only Harnu rewrites, and
 * reports the card's column as a plain value. It reads and writes no file. S-7 owns the state rule, so
 * AC-29's mapping is written below as a table taken from the AC's own text, never imported.
 */
import { describe, expect, it } from 'vitest'
import {
  COLUMN_ORDER,
  buildNewCardContent,
  parseCard,
  type ColumnKey,
  type RoadmapCard
} from '../src/main/roadmap-core'
import {
  MISSION_V4_ID_RE,
  STATE_LABELS,
  STEP_STATES,
  StepSchema,
  type StepState,
  type StepV4
} from '../src/main/missions/model'
import {
  MISSION_BLOCK_END,
  extractMissionBlock,
  findCardByName,
  findStepCard,
  indexStepCards,
  stepCardKey,
  moveStepCard,
  planStepCard,
  stepCardColumn,
  writeMissionBlock,
  type CardFile,
  type StepCardPlan
} from '../src/main/missions/cards'

const MISSION = 'mnt-0a1b2c3d'
const AT = '2026-11-14T10:00:00Z'

function step(over: Record<string, unknown> = {}): StepV4 {
  return StepSchema.parse({
    id: 'stp-5',
    milestone: 'mls-2',
    title: 'Load the test files',
    acs: [
      { id: 'ac-1', text: 'The pull request is merged', by: 'fact', fact: 'pr-merged' },
      { id: 'ac-2', text: 'Every reviewer question has an answer', by: 'session' }
    ],
    ...over
  })
}

function created(plan: StepCardPlan): { slug: string; id: string; content: string } {
  if (plan.action !== 'create') throw new Error(`expected create, got ${plan.action}`)
  return plan
}

function plan(over: Record<string, unknown> = {}, cards: CardFile[] = []): StepCardPlan {
  return planStepCard({
    missionId: MISSION,
    step: step(),
    dispatch: { to: 'worktree' },
    cards,
    provenance: { at: AT, branch: 'main' },
    ...over
  } as Parameters<typeof planStepCard>[0])
}

/** A card file at a given status, optionally stamped for a step. */
function cardFile(slug: string, status: string, stamp: Record<string, string> = {}): CardFile {
  const lines = [`---`, `id: ${slug.split('-')[0]}`, `title: ${slug}`, `status: ${status}`]
  for (const [k, v] of Object.entries(stamp)) lines.push(`${k}: ${v}`)
  lines.push('provenance:', '  author: agent', `  at: ${AT}`, '---', '', 'Existing body.', '')
  return { slug, content: lines.join('\n') }
}

describe('a dispatched step is a card with a marked block', () => {
  it('dispatching creates the card in backlog with mission, milestone and step fields', () => {
    const made = created(plan())
    const card = parseCard(made.content, made.slug)
    expect(card.status).toBe('backlog')
    expect(card.column).toBe('backlog')
    expect(card.mission).toBe(MISSION)
    expect(card.milestone).toBe('mls-2')
    expect(card.step).toBe('stp-5')
    expect(card.title).toBe('Load the test files')
    expect(card.substrate).toBe('worktree')
    expect(card.session).toBeUndefined()
    expect(card.provenance.author).toBe('agent')
  })

  it('writes the criteria into the card body as one marked block, in the criteria order', () => {
    const made = created(plan())
    const body = parseCard(made.content, made.slug).body
    expect(body.match(/<!-- mission:begin /g)).toHaveLength(1)
    expect(body.match(/<!-- mission:end -->/g)).toHaveLength(1)
    const block = extractMissionBlock(made.content)
    expect(block?.stepId).toBe('stp-5')
    expect(block?.text).toContain('The pull request is merged')
    expect(block?.text).toContain('Every reviewer question has an answer')
    expect(block!.text.indexOf('ac-1')).toBeLessThan(block!.text.indexOf('ac-2'))
    expect(body).toContain('<!-- mission:begin stp-5 -->')
    expect(body).toContain(MISSION_BLOCK_END)
  })

  it('a mission with no milestones stamps no milestone', () => {
    const made = created(plan({ step: step({ milestone: undefined }) }))
    const card = parseCard(made.content, made.slug)
    expect(card.milestone).toBeUndefined()
    expect(card.step).toBe('stp-5')
  })

  it('mints the next card id and a unique slug from the cards on the board', () => {
    const board = [cardFile('T41-older', 'done'), cardFile('T7-other', 'backlog')]
    const made = created(plan({}, board))
    expect(made.id).toBe('T42')
    expect(made.slug).toBe('T42-load-the-test-files')
    const clash = created(plan({}, [...board, cardFile('T42-load-the-test-files', 'done')]))
    expect(clash.slug).not.toBe('T42-load-the-test-files')
  })

  it('a step the leading session does itself has no card', () => {
    const result = plan({ dispatch: null })
    expect(result.action).toBe('none')
  })

  it('a step handed to no session or worktree of its own has no card either', () => {
    expect(plan({ dispatch: { to: 'internal' } }).action).toBe('none')
  })

  it('never tracks one step twice: a second dispatch binds the card the step already has', () => {
    const first = created(plan())
    const second = plan({}, [{ slug: first.slug, content: first.content }])
    expect(second.action).toBe('bind')
    if (second.action === 'bind') expect(second.slug).toBe(first.slug)
  })

  it('binds the card named in the step, stamping the fields and writing the block', () => {
    const existing = cardFile('T9-hand-made', 'ready')
    const result = plan({ step: step({ card: 'T9-hand-made' }) }, [existing])
    expect(result.action).toBe('bind')
    if (result.action !== 'bind') return
    const card = parseCard(result.content, result.slug)
    expect(card.mission).toBe(MISSION)
    expect(card.step).toBe('stp-5')
    expect(card.milestone).toBe('mls-2')
    expect(card.status).toBe('ready')
    expect(card.body).toContain('Existing body.')
    expect(extractMissionBlock(result.content)?.stepId).toBe('stp-5')
  })

  it('finds the step card by its stamp even when the step does not name it, and by id or slug', () => {
    const stamped = cardFile('T9-stamped', 'backlog', { mission: MISSION, step: 'stp-5' })
    expect(findStepCard([stamped], { missionId: MISSION, stepId: 'stp-5' })?.slug).toBe(
      'T9-stamped'
    )
    expect(findStepCard([stamped], { missionId: MISSION, stepId: 'stp-6' })).toBeUndefined()
    const byId = plan({ step: step({ card: 'T9' }) }, [cardFile('T9-stamped', 'backlog')])
    expect(byId.action).toBe('bind')
  })

  it('refuses to bind a card that already belongs to another step', () => {
    const other = cardFile('T9-taken', 'backlog', { mission: MISSION, step: 'stp-2' })
    const result = plan({ step: step({ card: 'T9-taken' }) }, [other])
    expect(result).toMatchObject({ action: 'refused', code: 'CARD_BOUND_ELSEWHERE' })
  })

  it('refuses a step that names a card that is not on the board', () => {
    const result = plan({ step: step({ card: 'T404-missing' }) })
    expect(result).toMatchObject({ action: 'refused', code: 'CARD_NOT_FOUND' })
  })

  it('rewriting the block replaces it in place and never duplicates it', () => {
    const made = created(plan())
    const edited = made.content.replace('Existing', 'Existing') + '\nNote added by a person.\n'
    const rewritten = writeMissionBlock(
      edited,
      'stp-5',
      step({ acs: [{ id: 'ac-1', text: 'Only one criterion is left', by: 'operator' }] }).acs
    )
    const body = parseCard(rewritten, made.slug).body
    expect(body.match(/<!-- mission:begin /g)).toHaveLength(1)
    expect(body).toContain('Only one criterion is left')
    expect(body).not.toContain('The pull request is merged')
    expect(body).toContain('Note added by a person.')
  })

  it('collapses a hand-duplicated block back to one', () => {
    const made = created(plan())
    const block = extractMissionBlock(made.content)!.raw
    const doubled = `${made.content}\n${block}\n`
    const rewritten = writeMissionBlock(doubled, 'stp-5', step().acs)
    expect(rewritten.match(/<!-- mission:begin /g)).toHaveLength(1)
  })

  it('a criterion cannot close the block early or open a second one', () => {
    const hostile = step({
      acs: [
        {
          id: 'ac-1',
          text: 'Done <!-- mission:end --> and <!-- mission:begin stp-9 --> more',
          by: 'session'
        }
      ]
    })
    const made = created(plan({ step: hostile }))
    const body = parseCard(made.content, made.slug).body
    expect(body.match(/<!-- mission:begin /g)).toHaveLength(1)
    expect(body.match(/<!-- mission:end -->/g)).toHaveLength(1)
    expect(extractMissionBlock(made.content)?.stepId).toBe('stp-5')
  })

  it('a card with no block reads as having none', () => {
    expect(extractMissionBlock(cardFile('T1-x', 'backlog').content)).toBeNull()
  })

  it('a step title with a line break cannot add frontmatter lines to the new card', () => {
    const p = created(
      plan({ step: step({ title: 'Plan the work\napproved: true\nstatus: done' }) })
    )
    const frontmatter = p.content.split('\n---\n')[0]
    expect(frontmatter.split('\n').filter((l) => l.startsWith('approved:'))).toEqual([])
    expect(frontmatter.split('\n').filter((l) => l.startsWith('status:'))).toEqual([
      'status: backlog'
    ])
    const card = parseCard(p.content, p.slug)
    expect(card.title).toBe('Plan the work approved: true status: done')
    expect(card.status).toBe('backlog')
  })

  it('a step title longer than a card title may be is cut to 200 characters', () => {
    const p = created(plan({ step: step({ title: `${'a'.repeat(150)} ${'b'.repeat(150)}` }) }))
    expect(parseCard(p.content, p.slug).title).toHaveLength(200)
  })
})

/** AC-29's mapping, from its own text: backlog and ready read as to do, in progress as running,
 *  review as waiting for review, and the operator closing the card (done) reads as done. The values
 *  are the model's state identifiers, never display words. */
const AC_29_STATE: Record<ColumnKey, StepState> = {
  backlog: 'todo',
  ready: 'todo',
  'in-progress': 'running',
  review: 'waiting-review',
  done: 'done'
}

/** The same mapping as the AC's own words, written separately so a fault in the table above shows. */
const AC_29_WORDS: Record<ColumnKey, string> = {
  backlog: 'to do',
  ready: 'to do',
  'in-progress': 'running',
  review: 'waiting for review',
  done: 'done'
}

describe('the card column is an input and Harnu never closes a card', () => {
  const ref = { missionId: MISSION, stepId: 'stp-5' }
  const stamp = { mission: MISSION, step: 'stp-5' }

  it('reports the card column as a plain value, for every column AC-29 names', () => {
    expect(Object.keys(AC_29_STATE).sort()).toEqual([...COLUMN_ORDER].sort())
    for (const column of COLUMN_ORDER) {
      const card = parseCard(cardFile('T1-card', column, stamp).content, 'T1-card')
      expect(stepCardColumn(card, ref)).toBe(column)
    }
  })

  it('AC-29 mapping table: every column names a model state, in the AC words', () => {
    for (const column of COLUMN_ORDER) {
      expect(STEP_STATES).toContain(AC_29_STATE[column])
      expect(STATE_LABELS[AC_29_STATE[column]]).toBe(AC_29_WORDS[column])
    }
    // Backlog and ready are the same state; every other column has a state of its own.
    expect(AC_29_STATE.backlog).toBe(AC_29_STATE.ready)
    expect(new Set(Object.values(AC_29_STATE)).size).toBe(4)
  })

  it('has no column for a step with no card, a card of another step, or a card that does not parse', () => {
    expect(stepCardColumn(undefined, ref)).toBeUndefined()
    const other = parseCard(
      cardFile('T1-c', 'review', { mission: MISSION, step: 'stp-9' }).content,
      'T1-c'
    )
    expect(stepCardColumn(other, ref)).toBeUndefined()
    const malformed: RoadmapCard = parseCard('no frontmatter here', 'T2-bad')
    expect(stepCardColumn(malformed, ref)).toBeUndefined()
  })

  it('a card moved by the operator is followed: the column is read fresh from the card', () => {
    const base = created(plan())
    const card = (status: string): RoadmapCard =>
      parseCard(base.content.replace('status: backlog', `status: ${status}`), base.slug)
    expect(stepCardColumn(card('in-progress'), ref)).toBe('in-progress')
    expect(stepCardColumn(card('done'), ref)).toBe('done')
  })

  it('moves a card only among backlog, ready and review, and writes nothing else', () => {
    const file = cardFile('T1-card', 'backlog', stamp)
    for (const to of ['ready', 'review', 'backlog']) {
      const moved = moveStepCard(file.content, to)
      expect(moved.ok).toBe(true)
      if (moved.ok) {
        expect(parseCard(moved.content, 'T1-card').status).toBe(to)
        expect(moved.content.replace(/^status: .*$/m, '')).toBe(
          file.content.replace(/^status: .*$/m, '')
        )
      }
    }
  })

  it('refuses a move to done, and a move to in-progress, and leaves the card as it was', () => {
    for (const from of ['backlog', 'ready', 'in-progress', 'review']) {
      const file = cardFile('T1-card', from, stamp)
      for (const to of ['done', 'in-progress', 'Done', 'closed', '']) {
        const moved = moveStepCard(file.content, to)
        expect(moved.ok).toBe(false)
      }
      expect(moveStepCard(file.content, 'done')).toEqual({
        ok: false,
        code: 'CARD_CLOSE_IS_THE_OPERATORS'
      })
    }
  })

  it('binding a card in progress or in review keeps its column and stamps it', () => {
    for (const status of ['in-progress', 'review']) {
      const result = plan({ step: step({ card: 'T9-live' }) }, [cardFile('T9-live', status)])
      expect(result.action).toBe('bind')
      if (result.action !== 'bind') continue
      const card = parseCard(result.content, result.slug)
      expect(card.status).toBe(status)
      expect(card.step).toBe('stp-5')
      expect(extractMissionBlock(result.content)?.stepId).toBe('stp-5')
    }
  })

  it('a card the operator closed stays closed: no move, no status change by a block rewrite, and no bind', () => {
    const closed = cardFile('T1-card', 'done', stamp)
    expect(moveStepCard(closed.content, 'backlog').ok).toBe(false)
    const rewritten = writeMissionBlock(closed.content, 'stp-5', step().acs)
    expect(parseCard(rewritten, 'T1-card').status).toBe('done')
    // A closed card is finished work: a step needs a card that can still move.
    const named = plan({ step: step({ card: 'T1-card' }) }, [closed])
    expect(named).toMatchObject({ action: 'refused', code: 'CARD_CLOSED' })
    // Found by its stamp rather than by name, it is refused too, and no second card is made.
    const stamped = plan({}, [closed])
    expect(stamped).toMatchObject({ action: 'refused', code: 'CARD_CLOSED' })
  })

  it('no path through the module ever writes status: done onto a card that was not already done', () => {
    const outputs: string[] = []
    for (const column of COLUMN_ORDER) {
      if (column === 'done') continue
      const file = cardFile('T1-card', column, stamp)
      outputs.push(writeMissionBlock(file.content, 'stp-5', step().acs))
      const bound = plan({ step: step({ card: 'T1-card' }) }, [file])
      if (bound.action === 'bind') outputs.push(bound.content)
      for (const to of ['backlog', 'ready', 'review', 'done', 'in-progress']) {
        const moved = moveStepCard(file.content, to)
        if (moved.ok) outputs.push(moved.content)
      }
    }
    outputs.push(created(plan()).content)
    expect(outputs.length).toBeGreaterThan(10)
    for (const content of outputs) {
      expect(parseCard(content, 'T1-card').status).not.toBe('done')
      expect(content).not.toMatch(/^status:\s*done\s*$/m)
    }
  })

  it('a card built for a dispatched step is born in backlog even when the board has done cards', () => {
    const done = buildNewCardContent({
      slug: 'T1-d',
      id: 'T1',
      title: 'd',
      body: 'x',
      provenance: { author: 'agent', at: AT }
    }).replace('status: backlog', 'status: done')
    const made = created(plan({}, [{ slug: 'T1-d', content: done }]))
    expect(parseCard(made.content, made.slug).status).toBe('backlog')
  })
})

describe('a card is never closed through a hostile id', () => {
  const hostile = `${MISSION}\nstatus: done`

  it('refuses a mission id that is not mnt-<8 hex>, on create', () => {
    const result = plan({ missionId: hostile })
    expect(result).toMatchObject({ action: 'refused', code: 'BAD_MISSION_ID' })
    for (const bad of [
      '',
      'mnt-xyz',
      'MNT-0a1b2c3d',
      ` ${MISSION}`,
      `${MISSION}\n`,
      `${MISSION}x`
    ]) {
      expect(MISSION_V4_ID_RE.test(bad)).toBe(false)
      expect(plan({ missionId: bad })).toMatchObject({ action: 'refused', code: 'BAD_MISSION_ID' })
    }
  })

  it('refuses it on bind too, and leaves the card as it was', () => {
    const existing = cardFile('T9-hand-made', 'ready')
    const result = plan({ missionId: hostile, step: step({ card: 'T9-hand-made' }) }, [existing])
    expect(result).toMatchObject({ action: 'refused', code: 'BAD_MISSION_ID' })
    expect('content' in result).toBe(false)
  })

  it('refuses a step id or milestone that is not an id, and a provenance that spans lines', () => {
    const badStep = plan({ step: step({ id: 'stp-5' }), missionId: MISSION })
    expect(badStep.action).toBe('create')
    const forged = { ...step(), id: 'stp-5\nstatus: done' } as StepV4
    expect(plan({ step: forged })).toMatchObject({ action: 'refused', code: 'BAD_INPUT' })
    const forgedMilestone = { ...step(), milestone: 'mls-1\nstatus: done' } as StepV4
    expect(plan({ step: forgedMilestone })).toMatchObject({ action: 'refused', code: 'BAD_INPUT' })
    expect(plan({ provenance: { at: AT, branch: 'main\nstatus: done' } })).toMatchObject({
      action: 'refused',
      code: 'BAD_INPUT'
    })
    expect(plan({ provenance: { at: `${AT}\nstatus: done` } })).toMatchObject({
      action: 'refused',
      code: 'BAD_INPUT'
    })
  })

  it('refuses a dispatch target that is not session, worktree, teammate or internal', () => {
    for (const to of ['worktree\nstatus: done', 'WORKTREE', '', 'shell', 'worktree ']) {
      expect(plan({ dispatch: { to } as never })).toMatchObject({
        action: 'refused',
        code: 'BAD_INPUT'
      })
    }
    for (const to of ['session', 'worktree', 'teammate']) {
      expect(plan({ dispatch: { to } as never }).action).toBe('create')
    }
    expect(plan({ dispatch: { to: 'internal' } }).action).toBe('none')
  })

  it('never yields a done card from any hostile id, on create or bind', () => {
    const existing = cardFile('T9-hand-made', 'ready')
    const outputs: StepCardPlan[] = [
      plan({ missionId: hostile }),
      plan({ missionId: hostile, step: step({ card: 'T9-hand-made' }) }, [existing]),
      plan({ step: { ...step(), id: 'stp-5\nstatus: done' } }),
      plan({ step: { ...step(), milestone: 'mls-1\nstatus: done' } }),
      plan({ dispatch: { to: 'worktree\nstatus: done' } as never }),
      plan({ dispatch: { to: 'worktree\nstatus: done' } as never }, [existing])
    ]
    for (const out of outputs) {
      expect(out.action).toBe('refused')
      if ('content' in out) expect(out.content).not.toMatch(/^status:\s*done\s*$/m)
    }
  })
})

describe('every reader finds the step card the way the planner does', () => {
  const stamped = (slug: string, stp: string, status = 'backlog'): CardFile =>
    cardFile(slug, status, { mission: MISSION, step: stp })

  it('findCardByName finds a card by slug or by id and by nothing else', () => {
    const cards = [cardFile('T9-first', 'backlog'), cardFile('T10-second', 'ready')]
    expect(findCardByName(cards, 'T9-first')?.slug).toBe('T9-first')
    expect(findCardByName(cards, 'T10')?.slug).toBe('T10-second')
    expect(findCardByName(cards, 'T1')).toBeUndefined()
    expect(findCardByName(cards, '')).toBeUndefined()
  })

  it('findCardByName answers what planStepCard binds', () => {
    const cards = [cardFile('T9-hand-made', 'ready')]
    const bound = plan({ step: step({ card: 'T9' }) }, cards)
    expect(bound.action).toBe('bind')
    if (bound.action === 'bind') expect(bound.slug).toBe(findCardByName(cards, 'T9')?.slug)
  })

  it('indexStepCards maps mission/step to the stamped card and leaves out the rest', () => {
    const cards = [
      stamped('T1-a', 'stp-1'),
      stamped('T2-b', 'stp-2', 'review'),
      cardFile('T3-plain', 'backlog'),
      cardFile('T4-half', 'backlog', { mission: MISSION })
    ]
    const index = indexStepCards(cards)
    expect([...index.keys()].sort()).toEqual(
      [
        stepCardKey({ missionId: MISSION, stepId: 'stp-1' }),
        stepCardKey({ missionId: MISSION, stepId: 'stp-2' })
      ].sort()
    )
    const entry = index.get(stepCardKey({ missionId: MISSION, stepId: 'stp-2' }))
    expect(entry?.file.slug).toBe('T2-b')
    expect(entry?.card.column).toBe('review')
    expect(index.get(stepCardKey({ missionId: MISSION, stepId: 'stp-9' }))).toBeUndefined()
  })

  it('indexStepCards agrees with findStepCard, the first card on the board winning a duplicate stamp', () => {
    const cards = [stamped('T1-first', 'stp-1'), stamped('T2-dup', 'stp-1')]
    const entry = indexStepCards(cards).get(stepCardKey({ missionId: MISSION, stepId: 'stp-1' }))
    expect(entry?.file.slug).toBe('T1-first')
    expect(entry?.file.slug).toBe(
      findStepCard(cards, { missionId: MISSION, stepId: 'stp-1' })?.slug
    )
  })

  it('indexStepCards reads each card once, however many steps are looked up', () => {
    let reads = 0
    const cards: CardFile[] = Array.from({ length: 50 }, (_, i) => {
      const file = stamped(`T${i + 1}-card`, `stp-${i + 1}`)
      return {
        slug: file.slug,
        get content(): string {
          reads++
          return file.content
        }
      }
    })
    const index = indexStepCards(cards)
    for (let i = 1; i <= 50; i++) {
      expect(index.get(stepCardKey({ missionId: MISSION, stepId: `stp-${i}` }))).toBeDefined()
    }
    expect(reads).toBe(50)
  })

  it('two missions sharing a step id each keep their own card in the index', () => {
    const other = 'mnt-ffffffff'
    const cards = [
      stamped('T1-mine', 'stp-1'),
      cardFile('T2-theirs', 'review', { mission: other, step: 'stp-1' })
    ]
    const index = indexStepCards(cards)
    expect(index.size).toBe(2)
    expect(index.get(stepCardKey({ missionId: MISSION, stepId: 'stp-1' }))?.file.slug).toBe(
      'T1-mine'
    )
    expect(index.get(stepCardKey({ missionId: other, stepId: 'stp-1' }))?.file.slug).toBe(
      'T2-theirs'
    )
    expect(findStepCard(cards, { missionId: other, stepId: 'stp-1' })?.slug).toBe('T2-theirs')
  })

  it('a malformed card file is left out of the index and never throws', () => {
    const cards = [{ slug: 'T5-bad', content: 'no frontmatter at all' }, stamped('T6-ok', 'stp-1')]
    expect(indexStepCards(cards).size).toBe(1)
  })
})
