/**
 * Pure assembler (T15): turn the user's MCP prefs + pinned folders + scanned
 * roots into the {@link Policy} snapshot T3's `evaluateToolCall` consumes.
 *
 * Framework-free + side-effect-free (no fs / electron / timers — only the
 * shared `normalizePath` from `permission-core`, which itself touches only
 * `node:path`/`node:os` for `~` expansion) so the assembled policy is
 * deterministic and lands in the pure-core coverage surface per ADR-0001
 * (pure-core / thin-shell). The shell gathers the inputs (reads the enable
 * flag, the pinned folders, the scanned roots), calls {@link assemblePolicy},
 * and hands the snapshot to `evaluateToolCall`.
 *
 * THE ALLOWLIST IS GONE. Agents are free by default: this assembler no longer
 * computes "which folders may an agent act in" (the answer is "all of them"),
 * only "which folders did the operator explicitly BLOCK" — the `denyFolders`
 * denylist. `Policy.allowFolders` survives under its old name but with a new,
 * narrower job: it is the DISCLOSURE set (which folders' real paths may be shown
 * to an agent), derived as knownRoots-minus-blocked, and it is NOT read by the
 * gate. See `permission-core.ts`'s module header for the full posture.
 *
 * CORRECTNESS — this module reuses the SAME {@link normalizePath} as
 * permission-core so the policy and its consumer agree bit-for-bit on path
 * identity: a trailing-slash or `~` variant in a folder collapses to the exact
 * normalized form `evaluateToolCall` compares against. Diverging here would
 * silently break the denylist + containment checks for those variants.
 */

import { isFolderDenied, normalizePath, type Policy } from './permission-core'

/** The slice of user preferences the assembler reads. */
export interface McpPolicyPrefs {
  /** Master kill switch, copied verbatim onto {@link Policy.serverEnabled}. */
  serverEnabled: boolean
  /**
   * The opt-in friction switch ("Ask before agent actions"), copied verbatim onto
   * {@link Policy.ask}. Optional + defaults OFF — absent/false = the free posture
   * (mutations run without a confirm).
   */
  ask?: boolean
}

/**
 * One pinned/user folder row the assembler folds in. Its `path` always joins
 * `knownRoots`; it joins `denyFolders` only when `agentDenied`.
 */
export interface PolicyFolderInput {
  /** Absolute (or `~`-prefixed) folder path; normalized before use. */
  path: string
  /**
   * The operator explicitly BLOCKED agents in this folder (and its subtree). This
   * is the ONLY per-folder field the gate reads. Optional + absent ⇒ NOT blocked
   * (agents are free by default).
   */
  agentDenied?: boolean
  /**
   * DEPRECATED (the allowlist reversal). Still accepted so a legacy `projects.json`
   * record parses and round-trips, but the decision IGNORES it completely — a
   * record carrying `agentAllowed: false` from before the flip is nonetheless
   * reachable (that is what makes the reversal retroactive, with no migration
   * pass). Never written again; use {@link agentDenied} to block a folder.
   */
  agentAllowed?: boolean
}

/**
 * Normalize each path in `paths` (via the shared {@link normalizePath}) and
 * collect them into a new array, dropping later duplicates while preserving
 * first-seen order. Pure: never mutates the input.
 */
function normalizedUnique(paths: Iterable<string>, homeDir: string | undefined): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const p of paths) {
    const normalized = homeDir === undefined ? normalizePath(p) : normalizePath(p, homeDir)
    if (seen.has(normalized)) continue
    seen.add(normalized)
    out.push(normalized)
  }
  return out
}

/**
 * Assemble a {@link Policy} snapshot from user prefs, the pinned folders, and
 * the scanned roots. Pure + deterministic + non-mutating:
 *
 *  - `knownRoots` = normalized(pinned ∪ scanned), deduped, pinned-first order.
 *  - `denyFolders` = normalized paths of the pinned folders the operator BLOCKED
 *    (`agentDenied`). The gate's only per-folder input.
 *  - `allowFolders` = the DISCLOSURE set: every known root that is not blocked
 *    (nor inside a blocked one). NOT an access gate — see {@link Policy.allowFolders}.
 *  - `serverEnabled` / `ask` are copied from prefs.
 *
 * @param prefs - the enable flag + the `ask` friction opt-in.
 * @param userProjects - the pinned folders, each with its optional `agentDenied` flag.
 * @param scannedRoots - additional legitimate root directories.
 * @param homeDir - home dir for `~` expansion; injectable for tests. Defaults to
 *   `os.homedir()` (via {@link normalizePath}) when omitted.
 * @returns the {@link Policy} snapshot ready for `evaluateToolCall`.
 */
export function assemblePolicy(
  prefs: McpPolicyPrefs,
  userProjects: readonly PolicyFolderInput[],
  scannedRoots: readonly string[],
  homeDir?: string
): Policy {
  const knownRoots = normalizedUnique(
    [...userProjects.map((f) => f.path), ...scannedRoots],
    homeDir
  )

  // The ONLY per-folder gate input. `agentAllowed` is deliberately not consulted:
  // an old record that says `agentAllowed: false` is still reachable (retroactive
  // by construction — no migration pass rewrites anything on disk).
  const denyFolders = normalizedUnique(
    userProjects.filter((f) => f.agentDenied === true).map((f) => f.path),
    homeDir
  )

  // The disclosure set: a known root may have its real path shown to an agent
  // unless the operator blocked it (or an ancestor of it). Prefix-aware, so
  // blocking a repo also hides its worktrees' paths.
  const denied = (root: string): boolean =>
    homeDir === undefined
      ? isFolderDenied(root, denyFolders)
      : isFolderDenied(root, denyFolders, homeDir)
  const allowFolders =
    denyFolders.length === 0 ? knownRoots : knownRoots.filter((root) => !denied(root))

  return {
    serverEnabled: prefs.serverEnabled,
    denyFolders,
    allowFolders,
    knownRoots,
    ...(prefs.ask === true ? { ask: true } : {})
  }
}
