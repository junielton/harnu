// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@renderer/i18n'
import NotesPickerDialog from '../src/renderer/src/components/NotesPickerDialog.vue'
import { useUiStore } from '../src/renderer/src/stores/ui'
import { useHelpersStore } from '../src/renderer/src/stores/helpers'

const FOLDER = '/home/dev/org/proj/www'
const note = (date: string): { date: string; filePath: string } => ({
  date,
  filePath: `${FOLDER}/.harnu/notes/${date}.md`
})

const notesList = vi.fn()
const notesOpen = vi.fn()
let wrapper: VueWrapper | null = null

const q = <T extends HTMLElement = HTMLElement>(sel: string): T | null =>
  document.body.querySelector<T>(sel)
const rows = (): HTMLElement[] =>
  Array.from(document.body.querySelectorAll<HTMLElement>('[data-notes-picker-row]'))
const input = (): HTMLInputElement => q<HTMLInputElement>('[data-notes-picker-input]')!

function key(k: string, el: HTMLElement = input()): void {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
}

async function open(
  list: unknown = {
    ok: true,
    notesDir: `${FOLDER}/.harnu/notes`,
    today: '2026-11-24',
    notes: [note('2026-11-24'), note('2026-11-20'), note('2026-10-02')]
  }
): Promise<ReturnType<typeof useUiStore>> {
  notesList.mockResolvedValue(list)
  const ui = useUiStore()
  wrapper = mount(NotesPickerDialog, { attachTo: document.body, global: { plugins: [i18n] } })
  ui.openNotesPicker(FOLDER)
  await flushPromises()
  return ui
}

beforeEach(() => {
  setActivePinia(createPinia())
  notesList.mockReset()
  notesOpen.mockReset()
  notesOpen.mockResolvedValue({ ok: true, filePath: '/x.md', created: false })
  ;(window as unknown as { api: unknown }).api = { notesList, notesOpen }
  vi.spyOn(useHelpersStore(), 'addMarkdownHelper').mockReturnValue('h-1')
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.restoreAllMocks()
})

describe('NotesPickerDialog', () => {
  it('loads the folder notes on open and focuses the search input', async () => {
    await open()
    expect(notesList).toHaveBeenCalledWith(FOLDER)
    expect(rows().map((r) => r.getAttribute('data-date'))).toEqual([
      '2026-11-24',
      '2026-11-20',
      '2026-10-02'
    ])
    expect(document.activeElement).toBe(input())
  })

  it('shows today and yesterday hints from i18n', async () => {
    await open({
      ok: true,
      notesDir: 'n',
      today: '2026-11-24',
      notes: [note('2026-11-24'), note('2026-11-23')]
    })
    const [today, yesterday] = rows()
    expect(today.textContent).toContain(i18n.global.t('notes.picker.today'))
    expect(yesterday.textContent).toContain(i18n.global.t('notes.picker.yesterday'))
  })

  it('shows a localized weekday for older days', async () => {
    await open()
    const weekday = new Intl.DateTimeFormat(i18n.global.locale.value, { weekday: 'long' }).format(
      new Date(2026, 10, 20)
    )
    expect(rows()[1].textContent).toContain(weekday)
  })

  it('filters as you type', async () => {
    await open()
    input().value = '10-0'
    input().dispatchEvent(new Event('input'))
    await flushPromises()
    expect(rows().map((r) => r.getAttribute('data-date'))).toEqual(['2026-10-02'])
  })

  it('ArrowDown + Enter opens the second row by its date, then closes', async () => {
    const ui = await open()
    key('ArrowDown')
    await flushPromises()
    key('Enter')
    await flushPromises()
    expect(notesOpen).toHaveBeenCalledWith(FOLDER, '2026-11-20')
    expect(ui.dialog).toBeNull()
  })

  it('clamps the selection at both ends', async () => {
    await open()
    key('ArrowUp')
    await flushPromises()
    expect(rows()[0].getAttribute('aria-selected')).toBe('true')
    for (let i = 0; i < 6; i++) key('ArrowDown')
    await flushPromises()
    expect(rows()[2].getAttribute('aria-selected')).toBe('true')
  })

  it('resets the selection to the first row when the query changes', async () => {
    await open()
    key('ArrowDown')
    key('ArrowDown')
    await flushPromises()
    input().value = '2026'
    input().dispatchEvent(new Event('input'))
    await flushPromises()
    expect(rows()[0].getAttribute('aria-selected')).toBe('true')
  })

  it("Enter on today's not-yet-created row asks main for today's note (no date)", async () => {
    await open({ ok: true, notesDir: 'n', today: '2026-11-24', notes: [note('2026-11-20')] })
    expect(rows()[0].getAttribute('data-date')).toBe('2026-11-24')
    key('Enter')
    await flushPromises()
    expect(notesOpen).toHaveBeenCalledTimes(1)
    expect(notesOpen).toHaveBeenCalledWith(FOLDER, undefined)
  })

  it('clicking a row opens it', async () => {
    await open()
    rows()[2].click()
    await flushPromises()
    expect(notesOpen).toHaveBeenCalledWith(FOLDER, '2026-10-02')
  })

  it('shows the empty line when nothing matches, and Enter does nothing', async () => {
    await open()
    input().value = 'zzz'
    input().dispatchEvent(new Event('input'))
    await flushPromises()
    expect(rows()).toHaveLength(0)
    expect(q('[data-notes-picker-empty]')?.textContent).toContain(
      i18n.global.t('notes.picker.empty')
    )
    key('Enter')
    await flushPromises()
    expect(notesOpen).not.toHaveBeenCalled()
  })

  it('shows loadFailed inside the dialog when the list cannot be read', async () => {
    const ui = await open({ ok: false, code: 'io' })
    expect(q('[data-notes-picker-error]')?.textContent).toContain(
      i18n.global.t('notes.picker.loadFailed')
    )
    expect(rows()).toHaveLength(0)
    expect(ui.dialog).toBe('notesPicker')
  })

  it('Esc closes the dialog', async () => {
    const ui = await open()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(ui.dialog).toBeNull()
  })
})
