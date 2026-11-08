/**
 * T2: the doc-reader gate as Harnu ships it. A plugin `PreToolUse` hook of `type: "http"` POSTs to
 * the loopback Hook Bridge, which answers with {@link answerDocReadHook}. Nothing runs a PATH
 * `node`, so a version-manager node that exits 127 can no longer make the gate fail open
 * silently (T1 spike finding).
 *
 * Fails open by construction: when Harnu is not running the POST is refused, and Claude Code
 * treats an http hook error as non-blocking, so the tool call goes ahead.
 */

import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { clampMinLines, decideDocRead, gateHookOutput } from './gate-core'

/** The catalog name of the feature, and the agent's name inside the `harnu` plugin. */
export const DOC_READER_FEATURE = 'doc-reader'
/** How the model is told to call the agent. Plugin agents are namespaced by the plugin. */
export const DOC_READER_AGENT = 'harnu:doc-reader'
/** The Hook Bridge route prefix: `POST /docread/<token>/<minLines>`. */
export const DOC_READER_ROUTE = 'docread'
/** Seconds Claude Code waits for the hook. The answer is a stat and a line count. */
export const DOC_READER_HOOK_TIMEOUT_S = 5

/**
 * The URL the staged hook POSTs to. The folder's threshold is baked into the path when the
 * session is staged, so the bridge holds no per-folder state and a threshold change reaches the
 * next session, like every other Settings → Skills change.
 */
export function docReaderHookUrl(port: number, token: string, minLines: number): string {
  return `http://127.0.0.1:${port}/${DOC_READER_ROUTE}/${token}/${clampMinLines(minLines)}`
}

/** The staged plugin's `hooks/hooks.json`. It carries the bridge token: never log it. */
export function docReaderHooksJson(port: number, token: string, minLines: number): string {
  return (
    JSON.stringify(
      {
        hooks: {
          PreToolUse: [
            {
              matcher: 'Read|Bash',
              hooks: [
                {
                  type: 'http',
                  url: docReaderHookUrl(port, token, minLines),
                  timeout: DOC_READER_HOOK_TIMEOUT_S
                }
              ]
            }
          ]
        }
      },
      null,
      2
    ) + '\n'
  )
}

/**
 * The feature's share of the staging `.stamp`. It changes with the bridge's port and token (every
 * Harnu boot) and with the threshold, so a stale hook pointing at a dead bridge is re-staged. The
 * token is hashed so the stamp never holds it.
 */
export function docReaderStampPart(port: number, token: string, minLines: number): string {
  const h = createHash('sha256').update(`${port}:${token}`).digest('hex').slice(0, 12)
  return `${DOC_READER_FEATURE}@${h}:${clampMinLines(minLines)}`
}

/** The threshold from the route's last path segment; anything malformed is the default. */
export function minLinesFromRoute(segment: string | undefined): number {
  return clampMinLines(segment !== undefined && /^\d+$/.test(segment) ? Number(segment) : NaN)
}

/** Files above this size are not counted; the gate lets them through. */
const MAX_COUNT_BYTES = 16 * 1024 * 1024

/** Newline count of a regular file (a last line without `\n` counts), or `null` when unreadable. */
export async function countFileLines(abs: string): Promise<number | null> {
  const fh = await open(abs, 'r').catch(() => null)
  if (!fh) return null
  try {
    const st = await fh.stat()
    if (!st.isFile() || st.size > MAX_COUNT_BYTES) return null
    const buf = await fh.readFile()
    let n = 0
    for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) n++
    if (buf.length > 0 && buf[buf.length - 1] !== 0x0a) n++
    return n
  } catch {
    return null
  } finally {
    await fh.close().catch(() => {})
  }
}

/**
 * The bridge's answer to one doc-reader hook POST: `{}` (allow) or the `PreToolUse` deny. Anything
 * that is not a doc read answers `{}` before touching the disk. Never throws.
 */
export async function answerDocReadHook(
  minLines: number,
  body: Record<string, unknown>,
  countLines: (abs: string) => Promise<number | null> = countFileLines
): Promise<string> {
  try {
    // decideDocRead is synchronous and counting is async: a first pass finds the one file it would
    // count, which happens only for a whole-doc read by the main thread; the real count decides.
    const seen: { abs?: string } = {}
    const probe = decideDocRead(body, {
      minLines,
      agentName: DOC_READER_AGENT,
      countLines: (abs) => {
        seen.abs = abs
        return Number.MAX_SAFE_INTEGER // "large": reaching here means it is a doc read
      }
    })
    if (probe.action === 'allow' || seen.abs === undefined) return '{}'
    const lines = await countLines(seen.abs)
    const decision = decideDocRead(body, {
      minLines,
      agentName: DOC_READER_AGENT,
      countLines: () => lines
    })
    return gateHookOutput(decision)
  } catch {
    return '{}'
  }
}
