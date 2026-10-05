/**
 * Option+click a path in a transcript → reveal it in the Explorer pane.
 *
 * This module is the terminal half of that feature: it finds path-SHAPED tokens
 * on a line and (later, in `registerFileLinkProvider`) turns the ones that
 * really exist into xterm links. It deliberately knows nothing about the
 * filesystem — existence, root-confinement and gitignore are decided by the
 * main process (`explorer:resolve`), so this file stays pure and unit-testable.
 */

/** One path-shaped token found on a terminal line. */
export interface PathCandidate {
  /**
   * The RESOLVABLE path: trailing punctuation and any `:line[:col]` suffix
   * stripped. This is what gets sent to `explorer:resolve`.
   */
  text: string
  /** 0-based index of the token's first character in the source line. */
  start: number
  /**
   * Exclusive end index covering the token as DISPLAYED — it includes a
   * `:42:7` suffix (so the underline covers the line number the user sees) but
   * excludes trailing sentence punctuation.
   */
  end: number
}

/**
 * Characters that can never be part of a path token on a terminal line.
 * Whitespace plus the quoting/bracketing characters Claude wraps paths in.
 */
const TOKEN = /[^\s"'`()[\]{}<>,;|]+/g

/** Sentence punctuation to shave off a token's tail before anything else. */
const TRAILING_PUNCT = /[.,;:!?]+$/

/** A `:42` or `:42:7` line/column suffix at the end of a token. */
const LINE_COL = /:\d+(?::\d+)?$/

/** `scheme://` — a URL, which `WebLinksAddon` already linkifies. */
const URI_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i

/**
 * Extract every path-shaped token from one line of terminal text.
 *
 * Matching is deliberately PERMISSIVE — `and/or` comes back as a candidate.
 * The authoritative filter is existence + root-confinement in the main process;
 * being strict here would only cost us real paths. The one shape rule we do
 * enforce is that a token must carry a separator, because a bare basename
 * (`pty.ts` in prose) cannot be resolved without a search.
 */
export function extractPathCandidates(line: string): PathCandidate[] {
  const out: PathCandidate[] = []
  if (!line) return out
  TOKEN.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TOKEN.exec(line)) !== null) {
    const start = m.index
    const displayed = m[0].replace(TRAILING_PUNCT, '')
    if (displayed.length < 2) continue
    if (URI_SCHEME.test(displayed)) continue
    const text = displayed.replace(LINE_COL, '')
    if (text.length < 2) continue
    if (!/[/\\]/.test(text)) continue
    out.push({ text, start, end: start + displayed.length })
  }
  return out
}

import type { IBuffer, ILink, ILinkProvider, Terminal } from '@xterm/xterm'
import type { ResolvedPath } from '../../../preload'

/**
 * A wrapped logical line, stitched back into one string, with a row and column
 * recorded for EVERY character index so a match's offsets can be mapped back to
 * xterm buffer coordinates.
 */
export interface LogicalLine {
  text: string
  /** 1-based absolute buffer row for each index of `text`. */
  rows: number[]
  /** 1-based column for each index of `text`. */
  cols: number[]
}

/**
 * Read the full logical line containing the 1-based absolute buffer row
 * `bufferLineNumber`, following xterm's `isWrapped` chain up and down.
 *
 * Cells are read one at a time rather than via `translateToString` because a
 * cell may hold several characters (combining marks) or occupy two columns (a
 * wide CJK glyph or emoji) — a plain string translation loses the mapping and
 * would underline the wrong cells. The per-character `rows`/`cols` arrays are
 * that mapping.
 */
export function readLogicalLine(buffer: IBuffer, bufferLineNumber: number): LogicalLine | null {
  if (!buffer.getLine(bufferLineNumber - 1)) return null

  // Walk up to the first row of the logical line.
  let first = bufferLineNumber
  while (first > 1 && buffer.getLine(first - 1)?.isWrapped) first--

  const text: string[] = []
  const rows: number[] = []
  const cols: number[] = []
  for (let y = first; ; y++) {
    const line = buffer.getLine(y - 1)
    if (!line) break
    if (y !== first && !line.isWrapped) break
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x)
      if (!cell) continue
      // Width 0 is the trailing half of a wide glyph — it carries no chars.
      if (cell.getWidth() === 0) continue
      const chars = cell.getChars() || ' '
      for (const ch of chars) {
        text.push(ch)
        rows.push(y)
        cols.push(x + 1)
      }
    }
  }
  return { text: text.join(''), rows, cols }
}

/** Everything the provider needs from its host, injected so it stays testable. */
export interface FileLinkContext {
  /** Absolute project root links are confined to (the Explorer pane's root). */
  root(): string
  /** Absolute cwd relative paths resolve against. */
  cwd(): string
  /** Is Option/Alt currently held? Links only exist while it is. */
  isAltHeld(): boolean
  /** Existence + confinement + gitignore gate (`window.api.explorerResolve`). */
  resolve(root: string, cwd: string, candidates: string[]): Promise<ResolvedPath[]>
  /** Option+click landed on a resolved entry. */
  onReveal(path: string, isDir: boolean): void
}

/** Bound on the per-line resolution cache. Small — it only has to cover the
 *  lines a pointer sweeps across, and stale entries must expire cheaply. */
const CACHE_LIMIT = 200

/**
 * How long a resolved reply stays valid before a re-hover re-resolves it.
 * Short enough that a file Claude only just created shows up as a link soon
 * after (a negative reply — "doesn't exist yet" — would otherwise be cached
 * for the terminal's entire lifetime); long enough that sweeping the pointer
 * back and forth across one line doesn't re-issue the IPC call on every
 * `mousemove`.
 */
const CACHE_TTL_MS = 2000

/**
 * Build the xterm link provider that turns transcript paths into option+click
 * targets.
 *
 * Two deliberate behaviours:
 *
 *  - **Nothing is provided unless Option is held.** Underlining every path
 *    while the operator reads output would be noise, so the affordance is the
 *    IDE one: hold the modifier, the paths under the pointer light up.
 *  - **`activate` re-checks `altKey`.** xterm calls `activate` on any click of
 *    a link it currently knows about; the modifier check is ours to make.
 */
export function createFileLinkProvider(term: Terminal, ctx: FileLinkContext): ILinkProvider {
  // Keyed by root + cwd + the line's text, so an identical line resolves once
  // — until its entry expires (`CACHE_TTL_MS`), so a negative reply isn't
  // permanent.
  const cache = new Map<string, { promise: Promise<ResolvedPath[]>; expiresAt: number }>()

  function resolveCached(
    root: string,
    cwd: string,
    line: string,
    texts: string[]
  ): Promise<ResolvedPath[]> {
    const key = `${root}\u0000${cwd}\u0000${line}`
    const now = Date.now()
    const hit = cache.get(key)
    if (hit && hit.expiresAt > now) return hit.promise
    const p = ctx.resolve(root, cwd, texts).catch(() => [] as ResolvedPath[])
    cache.set(key, { promise: p, expiresAt: now + CACHE_TTL_MS })
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string)
    return p
  }

  // The Alt tracker's resync (below) dispatches a decoy `mousemove` at an
  // off-row position purely to force xterm's internal state to change, ahead
  // of the real dispatch at the pointer's actual position. That decoy is a
  // genuine `provideLinks` call for a genuine (if uninteresting) row, and its
  // async `resolve` can still be in flight when the real dispatch's own call
  // resolves — or even resolve AFTER it. xterm keys its per-provider reply
  // cache by provider index, not by row, so a late decoy reply would clobber
  // the real row's correct one. `latestRequestId` makes each call check, once
  // its resolve returns, whether a NEWER call has since been made on this same
  // provider — if so, this one is stale and answers "no links" instead of
  // racing the newer call's reply.
  let latestRequestId = 0

  return {
    provideLinks(bufferLineNumber, callback): void {
      const requestId = ++latestRequestId
      if (!ctx.isAltHeld()) {
        callback(undefined)
        return
      }
      const root = ctx.root()
      const cwd = ctx.cwd()
      if (!root || !cwd) {
        callback(undefined)
        return
      }

      const logical = readLogicalLine(term.buffer.active, bufferLineNumber)
      if (!logical) {
        callback(undefined)
        return
      }
      const candidates = extractPathCandidates(logical.text)
      if (candidates.length === 0) {
        callback(undefined)
        return
      }

      const texts = [...new Set(candidates.map((c) => c.text))]
      void resolveCached(root, cwd, logical.text, texts).then((resolved) => {
        if (requestId !== latestRequestId) {
          // Superseded by a newer `provideLinks` call on this provider — drop
          // this reply WITHOUT calling `callback` at all. Calling it with
          // `undefined` would make xterm null out `_activeProviderReplies` for
          // the current (real) reply that has already landed, breaking a
          // later hover onto a second path on the same row until the pointer
          // leaves and re-enters. xterm has no timeout on an unanswered ask,
          // and the superseded ask's own reply map is already discarded, so
          // silence here is safe.
          return
        }
        const byText = new Map(resolved.map((r) => [r.text, r]))
        const links: ILink[] = []
        for (const c of candidates) {
          const hit = byText.get(c.text)
          if (!hit) continue
          const lastIndex = c.end - 1
          if (logical.rows[c.start] === undefined || logical.rows[lastIndex] === undefined) continue
          links.push({
            text: logical.text.slice(c.start, c.end),
            range: {
              start: { x: logical.cols[c.start], y: logical.rows[c.start] },
              // xterm's range end is INCLUSIVE of the last cell.
              end: { x: logical.cols[lastIndex], y: logical.rows[lastIndex] }
            },
            activate: (event: MouseEvent): void => {
              if (!event.altKey) return
              ctx.onReveal(hit.path, hit.isDir)
            }
          })
        }
        callback(links.length > 0 ? links : undefined)
      })
    }
  }
}

// ── Alt tracker ─────────────────────────────────────────────────────────────
// xterm only re-runs link providers on `mousemove`, and only when the buffer
// cell or active line actually changes — so pressing or releasing Option with
// a still pointer would leave the underline stale (see `resyncHoveredLink`
// below for exactly which xterm internals make this true). One shared,
// ref-counted tracker watches the modifier at the window level and forces a
// two-step synthetic `mousemove` (decoy row, then the real position) to make
// that state genuinely change and re-trigger a real link scan. Shared because
// `LiveTerminal`s outlive the components that host them — a per-component
// tracker would be captured dead after a remount.

let altRefCount = 0
let altHeld = false
let lastClientX = 0
let lastClientY = 0
let altListeners: (() => void) | null = null
// Set for the duration of the two-dispatch resync below. Without this, the
// decoy dispatch's own `mousemove` — which bubbles through `document` exactly
// like a real one — is picked up by `onMove` and overwrites `lastClientX`/
// `lastClientY` with the decoy's coordinates BEFORE the "real" dispatch reads
// them, so both events land at the decoy position and the pointer's actual
// row is never re-scanned. Confirmed empirically in jsdom with an attached
// target: `seen: [decoyY, decoyY]`.
let suppressPositionTracking = false

function dispatchSyntheticMove(target: Element, clientX: number, clientY: number): void {
  target.dispatchEvent(
    new MouseEvent('mousemove', { clientX, clientY, altKey: altHeld, bubbles: true })
  )
}

/**
 * xterm's own mousemove handler is a no-op when an event lands on the SAME
 * buffer cell it last saw (`_lastBufferCell` short-circuit in its internal
 * `_handleMouseMove`), and even when the cell genuinely differs, a hover with
 * `_activeLine` unchanged only re-inspects the cached provider replies rather
 * than calling `provideLinks` again. So re-dispatching a single `mousemove` at
 * the unchanged last-known pointer position — which is what pressing/releasing
 * Option with a still pointer requires — never reaches `provideLinks`: no
 * underline appears, and a click at that moment never reaches `activate`.
 *
 * Force a genuine transition instead: dispatch at a decoy row clearly off the
 * current one first, then the real position — reading BOTH clientX/clientY
 * into locals up front and suppressing `onMove` for the duration, so the
 * decoy's own bubbled event can't clobber the coordinates the real dispatch
 * uses (see `suppressPositionTracking` above).
 *
 * The decoy's direction is chosen relative to the target's OWN bounding box,
 * not a fixed pixel offset from the pointer: xterm clamps the row it computes
 * to `[1, rows]` (`getCoords`), so a decoy a fixed distance ABOVE the pointer
 * clamps right back to row 1 when the pointer is already on the terminal's
 * first visible row (and a fixed distance BELOW does the same at the last
 * row) — a no-op at exactly the rows most likely to be hovered. Aiming for
 * whichever edge of the target's box is farthest from the pointer's own
 * position instead can only coincide with the pointer's own row if the
 * terminal is a single row tall, which never happens in practice.
 */
function resyncHoveredLink(): void {
  const clientX = lastClientX
  const clientY = lastClientY
  const target = document.elementFromPoint(clientX, clientY)
  if (!target) return
  const rect = target.getBoundingClientRect()
  const nearTop = clientY - rect.top < (rect.height || 1) / 2
  const DECOY_MARGIN_PX = 50
  const decoyY = nearTop ? rect.bottom + DECOY_MARGIN_PX : rect.top - DECOY_MARGIN_PX

  suppressPositionTracking = true
  try {
    dispatchSyntheticMove(target, clientX, decoyY)
    dispatchSyntheticMove(target, clientX, clientY)
  } finally {
    suppressPositionTracking = false
  }
}

function installAltListeners(): () => void {
  const onMove = (e: MouseEvent): void => {
    if (suppressPositionTracking) return
    lastClientX = e.clientX
    lastClientY = e.clientY
  }
  const onKey = (e: KeyboardEvent): void => {
    const held = e.altKey
    if (held === altHeld) return
    altHeld = held
    resyncHoveredLink()
  }
  const onBlur = (): void => {
    if (!altHeld) return
    altHeld = false
    resyncHoveredLink()
  }
  document.addEventListener('mousemove', onMove, true)
  window.addEventListener('keydown', onKey, true)
  window.addEventListener('keyup', onKey, true)
  window.addEventListener('blur', onBlur)
  return () => {
    document.removeEventListener('mousemove', onMove, true)
    window.removeEventListener('keydown', onKey, true)
    window.removeEventListener('keyup', onKey, true)
    window.removeEventListener('blur', onBlur)
    altHeld = false
  }
}

/** Acquire the shared Option-held tracker. Release when the terminal goes. */
export function acquireAltTracker(): { isAltHeld(): boolean; release(): void } {
  if (altRefCount === 0) altListeners = installAltListeners()
  altRefCount++
  let released = false
  return {
    isAltHeld: () => altHeld,
    release(): void {
      if (released) return
      released = true
      altRefCount--
      if (altRefCount === 0 && altListeners) {
        altListeners()
        altListeners = null
      }
    }
  }
}

/**
 * Register the file-link provider on `term`, wiring in the shared Option
 * tracker. Returns a disposer that unregisters the provider AND releases the
 * tracker — push it onto the terminal's cleanup list.
 */
export function registerFileLinkProvider(
  term: Terminal,
  ctx: Omit<FileLinkContext, 'isAltHeld'>
): () => void {
  const tracker = acquireAltTracker()
  const disposable = term.registerLinkProvider(
    createFileLinkProvider(term, { ...ctx, isAltHeld: tracker.isAltHeld })
  )
  return () => {
    disposable.dispose()
    tracker.release()
  }
}
