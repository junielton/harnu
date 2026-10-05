/**
 * The security heart of the Harnu MCP server (T3): a PURE decision function that
 * gates every inbound MCP tool call against a policy snapshot.
 *
 * Framework-free + side-effect-free (no `fs`/`electron`/timers) so it is
 * deterministic and unit-testable in the node vitest env, landing in the
 * pure-core coverage surface per ADR-0001 (pure-core / thin-shell). The shell
 * builds the {@link Policy} snapshot (reading the kill switch, the `ask` friction
 * pref, the blocked folders, and the known roots), calls {@link evaluateToolCall},
 * and then applies the side effects (dispatch, surface a confirm, audit).
 *
 * SECURITY CONTRACT — agents are FREE BY DEFAULT; friction is opt-in. This is a
 * deliberate, operator-approved reversal of the original fail-closed allowlist
 * posture (an agent that got a session id back from `create_session` and was then
 * refused `get_session` with `FOLDER_NOT_ALLOWED` left the machine idle). The
 * contract is now:
 *
 *  1. A disabled server denies EVERYTHING, including reads (the kill switch — the
 *     ONE unconditional gate that survives).
 *  2. A folder the operator explicitly BLOCKED (`agentDenied`), or any path INSIDE
 *     one, is denied `FOLDER_NOT_ALLOWED`. The denylist is ABSOLUTE: no grant, no
 *     confirm, no discovery layer may promote it (see `plan-tool-call.ts`).
 *  3. Otherwise reads → `allow` (transcript reads included: there is no allowlist
 *     left to gate them by).
 *  4. Otherwise mutations → `allow` in the DEFAULT mode, or `confirm` when the
 *     operator opted into {@link Policy.ask} ("Ask before agent actions").
 *
 * THERE IS NO ALLOWLIST. `Policy.allowFolders` survives only as the DISCLOSURE
 * set (which folders' real paths may be shown to an agent — see its doc); it is
 * NOT read by {@link evaluateToolCall} any more.
 *
 * CONTAINMENT (`PATH_ESCAPE`) is likewise only enforced in the guarded (`ask`)
 * mode. In the default mode an unknown path is NOT an error — the operator chose
 * "no boundary at all", which is coherent because `adopt_folder` is itself silent:
 * a containment boundary would have been bypassable in two hops anyway.
 *
 * The {@link normalizePath} helper (trailing-slash strip + `~` expansion) is the
 * single normalization used for every path comparison here and is re-exported
 * for reuse by the endpoint/registry layer (T15).
 */

import * as os from 'node:os'
import * as path from 'node:path'

/** The three possible gate outcomes. `confirm` defers to a human prompt. */
export type Verdict = 'allow' | 'deny' | 'confirm'

/** Machine-readable cause for a `deny`. Surfaced in the audit log + UI. */
export type DenyReason = 'SERVER_DISABLED' | 'PATH_ESCAPE' | 'FOLDER_NOT_ALLOWED'

/** The decision returned by {@link evaluateToolCall}. `reason` is set on deny only. */
export interface Decision {
  verdict: Verdict
  reason?: DenyReason
}

/** Read vs mutation classification of an inbound tool call. */
export type ToolKind = 'read' | 'mutation'

/** A single inbound MCP tool call, classified for the gate. */
export interface ToolCall {
  /** The MCP tool name (e.g. `fleet_status`, `get_session`, `session_send`). */
  tool: string
  /** Whether this call only reads state or mutates it. */
  kind: ToolKind
  /**
   * Absolute path of the folder/cwd the call targets. Optional — a global read
   * (e.g. fleet status) has no single target. An absent folder is no longer a
   * denial: with no allowlist there is nothing to be absent from, and the only
   * per-folder gate (the denylist) simply cannot match an unknown target.
   */
  folder?: string
  /**
   * Whether a read discloses transcript content (e.g. `get_session` returning the
   * conversation). NO LONGER GATED here — it used to require an allowlisted folder.
   * Retained because the shell still uses it to pick the redaction directive, and
   * because a guarded mode would want it back.
   */
  disclosesTranscript?: boolean
}

/** The policy snapshot the shell assembles for each decision. */
export interface Policy {
  /** Master kill switch. `false` denies every call, reads included. */
  serverEnabled: boolean
  /**
   * The DENYLIST — folders the operator explicitly blocked for agents
   * (`UserProject.agentDenied`). A target that IS one of these, or lives INSIDE
   * one, is denied `FOLDER_NOT_ALLOWED`, reads included. Absolute: no layer above
   * the gate may promote it. Optional + absent ⇒ nothing blocked (the default
   * free posture).
   */
  denyFolders?: string[]
  /**
   * NOT an access gate any more (the allowlist is gone). This is the DISCLOSURE
   * set: the known folders whose REAL absolute paths may be revealed to an agent
   * — every known root the operator has not blocked. Consumed by
   * `fleet-snapshot.ts` / `worktree-core.ts` to decide what to alias away when
   * redacting, never by {@link evaluateToolCall}.
   */
  allowFolders: string[]
  /** Legitimate root directories. The containment anchor — enforced only when {@link ask}. */
  knownRoots: string[]
  /**
   * The opt-in FRICTION switch ("Ask before agent actions", `mcp-prefs.json`
   * `{ "ask": true }`). Default `false`/absent = the free posture: mutations
   * `allow` without a human. When `true`, every mutation resolves to `confirm`
   * again and containment (`PATH_ESCAPE`) is re-armed. It does NOT resurrect the
   * allowlist — a folder is still reachable unless it is explicitly denied.
   */
  ask?: boolean
}

/**
 * Normalize a path for stable comparison: expand a leading `~`, absolutize +
 * collapse `.`/`..` segments, then strip a trailing separator (except the
 * filesystem root). PURE — no `fs.realpath`, so it is deterministic and works on
 * paths that do not yet exist on disk. This is the single normalization used by
 * every path check in this module and is re-exported for T15.
 *
 * @param input - the raw path (may start with `~`, may have a trailing slash).
 * @param homeDir - home directory used for `~` expansion; injectable for tests.
 *   Defaults to `os.homedir()`.
 * @returns the normalized absolute path.
 */
export function normalizePath(input: string, homeDir: string = os.homedir()): string {
  const expanded = input.startsWith('~') ? path.join(homeDir, input.slice(1)) : input
  const resolved = path.resolve(expanded)
  const normalized = path.normalize(resolved)
  return stripTrailingSeparator(normalized)
}

/** Drop a trailing path separator, but never from the root (`/`, `C:\`). */
function stripTrailingSeparator(p: string): string {
  if (p.length <= 1) return p
  if (process.platform === 'win32' && /^[A-Za-z]:\\$/.test(p)) return p
  if (p.endsWith(path.sep) && p !== path.sep) return p.slice(0, -1)
  return p
}

/** Whether `target` is `root` itself or a descendant of it (both normalized). */
export function isWithinRoot(target: string, root: string): boolean {
  if (target === root) return true
  const prefix = root.endsWith(path.sep) ? root : root + path.sep
  return target.startsWith(prefix)
}

/** Whether the target folder is contained within at least one known root. */
function isWithinKnownRoots(folder: string, knownRoots: string[], homeDir: string): boolean {
  const target = normalizePath(folder, homeDir)
  return knownRoots.some((root) => isWithinRoot(target, normalizePath(root, homeDir)))
}

/**
 * Whether the target folder is BLOCKED — it is itself an `agentDenied` folder, or
 * it lives inside one. Prefix containment (not bare equality) is what makes a
 * block cover a repo's worktrees and subdirectories in one action.
 */
export function isFolderDenied(
  folder: string,
  denyFolders: readonly string[],
  homeDir: string = os.homedir()
): boolean {
  const target = normalizePath(folder, homeDir)
  return denyFolders.some((d) => isWithinRoot(target, normalizePath(d, homeDir)))
}

/**
 * Resolve a raw folder string to the CANONICAL path of a known folder —
 * never the raw spelling. A pane-routing key (2026-07-13 agent-pane-routing
 * design) must exact-match a folder Harnu actually tracks: a trailing slash,
 * a `~` spelling, or a symlink alias would otherwise mint a phantom key that
 * appends to a stack no session renders (the hidden second cause behind
 * BUG-20). `undefined` when nothing in `knownFolders` matches by normalized-
 * path equality, so the caller can steer instead of routing to a phantom.
 */
export function resolveKnownFolder(
  folder: string,
  knownFolders: string[],
  homeDir: string = os.homedir()
): string | undefined {
  const target = normalizePath(folder, homeDir)
  return knownFolders.find((f) => normalizePath(f, homeDir) === target)
}

/**
 * Decide whether an inbound MCP tool call may proceed. Pure: same inputs always
 * yield the same {@link Decision}. See the module header for the full contract;
 * the precedence is:
 *
 *   1. server kill switch                    → SERVER_DISABLED
 *   2. explicitly BLOCKED folder (or inside one) → FOLDER_NOT_ALLOWED (absolute)
 *   3. containment, ONLY in the `ask` mode    → PATH_ESCAPE
 *   4. reads                                  → allow
 *   5. mutations                              → allow, or `confirm` when `ask`
 *
 * Note the inversion versus the original M1 gate: an UNKNOWN folder is no longer
 * an error. A folder nobody ever pinned is reachable — that idle-machine bug
 * (`create_session` succeeds, `get_session` refused) is exactly what this
 * reversal removes. Only an explicit block, or the kill switch, refuses.
 *
 * @param call - the classified inbound tool call.
 * @param policy - the policy snapshot to decide against.
 * @returns the gate decision.
 */
export function evaluateToolCall(call: ToolCall, policy: Policy): Decision {
  const homeDir = os.homedir()

  // 1. Master kill switch — denies everything, reads included.
  if (!policy.serverEnabled) return deny('SERVER_DISABLED')

  // 2. The denylist. Checked BEFORE everything else that could allow, and it is
  //    ABSOLUTE — `plan-tool-call.ts` refuses to let any layer (grant, bootstrap
  //    confirm, worktree-inheritance discovery) promote this deny. A block covers
  //    the folder AND its whole subtree, so blocking a repo blocks its worktrees.
  if (call.folder !== undefined && isFolderDenied(call.folder, policy.denyFolders ?? [], homeDir)) {
    return deny('FOLDER_NOT_ALLOWED')
  }

  // 3. Containment — only in the guarded (`ask`) mode. In the default free mode
  //    the operator deliberately chose "no boundary at all": an unknown path is
  //    not an error, and `adopt_folder` could silently widen any boundary anyway.
  if (
    policy.ask === true &&
    call.folder !== undefined &&
    !isWithinKnownRoots(call.folder, policy.knownRoots, homeDir)
  ) {
    return deny('PATH_ESCAPE')
  }

  // 4. Reads — always permitted outside a blocked folder. Transcript-disclosing
  //    reads (`get_session`, project memory) are no longer allowlist-gated: there
  //    is no allowlist, and the folder denylist above already covers the only
  //    folders the operator said an agent may not see.
  if (call.kind === 'read') return { verdict: 'allow' }

  // 5. Mutations — free by default; `ask` re-arms the human confirm for all of
  //    them. (The verbs that ALWAYS face a human regardless — `submit_manifest`,
  //    `plan_mission` — are forced back to `confirm` one layer up, in
  //    `plan-tool-call.ts`: this core is tool-agnostic by design.)
  return { verdict: policy.ask === true ? 'confirm' : 'allow' }
}

/** Build a `deny` decision with a machine-readable reason. */
function deny(reason: DenyReason): Decision {
  return { verdict: 'deny', reason }
}
