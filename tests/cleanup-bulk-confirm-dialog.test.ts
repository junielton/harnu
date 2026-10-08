// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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
    chips: ['stack', 'deps', 'checkout', 'branch'],
    stackCount: 1,
    reasonCode: null,
    reasonDetail: null,
    project: null,
    risk: false,
    ...over
  }
}

const reviewRow = (over: Partial<DialogRow> = {}): DialogRow =>
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
  mode: 'ready' | 'review' = 'ready',
  stale = false
): Promise<VueWrapper> {
  wrapper = mount(CleanupBulkConfirmDialog, {
    props: { rows, mode, stale },
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
    expect(title.textContent?.trim()).toBe('Clean 2 ready items?')
    expect(q('[data-testid="bulk-total"]')!.textContent?.trim()).toBe('2 ready · 1.00 GB')
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
    expect(list.className).toContain('max-h-(--fv-rail-list-max-h)')
    expect(list.className).toContain('overflow-y-auto')
    expect(list.getAttribute('tabindex')).toBe('0')
  })

  it('states what each worktree removal takes: stack, deps, checkout, branch — never a volume', async () => {
    await open([row()])
    const chips = qa('[data-testid="bulk-row"] [data-chip]')
    expect(chips.map((c) => c.getAttribute('data-chip'))).toEqual([
      'stack',
      'deps',
      'checkout',
      'branch'
    ])
    expect(chips.find((c) => c.getAttribute('data-chip') === 'stack')!.className).not.toContain(
      'text-warning'
    )
  })

  it('an orphan volume row carries the one chip that uses the warning triple', async () => {
    await open(
      [
        row({
          id: 'volume:pg',
          kind: 'volume',
          name: 'pg',
          branch: null,
          chips: ['volume'],
          reasonCode: 'no-known-worktree',
          project: 'old-app',
          risk: false
        })
      ],
      'review'
    )
    const volume = qa('[data-testid="bulk-row"] [data-chip="volume"]')[0]!
    expect(volume.className).toContain('text-warning')
    expect(volume.className).toContain('bg-warning-soft')
  })
})

describe('CleanupBulkConfirmDialog — copy by mode', () => {
  it('ready items: Success confirm, volumes are kept, and how the rest comes back', async () => {
    await open([row()], 'ready')
    const confirm = q('[data-testid="bulk-confirm"]')!
    expect(confirm.textContent?.trim()).toBe('Clean 1 ready')
    expect(confirm.className).toContain('text-green')
    const warn = q('[data-testid="bulk-warning"]')!.textContent!
    expect(warn).toContain('Volumes are kept. They show up in Needs review afterwards.')
    // A space between the two sentences (they come from two catalog keys).
    expect(warn).toContain('afterwards. Code')
    expect(warn).not.toContain('cannot be restored')
    expect(warn).toContain('archive refs')
    expect(warn).toContain('OS trash')
    expect(q('[data-testid="bulk-volumes-kept"]')).not.toBeNull()
    expect(q('[data-testid="bulk-volumes-lost"]')).toBeNull()
    expect(q('[data-testid="bulk-risk"]')).toBeNull()
    expect(q('[data-testid="bulk-reason"]')).toBeNull()
  })

  it('ready items: never shows a volume chip for a worktree, whatever it owns', async () => {
    await open([row({ chips: ['stack', 'deps', 'checkout', 'branch'] })], 'ready')
    expect(qa('[data-chip="volume"]')).toHaveLength(0)
  })

  it('review: Danger confirm, a reason per row, and the stronger risk line with the count', async () => {
    await open(
      [
        reviewRow(),
        reviewRow({ id: 'd2', name: 'PROJ-8', reasonCode: 'remote-gone' }),
        reviewRow({ id: 'd3', name: 'idle', risk: false, reasonCode: 'open-idle-session' })
      ],
      'review'
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

  it('review: one risky row reads in the singular', async () => {
    await open([reviewRow()], 'review')
    expect(q('[data-testid="bulk-risk"]')!.textContent).toContain(
      '1 of these holds work that no other branch has'
    )
  })

  it('review: an orphan volume uses item wording and always warns that volumes are lost', async () => {
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
    await open([volume], 'review')
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
    // The × is now the first control of the dialog, so that is where Tab wraps to.
    const first = q('[data-testid="bulk-close"]')!
    const confirm = q('[data-testid="bulk-confirm"]')!
    confirm.focus()
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    window.dispatchEvent(tab)
    expect(tab.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(first)

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

describe('CleanupBulkConfirmDialog — when what it showed has changed', () => {
  it('says so, in the warning ink, and disables the confirm', async () => {
    await open([row()], 'ready', true)
    expect(q('[data-testid="bulk-stale"]')!.textContent).toContain(
      i18n.global.t('cleanup.gc.confirm.changed')
    )
    expect((q('[data-testid="bulk-confirm"]') as HTMLButtonElement).disabled).toBe(true)
  })

  it('does not confirm on click or Enter while changed, but Cancel still closes it', async () => {
    const w = await open([row()], 'ready', true)
    ;(q('[data-testid="bulk-confirm"]') as HTMLButtonElement).click()
    q('[data-testid="bulk-confirm"]')!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
    )
    expect(w.emitted('confirm')).toBeUndefined()
    ;(q('[data-testid="bulk-cancel"]') as HTMLButtonElement).click()
    expect(w.emitted('cancel')).toHaveLength(1)
  })

  it('shows nothing of the kind while the facts are what was shown', async () => {
    await open([row()], 'ready', false)
    expect(q('[data-testid="bulk-stale"]')).toBeNull()
    expect((q('[data-testid="bulk-confirm"]') as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('CleanupBulkConfirmDialog — chip titles', () => {
  it("the volume chip describes an orphan volume with no worktree, not a worktree's volume", () => {
    for (const locale of ['en', 'pt-BR']) {
      const msgs = JSON.parse(
        readFileSync(join(process.cwd(), `src/renderer/src/i18n/${locale}.json`), 'utf8')
      )
      const title: string = msgs.cleanup.gc.chip.title.volume
      expect(title, locale).not.toMatch(/owned by this worktree|deste worktree/i)
      if (locale === 'en') expect(title).toMatch(/no worktree/i)
    }
  })
})

describe('CleanupBulkConfirmDialog — parity with the approved mockup', () => {
  it('has a × close button that cancels, next to the title', async () => {
    const w = await open([row()])
    const x = q('[data-testid="bulk-close"]') as HTMLButtonElement
    expect(x.getAttribute('aria-label')).toBe('Close')
    expect(x.querySelector('svg')).not.toBeNull()
    x.click()
    expect(w.emitted('cancel')).toHaveLength(1)
  })

  it('gives every removal chip an icon', async () => {
    await open([row()])
    const chips = qa('[data-testid="bulk-row"] [data-chip]')
    expect(chips.length).toBeGreaterThan(0)
    for (const c of chips) expect(c.querySelector('svg'), c.dataset.chip).not.toBeNull()
  })

  it('sets the row title in mono, with the branch as a mono sub-line', async () => {
    await open([row()])
    const r = q('[data-testid="bulk-row"]')!
    expect(r.querySelector('[data-testid="bulk-row-title"]')!.className).toContain('font-mono')
    expect(r.querySelector('[data-testid="bulk-row-sub"]')!.className).toContain('font-mono')
  })

  it('states the whole clean in one breakdown line, without volumes', async () => {
    await open([
      row({ stackCount: 2 }),
      row({ id: 'r2', stackCount: 1, chips: ['deps', 'checkout'] })
    ])
    expect(q('[data-testid="bulk-breakdown"]')!.textContent!.trim()).toBe(
      '3 stacks stopped · 2 dependency folders removed · 2 worktrees trashed'
    )
  })

  it('leaves out a part that is zero, and uses the singular for one', async () => {
    await open([row({ stackCount: 0, chips: ['checkout', 'branch'] })])
    expect(q('[data-testid="bulk-breakdown"]')!.textContent!.trim()).toBe('1 worktree trashed')
  })

  it('adds the volumes only for an orphan volume row', async () => {
    await open(
      [
        {
          ...row(),
          id: 'volume:pg',
          kind: 'volume',
          name: 'pg',
          branch: null,
          chips: ['volume'],
          stackCount: 0,
          reasonCode: 'no-known-worktree',
          project: 'old-app'
        }
      ],
      'review'
    )
    expect(q('[data-testid="bulk-breakdown"]')!.textContent!.trim()).toBe('1 volume deleted')
  })

  it('the footer reads "N ready · size" for the ready dialog and "N selected · size" for remove-selected', async () => {
    await open([row(), row({ id: 'r2' })], 'ready')
    expect(q('[data-testid="bulk-total"]')!.textContent!.trim()).toBe('2 ready · 1.02 GB')
    wrapper?.unmount()
    await open([reviewRow(), reviewRow({ id: 'd2' })], 'review')
    expect(q('[data-testid="bulk-total"]')!.textContent!.trim()).toBe('2 selected · 1.02 GB')
  })

  it('puts an icon on the confirm button: Recycle on Success, Trash on Danger', async () => {
    await open([row()], 'ready')
    expect(q('[data-testid="bulk-confirm"] svg')!.getAttribute('class')).toContain('recycle')
    wrapper?.unmount()
    await open([reviewRow()], 'review')
    expect(q('[data-testid="bulk-confirm"] svg')!.getAttribute('class')).toContain('trash')
  })
})
