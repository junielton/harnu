// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import NewWorktreeDialog from '../src/renderer/src/components/NewWorktreeDialog.vue'
import en from '../src/renderer/src/i18n/en.json'
import { useUiStore } from '../src/renderer/src/stores/ui'

/**
 * Covers the slugify strip only (`design.md §6` → "New worktree" → Slugify
 * strip): when it shows, what it suggests, and that applying it rewrites the
 * branch input and makes the strip go away.
 */

const REPO = '/tmp/repo'

const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } })

function stubApi(): void {
  // Only what the dialog reaches for on open. The plan dry-run stays pending
  // forever — the strip is independent of it.
  ;(globalThis as unknown as { window: Window }).window.api = {
    worktreeBranches: vi.fn().mockResolvedValue([]),
    worktreePlan: vi.fn().mockReturnValue(new Promise(() => {})),
    worktreeInheritOffer: vi.fn().mockResolvedValue(false),
    onWorktreeProgress: vi.fn().mockReturnValue(() => {}),
    worktreeCreate: vi.fn().mockReturnValue(new Promise(() => {}))
  } as unknown as Window['api']
}

let wrappers: VueWrapper[] = []

async function openDialog(): Promise<VueWrapper> {
  const w = mount(NewWorktreeDialog, {
    global: { plugins: [i18n], stubs: { Teleport: true } }
  })
  wrappers.push(w)
  const ui = useUiStore()
  ui.dialog = 'newWorktree'
  ui.newWorktreePath = REPO
  await w.vm.$nextTick()
  await w.vm.$nextTick()
  return w
}

function branchInput(w: VueWrapper): ReturnType<VueWrapper['get']> {
  return w.get('#new-worktree-branch')
}

/** The strip is the only place the Apply label appears. */
function strip(w: VueWrapper): ReturnType<VueWrapper['findAll']>[number] | undefined {
  return w.findAll('button').find((b) => b.text() === en.worktree.create.slugifyApply)
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  stubApi()
})

afterEach(() => {
  for (const w of wrappers) w.unmount()
  wrappers = []
})

describe('NewWorktreeDialog — slugify strip', () => {
  it('stays hidden while the branch is empty', async () => {
    const w = await openDialog()
    expect(strip(w)).toBeUndefined()
  })

  it('stays hidden for an already-clean branch name', async () => {
    const w = await openDialog()
    await branchInput(w).setValue('acme-10996-foo')
    expect(strip(w)).toBeUndefined()
  })

  it('appears with the slug once a ticket title is typed', async () => {
    const w = await openDialog()
    await branchInput(w).setValue('ACME-10996 Report Export Date Range Filter')
    expect(strip(w)).toBeDefined()
    expect(w.text()).toContain('acme-10996-report-export-date-range-filter')
  })

  it('rewrites the branch input on Apply and then disappears', async () => {
    const w = await openDialog()
    await branchInput(w).setValue('ACME-10996 Report Export')
    await strip(w)!.trigger('click')
    expect((branchInput(w).element as HTMLInputElement).value).toBe('acme-10996-report-export')
    expect(strip(w)).toBeUndefined()
  })

  it('never appears in existing-branch mode', async () => {
    const w = await openDialog()
    await branchInput(w).setValue('ACME-10996 Report Export')
    expect(strip(w)).toBeDefined()
    // Switch to the checkout mode — there is no free-text branch field there.
    const existingTab = w
      .findAll('button')
      .find((b) => b.text() === en.worktree.create.modeExistingTab)
    await existingTab!.trigger('click')
    expect(strip(w)).toBeUndefined()
  })

  it('honors the persisted prefix and toggles', async () => {
    localStorage.setItem(
      'om2tab.worktreeSlugify',
      JSON.stringify({ prefix: 'feature/', slugifyPrefix: false, preserveCase: true })
    )
    const w = await openDialog()
    await branchInput(w).setValue('ACME-10996 Report Export')
    expect(w.text()).toContain('feature/ACME-10996-Report-Export')
  })

  it('survives a malformed persisted blob', async () => {
    localStorage.setItem('om2tab.worktreeSlugify', '{not json')
    const w = await openDialog()
    await branchInput(w).setValue('ACME-10996 Report Export')
    expect(w.text()).toContain('acme-10996-report-export')
  })
})
