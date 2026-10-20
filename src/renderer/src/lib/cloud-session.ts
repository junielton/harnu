/**
 * Cloud-stub classification, shared by `App.vue` (which panel to render) and
 * `TerminalPane.vue` (whether to refuse a doomed `claude --resume`).
 *
 * See `design.md` §6 → "Cloud session panel" and
 * `docs/specs/BUG-198-cloud-panel-false-positive.md`.
 */

/** The slice of a `Session` the classification reads. */
export interface CloudStubInput {
  resumable: boolean
  isShellTerminal?: boolean
  resumeAnyway?: boolean
}

/**
 * Whether the selected session should render `CloudSessionPanel` instead of the
 * terminal. Only a row with no live terminal in this app run qualifies: while
 * the process that will write the turns is alive, disk's turn count says
 * nothing (G1). "Resume anyway" lifts the classification for good (G4).
 */
export function isCloudStub(
  session: CloudStubInput | null | undefined,
  hasLiveTerminal: boolean
): boolean {
  if (!session || session.resumable !== false) return false
  return !session.isShellTerminal && !session.resumeAnyway && !hasLiveTerminal
}

/**
 * Whether `TerminalPane` must refuse to spawn `claude --resume` for this row
 * (a doomed process: "No conversation found …"). Lifted by "Resume anyway".
 */
export function isSpawnRefused(session: CloudStubInput | null | undefined): boolean {
  return session?.resumable === false && !session.resumeAnyway
}
