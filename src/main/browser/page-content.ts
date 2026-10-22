/**
 * Content refusals of the page verbs that can be judged from the call's arguments alone (T564 U2, spec §6.3).
 * They run in the PLAN-level gate, before the kill-switch and before any confirm in `ask` mode, so a refusal
 * never fires after the operator was asked about a call that could not have run.
 */
import type { ContentRefusal } from './content-check'
import { MAX_DATA_BYTES } from './page-state'
import { MAX_PATCH_HTML_BYTES } from './page-patch'

/** `browser_open({ html })` writes a panel file; the page is capped (spec §5.1). */
export const MAX_PANEL_HTML_BYTES = 256 * 1024

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

function tooLarge(code: 'DATA_TOO_LARGE' | 'HTML_TOO_LARGE', limitBytes: number): ContentRefusal {
  return { code, detail: `over ${limitBytes} bytes`, limitBytes }
}

/**
 * The size refusal for `op` called with `args`, or `null`. Unknown shapes are left to the verb's own checks.
 * `content-check.ts` calls this as part of the one plan-level content check.
 */
export function checkPageContentSize(
  op: string,
  args: Record<string, unknown>
): ContentRefusal | null {
  if (op === 'browser_set_data' && 'data' in args && args.data !== undefined) {
    try {
      const json = JSON.stringify(args.data)
      if (json !== undefined && byteLength(json) > MAX_DATA_BYTES) {
        return tooLarge('DATA_TOO_LARGE', MAX_DATA_BYTES)
      }
    } catch {
      return null
    }
  }
  if (op === 'browser_patch' && typeof args.html === 'string') {
    if (byteLength(args.html) > MAX_PATCH_HTML_BYTES) {
      return tooLarge('HTML_TOO_LARGE', MAX_PATCH_HTML_BYTES)
    }
  }
  if (op === 'browser_open' && typeof args.html === 'string') {
    if (byteLength(args.html) > MAX_PANEL_HTML_BYTES) {
      return tooLarge('HTML_TOO_LARGE', MAX_PANEL_HTML_BYTES)
    }
  }
  return null
}
