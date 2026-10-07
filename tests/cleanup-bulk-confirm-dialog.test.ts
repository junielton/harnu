// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import CleanupBulkConfirmDialog from '../src/renderer/src/components/CleanupBulkConfirmDialog.vue'
import { i18n } from '@renderer/i18n'
import type { DialogRow } from '../src/renderer/src/lib/gc-model'

const MB = 1_000_000

function row(over: Partial<DialogRow> = {}): DialogRow {
  return {
    id: 'r1',
    kind: 'worktree',
    repo: 'www',
    name: 'PROJ-41-feature',
    branch: 'feat/proj-41',
    bytes: 512 * MB,
    chips: ['stack', 'volume', 'deps', 'checkout', 'branch'],
    reasonCode: null,
    reasonDetail: null,
    project: null,
    risk: false,
    ...over
  }
}

const decideRow = (over: Partial<DialogRow> = {}): DialogRow =>
  row({
    id: 'd1',
    name: 'PROJ-7-spike',
    branch: 'feat/proj-7',
    chips: ['checkout', 'branch'],
    reasonCode: 'closed-unmerged',
    reasonDetail: 'The pull request was closed without being merged.',
    risk: true,
    ...over
  })

let wrapper: VueWrapper | null = null

async function open(
  rows: DialogRow[],
  mode: 'corpses' | 'decide' = 'corpses',
  removeVolumes = true
): Promise<VueWrapper> {
  wrapper = mount(CleanupBulkConfirmDialog, {
    props: { rows, mode, removeVolumes },
    global: { plugins: [i18n] },
    attachTo: document.body
  })
  await flushPromises()
  await flushPromises()
  return wrapper
}

const q = (sel: string): HTMLElement | null => document.body.querySelector<HTMLElement>(sel)
const qa = (sel: string): HTMLElement[] => [...document.body.querySelectorAll<HTMLElement>(sel)]

beforeEach(() => {
  document.body.innerHTML = ''
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.restoreAllMocks()
})

describe('CleanupBulkConfirmDialog — what it discloses', () => {
  it('is a modal dialog labelled by its title, with the count and the total', async () => {
    await open([row(), row({ id: 'r2', name: 'PROJ-42', bytes: 488 * MB })])
    const dlg = q('[data-testid="bulk-dialog"]')!
    expect(dlg.getAttribute('role')).toBe('dialog')
    expect(dlg.getAttribute('aria-modal')).toBe('true')
    const title = q(`#${dlg.getAttribute('aria-labelledby')}`)!
    expect(title.textContent?.trim()).toBe('Clean 2 corpses?')
    expect(q('[data-testid="bulk-summary"]')!.textContent?.trim()).toBe('2 items · 1.00 GB')
  })

  it('lists every row as repo › worktree with its branch and size', async () => {
    await open([row(), row({ id: 'r2', name: 'PROJ-42', branch: 'feat/proj-42', bytes: 488 * MB })])
    const rows = qa('[data-testid="bulk-row"]')
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain('www › PROJ-41-feature')
    expect(rows[0].textContent).toContain('feat/proj-41')
    expect(rows[0].textContent).toContain('512 MB')
  })

  it('bounds the list at the existing 280px cap and makes it focusable and scrollable', async () => {
    await open([row()])
    const list = q('[data-testid="bulk-list"]')!
    expect(list.className).toContain('max-h-[var(--fv-rail-list-max-h)]')
    expect(list.className).toContain('overflow-y-auto')
    expect(list.getAttribute('tabindex')).toBe('0')
  })

  it('states what each removal takes, and the volume chip uses the warning triple', async () => {
    await open([row()])
    const chips = qa('[data-testid="bulk-row"] [data-chip]')
    expect(chips.map((c) => c.getAttribute('data-chip'))).toEqual([
      'stack',
      'volume',
      'deps',
      'checkout',
      'branch'
    ])
    const volume = chips.find((c) => c.getAttribute('data-chip') === 'volume')!
    expect(volume.className).toContain('text-warning')
    expect(volume.className).toContain('bg-warning-soft')
    expect(chips.find((c) => c.getAttribute('data-chip') === 'stack')!.className).not.toContain(
      'text-warning'
    )
  })
})

describe('CleanupBulkConfirmDialog — copy by mode', () => {
  it('corpses: Success confirm, volumes cannot be restored, and how the rest comes back', async () => {
    await open([row()], 'corpses')
    const confirm = q('[data-testid="bulk-confirm"]')!
    expect(confirm.textContent?.trim()).toBe('Clean 1 corpse')
    expect(confirm.className).toContain('text-green')
    const warn = q('[data-testid="bulk-warning"]')!.textContent!
    expect(warn).toContain('Volumes cannot be restored.')
    expect(warn).toContain('archive refs')
    expect(warn).toContain('OS trash')
    expect(q('[data-testid="bulk-risk"]')).toBeNull()
    expect(q('[data-testid="bulk-reason"]')).toBeNull()
  })

  it('corpses: says volumes are kept when removeVolumes is off', async () => {
    await open([row({ chips: ['checkout', 'branch'] })], 'corpses', false)
    const warn = q('[data-testid="bulk-warning"]')!.textContent!
    expect(warn).toContain('Docker volumes are kept.')
    expect(warn).not.toContain('cannot be restored')
  })

  it('corpses: says volumes are kept when no row owns one', async () => {
    await open([row({ chips: ['checkout'] })], 'corpses', true)
    expect(q('[data-testid="bulk-volumes-kept"]')).not.toBeNull()
  })

  it('decide: Danger confirm, a reason per row, and the stronger risk line with the count', async () => {
    await open(
      [
        decideRow(),
        decideRow({ id: 'd2', name: 'PROJ-8', reasonCode: 'remote-gone' }),
        decideRow({ id: 'd3', name: 'idle', risk: false, reasonCode: 'open-idle-session' })
      ],
      'decide'
    )
    const confirm = q('[data-testid="bulk-confirm"]')!
    expect(confirm.textContent?.trim()).toBe('Remove 3 worktrees')
    expect(confirm.className).toContain('text-red')
    expect(qa('[data-testid="bulk-reason"]')).toHaveLength(3)
    expect(q('[data-testid="bulk-risk"]')!.textContent).toContain(
      '2 of these hold work that no other branch has'
    )
    expect(q('[data-testid="bulk-risk"]')!.textContent).toContain('OS trash')
    const risky = qa('[data-testid="bulk-row"]').filter((r) => r.dataset.risk === 'true')
    expect(risky).toHaveLength(2)
  })

  it('decide: one risky row reads in the singular', async () => {
    await open([decideRow()], 'decide')
    expect(q('[data-testid="bulk-risk"]')!.textContent).toContain(
      '1 of these holds work that no other branch has'
    )
  })

  it('decide: an orphan volume uses item wording and always warns that volumes are lost', async () => {
    const volume = row({
      id: 'volume:pg_data',
      kind: 'volume',
      repo: null,
      name: 'pg_data',
      branch: null,
      project: 'old-app',
      chips: ['volume'],
      reasonCode: 'no-known-worktree',
      reasonDetail: 'No known worktree.',
      risk: false
    })
    await open([volume], 'decide', false)
    expect(q('[data-testid="bulk-confirm"]')!.textContent?.trim()).toBe('Remove 1 item')
    expect(q('[data-testid="bulk-row"]')!.textContent).toContain('Docker volume pg_data')
    expect(q('[data-testid="bulk-row"]')!.textContent).toContain('Project old-app')
    expect(q('[data-testid="bulk-volumes-lost"]')).not.toBeNull()
  })
})

describe('CleanupBulkConfirmDialog — behaviour', () => {
  it('opens with focus on Cancel, never on the confirm button', async () => {
    await open([row()])
    expect(document.activeElement).toBe(q('[data-testid="bulk-cancel"]'))
    expect(document.activeElement).not.toBe(q('[data-testid="bulk-confirm"]'))
  })

  it('Esc cancels and does not confirm', async () => {
    const w = await open([row()])
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(w.emitted('cancel')).toHaveLength(1)
    expect(w.emitted('confirm')).toBeUndefined()
  })

  it('Enter activates only the focused control: a bare Enter confirms nothing', async () => {
    const w = await open([row()])
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(w.emitted('confirm')).toBeUndefined()
    // Cancel has focus, so activating the focused control cancels.
    ;(document.activeElement as HTMLElement).click()
    expect(w.emitted('cancel')).toHaveLength(1)
    expect(w.emitted('confirm')).toBeUndefined()
  })

  it('the confirm button emits confirm', async () => {
    const w = await open([row()])
    q('[data-testid="bulk-confirm"]')!.click()
    expect(w.emitted('confirm')).toHaveLength(1)
  })

  it('a backdrop click cancels; a click inside the card does nothing', async () => {
    const w = await open([row()])
    const backdrop = q('[data-testid="bulk-dialog"]')!.parentElement!
    q('[data-testid="bulk-dialog"]')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(w.emitted('cancel')).toBeUndefined()
    backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(w.emitted('cancel')).toHaveLength(1)
    expect(w.emitted('confirm')).toBeUndefined()
  })

  it('traps Tab inside: from the last control it wraps to the first, and back with Shift+Tab', async () => {
    // jsdom has no layout, so every element would read as hidden to the trap.
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([
      {} as DOMRect
    ] as unknown as DOMRectList)
    await open([row()])
    const list = q('[data-testid="bulk-list"]')!
    const confirm = q('[data-testid="bulk-confirm"]')!
    confirm.focus()
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    window.dispatchEvent(tab)
    expect(tab.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(list)

    const back = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
      cancelable: true
    })
    window.dispatchEvent(back)
    expect(document.activeElement).toBe(confirm)
  })
})
