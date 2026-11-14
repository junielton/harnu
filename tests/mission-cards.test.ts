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
import { StepSchema, type StepV4 } from '../src/main/missions/model'
import {
  MISSION_BLOCK_END,
  extractMissionBlock,
  findStepCard,
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
 *  review as waiting for review, and the operator closing the card (done) reads as done. */
const AC_29_STATE: Record<ColumnKey, string> = {
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
      expect(AC_29_STATE[stepCardColumn(card, ref) as ColumnKey]).toBeTruthy()
    }
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

  it('a card the operator closed stays closed: no move, no status change by create, bind or block rewrite', () => {
    const closed = cardFile('T1-card', 'done', stamp)
    expect(moveStepCard(closed.content, 'backlog').ok).toBe(false)
    const rewritten = writeMissionBlock(closed.content, 'stp-5', step().acs)
    expect(parseCard(rewritten, 'T1-card').status).toBe('done')
    const bound = plan({ step: step({ card: 'T1-card' }) }, [closed])
    expect(bound.action).toBe('bind')
    if (bound.action === 'bind') expect(parseCard(bound.content, bound.slug).status).toBe('done')
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
