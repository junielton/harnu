/**
 * "Errors that steer" for the browser verbs (T564 U1, spec §6.3): each refusal names the way forward.
 * Kept apart from `mcp/deny-hint.ts`, which delegates to it for every code in {@link BROWSER_DENIAL_CODES}.
 */
import type { SteerableDenial } from '../mcp/deny-hint'

export const BROWSER_DENIAL_CODES = [
  'PANE_NOT_FOUND',
  'BROWSER_DISCONNECTED',
  'BROWSER_WRITES_DISABLED',
  'BROWSER_PAUSED',
  'URL_SCHEME_BLOCKED',
  'PANE_LIMIT',
  'NOT_YET_AVAILABLE'
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
  }
}
