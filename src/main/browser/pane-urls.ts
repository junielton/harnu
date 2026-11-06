/**
 * The addresses the open Harnu browser panes show (autonomous cleanup U3.5). Read-only: a stack
 * whose published port a pane is looking at is in use, so Cleanup never pauses it.
 *
 * Pure over the registry's records; `browser-service.ts` supplies the live view host.
 */

export interface PaneRef {
  paneId: string
  /** Set while the pane is discarded: the address it comes back to. */
  discarded?: { url: string } | null
}

/** The live address of each pane, else the remembered one of a discarded pane; empty ones are skipped. */
export function openPaneUrls(
  panes: readonly PaneRef[],
  liveUrl: (paneId: string) => string | undefined
): string[] {
  const urls: string[] = []
  for (const pane of panes) {
    const url = liveUrl(pane.paneId) || pane.discarded?.url
    if (url) urls.push(url)
  }
  return urls
}
