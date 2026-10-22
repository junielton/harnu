/**
 * What the operator reads in a browser lease confirm (T564 U4, spec §7.1, design.md "Lease confirm"): the pane, the
 * site, and the first thing the agent would do, made safe to read. The confirm is the only thing standing between
 * an agent and a page the operator is signed in to, so it must not be possible to make it say something other
 * than what would happen. Everything about the pane comes from the registry and the live URL, never from the
 * agent's arguments; the agent's own text is shown escaped (invisible and direction-changing characters spelled
 * out), with its true length, and cut at {@link PREVIEW_MAX_CHARS}. Pure (ADR-0001).
 */
import { escapeForConfirm } from '../terminal-confirm-text'
import type { OriginClass } from './origin-class'

/** The most characters of an expression, typed text or value the confirm shows. */
export const PREVIEW_MAX_CHARS = 200

export interface LeaseConfirmFacts {
  op: string
  args: Record<string, unknown>
  paneName: string
  /** The leading part of the pane id, enough to tell two panes in a folder apart. */
  shortPaneId: string
  openedBy: 'agent' | 'operator'
  /** `host[:port]` of the live page (no path, no query), or `''`. */
  host: string
  originClass: OriginClass
  /** The folder, already shortened for display (`~/…`). */
  folder: string
  /** Role and name of the element a `click`/`type` targets, when it could be resolved. */
  target?: { role: string; name: string } | null
  /**
   * Best-effort secret scrubber for the agent's text and the page's element names (the audit's own, so the confirm
   * and the log never differ). Absent = shown as is.
   */
  scrub?: (text: string) => string
}

/** `text` escaped and cut for display, with its true length. */
function preview(text: string, scrub?: (t: string) => string): string {
  const trueLength = [...text].length
  // Scrubbed FIRST and over the whole text, so the cut can never leave half a secret (the audit does the same).
  const clean = [...(scrub && text !== '' ? scrub(text) : text)]
  const cut = clean.length > PREVIEW_MAX_CHARS
  const shown = escapeForConfirm(clean.slice(0, PREVIEW_MAX_CHARS).join(''))
  return `(${trueLength} characters): "${shown}"${cut ? '…' : ''}`
}

function targetLabel(f: LeaseConfirmFacts): string {
  const ref = typeof f.args.ref === 'string' ? f.args.ref : '?'
  if (!f.target) return `element ${escapeForConfirm(ref)}`
  const name = f.scrub ? f.scrub(f.target.name) : f.target.name
  return `${escapeForConfirm(f.target.role)} "${escapeForConfirm(name).slice(0, PREVIEW_MAX_CHARS)}" (${escapeForConfirm(ref)})`
}

/** One line: the first thing the call would do. */
export function describeFirstAction(f: LeaseConfirmFacts): string {
  const a = f.args
  switch (f.op) {
    case 'browser_eval':
      return `eval ${preview(typeof a.expression === 'string' ? a.expression : '', f.scrub)}`
    case 'browser_click': {
      const n = typeof a.clickCount === 'number' && a.clickCount > 1 ? ` x${a.clickCount}` : ''
      const b =
        typeof a.button === 'string' && a.button !== 'left'
          ? ` (${escapeForConfirm(a.button)} button)`
          : ''
      return `click ${targetLabel(f)}${n}${b}`
    }
    case 'browser_type':
      return `type ${preview(typeof a.text === 'string' ? a.text : '', f.scrub)}${typeof a.ref === 'string' ? ` into ${targetLabel(f)}` : ' into the focused element'}${a.submit === true ? ', then press Enter' : ''}`
    case 'browser_fill': {
      const fields = Array.isArray(a.fields) ? (a.fields as Array<Record<string, unknown>>) : []
      const first = fields[0]
      return `fill ${fields.length} field${fields.length === 1 ? '' : 's'}${first ? `; the first value ${preview(typeof first.value === 'string' ? first.value : '', f.scrub)}` : ''}`
    }
    case 'browser_press': {
      const keys = Array.isArray(a.keys) ? (a.keys as unknown[]).map(String) : []
      const shown = keys.slice(0, 12).map(escapeForConfirm).join(', ')
      return `press ${keys.length} key${keys.length === 1 ? '' : 's'}: ${shown}${keys.length > 12 ? ', …' : ''}`
    }
    case 'browser_navigate':
      return typeof a.url === 'string'
        ? `go to ${escapeForConfirm(hostOf(a.url))}`
        : `navigate (${escapeForConfirm(String(a.action ?? ''))})`
    case 'browser_network':
      return `${escapeForConfirm(String(a.action ?? 'read'))} network traffic recording`
    case 'browser_close':
      return 'close this pane'
    default:
      return escapeForConfirm(f.op.replace(/^browser_/, ''))
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return '(an address)'
  }
}

/** The full prompt text of a lease confirm. */
export function leaseConfirmPrompt(f: LeaseConfirmFacts): string {
  const site = f.host === '' ? '(nothing loaded)' : `${escapeForConfirm(f.host)} (${f.originClass})`
  return (
    `An agent wants to drive a browser pane.\n\n` +
    `Pane: ${escapeForConfirm(f.paneName)} (${escapeForConfirm(f.shortPaneId)})\n` +
    `Opened by: ${f.openedBy}\n` +
    `Site: ${site}\n` +
    `Folder: ${escapeForConfirm(f.folder)}\n\n` +
    `The first thing it would do:\n  ${describeFirstAction(f)}\n\n` +
    `Allow lets agents drive this pane while it stays on ${site === '(nothing loaded)' ? 'this page' : escapeForConfirm(f.host)}, until it has had no agent write for 10 minutes. ` +
    `If the pane moves to another site, this approval ends and you are asked again. ` +
    `The permission belongs to the pane, not to the agent that asked. ` +
    `Nothing happens when you Allow: the agent is told to look at the page and call again. ` +
    `What an agent types runs as you on this page. ` +
    `Deny blocks writes to this pane for 5 minutes.`
  )
}
