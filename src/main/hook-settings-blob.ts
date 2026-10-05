/**
 * Per-session hook injection blob (T92 — hook-driven fleet state).
 *
 * Instead of (only) installing observer hooks into the user's global
 * `~/.claude/settings.json` (`hook-installer.ts`), Harnu can inject the SAME
 * loopback hooks into each `claude` session it spawns via `claude --settings
 * '<inline JSON>'` — a per-launch settings SOURCE that merges additively with the
 * user's own sources, with ZERO edits to any file on disk. The events POST to the
 * exact same Hook Bridge endpoint (`hook-bridge.ts`) the global install uses, so
 * they fold into the identical per-session task-state FSM + fleet overlay.
 *
 * This module is PURE (no electron / node-fs / net) so it unit-tests in the node
 * vitest env like `claude-args.ts`: {@link buildHookSettingsBlob} composes the
 * inline settings object, and {@link injectHookSettings} composes it into an argv
 * that may ALREADY carry a user `--settings` — the merge rule is the delicate part
 * (§ "Merge with a user-provided --settings" below).
 *
 * Deliberately NARROW event set (spec §2): UserPromptSubmit → working · Stop →
 * idle (its payload natively carries `last_assistant_message`) · Notification →
 * needs-you / idle (routed by `notification_type`) · SessionStart / SessionEnd →
 * lifecycle. High-frequency PreToolUse/PostToolUse and the decision-carrying
 * PreToolUse/PermissionRequest are OMITTED on purpose — chatty events would spam
 * the bridge, and duplicating the global install's PermissionRequest here would
 * double-fire the Approval Inbox. State observation only.
 */

import { splitOptionArgs } from './claude-args'

/** Per-hook timeout (SECONDS). Mirrors `hook-installer.ts#HOOK_TIMEOUT_S` — a hung
 *  bridge must never stall Claude past this, so `5` stays well under CC's 10-min
 *  default. */
export const HOOK_TIMEOUT_S = 5

/** Marker key stamped on each handler (mirror of `hook-installer.ts#SENTINEL`),
 *  so an operator inspecting the argv can tell the blob is Harnu's. Purely
 *  cosmetic here — the blob is ephemeral (never written to disk), so identity /
 *  pruning never keys off it (that only matters for the global settings.json). */
const HARNU_HOOK_MARKER = '_harnu'

/**
 * The Notification `notification_type`s that mean "blocked on you" (spec §4). A
 * Notification hook carrying one of these routes the session to `needs-input`
 * (→ the fleet's needs-you). `idle_prompt` is deliberately NOT here — it is the
 * 60s "still there?" nudge, which Harnu classifies as genuinely `idle`, matching
 * the shipped `reduceTaskState` semantics (see `hook-state.ts`).
 */
export const NEEDS_YOU_NOTIFICATION_TYPES: readonly string[] = [
  'permission_prompt',
  'worker_permission_prompt',
  'elicitation_dialog'
]

/** The Notification types the blob subscribes to (the blocking set + the idle
 *  nudge, so `idle_prompt` still relaxes a session to idle event-drivenly). */
const NOTIFICATION_TYPES: readonly string[] = [...NEEDS_YOU_NOTIFICATION_TYPES, 'idle_prompt']

type Handler = Record<string, unknown>
type MatcherEntry = { matcher?: string; hooks: Handler[] }
export type HookSettingsBlob = {
  hooks: Record<string, MatcherEntry[]>
  preferredNotifChannel: string
}

/**
 * The loopback bridge URL for one event/tag — byte-identical in shape to
 * `hook-installer.ts#makeHandler` so the SAME `hook-bridge` request parser
 * (`/hook/<token>/<event>/<tag>`) validates + routes it. `tag` is the semantic
 * discriminator baked into the path (the bridge recovers the matcher from it
 * without parsing body field names); `_` means "no matcher".
 */
function bridgeUrl(port: number, token: string, event: string, tag: string): string {
  return `http://127.0.0.1:${port}/hook/${token}/${event}/${tag}`
}

function httpHandler(port: number, token: string, event: string, tag: string): Handler {
  return {
    type: 'http',
    url: bridgeUrl(port, token, event, tag),
    timeout: HOOK_TIMEOUT_S,
    [HARNU_HOOK_MARKER]: 'v1'
  }
}

/**
 * Build the inline `--settings` object injected at spawn. `port`/`token` point at
 * the live Hook Bridge. Also sets `preferredNotifChannel: 'notifications_disabled'`
 * so the spawned session never rings its own terminal bell — Harnu owns the single
 * notification surface (sound + OS attention), fed from these very hook events.
 */
export function buildHookSettingsBlob(port: number, token: string): HookSettingsBlob {
  const hooks: Record<string, MatcherEntry[]> = {
    UserPromptSubmit: [{ hooks: [httpHandler(port, token, 'UserPromptSubmit', '_')] }],
    Stop: [{ hooks: [httpHandler(port, token, 'Stop', '_')] }],
    SessionStart: [{ hooks: [httpHandler(port, token, 'SessionStart', '_')] }],
    SessionEnd: [{ hooks: [httpHandler(port, token, 'SessionEnd', '_')] }],
    Notification: NOTIFICATION_TYPES.map((t) => ({
      matcher: t,
      hooks: [httpHandler(port, token, 'Notification', t)]
    }))
  }
  return { hooks, preferredNotifChannel: 'notifications_disabled' }
}

/** Serialize the blob to the single argv token `--settings` receives. Compact
 *  (no indentation) — it is one process arg, spawned WITHOUT a shell, so no
 *  quoting/escaping is needed. */
export function buildHookSettingsBlobJson(port: number, token: string): string {
  return JSON.stringify(buildHookSettingsBlob(port, token))
}

// ─── Merge with a user-provided --settings ────────────────────────────────────
//
// The user's Claude Boot config may already put a `--settings` on the argv, whose
// value is EITHER an inline JSON object OR a path to a settings file. We must add
// our hooks WITHOUT clobbering that value (spec §2):
//
//   • no user --settings          → emit `--settings <blob>`.
//   • user inline JSON (`{…}`)     → deep-merge our hooks INTO it (arrays concat,
//                                     user entries first) and set our notif channel
//                                     only if the user didn't → one `--settings`.
//   • user file PATH (or a `{…}`   → keep the user's `--settings <value>` VERBATIM
//     that fails to parse)           and DON'T add ours. `--settings` is a single
//                                     settings source (not repeatable-safe), so a
//                                     second flag risks last-wins clobbering; we
//                                     never risk the user's value. Such a session
//                                     still gets fleet state from the GLOBAL install
//                                     (its hooks live in the user settings source,
//                                     which merges additively with the file source).

/** True when a `--settings` value is inline JSON (an object) rather than a path. */
function isInlineJsonObject(value: string): boolean {
  return value.trim().startsWith('{')
}

/**
 * Deep-merge our blob into a user's inline-JSON `--settings` value. Hooks arrays
 * concat per-event with the USER's entries first (ours appended), so both fire and
 * the user's ordering is preserved; every other user key is kept untouched;
 * `preferredNotifChannel` is set to our value ONLY when the user hasn't chosen one.
 * Returns the merged JSON string, or `null` if the user value doesn't parse to an
 * object (caller then keeps the user value verbatim and skips our injection).
 */
export function mergeInlineSettings(userJson: string, blobJson: string): string | null {
  let user: Record<string, unknown>
  try {
    const parsed = JSON.parse(userJson)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    user = parsed as Record<string, unknown>
  } catch {
    return null
  }
  const blob = JSON.parse(blobJson) as HookSettingsBlob
  const out: Record<string, unknown> = { ...user }

  // hooks: concat per-event (user first, ours appended).
  const userHooks =
    user.hooks && typeof user.hooks === 'object' && !Array.isArray(user.hooks)
      ? (user.hooks as Record<string, MatcherEntry[]>)
      : {}
  const mergedHooks: Record<string, MatcherEntry[]> = { ...userHooks }
  for (const [event, entries] of Object.entries(blob.hooks)) {
    mergedHooks[event] = [...(userHooks[event] ?? []), ...entries]
  }
  out.hooks = mergedHooks

  // notif channel: never override an explicit user choice.
  if (!('preferredNotifChannel' in user)) out.preferredNotifChannel = blob.preferredNotifChannel

  return JSON.stringify(out)
}

/**
 * Compose the `--settings` argv token(s) for a SINGLE user value (or none). See
 * the merge table above. Pure; returns the flag+value pair(s) to emit.
 */
export function composeSettingsArgs(userVal: string | undefined, blobJson: string): string[] {
  const u = userVal?.trim()
  if (!u) return ['--settings', blobJson] // no user value → just ours
  if (isInlineJsonObject(u)) {
    const merged = mergeInlineSettings(u, blobJson)
    if (merged) return ['--settings', merged] // inline JSON → composed single value
    // parse failure → treat as opaque; keep verbatim (fall through)
  }
  return ['--settings', u] // file path (or unparseable) → keep user's, skip ours
}

/**
 * Inject the hook-settings blob into a fully-built `claude` argv, honoring any
 * `--settings` the user already supplied. Handles both `--settings <v>` (two
 * tokens) and `--settings=<v>` (one token). With more than one user `--settings`
 * (an extraArgs edge case), every user value is kept verbatim and ours is skipped
 * — too ambiguous to safely merge. Pure — the single source of truth for the
 * injection point, shared by pty.ts's agent and non-agent claude spawns.
 *
 * SEPARATOR-AWARE (BUG-86): only the OPTION portion of the argv is scanned and
 * rewritten; the bare `--` and the positional prompt after it are re-appended
 * untouched. Emitting `--settings` past the separator would hand the CLI two
 * extra words of prompt text instead of a settings source — which is precisely
 * what freshly spawned sessions were doing. Scanning only the option portion
 * also stops a positional prompt that happens to contain the literal
 * `--settings` from being mistaken for a user value.
 */
export function injectHookSettings(args: readonly string[], blobJson: string): string[] {
  const { options, promptTail } = splitOptionArgs(args)
  const kept: string[] = []
  const userVals: string[] = []
  for (let i = 0; i < options.length; i++) {
    const t = options[i]
    if (t === '--settings') {
      if (i + 1 < options.length) {
        userVals.push(options[i + 1])
        i++
      }
      continue
    }
    if (t.startsWith('--settings=')) {
      userVals.push(t.slice('--settings='.length))
      continue
    }
    kept.push(t)
  }
  if (userVals.length === 0) return [...kept, '--settings', blobJson, ...promptTail]
  if (userVals.length === 1)
    return [...kept, ...composeSettingsArgs(userVals[0], blobJson), ...promptTail]
  // >1 user --settings → keep all verbatim, skip ours (don't risk a clobber).
  const out = [...kept]
  for (const v of userVals) out.push('--settings', v)
  return [...out, ...promptTail]
}
