// @vitest-environment jsdom
/**
 * Mission dropdown · S-4 · AC-13 — an open step draws, in order: the blocker (reason, ask, unblocks, age, and
 * "Done, continue" only when the operator owns it), "Criteria" (verified ones folded into one line, open ones
 * with who settles them and their "Mark done" or "Mark approved" button; below 380px the who-settles cell goes
 * under the text), and "Links". A door that fails shows one red box with what to do, under the step's last
 * block, as in the pane (design.md §6 "Mission dropdown" → "What it draws" 4; mockup states `step-open` and
 * `blocked`).
 *
 * jsdom has no layout engine, so the width rule is read off the classes (the dropdown's body is the `@container`
 * the classes answer to), and order is read off the document. The step reads the row `buildPaneTree` made and
 * computes no state: every door goes through the store.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '../src/renderer/src/i18n'
import enMessages from '../src/renderer/src/i18n/en.json'
import ptMessages from '../src/renderer/src/i18n/pt-BR.json'
import MissionDropdownStep from '../src/renderer/src/components/MissionDropdownStep.vue'
import MissionDropdownTree from '../src/renderer/src/components/MissionDropdownTree.vue'
import { sampleOf } from '../src/renderer/src/lib/mission-sample'
import {
  splitCriteria,
  stepLinkRows,
  type MissionV4Reply,
  type PaneStepRow
} from '../src/renderer/src/lib/mission-pane-view'
import { useMissionsStore } from '../src/renderer/src/stores/missions'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'

type By = 'fact' | 'session' | 'operator' | 'person'
interface CriterionSeed {
  id: string
  text: string
  by: By
  settled?: boolean
  person?: string
  selfCheck?: boolean
}
interface BlockerSeed {
  id: string
  reason: string
  ask: string | null
  unblocks: string | null
  owner: 'agent' | 'operator'
  waitedMs: number | null
}

const L = enMessages.missionDropdown.step

function stepOf(
  over: {
    criteria?: CriterionSeed[]
    blockers?: BlockerSeed[]
    links?: Array<{ kind: 'pr'; ref: string }>
  } = {}
): PaneStepRow {
  const criteria = (over.criteria ?? []).map((c) => ({
    id: c.id,
    text: c.text,
    by: c.by,
    ...(c.person !== undefined ? { person: c.person } : {}),
    settled: c.settled === true,
    via: c.settled === true ? c.by : null,
    ...(c.selfCheck
      ? { selfCheck: { at: '2026-11-14T10:00:00.000Z', by: 'S9', evidence: 'x' } }
      : {})
  }))
  const { verified, open } = splitCriteria(criteria as never)
  return {
    id: 'stp-1',
    title: 'Score the proofs',
    state: 'waiting-review',
    blocked: (over.blockers ?? []).length > 0,
    needsYou: false,
    pr: null,
    criteria,
    prUrl: null,
    verified,
    open,
    blockers: over.blockers ?? [],
    links: stepLinkRows(over.links ?? [], [])
  } as unknown as PaneStepRow
}

let wrapper: VueWrapper | null = null
let door: ReturnType<typeof vi.spyOn>

async function mountStep(
  step: PaneStepRow,
  raw: Array<{ kind: string; ref: string }> = [],
  doorReply: unknown = { ok: true, changed: true }
): Promise<VueWrapper> {
  ;(window as unknown as { api: unknown }).api = {
    shellOpenExternal: vi.fn(async () => undefined),
    missionPathKinds: vi.fn(async () => ({})),
    foldersLoad: vi.fn(async () => []),
    helpersGet: vi.fn(async () => null),
    helpersSet: vi.fn(async () => undefined)
  }
  const missions = useMissionsStore()
  door = vi.spyOn(missions, 'runV4Door').mockResolvedValue(doorReply as never)
  const sessions = useSessionsStore()
  sessions.folders = [
    { path: '/repo', sessions: [{ sessionId: 'S1', projectPath: '/repo' }] }
  ] as never
  sessions.select('S1')
  const w = mount(MissionDropdownStep, {
    props: { step, rawLinks: raw as never },
    global: { plugins: [i18n] },
    attachTo: document.body
  })
  wrapper = w
  await flushPromises()
  return w
}

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

const blockerOf = (owner: 'agent' | 'operator', over: Partial<BlockerSeed> = {}): BlockerSeed => ({
  id: 'b1',
  reason: 'The scoring service needs an API key the session does not have.',
  ask: 'Add the key to the environment the session runs in.',
  unblocks: 'Unblocks when the key is set.',
  owner,
  waitedMs: 40 * 60_000,
  ...over
})

describe('blocker, criteria and failing door', () => {
  it('draws the blocker, then Criteria, then Links, in that order', async () => {
    const w = await mountStep(
      stepOf({
        blockers: [blockerOf('operator')],
        criteria: [{ id: 'c1', text: 'The score is the same twice', by: 'session' }],
        links: [{ kind: 'pr', ref: 'https://git.example/acme/web/pull/21' }]
      }),
      [{ kind: 'pr', ref: 'https://git.example/acme/web/pull/21' }]
    )
    const order = ['blocker', 'criteria', 'step-links'].map(
      (t) => w.get(`[data-test="${t}"]`).element
    )
    for (let i = 0; i < order.length - 1; i++) {
      expect(
        order[i].compareDocumentPosition(order[i + 1]) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy()
    }
  })

  it('the blocker shows the reason, the exact ask, what it unblocks and how long it has waited', async () => {
    const w = await mountStep(stepOf({ blockers: [blockerOf('operator')] }))
    const b = w.get('[data-test="blocker"]')
    expect(b.get('[data-test="blocker-head"]').text()).toBe(`${L.blocked.you} · 40m`)
    expect(b.get('[data-test="blocker-reason"]').text()).toContain('API key')
    expect(b.get('[data-test="blocker-ask"]').text()).toContain('Add the key')
    expect(b.get('[data-test="blocker-unblocks"]').text()).toContain('Unblocks when')
  })

  it('“Done, continue” is drawn only when the operator owns the blocker, and goes through the door', async () => {
    const w = await mountStep(stepOf({ blockers: [blockerOf('operator')] }))
    const btn = w.get('[data-test="blocker-clear"]')
    expect(btn.text()).toBe(L.clear)
    await btn.trigger('click')
    expect(door).toHaveBeenCalledWith({ door: 'clearBlocker', blockerId: 'b1', stepId: 'stp-1' })
    wrapper?.unmount()
    const w2 = await mountStep(stepOf({ blockers: [blockerOf('agent', { waitedMs: null })] }))
    expect(w2.find('[data-test="blocker-clear"]').exists()).toBe(false)
    expect(w2.get('[data-test="blocker-head"]').text()).toBe(L.blocked.session)
  })

  it('Criteria folds the verified ones into one line and lists only the open ones with who settles them', async () => {
    const w = await mountStep(
      stepOf({
        criteria: [
          { id: 'c1', text: 'Done one', by: 'fact', settled: true },
          { id: 'c2', text: 'Done two', by: 'session', settled: true },
          { id: 'c3', text: 'Done three', by: 'session', settled: true },
          { id: 'c4', text: 'Check the scores by hand', by: 'operator' },
          { id: 'c5', text: 'The whole test set runs', by: 'session' },
          { id: 'c6', text: 'The reviewer agrees', by: 'person', person: 'Ana' },
          { id: 'c7', text: 'The numbers are automatic', by: 'fact' }
        ]
      })
    )
    expect(w.get('[data-test="criteria"]').text()).toContain(L.criteria)
    expect(L.criteria).toBe('Criteria')
    expect(w.get('[data-test="criteria-verified"]').text()).toBe('3 criteria verified')
    const rows = w.findAll('[data-test="criterion-row"]')
    expect(rows.map((r) => r.attributes('data-criterion'))).toEqual(['c4', 'c5', 'c6', 'c7'])
    expect(w.text()).not.toContain('Done one')
    const by = rows.map((r) => r.get('[data-test="criterion-by"]').text())
    expect(by).toEqual([L.by.operator, L.by.session, 'Waiting for Ana', L.by.fact])
    // The buttons: Mark done for the operator's, Mark approved for another person's, none for the rest.
    expect(rows[0].get('[data-test="criterion-mark"]').text()).toBe(L.mark)
    expect(rows[2].get('[data-test="criterion-mark"]').text()).toBe(L.markPerson)
    expect(rows[1].find('[data-test="criterion-mark"]').exists()).toBe(false)
    expect(rows[3].find('[data-test="criterion-mark"]').exists()).toBe(false)
    // The criterion text is its own element (the tree reads it), and the glyph is labelled.
    expect(rows[0].get('[data-test="criterion"]').text()).toBe('Check the scores by hand')
    await rows[0].get('[data-test="criterion-mark"]').trigger('click')
    expect(door).toHaveBeenCalledWith({ door: 'mark', stepId: 'stp-1', criterionId: 'c4' })
  })

  it('below 380px the who-settles cell goes under the text', async () => {
    const w = await mountStep(
      stepOf({ criteria: [{ id: 'c1', text: 'Check by hand', by: 'operator' }] })
    )
    const who = w.get('[data-test="criterion-who"]')
    // The dropdown's body is the size container: the cell answers to its width, never the window's.
    expect(who.classes()).toEqual(
      expect.arrayContaining(['@max-[379px]:col-start-2', '@max-[379px]:row-start-2'])
    )
    expect(who.classes().join(' ')).not.toMatch(/(^|\s)(max|min)-\[/)
  })

  it('a builder’s own check is labelled and the criterion stays open; no criteria says so', async () => {
    const w = await mountStep(
      stepOf({ criteria: [{ id: 'c1', text: 'Works', by: 'session', selfCheck: true }] })
    )
    expect(w.get('[data-test="criterion-selfcheck"]').text()).toBe(L.selfCheck)
    wrapper?.unmount()
    const none = await mountStep(stepOf())
    expect(none.get('[data-test="criteria-none"]').text()).toBe(
      enMessages.missionDropdown.tree.noCriteria
    )
  })

  it('a door that fails shows one red box with what to do, under the last block', async () => {
    const w = await mountStep(
      stepOf({
        blockers: [blockerOf('operator')],
        criteria: [{ id: 'c1', text: 'Check by hand', by: 'operator' }],
        links: [{ kind: 'pr', ref: 'https://git.example/acme/web/pull/21' }]
      }),
      [{ kind: 'pr', ref: 'https://git.example/acme/web/pull/21' }],
      { ok: false, code: 'WRITE_CONFLICT', error: 'WRITE_CONFLICT: x' }
    )
    expect(w.find('[data-test="door-error"]').exists()).toBe(false)
    await w.get('[data-test="criterion-mark"]').trigger('click')
    await flushPromises()
    const boxes = w.findAll('[data-test="door-error"]')
    expect(boxes).toHaveLength(1)
    const box = boxes[0]
    expect(box.attributes('role')).toBe('alert')
    expect(box.text()).toBe(L.error.WRITE_CONFLICT)
    expect(box.text()).not.toContain('WRITE_CONFLICT')
    expect(box.classes()).toEqual(expect.arrayContaining(['border-red-line', 'bg-red-soft']))
    // Under the step's last block: Links is above it.
    const links = w.get('[data-test="step-links"]').element
    expect(
      links.compareDocumentPosition(box.element) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    // The next press clears it first; a refused code the pane does not know still says what to do.
    door.mockResolvedValueOnce({ ok: false, code: 'SOMETHING_NEW', error: 'x' } as never)
    await w.get('[data-test="criterion-mark"]').trigger('click')
    await flushPromises()
    expect(w.findAll('[data-test="door-error"]')).toHaveLength(1)
    expect(w.get('[data-test="door-error"]').text()).toBe(L.error.other)
  })

  it('inside the tree an open step reads its blocker’s age against the clock, with no clock passed in', async () => {
    ;(window as unknown as { api: unknown }).api = {
      shellOpenExternal: vi.fn(),
      missionPathKinds: vi.fn(async () => ({})),
      foldersLoad: vi.fn(async () => []),
      helpersGet: vi.fn(async () => null),
      helpersSet: vi.fn(async () => undefined)
    }
    const { detail } = sampleOf('step-blocked').reply as unknown as {
      detail: MissionV4Reply['detail']
    }
    const w = mount(MissionDropdownTree, {
      props: { detail, askLeader: null },
      global: { plugins: [i18n] },
      attachTo: document.body
    })
    wrapper = w as unknown as VueWrapper
    await (w.vm as unknown as { openStep: (id: string) => Promise<void> }).openStep('stp-10')
    const head = w.get('[data-test="blocker-head"]').text()
    expect(head).toMatch(new RegExp(`^${L.blocked.you} · \\d+[mhd]`))
  })

  it('every string of the step is in both languages', () => {
    const flat = (o: unknown, p = ''): string[] =>
      typeof o === 'object' && o !== null
        ? Object.entries(o).flatMap(([k, v]) => flat(v, `${p}${k}.`))
        : [p.slice(0, -1)]
    expect(flat(ptMessages.missionDropdown.step).sort()).toEqual(
      flat(enMessages.missionDropdown.step).sort()
    )
    expect(ptMessages.missionDropdown.step.criteria).not.toBe('Criteria')
  })
})
