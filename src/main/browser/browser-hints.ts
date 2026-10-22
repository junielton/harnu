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
  'PAGE_READ_FAILED',
  'ZOOM_IN_DEVICE_MODE',
  'EMULATION_FAILED',
  'NOT_A_FILE_INPUT',
  'UPLOAD_PATH_DENIED',
  'UPLOAD_TOO_LARGE',
  'NO_DOWNLOAD_STARTED',
  'DOWNLOAD_TOO_LARGE',
  'DOWNLOAD_FAILED',
  'DOWNLOAD_CANCELLED',
  // T569 U2: live panels and the path / html forms of browser_open.
  'DATA_TOO_LARGE',
  'REV_CONFLICT',
  'HTML_TOO_LARGE',
  'PATH_NOT_ALLOWED',
  'PAGE_NOT_READY'
] as const
export type BrowserDenialCode = (typeof BROWSER_DENIAL_CODES)[number]

/**
 * Refusals whose plan-level message carries the specific problem (`CODE: detail`), because the code alone cannot
 * say which path or which argument was wrong.
 */
export const BROWSER_DETAIL_CODES = [
  'BROWSER_KEY_UNKNOWN',
  'ZOOM_IN_DEVICE_MODE',
  'UPLOAD_PATH_DENIED'
] as const satisfies readonly BrowserDenialCode[]

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
  /**
   * `SCREENSHOT_FAILED`, `PAGE_READ_FAILED`, `INPUT_FAILED`, `BROWSER_KEY_UNKNOWN`, `ZOOM_IN_DEVICE_MODE`,
   * `EMULATION_FAILED`, `UPLOAD_*`, `DOWNLOAD_*`: what went wrong.
   */
  detail?: string
  /** `ELEMENT_NOT_VISIBLE`: the verb that asked, so the hint speaks of input and not of a capture. */
  during?: 'input'
  /** `PANE_INPUT_NOT_READY`: who opened the pane. An agent may reload its own pane; an operator's page is theirs. */
  openedBy?: 'agent' | 'operator'
  /** `REV_CONFLICT`: the rev the sidecar holds now. */
  currentRev?: number
  /** `DATA_TOO_LARGE` / `HTML_TOO_LARGE`: the cap, in bytes. */
  limitBytes?: number
  /** `PATH_NOT_ALLOWED`: why the jail refused. */
  jailReason?: string
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
            do: 'Use a `url`, `path` or `html` on browser_open instead (an http or https address, a project .html file, or inline HTML for a live panel), or ask the operator.',
            why: 'This build ships the list, navigate and close verbs and the live-panel verbs; the rest arrive in later releases.'
          }
        ]
      }
    case 'NOT_A_PAGE_PANE':
      return {
        error: code,
        message: `browser_set_data and browser_patch only work on a pane showing one of Harnu's own page files (an origin of \`page\`)${at}. This pane is showing something else.`,
        nextActions: [
          {
            do: 'Open the panel with browser_open({ path }) or browser_open({ html, name }) and use that paneId. For a dev server or an external site there is no data/patch verb.',
            why: 'Live panels are page-class only for every caller, so a read-only worker can never reach a dev server or a site through them.'
          }
        ]
      }
    case 'SELECTOR_NOT_FOUND':
      return {
        error: code,
        message: `The selector${ctx.selector ? ` “${ctx.selector}”` : ''} matched no element in the page, or is not a valid CSS selector.`,
        nextActions: [
          {
            do: 'Check the selector against the page (a patch changes the live DOM, so an element your script has not rendered yet does not exist), or take a browser_snapshot, or wait for it with browser_wait_for({ selector }).',
            why: 'Zero matches is an error, not a silent no-op, so a typo cannot pass for success; the page may also still be loading, or the element may be inside a frame or hidden.'
          }
        ]
      }
    case 'DATA_TOO_LARGE':
      return {
        error: code,
        message: `That data is larger than ${Math.round((ctx.limitBytes ?? 262144) / 1024)} KiB once serialised.`,
        nextActions: [
          {
            do: 'Send less: keep the panel state small (counts, ids, short strings) and have the page fetch or render the bulk from files.',
            why: 'The state is one JSON file shared by every pane on the page and re-read on every reload.'
          }
        ]
      }
    case 'REV_CONFLICT':
      return {
        error: code,
        message: `expectRev did not match: the page state is at rev ${ctx.currentRev ?? '?'} now. Nothing was written.`,
        nextActions: [
          {
            do: 'Read the current state (browser_snapshot with include: ["data"], or call set_data without expectRev), merge your change, and call again with the new rev.',
            why: 'Someone else wrote the state since you read it; expectRev exists so you never overwrite that blindly.'
          }
        ]
      }
    case 'HTML_TOO_LARGE':
      return {
        error: code,
        message: `That HTML is larger than ${Math.round((ctx.limitBytes ?? 65536) / 1024)} KiB.`,
        nextActions: [
          {
            do: 'For a bigger panel write the .html file with your Write tool and open it with browser_open({ path }); keep patches small.',
            why: 'Patches are a scalpel for one number or row; the file is the panel.'
          }
        ]
      }
    case 'PATH_NOT_ALLOWED':
      return {
        error: code,
        message: `Harnu will not serve that path${ctx.jailReason ? ` (${ctx.jailReason})` : ''}${at}.`,
        nextActions: [
          {
            do: 'Pass a file inside this folder that exists (repo-relative or absolute). Nothing under .git or .harnu/memory is served, and a symlink that leaves the folder is refused.',
            why: 'A page can only read files the operator could already open from this folder.'
          }
        ]
      }
    case 'PAGE_NOT_READY':
      return {
        error: code,
        message: `The page in that pane has not finished loading, so nothing was changed${at}.`,
        nextActions: [
          {
            do: 'Wait a moment and call again (browser_navigate with waitUntil: "load" waits for it), or check the pane with browser_list.',
            why: 'A patch needs a loaded document; this is not the same as a selector that matches nothing.'
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
    case 'PANE_INPUT_NOT_READY': {
      const operatorPane = ctx.openedBy === 'operator'
      return {
        error: code,
        message:
          'Nothing was sent. A pane does not take mouse clicks or key presses on the first page it loads, after it moves to another site (or from about:blank), or after a page redirects itself, until it is navigated again on the same site, so a click or a key press would have been acknowledged and ignored.',
        nextActions: [
          operatorPane
            ? {
                do: 'Ask the operator to reload that pane (or to open another page in it), then browser_snapshot for fresh refs and call again. Do not reload it yourself.',
                why: 'The operator opened this pane: a reload can lose what they have typed or the state they are in. After that the pane delivers clicks and key presses.'
              }
            : {
                do: 'Reload it with browser_navigate({ paneId, action: "reload" }), then browser_snapshot for fresh refs, and call again. A reload (or navigating the same site again) fixes it.',
                why: 'After that the pane delivers clicks and key presses, whether or not the operator is looking at it.'
              },
          {
            do: 'browser_fill, a plain browser_type (no delayMs, no submit) and browser_eval work on the first page; use them if you do not need a click or a key.',
            why: 'They insert text and run script instead of sending mouse and key events.'
          }
        ]
      }
    }
    case 'ZOOM_IN_DEVICE_MODE':
      return {
        error: code,
        message:
          ctx.detail ??
          'Zoom is off while a device is emulated: entering device mode resets it to 100%.',
        nextActions: [
          {
            do: 'Call browser_emulate with `reset: true` (and `zoom`, if you still want one) to leave device mode first, or drop `zoom` and use a smaller `device` or `width`/`height` instead.',
            why: 'In device mode the page is drawn at the device’s own size; a second scale on top would make coordinates and media queries disagree with the device.'
          }
        ]
      }
    case 'EMULATION_FAILED':
      return {
        error: code,
        message: `The device settings could not be applied${ctx.detail ? `: ${ctx.detail}` : ''}.`,
        nextActions: [
          {
            do: 'Call browser_list to see the emulation the pane actually has, then try again; if the pane crashed, browser_navigate it to reload.',
            why: 'The page was not ready, or went away, while the settings were being sent.'
          }
        ]
      }
    case 'NOT_A_FILE_INPUT':
      return {
        error: code,
        message: 'That element is not an `<input type=file>`.',
        nextActions: [
          {
            do: 'Take a browser_snapshot and pass the ref of the file input itself (a button that opens the file dialog is not enough; look for a textbox or button that belongs to the input, or use browser_eval to find it).',
            why: 'Files are attached to the input element directly; Harnu never opens a native file dialog.'
          }
        ]
      }
    case 'UPLOAD_PATH_DENIED':
      return {
        error: code,
        message: `That file cannot be uploaded${ctx.detail ? `: ${ctx.detail}` : ''}.`,
        nextActions: [
          {
            do: 'Pass paths that are files inside the pane’s folder. Secrets (.git, .env*, *.pem, *.key, id_*) and anything reached through a link that leaves the folder are never uploaded. Copy a file into the folder first if you need it.',
            why: 'Nothing outside the folder may leave through a page; the operator’s folder is the boundary.'
          }
        ]
      }
    case 'UPLOAD_TOO_LARGE':
      return {
        error: code,
        message: `That file is too large to upload${ctx.detail ? `: ${ctx.detail}` : ''}. The limit is 50 MiB per file.`,
        nextActions: [
          {
            do: 'Upload a smaller file, or split it.',
            why: 'Large uploads would sit in memory while they are attached.'
          }
        ]
      }
    case 'NO_DOWNLOAD_STARTED':
      return {
        error: code,
        message: 'No download began before the timeout, so nothing was saved.',
        nextActions: [
          {
            do: 'Check the link with browser_snapshot, pass `ref` of the element that starts the download (or `url` of the file), or raise `timeoutMs` (at most 30000).',
            why: 'The allowance lasts one download and ends when the call does; a download the page starts later is cancelled.'
          }
        ]
      }
    case 'DOWNLOAD_TOO_LARGE':
      return {
        error: code,
        message: `The download is over the 100 MiB limit and was cancelled${ctx.detail ? ` (${ctx.detail})` : ''}.`,
        nextActions: [
          {
            do: 'Download a smaller file, or ask the operator to fetch it themselves.',
            why: 'Downloads land in the folder; a huge one would fill the disk.'
          }
        ]
      }
    case 'DOWNLOAD_FAILED':
      return {
        error: code,
        message: `The download did not complete${ctx.detail ? `: ${ctx.detail}` : ''}. Nothing was kept.`,
        nextActions: [
          {
            do: 'Try again, or check the address with browser_navigate first.',
            why: 'The connection dropped or the server refused partway.'
          }
        ]
      }
    case 'DOWNLOAD_CANCELLED':
      return {
        error: code,
        message: `The download was cancelled${ctx.detail ? `: ${ctx.detail}` : ''}.`,
        nextActions: [
          {
            do: 'Tell the operator if you still need the file; do not retry in a loop.',
            why: 'The operator or the page cancelled it.'
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
          'Nothing was done. The operator’s lease on this pane ended before the call ran (it idled out, the pane moved to another site, or the pane, the folder or the control switch changed).',
        nextActions: [
          {
            do: 'Call the verb again: it will ask the operator for a new lease.',
            why: 'A lease ends after 10 minutes without an agent write, when the pane moves to another site (scheme, host or port), on close, Disconnect, a folder block or the kill-switch.'
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
