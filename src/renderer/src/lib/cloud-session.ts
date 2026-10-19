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

/** Whether the selected session should render `CloudSessionPanel` instead of the terminal. */
export function isCloudStub(
  session: CloudStubInput | null | undefined,
  _hasLiveTerminal: boolean
): boolean {
  return session?.resumable === false && !session?.isShellTerminal
}

/** Whether `TerminalPane` must refuse to spawn `claude --resume` for this row. */
export function isSpawnRefused(session: CloudStubInput | null | undefined): boolean {
  return session?.resumable === false
}
