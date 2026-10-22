/**
 * What a browser verb's ARGUMENTS may contain (T564 U1, spec §6.3 "BAD_ARGS / content refusals"): the
 * exactly-one-form rule, the forms and options that are not available yet, and the URL scheme policy. Pure.
 *
 * These refusals are judged at PLAN level (`access.ts` calls this), in the documented order: after the pane is
 * known and not disconnected, but BEFORE the kill-switch, Pause, the tier and any confirm. So in "Ask before
 * agent actions" mode a call that can never succeed never raises a confirm, and with the kill-switch off a
 * `javascript:` URL is still told what is wrong with it.
 */
import { checkTopLevelNavigation, URL_SCHEME_BLOCKED } from './nav-policy'
import { checkPageContentSize } from './page-content'

export type ContentCode =
  'BAD_ARGS' | typeof URL_SCHEME_BLOCKED | 'NOT_YET_AVAILABLE' | 'DATA_TOO_LARGE' | 'HTML_TOO_LARGE'

export interface ContentRefusal {
  code: ContentCode
  /** What is wrong, for `BAD_ARGS` (rides in the plan result) and the audit. */
  detail: string
  /** `URL_SCHEME_BLOCKED`: the refused scheme. `NOT_YET_AVAILABLE`: the feature asked for. */
  scheme?: string
  feature?: string
  /** `DATA_TOO_LARGE` / `HTML_TOO_LARGE`: the cap that was exceeded, in bytes. */
  limitBytes?: number
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
  return null
}

/** A `harnu-page://` address is Harnu's own: a project file is opened with `path`, never by address. */
function checkNotPageAddress(url: string, hint: string): ContentRefusal | null {
  const verdict = checkTopLevelNavigation(url, 'verb')
  if (verdict.ok && new URL(verdict.url).protocol === 'harnu-page:') {
    return { code: 'BAD_ARGS', detail: hint }
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
    if (args.device !== undefined) {
      return { code: 'NOT_YET_AVAILABLE', detail: 'device', feature: 'Device emulation' }
    }
    // The `path` and `html` forms open one of our own page files (T569 U2); the jail and the size cap are the verb's.
    if (args.path !== undefined || args.html !== undefined) return checkPageContentSize(op, args)
    const bad = checkUrl(str(args.url) ?? '')
    if (bad) return bad
    return checkNotPageAddress(
      str(args.url) ?? '',
      'Open a project file with `path` (or `html` and `name`), not a harnu-page address.'
    )
  }
  if (op === 'browser_navigate') {
    if ((args.url === undefined) === (args.action === undefined)) {
      return { code: 'BAD_ARGS', detail: 'Pass exactly one of `url` or `action`.' }
    }
    if (args.url === undefined) return null
    const bad = checkUrl(str(args.url) ?? '')
    if (bad) return bad
    return checkNotPageAddress(
      str(args.url) ?? '',
      'browser_navigate takes http(s) addresses. Open a project file with browser_open({ path }).'
    )
  }
  if (op === 'browser_set_data' || op === 'browser_patch') return checkPageContentSize(op, args)
  return null
}
