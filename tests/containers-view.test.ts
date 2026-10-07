// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises, DOMWrapper, type VueWrapper } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setActivePinia, createPinia } from 'pinia'
import ContainersView from '../src/renderer/src/components/ContainersView.vue'
import { useUiStore } from '../src/renderer/src/stores/ui'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import { i18n } from '@renderer/i18n'
import { stubTakeoverShellTargets } from './helpers/takeover-shell-stub'
import {
  BULK_TOMB,
  NOW,
  REMOVE_TOMB,
  STOP_TOMB,
  snapshotOf,
  specStacks
} from './helpers/containers-fixtures'
import { cloneGuardedApi } from './helpers/containers-api'
import type { ContainersActResult, ContainersSnapshot, ContainersTombstone } from '../src/preload'

/**
 * T331 — the Containers takeover, mounted over a stubbed U1 IPC. What jsdom
 * can see: markup, classes, which buttons exist and what they send. Layout
 * and pixels are pinned against the approved spec by `mockup-qa` instead.
 */

const REPO = join(import.meta.dirname, '..')
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8')

let containersAct: ReturnType<typeof vi.fn>
/** Fires the `containers:update` push the main process sends after an action. */
let pushSnapshot: (snap: ContainersSnapshot) => void

function stubApi(snap: ContainersSnapshot | null): void {
  containersAct = vi.fn(
    async (req: { verb: ContainersActResult['verb'] }): Promise<ContainersActResult> => ({
      ok: true,
      verb: req.verb,
      results: [],
      tombstone: null
    })
  )
  const api = {
    containersSnapshot: vi.fn(async () => snap),
    containersScan: vi.fn(async () => snap ?? snapshotOf([])),
    containersAct,
    onContainersUpdate: (cb: (snap: ContainersSnapshot) => void) => {
      pushSnapshot = cb
      return () => {}
    }
  }
  ;(window as unknown as { api: unknown }).api = cloneGuardedApi(api)
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await flushPromises()
}

async function mountView(snap: ContainersSnapshot | null): Promise<VueWrapper> {
  stubApi(snap)
  stubTakeoverShellTargets()
  const wrapper = mount(ContainersView, { global: { plugins: [i18n] }, attachTo: document.body })
  await settle()
  return wrapper
}

function body(): DOMWrapper<Element> {
  return new DOMWrapper(document.body)
}

async function selectRow(wrapper: VueWrapper, id: string): Promise<void> {
  await wrapper.get(`[data-stack="${id}"]`).trigger('click')
  await settle()
}

function tierButtons(wrapper: VueWrapper): Array<{ text: string; disabled: boolean }> {
  return wrapper
    .findAll('[data-testid^="containers-tier-"]')
    .map((b) => ({ text: b.text(), disabled: (b.element as HTMLButtonElement).disabled }))
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
})

describe('AC-2: the view', () => {
  it('renders the hero, the three sections and the bulk button', async () => {
    const wrapper = await mountView(snapshotOf(specStacks(), [STOP_TOMB]))
    const text = wrapper.text()
    expect(text).toContain('RAM freed by stopping zombie stacks')
    expect(text).toContain('788 MB') // proj-82: 612 + 176
    expect(text).toContain('host ports released')
    expect(text).toContain('in volumes — removal needs your confirm')
    expect(text).toContain('Needs you')
    expect(text).toContain('Leave alone')
    expect(text).toContain('Recent')
    expect(wrapper.get('[data-testid="containers-stop-running"]').text()).toBe('Stop 1 running')
    expect(wrapper.get('[data-dsqa="containers-view"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('reads "zombie in Nd" on a pending row (provisional AC-12) and lists it under Leave alone', async () => {
    const wrapper = await mountView(snapshotOf(specStacks()))
    const row = wrapper.get('[data-stack="proj-44"]')
    expect(row.text()).toContain('zombie in 2d')
    const html = wrapper.html()
    expect(html.indexOf('Leave alone')).toBeLessThan(html.indexOf('data-stack="proj-44"'))
    wrapper.unmount()
  })

  it('shows the scanning state before the first snapshot', async () => {
    stubApi(null)
    ;(window as unknown as { api: { containersScan: unknown } }).api.containersScan = vi.fn(
      () => new Promise(() => {})
    )
    stubTakeoverShellTargets()
    const wrapper = mount(ContainersView, { global: { plugins: [i18n] } })
    await settle()
    expect(wrapper.get('[data-dsqa="containers-view--scanning"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('reading docker…')
    expect(wrapper.text()).toContain('Scanning…')
    wrapper.unmount()
  })

  it("shows the docker-unavailable state with docker's error", async () => {
    const wrapper = await mountView({
      scannedAt: NOW,
      dockerAvailable: false,
      dockerError: 'docker CLI not found on PATH',
      zombieAfterDays: 2,
      recent: []
    })
    expect(wrapper.get('[data-dsqa="containers-view--docker-unavailable"]').exists()).toBe(true)
    expect(wrapper.text()).toContain("Docker isn't reachable")
    expect(wrapper.text()).toContain('docker CLI not found on PATH')
    wrapper.unmount()
  })

  it('switches the hero to "nothing to stop" when no Needs-you stack runs', async () => {
    const stacks = specStacks().filter((s) => s.id !== 'proj-82')
    const wrapper = await mountView(snapshotOf(stacks))
    expect(wrapper.find('[data-dsqa="containers-hero--nothing-to-stop"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('RAM held by zombie stacks')
    expect(wrapper.find('[data-testid="containers-stop-running"]').exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('AC-3/AC-4: the detail pane offers exactly what each verdict allows', () => {
  it('running zombie: Stop stack + Remove… disabled, captioned "Stop it first"', async () => {
    const wrapper = await mountView(snapshotOf(specStacks()))
    expect(tierButtons(wrapper)).toEqual([
      { text: 'Stop stack', disabled: false },
      { text: 'Remove…', disabled: true }
    ])
    expect(wrapper.text()).toContain('Stop it first')
    expect(wrapper.text()).toContain('Unused for')
    wrapper.unmount()
  })

  it('stopped zombie: Start stack + an enabled Remove…', async () => {
    const wrapper = await mountView(snapshotOf(specStacks()))
    await selectRow(wrapper, 'proj-11')
    expect(wrapper.find('[data-dsqa="containers-detail--exited"]').exists()).toBe(true)
    expect(tierButtons(wrapper)).toEqual([
      { text: 'Start stack', disabled: false },
      { text: 'Remove…', disabled: false }
    ])
    wrapper.unmount()
  })

  it('orphan: only Remove…, no nav target', async () => {
    const wrapper = await mountView(snapshotOf(specStacks()))
    await selectRow(wrapper, 'proj-27')
    expect(wrapper.find('[data-dsqa="containers-detail--orphan"]').exists()).toBe(true)
    expect(tierButtons(wrapper)).toEqual([{ text: 'Remove…', disabled: false }])
    expect(wrapper.text()).toContain('no — the directory was deleted')
    expect(wrapper.text()).not.toContain('Open worktree')
    wrapper.unmount()
  })

  it("active: Stop stack sends force:true and warns the session's app goes down", async () => {
    const wrapper = await mountView(snapshotOf(specStacks()))
    await selectRow(wrapper, 'proj-71')
    expect(wrapper.text()).toContain("The session's app goes down with it")
    await wrapper.get('[data-testid="containers-tier-stop"]').trigger('click')
    await settle()
    expect(containersAct).toHaveBeenCalledWith({ verb: 'stop', stacks: ['proj-71'], force: true })
    wrapper.unmount()
  })

  it('protected: Stop stack sends force:true, no Remove', async () => {
    const wrapper = await mountView(snapshotOf(specStacks()))
    await selectRow(wrapper, 'proj-20')
    expect(tierButtons(wrapper)).toEqual([{ text: 'Stop stack', disabled: false }])
    await wrapper.get('[data-testid="containers-tier-stop"]').trigger('click')
    await settle()
    expect(containersAct).toHaveBeenCalledWith({ verb: 'stop', stacks: ['proj-20'], force: true })
    wrapper.unmount()
  })

  it('pending: the protected pane without the shield, manual Stop without force, no Remove', async () => {
    const wrapper = await mountView(snapshotOf(specStacks()))
    await selectRow(wrapper, 'proj-44')
    expect(wrapper.find('[data-dsqa="containers-detail--pending"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('No session has used this stack for 20 hours.')
    expect(wrapper.text()).toContain('It becomes a zombie after 2 days.')
    expect(tierButtons(wrapper)).toEqual([{ text: 'Stop stack', disabled: false }])
    await wrapper.get('[data-testid="containers-tier-stop"]').trigger('click')
    await settle()
    expect(containersAct).toHaveBeenCalledWith({ verb: 'stop', stacks: ['proj-44'] })
    wrapper.unmount()
  })

  it('unknown: no actions at all', async () => {
    const wrapper = await mountView(snapshotOf(specStacks()))
    await selectRow(wrapper, 'postgres-scratch')
    expect(wrapper.find('[data-dsqa="containers-detail--unknown"]').exists()).toBe(true)
    expect(tierButtons(wrapper)).toEqual([])
    wrapper.unmount()
  })
})

describe('AC-4: actions', () => {
  it('"Stop N running" asks nothing and sends { verb: stop, bulk: true }', async () => {
    const wrapper = await mountView(snapshotOf(specStacks()))
    await wrapper.get('[data-testid="containers-stop-running"]').trigger('click')
    await settle()
    expect(containersAct).toHaveBeenCalledTimes(1)
    expect(containersAct).toHaveBeenCalledWith({ verb: 'stop', bulk: true })
    expect(body().find('[role="dialog"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('the hover quick-stop exists on running Needs-you rows only, and stops without selecting', async () => {
    const wrapper = await mountView(snapshotOf(specStacks()))
    const quick = wrapper.findAll('[data-testid="containers-quick-stop"]')
    expect(quick).toHaveLength(1)
    expect(
      wrapper.get('[data-stack="proj-82"]').find('[data-testid="containers-quick-stop"]').exists()
    ).toBe(true)
    await selectRow(wrapper, 'proj-20')
    await wrapper
      .get('[data-stack="proj-82"] [data-testid="containers-quick-stop"]')
      .trigger('click')
    await settle()
    expect(containersAct).toHaveBeenCalledWith({ verb: 'stop', stacks: ['proj-82'] })
    expect(wrapper.get('[data-stack="proj-20"]').attributes('aria-pressed')).toBe('true')
    wrapper.unmount()
  })

  it('Enter/Space on a focused quick-stop stay with the button and never select the row', async () => {
    const wrapper = await mountView(snapshotOf(specStacks()))
    await selectRow(wrapper, 'proj-20')
    const button = wrapper.get(
      '[data-stack="proj-82"] [data-testid="containers-quick-stop"]'
    ).element
    for (const key of ['Enter', ' ']) {
      const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
      button.dispatchEvent(ev)
      await settle()
      // The row's handler must not cancel the button's own activation.
      expect(ev.defaultPrevented).toBe(false)
    }
    expect(wrapper.get('[data-stack="proj-20"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.get('[data-stack="proj-82"]').attributes('aria-pressed')).toBe('false')
    wrapper.unmount()
  })

  it('Remove… opens the dialog with the volume UNCHECKED and sends removeVolumes:false', async () => {
    const wrapper = await mountView(snapshotOf(specStacks()))
    await selectRow(wrapper, 'proj-27')
    await wrapper.get('[data-testid="containers-tier-remove"]').trigger('click')
    await settle()

    const dialog = body().get('[data-dsqa="containers-remove-dialog--orphan"]')
    expect(dialog.text()).toContain('Remove proj-27?')
    expect(dialog.text()).toContain('Its worktree no longer exists.')
    expect(dialog.text()).toContain('proj-27_mysql')
    const box = body().get('[data-testid="containers-remove-volume"]').element as HTMLInputElement
    expect(box.checked).toBe(false)
    expect(containersAct).not.toHaveBeenCalled()

    await body().get('[data-testid="containers-remove-confirm"]').trigger('click')
    await settle()
    expect(containersAct).toHaveBeenCalledWith({
      verb: 'remove',
      stack: 'proj-27',
      removeVolumes: false
    })
    wrapper.unmount()
  })

  it('the zombie variant of the dialog says the worktree still exists', async () => {
    const wrapper = await mountView(snapshotOf(specStacks()))
    await selectRow(wrapper, 'proj-11')
    await wrapper.get('[data-testid="containers-tier-remove"]').trigger('click')
    await settle()
    const dialog = body().get('[data-dsqa="containers-remove-dialog--zombie"]')
    expect(dialog.text()).toContain('Its worktree still exists')
    wrapper.unmount()
  })

  it("AC-5: a failed stop shows docker's error inline and offers Try again", async () => {
    const wrapper = await mountView(snapshotOf(specStacks()))
    containersAct.mockResolvedValueOnce({
      ok: false,
      verb: 'stop',
      results: [
        {
          stack: 'proj-82',
          ok: false,
          error: 'DOCKER_FAILED',
          message: 'Error response from daemon: cannot stop container: permission denied',
          containerIds: [],
          freedBytes: 0,
          portsReleased: [],
          removedContainers: [],
          removedVolumes: [],
          keptVolumes: []
        }
      ],
      tombstone: null
    })
    await wrapper.get('[data-testid="containers-tier-stop"]').trigger('click')
    await settle()
    expect(wrapper.find('[data-dsqa="containers-detail--failed"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('Stop failed. Nothing changed')
    expect(wrapper.text()).toContain('cannot stop container: permission denied')
    expect(tierButtons(wrapper)[0]?.text).toBe('Try again')
    wrapper.unmount()
  })
})

describe('AC-6: Recent — one entry per action', () => {
  it('a single stop shows the undo command and Start stack', async () => {
    const wrapper = await mountView(snapshotOf(specStacks(), [STOP_TOMB, BULK_TOMB, REMOVE_TOMB]))
    const rows = wrapper
      .findAll('[aria-pressed]')
      .filter((r) => r.text().includes('ago') || r.text().includes('just now'))
    expect(rows).toHaveLength(3)
    await rows.find((r) => r.text().includes('proj-54'))!.trigger('click')
    await settle()
    expect(wrapper.find('[data-dsqa="containers-detail--recent"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('To undo')
    expect(wrapper.text()).toContain('docker start 3f9a1c 8b2e44')
    expect(wrapper.get('[data-testid="containers-tier-start-recent"]').text()).toBe('Start stack')
    wrapper.unmount()
  })

  it('a bulk stop is ONE entry, undone with "Start all N"', async () => {
    const wrapper = await mountView(snapshotOf(specStacks(), [BULK_TOMB]))
    const row = wrapper.findAll('[aria-pressed]').find((r) => r.text().includes('3 stacks'))!
    expect(row.text()).toContain('stopped')
    await row.trigger('click')
    await settle()
    expect(wrapper.find('[data-dsqa="containers-detail--recent-bulk"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('stopped 3 stacks · 9 containers')
    expect(wrapper.get('[data-testid="containers-tier-start-recent"]').text()).toBe('Start all 3')
    wrapper.unmount()
  })

  it('a removal shows the copyable recreate command and no Start', async () => {
    const wrapper = await mountView(snapshotOf(specStacks(), [REMOVE_TOMB]))
    await wrapper
      .findAll('[aria-pressed]')
      .find((r) => r.text().includes('proj-19'))!
      .trigger('click')
    await settle()
    expect(wrapper.find('[data-dsqa="containers-detail--recent-removed"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('To bring it back')
    expect(wrapper.text()).toContain('docker compose --project-directory')
    expect(wrapper.find('[title="Copy command"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="containers-tier-start-recent"]').exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('AC-2/AC-6: the volume fate of a removal comes from the tombstone', () => {
  it('the Recent row reads "removed · volume kept" and the detail names the kept volume', async () => {
    const wrapper = await mountView(snapshotOf(specStacks(), [REMOVE_TOMB]))
    const row = wrapper.findAll('[aria-pressed]').find((r) => r.text().includes('proj-19'))!
    expect(row.text()).toContain('removed · volume kept')
    await row.trigger('click')
    await settle()
    const detail = wrapper.get('[data-dsqa="containers-detail--recent-removed"]')
    expect(detail.text()).toContain('removed 4 containers · volume kept')
    expect(detail.text()).toContain('Volume kept')
    expect(detail.text()).toContain('proj-19_mysql')
    expect(detail.text()).toContain('233.5 MB')
    expect(detail.text()).toContain('reattaches the kept volume')
    wrapper.unmount()
  })

  it('a journal line from before keptVolumes existed reads plain "removed"', async () => {
    const legacy = {
      ...REMOVE_TOMB,
      stacks: [{ ...REMOVE_TOMB.stacks[0]!, keptVolumes: undefined, keptVolumeBytes: undefined }]
    }
    const wrapper = await mountView(snapshotOf(specStacks(), [legacy]))
    const row = wrapper.findAll('[aria-pressed]').find((r) => r.text().includes('proj-19'))!
    expect(row.text()).toContain('removed')
    expect(row.text()).not.toContain('volume kept')
    wrapper.unmount()
  })
})

describe('AC-7: navigation from a stack reaches the right Harnu target', () => {
  function stubSessions(): {
    activate: ReturnType<typeof vi.spyOn>
    jump: ReturnType<typeof vi.spyOn>
  } {
    const sessions = useSessionsStore()
    vi.spyOn(sessions, 'findSessionById').mockImplementation(
      (id: string) => ({ sessionId: id }) as unknown as ReturnType<typeof sessions.findSessionById>
    )
    vi.spyOn(sessions, 'findFolderByPath').mockImplementation(
      (path: string) => ({ path }) as unknown as ReturnType<typeof sessions.findFolderByPath>
    )
    const activate = vi.spyOn(sessions, 'activateSession').mockImplementation(() => {})
    const jump = vi.spyOn(sessions, 'jumpToFolder').mockImplementation(() => {})
    return { activate, jump }
  }

  function navButton(wrapper: VueWrapper, label: string): DOMWrapper<Element> {
    const b = wrapper.findAll('button').find((x) => x.text() === label)
    expect(b, `no "${label}" button`).toBeDefined()
    return b!
  }

  it('active: "Go to session" activates the live session; "Open worktree" focuses its folder', async () => {
    const { activate, jump } = stubSessions()
    const wrapper = await mountView(snapshotOf(specStacks()))
    await selectRow(wrapper, 'proj-71')
    await navButton(wrapper, 'Go to session').trigger('click')
    expect(activate).toHaveBeenCalledWith('session-71')
    await navButton(wrapper, 'Open worktree').trigger('click')
    expect(jump).toHaveBeenCalledWith('/home/dev/Workspace/org/proj/www/worktrees/proj-71')
    wrapper.unmount()
  })

  it('protected: "Open folder" focuses the main checkout', async () => {
    const { activate, jump } = stubSessions()
    const wrapper = await mountView(snapshotOf(specStacks()))
    await selectRow(wrapper, 'proj-20')
    expect(wrapper.findAll('button').some((b) => b.text() === 'Go to session')).toBe(false)
    await navButton(wrapper, 'Open folder').trigger('click')
    expect(jump).toHaveBeenCalledWith('/home/dev/Workspace/org/proj/www')
    expect(activate).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('orphan and unknown offer no navigation, even when Harnu knows every folder', async () => {
    stubSessions()
    const wrapper = await mountView(snapshotOf(specStacks()))
    for (const id of ['proj-27', 'postgres-scratch']) {
      await selectRow(wrapper, id)
      const labels = wrapper.findAll('button').map((b) => b.text())
      for (const nav of ['Go to session', 'Open worktree', 'Open folder']) {
        expect(labels, `${id} offers ${nav}`).not.toContain(nav)
      }
    }
    wrapper.unmount()
  })
})

describe('AC-1: registration', () => {
  it('opening Containers closes any other takeover, and vice versa', () => {
    const ui = useUiStore()
    ui.openCleanup()
    ui.openContainers()
    expect(ui.activeView?.id).toBe('containers')
    expect(ui.cleanupOpen).toBe(false)
    ui.openScheduler()
    expect(ui.containersOpen).toBe(false)
  })

  it('the footer toggle opens and closes it', () => {
    const ui = useUiStore()
    ui.toggleContainers()
    expect(ui.containersOpen).toBe(true)
    ui.toggleContainers()
    expect(ui.activeView).toBeNull()
  })

  it('a notification target can open it', () => {
    const ui = useUiStore()
    ui.openNavigableView('containers')
    expect(ui.containersOpen).toBe(true)
  })

  it('TakeoverHost maps it, App.vue gates it, StatusFooter toggles it', () => {
    expect(read('src/renderer/src/components/TakeoverHost.vue')).toContain(
      'containers: ContainersView'
    )
    expect(read('src/renderer/src/App.vue')).toMatch(/showContainers\.value \|\|/)
    // T443: the Containers footer pill is gone; the single Cleanup pill replaced it (and the old
    // Cleanup pill), and the inspector stays reachable from the entry points that open it.
    const footer = read('src/renderer/src/components/StatusFooter.vue')
    expect(footer).not.toContain('containersCount')
    expect(footer).not.toContain('ui.toggleContainers()')
    expect(footer).toContain('ui.toggleCleanup()')
    expect(footer.match(/data-dsqa="cleanup-footer-pill"/g)).toHaveLength(1)
  })
})

describe('AC-10: copy', () => {
  it('the containers copy never says "idle", in any locale', () => {
    for (const file of ['src/renderer/src/i18n/en.json', 'src/renderer/src/i18n/pt-BR.json']) {
      const block = JSON.stringify(JSON.parse(read(file)).containers)
      expect(block.toLowerCase(), file).not.toContain('idle')
    }
  })

  it('uses the operator-decided wording', () => {
    const en = JSON.parse(read('src/renderer/src/i18n/en.json')).containers
    expect(en.stopRunning).toBe('Stop {n} running')
    expect(en.evidence.unusedFor).toBe('Unused for')
    expect(en.verdict.zombie).toBe('zombie')
  })

  it('T341 AC-7: every sweep key exists in both locales', () => {
    const locales = ['src/renderer/src/i18n/en.json', 'src/renderer/src/i18n/pt-BR.json'].map(
      (f) => JSON.parse(read(f)).containers
    )
    for (const c of locales) {
      expect(Object.keys(c.sweepDialog).sort()).toEqual([
        'body',
        // BUG-137: the mismatch line, at parity like every other sweep key.
        'changed',
        'failedStack',
        // BUG-139: the in-dialog twin of `changed`, when the set moved before
        // main was ever asked.
        'moved',
        'partial',
        'stackContainers',
        'title',
        'volumes'
      ])
      expect(typeof c.refusal.SWEEP_SET_CHANGED).toBe('string')
      expect(typeof c.sweep).toBe('string')
      expect(typeof c.sweeping).toBe('string')
      expect(typeof c.failed.refused.sweep).toBe('string')
    }
    // The label the operator picked (provisional, T341), in the source of truth.
    const en = locales[0]
    expect(en.sweep).toBe('Clean up {n} stack | Clean up {n} stacks')
    expect(en.sweepDialog.title).toBe('Clean up {n} stack? | Clean up {n} stacks?')
    expect(en.dialog.confirm).toBe('Remove {n} container | Remove {n} containers')
  })

  it('the Containers components hold no hardcoded English in their templates', () => {
    for (const f of [
      'ContainersView.vue',
      'ContainersDetail.vue',
      'ContainersRemoveDialog.vue',
      'ContainersSweepDialog.vue'
    ]) {
      const src = read(`src/renderer/src/components/${f}`)
      const template = src.slice(src.indexOf('<template>'))
      // Visible text lives in $t: a bare word between tags is a leaked literal.
      expect(template, f).not.toMatch(/>\s*[A-Z][a-z]+(?: [a-z]+)*\s*</)
    }
  })
})

describe('T443: the mass clean now lives in Cleanup', () => {
  it('shows one button beside the unchanged bulk stop, counting every zombie and orphan', async () => {
    const wrapper = await mountView(snapshotOf(specStacks()))
    // proj-82 + proj-11 (zombie) + proj-27 (orphan); nothing else is eligible.
    expect(wrapper.find('[data-testid="containers-sweep"]').exists()).toBe(true)
    // The count is the pluralized message's argument, not a tick-list: no checkbox is drawn.
    expect(wrapper.find('[data-testid="containers-select-stack"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="containers-select-all"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="containers-stop-running"]').text()).toBe('Stop 1 running')
    wrapper.unmount()
  })

  it('is absent during the first scan and absent when nothing is eligible', async () => {
    stubApi(null)
    ;(window as unknown as { api: { containersScan: unknown } }).api.containersScan = vi.fn(
      () => new Promise(() => {})
    )
    stubTakeoverShellTargets()
    const scanning = mount(ContainersView, { global: { plugins: [i18n] } })
    await settle()
    expect(scanning.find('[data-testid="containers-sweep"]').exists()).toBe(false)
    scanning.unmount()

    const clean = await mountView(
      snapshotOf(specStacks().filter((s) => s.verdict !== 'zombie' && s.verdict !== 'orphan'))
    )
    expect(clean.find('[data-testid="containers-sweep"]').exists()).toBe(false)
    clean.unmount()
  })

  it('routes to Cleanup instead of opening a dialog or sending a sweep', async () => {
    const wrapper = await mountView(snapshotOf(specStacks()))
    const ui = useUiStore()
    expect(ui.cleanupOpen).toBe(false)
    await wrapper.get('[data-testid="containers-sweep"]').trigger('click')
    await settle()
    // One cleanup door: Cleanup opens, the Containers takeover gives way to it, and the view
    // itself neither opens a confirm nor asks main to clean anything.
    expect(ui.cleanupOpen).toBe(true)
    expect(ui.containersOpen).toBe(false)
    expect(body().find('[data-dsqa="containers-sweep-dialog"]').exists()).toBe(false)
    expect(containersAct).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('the view no longer carries the sweep dialog or its tick-list', () => {
    const view = read('src/renderer/src/components/ContainersView.vue')
    expect(view).not.toContain('ContainersSweepDialog')
    expect(view).not.toContain('tickedStacks')
    expect(view).toContain('ui.openCleanup()')
  })
})

describe('T341 AC-5: after the sweep', () => {
  it('drops the swept stacks and shows ONE Recent entry reading as a multi-stack removal', async () => {
    const before = specStacks()
    const wrapper = await mountView(snapshotOf(before))
    for (const id of ['proj-82', 'proj-11', 'proj-27']) {
      expect(wrapper.find(`[data-stack="${id}"]`).exists(), id).toBe(true)
    }

    const sweepTomb: ContainersTombstone = {
      at: NOW - 1000,
      actor: 'operator',
      verb: 'sweep',
      stacks: ['proj-82', 'proj-11', 'proj-27'].map((id) => ({
        stack: id,
        name: id,
        path: `/home/dev/Workspace/org/proj/www/worktrees/${id}`,
        containerIds: [`${id}-1`],
        freed: { ramBytes: 0, ports: [], volumes: [], volumeBytes: 0 },
        keptVolumes: [`${id}_mysql`],
        keptVolumeBytes: 1_000_000
      })),
      restoreHint: null
    }
    pushSnapshot(
      snapshotOf(
        before.filter((s) => !['proj-82', 'proj-11', 'proj-27'].includes(s.id)),
        [sweepTomb]
      )
    )
    await settle()

    for (const id of ['proj-82', 'proj-11', 'proj-27']) {
      expect(wrapper.find(`[data-stack="${id}"]`).exists(), id).toBe(false)
    }
    // One journal line per action, so one row — and it reads as a removal.
    const recent = wrapper.findAll('[aria-pressed]').filter((r) => r.text().includes('removed'))
    expect(recent).toHaveLength(1)
    expect(recent[0].text()).toContain('3 stacks')
    expect(recent[0].text()).toContain('removed · volume kept')
    // Nothing is left to sweep, so the button is gone.
    expect(wrapper.find('[data-testid="containers-sweep"]').exists()).toBe(false)
    wrapper.unmount()
  })
})
