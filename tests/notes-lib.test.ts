// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createPinia, setActivePinia } from 'pinia'
import {
  filterPickerRows,
  openAllNotes,
  openNoteInStack,
  openTodayNote,
  pickerRows,
  relativeHint
} from '../src/renderer/src/lib/notes'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import { useHelpersStore } from '../src/renderer/src/stores/helpers'
import { useUiStore } from '../src/renderer/src/stores/ui'
import { i18n } from '@renderer/i18n'

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

  it('a second open of an already-open note asks that same pane to enter edit and take focus', async () => {
    notesOpen.mockResolvedValue({ ok: true, filePath: '/repo/.harnu/notes/x.md', created: false })
    const helpers = useHelpersStore()
    // Real store, real dedup: the second open lands on the first pane's id.
    await openNoteInStack('/repo')
    const first = helpers.byWorktree.get('/repo')!.panes[0].id
    helpers.consumeMarkdownEdit(first) // the pane acted on the first request
    expect(helpers.markdownEditRequest).toBeNull()

    await openNoteInStack('/repo')
    expect(helpers.byWorktree.get('/repo')!.panes).toHaveLength(1)
    expect(helpers.markdownEditRequest).toBe(first)
  })

  it('un-maximizes and leaves the expanded view of another pane that hides the note', async () => {
    notesOpen.mockResolvedValue({ ok: true, filePath: '/repo/.harnu/notes/x.md', created: false })
    const helpers = useHelpersStore()
    await openNoteInStack('/repo')
    const note = helpers.byWorktree.get('/repo')!.panes[0].id
    helpers.toggleMaximizePane('/repo', 'h-other')
    helpers.toggleExpandPane('/repo', 'h-other')

    await openNoteInStack('/repo')
    expect(helpers.maximizedPaneId('/repo')).toBeNull()
    expect(helpers.expandedPaneId('/repo')).toBeNull()
    expect(helpers.markdownEditRequest).toBe(note)
  })

  it('leaves the note maximized when it is the maximized pane itself', async () => {
    notesOpen.mockResolvedValue({ ok: true, filePath: '/repo/.harnu/notes/x.md', created: false })
    const helpers = useHelpersStore()
    await openNoteInStack('/repo')
    const note = helpers.byWorktree.get('/repo')!.panes[0].id
    helpers.toggleMaximizePane('/repo', note)

    await openNoteInStack('/repo')
    expect(helpers.maximizedPaneId('/repo')).toBe(note)
  })

  it('treats a rejected IPC call as a failure too', async () => {
    notesOpen.mockRejectedValue(new Error('boom'))
    const ui = useUiStore()
    const toast = vi.spyOn(ui, 'pushToast')
    await expect(openNoteInStack('/repo')).resolves.toBe(false)
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ kind: 'warning' }))
  })
})

describe('the shortcut and palette handlers', () => {
  const notesOpen = vi.fn()

  beforeEach(() => {
    setActivePinia(createPinia())
    notesOpen.mockReset()
    notesOpen.mockResolvedValue({ ok: true, filePath: '/repo/.harnu/notes/x.md', created: false })
    ;(window as unknown as { api: unknown }).api = { notesOpen }
  })

  function selectFolder(path: string | null): void {
    vi.spyOn(useSessionsStore(), 'activeFolderPath', 'get').mockReturnValue(path)
  }

  it("openTodayNote opens today's note for the active folder", async () => {
    selectFolder('/repo')
    const add = vi.spyOn(useHelpersStore(), 'addMarkdownHelper').mockReturnValue('h-1')
    await openTodayNote()
    expect(notesOpen).toHaveBeenCalledWith('/repo', undefined)
    expect(add).toHaveBeenCalledTimes(1)
  })

  it('openAllNotes opens the picker for the active folder', () => {
    selectFolder('/repo')
    const ui = useUiStore()
    const open = vi.spyOn(ui, 'openNotesPicker')
    openAllNotes()
    expect(open).toHaveBeenCalledWith('/repo')
  })

  it('with no folder selected both steer the operator to pick one, and open nothing', async () => {
    selectFolder(null)
    const ui = useUiStore()
    const toast = vi.spyOn(ui, 'pushToast')
    const open = vi.spyOn(ui, 'openNotesPicker')
    const add = vi.spyOn(useHelpersStore(), 'addMarkdownHelper')

    await openTodayNote()
    openAllNotes()

    expect(toast).toHaveBeenCalledTimes(2)
    for (const call of toast.mock.calls) {
      expect(call[0]).toMatchObject({ kind: 'warning', title: i18n.global.t('notes.noFolder') })
    }
    expect(i18n.global.t('notes.noFolder')).not.toBe('notes.noFolder')
    expect(notesOpen).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
    expect(add).not.toHaveBeenCalled()
  })
})

describe('App.vue registrations', () => {
  const src = readFileSync(resolve(__dirname, '../src/renderer/src/App.vue'), 'utf8')
  const block = (id: string): string => {
    const start = src.indexOf(`id: '${id}'`)
    expect(start, `${id} is registered`).toBeGreaterThan(-1)
    return src.slice(start, src.indexOf("id: '", start + 5))
  }

  it('route both commands through the shared handlers, with no enabled() gate (spec §6.3: no folder → toast)', () => {
    const today = block('notes.openToday')
    const all = block('notes.open')
    expect(today).toContain("keys: kb('notes.openToday')")
    expect(today).toContain('openTodayNote()')
    expect(today).not.toContain('enabled:')
    expect(all).toContain("keys: kb('notes.open')")
    expect(all).toContain('openAllNotes()')
    expect(all).not.toContain('enabled:')
  })
})
