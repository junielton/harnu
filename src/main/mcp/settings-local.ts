/**
 * Durable "always allow this verb here" grants (T93 piece 4), as PURE functions.
 *
 * When the operator ticks "always allow this verb here" on an agent-action confirm,
 * Harnu writes a `mcp__harnu__<verb>` allow rule into the target folder's
 * `.claude/settings.local.json` — adopting CC's OWN native permission persistence
 * (`{ "permissions": { "allow": [...] } }`) instead of an in-memory-only grant, so
 * it survives restarts. Harnu's own confirm gate then HONORS the same file: a future
 * call to that verb in that folder skips the human confirm.
 *
 * This module owns the two pure halves — {@link mergeVerbAllowRule} (the
 * read-merge-write transform, given a parsed object) and {@link settingsAllowsVerb}
 * (the honor-side match) — plus the rule codec and the dangerous-verb set. The fs
 * read/parse/write is the shell's job (server.ts), so this stays framework-free +
 * side-effect-free per ADR-0001 (pure-core / thin-shell) and lands in the coverage
 * surface with a deterministic read-merge-write matrix.
 *
 * SECURITY — {@link ALWAYS_ALLOWABLE_VERBS} is the allowlist BOTH the offer (which
 * confirms show the checkbox) and the honor (which persisted rules skip a confirm)
 * gate on. It deliberately EXCLUDES `plan_mission`: a durable auto-allow of the
 * grant minter would let an agent mint mission grants with no human in the loop, so
 * even a hand-written `mcp__harnu__plan_mission` (or the legacy `mcp__capy__plan_mission`) rule is ignored by the honor path.
 */

import { MCP_TOOLS, type McpOp } from './tool-catalog'
import { MCP_SERVER_NAMES, mcpToolName } from './config-file'

/** The `permissions.allow` rule that matches ONE Harnu verb (e.g. `mcp__harnu__create_session`). */
export function verbAllowRule(op: string): string {
  return mcpToolName(op)
}

/**
 * Every rule that grants `op`: the current `mcp__harnu__<op>` plus the pre-rename
 * `mcp__capy__<op>` that users' existing `settings.local.json` files still carry.
 */
function verbAllowRules(op: string): string[] {
  return MCP_SERVER_NAMES.map((server) => mcpToolName(op, server))
}

/**
 * The mutating verbs a durable "always allow" may cover. Reads never confirm, so
 * they are absent; `plan_mission` is DELIBERATELY excluded (see module doc).
 *
 * T120: DERIVED from `MCP_TOOLS`'s `alwaysAllowable` gate field (the catalog is
 * the single source of truth for gate policy) rather than a hand-maintained
 * literal — a verb is on this list iff its `McpToolDef` says so.
 */
export const ALWAYS_ALLOWABLE_VERBS: readonly McpOp[] = MCP_TOOLS.filter(
  (t) => t.alwaysAllowable
).map((t) => t.op)

const ALWAYS_ALLOWABLE_SET: ReadonlySet<string> = new Set(ALWAYS_ALLOWABLE_VERBS)

/** Whether a durable "always allow" may be offered/honored for `op`. */
export function isAlwaysAllowableVerb(op: string): boolean {
  return ALWAYS_ALLOWABLE_SET.has(op)
}

/**
 * The verbs whose "always allow" checkbox defaults UNCHECKED (T93): they run a
 * shell (`create_worktree`'s `WORKTREE.md` scripts) or open a terminal
 * (`spawn_terminal`), so a durable auto-allow must be a deliberate tick, never a
 * default. Every other allowable verb defaults checked.
 *
 * T120: DERIVED from `MCP_TOOLS`'s `dangerousAlwaysAllow` gate field — see
 * {@link ALWAYS_ALLOWABLE_VERBS}'s doc for why.
 */
export const DANGEROUS_ALWAYS_ALLOW_VERBS: readonly McpOp[] = MCP_TOOLS.filter(
  (t) => t.dangerousAlwaysAllow
).map((t) => t.op)

const DANGEROUS_SET: ReadonlySet<string> = new Set(DANGEROUS_ALWAYS_ALLOW_VERBS)

/** Initial checkbox state for `op`'s "always allow" offer: unchecked iff dangerous. */
export function alwaysAllowDefaultFor(op: string): boolean {
  return !DANGEROUS_SET.has(op)
}

/** A `.claude/settings.local.json` shape with the permission slice we touch. */
interface SettingsLocal {
  permissions?: {
    allow?: unknown
    [k: string]: unknown
  }
  [k: string]: unknown
}

/** Dedupe a string array preserving first-seen order; drops non-string members. */
function dedupeStrings(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const v of input) {
    if (typeof v !== 'string') continue
    if (seen.has(v)) continue
    seen.add(v)
    out.push(v)
  }
  return out
}

/**
 * Read-merge-write a `mcp__harnu__<verb>` allow rule into a parsed
 * `.claude/settings.local.json` object. PURE: returns a NEW object, never mutates
 * the input. Behavior matrix:
 *
 *  - `existing` absent/`undefined`/not-an-object → `{ permissions: { allow: [rule] } }`.
 *  - Unrelated top-level keys AND unrelated `permissions.*` keys (deny/ask/…) are
 *    preserved verbatim.
 *  - `permissions.allow` is normalized to a DEDUPED string array; the rule is added
 *    only if absent (idempotent). A malformed `allow` (non-array) is replaced with a
 *    fresh `[rule]` rather than throwing.
 *
 * @param existing - the parsed settings object (or `undefined` when the file is
 *   missing/corrupt — the shell passes `undefined` on a parse failure).
 * @param rule - the allow rule to add (from {@link verbAllowRule}).
 * @returns the merged object ready to serialize.
 */
export function mergeVerbAllowRule(existing: unknown, rule: string): SettingsLocal {
  const base: SettingsLocal =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? { ...(existing as SettingsLocal) }
      : {}
  const permsIn =
    base.permissions && typeof base.permissions === 'object' && !Array.isArray(base.permissions)
      ? base.permissions
      : {}
  const allow = dedupeStrings(permsIn.allow)
  if (!allow.includes(rule)) allow.push(rule)
  base.permissions = { ...permsIn, allow }
  return base
}

/**
 * Honor-side match: does a parsed `.claude/settings.local.json` grant a durable
 * "always allow" for Harnu verb `op`? True only when `op` is an
 * {@link ALWAYS_ALLOWABLE_VERBS} member (so a hand-written `plan_mission` rule is
 * ignored) AND `permissions.allow` contains its `mcp__harnu__<op>` rule (or its legacy `mcp__capy__<op>` form). PURE +
 * never throws on a malformed object.
 *
 * @param settings - the parsed settings object (or `undefined`/garbage → `false`).
 * @param op - the Harnu verb being gated.
 */
export function settingsAllowsVerb(settings: unknown, op: string): boolean {
  if (!isAlwaysAllowableVerb(op)) return false
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return false
  const perms = (settings as SettingsLocal).permissions
  if (!perms || typeof perms !== 'object' || Array.isArray(perms)) return false
  const allow = dedupeStrings(perms.allow)
  return verbAllowRules(op).some((rule) => allow.includes(rule))
}

// ---- T109: generic `hooks.<Event>` command-entry helper (extended, not forked,
// for the orchestrator guard's PreToolUse registration — a different settings.local.json
// slice than the `permissions.allow` grant above, same read-merge-write discipline) --------

/** One `type: "command"` handler under a matcher entry. */
interface HookCommandHandler {
  type: 'command'
  command: string
  [k: string]: unknown
}

/** One matcher entry under a hook event (`hooks.<Event>` is an array of these). */
interface HookMatcherEntry {
  matcher?: string
  hooks: HookCommandHandler[]
  [k: string]: unknown
}

type HooksBlock = Record<string, HookMatcherEntry[]>

interface SettingsLocalWithHooks {
  hooks?: HooksBlock
  [k: string]: unknown
}

function asHooksBlock(v: unknown): HooksBlock {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as HooksBlock) : {}
}

/** Identity for one of our hook entries: same matcher AND a handler with the same command. */
function entryMatches(entry: HookMatcherEntry, matcher: string, command: string): boolean {
  return (
    entry.matcher === matcher &&
    Array.isArray(entry.hooks) &&
    entry.hooks.some((h) => h && h.type === 'command' && h.command === command)
  )
}

/**
 * Whether a parsed `.claude/settings.local.json` object already has a
 * `hooks.<event>` command entry matching `(matcher, command)`. PURE, never throws.
 */
export function hasHookEntry(
  existing: unknown,
  event: string,
  matcher: string,
  command: string
): boolean {
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) return false
  const entries = asHooksBlock((existing as SettingsLocalWithHooks).hooks)[event]
  return Array.isArray(entries) && entries.some((e) => entryMatches(e, matcher, command))
}

/**
 * Read-merge-write ONE `type: "command"` hook entry into a `.claude/settings.local.json`
 * object, under `hooks.<event>` with the given `matcher`. PURE: returns a NEW object,
 * never mutates the input.
 *
 *  - `existing` absent/`undefined`/not-an-object → a fresh `{ hooks: { [event]: [...] } }`.
 *  - Unrelated top-level keys, unrelated hook EVENTS, and unrelated matcher entries
 *    within the same event are preserved verbatim.
 *  - Idempotent: identified by `(event, matcher, command)` — re-adding is a no-op.
 */
export function mergeHookEntry(
  existing: unknown,
  event: string,
  matcher: string,
  command: string
): SettingsLocalWithHooks {
  const base: SettingsLocalWithHooks =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? { ...(existing as SettingsLocalWithHooks) }
      : {}
  const hooksIn = asHooksBlock(base.hooks)
  const eventEntries = Array.isArray(hooksIn[event]) ? hooksIn[event] : []
  const alreadyPresent = eventEntries.some((e) => entryMatches(e, matcher, command))
  const nextEventEntries = alreadyPresent
    ? eventEntries
    : [...eventEntries, { matcher, hooks: [{ type: 'command' as const, command }] }]
  base.hooks = { ...hooksIn, [event]: nextEventEntries }
  return base
}

/**
 * Remove a `(event, matcher, command)` hook entry from a `.claude/settings.local.json`
 * object. PURE: returns a NEW object. Drops an emptied matcher entry, an emptied
 * event array, and the `hooks` key itself once nothing remains — the file never
 * carries dead scaffolding after an uninstall. A no-op (returns the input shape,
 * copied) when the entry isn't present.
 */
export function removeHookEntry(
  existing: unknown,
  event: string,
  matcher: string,
  command: string
): SettingsLocalWithHooks {
  const base: SettingsLocalWithHooks =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? { ...(existing as SettingsLocalWithHooks) }
      : {}
  const hooksIn = asHooksBlock(base.hooks)
  if (Object.keys(hooksIn).length === 0) return base

  const nextHooks: HooksBlock = {}
  for (const [ev, entries] of Object.entries(hooksIn)) {
    if (ev !== event) {
      nextHooks[ev] = entries
      continue
    }
    const kept = entries
      .map((e) =>
        e.matcher === matcher
          ? {
              ...e,
              hooks: (e.hooks ?? []).filter(
                (h) => !(h && h.type === 'command' && h.command === command)
              )
            }
          : e
      )
      .filter((e) => Array.isArray(e.hooks) && e.hooks.length > 0)
    if (kept.length > 0) nextHooks[ev] = kept
  }
  if (Object.keys(nextHooks).length > 0) base.hooks = nextHooks
  else delete base.hooks
  return base
}
