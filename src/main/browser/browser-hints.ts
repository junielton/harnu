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
  'ELEMENT_OBSCURED',
  'ELEMENT_DISABLED',
  'ELEMENT_NOT_EDITABLE',
  'OFFSET_OUTSIDE_BOX',
  'EVAL_TIMEOUT',
  'FRAME_NOT_FOUND',
  'INPUT_FAILED',
  'BROWSER_KEY_UNKNOWN',
  'PANE_INPUT_NOT_READY',
  'BROWSER_APPROVED_RESEND',
  'BROWSER_WRITE_DENIED',
  'BROWSER_LEASE_ENDED',
  'BROWSER_BUSY',
  'BROWSER_RATE_LIMIT',
  'NOT_A_PAGE_PANE',
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
  /** `SCREENSHOT_FAILED`, `PAGE_READ_FAILED`, `INPUT_FAILED`, `BROWSER_KEY_UNKNOWN`: what went wrong. */
  detail?: string
  /** `ELEMENT_NOT_VISIBLE`: the verb that asked, so the hint speaks of input and not of a capture. */
  during?: 'input'
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
      if (ctx.during === 'input') {
        return {
          error: code,
          message:
            'That element did not become visible and still within 5 seconds, so nothing was done to it.',
          nextActions: [
            {
              do: 'Take a browser_snapshot to see the page as it is now, scroll or open whatever hides the element, then use a fresh ref.',
              why: 'Input is only sent to an element a person could see and reach: it must have a size, be inside the page and stop moving.'
            }
          ]
        }
      }
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
    case 'ELEMENT_OBSCURED':
      return {
        error: code,
        message:
          'Something else covers that element at the point Harnu would click, and it did not go away within 5 seconds. Nothing was clicked.',
        nextActions: [
          {
            do: 'Take a browser_snapshot, close or dismiss whatever is in front (a dialog, a cookie banner, a menu), then try again; or click the covering element instead.',
            why: 'A real click lands on the topmost element at that point, so clicking a covered element would press something else.'
          }
        ]
      }
    case 'ELEMENT_DISABLED':
      return {
        error: code,
        message: 'That element is disabled, so it does not take input. Nothing was done.',
        nextActions: [
          {
            do: 'Do whatever enables it first (fill a required field, tick a box), then take a fresh browser_snapshot and try again.',
            why: 'A disabled control ignores clicks and typing; the page enables it when its conditions are met.'
          }
        ]
      }
    case 'ELEMENT_NOT_EDITABLE':
      return {
        error: code,
        message: 'That element does not take typed text, so nothing was typed.',
        nextActions: [
          {
            do: 'Use the ref of a text field, a text area or an editable region from browser_snapshot. To press a button use browser_click.',
            why: 'browser_fill and browser_type put text into editable elements only.'
          }
        ]
      }
    case 'OFFSET_OUTSIDE_BOX':
      return {
        error: code,
        message: 'The `offset` is outside the element’s box. Nothing was clicked.',
        nextActions: [
          {
            do: 'Pass `offset` as {x, y} in CSS pixels measured from the element’s top-left corner, within its width and height, or leave it out to click the centre.',
            why: 'Clicks are aimed at elements, never at raw page coordinates.'
          }
        ]
      }
    case 'EVAL_TIMEOUT':
      return {
        error: code,
        message: `The script did not finish in time and was stopped${ctx.detail ? ` (${ctx.detail})` : ''}.`,
        nextActions: [
          {
            do: 'Make the expression return sooner (do less per call, or use browser_wait_for for things that take time), or raise `timeoutMs` (at most 30000).',
            why: 'An expression that never settles would hold the pane for every other writer.'
          }
        ]
      }
    case 'FRAME_NOT_FOUND':
      return {
        error: code,
        message: `No frame of this page matches${ctx.detail ? ` ${JSON.stringify(ctx.detail)}` : ''}.`,
        nextActions: [
          {
            do: 'Pass `frame` as a frame’s name or a part of its address, or leave it out to run in the top page. browser_snapshot lists child frames as `iframe [host]`.',
            why: 'The script must run in a frame the page really has.'
          }
        ]
      }
    case 'INPUT_FAILED':
      return {
        error: code,
        message: `The input could not be sent${ctx.detail ? `: ${ctx.detail}` : ''}.`,
        nextActions: [
          {
            do: 'Take a browser_snapshot and try again with a fresh ref; if the pane crashed, browser_navigate it to reload.',
            why: 'The page changed or went away between finding the element and acting on it.'
          }
        ]
      }
    case 'BROWSER_KEY_UNKNOWN':
      return {
        error: code,
        message: ctx.detail ?? 'That is not a key name.',
        nextActions: [
          {
            do: 'Press keys by name in `keys` (Enter, Tab, Esc, Backspace, Delete, Space, Up/Down/Left/Right, Home, End, PageUp, PageDown, F1–F12, a letter or digit, with Ctrl+, Alt+, Meta+ or Shift+ in front). Put text in browser_type.',
            why: 'Control actions are named keys so the operator and the audit see exactly what was pressed. Nothing was pressed.'
          }
        ]
      }
    case 'PANE_INPUT_NOT_READY':
      return {
        error: code,
        message:
          'Nothing was sent. This pane is still on the first page it loaded, and a pane does not take mouse clicks or key presses on its first page, so a click or a key press would have been acknowledged and ignored.',
        nextActions: [
          {
            do: 'Reload it with browser_navigate({ paneId, action: "reload" }), then browser_snapshot for fresh refs, and call again. Any later navigation fixes it.',
            why: 'After the first navigation the pane delivers clicks and key presses, whether or not the operator is looking at it.'
          },
          {
            do: 'browser_fill, a plain browser_type (no delayMs, no submit) and browser_eval work on the first page; use them if you do not need a click or a key.',
            why: 'They insert text and run script instead of sending mouse and key events.'
          }
        ]
      }
    case 'BROWSER_APPROVED_RESEND':
      return {
        error: code,
        message:
          'Nothing was done. The operator approved driving this pane. Call browser_snapshot to see the page as it is now, then call the verb again.',
        nextActions: [
          {
            do: 'Call browser_snapshot to see the page as it is now, then call the verb again with what you still want done.',
            why: 'An approval only grants a lease on this pane; the call that asked is never replayed, because the page may have changed while it waited.'
          }
        ]
      }
    case 'BROWSER_WRITE_DENIED':
      return {
        error: code,
        message: `The operator declined driving that pane${at}. Script and input calls to it are refused for 5 minutes.`,
        nextActions: [
          {
            do: 'Stop sending to this pane. Open your own pane on a local dev server with browser_open, or ask the operator to run it or to allow it.',
            why: 'A Deny starts a 5-minute cooldown; asking again right away only gets refused.'
          }
        ]
      }
    case 'BROWSER_LEASE_ENDED':
      return {
        error: code,
        message:
          'Nothing was done. The operator’s lease on this pane ended before the call ran (it idled out, or the pane, the folder or the control switch changed).',
        nextActions: [
          {
            do: 'Call the verb again: it will ask the operator for a new lease.',
            why: 'A lease ends after 10 minutes without an agent write, on close, Disconnect, a folder block or the kill-switch.'
          }
        ]
      }
    case 'BROWSER_BUSY':
      return {
        error: code,
        message:
          'Other writes to this pane were still running after 10 seconds, so yours was not started. Nothing was done.',
        nextActions: [
          {
            do: 'Wait a moment and call again, or work on a different pane.',
            why: 'Writes to one pane run one at a time, in order; a stuck one must not hold up the 2-minute tool deadline.'
          }
        ]
      }
    case 'BROWSER_RATE_LIMIT':
      return {
        error: code,
        message: 'More than 60 writes to this pane in the last minute. Nothing was done.',
        nextActions: [
          {
            do: 'Slow down: batch field values into one browser_fill, and wait for the page with browser_wait_for instead of retrying.',
            why: 'A loop that clicks as fast as it can is almost always a mistake worth stopping.'
          }
        ]
      }
    case 'NOT_A_PAGE_PANE':
      return {
        error: code,
        message:
          'Live-panel verbs work on a Harnu page pane only; this pane shows another kind of page.',
        nextActions: [
          {
            do: 'Open a page with browser_open({ path }) for a live panel, or use browser_eval / browser_click on this pane.',
            why: 'A live panel is a page Harnu serves itself; patching someone else’s page is not allowed.'
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
