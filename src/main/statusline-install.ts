/**
 * Pure install/identity helpers for the statusLine telemetry bridge.
 *
 * `statusLine` is a SINGLE top-level key in `~/.claude/settings.json` (unlike the
 * `hooks` array), so install must never clobber a user's own statusLine. Identity
 * is keyed on the writer-script PATH inside the command string — a field Claude
 * Code round-trips intact — NOT a side-channel sentinel key (lesson 002:
 * `docs/lessons/framework/002-claude-code-strips-settings-hook-keys.md`).
 *
 * Kept framework-free (no electron/fs) so it's unit-testable in the `node` vitest
 * env (`tests/statusline-install.test.ts`); the shell in `statusline.ts` does the
 * read-modify-write via `claude-settings.ts`.
 */

export interface StatusLineConfig {
  type: 'command'
  command: string
  padding?: number
}

/** Backup key holding our config when a foreign statusLine is preserved. */
const BACKUP_KEY = 'statusLine_harnu'
/** Legacy backup keys (pre-Harnu rebrand: Capy, and before it om2tab) — never written
 *  any more, but still recognized and dropped on install/strip for idempotent cleanup. */
const LEGACY_BACKUP_KEYS = ['statusLine_capy', 'statusLine_om2tab'] as const

/**
 * Bump when the writer script changes — the boot self-heal rewrites the on-disk
 * script whenever its version header doesn't match (so updates propagate).
 */
export const WRITER_SCRIPT_VERSION = 1

/**
 * The statusLine `command` script: reads the raw JSON blob Claude Code pipes on
 * stdin and drops it into `<inboxDir>/<unique>.json`. POSIX-pure (no `jq`/`node`
 * assumed on the user's PATH) — the main process extracts `session_id` from the
 * JSON content, not the filename. Carries a version header for {@link isWriterStale}.
 */
export function buildWriterScript(kind: 'sh' | 'cmd', inboxDir: string): string {
  if (kind === 'cmd') {
    return [
      '@echo off',
      `REM harnu-writer v${WRITER_SCRIPT_VERSION}`,
      `more > "${inboxDir}\\%RANDOM%%RANDOM%.json"`,
      ''
    ].join('\r\n')
  }
  return [
    '#!/bin/sh',
    `# harnu-writer v${WRITER_SCRIPT_VERSION}`,
    `cat > "${inboxDir}/$(date +%s%N)-$$.json"`,
    ''
  ].join('\n')
}

/** Writer markers we have ever stamped: current `harnu`, then legacy `capy` and `om2tab`. */
const WRITER_MARKER_RE = /\b(harnu|capy|om2tab)-writer v\d+\b/

/** True when a script carries one of our writer markers (current or legacy). */
export function isOurWriterScript(script: string | null): boolean {
  return script != null && WRITER_MARKER_RE.test(script)
}

/**
 * True when the on-disk writer is missing or is not the current `harnu-writer`
 * version. A legacy `capy-`/`om2tab-writer` script counts as stale on purpose: the
 * userData migration copies it over verbatim, and it embeds the OLD inbox dir, so
 * it must be rewritten with the current one rather than kept.
 */
export function isWriterStale(existing: string | null): boolean {
  if (existing == null) return true
  return !new RegExp(`\\bharnu-writer v${WRITER_SCRIPT_VERSION}\\b`).test(existing)
}

/**
 * Our writer is always `<userData>/statusline/statusline-writer.{sh,cmd}`, and
 * `<userData>` ends in our app dir (`Capy` before the rename, `Harnu` after), so the
 * CC-preserved marker is that whole tail — robust to CC stripping unknown keys (it
 * only rewrites the `command` it executes, never drops it). Anchored on purpose: a
 * user's own `my-statusline-writer.sh`, or one in some other app's `statusline/` dir,
 * must never be taken for ours (and overwritten).
 */
const WRITER_PATH_RE =
  /[\\/](?:Capy|capy|Harnu|harnu)[\\/]statusline[\\/]statusline-writer\.(?:sh|cmd)\b/

/** True iff the given statusLine value is one we installed (command path match). */
export function isOurStatusLine(sl: unknown): boolean {
  if (!sl || typeof sl !== 'object') return false
  const command = (sl as Record<string, unknown>).command
  return typeof command === 'string' && WRITER_PATH_RE.test(command)
}

/**
 * Non-destructive install. Installs ours when (a) no statusLine exists, or (b) the
 * existing one is already ours (idempotent path refresh). When a FOREIGN statusLine
 * is present, it is PRESERVED and ours is stashed under `statusLine_harnu` so the
 * caller can warn / offer migration. Returns the next settings plus flags.
 */
export function mergeStatusLine(
  settings: Record<string, unknown>,
  ourCommand: string
): { next: Record<string, unknown>; installed: boolean; foreignPreserved: boolean } {
  const ours: StatusLineConfig = { type: 'command', command: ourCommand }
  const current = settings.statusLine

  // `ourCommand` itself always counts as ours, whatever the userData dir is called
  // (a dev/verify instance with a custom --user-data-dir stays idempotent).
  const isCurrent =
    !!current &&
    typeof current === 'object' &&
    (current as Record<string, unknown>).command === ourCommand
  if (current == null || isCurrent || isOurStatusLine(current)) {
    const next = { ...settings, statusLine: ours }
    delete next[BACKUP_KEY] // a refreshed direct install drops any stale backup
    for (const k of LEGACY_BACKUP_KEYS) delete next[k] // also the pre-Harnu backup keys
    return { next, installed: true, foreignPreserved: false }
  }

  // Foreign statusLine present — never overwrite it. Our backup moves to the new
  // key; a legacy backup would only point at the old userData path, so drop it.
  const next = { ...settings, [BACKUP_KEY]: ours }
  for (const k of LEGACY_BACKUP_KEYS) delete next[k]
  return { next, installed: false, foreignPreserved: true }
}

/**
 * Remove only OUR statusLine (idempotent). A foreign statusLine is left untouched.
 *
 * Two identity modes:
 * - **Loose** (no `exactCommand`) — anything matching the statusline-writer basename is
 *   ours. For the explicit user toggle-off, where the intent is "no Harnu
 *   telemetry at all".
 * - **Strict** (`exactCommand`) — only a statusLine whose `command` is EXACTLY
 *   this instance's writer invocation. For automatic exit cleanup: a dev/verify
 *   instance (different userData → different writer path) quitting must never
 *   strip the statusLine of a production instance that is still running (the
 *   loose match did exactly that, silently killing telemetry fleet-wide).
 */
export function stripStatusLine(
  settings: Record<string, unknown>,
  exactCommand?: string
): Record<string, unknown> {
  const isOwn = (sl: unknown): boolean => {
    if (exactCommand === undefined) return isOurStatusLine(sl)
    if (!sl || typeof sl !== 'object') return false
    return (sl as Record<string, unknown>).command === exactCommand
  }
  const next = { ...settings }
  if (isOwn(next.statusLine)) delete next.statusLine
  if (exactCommand === undefined || isOwn(next[BACKUP_KEY])) delete next[BACKUP_KEY]
  for (const k of LEGACY_BACKUP_KEYS)
    if (exactCommand === undefined || isOwn(next[k])) delete next[k]
  return next
}
