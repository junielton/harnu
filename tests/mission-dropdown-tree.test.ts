// @vitest-environment jsdom
/**
 * Mission dropdown · S-3 · AC-4, AC-9, AC-10 — the tree: milestone ▸ step ▸ criteria as a keyboard
 * `role="tree"`, where only the current milestone is open, the owed steps come first, at most three running
 * steps show and the rest sit behind "{n} more steps" (design.md §6 "Mission dropdown" → "What it draws" 3
 * and "Keyboard and focus"; mockup `docs/design/mission-dropdown/`, state `mid`).
 *
 * jsdom has no layout engine, so the contract is read off the elements and the keys: which rows exist, their
 * `aria-expanded` and `tabindex`, and where focus goes. The tree reads the server's view and computes no state.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { i18n } from '../src/renderer/src/i18n'
import MissionDropdownTree from '../src/renderer/src/components/MissionDropdownTree.vue'
import {
  RUNNING_SHOWN,
  capRunning,
  treeKeyAction,
  type TreeRow
} from '../src/renderer/src/lib/mission-dropdown-tree'
import { buildPaneTree, type MissionV4Reply } from '../src/renderer/src/lib/mission-pane-view'

type Detail = MissionV4Reply['detail']
type StepState = 'todo' | 'running' | 'waiting-review' | 'done'
type MilestoneState = 'not-started' | 'in-progress' | 'waiting-review' | 'done'

interface StepSeed {
  id: string
  milestone?: string
  title: string
  state: StepState
  blocked?: boolean
  /** A pull request number: its link carries the address the view resolves. */
  pr?: number
  criteria?: Array<[string, boolean]>
  optional?: boolean
}
interface MilestoneSeed {
  id: string
  title: string
  state: MilestoneState
  optional?: boolean
}
interface Seed {
  milestones: MilestoneSeed[]
  steps: StepSeed[]
  current: string | null
  /** Steps the operator owes something on. */
  owed?: string[]
}

/** A detail the way the server builds one, with the counts it would derive (as `mission-pane-tree.test.ts`). */
function detailOf(seed: Seed): Detail {
  const optionalIds = new Set(seed.milestones.filter((m) => m.optional).map((m) => m.id))
  const isOptional = (s: StepSeed): boolean =>
    s.optional === true || (s.milestone !== undefined && optionalIds.has(s.milestone))
  const milestones = seed.milestones.map((m) => {
    const own = seed.steps.filter((s) => s.milestone === m.id && !isOptional(s))
    return {
      id: m.id,
      title: m.title,
      optional: m.optional === true,
      waitsFor: null,
      state: m.state,
      stateLabel: 'ZZZ server words',
      counts: {
        running: own.filter((s) => s.state === 'running').length,
        waitingReview: own.filter((s) => s.state === 'waiting-review').length,
        blocked: own.filter((s) => s.blocked === true).length
      }
    }
  })
  const steps = seed.steps.map((s) => ({
    id: s.id,
    title: s.title,
    milestone: s.milestone ?? null,
    optional: isOptional(s),
    state: s.state,
    stateLabel: 'ZZZ server words',
    blocked: s.blocked === true,
    card: null,
    startedAt: null,
    waitsFor: null,
    criteria: (s.criteria ?? []).map(([text, settled], i) => ({
      id: `ac-${i + 1}`,
      text,
      by: 'session' as const,
      settled,
      via: settled ? ('session' as const) : null
    })),
    open: [],
    blockers: [],
    links:
      s.pr !== undefined
        ? [{ kind: 'pr' as const, ref: `https://github.com/acme/web/pull/${s.pr}` }]
        : []
  }))
  const counted = steps.filter((s) => !s.optional)
  const unit = milestones.length > 0 ? 'milestones' : 'steps'
  const items = (seed.owed ?? []).map((stepId, i) => ({
    id: `w${i}`,
    kind: 'review' as const,
    stepIds: [stepId],
    ask: 'x',
    why: 'y'
  }))
  return {
    ok: true,
    id: 'mnt-tree',
    title: 'Collect partner listings every day',
    doneWhen: 'x',
    status: 'open',
    state: 'open',
    stateLabel: 'ZZZ',
    standing: 'operator',
    leads: null,
    source: 'v4',
    progress: {
      unit,
      total: unit === 'milestones' ? milestones.filter((m) => !m.optional).length : counted.length,
      done: 0,
      headline: 'ZZZ',
      current: seed.current === null ? null : { id: seed.current, ordinal: 1 },
      allDone: false,
      counts: { todo: 0, running: 0, waitingReview: 0, done: 0, blocked: 0 }
    },
    milestones,
    steps,
    next: items[0] ?? null,
    waiting: {
      items,
      next: items[0] ?? null,
      more: items.slice(1),
      moreLine: null,
      people: [],
      peopleLine: null,
      peopleLines: []
    },
    summary: '',
    links: [],
    blockers: [],
    sessions: []
  } as unknown as Detail
}

/** Three milestones; the second is the current one, with every kind of step the order has to place. */
const MID: Seed = {
  current: 'ms-2',
  owed: ['s-block', 's-review'],
  milestones: [
    { id: 'ms-1', title: 'Pick the sources', state: 'done' },
    { id: 'ms-2', title: 'A tool that scores a spec', state: 'in-progress' },
    { id: 'ms-3', title: 'Run it every day', state: 'not-started' }
  ],
  steps: [
    { id: 's-done-1', milestone: 'ms-1', title: 'List the sources', state: 'done' },
    { id: 's-todo', milestone: 'ms-2', title: 'Write the report page', state: 'todo' },
    { id: 's-run-1', milestone: 'ms-2', title: 'Score the first twelve specs', state: 'running' },
    {
      id: 's-block',
      milestone: 'ms-2',
      title: 'Add the scoring service key',
      state: 'waiting-review',
      blocked: true
    },
    {
      id: 's-review',
      milestone: 'ms-2',
      title: 'Look over the sign-in pull request',
      state: 'waiting-review',
      pr: 21,
      criteria: [
        ['Every reviewer question has an answer', true],
        ['The page opens on a phone', false]
      ]
    },
    { id: 's-run-2', milestone: 'ms-2', title: 'Score the second twelve specs', state: 'running' },
    { id: 's-run-3', milestone: 'ms-2', title: 'Score the third twelve specs', state: 'running' },
    { id: 's-run-4', milestone: 'ms-2', title: 'Score the fourth twelve specs', state: 'running' },
    { id: 's-run-5', milestone: 'ms-2', title: 'Score the fifth twelve specs', state: 'running' },
    { id: 's-done-2', milestone: 'ms-2', title: 'Pick the test set', state: 'done' },
    { id: 's-todo-3', milestone: 'ms-3', title: 'Schedule the run', state: 'todo' }
  ]
}

let wrapper: VueWrapper | null = null
const openExternal = vi.fn(async () => undefined)

function mountTree(
  seed: Seed,
  props: { askLeader?: string | null } = {}
): { w: VueWrapper; detail: Detail } {
  i18n.global.locale.value = 'en'
  const detail = detailOf(seed)
  wrapper = mount(MissionDropdownTree, {
    props: { detail, askLeader: props.askLeader ?? null },
    global: { plugins: [i18n] },
    attachTo: document.body
  })
  return { w: wrapper, detail }
}

beforeEach(() => {
  ;(window as unknown as { api: unknown }).api = { shellOpenExternal: openExternal }
  openExternal.mockClear()
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  localStorage.clear()
})

const q = (sel: string): HTMLElement | null => document.body.querySelector<HTMLElement>(sel)
const qa = (sel: string): HTMLElement[] => [...document.body.querySelectorAll<HTMLElement>(sel)]
const items = (): HTMLElement[] => qa('[role="treeitem"]')
const idOf = (el: HTMLElement): string => el.dataset.milestone ?? el.dataset.step ?? ''
const rowOf = (id: string): HTMLElement => items().find((el) => idOf(el) === id) as HTMLElement
const focused = (): HTMLElement => document.activeElement as HTMLElement

async function press(el: HTMLElement, key: string): Promise<void> {
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  await nextTick()
  await nextTick()
}

describe('AC-9 — milestone, step, criteria; only the current milestone is open', () => {
  it('only the current milestone is open', async () => {
    mountTree(MID)

    expect(q('[role="tree"]')).not.toBeNull()
    const milestones = items().filter((el) => el.dataset.milestone)
    expect(milestones.map(idOf)).toEqual(['ms-1', 'ms-2', 'ms-3'])
    expect(milestones.map((el) => el.getAttribute('aria-expanded'))).toEqual([
      'false',
      'true',
      'false'
    ])
    // The steps of the others are not drawn at all: one line each.
    expect(qa('[data-test="step-row"]').every((el) => el.dataset.parent === 'ms-2')).toBe(true)
    expect(rowOf('s-done-1')).toBeUndefined()
    expect(rowOf('s-todo-3')).toBeUndefined()
    // The current milestone's glyph keeps its halo; the others have none.
    const halo = (id: string): boolean =>
      /ring-3|ring-accent-soft/.test(
        rowOf(id).querySelector('[data-test="milestone-glyph"]')?.className ?? ''
      )
    expect(halo('ms-2')).toBe(true)
    expect(halo('ms-1')).toBe(false)
    expect(halo('ms-3')).toBe(false)

    // No timeline line and no "Steps and timeline" disclosure.
    expect(
      q('[data-test="line-above"], [data-test="line-below"], [data-test="line-through"]')
    ).toBeNull()
    expect(document.body.textContent).not.toMatch(/Steps and timeline/i)

    // The dropdown reads and writes no `om2tab.missionPane.sections` value.
    const reads: string[] = []
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation((k) => {
      reads.push(k)
      return null
    })
    const writes = vi.spyOn(Storage.prototype, 'setItem')
    wrapper?.unmount()
    mountTree(MID)
    await nextTick()
    expect(reads.some((k) => k.includes('missionPane'))).toBe(false)
    expect(writes).not.toHaveBeenCalled()
    spy.mockRestore()
    writes.mockRestore()
  })

  it('a mission with no milestones draws its steps as one list', () => {
    mountTree({
      current: 's-b',
      milestones: [],
      steps: [
        { id: 's-a', title: 'Write the plan', state: 'done' },
        { id: 's-b', title: 'Score the specs', state: 'running' },
        { id: 's-c', title: 'Write the report', state: 'todo' }
      ]
    })
    expect(items().filter((el) => el.dataset.milestone)).toHaveLength(0)
    expect(qa('[data-test="step-row"]').map(idOf)).toEqual(['s-a', 's-b', 's-c'])
  })

  it('optional milestones stay under one collapsed line', async () => {
    mountTree({
      current: 'ms-1',
      milestones: [
        { id: 'ms-1', title: 'The scorer', state: 'in-progress' },
        { id: 'ms-o1', title: 'A nicer chart', state: 'not-started', optional: true },
        { id: 'ms-o2', title: 'An export', state: 'not-started', optional: true }
      ],
      steps: [{ id: 's-1', milestone: 'ms-1', title: 'Score the specs', state: 'running' }]
    })
    const toggle = q('[data-test="optional-toggle"]') as HTMLElement
    expect(toggle.textContent?.trim()).toBe('2 optional milestones')
    expect(items().map(idOf)).not.toContain('ms-o1')
    toggle.click()
    await nextTick()
    expect(items().map(idOf)).toEqual(expect.arrayContaining(['ms-o1', 'ms-o2']))
  })

  it('"Open step" unfolds the milestone and the step and brings it into view', async () => {
    const { w } = mountTree(MID)
    await (w.vm as unknown as { openStep: (id: string) => Promise<void> }).openStep('s-done-2')
    expect(rowOf('s-done-2').getAttribute('aria-expanded')).toBe('true')
    await (w.vm as unknown as { openStep: (id: string) => Promise<void> }).openStep('s-todo-3')
    expect(rowOf('ms-3').getAttribute('aria-expanded')).toBe('true')
    expect(rowOf('s-todo-3').getAttribute('aria-expanded')).toBe('true')
  })
})

describe('AC-10 — order inside an open milestone, and the step row', () => {
  it('three running steps and no Blocked chip', async () => {
    mountTree(MID)

    // Owed first (in plan order), then at most three running, nothing else until "more".
    const shown = qa('[data-test="step-row"]').map(idOf)
    expect(shown).toEqual(['s-block', 's-review', 's-run-1', 's-run-2', 's-run-3'])
    const more = q('[data-test="fold-more"]') as HTMLElement
    // Two running steps beyond the three, the to do step and the done one.
    expect(more.textContent?.trim()).toBe('4 more steps')

    // The step row: glyph, title, the PR number as a link and the Yours chip; no Blocked chip, no matter
    // that the step is blocked (the flag glyph and its label say it).
    const blocked = rowOf('s-block')
    expect(blocked.querySelector('[data-glyph="blocked"]')).not.toBeNull()
    expect(blocked.querySelector('[data-test="chip-blocked"]')).toBeNull()
    expect(blocked.textContent).not.toMatch(/Blocked/)
    expect(blocked.querySelector('[data-test="chip-yours"]')?.textContent?.trim()).toBe('Yours')
    const review = rowOf('s-review')
    expect(review.textContent).toContain('Look over the sign-in pull request')
    expect(review.querySelector('[data-test="step-pr"]')?.textContent?.trim()).toBe('#21')
    // A running step nobody owes has neither chip.
    expect(rowOf('s-run-1').querySelector('[data-test^="chip-"]')).toBeNull()
    expect(qa('[data-test="chip-blocked"]')).toHaveLength(0)

    // Opening the fold adds the rest in plan order and the button says how to close it.
    more.click()
    await nextTick()
    expect(qa('[data-test="step-row"]').map(idOf)).toEqual([
      's-block',
      's-review',
      's-run-1',
      's-run-2',
      's-run-3',
      's-todo',
      's-run-4',
      's-run-5',
      's-done-2'
    ])
    expect((q('[data-test="fold-more"]') as HTMLElement).textContent?.trim()).toBe('Show less')
  })

  it('the cap is a pure rule: the owed steps are never cut, only the running ones', () => {
    expect(RUNNING_SHOWN).toBe(3)
    const detail = detailOf(MID)
    const tree = capRunning(
      buildPaneTree(detail),
      detail.steps.map((s) => s.id)
    )
    const ms2 = tree.milestones.find((m) => m.id === 'ms-2')!
    expect(ms2.shown.map((s) => s.id)).toEqual([
      's-block',
      's-review',
      's-run-1',
      's-run-2',
      's-run-3'
    ])
    expect(ms2.folded.map((s) => s.id)).toEqual(['s-todo', 's-run-4', 's-run-5', 's-done-2'])

    // Many steps owed: all of them show, and the running ones still get their three.
    const owedMany = detailOf({
      ...MID,
      owed: ['s-todo', 's-run-1', 's-run-2', 's-run-3', 's-run-4', 's-block']
    })
    const t2 = capRunning(
      buildPaneTree(owedMany),
      owedMany.steps.map((s) => s.id)
    )
    const m = t2.milestones.find((x) => x.id === 'ms-2')!
    expect(m.shown.slice(0, 6).map((s) => s.id)).toEqual([
      's-todo',
      's-run-1',
      's-block',
      's-run-2',
      's-run-3',
      's-run-4'
    ])
    // Every step is in exactly one place.
    expect([...m.shown, ...m.folded].map((s) => s.id).sort()).toEqual(
      owedMany.steps
        .filter((s) => s.milestone === 'ms-2')
        .map((s) => s.id)
        .sort()
    )
  })
})

describe('AC-4 — the tree is a keyboard tree', () => {
  it('keyboard moves and toggles', async () => {
    mountTree(MID)

    // One tab stop for the whole tree: the current milestone. Every other row is reached by arrows.
    const stops = items().filter((el) => el.getAttribute('tabindex') === '0')
    expect(stops.map(idOf)).toEqual(['ms-2'])
    expect(items().every((el) => el.hasAttribute('aria-level'))).toBe(true)

    // Down and Up move between visible rows, in the order they are drawn.
    rowOf('ms-2').focus()
    await press(focused(), 'ArrowDown')
    expect(idOf(focused())).toBe('s-block')
    await press(focused(), 'ArrowDown')
    expect(idOf(focused())).toBe('s-review')
    await press(focused(), 'ArrowUp')
    expect(idOf(focused())).toBe('s-block')
    // The row focused is the one tab stop now.
    expect(
      items()
        .filter((el) => el.getAttribute('tabindex') === '0')
        .map(idOf)
    ).toEqual(['s-block'])

    // Left on a step that is closed moves out to its milestone; Left on the open milestone closes it.
    await press(focused(), 'ArrowLeft')
    expect(idOf(focused())).toBe('ms-2')
    expect(focused().getAttribute('aria-expanded')).toBe('true')
    await press(focused(), 'ArrowLeft')
    expect(rowOf('ms-2').getAttribute('aria-expanded')).toBe('false')
    expect(qa('[data-test="step-row"]')).toHaveLength(0)
    // Down now skips the hidden steps: the next visible row is the next milestone.
    await press(focused(), 'ArrowDown')
    expect(idOf(focused())).toBe('ms-3')
    await press(focused(), 'ArrowUp')

    // Right opens a closed milestone, and Right on an open one moves into its first step.
    await press(focused(), 'ArrowRight')
    expect(rowOf('ms-2').getAttribute('aria-expanded')).toBe('true')
    await press(focused(), 'ArrowRight')
    expect(idOf(focused())).toBe('s-block')

    // Right on a closed step opens it (its criteria show); Enter closes it; Space opens it again.
    await press(focused(), 'ArrowDown')
    expect(idOf(focused())).toBe('s-review')
    await press(focused(), 'ArrowRight')
    expect(rowOf('s-review').getAttribute('aria-expanded')).toBe('true')
    expect(qa('[data-test="criterion"]').map((el) => el.textContent?.trim())).toEqual([
      'Every reviewer question has an answer',
      'The page opens on a phone'
    ])
    await press(focused(), 'Enter')
    expect(rowOf('s-review').getAttribute('aria-expanded')).toBe('false')
    expect(qa('[data-test="criterion"]')).toHaveLength(0)
    await press(focused(), ' ')
    expect(rowOf('s-review').getAttribute('aria-expanded')).toBe('true')
    // Left on the open step closes it; focus stays on it.
    await press(focused(), 'ArrowLeft')
    expect(rowOf('s-review').getAttribute('aria-expanded')).toBe('false')
    expect(idOf(focused())).toBe('s-review')

    // Home and End jump to the first and the last visible row.
    await press(focused(), 'End')
    expect(idOf(focused())).toBe('ms-3')
    await press(focused(), 'Home')
    expect(idOf(focused())).toBe('ms-1')
    // Enter on a milestone toggles it.
    await press(focused(), 'Enter')
    expect(rowOf('ms-1').getAttribute('aria-expanded')).toBe('true')
    // The done milestone's one step is not owed and not running: it sits behind its own "1 more step".
    expect(qa('[data-test="fold-more"]').map((el) => el.textContent?.trim())).toEqual([
      '1 more step',
      '4 more steps'
    ])
  })

  it('the PR link is its own tab stop and never toggles the step', async () => {
    mountTree(MID)
    const link = q('[data-test="step-pr"]') as HTMLElement
    expect(link.getAttribute('role')).toBe('link')
    expect(link.getAttribute('tabindex')).toBe('0')
    // The row is the one tree stop; the link is a second one that does not move with the arrows.
    expect(rowOf('s-review').contains(link)).toBe(true)

    link.click()
    await nextTick()
    expect(openExternal).toHaveBeenCalledWith('https://github.com/acme/web/pull/21')
    expect(rowOf('s-review').getAttribute('aria-expanded')).toBe('false')

    // Enter and Space on the link open it too, and neither opens the step nor moves the tree.
    link.focus()
    await press(link, 'Enter')
    await press(link, ' ')
    expect(openExternal).toHaveBeenCalledTimes(3)
    expect(rowOf('s-review').getAttribute('aria-expanded')).toBe('false')
    await press(link, 'ArrowDown')
    expect(document.activeElement).toBe(link)
  })

  it('every pure key rule: the order the visible rows are in decides where a key goes', () => {
    const rows: TreeRow[] = [
      { id: 'a', parentId: null, open: false },
      { id: 'b', parentId: null, open: true },
      { id: 'b1', parentId: 'b', open: false },
      { id: 'b2', parentId: 'b', open: true },
      { id: 'c', parentId: null, open: false }
    ]
    const act = (id: string, key: string): ReturnType<typeof treeKeyAction> =>
      treeKeyAction(rows, id, key)
    expect(act('a', 'ArrowDown')).toEqual({ focus: 'b' })
    expect(act('c', 'ArrowDown')).toBeNull()
    expect(act('a', 'ArrowUp')).toBeNull()
    expect(act('b1', 'ArrowUp')).toEqual({ focus: 'b' })
    expect(act('b1', 'Home')).toEqual({ focus: 'a' })
    expect(act('b1', 'End')).toEqual({ focus: 'c' })
    expect(act('a', 'ArrowRight')).toEqual({ toggle: 'a' })
    expect(act('b', 'ArrowRight')).toEqual({ focus: 'b1' })
    expect(act('b', 'ArrowLeft')).toEqual({ toggle: 'b' })
    expect(act('b1', 'ArrowLeft')).toEqual({ focus: 'b' })
    expect(act('b2', 'ArrowLeft')).toEqual({ toggle: 'b2' })
    expect(act('a', 'ArrowLeft')).toBeNull()
    expect(act('a', 'Enter')).toEqual({ toggle: 'a' })
    expect(act('a', ' ')).toEqual({ toggle: 'a' })
    expect(act('a', 'x')).toBeNull()
    expect(treeKeyAction(rows, 'gone', 'ArrowDown')).toBeNull()
  })
})
