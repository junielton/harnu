// @vitest-environment jsdom
/**
 * T305 — `SchedulerPromptField.vue`, mounted.
 *
 * The popup, the chip row, and the one rule that keeps them correct: the chips
 * are a VIEW of the prompt string. Nothing here ever writes a `skills` array —
 * the only thing the field emits is the prompt text itself.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { nextTick } from 'vue'
import SchedulerPromptField from '../src/renderer/src/components/SchedulerPromptField.vue'
import SchedulerWorkerDetail from '../src/renderer/src/components/SchedulerWorkerDetail.vue'
import { i18n } from '@renderer/i18n'
import { useSchedulerStore } from '../src/renderer/src/stores/scheduler'
import type { AvailableSkill, Worker } from '../src/preload'

const SKILLS: AvailableSkill[] = [
  { name: 'deploy', description: 'project deploy', origin: 'project' },
  { name: 'land-prs', description: 'personal land-prs', origin: 'personal' },
  { name: 'status', description: 'bundled status', origin: 'bundled' }
]

/**
 * Mounted with the write-back a real parent does (`scheduler.save` echoes the
 * patch into the store synchronously), so the field sees its own edits.
 */
function mountField(modelValue = '') {
  const wrapper = mount(SchedulerPromptField, {
    props: {
      modelValue,
      skills: SKILLS,
      placeholder: 'p',
      'onUpdate:modelValue': (v: string) => wrapper.setProps({ modelValue: v })
    },
    global: { plugins: [i18n] },
    attachTo: document.body
  })
  return wrapper
}

/** Drive the textarea the way a person does: set value + caret, then `input`. */
async function type(
  wrapper: ReturnType<typeof mountField>,
  text: string,
  caret = text.length
): Promise<void> {
  const el = wrapper.find('textarea').element as HTMLTextAreaElement
  el.value = text
  el.setSelectionRange(caret, caret)
  await wrapper.find('textarea').trigger('input')
  await nextTick()
}

const popup = (w: ReturnType<typeof mountField>) => w.find('[data-dsqa="skill-mention-popup"]')
/** A row is `<span>name</span><span>origin</span>` — read them as two fields. */
const rowText = (r: { findAll: (s: string) => { text: () => string }[] }): string =>
  r
    .findAll('span')
    .map((s) => s.text())
    .join(' ')
const chips = (w: ReturnType<typeof mountField>) => w.findAll('[data-skill-chip]')

describe('SchedulerPromptField — the / popup (AC-1)', () => {
  it('opens when / is typed at the start of the field', async () => {
    const w = mountField()
    await type(w, '/')
    expect(popup(w).exists()).toBe(true)
  })

  it('opens when / is typed after whitespace', async () => {
    const w = mountField()
    await type(w, 'run /')
    expect(popup(w).exists()).toBe(true)
  })

  it('stays SHUT for a / inside a path', async () => {
    const w = mountField()
    await type(w, 'look at src/')
    expect(popup(w).exists()).toBe(false)
    await type(w, 'look at src/main/')
    expect(popup(w).exists()).toBe(false)
  })

  it('closes again on a space', async () => {
    const w = mountField()
    await type(w, 'run /land-prs')
    expect(popup(w).exists()).toBe(true)
    await type(w, 'run /land-prs ')
    expect(popup(w).exists()).toBe(false)
  })

  it('AC-2: each row carries the origin it would be staged from', async () => {
    const w = mountField()
    await type(w, '/')
    const rows = popup(w).findAll('[role="option"]')
    expect(rows.map((r) => rowText(r))).toEqual([
      'deploy project',
      'land-prs personal',
      'status bundled'
    ])
  })

  it('filters to what has been typed, and says so when nothing matches', async () => {
    const w = mountField()
    await type(w, '/lan')
    expect(
      popup(w)
        .findAll('[role="option"]')
        .map((r) => rowText(r))
    ).toEqual(['land-prs personal'])
    await type(w, '/zzz')
    expect(popup(w).findAll('[role="option"]')).toHaveLength(0)
    expect(popup(w).text()).toContain('No skill matches')
  })

  it('Escape dismisses without touching the prompt', async () => {
    const w = mountField()
    await type(w, 'run /lan')
    await w.find('textarea').trigger('keydown', { key: 'Escape' })
    await nextTick()
    expect(popup(w).exists()).toBe(false)
    expect(w.emitted('update:modelValue')?.at(-1)).toEqual(['run /lan'])
  })
})

describe('SchedulerPromptField — picking (AC-4)', () => {
  it('inserts the literal skill name into the prompt text', async () => {
    const w = mountField()
    await type(w, 'run /lan')
    await popup(w).findAll('[role="option"]')[0].trigger('mousedown')
    await flushPromises()
    const emitted = w.emitted('update:modelValue')?.at(-1) as [string]
    expect(emitted[0]).toBe('run /land-prs ')
    expect(emitted[0]).toContain('land-prs')
  })

  it('picks the highlighted row on Enter', async () => {
    const w = mountField()
    await type(w, '/')
    await w.find('textarea').trigger('keydown', { key: 'ArrowDown' })
    await w.find('textarea').trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect((w.emitted('update:modelValue')?.at(-1) as [string])[0]).toBe('/land-prs ')
  })

  it('AC-5: every value it ever emits is the prompt string, nothing else', async () => {
    const w = mountField()
    await type(w, '/')
    await popup(w).findAll('[role="option"]')[0].trigger('mousedown')
    await flushPromises()
    const emissions = w.emitted('update:modelValue') as [string][]
    expect(emissions.length).toBeGreaterThan(0)
    for (const payload of emissions) {
      expect(payload).toHaveLength(1)
      expect(typeof payload[0]).toBe('string')
    }
  })
})

describe('SchedulerPromptField — the chip row (AC-5, AC-6)', () => {
  it('renders one chip per mention, tagged with its origin', async () => {
    const w = mountField('run /land-prs then /deploy')
    expect(chips(w).map((c) => c.attributes('data-skill-chip'))).toEqual(['personal', 'project'])
    expect(chips(w)[0].text()).toContain('land-prs')
    expect(chips(w)[0].text()).toContain('personal')
  })

  it('AC-6: a mention that resolves to nothing renders as a warning chip', async () => {
    const w = mountField('run /ghost-skill')
    expect(chips(w)).toHaveLength(1)
    expect(chips(w)[0].attributes('data-skill-chip')).toBe('not-found')
    expect(chips(w)[0].text()).toContain('not found')
    expect(chips(w)[0].classes()).toContain('text-warning')
    expect(chips(w)[0].classes()).toContain('bg-red-soft')
  })

  it('AC-5: deleting the text by hand removes the chip', async () => {
    const w = mountField('run /land-prs')
    expect(chips(w)).toHaveLength(1)
    await w.setProps({ modelValue: 'run ' })
    expect(chips(w)).toHaveLength(0)
  })

  it('AC-5: typing a name by hand adds the chip, with no picker involved', async () => {
    const w = mountField('')
    expect(chips(w)).toHaveLength(0)
    await w.setProps({ modelValue: 'run /deploy' })
    expect(chips(w).map((c) => c.attributes('data-skill-chip'))).toEqual(['project'])
  })

  it('does not flash a "not found" chip for the name still being typed', async () => {
    const w = mountField('run ')
    await type(w, 'run /la')
    // The popup is open on `la`; the chip row must not accuse it of not existing.
    expect(popup(w).exists()).toBe(true)
    expect(chips(w)).toHaveLength(0)
    // Move the caret away and it is a mention like any other.
    await type(w, 'run /la ')
    expect(chips(w).map((c) => c.attributes('data-skill-chip'))).toEqual(['not-found'])
  })

  it('renders no chip row at all when the prompt names nothing', () => {
    const w = mountField('just watch the repo')
    expect(w.find('[data-dsqa="skill-chips"]').exists()).toBe(false)
  })
})

// ── the folder → list refresh, which only the parent can drive ───────────────

const skillsAvailable = vi.fn()
const bundledSkillsGet = vi.fn()
const bundledSkillsGetFolder = vi.fn()

const WORKER: Worker = {
  id: 'w1',
  name: 'PR watcher',
  enabled: true,
  prompt: 'Check for new PRs.',
  folder: '/repo/alpha',
  everyMinutes: 5,
  runOnBoot: false,
  model: 'haiku',
  effort: 'low',
  mode: 'observe',
  timeoutSeconds: 300,
  carryLastResult: false,
  failureStreak: 0
}

describe('SchedulerWorkerDetail — the list is folder-dependent (AC-3)', () => {
  beforeEach(() => {
    skillsAvailable.mockReset()
    skillsAvailable.mockResolvedValue(SKILLS)
    bundledSkillsGet.mockResolvedValue({
      version: '1',
      catalog: [{ name: 'status', description: '' }],
      enabled: { status: true },
      userLevelInstall: {},
      collisions: []
    })
    bundledSkillsGetFolder.mockResolvedValue({})
    const api = {
      skillsAvailable,
      bundledSkillsGet,
      bundledSkillsGetFolder,
      schedulerRuns: vi.fn(async () => []),
      claudeConfigGetGlobal: vi.fn(async () => ({})),
      claudeConfigListEndpoints: vi.fn(async () => [])
    }
    ;(window as unknown as { api: unknown }).api = new Proxy(api, {
      get: (t: Record<string, unknown>, k: string) => (k in t ? t[k] : () => () => {})
    })
    setActivePinia(createPinia())
  })

  it('re-reads the union when the Folder field changes', async () => {
    const wrapper = mount(SchedulerWorkerDetail, {
      props: { worker: WORKER, running: false, nowMs: Date.now() },
      global: { plugins: [i18n] }
    })
    await flushPromises()
    expect(skillsAvailable).toHaveBeenCalledWith('/repo/alpha')

    await wrapper.setProps({ worker: { ...WORKER, folder: '/repo/beta' } })
    await flushPromises()
    expect(skillsAvailable).toHaveBeenLastCalledWith('/repo/beta')
    expect(skillsAvailable).toHaveBeenCalledTimes(2)
  })

  it('AC-5: editing the prompt persists the PROMPT and nothing else', async () => {
    const store = useSchedulerStore()
    const save = vi.spyOn(store, 'save').mockImplementation(() => {})
    const wrapper = mount(SchedulerWorkerDetail, {
      props: { worker: WORKER, running: false, nowMs: Date.now() },
      global: { plugins: [i18n] }
    })
    await flushPromises()
    ;(wrapper.vm as unknown as { openSettingsAndFocusName: () => void }).openSettingsAndFocusName()
    await flushPromises()

    const textarea = wrapper.find('[data-dsqa="worker-prompt-field"] textarea')
    ;(textarea.element as HTMLTextAreaElement).value = 'run /land-prs'
    await textarea.trigger('input')
    await flushPromises()

    expect(save).toHaveBeenCalledWith('w1', { prompt: 'run /land-prs' })
    for (const [, patch] of save.mock.calls) {
      expect(Object.keys(patch as object)).not.toContain('skills')
    }
  })
})
