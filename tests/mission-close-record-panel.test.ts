// @vitest-environment jsdom
/**
 * Campaign ch.6 part 2 (T610, AC-6.2) — the end dialog's "Also record" panel. It lists the
 * mission's stored `memoryDrafts` (kind, text, citations, what each replaces), every one
 * UNTICKED; "Close as delivered" sends the ids of the ticked ones with the end door and
 * nothing else; "Nothing notable" shows when the consolidator found nothing; Discard hides
 * the panel and sends no ids. Mounted through `MissionPill` so the real door path is used.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, DOMWrapper, type VueWrapper } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { i18n } from '@renderer/i18n'
import type { MissionView } from '../src/main/mission-ipc'
import type { MemoryDraft } from '../src/main/consolidator-core'
import MissionPill from '../src/renderer/src/components/MissionPill.vue'
import { useUiStore } from '../src/renderer/src/stores/ui'
import { fixtureView } from './helpers/mission-v3-view'

vi.mock('../src/renderer/src/lib/notification-sound', () => ({ playNotificationSound: vi.fn() }))

const OWNER = '00000000-0000-4000-8000-000000000001'

const DRAFTS: MemoryDraft[] = [
  {
    id: 'drf-1',
    kind: 'decision',
    page: 'decisions',
    entry: '## Wake the steward on events\n\nWhy: polling wasted ticks.',
    cites: [
      { kind: 'step', ref: 'stp-3' },
      { kind: 'pr', ref: '#175' }
    ],
    mission: 'mnt-4ba02726',
    validFrom: '2026-11-02',
    supersedes: 'e-1a2b3c4d'
  },
  {
    id: 'drf-2',
    kind: 'lesson',
    page: 'decisions',
    entry: '## A claimed step is not a verified one',
    cites: [{ kind: 'commit', ref: 'a0fd969f' }],
    mission: 'mnt-4ba02726',
    validFrom: '2026-11-02'
  },
  {
    id: 'drf-3',
    kind: 'hot',
    page: 'hot',
    entry: '**Now:** campaign ch.6 closed',
    cites: [{ kind: 'step', ref: 'stp-16' }],
    mission: 'mnt-4ba02726',
    validFrom: '2026-11-02'
  }
]

function withDrafts(drafts: MemoryDraft[] | undefined, nothingNotable = false): MissionView {
  return fixtureView('delivered', {
    mission: {
      status: 'delivered',
      pendingClose: { at: '2026-10-01T11:00:00.000Z', requestedBy: OWNER },
      ...(drafts ? { memoryDrafts: drafts } : {}),
      ...(nothingNotable
        ? {
            outcome: {
              declaredEnd: { kind: 'code', target: 'x', evidence: 'y' },
              actualEnd: 'x',
              deviations: [],
              blockers: [],
              verificationGaps: [],
              surprises: [],
              perStep: [],
              nothingNotable: true
            }
          }
        : {})
    },
    view: { you: [{ kind: 'close' }], closeWarnings: [] }
  })
}

let door: ReturnType<typeof vi.fn>
let wrapper: VueWrapper | null = null
const body = (): DOMWrapper<Element> => new DOMWrapper(document.body)
const q = (sel: string): Element | null => document.body.querySelector(sel)
const qa = (sel: string): Element[] => [...document.body.querySelectorAll(sel)]

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await flushPromises()
}

async function openEnd(v: MissionView): Promise<void> {
  const list = vi
    .fn()
    .mockResolvedValueOnce({ views: [v], unreadable: [] })
    .mockImplementation(() => new Promise(() => undefined))
  ;(window as unknown as { api: unknown }).api = {
    missionList: list,
    missionOperatorDoor: door,
    requestAttention: vi.fn()
  }
  wrapper = mount(MissionPill, {
    props: { sessionId: OWNER },
    global: { plugins: [i18n] },
    attachTo: document.body
  })
  await settle()
  await body().get('[data-dsqa^="topbar-pill"]').trigger('click')
  await settle()
  await body().get('[data-test="mission-close"]').trigger('click')
  await settle()
}

const draftRow = (id: string): Element | null =>
  q(`[data-test="mission-record-draft"][data-id="${id}"]`)
const tick = async (id: string): Promise<void> => {
  await body().get(`[data-test="mission-record-draft"][data-id="${id}"] input`).setValue(true)
}
const go = (): Promise<void> =>
  body().get('[data-test="mission-close-confirm-go"]').trigger('click')

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
  door = vi.fn(async () => ({ ok: true, view: null }))
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('"Also record" panel (AC-6.2)', () => {
  it('lists every stored draft, unticked, with its kind, text and citations', async () => {
    await openEnd(withDrafts(DRAFTS))
    expect(q('[data-test="mission-record"]')).not.toBeNull()
    expect(qa('[data-test="mission-record-draft"]').map((r) => r.getAttribute('data-id'))).toEqual([
      'drf-1',
      'drf-2',
      'drf-3'
    ])
    for (const input of qa('[data-test="mission-record-draft"] input')) {
      expect((input as HTMLInputElement).checked).toBe(false)
    }
    const first = draftRow('drf-1')!.textContent ?? ''
    expect(first).toContain('Decision')
    expect(first).toContain('Wake the steward on events')
    expect(first).toContain('stp-3')
    expect(first).toContain('#175')
    expect(draftRow('drf-2')!.textContent).toContain('Lesson')
    expect(draftRow('drf-2')!.textContent).toContain('a0fd969f')
    expect(draftRow('drf-3')!.textContent).toContain('Hot')
  })

  it('shows what a supersede draft replaces', async () => {
    await openEnd(withDrafts(DRAFTS))
    expect(draftRow('drf-1')!.textContent).toContain('e-1a2b3c4d')
    expect(draftRow('drf-2')!.textContent).not.toContain('Replaces')
  })

  it('ticked ids ride the end door; unticked ones do not', async () => {
    await openEnd(withDrafts(DRAFTS))
    await tick('drf-1')
    await tick('drf-3')
    await go()
    await settle()
    expect(door).toHaveBeenCalledTimes(1)
    expect(door.mock.calls[0][0]).toMatchObject({
      door: 'end',
      closedAs: 'delivered',
      record: ['drf-1', 'drf-3']
    })
  })

  it('ticking nothing sends no record key at all (default is write nothing)', async () => {
    await openEnd(withDrafts(DRAFTS))
    await go()
    await settle()
    expect(door.mock.calls[0][0]).not.toHaveProperty('record')
  })

  it('"Nothing notable" shows when the consolidator found nothing, and there is nothing to tick', async () => {
    await openEnd(withDrafts(undefined, true))
    expect(q('[data-test="mission-record-nothing"]')?.textContent).toContain('Nothing notable')
    expect(qa('[data-test="mission-record-draft"]')).toHaveLength(0)
  })

  it('no drafts and no outcome: no panel at all', async () => {
    await openEnd(withDrafts(undefined))
    expect(q('[data-test="mission-record"]')).toBeNull()
  })

  it('Discard hides the panel and sends no ids, even for drafts ticked before switching', async () => {
    await openEnd(withDrafts(DRAFTS))
    await tick('drf-1')
    await body().get('[data-test="mission-end-choice-discarded"] input').setValue(true)
    expect(q('[data-test="mission-record"]')).toBeNull()
    await go()
    await settle()
    expect(door.mock.calls[0][0]).toMatchObject({ door: 'end', closedAs: 'discarded' })
    expect(door.mock.calls[0][0]).not.toHaveProperty('record')
  })

  it('a ticked draft survives switching to Discard and back', async () => {
    await openEnd(withDrafts(DRAFTS))
    await tick('drf-2')
    await body().get('[data-test="mission-end-choice-discarded"] input').setValue(true)
    await body().get('[data-test="mission-end-choice-delivered"] input').setValue(true)
    expect((draftRow('drf-2')!.querySelector('input') as HTMLInputElement).checked).toBe(true)
  })

  it('a draft the memory write refused is toasted once the mission is closed', async () => {
    door = vi.fn(async () => ({
      ok: true,
      view: null,
      recorded: { written: ['drf-3'], failed: [{ id: 'drf-1', error: 'SUPERSEDES_NOT_FOUND: x' }] }
    }))
    await openEnd(withDrafts(DRAFTS))
    await tick('drf-1')
    await tick('drf-3')
    await go()
    await settle()
    const toast = useUiStore().toasts.at(-1)
    expect(toast).toMatchObject({ kind: 'warning' })
    expect(toast?.description).toContain('SUPERSEDES_NOT_FOUND')
  })
})
