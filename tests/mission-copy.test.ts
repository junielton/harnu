// @vitest-environment jsdom
/**
 * Mission v3 S3 (spec §3.2, AC-2 / AC-6) — what the three mission surfaces say,
 * mounted. The Topbar pill, the popover header and the sidebar chip print the
 * SERVER's headline ("Step 8 of 9", "Steps 4–7 of 9", "Step 5 of 5 ✓", nothing
 * when empty); the chip wears the pill's tone; the current marker sits on step
 * N. The popover renders the seven step visuals, the checks (ticked, added and
 * deleted through the operator doors), one row per child session, and a
 * go-to-session action that toasts when the session is not loaded. No draft
 * callout and no Approve button exist anywhere.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, DOMWrapper, type VueWrapper } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { i18n } from '@renderer/i18n'
import en from '../src/renderer/src/i18n/en.json'
import ptBR from '../src/renderer/src/i18n/pt-BR.json'
import type { MissionDoorResult, MissionView } from '../src/main/mission-ipc'
import type { Check } from '../src/main/mission-core'
import MissionPill from '../src/renderer/src/components/MissionPill.vue'
import SidebarFolder from '../src/renderer/src/components/SidebarFolder.vue'
import { useSessionsStore, type Folder } from '../src/renderer/src/stores/sessions'
import { useUiStore } from '../src/renderer/src/stores/ui'
import { fixtureView, type FixtureName } from './helpers/mission-v3-view'

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

/** Mount the pill and open its popover. */
async function openPopover(v: MissionView, doorResult?: MissionDoorResult): Promise<void> {
  seed(v, doorResult)
  wrapper = mount(MissionPill, {
    props: { sessionId: OWNER },
    global: { plugins: [i18n] },
    attachTo: document.body
  })
  await settle()
  await body().get('[data-dsqa^="topbar-pill"]').trigger('click')
  await settle()
}

const pill = (): DOMWrapper<Element> => body().get('[data-dsqa^="topbar-pill"]')
const pillText = (): string => pill().text().trim()
const headerCount = (): string => body().get('[data-test="mission-count"]').text().trim()
const counts = (): string => body().get('[data-test="mission-counts"]').text().replace(/\s+/g, ' ')

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

describe('AC-2 — the headline is the server’s position', () => {
  it('faq-like reads "Step 8 of 9" in the pill and the popover, the marker on step 8', async () => {
    const v = fixtureView('faq-like')
    await openPopover(v)
    expect(pillText()).toBe('Step 8 of 9')
    expect(headerCount()).toBe('Step 8 of 9')
    expect(counts()).toBe('6 done · 6 verified · 1 left behind')
    const current = body().findAll('[aria-current="step"]')
    expect(current.map((c) => c.attributes('data-position'))).toEqual(['8'])
  })

  it('parallel reads "Steps 4–7 of 9"', async () => {
    await openPopover(fixtureView('parallel'))
    expect(pillText()).toBe('Steps 4–7 of 9')
    expect(headerCount()).toBe('Steps 4–7 of 9')
    expect(body().findAll('[aria-current="step"]')).toHaveLength(4)
  })

  it('delivered reads "Step 5 of 5 ✓" with the check icon', async () => {
    await openPopover(fixtureView('delivered'))
    expect(pillText()).toBe('Step 5 of 5 ✓')
    expect(headerCount()).toBe('Step 5 of 5 ✓')
  })

  it('an empty mission prints no headline (never "Step 0 of 0")', async () => {
    await openPopover(fixtureView('delivered', { mission: { steps: [] } }))
    expect(pillText()).toBe('')
    expect(document.body.querySelector('[data-test="mission-count"]')?.textContent?.trim()).toBe('')
    expect(document.body.textContent).not.toContain('Step 0')
  })

  it.each(['faq-like', 'parallel', 'delivered', 'tools-listing-like'] as FixtureName[])(
    '%s: pill N equals the step carrying the current marker',
    async (name) => {
      const v = fixtureView(name)
      await openPopover(v)
      const marked = body()
        .findAll('[aria-current="step"]')
        .map((c) => Number(c.attributes('data-position')))
      if (v.progress.current) expect(marked[0]).toBe(v.progress.current.from)
      else expect(marked).toEqual([])
    }
  )

  it('the rail shows a legacy fixed start as scope, not a step', async () => {
    await openPopover(fixtureView('faq-like'))
    const ids = body()
      .findAll('[data-step]')
      .map((s) => s.attributes('data-step'))
    expect(ids).not.toContain('stp-1')
    expect(ids).toHaveLength(9)
  })
})

describe('AC-2 — the sidebar chip', () => {
  it('faq-like reads 8/9 with the same tone class as the pill', async () => {
    const v = fixtureView('faq-like')
    await mountSidebar(v)
    expect(chip().text()).toBe('8/9')
    expect(chip().attributes('aria-label')).toBe('Mission: Step 8 of 9')
    const chipTone = toneText(chip())
    wrapper?.unmount()
    document.body.innerHTML = ''
    setActivePinia(createPinia())
    await openPopover(v)
    expect(toneText(pill())).toEqual(chipTone)
    expect(chipTone).toEqual(['text-accent'])
  })

  it.each([
    ['parallel', '4–7/9'],
    ['delivered', '5/5 ✓']
  ] as const)('%s chip reads %s', async (name, text) => {
    await mountSidebar(fixtureView(name))
    expect(chip().text()).toBe(text)
  })

  it('needs-you: the chip and the pill both turn warning, and the chip is pinned', async () => {
    const v = fixtureView('faq-like', {
      view: { you: [{ kind: 'checks', count: 1, stepIds: ['stp-4'] }] }
    })
    await mountSidebar(v)
    expect(toneText(chip())).toEqual(['text-warning'])
    expect(chip().classes()).toContain('opacity-100')
    expect(chip().attributes('aria-label')).toBe('Mission: Step 8 of 9 — needs you')
    wrapper?.unmount()
    document.body.innerHTML = ''
    setActivePinia(createPinia())
    await openPopover(v)
    expect(toneText(pill())).toEqual(['text-warning'])
  })

  it('a delivered mission awaiting its close: green like the pill, pinned, no warning mark', async () => {
    const v = fixtureView('delivered', {
      mission: { status: 'delivered' },
      view: { you: [{ kind: 'close' }], closeWarnings: [] }
    })
    await mountSidebar(v)
    expect(toneText(chip())).toEqual(['text-green'])
    expect(chip().classes()).toContain('opacity-100')
    expect(chip().find('svg').exists()).toBe(false)
    wrapper?.unmount()
    document.body.innerHTML = ''
    setActivePinia(createPinia())
    await openPopover(v)
    expect(toneText(pill())).toEqual(['text-green'])
  })

  it('an empty mission renders no chip', async () => {
    await mountSidebar(fixtureView('delivered', { mission: { steps: [] } }))
    expect(document.body.querySelector('[data-dsqa="sidebar-mission-chip"]')).toBeNull()
  })
})

describe('the seven step visuals', () => {
  it('each rail glyph names its server state, and left-behind wins', async () => {
    const v = fixtureView('hero-like')
    await openPopover(v)
    const visuals = Object.fromEntries(
      body()
        .findAll('[data-step]')
        .map((s) => [s.attributes('data-step'), s.attributes('data-visual')])
    )
    for (const [id, st] of Object.entries(v.progress.states)) {
      expect(visuals[id], id).toBe(v.progress.leftBehind.includes(id) ? 'left-behind' : st)
    }
    expect(visuals['stp-2']).toBe('waiting')
    expect(visuals['stp-6']).toBe('done')
    expect(visuals['stp-3']).toBe('left-behind')
    // The glyph says what it is.
    const glyph = body().get('[data-step="stp-2"] [data-glyph]')
    expect(glyph.attributes('title')).toBe('Waiting')
  })

  it('running steps pulse; a blocked step shows the warning glyph', async () => {
    await openPopover(fixtureView('parallel'))
    expect(body().find('[data-step="stp-5"] [data-glyph] .anim-pulse-dot').exists()).toBe(true)
    expect(body().get('[data-step="stp-5"] [data-glyph]').attributes('title')).toBe('Running')
    wrapper?.unmount()
    document.body.innerHTML = ''
    setActivePinia(createPinia())
    await openPopover(fixtureView('blocked-like'))
    expect(body().get('[data-step="stp-6"] [data-glyph]').attributes('title')).toBe('Blocked')
  })
})

describe('AC-6 — checks on their step, through the doors', () => {
  const check = (id: string, label: string, ticked = false): Check => ({
    id,
    label,
    source: 'verifier',
    createdAt: '2026-10-01T10:00:00.000Z',
    ...(ticked ? { ticked: { at: '2026-10-01T11:00:00.000Z' } } : {})
  })

  function withChecks(): MissionView {
    const v = fixtureView('faq-like')
    v.mission.steps.find((s) => s.id === 'stp-4')!.checks = [
      check('chk-1', 'DSQA done'),
      check('chk-2', 'Validated visually', true)
    ]
    return v
  }

  it('renders the checks on their step, the unticked one due', async () => {
    await openPopover(withChecks())
    const rows = body().findAll('[data-step="stp-4"] [data-test="mission-check"]')
    expect(
      rows.map((r) => [r.get('[title]').text(), r.find('[data-test="mission-check-due"]').exists()])
    ).toEqual([
      ['DSQA done', true],
      ['Validated visually', false]
    ])
    expect(rows[0].get('[data-test="mission-check-due"]').text()).toBe('due')
    const boxes = body().findAll<HTMLInputElement>(
      '[data-step="stp-4"] [data-test="mission-check-box"]'
    )
    expect(boxes.map((b) => b.element.checked)).toEqual([false, true])
  })

  it('ticking and unticking go through the tickCheck door', async () => {
    const v = withChecks()
    await openPopover(v)
    const boxes = body().findAll('[data-step="stp-4"] [data-test="mission-check-box"]')
    await boxes[0].setValue(true)
    await settle()
    expect(door).toHaveBeenCalledWith({
      door: 'tickCheck',
      root: '/repo',
      missionId: v.mission.id,
      stepId: 'stp-4',
      checkId: 'chk-1',
      ticked: true
    })
    await boxes[1].setValue(false)
    await settle()
    expect(door).toHaveBeenLastCalledWith(
      expect.objectContaining({ door: 'tickCheck', checkId: 'chk-2', ticked: false })
    )
  })

  it('a check on a todo step is not marked due', async () => {
    const v = fixtureView('faq-like')
    // stp-10 is the end step, still `todo`: its check is not owed yet.
    expect(v.progress.states['stp-10']).toBe('todo')
    v.mission.steps.find((s) => s.id === 'stp-10')!.checks = [check('chk-1', 'Release notes read')]
    await openPopover(v)
    const row = body().get('[data-step="stp-10"] [data-test="mission-check"]')
    expect(row.text()).toContain('Release notes read')
    expect(row.find('[data-test="mission-check-due"]').exists()).toBe(false)
  })

  it('a refused tick puts the checkbox back to the server value', async () => {
    const v = withChecks()
    await openPopover(v, { ok: false, error: 'CHECK_NOT_FOUND: chk-1 is gone' })
    const box = body().get<HTMLInputElement>('[data-step="stp-4"] [data-check="chk-1"] input')
    await box.setValue(true)
    await settle()
    expect(door).toHaveBeenCalledWith(expect.objectContaining({ door: 'tickCheck', ticked: true }))
    expect(box.element.checked).toBe(false)
    // …and an untick refused on a ticked check puts it back to ticked.
    const ticked = body().get<HTMLInputElement>('[data-step="stp-4"] [data-check="chk-2"] input')
    await ticked.setValue(false)
    await settle()
    expect(ticked.element.checked).toBe(true)
  })

  it('delete goes through the deleteCheck door', async () => {
    const v = withChecks()
    await openPopover(v)
    await body().get('[data-step="stp-4"] [data-test="mission-check-delete"]').trigger('click')
    await settle()
    expect(door).toHaveBeenCalledWith({
      door: 'deleteCheck',
      root: '/repo',
      missionId: v.mission.id,
      stepId: 'stp-4',
      checkId: 'chk-1'
    })
  })

  it('"+ check" adds through the addCheck door; a deduped answer shows no duplicate', async () => {
    const v = withChecks()
    // The server already holds "dsqa done" on the step: it answers deduped, unchanged.
    await openPopover(v, { ok: true, view: v, deduped: true })
    await body().get('[data-step="stp-4"] [data-test="mission-check-add"]').trigger('click')
    const input = body().get('[data-step="stp-4"] [data-test="mission-check-input"]')
    await input.setValue('dsqa done')
    await input.trigger('keydown', { key: 'Enter' })
    await settle()
    expect(door).toHaveBeenCalledWith({
      door: 'addCheck',
      root: '/repo',
      missionId: v.mission.id,
      stepId: 'stp-4',
      label: 'dsqa done'
    })
    const rows = body().findAll('[data-step="stp-4"] [data-test="mission-check"]')
    expect(rows).toHaveLength(2)
    expect(document.body.querySelector('[data-test="mission-check-input"]')).toBeNull()
  })
})

describe('child sessions', () => {
  const CHILD = '00000000-0000-4000-8000-000000000105'

  function linkedTwice(): MissionView {
    const v = fixtureView('parallel')
    v.derived.steps
      .find((s) => s.stepId === 'stp-9')!
      .children.push({ sessionId: CHILD, known: true, taskState: 'idle', pendingApprovals: 0 })
    return v
  }

  it('a child row appears once; the other step says "+1 session"', async () => {
    await openPopover(linkedTwice())
    const rows = body()
      .findAll('[data-test="mission-child"]')
      .filter((r) => r.attributes('data-session') === CHILD)
    expect(rows).toHaveLength(1)
    expect(body().get('[data-step="stp-7"] [data-test="mission-child"]')).toBeTruthy()
    expect(body().get('[data-step="stp-9"] [data-test="mission-child-elsewhere"]').text()).toBe(
      '+1 session'
    )
  })

  it('go-to-session on a session the sidebar has not loaded toasts instead of doing nothing', async () => {
    await openPopover(linkedTwice())
    const sessions = useSessionsStore()
    const activate = vi.spyOn(sessions, 'activateSession')
    await body().get(`[data-session="${CHILD}"] [data-test="mission-child-goto"]`).trigger('click')
    expect(activate).not.toHaveBeenCalled()
    expect(useUiStore().toasts.map((t) => t.title)).toContain('Session not loaded yet')
  })

  it('go-to-session on a loaded session selects it in-app', async () => {
    await openPopover(linkedTwice())
    const sessions = useSessionsStore()
    const folder = sessionFolder()
    folder.sessions[0].sessionId = CHILD
    sessions.folders = [folder]
    const activate = vi.spyOn(sessions, 'activateSession').mockImplementation(() => undefined)
    await body().get(`[data-session="${CHILD}"] [data-test="mission-child-goto"]`).trigger('click')
    expect(activate).toHaveBeenCalledWith(CHILD)
    expect(useUiStore().toasts).toHaveLength(0)
  })

  it('the action is the in-app go-to icon, not an external link', () => {
    const src = readFileSync('src/renderer/src/components/MissionStepRail.vue', 'utf8')
    expect(src).toMatch(/\bLogIn\b/)
    expect(src).not.toMatch(/\bExternalLink\b/)
  })
})

describe('no draft, no Approve', () => {
  it('a legacy draft view renders no draft callout and no Approve button', async () => {
    await openPopover(fixtureView('nothing', { mission: { status: 'draft' } }))
    expect(document.body.querySelector('[data-test="mission-draft-callout"]')).toBeNull()
    expect(document.body.querySelector('[data-test="mission-approve"]')).toBeNull()
    expect(document.body.textContent).not.toMatch(/approve mission|awaiting your approval/i)
  })

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
    expect(block.state).not.toHaveProperty('draft')
    expect(block.sub).not.toHaveProperty('draft')
    expect(keys).not.toMatch(/nothing runs|nada roda/i)
  })
})
