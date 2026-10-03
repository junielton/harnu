import { defineStore } from 'pinia'
import { ref } from 'vue'
import { i18n } from '../i18n'
import { isMac } from '../lib/platform'
import { useUiStore } from './ui'
import { useHelpersStore } from './helpers'
import {
  resolveKeybindings,
  type ResolvedKeybindings,
  type ShortcutActionId
} from '../../../main/keybindings-core'

/** One override entry as it is written to `keybindings.json`. */
interface OverrideEntry {
  command: ShortcutActionId
  key: string | null
}

const FILE_HEADER =
  '// Harnu keybindings — overrides merged over the built-in defaults.\n' +
  '// Editing via Settings → Keyboard Shortcuts rewrites this file from the\n' +
  '// resolved table: hand-added comments and entries the resolver rejected\n' +
  '// (a reserved chord, a non-accelerator chord) are dropped on the next write.\n' +
  '// One entry per "command". "key": null (or a leading "-" on the command)\n' +
  '// unbinds the default.\n'

/** Serialize the current override set back into a JSONC body for `keybindings:save`. */
function serializeOverrides(entries: OverrideEntry[]): string {
  if (entries.length === 0) return FILE_HEADER + '[]\n'
  return FILE_HEADER + JSON.stringify(entries, null, 2) + '\n'
}

/**
 * Keybindings store (T1 P2) — holds the RESOLVED table (built-in defaults ←
 * the user's `keybindings.json`) and keeps it live.
 *
 * Main owns the file + the chokidar watch (`src/main/keybindings.ts`); this
 * store calls `keybindings:load` once at boot and then applies every
 * `keybindings:changed` push, so a hand-edit takes effect without a restart.
 *
 * Consumers: `App.vue`'s `useShortcuts([...])` (its renderer-level chord
 * watchers re-key when `resolved` changes), plus the `<kbd>` hints in
 * `EmptyState.vue` / `SessionMenu.vue` (made reactive in P3, reading this
 * store). The native menu accelerators were threaded from the resolved table in
 * P3 too (`src/main/menu.ts`).
 */
export const useKeybindingsStore = defineStore('keybindings', () => {
  // Seed with defaults-only so `chordFor()` returns sane values during the
  // brief window before `keybindings:load` resolves. `mac` is passed on every
  // resolve so the `Ctrl`/`Cmd` fold matches this platform (keybindings-core).
  const resolved = ref<ResolvedKeybindings>(resolveKeybindings(null, { mac: isMac }))
  const path = ref<string>('')

  // Serialize `keybindings:save` calls: two quick clicks (Reset all then a
  // rebind) must land on disk in issue order, or the chokidar watch reconciles
  // to the wrong one. Each `applyOverrides` awaits the prior save.
  let saveChain: Promise<unknown> = Promise.resolve()

  let started = false
  let unsubscribe: (() => void) | null = null
  // Dedupe the "some overrides were ignored" toast so the watcher can't spam it
  // when the file is saved repeatedly with the same mistake.
  let lastWarningSig = ''

  function warnIfNeeded(next: ResolvedKeybindings): void {
    const sig = next.warnings.map((w) => `${w.code}:${w.command ?? ''}:${w.key ?? ''}`).join('|')
    if (!sig || sig === lastWarningSig) {
      lastWarningSig = sig
      return
    }
    lastWarningSig = sig
    useUiStore().pushToast({
      kind: 'danger',
      title: i18n.global.t('keybindings.toast.warnings.title'),
      description: i18n.global.t('keybindings.toast.warnings.description', {
        count: next.warnings.length
      })
    })
  }

  async function init(): Promise<void> {
    if (started) return
    started = true
    const { path: p, resolved: r } = await window.api.keybindingsLoad()
    path.value = p
    resolved.value = r
    warnIfNeeded(r)
    unsubscribe = window.api.onKeybindingsChanged(({ resolved: incoming }) => {
      resolved.value = incoming
      warnIfNeeded(incoming)
    })
  }

  /**
   * Re-read + re-watch. Called after `settings.json` relocates (the file moves
   * with it, Q3) so the watch re-targets the new directory.
   */
  async function reload(): Promise<void> {
    const { path: p, resolved: r } = await window.api.keybindingsLoad()
    path.value = p
    resolved.value = r
    warnIfNeeded(r)
  }

  /** The resolved chord for an action id, or `undefined` when unbound / unknown. */
  function chordFor(id: ShortcutActionId): string | undefined {
    return resolved.value.byId[id]?.keys ?? undefined
  }

  /**
   * The override set a resolved table implies — every row that is not a plain
   * default. This is the SANITIZED set: an entry the resolver rejected (reserved
   * chord, non-accelerator chord) never reaches `source: 'override'`, so it is
   * absent here and therefore never written back to disk.
   */
  function overridesFrom(r: ResolvedKeybindings): OverrideEntry[] {
    const out: OverrideEntry[] = []
    for (const b of r.list) {
      if (b.source === 'override') out.push({ command: b.id, key: b.keys })
      else if (b.source === 'unbound') out.push({ command: b.id, key: null })
    }
    return out
  }

  /**
   * Apply a mutation to the override set, write it to `keybindings.json`, and
   * optimistically re-resolve so the pane (chords + conflict badges) updates
   * without waiting for the chokidar round-trip. `keybindings:changed` then
   * confirms it. The Settings pane (P4) is the only caller.
   *
   * What is persisted is the set implied by the RE-RESOLVED table, not the raw
   * mutation: a rejected entry (bind to a reserved chord, or a chord Electron
   * can't express on a menu-backed action) must not linger in the file
   * re-triggering the "some shortcuts were ignored" toast on every reconcile.
   * `warnIfNeeded` fires here too so that feedback is immediate rather than
   * arriving a chokidar round-trip later.
   */
  async function applyOverrides(
    mutate: (draft: OverrideEntry[]) => OverrideEntry[]
  ): Promise<void> {
    const next = mutate(overridesFrom(resolved.value))
    const resolvedNext = resolveKeybindings(next, { mac: isMac })
    resolved.value = resolvedNext
    warnIfNeeded(resolvedNext)
    const body = serializeOverrides(overridesFrom(resolvedNext))
    saveChain = saveChain.catch(() => {}).then(() => window.api.keybindingsSave(body))
    await saveChain
  }

  /** Rebind one action to a canonical chord (`null` unbinds it). */
  function setBinding(id: ShortcutActionId, keys: string | null): Promise<void> {
    return applyOverrides((draft) => [
      ...draft.filter((e) => e.command !== id),
      { command: id, key: keys }
    ])
  }

  /** Drop one action's override — it falls back to the built-in default. */
  function resetBinding(id: ShortcutActionId): Promise<void> {
    return applyOverrides((draft) => draft.filter((e) => e.command !== id))
  }

  /** Drop every override — the whole table returns to defaults. */
  function resetAll(): Promise<void> {
    return applyOverrides(() => [])
  }

  /**
   * Open the raw `keybindings.json` in a MarkdownPane helper pane, in edit mode
   * (T1 P5). The shared destination for `app.openKeybindings` (menu item + the
   * ⌘⌥K chord, dispatched from `App.vue`) and the pane's "Open keybindings.json"
   * button. The file sits outside every known Harnu root — the confined
   * `markdown:read` / `:write` / `:watch` channels take an exact-path exception
   * for it (`src/main/markdown-*.ts`). The pane lands in the active folder's
   * helper stack; with nothing selected there is no stack to land in, so we
   * surface a toast instead.
   */
  function openInEditor(): void {
    const helpers = useHelpersStore()
    const ui = useUiStore()
    const worktree = helpers.currentWorktreePath
    if (!worktree) {
      ui.pushToast({
        kind: 'danger',
        title: i18n.global.t('keybindings.toast.openNeedsFolder.title'),
        description: i18n.global.t('keybindings.toast.openNeedsFolder.description')
      })
      return
    }
    // `path` is empty only in the boot window before `keybindingsLoad()` resolves
    // (`init()` is fire-and-forget). A folder IS open, so bail quietly instead of
    // flashing "open a folder first" — the button/chord just no-ops for that tick.
    if (!path.value) return
    helpers.addMarkdownHelper(worktree, path.value, worktree, { initialMode: 'edit' })
    // The pane opens next to the main view; the Settings dialog is `fixed
    // inset-0` (teleported to body) and would sit on top of it. Close it, same
    // gesture as `RoadmapBoard.openDetailDoc` clearing its modal after the add.
    // A no-op when opened from the ⌘⌥K chord / View menu with no dialog up.
    ui.closeDialog()
  }

  function dispose(): void {
    unsubscribe?.()
    unsubscribe = null
    started = false
    lastWarningSig = ''
  }

  return {
    resolved,
    path,
    init,
    reload,
    chordFor,
    setBinding,
    resetBinding,
    resetAll,
    openInEditor,
    dispose
  }
})
