/**
 * Path-injection escaping — the pure core behind "drop a file into a session".
 *
 * When a terminal-native file drop happens (dragging a file into GNOME Terminal,
 * iTerm, Konsole, …), the emulator pastes the file's absolute path with every
 * shell-special character BACKSLASH-escaped — `My Project` becomes
 * `My\ Project`, `PRD (draft).md` becomes `PRD\ \(draft\).md`. Claude Code's
 * paste-path detection parses exactly this backslash-escaped form and turns a
 * recognised path into an `[Image #N]` / file reference. So to make Harnu inject
 * a path the same way a real drop does, we reproduce that escaping rather than
 * wrapping in quotes (Claude Code's detector keys on the backslash form, not
 * `'…'`).
 *
 * This module is the pure, framework-free escaper (mirrors the ADR-0001 house
 * style of `prompt-submit.ts` / `prompt-inject-gate.ts`): no electron, no store,
 * no PTY — just string → string, so it is unit-testable in isolation
 * (`tests/path-inject.test.ts`). The store's `injectPathIntoSession` composes it
 * with the writer bus.
 */

/**
 * Characters a terminal-native file drop backslash-escapes when it pastes a
 * path. Whitespace (space, tab) plus the POSIX shell metacharacters and glob /
 * expansion sigils. The backslash itself is included so it is escaped first-class
 * by the same pass. Kept as an explicit char class for auditability.
 */
const SHELL_SPECIAL = /[ \t'"`\\()[\]{}$&;|<>*?#~!]/g

/**
 * Escape an absolute path the way a terminal-native file drop emits it:
 * backslash-escape every shell-special char (space, tab, quotes, backtick,
 * backslash, parens, brackets, braces, `$ & ; | < > * ? # ~ !`). A path with no
 * special characters is returned UNCHANGED. Does NOT wrap in quotes — Claude
 * Code's paste-path detection parses the backslash-escaped form. Pure + total.
 */
export function shellEscapePath(absPath: string): string {
  return absPath.replace(SHELL_SPECIAL, '\\$&')
}
