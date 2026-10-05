import type { Terminal } from '@xterm/xterm'

/**
 * Hooks the shared terminal keymap needs from its host pane. Kept as plain
 * callbacks so this module stays free of Pinia/Vue — it only knows xterm.
 */
export interface TerminalKeymapHooks {
  /** Send raw bytes straight to the PTY (for control-byte chords). */
  write: (data: string) => void
  /** Nudge the terminal font size by `delta` steps (caller clamps + persists). */
  fontStep: (delta: number) => void
  /** Reset the terminal font size to its default. */
  fontReset: () => void
}

/**
 * Install Harnu's terminal keymap on a freshly-created xterm instance.
 *
 * xterm.js allows exactly ONE custom key-event handler per terminal (a second
 * `attachCustomKeyEventHandler` replaces the first), so every app-level chord
 * lives here. Returning `false` swallows the key (xterm calls `preventDefault`
 * and emits nothing); returning `true` lets xterm handle it as usual.
 *
 * Bindings mirror `design.md` §6 (and WezTerm's defaults):
 *
 *  - Copy  — `Ctrl+Shift+C` (Linux/Win) / `⌘C` (mac), only when a selection
 *            exists. xterm draws its own selection layer that the OS "copy"
 *            role can't see, so we read `term.getSelection()` ourselves.
 *  - Paste — `Ctrl+Shift+V` / `⌘V`, via `term.paste()` so bracketed-paste mode
 *            is honored (a multi-line paste doesn't auto-submit in the Claude
 *            TUI / shell).
 *  - `Shift+Enter` → insert a soft newline (`\x0a`, i.e. LF / Ctrl+J — the
 *            sequence Claude Code documents as "insert newline, any terminal").
 *            Plain `Enter` keeps sending `\r` (submit). Mirrors what WezTerm /
 *            iTerm2 give inside the Claude TUI.
 *  - `Ctrl+Backspace`  → delete previous word (`\x17`). xterm's default for
 *            this chord is `\x08`, which the Claude TUI ignores (the bug).
 *  - `Shift+Backspace` → delete previous char (`\x7f`), same as plain
 *            Backspace; xterm's default `\x08` did nothing.
 *  - `Ctrl/⌘ + =`/`-`/`0` → font larger / smaller / reset.
 *
 * macOS caveat: `⌘C`/`⌘V` are bound by the Electron `editMenu` role at the OS
 * menu level, which intercepts them before xterm (see `src/main/menu.ts` —
 * xterm cannot intercept menu accelerators). The `⌘` branch here is
 * best-effort; full mac-native `⌘C` parity for the terminal needs a separate
 * Edit-menu integration. `Ctrl+Shift+C/V` is unaffected and works everywhere.
 */
/**
 * Fully consume a chord we've handled ourselves and tell xterm not to emit a
 * byte for it (the `false` return value). Two side effects are mandatory:
 *
 *  - `preventDefault()` — returning `false` only stops xterm's own byte, it
 *    does NOT suppress the browser's native action for the chord. For paste
 *    that would mean a SECOND paste (xterm also handles the native `paste`
 *    event → double-paste); for Ctrl+Shift+C it opens DevTools; for
 *    Ctrl/⌘ +/-/0 it zooms the whole window.
 *  - `stopPropagation()` — without it the keydown bubbles up to the
 *    window-level shortcut layer (`useMagicKeys` in `useShortcuts.ts`), which
 *    keys off the *physical* key and ignores modifiers. That is the focus-jump
 *    bug: an intercepted `Shift+Enter` still reaches the global `Enter`
 *    binding (`sidebar.cursor.activate`), which activates the keyboard cursor
 *    and switches the visible session out from under the terminal. xterm's own
 *    native-key path already does both via its internal `_cancel`; chords we
 *    intercept bail out before that point, so we replicate it here.
 */
function swallow(e: KeyboardEvent): false {
  e.preventDefault()
  e.stopPropagation()
  return false
}

export function installTerminalKeymap(term: Terminal, hooks: TerminalKeymapHooks): void {
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true

    // Clipboard chord: Ctrl+Shift (Linux/Win) or bare ⌘ (mac), never Alt.
    const clip = !e.altKey && ((e.ctrlKey && e.shiftKey) || (e.metaKey && !e.ctrlKey))
    if (clip && e.code === 'KeyC') {
      if (term.hasSelection()) void navigator.clipboard.writeText(term.getSelection())
      return swallow(e)
    }
    if (clip && e.code === 'KeyV') {
      void navigator.clipboard.readText().then((txt) => {
        if (txt) term.paste(txt)
      })
      return swallow(e)
    }

    // Shift+Enter → soft newline. Plain Enter sends `\r` (submit); xterm
    // ignores the Shift modifier and would also submit, so intercept it and
    // send `\x0a` (LF / Ctrl+J), which Claude Code treats as a newline insert.
    if (
      (e.code === 'Enter' || e.code === 'NumpadEnter') &&
      e.shiftKey &&
      !e.ctrlKey &&
      !e.altKey &&
      !e.metaKey
    ) {
      hooks.write('\x0a')
      return swallow(e)
    }

    // Deletion chords — only the bare modifier, so we don't shadow
    // Ctrl+Shift+Backspace or Alt+Backspace (xterm's own word-delete).
    if (e.code === 'Backspace') {
      if (e.ctrlKey && !e.shiftKey && !e.metaKey && !e.altKey) {
        hooks.write('\x17') // unix-word-rubout → delete previous word
        return swallow(e)
      }
      if (e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        hooks.write('\x7f') // DEL → delete previous char
        return swallow(e)
      }
    }

    // Font size — Ctrl/⌘ with '='/'+' (Equal), '-' (Minus), '0' (Digit0).
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      if (e.code === 'Equal') {
        hooks.fontStep(1)
        return swallow(e)
      }
      if (e.code === 'Minus') {
        hooks.fontStep(-1)
        return swallow(e)
      }
      if (e.code === 'Digit0') {
        hooks.fontReset()
        return swallow(e)
      }
    }

    return true
  })
}
