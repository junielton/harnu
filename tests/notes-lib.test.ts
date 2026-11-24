// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import {
  filterPickerRows,
  openNoteInStack,
  pickerRows,
  relativeHint
} from '../src/renderer/src/lib/notes'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import { useHelpersStore } from '../src/renderer/src/stores/helpers'
import { useUiStore } from '../src/renderer/src/stores/ui'

const note = (date: string): { date: string; filePath: string } => ({
  date,
  filePath: `/repo/.harnu/notes/${date}.md`
})

describe('pickerRows', () => {
  it('keeps today first when its file exists, newest first after it, no duplicate', () => {
    const rows = pickerRows(
      [note('2026-11-24'), note('2026-11-20'), note('2026-10-02')],
      '2026-11-24'
    )
    expect(rows.map((r) => r.date)).toEqual(['2026-11-24', '2026-11-20', '2026-10-02'])
    expect(rows[0].filePath).toBe('/repo/.harnu/notes/2026-11-24.md')
  })

  it('prepends a not-yet-created today row with a null filePath', () => {
    const rows = pickerRows([note('2026-11-20')], '2026-11-24')
    expect(rows).toEqual([
      { date: '2026-11-24', filePath: null },
      { date: '2026-11-20', filePath: '/repo/.harnu/notes/2026-11-20.md' }
    ])
  })

  it('puts today first even if the list is not ordered', () => {
    const rows = pickerRows([note('2026-11-20'), note('2026-11-24')], '2026-11-24')
    expect(rows.map((r) => r.date)).toEqual(['2026-11-24', '2026-11-20'])
  })

  it('returns only the today row for an empty list', () => {
    expect(pickerRows([], '2026-11-24')).toEqual([{ date: '2026-11-24', filePath: null }])
  })
})

describe('filterPickerRows', () => {
  const rows = pickerRows(
    [note('2026-11-24'), note('2026-11-20'), note('2026-10-02')],
    '2026-11-24'
  )

  it('matches a substring of the date', () => {
    expect(filterPickerRows(rows, '11-2').map((r) => r.date)).toEqual(['2026-11-24', '2026-11-20'])
  })

  it('trims and ignores case; empty query keeps everything', () => {
    expect(filterPickerRows(rows, '  10-02 ').map((r) => r.date)).toEqual(['2026-10-02'])
    expect(filterPickerRows(rows, '')).toEqual(rows)
    expect(filterPickerRows(rows, '   ')).toEqual(rows)
  })

  it('returns nothing when no date matches', () => {
    expect(filterPickerRows(rows, 'zzz')).toEqual([])
  })
})

describe('relativeHint', () => {
  it('names today and yesterday', () => {
    expect(relativeHint('2026-11-24', '2026-11-24')).toBe('today')
    expect(relativeHint('2026-11-23', '2026-11-24')).toBe('yesterday')
  })

  it('crosses month and year boundaries for yesterday', () => {
    expect(relativeHint('2026-10-31', '2026-11-01')).toBe('yesterday')
    expect(relativeHint('2025-12-31', '2026-01-01')).toBe('yesterday')
  })

  it('returns the local weekday for any other day (0 = Sunday)', () => {
    // 2026-11-20 is a Friday, 2026-11-22 a Sunday.
    expect(relativeHint('2026-11-20', '2026-11-24')).toEqual({ weekday: 5 })
    expect(relativeHint('2026-11-22', '2026-11-24')).toEqual({ weekday: 0 })
  })
})

describe('openNoteInStack', () => {
  const notesOpen = vi.fn()

  beforeEach(() => {
    setActivePinia(createPinia())
    notesOpen.mockReset()
    ;(window as unknown as { api: unknown }).api = { notesOpen }
  })

  it('opens the note as an edit-mode markdown pane under the selected session worktree', async () => {
    notesOpen.mockResolvedValue({
      ok: true,
      filePath: '/repo/.harnu/notes/2026-11-24.md',
      created: true
    })
    const sessions = useSessionsStore()
    vi.spyOn(sessions, 'selectedSession', 'get').mockReturnValue({
      projectPath: '/repo-wt'
    } as never)
    const helpers = useHelpersStore()
    const add = vi.spyOn(helpers, 'addMarkdownHelper').mockReturnValue('h-1')

    await expect(openNoteInStack('/repo', '2026-11-24')).resolves.toBe(true)
    expect(notesOpen).toHaveBeenCalledWith('/repo', '2026-11-24')
    expect(add).toHaveBeenCalledWith('/repo-wt', '/repo/.harnu/notes/2026-11-24.md', '/repo', {
      initialMode: 'edit'
    })
  })

  it("falls back to the folder when no session is selected, and passes no date for today's note", async () => {
    notesOpen.mockResolvedValue({ ok: true, filePath: '/repo/.harnu/notes/x.md', created: false })
    const helpers = useHelpersStore()
    const add = vi.spyOn(helpers, 'addMarkdownHelper').mockReturnValue('h-1')

    await expect(openNoteInStack('/repo')).resolves.toBe(true)
    expect(notesOpen).toHaveBeenCalledWith('/repo', undefined)
    expect(add).toHaveBeenCalledWith('/repo', '/repo/.harnu/notes/x.md', '/repo', {
      initialMode: 'edit'
    })
  })

  it('pushes a warning toast and returns false when the note cannot be opened', async () => {
    notesOpen.mockResolvedValue({ ok: false, code: 'not-found' })
    const helpers = useHelpersStore()
    const add = vi.spyOn(helpers, 'addMarkdownHelper')
    const ui = useUiStore()
    const toast = vi.spyOn(ui, 'pushToast')

    await expect(openNoteInStack('/repo')).resolves.toBe(false)
    expect(add).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ kind: 'warning' }))
  })

  it('treats a rejected IPC call as a failure too', async () => {
    notesOpen.mockRejectedValue(new Error('boom'))
    const ui = useUiStore()
    const toast = vi.spyOn(ui, 'pushToast')
    await expect(openNoteInStack('/repo')).resolves.toBe(false)
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ kind: 'warning' }))
  })
})
