/**
 * Which chords a focused browser pane forwards to Harnu, and what each one runs (T564 U1, spec §2.5). Pure:
 * main decides synchronously whether to swallow a key (`before-input-event`), so it needs the SET of chords
 * Harnu binds; when a forwarded chord arrives, this resolves it to an action id.
 *
 * Bindings in the `browser` scope win over `global` ones for the same chord: with a pane focused, `Cmd+R`
 * reloads the page, not the window. Scopes `sidebar`, `terminal` and `modal` never apply to a guest.
 */
import type { ResolvedBinding } from '../../../main/keybindings-core'
import { chordOf } from '../../../main/browser/chord'

type BindingLike = Pick<ResolvedBinding, 'id' | 'keys' | 'scope'>

/**
 * Actions whose handlers are disabled until a later unit enables them. Their chords are NOT swallowed from the
 * page: a key Harnu does nothing with must reach the page. (Zoom went live in U5 (T572), the point-and-comment
 * overlay in U6 (T573), so nothing is inactive now.)
 */
export const INACTIVE_BROWSER_ACTIONS: ReadonlySet<string> = new Set<string>()

/** Off macOS `Ctrl` and `Cmd` are the same physical key, so main reports `Cmd`; fold the table the same way. */
function fold(chord: string, mac: boolean): string {
  return mac ? chord : chord.replace(/Ctrl\+/g, 'Cmd+').replace(/Cmd\+Cmd\+/g, 'Cmd+')
}

/** The canonical chords of every binding a guest should offer to Harnu. */
export function boundChordsFrom(list: readonly BindingLike[], mac: boolean): string[] {
  const out = new Set<string>()
  for (const b of list) {
    if (b.keys === null) continue
    if (b.scope !== 'global' && b.scope !== 'browser') continue
    if (INACTIVE_BROWSER_ACTIONS.has(b.id)) continue
    out.add(fold(b.keys, mac))
  }
  return [...out]
}

/** The action a forwarded chord runs, preferring the `browser` scope over `global`; `null` when unbound. */
export function actionForChord(
  list: readonly BindingLike[],
  chord: string,
  mac: boolean
): { id: string; scope: 'browser' | 'global' } | null {
  for (const scope of ['browser', 'global'] as const) {
    const hit = list.find(
      (b) =>
        b.scope === scope &&
        b.keys !== null &&
        !INACTIVE_BROWSER_ACTIONS.has(b.id) &&
        fold(b.keys, mac) === chord
    )
    if (hit) return { id: hit.id, scope }
  }
  return null
}

/** The tab actions: pane chords that act on the focused pane's tabs (browser-tabs S-4). */
const TAB_ACTIONS: ReadonlySet<string> = new Set([
  'browser.tab.new',
  'browser.tab.close',
  'browser.tab.next',
  'browser.tab.prev'
])

/**
 * The tab action a key press in the pane chrome (header, address bar) runs, or `null`. The page's own presses reach
 * main's `before-input-event` instead; both resolve through the same bindings, so a rebound chord moves both.
 */
export function tabActionForKey(
  list: readonly BindingLike[],
  ev: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey' | 'isComposing'>,
  mac: boolean
): string | null {
  if (ev.isComposing || ev.key === 'Process') return null
  const chord = chordOf(
    {
      type: 'keyDown',
      key: ev.key,
      control: ev.ctrlKey,
      alt: ev.altKey,
      shift: ev.shiftKey,
      meta: ev.metaKey
    },
    mac
  )
  if (chord === null) return null
  const hit = actionForChord(list, chord, mac)
  return hit && TAB_ACTIONS.has(hit.id) ? hit.id : null
}
