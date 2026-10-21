/**
 * Which chords a focused browser pane forwards to Harnu, and what each one runs (T564 U1, spec §2.5). Pure:
 * main decides synchronously whether to swallow a key (`before-input-event`), so it needs the SET of chords
 * Harnu binds; when a forwarded chord arrives, this resolves it to an action id.
 *
 * Bindings in the `browser` scope win over `global` ones for the same chord: with a pane focused, `Cmd+R`
 * reloads the page, not the window. Scopes `sidebar`, `terminal` and `modal` never apply to a guest.
 */
import type { ResolvedBinding } from '../../../main/keybindings-core'

type BindingLike = Pick<ResolvedBinding, 'id' | 'keys' | 'scope'>

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
      (b) => b.scope === scope && b.keys !== null && fold(b.keys, mac) === chord
    )
    if (hit) return { id: hit.id, scope }
  }
  return null
}
