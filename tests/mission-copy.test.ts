// @vitest-environment jsdom
/**
 * Mission v3 S3 (spec §3.2, AC-2) — what the sidebar chip says, mounted. The chip prints the SERVER's
 * headline ("Step 8 of 9", "Steps 4–7 of 9", "Step 5 of 5 ✓", nothing when empty) in the tone of the
 * mission's state. No draft callout and no Approve button exist anywhere. (The popover that used to share
 * these checks is gone, S-37; the pane's own copy is covered in `mission-pane-*.test.ts`.)
 */
import { readdirSync, readFileSync } from 'node:fs'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, DOMWrapper, type VueWrapper } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { i18n } from '@renderer/i18n'
import en from '../src/renderer/src/i18n/en.json'
import ptBR from '../src/renderer/src/i18n/pt-BR.json'
import type { MissionDoorResult, MissionView } from '../src/main/mission-ipc'
import SidebarFolder from '../src/renderer/src/components/SidebarFolder.vue'
import type { Folder } from '../src/renderer/src/stores/sessions'
import { fixtureView } from './helpers/mission-v3-view'

vi.mock('../src/renderer/src/lib/notification-sound', () => ({ playNotificationSound: vi.fn() }))

const OWNER = '00000000-0000-4000-8000-000000000001'

let wrapper: VueWrapper | null = null
let door: ReturnType<typeof vi.fn>
const body = (): DOMWrapper<Element> => new DOMWrapper(document.body)

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await flushPromises()
}

function seed(v: MissionView, doorResult: MissionDoorResult = { ok: true, view: v }): void {
  door = vi.fn(async () => doorResult)
  ;(window as unknown as { api: unknown }).api = {
    missionList: vi.fn(async () => ({ views: [v], unreadable: [] })),
    missionOperatorDoor: door,
    requestAttention: vi.fn()
  }
}

function sessionFolder(): Folder {
  const now = new Date().toISOString()
  return {
    path: '/repo',
    alias: 'repo',
    gitBranch: '',
    expanded: true,
    pinned: false,
    sessions: [
      {
        sessionId: OWNER,
        summary: 'owner',
        firstPrompt: '',
        created: now,
        modified: now,
        status: 'idle',
        isSidechain: false,
        resumable: true,
        bridged: false,
        synthetic: false,
        isShellTerminal: false
      }
    ]
  } as unknown as Folder
}

/** Mount one sidebar folder whose single session owns the seeded mission. */
async function mountSidebar(v: MissionView): Promise<void> {
  seed(v)
  wrapper = mount(SidebarFolder, {
    props: { folder: sessionFolder(), headerless: true },
    global: { plugins: [i18n] },
    attachTo: document.body
  })
  await settle()
}

const chip = (): DOMWrapper<Element> => body().get('[data-dsqa="sidebar-mission-chip"]')
const full = (): DOMWrapper<Element> => body().get('[data-mission-full]')
const toneText = (el: DOMWrapper<Element>): string[] =>
  el.classes().filter((c) => /^text-(accent|warning|green|text-3)$/.test(c))

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('AC-2 — the sidebar chip', () => {
  it('faq-like reads 8/9 in the accent tone', async () => {
    const v = fixtureView('faq-like')
    await mountSidebar(v)
    expect(full().text()).toBe('Step 8 of 9')
    expect(chip().find('[data-mission-count]').exists()).toBe(false)
    expect(chip().attributes('aria-label')).toBe('Mission: Step 8 of 9')
    expect(toneText(full())).toEqual(['text-accent'])
  })

  it.each([
    ['parallel', 'Steps 4–7 of 9'],
    ['delivered', 'Step 5 of 5 ✓']
  ] as const)('%s chip reads %s', async (name, text) => {
    await mountSidebar(fixtureView(name))
    expect(full().text()).toBe(text)
  })

  it('needs-you: the chip turns warning and is pinned', async () => {
    const v = fixtureView('faq-like', {
      view: { you: [{ kind: 'checks', count: 1, stepIds: ['stp-4'] }] }
    })
    await mountSidebar(v)
    expect(toneText(full())).toEqual(['text-warning'])
    expect(chip().get('[data-mission-count]').text()).toBe('1')
    expect(chip().find('svg.lucide-triangle-alert').exists()).toBe(true)
    expect(chip().attributes('aria-label')).toBe('Mission: Step 8 of 9 — needs you')
  })

  it('a delivered mission awaiting its close: green full text, pinned owed count', async () => {
    const v = fixtureView('delivered', {
      mission: { status: 'delivered' },
      view: { you: [{ kind: 'close' }], closeWarnings: [] }
    })
    await mountSidebar(v)
    expect(toneText(full())).toEqual(['text-green'])
    expect(chip().get('[data-mission-count]').text()).toBe('1')
    expect(chip().find('svg.lucide-triangle-alert').exists()).toBe(true)
  })

  it('an empty mission renders no chip', async () => {
    await mountSidebar(fixtureView('delivered', { mission: { steps: [] } }))
    expect(document.body.querySelector('[data-dsqa="sidebar-mission-chip"]')).toBeNull()
  })
})

describe('no draft, no Approve', () => {
  it('no mission component or the view model references a draft or the approve door', () => {
    const dir = 'src/renderer/src/components'
    const files = readdirSync(dir)
      .filter((f) => /^Mission.*\.vue$/.test(f))
      .map((f) => `${dir}/${f}`)
    for (const f of [
      ...files,
      'src/renderer/src/lib/mission-view.ts',
      'src/renderer/src/lib/mission-cue.ts',
      'src/renderer/src/stores/missions.ts'
    ]) {
      const src = readFileSync(f, 'utf8')
      expect(src, f).not.toMatch(/door:\s*'approve'|draftCallout|'draft'/)
    }
  })

  it.each([
    ['en', en.mission],
    ['pt-BR', ptBR.mission]
  ])('the %s mission copy has no draft or approve-mission keys', (_l, block) => {
    const keys = JSON.stringify(block)
    expect(block).not.toHaveProperty('pill')
    expect(block).not.toHaveProperty('draftCallout')
    expect(block).not.toHaveProperty('approve')
    expect(keys).not.toMatch(/nothing runs|nada roda/i)
  })
})
