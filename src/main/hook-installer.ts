import { copyFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { updateClaudeSettings, claudeSettingsPath } from './claude-settings'

/**
 * Installs/uninstalls Harnu's observer hooks into the user's global
 * `~/.claude/settings.json` (session-state real-state spec §4.3). We identify our
 * own handlers by their loopback bridge-URL shape (`isOurs`) so we touch EXACTLY
 * ours and nothing the user hand-added — NOT by the `_harnu` sentinel, which
 * Claude Code strips from hook handlers whenever it rewrites settings.json (it
 * still gets written as a fallback signal, but identity must not depend on it).
 * `reconcileHooks` is the self-healing core: on every boot it
 * prunes DEAD peers (stale entries left by crashed/killed instances — the cause
 * of `ECONNREFUSED` spam in later Claude sessions) and our own prior entry,
 * keeps LIVE peers + foreign hooks, and re-adds ours with the live port.
 *
 * The hooks are pure observers: the bridge always answers 200 with no decision
 * field, so they can never block or alter a session (spec §4.1).
 */

export const SENTINEL = '_harnu'
/** Legacy sentinels, newest first: `_capy` (pre-Harnu rebrand) and `_om2tab`
 *  (pre-Capy rebrand). Never written any more; still recognized so old installs
 *  get pruned and replaced instead of duplicated. */
export const LEGACY_SENTINELS = ['_capy', '_om2tab'] as const
const SENTINEL_VERSION = 'v1'
const HOOK_TIMEOUT_S = 5

export type Transport = 'http' | 'command'

type Handler = Record<string, unknown>
type MatcherEntry = { matcher?: string; hooks: Handler[] }
type HookConfig = Record<string, MatcherEntry[]>

/**
 * Events we observe. `settingsMatcher` is Claude Code's own filter (tool matcher
 * for PreToolUse, notification type for Notification); `tag` is the semantic
 * discriminator baked into the URL path so the bridge can recover it without
 * parsing payload field names. Deliberately omits high-frequency
 * PostToolUse/PostToolBatch in v1 (the watcher already signals "writing"=Working).
 */
const EVENT_SPECS: Array<{ event: string; settingsMatcher?: string; tag: string }> = [
  { event: 'Notification', settingsMatcher: 'permission_prompt', tag: 'permission_prompt' },
  { event: 'Notification', settingsMatcher: 'idle_prompt', tag: 'idle_prompt' },
  { event: 'Stop', tag: '_' },
  { event: 'StopFailure', tag: '_' },
  { event: 'UserPromptSubmit', tag: '_' },
  { event: 'SessionStart', tag: '_' },
  { event: 'SessionEnd', tag: '_' },
  { event: 'PreToolUse', settingsMatcher: '*', tag: '_' },
  { event: 'PermissionRequest', tag: '_' }
]

function makeHandler(
  port: number,
  token: string,
  event: string,
  tag: string,
  transport: Transport
): Handler {
  const url = `http://127.0.0.1:${port}/hook/${token}/${event}/${tag}`
  const base: Handler =
    transport === 'command'
      ? { type: 'command', command: `curl -s -X POST --data-binary @- ${url}` }
      : { type: 'http', url }
  return { ...base, timeout: HOOK_TIMEOUT_S, [SENTINEL]: SENTINEL_VERSION }
}

/** Build the `hooks` fragment Harnu owns: `{ [event]: [{ matcher?, hooks: [handler] }] }`. */
export function buildHookConfig(
  port: number,
  token: string,
  transport: Transport = 'http'
): HookConfig {
  const cfg: HookConfig = {}
  for (const spec of EVENT_SPECS) {
    const entry: MatcherEntry = {
      ...(spec.settingsMatcher ? { matcher: spec.settingsMatcher } : {}),
      hooks: [makeHandler(port, token, spec.event, spec.tag, transport)]
    }
    ;(cfg[spec.event] ??= []).push(entry)
  }
  return cfg
}

/** The loopback bridge URL embedded in a handler — its `url`, or the curl URL in
 *  `command` — regardless of whether the sentinel survived. */
function candidateUrl(h: Handler): string | null {
  if (typeof h.url === 'string') return h.url
  if (typeof h.command === 'string') {
    const m = h.command.match(/https?:\/\/\S+/)
    return m ? m[0] : null
  }
  return null
}

/** Our bridge URL shape: `//127.0.0.1:<port>/hook/<token>/<event>/<tag>`. */
const BRIDGE_URL = /\/\/127\.0\.0\.1:\d+\/hook\/[^/]+\/[^/]+\/[^/]+/

/**
 * True if a handler is one of ours. The PRIMARY signal is the bridge-URL shape,
 * which Claude Code preserves; the `_harnu` sentinel is only a fallback because
 * CC re-serializes settings.json through a strict schema that strips unknown keys
 * from hook handlers on every settings write (e.g. `/model`). Keying identity on
 * the sentinel alone blinded the whole self-heal once CC stripped it — the cause
 * of the persistent `ECONNREFUSED` orphans this guards against.
 */
function isOurs(h: Handler): boolean {
  const url = candidateUrl(h)
  if (url && BRIDGE_URL.test(url)) return true
  return SENTINEL in h || isLegacyTagged(h)
}

/** True if a handler still carries a pre-Harnu sentinel (`_capy` / `_om2tab`). */
function isLegacyTagged(h: Handler): boolean {
  return LEGACY_SENTINELS.some((k) => k in h)
}

/** The bridge URL of one of our handlers, or null if it isn't ours. */
function hookUrl(h: Handler): string | null {
  return isOurs(h) ? candidateUrl(h) : null
}

/** The loopback port one of our handlers POSTs to, or null if not ours / unparseable. */
export function hookPort(h: Handler): number | null {
  const url = hookUrl(h)
  const m = url?.match(/127\.0\.0\.1:(\d+)\/hook\//)
  return m ? Number(m[1]) : null
}

/** The bridge token (uuid) baked into one of our handler URLs, or null. */
export function hookToken(h: Handler): string | null {
  const url = hookUrl(h)
  const m = url?.match(/\/hook\/([^/]+)\//)
  return m ? m[1] : null
}

/** Distinct loopback ports across all of our handlers in `settings`. */
export function harnuPorts(settings: Record<string, unknown>): number[] {
  const hooks = settings.hooks as HookConfig | undefined
  if (!hooks) return []
  const ports = new Set<number>()
  for (const entries of Object.values(hooks))
    for (const e of entries)
      for (const h of e.hooks ?? []) {
        const p = hookPort(h)
        if (p !== null) ports.add(p)
      }
  return [...ports]
}

export interface ReconcileOpts {
  /** Our fresh hook fragment to install (omit to only prune). */
  add?: HookConfig
  /** Remove our handlers carrying this token (idempotent re-install / own cleanup). */
  ourToken?: string
  /** Remove our handlers whose port is in this set (stale peers from dead instances). */
  deadPorts?: ReadonlySet<number>
}

/**
 * Self-healing reconcile: strip our handlers that are stale (token === ourToken,
 * or port in deadPorts), keep everything else — including LIVE peer instances'
 * handlers (so a second instance never clobbers a running one) and all foreign
 * hooks — then merge `add` if given. Drops emptied entries/events; removes the
 * `hooks` key if nothing remains. Pure (the caller supplies `deadPorts` after
 * probing).
 */
export function reconcileHooks(
  settings: Record<string, unknown>,
  opts: ReconcileOpts
): Record<string, unknown> {
  const { add, ourToken, deadPorts } = opts
  const src = settings.hooks as HookConfig | undefined
  const stale = (h: Handler): boolean => {
    if (!isOurs(h)) return false
    // A pre-Harnu sentinel (`_capy`/`_om2tab`) means the entry was written by a
    // build this one replaces: always prune it, so the rename never leaves a
    // second observer (or a dead-port orphan) behind beside our `_harnu` entry.
    if (isLegacyTagged(h)) return true
    if (ourToken != null && hookToken(h) === ourToken) return true
    const port = hookPort(h)
    return port != null && !!deadPorts?.has(port)
  }
  const out: HookConfig = {}
  if (src) {
    for (const [event, entries] of Object.entries(src)) {
      const kept = entries
        .map((e) => ({ ...e, hooks: (e.hooks ?? []).filter((h) => !stale(h)) }))
        .filter((e) => e.hooks.length > 0)
      if (kept.length > 0) out[event] = kept
    }
  }
  if (add) {
    for (const [event, entries] of Object.entries(add)) {
      out[event] = [...(out[event] ?? []), ...entries]
    }
  }
  const result = { ...settings }
  if (Object.keys(out).length > 0) result.hooks = out
  else delete result.hooks
  return result
}

/** True if any sentinel-tagged handler is present in `settings.hooks`. */
export function hasOurHooks(settings: Record<string, unknown>): boolean {
  const hooks = settings.hooks as HookConfig | undefined
  if (!hooks) return false
  return Object.values(hooks).some((entries) => entries.some((e) => (e.hooks ?? []).some(isOurs)))
}

/** Remove every sentinel-tagged handler; drop entries/events left empty. */
export function stripOurHooks(settings: Record<string, unknown>): Record<string, unknown> {
  const src = settings.hooks as HookConfig | undefined
  const result = { ...settings }
  if (!src) return result

  const out: HookConfig = {}
  for (const [event, entries] of Object.entries(src)) {
    const kept = entries
      .map((e) => ({ ...e, hooks: (e.hooks ?? []).filter((h) => !isOurs(h)) }))
      .filter((e) => e.hooks.length > 0)
    if (kept.length > 0) out[event] = kept
  }
  if (Object.keys(out).length > 0) result.hooks = out
  else delete result.hooks
  return result
}

/** Merge our hooks in, replacing any stale entries first — including legacy
 *  `_capy` / `_om2tab` ones (back-compat) — so re-install stays idempotent. */
export function mergeHooks(
  settings: Record<string, unknown>,
  ourHooks: HookConfig
): Record<string, unknown> {
  const cleaned = stripOurHooks(settings)
  const existing = (cleaned.hooks as HookConfig | undefined) ?? {}
  const mergedHooks: HookConfig = { ...existing }
  for (const [event, entries] of Object.entries(ourHooks)) {
    mergedHooks[event] = [...(mergedHooks[event] ?? []), ...entries]
  }
  return { ...cleaned, hooks: mergedHooks }
}

export interface InstallOpts {
  path?: string
  transport?: Transport
  /** Stale peer ports to prune (probed by the bridge); defaults to none. */
  deadPorts?: ReadonlySet<number>
}

/**
 * Install/refresh our hooks: prune stale peers (dead ports) and our own prior
 * entry, KEEP live peers + foreign hooks, then add our fresh entry. Safe to run
 * on every boot and idempotent on re-install with the same token.
 */
export async function installHooks(
  port: number,
  token: string,
  opts: InstallOpts = {}
): Promise<void> {
  const path = opts.path ?? claudeSettingsPath()
  await updateClaudeSettings(path, (settings) =>
    reconcileHooks(settings, {
      add: buildHookConfig(port, token, opts.transport),
      ourToken: token,
      deadPorts: opts.deadPorts ?? new Set()
    })
  )
}

/**
 * Prune stale entries WITHOUT installing — used on a disabled boot to clear
 * leftovers from a prior enabled instance that crashed.
 */
export async function pruneHooks(opts: {
  path?: string
  ourToken?: string
  deadPorts?: ReadonlySet<number>
}): Promise<void> {
  const path = opts.path ?? claudeSettingsPath()
  await updateClaudeSettings(path, (settings) =>
    reconcileHooks(settings, { ourToken: opts.ourToken, deadPorts: opts.deadPorts })
  )
}

/**
 * Remove our hooks. With `token`, removes only that instance's entry (keeps live
 * peers); without it, strips all of ours (the explicit global opt-out).
 */
export async function uninstallHooks(opts: { path?: string; token?: string } = {}): Promise<void> {
  const path = opts.path ?? claudeSettingsPath()
  await updateClaudeSettings(path, (settings) =>
    opts.token != null
      ? reconcileHooks(settings, { ourToken: opts.token })
      : stripOurHooks(settings)
  )
}

/**
 * Synchronous mirror of `claude-settings.ts`'s `atomicWrite` for exit handlers:
 * back up the prior bytes to `<path>.backup` (best-effort), write a `*.tmp`
 * sibling, then `renameSync` it over the target so a SIGKILL mid-write can never
 * truncate the co-owned settings.json.
 */
function atomicWriteSync(path: string, content: string): void {
  try {
    copyFileSync(path, `${path}.backup`)
  } catch {
    /* best-effort backup: source may not exist yet */
  }
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, path)
}

/**
 * Synchronous own-entry removal for process-exit handlers (where async I/O can't
 * complete). Best-effort: never throws — a missing/garbage settings file is left
 * untouched. Removes only our token's handlers, so a live peer is preserved.
 */
export function removeOwnHooksSync(token: string, path?: string): void {
  const p = path ?? claudeSettingsPath()
  try {
    const raw = readFileSync(p, 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
    const next = reconcileHooks(parsed as Record<string, unknown>, { ourToken: token })
    const out = JSON.stringify(next, null, 2) + '\n'
    if (out !== raw) atomicWriteSync(p, out) // skip pointless writes (e.g. hooks disabled)
  } catch {
    /* exit-path best-effort: never throw */
  }
}
