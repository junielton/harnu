/**
 * Hook responder dispatch — PURE CORE (hook-responder-dispatch spec §4.1).
 *
 * Zero electron/node deps (only types + the global `AbortSignal`), mirroring
 * `hook-state.ts` (pure reducer) and `statusline-parse.ts`. ALL of the risk logic
 * lives here and is 100% TDD-able without a server or IPC:
 *
 *  - `isDispatchable` — which (event, matcher) pairs the responder may DECIDE.
 *  - `parseHookRequest` — fail-safe normalization of a raw hook body.
 *  - `runResolvers` — the heart: ordered, short-circuiting, never-rejecting, with
 *    a HARD deadline ceiling via `Promise.race` against the abort signal (a
 *    misbehaved resolver that ignores the signal can never hold the result).
 *  - `serializeDecision` — maps a `HookDecision` onto the Claude Code wire body,
 *    per event; total + fail-open (`{}` for anything it can't safely emit).
 *  - `describeDecision` — deterministic one-line summary for the shadow log.
 */

/** The events the responder can DECIDE on (everything else is observed only). */
export const DISPATCHABLE_EVENTS = [
  'PreToolUse',
  'PermissionRequest',
  'UserPromptSubmit',
  'Notification' // only with matcher 'permission_prompt' — see isDispatchable
] as const
export type DispatchableEvent = (typeof DISPATCHABLE_EVENTS)[number]

/** The normalized request handed to resolvers. Fail-safe: absent fields → undefined. */
export interface HookRequest {
  sessionId: string
  event: string
  matcher?: string
  /** Tool name (PreToolUse/PermissionRequest) extracted from the body, if any. */
  toolName?: string
  /** Tool input (PreToolUse) — opaque object, untouched by the substrate. */
  toolInput?: Record<string, unknown>
  /** User prompt (UserPromptSubmit), if any. */
  prompt?: string
  /** Raw hook body, for resolvers that need extra fields. */
  raw: Record<string, unknown>
}

/** The decision a resolver may return. `null`/abstention is the absence of a decision. */
export interface HookDecision {
  /** allow/deny/ask for PreToolUse/PermissionRequest. */
  permissionDecision?: 'allow' | 'deny' | 'ask'
  reason?: string
  /** Injected context (UserPromptSubmit). */
  additionalContext?: string
  /** Rewritten tool input (generic). */
  updatedInput?: Record<string, unknown>
  /** Rewritten displayed text (generic). */
  displayContent?: string
  /** Who decided (for the shadow log + audit). NEVER serialized to the wire. */
  by: string
}

export type ResponderMode = 'off' | 'shadow' | 'active'

/** The per-folder trust-ramp scope the Approval Inbox gate decides against (T30). */
export interface RampScope {
  /** Global responder mode (`off`/`shadow`/`active`). */
  mode: ResponderMode
  /** Master "Trust all folders" escape hatch — active intercepts every folder. */
  trustAll: boolean
  /** Normalized absolute paths of the pinned folders on the ramp (intercepted). */
  interceptFolders: ReadonlySet<string>
}

/** What the Approval Inbox resolver should do with a hook event (T30). */
export type GateAction =
  | 'park' // hold the tool call for a human (active + folder on the ramp)
  | 'preview' // log a "would-gate" shadow entry + abstain (shadow, or active off-ramp)
  | 'ignore' // do nothing (off mode, or a non-gated event)

/**
 * Decide how the Approval Inbox should treat a gated hook event — the pure heart
 * of the T30 per-folder trust ramp. `off` or a non-gated event → `ignore`.
 * `shadow` (fleet preview) → always `preview`. `active` → `park` iff the folder is
 * on the ramp (or `trustAll` is on), else `preview` (never blocked off-ramp — the
 * fail-safe-narrow default). A `null`/unattributable folder under active without
 * `trustAll` falls to `preview` (never park a call we can't attribute to a trusted
 * folder). This decision NEVER extends the fail-open deadline — it only chooses
 * which resolver path runs.
 */
export function gateAction(
  scope: RampScope,
  isGatedEvent: boolean,
  folder: string | null
): GateAction {
  if (scope.mode === 'off' || !isGatedEvent) return 'ignore'
  if (scope.mode === 'shadow') return 'preview'
  // active: park only where the ramp bites.
  const onRamp = scope.trustAll || (folder !== null && scope.interceptFolders.has(folder))
  return onRamp ? 'park' : 'preview'
}

export interface Resolver {
  id: string
  priority: number // lower runs first
  resolve: (
    req: HookRequest,
    signal: AbortSignal
  ) => HookDecision | null | Promise<HookDecision | null>
}

/** True if this (event, matcher) is dispatchable (Notification only with permission_prompt). */
export function isDispatchable(event: string, matcher?: string): boolean {
  if (event === 'PreToolUse' || event === 'PermissionRequest' || event === 'UserPromptSubmit')
    return true
  if (event === 'Notification') return matcher === 'permission_prompt'
  return false
}

/** Normalize the raw body into a HookRequest. NEVER throws (body already parsed by the caller). */
export function parseHookRequest(
  event: string,
  matcher: string | undefined,
  body: Record<string, unknown>,
  sessionId: string
): HookRequest {
  const toolName =
    typeof body.tool_name === 'string'
      ? body.tool_name
      : typeof body.toolName === 'string'
        ? body.toolName
        : undefined
  const rawInput = body.tool_input ?? body.toolInput
  const toolInput =
    rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)
      ? (rawInput as Record<string, unknown>)
      : undefined
  const prompt = typeof body.prompt === 'string' ? body.prompt : undefined
  return { sessionId, event, matcher, toolName, toolInput, prompt, raw: body }
}

/**
 * Run the resolvers IN priority order; the first non-null decision wins
 * (short-circuit). Each resolver is wrapped in try/catch — a throw is treated as
 * an abstention (null) + onError(by, err). Respects the AbortSignal (deadline):
 * a resolver still pending when the signal aborts is discarded → null. ALWAYS
 * resolves (never-rejects), mirroring runHaiku.
 *
 * HARD guarantee against deadlock: each resolver await is `Promise.race`d against
 * a promise that resolves `null` on `signal.abort` — we do NOT trust the resolver
 * to honor the signal itself. So even a misbehaved resolver that ignores the
 * signal and never settles cannot hold runResolvers past the abort — it resolves
 * `null` the instant the deadline fires. (The only pending timer is the
 * AbortController's, cleared in the caller's finally.)
 */
export function runResolvers(
  req: HookRequest,
  resolvers: readonly Resolver[],
  signal: AbortSignal,
  onError?: (by: string, err: unknown) => void
): Promise<HookDecision | null> {
  const ordered = [...resolvers].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
  return (async () => {
    if (signal.aborted) return null
    const abortPromise = new Promise<HookDecision | null>((res) => {
      signal.addEventListener('abort', () => res(null), { once: true })
    })
    for (const r of ordered) {
      if (signal.aborted) return null
      const call: Promise<HookDecision | null> = Promise.resolve()
        .then(() => r.resolve(req, signal))
        .catch((err) => {
          onError?.(r.id, err)
          return null
        })
      const d = await Promise.race([call, abortPromise])
      if (signal.aborted) return null // deadline won — discard any late decision
      if (d) return d // short-circuit on the first non-null
    }
    return null
  })()
}

/**
 * Serialize a decision into the HTTP body Claude Code understands, per event.
 * decision null → '{}' (fail-open). A shape invalid for the event → '{}' (never
 * emit a body the CC would reject). PURE and total.
 *
 * Field mapping (the substrate is the ONLY source of this contract; consumers —
 * Sentinel, re-entry brief — just fill the HookDecision and trust this map):
 *   PreToolUse/PermissionRequest:
 *     permissionDecision → hookSpecificOutput.permissionDecision
 *     reason             → hookSpecificOutput.permissionDecisionReason
 *     updatedInput       → updatedInput (top-level)
 *     displayContent     → displayContent (top-level)
 *   UserPromptSubmit:
 *     additionalContext  → hookSpecificOutput.additionalContext
 *   `by` NEVER reaches the wire (audit/shadow-log only).
 */
export function serializeDecision(event: string, decision: HookDecision | null): string {
  if (!decision) return '{}'
  try {
    const out: Record<string, unknown> = {}
    const isToolGate = event === 'PreToolUse' || event === 'PermissionRequest'
    if (isToolGate) {
      if (decision.permissionDecision) {
        const hso: Record<string, unknown> = {
          hookEventName: event,
          permissionDecision: decision.permissionDecision
        }
        if (decision.reason) hso.permissionDecisionReason = decision.reason
        out.hookSpecificOutput = hso
      }
      if (decision.updatedInput) out.updatedInput = decision.updatedInput
      if (decision.displayContent) out.displayContent = decision.displayContent
    } else if (event === 'UserPromptSubmit') {
      if (decision.additionalContext)
        out.hookSpecificOutput = {
          hookEventName: event,
          additionalContext: decision.additionalContext
        }
      if (decision.updatedInput) out.updatedInput = decision.updatedInput
      if (decision.displayContent) out.displayContent = decision.displayContent
    } else {
      // Unknown event: only the generic top-level fields are safe to emit.
      if (decision.updatedInput) out.updatedInput = decision.updatedInput
      if (decision.displayContent) out.displayContent = decision.displayContent
    }
    if (Object.keys(out).length === 0) return '{}'
    return JSON.stringify(out)
  } catch {
    return '{}'
  }
}

/**
 * Deterministic one-line summary of a decision for the shadow log + the
 * ShadowEntry.summary (e.g. `PreToolUse→deny (sentinel)` /
 * `UserPromptSubmit→+context (brief)`). PURE and total.
 */
export function describeDecision(event: string, decision: HookDecision): string {
  if (decision.permissionDecision) return `${event}→${decision.permissionDecision} (${decision.by})`
  if (decision.additionalContext) return `${event}→+context (${decision.by})`
  if (decision.updatedInput) return `${event}→updatedInput (${decision.by})`
  if (decision.displayContent) return `${event}→displayContent (${decision.by})`
  return `${event}→decide (${decision.by})`
}
