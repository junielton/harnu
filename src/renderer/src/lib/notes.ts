import { i18n } from '../i18n'
import { useHelpersStore } from '../stores/helpers'
import { useSessionsStore } from '../stores/sessions'
import { useUiStore } from '../stores/ui'

/**
 * Quick notes helpers shared by the notes picker and the shortcut/menu entry points: the
 * picker's pure row model, and `openNoteInStack`, the one way a note is opened as a pane.
 */

/** One picker row. `filePath: null` is today's note, which does not exist until it is opened. */
export interface PickerRow {
  date: string
  filePath: string | null
}

/** Today first (from the list when present, else a not-yet-created row), then the rest newest first. */
export function pickerRows(
  notes: { date: string; filePath: string }[],
  today: string
): PickerRow[] {
  const todayNote = notes.find((n) => n.date === today)
  const rest = notes
    .filter((n) => n.date !== today)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    .map((n) => ({ date: n.date, filePath: n.filePath }))
  return [{ date: today, filePath: todayNote?.filePath ?? null }, ...rest]
}

/** Case-insensitive substring of the date, after trimming. An empty query keeps every row. */
export function filterPickerRows(rows: PickerRow[], query: string): PickerRow[] {
  const q = query.trim().toLowerCase()
  if (!q) return rows
  return rows.filter((r) => r.date.toLowerCase().includes(q))
}

/** `YYYY-MM-DD` as a LOCAL date. `new Date('YYYY-MM-DD')` would parse it as UTC and shift the day. */
function parseLocalDate(date: string): Date {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(y, m - 1, d)
}

/** `'today'`, `'yesterday'`, or the local weekday (0 = Sunday) of `date`. */
export function relativeHint(
  date: string,
  today: string
): 'today' | 'yesterday' | { weekday: number } {
  if (date === today) return 'today'
  const day = parseLocalDate(date)
  const before = parseLocalDate(today)
  before.setDate(before.getDate() - 1)
  if (day.getTime() === before.getTime()) return 'yesterday'
  return { weekday: day.getDay() }
}

/**
 * Open a note (today's when `date` is omitted) as an edit-mode markdown pane in the helper stack,
 * focused with the caret at the end. A note that is already open is switched to edit mode and
 * focused (un-maximizing whatever pane hides it); its unsaved draft is kept. The worktree rule matches `useFolderMenuActions.projectMemory`. Resolves `false`, after a warning
 * toast, when the note could not be resolved.
 */
export async function openNoteInStack(folder: string, date?: string): Promise<boolean> {
  const sessions = useSessionsStore()
  const helpers = useHelpersStore()
  const ui = useUiStore()
  try {
    const res = await window.api.notesOpen(folder, date)
    if (res.ok) {
      const worktree = sessions.selectedSession?.projectPath || folder
      const paneId = helpers.addMarkdownHelper(worktree, res.filePath, folder, {
        initialMode: 'edit'
      })
      // A note already open in this stack is a dedup hit that only reveals the panel: ask the pane
      // to switch to edit and take focus too, so typing goes into the note, not the terminal.
      helpers.requestMarkdownEdit(worktree, paneId)
      return true
    }
  } catch {
    // Fall through to the toast below: a rejected IPC call is the same failure to the operator.
  }
  ui.pushToast({ kind: 'warning', title: i18n.global.t('notes.openFailed') })
  return false
}

/** The warning both entry points show when no folder is selected: say what to do about it. */
function toastNoFolder(): void {
  useUiStore().pushToast({ kind: 'warning', title: i18n.global.t('notes.noFolder') })
}

/**
 * `notes.openToday`, the shortcut / palette handler: today's note for the SELECTED folder. With no
 * folder selected it steers the operator to pick one instead of failing silently.
 */
export async function openTodayNote(): Promise<boolean> {
  const folder = useSessionsStore().activeFolderPath
  if (!folder) {
    toastNoFolder()
    return false
  }
  return openNoteInStack(folder)
}

/** `notes.open`, the shortcut / palette handler: the notes picker for the SELECTED folder. */
export function openAllNotes(): void {
  const folder = useSessionsStore().activeFolderPath
  if (!folder) {
    toastNoFolder()
    return
  }
  useUiStore().openNotesPicker(folder)
}
