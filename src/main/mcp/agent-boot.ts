/**
 * RCE / privilege-escalation gate for MCP-driven agent boot (T9).
 *
 * An MCP-spawned agent is UNTRUSTED input. When it requests a new Claude
 * session it may influence ONLY the capacity knobs — `model` and `effort`.
 * Every other {@link ClaudeBootConfig} field is a code-execution or
 * privilege-escalation vector and must never be set from an MCP request:
 *  - `dangerouslySkipPermissions` / `permissionMode: 'bypassPermissions'` —
 *    disable the human-in-the-loop approval gate;
 *  - `extraArgs` — raw argv injection;
 *  - `settings` / `settingSources` — load arbitrary hooks (a `PreToolUse` hook
 *    runs a shell command) and trust untrusted setting sources;
 *  - `systemPrompt` / `appendSystemPrompt` / `prePrompt` — safety-override /
 *    prompt injection + an attacker-controlled first turn;
 *  - `addDirs` — widen the tool sandbox to arbitrary paths;
 *  - `mcpConfig` / `provider` — point the agent at an attacker-controlled MCP
 *    server / model endpoint;
 *  - `agent` — load an arbitrary sub-agent definition.
 *
 * This module is the single source of truth for that gate. {@link
 * sanitizeAgentBootOverride} is the strict allowlist applied to the raw MCP
 * request (reject unknown keys outright). {@link forceDowngradePermission} is
 * the defense-in-depth backstop applied to the *resolved* config after merge,
 * in case a dangerous flag leaks in from the user's own `claude-boot.json`.
 *
 * Framework-free + side-effect-free per ADR-0001 (pure-core / thin-shell), so
 * it lands in the coverage surface and the unit tests stay deterministic.
 */

import { mergeBootConfig, type ClaudeBootConfig } from '../claude-args'

/**
 * The ONLY {@link ClaudeBootConfig} fields an untrusted MCP agent may set at
 * boot. Everything else is an RCE / escalation vector — see the module doc.
 */
export type AgentBootOverride = Pick<ClaudeBootConfig, 'model' | 'effort'>

/**
 * The allowlisted keys. Frozen so the gate can't be silently widened: adding a
 * field here is a security decision, not an incidental edit.
 */
const ALLOWED_KEYS = new Set<keyof AgentBootOverride>(['model', 'effort'])

/**
 * Strict allowlist for an MCP agent's boot override. Accepts ONLY a plain
 * object whose keys are a subset of `{ model?, effort? }`, each a string. Any
 * other key — or a non-string value, or a non-object input — throws, because
 * every other {@link ClaudeBootConfig} field is a privilege-escalation vector.
 *
 * @param input - the untrusted override object from the MCP request.
 * @returns a new `{ model?, effort? }` containing only the present allowed keys.
 * @throws if `input` is not a plain object, carries a forbidden key, or has a
 *   non-string `model` / `effort` value.
 */
export function sanitizeAgentBootOverride(input: unknown): AgentBootOverride {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('agent boot override must be a plain object')
  }
  const record = input as Record<string, unknown>
  const out: AgentBootOverride = {}
  for (const key of Object.keys(record)) {
    if (!ALLOWED_KEYS.has(key as keyof AgentBootOverride)) {
      throw new Error(`forbidden agent boot field: ${key}`)
    }
    const value = record[key]
    if (value === undefined) continue
    if (typeof value !== 'string') {
      throw new Error(`agent boot field "${key}" must be a string`)
    }
    out[key as keyof AgentBootOverride] = value
  }
  return out
}

/** A tolerant border parse of a `bootOverride`: the sanitized value, or WHY it was rejected. */
export type AgentBootParse = { ok: true; value: AgentBootOverride } | { ok: false; reason: string }

/**
 * Tolerant border parse of an untrusted `bootOverride` from an MCP request
 * (T63/BUG-10). Unlike {@link sanitizeAgentBootOverride} (which throws), this
 * NEVER throws and reports WHY it rejected, so the shell can steer the agent
 * instead of dropping a bad override silently — the failure that let an agent ask
 * for `sonnet` and silently get the operator's global `opus`, no error, no echo.
 *
 * Two tolerances beyond the strict sanitizer:
 *  1. A client that serialized the object as a JSON **string** (observed in
 *     dogfood) is `JSON.parse`-d first, so `'{"model":"sonnet"}'` still applies.
 *  2. `undefined` / `null` / an all-whitespace string → an empty, valid override
 *     (no override requested), not an error.
 *
 * Everything else still goes through the strict allowlist: a forbidden key, a
 * non-string value, or non-JSON garbage is rejected with a message the caller
 * surfaces as `INVALID_BOOT_OVERRIDE`.
 *
 * @param input - the raw, untrusted `bootOverride` field (object, JSON string, or absent).
 */
export function parseAgentBootOverride(input: unknown): AgentBootParse {
  if (input === undefined || input === null) return { ok: true, value: {} }
  let candidate: unknown = input
  if (typeof input === 'string') {
    const trimmed = input.trim()
    if (trimmed.length === 0) return { ok: true, value: {} }
    try {
      candidate = JSON.parse(trimmed)
    } catch {
      return {
        ok: false,
        reason:
          'bootOverride was a string but not valid JSON — pass a JSON object like {"model":"sonnet"}'
      }
    }
  }
  try {
    return { ok: true, value: sanitizeAgentBootOverride(candidate) }
  } catch (err) {
    return { ok: false, reason: (err as Error).message }
  }
}

/**
 * The `create_session` boot resolution the MCP server both FORWARDS to the
 * renderer and ECHOES back to the agent, derived from ONE source (T76/BUG-18).
 */
export interface CreateSessionBoot {
  /**
   * The allowlisted override to forward to the renderer spawn (`payload.bootOverride`),
   * or `undefined` when the agent requested neither knob. This is the EXACT object
   * the ACK's `effectiveModel`/`effectiveEffort` are computed from — so the echo can
   * never claim a model the forward didn't carry.
   */
  forward?: AgentBootOverride
  /** The model that WILL launch (`resolved` ⊕ `forward`), or `null` when neither sets one. */
  effectiveModel: string | null
  /** The effort that WILL launch (`resolved` ⊕ `forward`), or `null` when neither sets one. */
  effectiveEffort: string | null
}

/**
 * Resolve the `create_session` forward payload AND its ACK echo from a SINGLE
 * override object (T76/BUG-18).
 *
 * The original ACK (`server.ts`) recomputed `mergeBootConfig(resolved, override)`
 * from a variable PARALLEL to the one placed on the forwarded payload — two
 * derivations that could silently drift (an ACK claiming `haiku` while the spawn
 * launched `opus`, the exact BUG-18 face this closes on the server side). Here the
 * forwarded `forward` object and the echoed `effectiveModel`/`effectiveEffort` are
 * derived from the SAME `override`, so the echo is provably consistent with what
 * is sent downstream. Pure + side-effect-free (ADR-0001), unit-tested.
 *
 * @param override - the already-sanitized `{ model?, effort? }` (from {@link parseAgentBootOverride}).
 * @param resolved - the session's resolved global ⊕ folder boot config (from `getResolvedConfig`).
 */
export function resolveCreateSessionBoot(
  override: AgentBootOverride,
  resolved: ClaudeBootConfig
): CreateSessionBoot {
  // Re-project to exactly the allowlisted, non-empty knobs — the object that is
  // BOTH forwarded and the sole input to the effective merge below.
  const forward: AgentBootOverride = {
    ...(override.model ? { model: override.model } : {}),
    ...(override.effort ? { effort: override.effort } : {})
  }
  const hasForward = Object.keys(forward).length > 0
  const effective = mergeBootConfig(resolved, forward)
  return {
    ...(hasForward ? { forward } : {}),
    effectiveModel: effective.model ?? null,
    effectiveEffort: effective.effort ?? null
  }
}

/**
 * Defense-in-depth backstop: strip permission-skipping flags from a *resolved*
 * {@link ClaudeBootConfig} before it is used to spawn an MCP-driven session.
 * Removes `dangerouslySkipPermissions` entirely and rewrites a
 * `permissionMode` of `'bypassPermissions'` to `'manual'` (the safe mode's canonical name since CC 2.1.x; the old `'default'` survives only as a hidden alias). Every other field
 * is preserved verbatim. Inert on an already-safe config; never mutates input.
 *
 * @param cfg - the resolved boot config (post-merge with the user's own scopes).
 * @returns a new config with the permission-bypass escape hatches closed.
 */
export function forceDowngradePermission(cfg: ClaudeBootConfig): ClaudeBootConfig {
  const out: ClaudeBootConfig = { ...cfg }
  delete out.dangerouslySkipPermissions
  if (out.permissionMode === 'bypassPermissions') {
    out.permissionMode = 'manual'
  }
  return out
}
