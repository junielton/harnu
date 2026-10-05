/**
 * The security-composition reducer for the Harnu MCP server (T14).
 *
 * `planToolCall` is the ONE place the three leaf cores are fused into a single,
 * order-sensitive plan for an inbound MCP tool call:
 *
 *   - T5  tool-catalog — `toolByName`/`mutates` classify the call (read vs
 *     mutation) and resolve the router op + redaction directive;
 *   - T10 validate     — `parseToolInput` is the structural gate: a malformed
 *     call is rejected BEFORE permission is ever consulted;
 *   - T3  permission   — `evaluateToolCall` returns the gate verdict.
 *
 * The DANGEROUS ORDER lives HERE, encoded so a mutation testing tool (Stryker)
 * can reach it:
 *
 *   audit  →  permission  →  confirm-only-for-mutations  →  redact-on-reads
 *
 *  1. AUDIT is unconditional. EVERY call — denied, malformed, unknown-tool, or
 *     allowed — yields a fully-formed {@link AuditRecord}. The shell appends it
 *     before it acts on the verdict, so nothing is ever dispatched unrecorded.
 *     Post-reversal this matters MORE, not less: with mutations running free, the
 *     audit log is the operator's only trace of what the fleet did unattended.
 *  2. PERMISSION drives dispatch. `shouldDispatch` is `verdict === 'allow'` and
 *     NOTHING else — a denied call never dispatches, and a `confirm` waits for a
 *     human (it does not dispatch here either).
 *  3. CONFIRM-ONLY-FOR-MUTATIONS. `shouldConfirm` is `verdict === 'confirm'`;
 *     since the gate only ever returns `confirm` for a mutation, a read can
 *     never raise a confirm. Which mutations confirm is now the interesting part
 *     — see the free-by-default block in {@link planToolCall}: only
 *     `submit_manifest` / `plan_mission` always do, plus everything when the
 *     operator opts into `ask`.
 *  4. REDACT-ON-READS. The redaction directive is a property of the TOOL
 *     (`get_session ⇒ transcript`, `get_fleet ⇒ paths`, everything else
 *     `none`), independent of the verdict — it is still reported for a denied
 *     read so the disclosure layer is wired the same way regardless.
 *
 * Framework-free + side-effect-free per ADR-0001 (pure-core / thin-shell): the
 * clock is injected as `now`, so the plan is deterministic and lands in the
 * coverage surface. The shell supplies the policy snapshot + clock, calls this
 * reducer, appends `plan.auditRecord`, and only then dispatches / surfaces a
 * confirm / discloses a redacted payload according to the plan.
 */

import {
  evaluateToolCall,
  normalizePath,
  type Policy,
  type ToolCall,
  type Verdict
} from './permission-core'
import { homedir } from 'node:os'
import { toolByName } from './tool-catalog'
import { parseToolInput } from './validate'
import { grantDecision, type MissionGrant } from './grant-core'
import { canonicalWorktreeParentRepo } from '../worktree-core'
import type { AuditRecord } from './audit-log'

/**
 * How a disclosed payload must be scrubbed before it leaves the server.
 * `transcript` scrubs a session transcript (T8), `paths` aliases fleet paths,
 * `none` is "nothing to redact" (a mutation or a non-disclosing read).
 */
export type RedactDirective = 'transcript' | 'paths' | 'none'

/** The arguments to {@link planToolCall}. */
export interface PlanInput {
  /** The MCP tool name as the client invoked it (e.g. `get_session`). */
  tool: string
  /** The raw, UNTRUSTED tool arguments — validated here via T10. */
  input: unknown
  /** The policy snapshot the shell assembled for this decision (T3/T15). */
  policy: Policy
  /** Injected clock (epoch ms) stamped onto the audit record — keeps this pure. */
  now: number
  /**
   * Live mission grants (T44 S5). A grant can turn a mutation's `confirm` /
   * `FOLDER_NOT_ALLOWED` into `allow` WITHIN its scope. Optional — omit (→ none)
   * for the base behavior. NEVER consulted for `SERVER_DISABLED` / `PATH_ESCAPE`.
   */
  grants?: readonly MissionGrant[]
  /**
   * T72 inherit-once (env `inherit-once-registry`). Normalized worktree paths the
   * operator allowed "just this app session" via an inheritance-discovery confirm.
   * Optional — omit (→ none) for the base behavior. HARDENING: consulted ONLY when
   * the base verdict is deny+`FOLDER_NOT_ALLOWED` (never as raw membership above the
   * gate), so a later `PATH_ESCAPE` on the same path is never shadowed by a once
   * entry. Never consulted for `SERVER_DISABLED` / `PATH_ESCAPE`.
   */
  inheritOnce?: readonly string[]
  /** Home dir for path normalization in grant scope-matching; defaults to os.homedir(). */
  homeDir?: string
}

/** The order-sensitive plan {@link planToolCall} returns for one tool call. */
export interface ToolCallPlan {
  /** The audit entry for this call — ALWAYS present, even on a deny. */
  auditRecord: AuditRecord
  /** The gate verdict (mirrors {@link evaluateToolCall}; synthetic `deny` on reject). */
  verdict: Verdict
  /** Whether a human must sign off — true only for a mutation's `confirm`. */
  shouldConfirm: boolean
  /** Whether the op may run now — true only for an `allow`. */
  shouldDispatch: boolean
  /** How the disclosed payload must be scrubbed; a property of the tool. */
  redact: RedactDirective
  /** Set (T44 S5) when this dispatch was auto-allowed by a mission grant — the
   *  shell reserves + shadow-logs against `grantId` and refunds on failure. */
  grantAllow?: { grantId: string }
  /**
   * Set (T72) when a mutation's dead-end `FOLDER_NOT_ALLOWED` was promoted to a
   * `confirm` because it targets a canonical `.claude/worktrees/*` worktree whose
   * parent repo is ALREADY agent-allowed — the inheritance-discovery confirm. The
   * shell reads it to build the contextual disclosure (naming the parent repo) and
   * to actuate the operator's scope choice (always → persist opt-in + mark; once →
   * register the in-memory allow). Both paths are already normalized.
   */
  inheritDiscovery?: { repoRoot: string; worktree: string }
  /**
   * Set (T72) when this mutation was auto-allowed because its worktree is on the
   * inherit-once list (a prior "Only this" choice). The shell actuates it directly — no
   * budget, no confirm (the earlier Allow already authorized this worktree for the
   * app session). Mutually exclusive with `grantAllow` (grants win first).
   */
  inheritOnceAllow?: boolean
  /**
   * Set when this mutation ran FREE — no human confirm — which post-reversal is
   * the DEFAULT for every mutating verb that carries `silentAllowInAgentFolder`
   * (i.e. all of them except `submit_manifest` and `plan_mission`). The name is
   * historical (it once meant "silently allowed because the folder was on the
   * allowlist"); it now means "this verb may run without asking".
   *
   * Armed only on a base `allow` — so it can never fire under the kill switch, an
   * explicit folder block, or the `ask` friction mode (all of which yield `deny`
   * or `confirm`). The shell dispatches it as a mutation (still audited +
   * shadow-logged) with NO budget — it is not a mission grant. Mutually exclusive
   * with `grantAllow`/`inheritOnceAllow`.
   */
  silentAllowInAgentFolder?: boolean
}

/**
 * Best-effort extract of the target folder from raw args, checking the known
 * path-shaped keys in priority order. Used for the gate's containment/allowlist
 * check and the audit record. The actual safety (absolute, no `..`) is enforced
 * by T10 validation upstream and re-checked by {@link evaluateToolCall}.
 */
function pickFolder(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const record = input as Record<string, unknown>
  for (const key of ['folder', 'repoPath', 'worktreePath'] as const) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/** Assemble a denied, non-dispatched, non-confirming plan that is still audited. */
function denyPlan(
  tool: string,
  folder: string,
  now: number,
  result: string,
  redact: RedactDirective
): ToolCallPlan {
  return {
    auditRecord: {
      ts: now,
      tool,
      folder,
      verdict: 'deny',
      disclosedPayloadSummary: 'none',
      result
    },
    verdict: 'deny',
    shouldConfirm: false,
    shouldDispatch: false,
    redact
  }
}

/**
 * Compose the leaf cores into the {@link ToolCallPlan} for one inbound MCP tool
 * call. Pure + deterministic — see the module header for the full audit →
 * permission → confirm → redact order and the invariants it encodes.
 *
 * @param args - the tool name, raw untrusted input, policy snapshot, and clock.
 * @returns the order-sensitive plan the shell executes.
 */
export function planToolCall({
  tool,
  input,
  policy,
  now,
  grants,
  inheritOnce,
  homeDir
}: PlanInput): ToolCallPlan {
  const def = toolByName(tool)

  // Unknown tool: never reached by the registered router, but fail CLOSED and
  // still audit so the attempt is recorded.
  if (def === undefined) {
    return denyPlan(tool, pickFolder(input) ?? '', now, 'UNKNOWN_TOOL', 'none')
  }

  const redact = def.discloses ?? 'none'
  const folder = pickFolder(input)

  // Structural validation (T10): a malformed call is denied BEFORE permission is
  // consulted — yet it is STILL audited.
  const parsed = parseToolInput(def.op, input)
  if (!parsed.ok) {
    return denyPlan(tool, folder ?? '', now, `BAD_ARGS: ${parsed.detail}`, redact)
  }

  // Classify via the catalog `mutates` flag (T5) and assemble the gate call.
  const call: ToolCall = { tool, kind: def.mutates ? 'mutation' : 'read' }
  if (folder !== undefined) call.folder = folder
  // `disclosesTranscript` gates a read by the folder allowlist (it discloses
  // sensitive content — a session transcript, or project memory, per the tool's
  // own `disclosesTranscript` gate field). The memory-append mutation is
  // allowlist-gated regardless of this flag.
  if (def.disclosesTranscript) {
    call.disclosesTranscript = true
  }

  // Permission (T3): the verdict drives both dispatch and confirm.
  const decision = evaluateToolCall(call, policy)
  let verdict = decision.verdict
  let grantAllow: { grantId: string } | undefined
  let inheritDiscovery: { repoRoot: string; worktree: string } | undefined
  let inheritOnceAllow = false
  let silentAllowInAgentFolder = false

  // THE BLOCK IS ABSOLUTE. `FOLDER_NOT_ALLOWED` no longer means "not granted yet"
  // (there is no allowlist left to be absent from) — post-reversal it can only
  // mean the operator EXPLICITLY blocked this folder (`agentDenied`) in the folder
  // menu. So no layer below may promote it: not a mission grant, not the
  // `bootstrapConfirmOnDeny` exemption, not the T72 inheritance discovery. Only
  // the kill switch outranks it. Every promotion block below is guarded on this.
  const explicitBlock = verdict === 'deny' && decision.reason === 'FOLDER_NOT_ALLOWED'

  // FREE BY DEFAULT — the base gate hands back `allow` for a mutation (unless the
  // operator turned on `ask`, which makes it `confirm`). Two verbs must face a
  // human ANYWAY, and they are exactly the ones that do NOT carry
  // `silentAllowInAgentFolder`:
  //
  //   - `submit_manifest` — the operator's dispatch go-door. The verb IS the gate
  //     request: its disclosure is the checklist they partial-approve (T104 §2.1).
  //   - `plan_mission`    — mints a capability grant; a grant nobody approved is
  //     not a grant.
  //
  // Everything else (create_session, create_worktree, spawn_terminal,
  // adopt_folder, memory_append, open_file, notify, the board verbs) runs free.
  // `ask` mode never produces a base `allow` for a mutation, so this block is
  // inert there and all mutations keep their confirm — including these two.
  if (def.mutates && verdict === 'allow') {
    // T308: `forceConfirmFor` narrows a silent-allow back to `confirm` for an
    // input value whose risk the TOOL-LEVEL flag alone can't express (e.g.
    // create_worker's `mode: 'act'`). It is consulted only here, only on a base
    // `allow` for a mutation, so it can never loosen anything — a verb without
    // `silentAllowInAgentFolder` already confirms regardless of this field.
    const forcedConfirm = def.forceConfirmFor?.(parsed.value as Record<string, unknown>) ?? false
    if (def.silentAllowInAgentFolder && !forcedConfirm) silentAllowInAgentFolder = true
    else verdict = 'confirm'
  }

  // ── PROMOTION LAYERS ───────────────────────────────────────────────────────
  // Everything below can only ever WIDEN a verdict (deny→confirm, confirm→allow),
  // so an explicit operator block must skip the lot: the denylist is absolute, and
  // "the operator said no" is not a state any layer gets to bargain with. The kill
  // switch and containment are safe by construction — each block below requires a
  // specific verdict/reason that `SERVER_DISABLED` / `PATH_ESCAPE` never produce.
  if (!explicitBlock) {
    // T44 S5: mission grants compose ABOVE the base gate. Consulted ONLY for a
    // mutation whose verdict is `confirm` — which post-reversal means either the
    // operator turned on `ask` (guarded mode: a grant is how a fan-out buys the whole
    // batch with ONE approval, its original job) or this is an always-confirm verb.
    // In the default free mode a mutation is already `allow`, so grants are inert —
    // redundant, not removed. `def.grantable` is belt-and-suspenders (T104): no
    // legitimate `plan_mission` call can mint a grant naming `submit_manifest` (its
    // schema is `z.enum(SAFE_GRANT_VERBS)`), but gating here too means a future bug
    // that widens `MissionGrant.verbs` beyond that enum still can't silently cover a
    // verb that isn't declared grantable on its own def.
    const grantEligible =
      def.mutates &&
      def.op !== 'plan_mission' &&
      def.grantable === true &&
      folder !== undefined &&
      verdict === 'confirm'
    if (grantEligible) {
      const gd = grantDecision(
        { folder: folder as string, verb: def.op },
        grants ?? [],
        now,
        homeDir ?? homedir()
      )
      if (gd.outcome === 'allow') {
        verdict = 'allow'
        grantAllow = { grantId: gd.grantId }
      } else if (gd.outcome === 'escalate') {
        verdict = 'confirm' // park for a human — never a dry deny (invariant 6)
      }
      // 'none' → keep the base verdict
    }

    // bootstrapConfirmOnDeny (S1/S5): the verbs that BOOTSTRAP membership
    // (`adopt_folder`) or a grant (`plan_mission`), for which a bare
    // `FOLDER_NOT_ALLOWED` used to be the wrong answer — there was nothing else the
    // agent could do to unblock itself, so they got their own one-time confirm.
    //
    // UNREACHABLE post-reversal, and deliberately so: the only `FOLDER_NOT_ALLOWED`
    // left is an explicit block, which the `!explicitBlock` guard above already
    // excluded — so there is no deny here to bootstrap past. Kept verbatim (field +
    // condition) so a future guarded mode that reintroduces a "not known yet" deny
    // gets its bootstrap path back for free. It still requires the FOLDER_NOT_ALLOWED
    // reason, so it can never promote a `SERVER_DISABLED` / `PATH_ESCAPE` deny.
    if (
      def.bootstrapConfirmOnDeny &&
      verdict === 'deny' &&
      decision.reason === 'FOLDER_NOT_ALLOWED'
    ) {
      verdict = 'confirm'
    }

    // T72: agent-control inheritance DISCOVERY (+ the inherit-once list) — the
    // contextual "this worktree's parent repo is already allowed, want to inherit?"
    // upsell that turned a dead-end deny into a choice.
    //
    // UNREACHABLE post-reversal for the same reason: a worktree needs no inherited
    // grant (it is reachable like every other folder), and the only deny it could see
    // is an explicit block, excluded above. Critically, this MUST stay unreachable —
    // if it could fire on a block, the denylist would be one "Always" click away from
    // being undone. The registries, the `inheritAgentControl` birth marker, and the
    // server-side actuation stay wired for a guarded mode that re-derives worktree
    // scope.
    if (
      def.mutates &&
      verdict === 'deny' &&
      decision.reason === 'FOLDER_NOT_ALLOWED' &&
      folder !== undefined
    ) {
      const home = homeDir ?? homedir()
      const normFolder = normalizePath(folder, home)
      // (i) inherit-once — a prior "Only this" allowed this worktree for the app session.
      if ((inheritOnce ?? []).some((p) => normalizePath(p, home) === normFolder)) {
        verdict = 'allow'
        inheritOnceAllow = true
      } else {
        // (ii) discovery — a canonical `.claude/worktrees/*` worktree whose parent repo
        // is already reachable but this worktree is not: promote the dead-end deny to a
        // contextual confirm (the human picks always/once/deny).
        const parentRepo = canonicalWorktreeParentRepo(normFolder)
        if (parentRepo !== null) {
          const normParent = normalizePath(parentRepo, home)
          const allow = policy.allowFolders.map((f) => normalizePath(f, home))
          if (allow.includes(normParent) && !allow.includes(normFolder)) {
            verdict = 'confirm'
            inheritDiscovery = { repoRoot: normParent, worktree: normFolder }
          }
        }
      }
    }
  }

  // confirm-only-for-mutations + dispatch-only-on-allow, derived from the verdict.
  const shouldConfirm = verdict === 'confirm'
  const shouldDispatch = verdict === 'allow'

  // redact-on-reads: only a dispatched read discloses a payload, and its summary
  // names the redaction applied (`full` when there is nothing to scrub).
  const disclosedPayloadSummary = shouldDispatch ? (redact === 'none' ? 'full' : redact) : 'none'

  const auditRecord: AuditRecord = {
    ts: now,
    tool,
    folder: folder ?? '',
    verdict,
    disclosedPayloadSummary,
    result: grantAllow
      ? `grant ${grantAllow.grantId}`
      : inheritOnceAllow
        ? 'INHERIT_ONCE'
        : silentAllowInAgentFolder
          ? // Free mode: the mutation ran without asking. The audit row is the
            // operator's ONLY trace of it, so it says so plainly — this is what
            // they scan when they want to know what the fleet did unattended.
            'AGENT_ALLOWED'
          : (decision.reason ?? verdict)
  }

  // Optional fields are assigned only when set (exactOptionalPropertyTypes): a
  // grant-allow, an inherit-once-allow, and a silent-allow-in-agent-folder are
  // mutually exclusive (grants win first; the silent-allow only arms on a base
  // `confirm`).
  const result: ToolCallPlan = { auditRecord, verdict, shouldConfirm, shouldDispatch, redact }
  if (grantAllow) result.grantAllow = grantAllow
  if (inheritDiscovery) result.inheritDiscovery = inheritDiscovery
  if (inheritOnceAllow) result.inheritOnceAllow = true
  if (silentAllowInAgentFolder) result.silentAllowInAgentFolder = true
  return result
}
