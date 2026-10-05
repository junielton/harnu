/**
 * In-memory "inherit-once" registry (T72 env shell). Holds the worktree paths the
 * operator allowed **just this app session** by answering "Only this" on an
 * inheritance-discovery confirm (a mutation denied FOLDER_NOT_ALLOWED in a
 * canonical `.claude/worktrees/*` worktree of an already-allowed repo).
 *
 * IN-MEMORY ONLY — a capability surviving a restart is a security smell, so these
 * allows die with the process (mirroring the grant-registry + the confirm stash).
 * On the next boot the worktree reconfirms. `closeInheritOnce` is called on
 * server/window teardown alongside `closeGrants`.
 *
 * The pure {@link planToolCall} reads a SNAPSHOT of these paths ({@link
 * snapshotInheritOnce}) and — HARDENING — only ever consults it when the base gate
 * verdict is deny+`FOLDER_NOT_ALLOWED`, never as raw membership above the gate, so
 * a later `PATH_ESCAPE` on the same path can never be shadowed by a once entry
 * (same discipline as the grant block). This module owns nothing but the mutable
 * `Set`; the composition math lives in `plan-tool-call.ts`.
 *
 * Deliberately NOT the mission-grant `dynamicFolders` (grant-registry): that is a
 * member of a live `MissionGrant` carrying budget/TTL/verbs and only grows from a
 * `create_worktree` under a grant (D3). The T72 case is explicitly grant-LESS
 * (PRD §3.5), so reusing it would mean synthesizing a fake grant. The PATTERN
 * (in-memory, process-lifetime, path-scoped) is shared; the data structure is
 * dedicated and lean.
 *
 * env-bound (module-level mutable state) ⇒ the security math is unit-tested via
 * `plan-tool-call`; this registry's own add/snapshot/close is covered directly.
 */

import { normalizePath } from './permission-core'

/** Normalized worktree paths allowed "just this session" (process-lifetime). */
const onceFolders = new Set<string>()

/**
 * Register a worktree as inherit-once-allowed. The path is normalized (shared
 * {@link normalizePath}) so the snapshot compares bit-for-bit with the gate. A
 * repeat add is a no-op (Set semantics).
 */
export function addInheritOnce(folder: string, homeDir?: string): void {
  onceFolders.add(homeDir === undefined ? normalizePath(folder) : normalizePath(folder, homeDir))
}

/** The current inherit-once paths (already normalized) for the pure gate composer. */
export function snapshotInheritOnce(): string[] {
  return [...onceFolders]
}

/** Whether a (normalized) path is currently inherit-once-allowed — for diagnostics/tests. */
export function hasInheritOnce(folder: string, homeDir?: string): boolean {
  return onceFolders.has(
    homeDir === undefined ? normalizePath(folder) : normalizePath(folder, homeDir)
  )
}

/** Clear every once-allow on server/window teardown (never outlives the server). */
export function closeInheritOnce(): void {
  onceFolders.clear()
}

/** Test-only reset. */
export function _resetInheritOnce(): void {
  onceFolders.clear()
}
