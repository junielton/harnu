// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import FolderCombobox, {
  filterFolders,
  groupFoldersByRepo
} from '../src/renderer/src/components/ui/FolderCombobox.vue'
import type { Folder } from '../src/renderer/src/stores/sessions'

function folder(over: Partial<Folder> = {}): Folder {
  return {
    path: '/repo/harnu',
    alias: 'harnu',
    gitBranch: 'main',
    sessions: [],
    expanded: false,
    pinned: false,
    ...over
  } as Folder
}

const FOLDERS: Folder[] = [
  folder({
    path: '/repo/harnu',
    alias: 'harnu',
    gitBranch: 'main',
    repoId: '/repo/harnu',
    isMainWorktree: true
  }),
  folder({
    path: '/repo/worktrees/harnu-a',
    alias: 'harnu-a',
    gitBranch: 'card/T293',
    repoId: '/repo/harnu',
    isMainWorktree: false
  }),
  folder({ path: '/other/example-web', alias: 'example-web', gitBranch: 'develop' })
]

let mounted: ReturnType<typeof mount>[] = []

function mountCombobox(modelValue = '', folders: Folder[] = FOLDERS): ReturnType<typeof mount> {
  const w = mount(FolderCombobox, {
    props: {
      modelValue,
      folders,
      placeholder: 'Select a folder…',
      searchPlaceholder: 'Search folders…',
      noMatchLabel: 'No folders match',
      chooseAnotherLabel: 'Choose another folder…'
    }
  })
  mounted.push(w)
  return w
}

function rowPaths(): (string | null)[] {
  return Array.from(document.querySelectorAll('[data-folder-combobox-row]')).map((el) =>
    el.getAttribute('data-folder-path')
  )
}

afterEach(() => {
  // Unmount every wrapper this test created BEFORE wiping the DOM — a
  // component left open still holds a live `window` mousedown listener; a raw
  // `innerHTML = ''` never runs Vue's unmount lifecycle, so that listener
  // leaks into later tests and fires against DOM nodes this test just deleted.
  mounted.forEach((w) => w.unmount())
  mounted = []
  document.body.innerHTML = ''
})

describe('filterFolders — AC-1', () => {
  it('matches on alias', () => {
    expect(filterFolders(FOLDERS, 'example').map((f) => f.path)).toEqual(['/other/example-web'])
  })

  it('matches on branch', () => {
    expect(filterFolders(FOLDERS, 'card/T293').map((f) => f.alias)).toEqual(['harnu-a'])
  })

  it('matches on path', () => {
    expect(filterFolders(FOLDERS, '/other/').map((f) => f.alias)).toEqual(['example-web'])
  })

  it('returns everything for a blank query', () => {
    expect(filterFolders(FOLDERS, '  ')).toEqual(FOLDERS)
  })

  it('is case-insensitive', () => {
    expect(filterFolders(FOLDERS, 'HARNU-A').map((f) => f.path)).toEqual([
      '/repo/worktrees/harnu-a'
    ])
  })
})

describe('groupFoldersByRepo — AC-2', () => {
  it('groups folders sharing a repoId under one labeled entry, main worktree first', () => {
    const groups = groupFoldersByRepo(FOLDERS)
    const repoGroup = groups.find((g) => g.label !== undefined)
    expect(repoGroup?.folders.map((f) => f.path)).toEqual([
      '/repo/harnu',
      '/repo/worktrees/harnu-a'
    ])
    expect(repoGroup?.label).toBe('harnu')
  })

  it('preserves the input order — the sidebar order — for group placement', () => {
    const groups = groupFoldersByRepo(FOLDERS)
    // /repo/harnu (grouped, first occurrence) then /other/example-web (ungrouped)
    expect(groups.map((g) => g.key)).toEqual(['repo:/repo/harnu', '/other/example-web'])
  })

  it('leaves a repoId held by only one folder ungrouped (no header)', () => {
    const groups = groupFoldersByRepo([folder({ path: '/x', alias: 'x', repoId: 'solo-repo' })])
    expect(groups).toEqual([{ key: '/x', folders: [expect.objectContaining({ path: '/x' })] }])
  })

  it('leaves a folder with no repoId ungrouped', () => {
    const groups = groupFoldersByRepo([folder({ path: '/x', alias: 'x', repoId: undefined })])
    expect(groups[0].label).toBeUndefined()
  })
})

describe('FolderCombobox', () => {
  it('shows the placeholder when nothing is selected', () => {
    const w = mountCombobox('')
    expect(w.get('[data-folder-combobox-trigger]').text()).toBe('Select a folder…')
  })

  it('shows "alias · branch" for the selected folder (AC-5)', () => {
    const w = mountCombobox('/other/example-web')
    expect(w.get('[data-folder-combobox-trigger]').text()).toBe('example-web · develop')
  })

  it('has aria-haspopup and aria-expanded on the trigger (AC-6)', async () => {
    const w = mountCombobox('')
    const trigger = w.get('[data-folder-combobox-trigger]')
    expect(trigger.attributes('aria-haspopup')).toBe('listbox')
    expect(trigger.attributes('aria-expanded')).toBe('false')
    await trigger.trigger('click')
    expect(trigger.attributes('aria-expanded')).toBe('true')
  })

  it('has role=listbox on the panel and role=option on its rows (AC-6)', async () => {
    const w = mountCombobox()
    await w.get('[data-folder-combobox-trigger]').trigger('click')
    const panel = document.querySelector('[data-folder-combobox-panel]') as HTMLElement
    expect(panel.querySelector('[role="listbox"]')).not.toBeNull()
    const rows = document.querySelectorAll('[data-folder-combobox-row]')
    expect(rows.length).toBeGreaterThan(0)
    rows.forEach((row) => expect(row.getAttribute('role')).toBe('option'))
  })

  it('renders folders grouped by repo, preserving sidebar order, when opened', async () => {
    const w = mountCombobox()
    await w.get('[data-folder-combobox-trigger]').trigger('click')
    expect(rowPaths()).toEqual(['/repo/harnu', '/repo/worktrees/harnu-a', '/other/example-web'])
    const panel = document.querySelector('[data-folder-combobox-panel]') as HTMLElement
    expect(panel.textContent).toContain('harnu')
  })

  it('filters rows as the search query changes', async () => {
    const w = mountCombobox()
    await w.get('[data-folder-combobox-trigger]').trigger('click')
    const search = document.querySelector('[data-folder-combobox-search]') as HTMLInputElement
    search.value = 'example'
    search.dispatchEvent(new Event('input'))
    await w.vm.$nextTick()
    expect(rowPaths()).toEqual(['/other/example-web'])
  })

  it('shows the no-match row when nothing matches', async () => {
    const w = mountCombobox()
    await w.get('[data-folder-combobox-trigger]').trigger('click')
    const search = document.querySelector('[data-folder-combobox-search]') as HTMLInputElement
    search.value = 'zzz-does-not-exist'
    search.dispatchEvent(new Event('input'))
    await w.vm.$nextTick()
    expect(document.querySelector('[data-folder-combobox-empty]')?.textContent).toBe(
      'No folders match'
    )
  })

  it('a modelValue matching no known folder still renders as the trigger label (AC-3)', () => {
    const w = mountCombobox('/gone/deleted-worktree')
    expect(w.get('[data-folder-combobox-trigger]').text()).toBe('/gone/deleted-worktree')
  })

  it('emits the folder path and closes the panel on row click', async () => {
    const w = mountCombobox()
    await w.get('[data-folder-combobox-trigger]').trigger('click')
    const row = document.querySelector('[data-folder-path="/other/example-web"]') as HTMLElement
    row.click()
    await w.vm.$nextTick()
    expect(w.emitted('update:modelValue')?.[0]).toEqual(['/other/example-web'])
    expect(document.querySelector('[data-folder-combobox-panel]')).toBeNull()
  })

  it('shows the trailing "Choose another folder…" item (AC-4)', async () => {
    const w = mountCombobox()
    await w.get('[data-folder-combobox-trigger]').trigger('click')
    const row = document.querySelector('[data-folder-combobox-choose-another]')
    expect(row).not.toBeNull()
    expect(row?.textContent).toBe('Choose another folder…')
  })

  it('emits the pick-a-folder intent and closes the panel without changing the selection (AC-4)', async () => {
    const w = mountCombobox('/repo/harnu')
    await w.get('[data-folder-combobox-trigger]').trigger('click')
    const row = document.querySelector('[data-folder-combobox-choose-another]') as HTMLElement
    row.click()
    await w.vm.$nextTick()
    expect(w.emitted('choose-folder')).toHaveLength(1)
    expect(w.emitted('update:modelValue')).toBeUndefined()
    expect(document.querySelector('[data-folder-combobox-panel]')).toBeNull()
  })

  it('the "Choose another folder…" item is present even when nothing matches the query', async () => {
    const w = mountCombobox()
    await w.get('[data-folder-combobox-trigger]').trigger('click')
    const search = document.querySelector('[data-folder-combobox-search]') as HTMLInputElement
    search.value = 'zzz-does-not-exist'
    search.dispatchEvent(new Event('input'))
    await w.vm.$nextTick()
    expect(document.querySelector('[data-folder-combobox-choose-another]')).not.toBeNull()
  })

  it('ArrowDown then Enter selects the next row', async () => {
    const w = mountCombobox('')
    await w.get('[data-folder-combobox-trigger]').trigger('click')
    const search = document.querySelector('[data-folder-combobox-search]') as HTMLInputElement
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await w.vm.$nextTick()
    expect(w.emitted('update:modelValue')?.[0]).toEqual(['/repo/worktrees/harnu-a'])
  })

  it('ArrowUp wraps to the "Choose another folder…" sentinel and Enter activates it', async () => {
    const w = mountCombobox('')
    await w.get('[data-folder-combobox-trigger]').trigger('click')
    const search = document.querySelector('[data-folder-combobox-search]') as HTMLInputElement
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await w.vm.$nextTick()
    expect(w.emitted('choose-folder')).toHaveLength(1)
  })

  it('Escape closes the panel without emitting a selection', async () => {
    const w = mountCombobox('/repo/harnu')
    await w.get('[data-folder-combobox-trigger]').trigger('click')
    const search = document.querySelector('[data-folder-combobox-search]') as HTMLInputElement
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await w.vm.$nextTick()
    expect(document.querySelector('[data-folder-combobox-panel]')).toBeNull()
    expect(w.emitted('update:modelValue')).toBeUndefined()
  })

  it('closes on an outside mousedown without changing the selection', async () => {
    const w = mountCombobox('/repo/harnu')
    await w.get('[data-folder-combobox-trigger]').trigger('click')
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await w.vm.$nextTick()
    expect(document.querySelector('[data-folder-combobox-panel]')).toBeNull()
    expect(w.emitted('update:modelValue')).toBeUndefined()
  })

  it('stays open on a mousedown inside the panel', async () => {
    const w = mountCombobox('/repo/harnu')
    await w.get('[data-folder-combobox-trigger]').trigger('click')
    const search = document.querySelector('[data-folder-combobox-search]') as HTMLInputElement
    search.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await w.vm.$nextTick()
    expect(document.querySelector('[data-folder-combobox-panel]')).not.toBeNull()
  })
})
