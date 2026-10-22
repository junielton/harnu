/**
 * "Errors that steer" for the browser verbs (T564 U1, spec §6.3): each refusal names the way forward.
 * Kept apart from `mcp/deny-hint.ts`, which delegates to it for every code in {@link BROWSER_DENIAL_CODES}.
 */
import type { SteerableDenial } from '../mcp/deny-hint'

export const BROWSER_DENIAL_CODES = [
  'PANE_NOT_FOUND',
  'BROWSER_DISCONNECTED',
  'BROWSER_READ_NOT_ENABLED',
  'BROWSER_WRITES_DISABLED',
  'BROWSER_PAUSED',
  'URL_SCHEME_BLOCKED',
  'PANE_LIMIT',
  'NOT_YET_AVAILABLE',
  'REF_STALE',
  'REF_NOT_FOUND',
  'SELECTOR_NOT_FOUND',
  'ELEMENT_NOT_VISIBLE',
  'CURSOR_EXPIRED',
  'SCREENSHOT_FAILED',
  'PAGE_READ_FAILED'
] as const
export type BrowserDenialCode = (typeof BROWSER_DENIAL_CODES)[number]

export function isBrowserDenialCode(code: string): code is BrowserDenialCode {
  return (BROWSER_DENIAL_CODES as readonly string[]).includes(code)
}

export interface BrowserHintContext {
  folder?: string
  /** `PANE_LIMIT`: the agent panes the folder already holds, to reuse. */
  reusablePaneIds?: readonly string[]
  /** `NOT_YET_AVAILABLE`: which feature the caller asked for. */
  feature?: string
  /** `URL_SCHEME_BLOCKED`: the refused scheme, when known. */
  scheme?: string
  /** `SELECTOR_NOT_FOUND`: the selector that matched nothing. */
  selector?: string
  /** `SCREENSHOT_FAILED` and `PAGE_READ_FAILED`: why it failed. */
  detail?: string
}

export function shapeBrowserDenial(
  code: BrowserDenialCode,
  ctx: BrowserHintContext = {}
): SteerableDenial {
  const at = ctx.folder ? ` (${ctx.folder})` : ''
  switch (code) {
    case 'PANE_NOT_FOUND':
      return {
        error: code,
        message: 'No browser pane with that id exists: it never did, or it was closed.',
        nextActions: [
          {
            do: 'Call browser_list for the panes that exist, or open one with browser_open.',
            why: 'Pane ids do not survive a restart, and a closed pane is gone.'
          }
        ]
      }
    case 'BROWSER_DISCONNECTED':
      return {
        error: code,
        message: `The operator disconnected that pane${at}. Reads and writes to it are refused for good.`,
        nextActions: [
          {
            do: 'Treat this as the operator’s decision. Open a new, visible pane with browser_open if you still need a browser, or ask the operator.',
            why: 'Disconnect is permanent for that pane id; no verb reconnects it.'
          }
        ]
      }
    case 'BROWSER_READ_NOT_ENABLED':
      return {
        error: code,
        message: `The operator opened that pane${at}, and agents may not read panes the operator opens until the operator allows it for the folder.`,
        nextActions: [
          {
            do: 'Open your own pane with browser_open and read that, or ask the operator to let agents read browser panes they open.',
            why: 'An operator-opened pane can hold pages the operator is signed in to; reading it is the operator’s decision, per folder.'
          }
        ]
      }
    case 'BROWSER_WRITES_DISABLED':
      return {
        error: code,
        message:
          'The operator switched off “Allow agents to drive browser panes” in Settings → Control server. Every write is refused until it is back on.',
        nextActions: [
          {
            do: 'Reading (browser_list) and closing still work. Tell the operator what you wanted to do and ask them to turn it back on.',
            why: 'The switch is the operator’s decision; do not route around it.'
          }
        ]
      }
    case 'BROWSER_PAUSED':
      return {
        error: code,
        message: `The operator paused agent access to that pane${at}. Writes are refused until they resume it or 10 minutes pass.`,
        nextActions: [
          {
            do: 'Reads still work. Wait for the pause to end, or ask the operator to resume.',
            why: 'A pause is temporary and does not revoke anything.'
          }
        ]
      }
    case 'URL_SCHEME_BLOCKED':
      return {
        error: code,
        message: `Harnu does not open ${ctx.scheme ? `${ctx.scheme}:` : 'that kind of'} addresses in a browser pane. Only http, https and about:blank are allowed.`,
        nextActions: [
          {
            do: 'Serve the content over http://localhost (a dev server) or use an https URL.',
            why: 'file:, chrome:, devtools:, view-source: and javascript: addresses are blocked so a page can never reach local files or the app itself.'
          }
        ]
      }
    case 'PANE_LIMIT':
      return {
        error: code,
        message: `This folder${at} already has 4 agent-opened browser panes, so Harnu will not open a fifth.`,
        nextActions: [
          {
            do:
              ctx.reusablePaneIds && ctx.reusablePaneIds.length > 0
                ? `Reuse one: browser_navigate on ${ctx.reusablePaneIds.join(', ')}, or browser_close one first.`
                : 'Call browser_list and reuse one of the panes, or close one with browser_close.',
            why: 'A pane that outlived its task still holds a page in memory; reusing one is cheaper than another.'
          }
        ]
      }
    case 'NOT_YET_AVAILABLE':
      return {
        error: code,
        message: `${ctx.feature ?? 'That form'} is not available yet in this build of the browser pane.`,
        nextActions: [
          {
            do: 'Use a `url` on browser_open instead (an http or https address, for example a dev server on localhost), or ask the operator.',
            why: 'This build ships the url form of browser_open and the list, navigate and close verbs; the rest arrive in later releases.'
          }
        ]
      }
    case 'REF_STALE':
      return {
        error: code,
        message:
          'That ref belongs to a page you have since navigated away from (or to a snapshot Harnu no longer remembers), so it no longer points at anything.',
        nextActions: [
          {
            do: 'Call browser_snapshot again and use a ref from the new snapshot.',
            why: 'Refs are valid for one page only; a navigation kills every ref made before it.'
          }
        ]
      }
    case 'REF_NOT_FOUND':
      return {
        error: code,
        message:
          'No such ref. Refs look like `s4e12` and come from a browser_snapshot of this pane.',
        nextActions: [
          {
            do: 'Copy a ref exactly from the latest browser_snapshot text, for example `[ref=s4e12]` → `s4e12`.',
            why: 'A ref is only meaningful for the snapshot that made it, in the pane that took it.'
          }
        ]
      }
    case 'SELECTOR_NOT_FOUND':
      return {
        error: code,
        message: `No element matches the selector${ctx.selector ? ` ${JSON.stringify(ctx.selector)}` : ''}.`,
        nextActions: [
          {
            do: 'Take a browser_snapshot to see what is on the page, or wait for it with browser_wait_for({ selector }).',
            why: 'The page may still be loading, or the element may be inside a frame or hidden.'
          }
        ]
      }
    case 'ELEMENT_NOT_VISIBLE':
      return {
        error: code,
        message: 'That element has no size on the page, so there is nothing to capture.',
        nextActions: [
          {
            do: 'Pick a visible element, or take a screenshot of the whole pane without `ref`/`selector`.',
            why: 'Elements that are display:none or collapsed to zero size have no pixels.'
          }
        ]
      }
    case 'CURSOR_EXPIRED':
      return {
        error: code,
        message:
          'That cursor points before the oldest entry Harnu still holds (or is not a cursor of this pane).',
        nextActions: [
          {
            do: 'Read again with mode `tail` (console) or without `since` (network) and continue from the cursor it returns.',
            why: 'The buffer is a bounded ring; entries older than its limits are gone for good.'
          }
        ]
      }
    case 'SCREENSHOT_FAILED':
      return {
        error: code,
        message: `The page could not be captured${ctx.detail ? `: ${ctx.detail}` : ''}.`,
        nextActions: [
          {
            do: 'Wait for the page to load with browser_wait_for, then try again; if the pane crashed, browser_navigate it to reload.',
            why: 'A page that is still starting or has crashed has no frame to capture.'
          }
        ]
      }
    case 'PAGE_READ_FAILED':
      return {
        error: code,
        message: `The page could not be read${ctx.detail ? `: ${ctx.detail}` : ''}.`,
        nextActions: [
          {
            do: 'Wait for the page to load with browser_wait_for, then try again; if the pane crashed, browser_navigate it to reload.',
            why: 'A page that is still starting, mid-navigation or crashed cannot answer.'
          }
        ]
      }
  }
}
