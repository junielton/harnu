// @vitest-environment jsdom
/**
 * Missions v4 · stp-21 (T751) — the pane polish that is about words and rules, not pixels.
 *
 * AC-3  a link never breaks mid-word.
 * AC-4  Portuguese everywhere in the pane: every Next state and every summary heading, no English
 *       server text reaches the pane.
 * AC-5  the sample mission speaks the pane's own wording (one source) and its strip does not wrap narrow.
 * AC-6  the hand-off's new leader has a plain name: the mission's title, not the instruction it received.
 * AC-10 no stale "cannot create" comments in the pane files.
 * AC-11 the Activity fallback is true and complete (both outcomes), and the user doc says so.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '../src/renderer/src/i18n'
import enMessages from '../src/renderer/src/i18n/en.json'
import ptMessages from '../src/renderer/src/i18n/pt-BR.json'
import ActivityBell from '../src/renderer/src/components/ActivityBell.vue'
import MissionHandoffDialog from '../src/renderer/src/components/MissionHandoffDialog.vue'
import MissionPane from '../src/renderer/src/components/MissionPane.vue'
import {
  HANDOFF_NAME_PREFIX,
  PANE_SECTIONS_KEY,
  linkLabelParts,
  sessionNameOf,
  summaryHeadingLabel,
  translateHeadline,
  waitingText
} from '../src/renderer/src/lib/mission-pane-view'
import { SAMPLE_STATES, sampleOf, type SampleState } from '../src/renderer/src/lib/mission-sample'
import { useHelpersStore } from '../src/renderer/src/stores/helpers'
import { useMissionsStore } from '../src/renderer/src/stores/missions'
import { useNotificationsStore } from '../src/renderer/src/stores/notifications'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import { useUiStore } from '../src/renderer/src/stores/ui'
import type { MissionV4ViewReply } from '../src/main/mission-ipc'

vi.mock('../src/renderer/src/lib/notification-sound', () => ({ playNotificationSound: vi.fn() }))

const FOLDER = '/repo'
const SESSION = '99999999-9999-4999-8999-999999999999'
const OPEN_ALL = JSON.stringify({ tree: true, sessions: true, more: true })

type Detail = Extract<MissionV4ViewReply, { state: 'mission' }>['detail']
type Item = Detail['waiting']['items'][number]

const t = (key: string, values?: Record<string, unknown>, plural?: number): string =>
  String(
    plural === undefined
      ? i18n.global.t(key, (values ?? {}) as never)
      : i18n.global.t(key, (values ?? {}) as never, plural as never)
  )

let wrapper: VueWrapper | null = null
const q = (sel: string): HTMLElement | null => document.body.querySelector<HTMLElement>(sel)
const qa = (sel: string): HTMLElement[] => [...document.body.querySelectorAll<HTMLElement>(sel)]
const flat = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim()

async function settle(): Promise<void> {
  await flushPromises()
  await new Promise((r) => setTimeout(r, 30))
  await flushPromises()
}

async function mountPane(reply: MissionV4ViewReply | null, sample?: SampleState): Promise<VueWrapper> {
  ;(window as unknown as { api: unknown }).api = {
    missionList: vi.fn(async () => ({ views: [], unreadable: [], shadowed: [] })),
    missionV4View: vi.fn(async () => reply ?? { state: 'none', missions: [] }),
    missionV4Door: vi.fn(),
    missionHandOff: vi.fn(),
    missionOperatorDoor: vi.fn(),
    requestAttention: vi.fn(),
    sessionLinksList: vi.fn(async () => []),
    shellOpenExternal: vi.fn(async () => undefined),
    foldersLoad: vi.fn(async () => []),
    helpersGet: vi.fn(async () => null),
    helpersSet: vi.fn(async () => undefined)
  }
  const sessions = useSessionsStore()
  sessions.folders = [
    { path: FOLDER, sessions: [{ sessionId: SESSION, projectPath: FOLDER, summary: 'Leader' }] }
  ] as never
  sessions.select(SESSION)
  if (sample) useMissionsStore().showSample(sample)
  const w = mount(MissionPane, {
    props: {
      pane: { id: 'h-mission', type: 'mission', cwd: FOLDER, ratio: 1 },
      worktreePath: FOLDER
    },
    global: { plugins: [i18n] },
    attachTo: document.body
  })
  wrapper = w
  await settle()
  return w
}

/** A real session's reply built from the sample's, with the given waiting items. */
function replyWith(waiting: Item[], edit?: (d: Record<string, unknown>) => void): MissionV4ViewReply {
  const r = structuredClone(sampleOf('default').reply) as unknown as {
    sessions: Array<{ id: string }>
    detail: { waiting: Record<string, unknown> } & Record<string, unknown>
  }
  r.sessions = r.sessions.map((s, i) => (i === 0 ? { ...s, id: SESSION } : s))
  r.detail.waiting = {
    items: waiting,
    next: waiting[0] ?? null,
    more: waiting.slice(1),
    moreLine: null,
    people: [],
    peopleLine: null,
    peopleLines: []
  }
  edit?.(r.detail)
  return r as unknown as MissionV4ViewReply
}

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
  localStorage.clear()
  localStorage.setItem(PANE_SECTIONS_KEY, OPEN_ALL)
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

// ---- AC-3 · a link never breaks mid-word ---------------------------------------------------------------------

describe('AC-3 — a link wraps at separators and never inside a word', () => {
  const LABELS = [
    'github.com/org/repo/pull/21',
    'github.com/org/repo/blob/main/docs/specs/2026-11-14-missions-v4/spec.md',
    'figma.example/design/data-table',
    'localhost:5173/app/settings?tab=billing&plan=team#seats',
    'Figma frame',
    '#256',
    'a-very-long_name.with.dots/and/slashes'
  ]

  it.each(LABELS)('splits “%s” only after a separator, losing nothing', (label) => {
    const parts = linkLabelParts(label)
    expect(parts.join('')).toBe(label)
    const isWord = (c: string): boolean => /[\p{L}\p{N}]/u.test(c)
    parts.forEach((p, i) => {
      expect(p.length).toBeGreaterThan(0)
      if (i < parts.length - 1) {
        // A break falls AFTER a separator or a space, never between two letters or digits.
        const last = p[p.length - 1]
        const next = parts[i + 1][0]
        expect(isWord(last) && isWord(next), `${label}: “${p}|${parts[i + 1]}”`).toBe(false)
      }
    })
  })

  it('a long path is cut at its slashes, dots and dashes: many break points, none inside a segment', () => {
    const parts = linkLabelParts('github.com/org/repo/blob/main/docs/specs/2026-11-14-missions-v4/spec.md')
    expect(parts.length).toBeGreaterThan(6)
    expect(parts[0]).toBe('github.')
  })

  it('draws a step link with break points at separators, not break-all, and the full text in a title', async () => {
    const address = 'https://github.com/org/repo/blob/main/docs/specs/2026-11-14-missions-v4/spec.md'
    const reply = replyWith([], (d) => {
      const steps = d.steps as Array<{ links: unknown[] }>
      steps[0].links = [{ kind: 'doc', ref: address, label: 'spec' }]
    })
    await mountPane(reply)
    await (q('[data-test="step-row"]') as HTMLElement).click()
    await nextTick()
    const link = q('[data-test="step-link"]') as HTMLElement
    expect(link, 'the open step lists its link').not.toBeNull()
    expect(link.innerHTML).not.toContain('break-all')
    expect(link.querySelectorAll('wbr').length).toBeGreaterThan(3)
    expect(flat(link.textContent)).toBe('github.com/org/repo/blob/main/docs/specs/2026-11-14-missions-v4/spec.md')
    expect(link.getAttribute('title')).toContain('github.com/org/repo/blob/main/docs/specs/2026-11-14-missions-v4/spec.md')
  })
})

// ---- AC-4 · Portuguese everywhere ----------------------------------------------------------------------------

/** What the server writes today (`src/main/missions/waiting.ts`): English, in the reply. */
const SERVER: Record<string, { ask: string; why: string }> = {
  'main-failing': {
    ask: 'Fix the main branch: it broke after "Load the files"',
    why: 'Everything that merges next starts from a broken base'
  },
  unblock: { ask: 'Put the export on the shared drive', why: 'The step cannot go on until then' },
  settle: { ask: 'Mark done: Check the layout', why: 'It is the last thing open on this step' },
  review: { ask: 'Look over 2 pull requests', why: '2 steps cannot finish until you do' },
  close: { ask: 'Close the mission: every step is done', why: 'The mission is finished once you close it' },
  attach: {
    ask: 'Let another session join this mission',
    why: 'It asked to work on it and waits for your answer'
  }
}
const ENGLISH = [
  /Fix the main/i,
  /Everything that merges/i,
  /cannot go on/i,
  /Mark done/i,
  /last thing open/i,
  /Look over/i,
  /cannot finish/i,
  /Close the mission/i,
  /finished once/i,
  /Let another session/i,
  /asked to work/i,
  /waits for your answer/i,
  /more waiting on you/i,
  /Open step/i
]

function stepsFor(detail: Detail): Detail['steps'] {
  return detail.steps
}

/** Items that name real steps and criteria of the sample detail, so the renderer can word them from the record. */
function itemsOf(detail: Detail): Item[] {
  const steps = stepsFor(detail)
  const withOperatorCriterion = steps.find((s) => s.criteria.some((c) => c.by === 'operator' && !c.settled))
  const blocked = steps.find((s) => s.blockers.length > 0)
  const first = steps[0]
  const second = steps[1]
  return [
    { kind: 'main-failing', id: 'mf', stepId: first.id, pr: null, ...SERVER['main-failing'] },
    {
      kind: 'unblock',
      id: 'ub',
      stepId: blocked?.id ?? first.id,
      blockerId: blocked?.blockers[0]?.id ?? 'blk-1',
      ...SERVER.unblock
    },
    {
      kind: 'settle',
      id: 'st',
      stepId: withOperatorCriterion?.id ?? first.id,
      criterionId: withOperatorCriterion?.criteria.find((c) => c.by === 'operator')?.id ?? 'c1',
      ...SERVER.settle
    },
    { kind: 'review', id: 'rv', stepIds: [first.id, second.id], prs: [], ...SERVER.review },
    { kind: 'close', id: 'cl', requested: false, ...SERVER.close },
    { kind: 'attach', id: 'at', requestId: 'atr-1', sessionId: 'sess-x', ...SERVER.attach }
  ] as unknown as Item[]
}

describe('AC-4 — with the app in Portuguese, the Next box is Portuguese', () => {
  const detail = (): Detail =>
    (sampleOf('default').reply as Extract<MissionV4ViewReply, { state: 'mission' }>).detail

  it('words every kind of waiting item from its kind and the record, never from the server’s English', () => {
    i18n.global.locale.value = 'pt-BR'
    for (const item of itemsOf(detail())) {
      const w = waitingText(t, detail(), item)
      expect(w.ask, item.kind).toBeTruthy()
      expect(w.why, item.kind).toBeTruthy()
      for (const re of ENGLISH) {
        expect(`${w.ask} | ${w.why}`, item.kind).not.toMatch(re)
      }
      expect(w.ask).not.toBe((item as { ask: string }).ask)
    }
  })

  it('says it the same way in English as the server did, so nothing changes for English readers', () => {
    i18n.global.locale.value = 'en'
    const d = detail()
    const byKind = Object.fromEntries(itemsOf(d).map((i) => [i.kind, waitingText(t, d, i)]))
    expect(byKind.close).toEqual(SERVER.close)
    expect(byKind.attach).toEqual(SERVER.attach)
    expect(byKind.review.ask).toBe('Look over 2 pull requests')
    expect(byKind.review.why).toBe('2 steps cannot finish until you do')
    expect(byKind.unblock.why).toBe('The step cannot go on until then')
    expect(byKind['main-failing'].why).toBe(SERVER['main-failing'].why)
  })

  it('a blocker’s own words are shown as the agent wrote them; its default “why” is translated', () => {
    i18n.global.locale.value = 'pt-BR'
    const d = detail()
    const stepWithBlocker = d.steps.find((s) => s.blockers.length > 0)!
    const b = stepWithBlocker.blockers[0]
    const item = {
      kind: 'unblock',
      id: 'ub',
      stepId: stepWithBlocker.id,
      blockerId: b.id,
      ask: 'ENGLISH ASK',
      why: 'The step cannot go on until then'
    } as unknown as Item
    const bare = structuredClone(d)
    const bb = bare.steps.find((s) => s.id === stepWithBlocker.id)!.blockers[0] as Record<string, unknown>
    delete bb.unblocks
    const w = waitingText(t, bare, item)
    expect(w.ask).toBe(b.ask || b.reason)
    expect(w.why).toBe(ptMessages.missionPane.next.text.unblock.whyStep)
  })

  it('the mounted Next box and its “more” rows show none of the server’s English under pt-BR', async () => {
    i18n.global.locale.value = 'pt-BR'
    const d = detail()
    await mountPane(replyWith(itemsOf(d), undefined))
    await settle()
    const box = flat(q('[data-test="next-step"]')?.textContent)
    expect(box.length).toBeGreaterThan(0)
    for (const re of ENGLISH) expect(box, box).not.toMatch(re)
    expect(box).toContain('Seu próximo passo')
  })

  it('the picker’s count line is built from the numbers, not the server’s English', () => {
    i18n.global.locale.value = 'pt-BR'
    expect(translateHeadline(t, '4 of 21 steps done')).toBe('4 de 21 passos concluídos')
    expect(translateHeadline(t, '1 of 10 milestones done')).toBe('1 de 10 marcos concluídos')
    expect(translateHeadline(t, '0 of 1 step done')).toBe('0 de 1 passo concluído')
    i18n.global.locale.value = 'en'
    expect(translateHeadline(t, '4 of 21 steps done')).toBe('4 of 21 steps done')
    // A line this build does not know is shown as the server wrote it.
    expect(translateHeadline(t, 'nothing planned yet')).toBe('nothing planned yet')
  })
})

describe('AC-4 — with the app in Portuguese, the summary headings are Portuguese', () => {
  const HEADINGS = ['Goal', 'Where it is', 'Decided', 'Stopped at', 'Next step', 'Open criteria', 'Links']
  const BRIEF = ['# Mission mnt-1', ...HEADINGS.map((h) => `## ${h}\nbody of ${h}`)].join('\n\n')

  it('names every heading the summary has, in both languages, and leaves an unknown one as written', () => {
    i18n.global.locale.value = 'pt-BR'
    const pt = HEADINGS.map((h) => summaryHeadingLabel(t, h))
    expect(pt).toEqual([
      'Objetivo',
      'Onde está',
      'Decidido',
      'Parou em',
      'Próximo passo',
      'Critérios em aberto',
      'Links'
    ])
    i18n.global.locale.value = 'en'
    expect(HEADINGS.map((h) => summaryHeadingLabel(t, h))).toEqual(HEADINGS)
    expect(summaryHeadingLabel(t, 'Something new')).toBe('Something new')
  })

  it('the confirmation dialog shows the translated headings under pt-BR', async () => {
    i18n.global.locale.value = 'pt-BR'
    const w = mount(MissionHandoffDialog, {
      props: { open: true, brief: BRIEF, pending: false, errorKey: null, done: false, canOpenNew: false },
      global: { plugins: [i18n] },
      attachTo: document.body
    })
    wrapper = w
    await nextTick()
    const shown = qa('[data-test="handoff-heading"]').map((e) => flat(e.textContent))
    expect(shown).toEqual([
      'Objetivo',
      'Onde está',
      'Decidido',
      'Parou em',
      'Próximo passo',
      'Critérios em aberto',
      'Links'
    ])
    // The stable code of the section is still the server's heading.
    expect(qa('[data-test="handoff-section"]').map((e) => e.getAttribute('data-heading'))).toEqual(HEADINGS)
  })

  it('the new keys exist in both locales with the same shape (the parity the schema needs)', () => {
    const keysOf = (o: unknown, p = ''): string[] =>
      typeof o === 'object' && o !== null
        ? Object.entries(o).flatMap(([k, v]) => keysOf(v, p ? `${p}.${k}` : k))
        : [p]
    const en = keysOf(enMessages.missionPane).sort()
    const pt = keysOf(ptMessages.missionPane).sort()
    expect(pt).toEqual(en)
    for (const k of [
      'missionPane.next.text.mainFailing.ask',
      'missionPane.next.text.settle.whyMore',
      'missionPane.next.text.review.askOne',
      'missionPane.next.text.close.askReady',
      'missionPane.next.text.attach.why',
      'missionPane.next.text.unblock.whyMission',
      'missionPane.handoff.brief.section.goal',
      'missionPane.handoff.brief.section.openCriteria',
      'missionPane.tree.toggle'
    ]) {
      expect(en, k).toContain(k)
    }
  })
})

// ---- AC-5 · the sample is one thing ---------------------------------------------------------------------------

describe('AC-5 — the sample mission uses the pane’s own wording, and its strip fits at 296 px', () => {
  it('the Next box of every sample state shows the pane’s wording for its items, not strings of its own', async () => {
    for (const state of SAMPLE_STATES) {
      const sample = sampleOf(state)
      if (sample.reply.state !== 'mission') continue
      const detail = sample.reply.detail
      const next = detail.waiting.next
      if (!next) continue
      const expected = waitingText(t, detail, next)
      await mountPane(null, state)
      const box = flat(q('[data-test="next-step"]')?.textContent)
      expect(box, state).toContain(expected.ask)
      wrapper?.unmount()
      wrapper = null
      document.body.innerHTML = ''
      setActivePinia(createPinia())
    }
  })

  it('the sample’s hints quote the real labels of the pane, in both languages', async () => {
    for (const locale of ['en', 'pt-BR'] as const) {
      i18n.global.locale.value = locale
      await mountPane(null, 'waiting')
      const hint = flat(q('[data-test="mission-sample-hint"]')?.textContent)
      expect(hint, locale).toContain(t('missionPane.next.more', { n: 'N' }, 2))
      wrapper?.unmount()
      wrapper = null
      document.body.innerHTML = ''
      setActivePinia(createPinia())
      await mountPane(null, 'sessions')
      expect(flat(q('[data-test="mission-sample-hint"]')?.textContent), locale).toContain(
        t('missionPane.sessions.label')
      )
      wrapper?.unmount()
      wrapper = null
      document.body.innerHTML = ''
      setActivePinia(createPinia())
    }
  })

  it('the strip is two rows: the label and Leave on one, the note on its own full-width row', async () => {
    await mountPane(null, 'default')
    const strip = q('[data-test="mission-sample"]') as HTMLElement
    const note = strip.querySelector('[data-test="mission-sample-note"]') as HTMLElement
    const leave = strip.querySelector('[data-test="mission-sample-leave"]') as HTMLElement
    expect(note, 'the note has its own element').not.toBeNull()
    expect(note.parentElement).not.toBe(leave.parentElement)
    expect(note.className).not.toContain('flex-1')
  })
})

// ---- AC-6 · the hand-off's leader has a plain name -----------------------------------------------------------

describe('AC-6 — the session a hand-off started is named after the mission', () => {
  const MISSION_TITLE = 'Measure the spec skill, then fix what the numbers show'
  const instruction = `${HANDOFF_NAME_PREFIX} from another session. Harnu attaches you as its leader.`

  it('the Sessions row names it with the mission’s title, plainly, not the instruction it received', () => {
    const all = [{ sessionId: 'new-leader', firstPrompt: instruction }]
    const name = sessionNameOf('new-leader', all, t, MISSION_TITLE)
    expect(name).toBe(MISSION_TITLE)
    expect(name).not.toContain(HANDOFF_NAME_PREFIX)
    expect(name).not.toContain('Took over')
  })

  it('a session with a name of its own keeps it, and a hand-off with no title falls back as before', () => {
    const own = [{ sessionId: 's1', summary: 'Fix the importer', firstPrompt: instruction }]
    expect(sessionNameOf('s1', own, t, MISSION_TITLE)).toBe('Fix the importer')
    const bare = [{ sessionId: 's2', firstPrompt: instruction }]
    expect(sessionNameOf('s2', bare, t)).toBe(instruction)
  })
})

// ---- AC-10 · no stale comments -----------------------------------------------------------------------------

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(vue|ts)$/.test(name)) out.push(full)
  }
  return out
}

describe('AC-10 — no comment says a v4 mission cannot be created, or that a popover serves a record', () => {
  const RETIRED =
    /popover still serves|cannot create a v4 mission|cannot be created by an agent|no agent can create|verbs land in chapter|session verbs land|until the session verbs/i

  it('the pane files, the sample, the store and the renderer say nothing of the sort', () => {
    const files = walk('src/renderer/src')
    const hits = files.flatMap((f) =>
      readFileSync(f, 'utf8')
        .split('\n')
        .flatMap((line, i) => (RETIRED.test(line) ? [`${f}:${i + 1}: ${line.trim()}`] : []))
    )
    expect(hits).toEqual([])
  })
})

// ---- AC-11 · the Activity fallback --------------------------------------------------------------------------

describe('AC-11 — an Activity row of a mission whose leader is not loaded says so; one that is loaded opens the pane', () => {
  let activate: ReturnType<typeof vi.fn>
  const item = {
    id: 'mnt-1',
    title: 'Ship the table',
    description: 'owes 1',
    sessionId: 'owner-1',
    target: { view: 'mission', missionId: 'mnt-1' }
  }
  async function bell(): Promise<VueWrapper> {
    ;(window as unknown as { api: unknown }).api = {
      missionList: vi.fn(() => new Promise(() => {})),
      helpersGet: vi.fn(async () => null),
      helpersSet: vi.fn(async () => undefined)
    }
    activate = vi.fn()
    useSessionsStore().activateSession = activate as never
    useNotificationsStore().notify({
      ts: Date.now(),
      source: 'app',
      kind: 'warning',
      title: '1 mission needs you',
      group: 'mission-cue',
      items: [item]
    })
    const w = mount(ActivityBell, { attachTo: document.body, global: { plugins: [i18n] } })
    wrapper = w
    await w.get('[data-dsqa="topbar-bell"]').trigger('click')
    await nextTick()
    return w
  }

  it('leader loaded: it activates the session and opens the pane for it', async () => {
    const sessions = useSessionsStore()
    sessions.folders = [{ path: FOLDER, sessions: [{ sessionId: 'owner-1', projectPath: FOLDER }] }] as never
    const w = await bell()
    activate.mockImplementation((id: string) => {
      sessions.select(id)
      return true
    })
    await w.get('[data-dsqa="activity-item"]').trigger('click')
    expect(activate).toHaveBeenCalledWith('owner-1')
    expect(useHelpersStore().panesForCurrentWorktree.map((p) => p.type)).toContain('mission')
  })

  it('leader not loaded: a notice that names the mission, no pane, never a dead click', async () => {
    const w = await bell()
    activate.mockReturnValue(false)
    await w.get('[data-dsqa="activity-item"]').trigger('click')
    const notice = useUiStore().toasts.find((x) => `${x.title} ${x.description ?? ''}`.includes('Ship the table'))
    expect(notice, 'a notice naming the mission').toBeDefined()
    expect(useHelpersStore().panesForCurrentWorktree.map((p) => p.type)).not.toContain('mission')
  })

  it('the user doc says a notice shows, and no longer says an older Missions review opens', () => {
    const doc = readFileSync('docs/user/missions.md', 'utf8')
    expect(/older Missions review/i.test(doc), 'still names the older review').toBe(false)
    expect(/Missions review instead/i.test(doc), 'still names the older review').toBe(false)
    const line = doc.split('\n').find((l) => l.includes('**Activity.**')) ?? ''
    expect(/notice/i.test(line), 'the Activity line says a notice shows').toBe(true)
    expect(/names the mission/i.test(line), 'the notice names the mission').toBe(true)
  })
})
