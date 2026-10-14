/** The two preload calls releasing a helper's PTY needs. Narrowed so a test can fake them. */
export interface ReleaseApi {
  ptyDestroy(id: string): void
  terminalXtermGone(terminalId: string): void
}

/**
 * What a helper's renderer half does with its PTY when the xterm is disposed — on window unload
 * and on explicit removal alike (T474 §8 case 11).
 *
 * An operator-opened shell owns its PTY: destroy it, as it always has. An agent terminal's PTY
 * belongs to main (an agent holds its id, and a reload must not turn a viewed terminal into a
 * `closed` one while an unviewed one survives), so the renderer only says its xterm is gone.
 * Killing it on removal is main's job, through `terminal:close`.
 */
export function releaseHelperPty(
  live: { ptyId: string; terminalId?: string },
  api: ReleaseApi
): void {
  if (live.terminalId !== undefined) api.terminalXtermGone(live.terminalId)
  else api.ptyDestroy(live.ptyId)
}
