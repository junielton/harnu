/**
 * Missions v4 S-10 (AC-28, AC-29) — a dispatched step is a board card.
 *
 * A step has a board card only when it is dispatched to its own session or worktree. Dispatching it
 * creates the card (in `backlog`) or binds the card the step already has, stamps `mission`,
 * `milestone` and `step` on it, and writes the step's criteria into the card body as ONE marked block
 * (`<!-- mission:begin stp-n -->` … `<!-- mission:end -->`) that only Harnu rewrites. A step the
 * leading session does itself has no card, so the two trackers never track the same work twice.
 *
 * The criteria live on the step in the mission file (the single source); the block is a copy an
 * executor reading the card can see. The card's column is an INPUT to the step's state: this module
 * reports it as a plain value ({@link stepCardColumn}) and maps it to no state (S-7 owns the rule).
 * Harnu never moves a card to `done`: the operator closing a card is the only way a card gets there,
 * and nothing in this module can write it ({@link moveStepCard} refuses it).
 *
 * Pure: it reads and writes no file. The shell hands in the cards on the board as `{ slug, content }`
 * and writes back the `content` of the plan it gets. Electron-free.
 */

import {
  buildNewCardContent,
  isCardMoveTarget,
  mintNextCardId,
  parseCard,
  planCardMove,
  replaceCardBody,
  resolveUniqueSlug,
  slugifyTitle,
  updateFrontmatterFields,
  type CardSubstrate,
  type ColumnKey,
  type RoadmapCard
} from '../roadmap-core'
import type { AcceptanceCriterion, StepV4 } from './model'

// ---- The marked block ----------------------------------------------------------

/** The line that closes the block. It is the same for every step. */
export const MISSION_BLOCK_END = '<!-- mission:end -->'

/** The line that opens the block of one step. */
export function missionBlockBegin(stepId: string): string {
  return `<!-- mission:begin ${stepId} -->`
}

/** Every block, whatever step it names, lazily up to the first end marker. */
const BLOCK_RE = /<!-- mission:begin (stp-\d+) -->[\s\S]*?<!-- mission:end -->\n?/g

/** A comment marker inside a criterion's text would close or open a block: break it. */
function defang(text: string): string {
  return text.replace(/\s+/g, ' ').trim().replace(/<!--/g, '<!- -').replace(/-->/g, '- ->')
}

/** The block for one step: the markers around its criteria, one per line, in order. */
export function renderMissionBlock(
  stepId: string,
  acs: readonly Pick<AcceptanceCriterion, 'id' | 'text'>[]
): string {
  const lines = [
    missionBlockBegin(stepId),
    'Acceptance criteria. Harnu writes this block from the mission: change the criteria there.',
    ...acs.map((ac) => `- ${ac.id} · ${defang(ac.text)}`),
    MISSION_BLOCK_END
  ]
  return lines.join('\n')
}

/** What a card's block holds: the step it names, its text between the markers, and the whole block. */
export interface MissionBlock {
  stepId: string
  text: string
  raw: string
}

/** The first mission block in a card file, or null when it has none. */
export function extractMissionBlock(content: string): MissionBlock | null {
  const body = parseCard(content, '').body
  const m = new RegExp(BLOCK_RE.source).exec(body)
  if (!m) return null
  const raw = m[0].replace(/\n$/, '')
  const text = raw.slice(missionBlockBegin(m[1]).length, -MISSION_BLOCK_END.length).trim()
  return { stepId: m[1], text, raw }
}

/**
 * Put the step's block into a card file: replace the block in place (every block it finds collapses to
 * the one), or append it when there is none. The rest of the body and the whole frontmatter are
 * untouched, so the card's status never changes here.
 */
export function writeMissionBlock(
  content: string,
  stepId: string,
  acs: readonly Pick<AcceptanceCriterion, 'id' | 'text'>[]
): string {
  const block = renderMissionBlock(stepId, acs)
  const body = parseCard(content, '').body
  const matches = [...body.matchAll(BLOCK_RE)]
  let next: string
  if (matches.length === 0) {
    next = `${body.trimEnd()}\n\n${block}`
  } else {
    let first = true
    next = body.replace(BLOCK_RE, () => {
      if (!first) return ''
      first = false
      return `${block}\n`
    })
  }
  return replaceCardBody(content, next)
}

// ---- Finding and reading the step's card ----------------------------------------

/** A card as the shell reads it off the board: its slug and its whole file. */
export interface CardFile {
  slug: string
  content: string
}

/** The step a card is looked up for. */
export interface StepRef {
  missionId: string
  stepId: string
}

/** Whether a card carries this step's stamp. */
function isStampedFor(card: RoadmapCard, ref: StepRef): boolean {
  return card.mission === ref.missionId && card.step === ref.stepId
}

/** A card file by the name a step records: its slug or its id. */
function byName(cards: readonly CardFile[], name: string): CardFile | undefined {
  const bySlug = cards.find((c) => c.slug === name)
  if (bySlug) return bySlug
  return cards.find((c) => parseCard(c.content, c.slug).id === name)
}

/** The card stamped for this step, if the board has one. */
export function findStepCard(cards: readonly CardFile[], ref: StepRef): CardFile | undefined {
  return cards.find((c) => isStampedFor(parseCard(c.content, c.slug), ref))
}

/**
 * The card's column as a plain value, the input S-7's state rule reads. `undefined` when the step has
 * no card, the card belongs to another step, or the file does not parse: those read as "no card".
 */
export function stepCardColumn(card: RoadmapCard | undefined, ref: StepRef): ColumnKey | undefined {
  if (!card || card.malformed || !isStampedFor(card, ref)) return undefined
  return card.column
}

// ---- Dispatching a step ---------------------------------------------------------

/** Where a step goes when it is handed to work of its own. `internal` is the leader's own subagents. */
export interface StepDispatch {
  to: Extract<CardSubstrate, 'session' | 'worktree' | 'teammate' | 'internal'>
}

export interface PlanStepCardInput {
  missionId: string
  step: StepV4
  /** How the step is being dispatched; `null` when the leading session does it itself. */
  dispatch: StepDispatch | null
  /** Every card on the board, for the next id and for finding a card the step already has. */
  cards: readonly CardFile[]
  provenance: { at: string; branch?: string }
}

export type StepCardPlan =
  /** The step has no card: it is not dispatched to work of its own. Nothing to write. */
  | { action: 'none'; reason: 'leader-does-it' | 'not-dispatched' }
  /** A new card: write `content` to `<slug>.md`. */
  | { action: 'create'; slug: string; id: string; content: string }
  /** The step already has a card: write `content` over `<slug>.md`. Its column is untouched. */
  | { action: 'bind'; slug: string; content: string }
  | { action: 'refused'; code: 'CARD_NOT_FOUND' | 'CARD_BOUND_ELSEWHERE'; message: string }

/** Dispatch targets that are work of the step's own: a session or a worktree of its own. */
function hasOwnWork(dispatch: StepDispatch): boolean {
  return dispatch.to !== 'internal'
}

/** The fields a card carries for its step: `milestone` is removed when the step has none. */
function stepStamp(missionId: string, step: StepV4): Record<string, string | null> {
  return { mission: missionId, milestone: step.milestone ?? null, step: step.id }
}

/**
 * Decide what dispatching a step does to the board. A dispatch to a session or worktree of its own
 * creates the step's card in `backlog`, or binds the card the step already has (named in `step.card`
 * or stamped for it), never both and never a second one. A step the leader does itself, or one handed
 * to no work of its own, gets no card. Binding refuses a card that belongs to another step.
 */
export function planStepCard(input: PlanStepCardInput): StepCardPlan {
  const { missionId, step, dispatch, cards } = input
  if (dispatch === null) return { action: 'none', reason: 'leader-does-it' }
  if (!hasOwnWork(dispatch)) return { action: 'none', reason: 'not-dispatched' }

  const ref: StepRef = { missionId, stepId: step.id }
  const named = step.card ? byName(cards, step.card) : undefined
  if (step.card && !named) {
    return {
      action: 'refused',
      code: 'CARD_NOT_FOUND',
      message: `The step names the card ${step.card}, and the board has no such card.`
    }
  }
  const existing = named ?? findStepCard(cards, ref)

  if (existing) {
    const card = parseCard(existing.content, existing.slug)
    const taken = card.step !== undefined && !isStampedFor(card, ref)
    const takenByOtherMission = card.mission !== undefined && card.mission !== missionId
    if (taken || takenByOtherMission) {
      return {
        action: 'refused',
        code: 'CARD_BOUND_ELSEWHERE',
        message:
          `The card ${existing.slug} is already the work of ${card.mission ?? '?'} ${card.step ?? ''}.`.trim()
      }
    }
    const stamped = updateFrontmatterFields(existing.content, stepStamp(missionId, step))
    return {
      action: 'bind',
      slug: existing.slug,
      content: writeMissionBlock(stamped, step.id, step.acs)
    }
  }

  const id = mintNextCardId(
    cards.map((c) => parseCard(c.content, c.slug).id),
    'feature'
  )
  const slug = resolveUniqueSlug(
    `${id}-${slugifyTitle(step.title)}`,
    new Set(cards.map((c) => c.slug))
  )
  const content = buildNewCardContent({
    slug,
    id,
    title: step.title,
    body: `Dispatched step ${step.id} of mission ${missionId}.`,
    kind: 'feature',
    substrate: dispatch.to,
    mission: missionId,
    ...(step.milestone ? { milestone: step.milestone } : {}),
    step: step.id,
    provenance: { author: 'agent', at: input.provenance.at, branch: input.provenance.branch }
  })
  return { action: 'create', slug, id, content: writeMissionBlock(content, step.id, step.acs) }
}

// ---- Moving a step's card -------------------------------------------------------

export type StepCardMove =
  | { ok: true; content: string }
  | { ok: false; code: 'CARD_CLOSE_IS_THE_OPERATORS' | 'CARD_CLOSED' | 'BAD_TARGET' }

/**
 * Move a step's card to `backlog`, `ready` or `review`, and nothing else. `done` is refused by name:
 * closing a card is the operator's door and Harnu never does it. `in-progress` is refused too, because
 * only a real dispatch puts a card there. A card the operator already closed stays closed.
 */
export function moveStepCard(content: string, to: string): StepCardMove {
  if (to === 'done') return { ok: false, code: 'CARD_CLOSE_IS_THE_OPERATORS' }
  if (!isCardMoveTarget(to)) return { ok: false, code: 'BAD_TARGET' }
  const card = parseCard(content, '')
  if (planCardMove({ from: card.status, to }).ok === false)
    return { ok: false, code: 'CARD_CLOSED' }
  return { ok: true, content: updateFrontmatterFields(content, { status: to }) }
}
