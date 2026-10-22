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
import { checkEmulateArgs, isPresetName, DEVICE_PRESET_NAMES } from '../../shared/browser-emulation'
import type { EmulateArgs } from '../../shared/browser-emulation'
import { checkTopLevelNavigation, URL_SCHEME_BLOCKED } from './nav-policy'
import { checkUploadArgs } from './upload-plan'
import { escapeForAudit } from '../terminal-keys'
import * as path from 'node:path'
import { checkPageContentSize } from './page-content'
import { isDeniedPagePath, isPatchModeNeedingHtml } from './page-content-rules'

export type ContentCode =
  | 'BAD_ARGS'
  | typeof URL_SCHEME_BLOCKED
  | 'NOT_YET_AVAILABLE'
  | 'BROWSER_KEY_UNKNOWN'
  | 'ZOOM_IN_DEVICE_MODE'
  | 'UPLOAD_PATH_DENIED'
  | 'DATA_TOO_LARGE'
  | 'HTML_TOO_LARGE'
  | 'PATH_NOT_ALLOWED'

/** What the plan layer knows about the addressed pane that a content rule depends on (T572). */
export interface ContentContext {
  /** The pane emulates a device right now (the registry's emulation record). */
  deviceActive?: boolean
}

export interface ContentRefusal {
  code: ContentCode
  /** What is wrong, for `BAD_ARGS` (rides in the plan result) and the audit. */
  detail: string
  /** `URL_SCHEME_BLOCKED`: the refused scheme. `NOT_YET_AVAILABLE`: the feature asked for. */
  scheme?: string
  feature?: string
  /** `DATA_TOO_LARGE` / `HTML_TOO_LARGE`: the cap that was exceeded, in bytes. */
  limitBytes?: number
  /** `PATH_NOT_ALLOWED`: which jail rule refused. */
  jailReason?: string
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

/**
 * The part of the path jail that needs no disk (F6): a NUL, a relative path that climbs out of the folder, and
 * `.git` / `.harnu/memory` at any depth. An ABSOLUTE path that is not under the folder as spelled is left to the
 * verb, which `realpath`s both sides (the folder may be reached through a symlink).
 */
export function checkOpenPathLexically(
  folder: string | undefined,
  rawPath: string
): ContentRefusal | null {
  const refuse = (jailReason: string): ContentRefusal => ({
    code: 'PATH_NOT_ALLOWED',
    detail: jailReason,
    jailReason
  })
  if (rawPath.includes('\0')) return refuse('bad-path')
  if (folder === undefined || folder === '') return null
  const inFolder = path.isAbsolute(rawPath) ? path.normalize(rawPath) : path.join(folder, rawPath)
  const rel = path.relative(folder, inFolder)
  const outside = rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)
  if (outside) return path.isAbsolute(rawPath) ? null : refuse('escape')
  if (rel === '') return null
  if (isDeniedPagePath(rel.split(path.sep))) return refuse('denied-path')
  return null
}

/** The refusal for a call's arguments, or `null` when the content is fine. Verbs with no content rule pass. */
export function checkBrowserContent(
  op: string,
  args: Record<string, unknown>,
  ctx: ContentContext = {}
): ContentRefusal | null {
  if (op === 'browser_open') {
    const forms = [args.url, args.path, args.html].filter((v) => v !== undefined).length
    if (forms !== 1) {
      return { code: 'BAD_ARGS', detail: 'Pass exactly one of `url`, `path` or `html`.' }
    }
    if (args.device !== undefined && !isPresetName(args.device)) {
      return {
        code: 'BAD_ARGS',
        detail: `\`device\` is one of ${DEVICE_PRESET_NAMES.join(', ')}.`
      }
    }
    // The `path` and `html` forms open one of our own page files (T569 U2). What can be judged from the arguments
    // is judged HERE, before any confirm (F6); the realpath half of the jail (symlinks) is the verb's.
    if (args.html !== undefined) {
      if (typeof args.name !== 'string' || args.name.trim() === '') {
        return { code: 'BAD_ARGS', detail: '`html` needs a `name` for the panel file.' }
      }
    }
    if (typeof args.path === 'string') {
      const bad = checkOpenPathLexically(str(args.folder), args.path)
      if (bad) return bad
    }
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
  if (op === 'browser_emulate') {
    const refusal = checkEmulateArgs(args as EmulateArgs, {
      deviceActive: ctx.deviceActive === true
    })
    return refusal ? { code: refusal.code, detail: refusal.detail } : null
  }
  if (op === 'browser_upload') {
    const refusal = checkUploadArgs(args)
    return refusal
      ? {
          code: refusal.code === 'BAD_ARGS' ? 'BAD_ARGS' : 'UPLOAD_PATH_DENIED',
          detail: refusal.detail
        }
      : null
  }
  if (op === 'browser_download') {
    if ((args.url === undefined) === (args.ref === undefined)) {
      return { code: 'BAD_ARGS', detail: 'Pass exactly one of `url` or `ref`.' }
    }
    if (args.url !== undefined) {
      const url = str(args.url) ?? ''
      let protocol = ''
      try {
        protocol = new URL(url).protocol
      } catch {
        return { code: 'BAD_ARGS', detail: '`url` is not a valid address.' }
      }
      // A download fetches over the network: http(s) only, whatever a navigation may open.
      if (protocol !== 'http:' && protocol !== 'https:') {
        return {
          code: URL_SCHEME_BLOCKED,
          detail: `scheme ${protocol.replace(/:$/, '') || '(none)'}`,
          scheme: protocol.replace(/:$/, '')
        }
      }
    }
    return null
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
  if (op === 'browser_patch') {
    // Every mode but `remove` needs the markup to put in (F6).
    if (
      typeof args.mode === 'string' &&
      isPatchModeNeedingHtml(args.mode) &&
      args.html === undefined
    ) {
      return { code: 'BAD_ARGS', detail: `mode "${args.mode}" needs \`html\`.` }
    }
  }
  if (op === 'browser_set_data' || op === 'browser_patch') return checkPageContentSize(op, args)
  return null
}
