/**
 * What a browser verb's ARGUMENTS may contain (T564 U1, spec §6.3 "BAD_ARGS / content refusals"): the
 * exactly-one-form rule, the forms and options that are not available yet, and the URL scheme policy. Pure.
 *
 * These refusals are judged at PLAN level (`access.ts` calls this), in the documented order: after the pane is
 * known and not disconnected, but BEFORE the kill-switch, Pause, the tier and any confirm. So in "Ask before
 * agent actions" mode a call that can never succeed never raises a confirm, and with the kill-switch off a
 * `javascript:` URL is still told what is wrong with it.
 */
import { PRESS_KEY_NAMES, firstUnknownKey } from './cdp-keys'
import { checkTopLevelNavigation, URL_SCHEME_BLOCKED } from './nav-policy'
import { escapeForAudit } from '../terminal-keys'

export type ContentCode =
  'BAD_ARGS' | typeof URL_SCHEME_BLOCKED | 'NOT_YET_AVAILABLE' | 'BROWSER_KEY_UNKNOWN'

export interface ContentRefusal {
  code: ContentCode
  /** What is wrong, for `BAD_ARGS` (rides in the plan result) and the audit. */
  detail: string
  /** `URL_SCHEME_BLOCKED`: the refused scheme. `NOT_YET_AVAILABLE`: the feature asked for. */
  scheme?: string
  feature?: string
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

/** The URL half shared by `browser_open` and `browser_navigate`. */
function checkUrl(url: string): ContentRefusal | null {
  const verdict = checkTopLevelNavigation(url, 'verb')
  if (!verdict.ok) {
    return {
      code: URL_SCHEME_BLOCKED,
      detail: `scheme ${verdict.scheme || '(none)'}`,
      scheme: verdict.scheme
    }
  }
  // `harnu-page://` loads arrive with U2: until then no handler serves it.
  if (new URL(verdict.url).protocol === 'harnu-page:') {
    return {
      code: 'NOT_YET_AVAILABLE',
      detail: 'harnu-page',
      feature: 'Opening a harnu-page address'
    }
  }
  return null
}

/** The refusal for a call's arguments, or `null` when the content is fine. Verbs with no content rule pass. */
export function checkBrowserContent(
  op: string,
  args: Record<string, unknown>
): ContentRefusal | null {
  if (op === 'browser_open') {
    const forms = [args.url, args.path, args.html].filter((v) => v !== undefined).length
    if (forms !== 1) {
      return { code: 'BAD_ARGS', detail: 'Pass exactly one of `url`, `path` or `html`.' }
    }
    if (args.path !== undefined || args.html !== undefined) {
      return {
        code: 'NOT_YET_AVAILABLE',
        detail: 'path/html',
        feature: 'Opening a file or HTML in a browser pane'
      }
    }
    if (args.device !== undefined) {
      return { code: 'NOT_YET_AVAILABLE', detail: 'device', feature: 'Device emulation' }
    }
    return checkUrl(str(args.url) ?? '')
  }
  if (op === 'browser_navigate') {
    if ((args.url === undefined) === (args.action === undefined)) {
      return { code: 'BAD_ARGS', detail: 'Pass exactly one of `url` or `action`.' }
    }
    return args.url !== undefined ? checkUrl(str(args.url) ?? '') : null
  }
  if (op === 'browser_press') {
    const keys = Array.isArray(args.keys)
      ? args.keys.filter((k): k is string => typeof k === 'string')
      : []
    const bad = firstUnknownKey(keys)
    if (bad !== null) {
      // The name is untrusted text: quoted, escaped and cut, so it cannot pass for the rest of the message.
      const shown = [...bad].slice(0, 16)
      const quoted = `"${escapeForAudit(shown.join(''), true)}${[...bad].length > 16 ? '…' : ''}"`
      return {
        code: 'BROWSER_KEY_UNKNOWN',
        detail: `${quoted} is not a key. Use one of: ${PRESS_KEY_NAMES.join(', ')}.`
      }
    }
  }
  return null
}
