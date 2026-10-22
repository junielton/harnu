/**
 * The five reading verbs of unit U3 (T564, spec §6.1 rows 4–7 and 15): `browser_snapshot`, `browser_screenshot`,
 * `browser_console`, `browser_network` and `browser_wait_for`, as pure functions over injected dependencies.
 * The MCP handlers in `mcp/tool-handlers.ts` supply the real ones; the tests supply fakes.
 *
 * Every result is scrubbed with the `read_terminal` scrubber and carries the fixed untrusted-content note
 * (spec §7.6). Reads respect Disconnect and the operator-pane rule through the same `gate` the U1 verbs use.
 */
import {
  BROWSER_NOTE,
  ackBase,
  gate,
  originOf,
  refuse,
  refuseBadArgs,
  type BrowserHost,
  type BrowserVerbDeps,
  type Refusal
} from './verbs-core'
import { CONSOLE_LEVELS, type ConsoleLevel } from './console-buffer'
import { DEFAULT_CAPTURE_MINUTES, MAX_CAPTURE_MINUTES, type NetworkEntry } from './network-capture'
import { scrubUrl } from './origin-class'
import type { PaneReaders } from './pane-readers'
import {
  FULL_PAGE_MAX_HEIGHT,
  SCREENSHOT_DEFAULT_JPEG_QUALITY,
  SCREENSHOT_MAX_DIM,
  fullPageHeight,
  planScreenshot,
  rectFromQuad,
  type ShotPlan,
  type ViewMode
} from './screenshot-plan'
import { DEFAULT_MAX_NODES, MAX_NODES_CEILING, formatSnapshot, type AxNode } from './snapshot'
import {
  DEFAULT_WAIT_TIMEOUT_MS,
  MAX_WAIT_TIMEOUT_MS,
  compileUrlPattern,
  runWait,
  type WaitConditions
} from './wait-for'

/** A rectangle in CSS px. */
export interface CssRect {
  x: number
  y: number
  width: number
  height: number
}

export interface CaptureRequest {
  plan: ShotPlan
  format: 'png' | 'jpeg'
  quality: number
  maxDim: number
  /** The element's box in viewport CSS px: what `capturePage` is cropped to on a hidden view. */
  viewportRect?: CssRect
  /** The element's box (or the whole page) in document CSS px: the CDP `clip`. */
  documentRect?: CssRect
}

export interface CaptureResult {
  data: Uint8Array
  mime: 'image/png' | 'image/jpeg'
  width: number
  height: number
  clamped: boolean
}

/** What the view host adds for the reading verbs (`view-host.ts` implements it over Electron). */
export interface BrowserReadHost extends BrowserHost {
  readers(paneId: string): PaneReaders | undefined
  /** One CDP command against the pane; rejects when the command fails. */
  cdp(paneId: string, method: string, params?: object): Promise<unknown>
  viewMode(paneId: string): ViewMode | undefined
  /** Whether a device is being emulated (U5; always false before). */
  deviceMode(paneId: string): boolean
  capture(paneId: string, req: CaptureRequest): Promise<CaptureResult>
}

export interface BrowserReadDeps extends BrowserVerbDeps {
  host: BrowserReadHost
  sleep(ms: number): Promise<void>
  /** Write a screenshot under the folder's `.harnu/out/browser/shots/`; returns the repo-relative path. */
  saveShot(folder: string, data: Uint8Array, ext: 'png' | 'jpeg'): Promise<string>
  /**
   * Live-panel data for `browser_snapshot`'s `include: ['data']` (the U2 sidecar). Absent until U2 lands: the
   * snapshot then answers `data: null` with a note. One seam, so U2 wires it in one place.
   */
  pageData?(paneId: string): Promise<unknown>
}

/* ------------------------------------------------------------------------------------------------ */
/* Shared helpers                                                                                     */
/* ------------------------------------------------------------------------------------------------ */

interface ReadCtx {
  paneId: string
  folder: string
  readers: PaneReaders
  ack: Record<string, unknown>
}

/** Gate a pane-addressed read and build the common ACK fields; a refusal comes back as `{ refusal }`. */
async function openRead(
  op: Parameters<typeof gate>[0],
  paneId: string,
  deps: BrowserReadDeps,
  action?: string
): Promise<{ refusal: Refusal } | { ctx: ReadCtx }> {
  const g = await gate(op, paneId, deps, action)
  if ('refusal' in g) return g
  const rec = g.rec!
  const readers = deps.host.readers(rec.paneId)
  // A record without a view is a pane that is mid-close.
  if (!readers || !g.live) return { refusal: refuse('PANE_NOT_FOUND', { folder: rec.folder }) }
  return {
    ctx: {
      paneId: rec.paneId,
      folder: rec.folder,
      readers,
      ack: ackBase(rec, g.live, g.origin ?? originOf(rec, g.live, deps))
    }
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Resolve a CSS selector on the main document to a DOM backend node id, or `null` if nothing matches. */
async function queryBackendNodeId(
  host: BrowserReadHost,
  paneId: string,
  selector: string
): Promise<number | null> {
  const doc = (await host.cdp(paneId, 'DOM.getDocument', { depth: 0 })) as {
    root?: { nodeId?: number }
  }
  const rootId = doc.root?.nodeId
  if (rootId === undefined) return null
  const hit = (await host.cdp(paneId, 'DOM.querySelector', { nodeId: rootId, selector })) as {
    nodeId?: number
  }
  if (!hit.nodeId) return null
  const described = (await host.cdp(paneId, 'DOM.describeNode', { nodeId: hit.nodeId })) as {
    node?: { backendNodeId?: number }
  }
  return described.node?.backendNodeId ?? null
}

/** An invalid CSS selector is the caller's mistake, not a missing element. */
function isSelectorSyntaxError(err: unknown): boolean {
  return /not a valid selector|syntaxerror|is not a valid/i.test(errorText(err))
}

/* ------------------------------------------------------------------------------------------------ */
/* browser_snapshot                                                                                   */
/* ------------------------------------------------------------------------------------------------ */

export interface SnapshotArgs {
  paneId: string
  selector?: string
  interactiveOnly?: boolean
  maxNodes?: number
  include?: string[]
  frames?: boolean
}

const MAX_FRAMES_READ = 10

async function readAxNodes(
  host: BrowserReadHost,
  paneId: string,
  frameId?: string
): Promise<AxNode[]> {
  const params = frameId ? { frameId } : {}
  let res = (await host.cdp(paneId, 'Accessibility.getFullAXTree', params)) as { nodes?: AxNode[] }
  if (!res.nodes || res.nodes.length === 0) {
    // Some pages only answer once the domain is on.
    await host.cdp(paneId, 'Accessibility.enable', {}).catch(() => undefined)
    res = (await host.cdp(paneId, 'Accessibility.getFullAXTree', params)) as { nodes?: AxNode[] }
  }
  return res.nodes ?? []
}

/** Frame url by id, from `Page.getFrameTree`. */
async function frameUrls(host: BrowserReadHost, paneId: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const res = (await host.cdp(paneId, 'Page.getFrameTree', {})) as {
    frameTree?: FrameTreeNode
  }
  const walk = (n: FrameTreeNode | undefined): void => {
    if (!n) return
    if (n.frame?.id && n.frame.url) out.set(n.frame.id, n.frame.url)
    for (const c of n.childFrames ?? []) walk(c)
  }
  walk(res.frameTree)
  return out
}
interface FrameTreeNode {
  frame?: { id?: string; url?: string }
  childFrames?: FrameTreeNode[]
}

export async function snapshotVerb(
  args: SnapshotArgs,
  deps: BrowserReadDeps
): Promise<Record<string, unknown>> {
  const opened = await openRead('browser_snapshot', args.paneId, deps)
  if ('refusal' in opened) return opened.refusal
  const { ctx } = opened
  const host = deps.host

  if (args.maxNodes !== undefined && (args.maxNodes < 1 || args.maxNodes > MAX_NODES_CEILING)) {
    return refuseBadArgs(`\`maxNodes\` must be between 1 and ${MAX_NODES_CEILING}.`)
  }
  deps.registry.touch(ctx.paneId)

  try {
    let rootBackendNodeId: number | undefined
    if (args.selector !== undefined) {
      let found: number | null
      try {
        found = await queryBackendNodeId(host, ctx.paneId, args.selector)
      } catch (err) {
        if (isSelectorSyntaxError(err))
          return refuseBadArgs(`\`selector\` is not a valid CSS selector.`)
        throw err
      }
      if (found === null) return refuse('SELECTOR_NOT_FOUND', { selector: args.selector })
      rootBackendNodeId = found
    }

    const nodes = await readAxNodes(host, ctx.paneId)
    // Child frames: their host is always shown; their contents only when asked for (assumption A11).
    const frameHosts = new Map<number, string>()
    const frameTrees = new Map<number, AxNode[]>()
    const iframes = nodes.filter(
      (n) => n.role?.value === 'Iframe' && n.backendDOMNodeId !== undefined
    )
    if (iframes.length > 0) {
      const urls = await frameUrls(host, ctx.paneId).catch(() => new Map<string, string>())
      for (const n of iframes.slice(0, MAX_FRAMES_READ)) {
        const backendNodeId = n.backendDOMNodeId!
        try {
          const d = (await host.cdp(ctx.paneId, 'DOM.describeNode', { backendNodeId })) as {
            node?: { frameId?: string }
          }
          const frameId = d.node?.frameId
          const url = frameId ? urls.get(frameId) : undefined
          const hostName = url ? hostLabel(url) : ''
          if (hostName) frameHosts.set(backendNodeId, hostName)
          if (args.frames === true && frameId) {
            // A cross-process frame refuses this call and stays opaque (follow-up: Target.setAutoAttach).
            const inner = await readAxNodes(host, ctx.paneId, frameId).catch(() => [])
            if (inner.length > 0) frameTrees.set(backendNodeId, inner)
          }
        } catch {
          /* an iframe that cannot be described stays an opaque node */
        }
      }
    }

    const snapshotId = ctx.readers.refs.nextSnapshotId()
    const formatted = formatSnapshot(nodes, {
      snapshotId,
      interactiveOnly: args.interactiveOnly === true,
      maxNodes: args.maxNodes ?? DEFAULT_MAX_NODES,
      ...(rootBackendNodeId !== undefined ? { rootBackendNodeId } : {}),
      frameHosts,
      frameTrees
    })
    ctx.readers.refs.commit(snapshotId, formatted.refs)

    const wantsData = args.include?.includes('data') === true
    let data: unknown = undefined
    let dataNote: string | undefined
    if (wantsData) {
      const got = deps.pageData ? await deps.pageData(ctx.paneId).catch(() => undefined) : undefined
      data = got ?? null
      if (got === undefined) {
        dataNote =
          'Live-panel data is not available for this pane (it is not a live panel, or this build has none).'
      }
    }

    return {
      ...ctx.ack,
      snapshotId,
      text: deps.scrub(formatted.text),
      nodes: formatted.nodes,
      truncated: formatted.truncated,
      ...(formatted.rootMissing
        ? {
            note: 'The selector matched an element that is not in the accessibility tree (hidden or display:none).'
          }
        : {}),
      ...(wantsData ? { data, ...(dataNote ? { dataNote } : {}) } : {}),
      untrustedNote: BROWSER_NOTE,
      note: BROWSER_NOTE
    }
  } catch (err) {
    return refuse('PAGE_READ_FAILED', {
      detail: `the accessibility tree could not be read (${deps.scrub(errorText(err))})`
    })
  }
}

/** `iframe [host]` label: the host of a frame URL, or `''`. */
function hostLabel(url: string): string {
  try {
    const u = new URL(url)
    return u.protocol === 'about:' ? '' : u.host
  } catch {
    return ''
  }
}

/* ------------------------------------------------------------------------------------------------ */
/* browser_screenshot                                                                                 */
/* ------------------------------------------------------------------------------------------------ */

export interface ScreenshotArgs {
  paneId: string
  ref?: string
  selector?: string
  fullPage?: boolean
  format?: 'png' | 'jpeg'
  quality?: number
  maxDim?: number
  save?: boolean
}

interface LayoutMetrics {
  cssContentSize?: { width?: number; height?: number }
  cssVisualViewport?: { pageX?: number; pageY?: number }
}

export async function screenshotVerb(
  args: ScreenshotArgs,
  deps: BrowserReadDeps
): Promise<Record<string, unknown>> {
  const opened = await openRead('browser_screenshot', args.paneId, deps)
  if ('refusal' in opened) return opened.refusal
  const { ctx } = opened
  const host = deps.host

  if (args.ref !== undefined && args.selector !== undefined) {
    return refuseBadArgs('Pass `ref` or `selector`, not both.')
  }
  if (args.fullPage === true && (args.ref !== undefined || args.selector !== undefined)) {
    return refuseBadArgs(
      '`fullPage` captures the whole page; do not combine it with `ref` or `selector`.'
    )
  }
  const maxDim = args.maxDim ?? SCREENSHOT_MAX_DIM
  if (!Number.isInteger(maxDim) || maxDim < 1 || maxDim > SCREENSHOT_MAX_DIM) {
    return refuseBadArgs(`\`maxDim\` must be an integer between 1 and ${SCREENSHOT_MAX_DIM}.`)
  }
  const format = args.format ?? 'png'
  const quality = args.quality ?? SCREENSHOT_DEFAULT_JPEG_QUALITY
  if (!Number.isInteger(quality) || quality < 1 || quality > 100) {
    return refuseBadArgs('`quality` must be an integer between 1 and 100.')
  }
  deps.registry.touch(ctx.paneId)

  const mode = host.viewMode(ctx.paneId)
  if (!mode) return refuse('PANE_NOT_FOUND', { folder: ctx.folder })
  const element = args.ref !== undefined || args.selector !== undefined
  const plan = planScreenshot({
    mode,
    fullPage: args.fullPage === true,
    element,
    deviceMode: host.deviceMode(ctx.paneId)
  })

  let viewportRect: CssRect | undefined
  let documentRect: CssRect | undefined
  let fullPageClamped = false
  try {
    if (element) {
      let backendNodeId: number | null
      if (args.ref !== undefined) {
        const r = ctx.readers.refs.resolve(args.ref)
        if (!r.ok) return refuse(r.error)
        backendNodeId = r.backendNodeId
      } else {
        try {
          backendNodeId = await queryBackendNodeId(host, ctx.paneId, args.selector!)
        } catch (err) {
          if (isSelectorSyntaxError(err))
            return refuseBadArgs('`selector` is not a valid CSS selector.')
          throw err
        }
        if (backendNodeId === null) return refuse('SELECTOR_NOT_FOUND', { selector: args.selector })
      }
      let quad: number[] | undefined
      try {
        const box = (await host.cdp(ctx.paneId, 'DOM.getBoxModel', { backendNodeId })) as {
          model?: { border?: number[] }
        }
        quad = box.model?.border
      } catch {
        // The node left the document since the snapshot: the ref is dead; a selector that matched a node with no
        // box (display:none) has nothing to capture.
        return args.ref !== undefined ? refuse('REF_STALE') : refuse('ELEMENT_NOT_VISIBLE')
      }
      const rect = quad ? rectFromQuad(quad) : null
      if (!rect || rect.width < 1 || rect.height < 1) return refuse('ELEMENT_NOT_VISIBLE')
      viewportRect = rect
      if (plan.method === 'cdp') {
        const m = (await host.cdp(ctx.paneId, 'Page.getLayoutMetrics', {})) as LayoutMetrics
        const px = m.cssVisualViewport?.pageX ?? 0
        const py = m.cssVisualViewport?.pageY ?? 0
        documentRect = { x: rect.x + px, y: rect.y + py, width: rect.width, height: rect.height }
      }
    } else if (plan.method === 'cdp' && plan.clip === 'page') {
      const m = (await host.cdp(ctx.paneId, 'Page.getLayoutMetrics', {})) as LayoutMetrics
      const width = Math.max(1, Math.ceil(m.cssContentSize?.width ?? 1))
      const h = fullPageHeight(m.cssContentSize?.height ?? FULL_PAGE_MAX_HEIGHT)
      fullPageClamped = h.clamped
      documentRect = { x: 0, y: 0, width, height: h.height }
    }

    const shot = await host.capture(ctx.paneId, {
      plan,
      format,
      quality,
      maxDim,
      ...(viewportRect ? { viewportRect } : {}),
      ...(documentRect ? { documentRect } : {})
    })

    const ext = format
    const path = args.save === true ? await deps.saveShot(ctx.folder, shot.data, ext) : undefined
    return {
      ...ctx.ack,
      width: shot.width,
      height: shot.height,
      bytes: shot.data.byteLength,
      format,
      clamped: shot.clamped || fullPageClamped,
      ...(plan.method === 'capturePage' && plan.fullPageDowngraded
        ? {
            fullPageDowngraded:
              'The pane is hidden, so a viewport shot was taken instead of the whole page.'
          }
        : {}),
      ...(path !== undefined ? { path } : {}),
      image: { data: Buffer.from(shot.data).toString('base64'), mimeType: shot.mime },
      untrustedNote: BROWSER_NOTE,
      note: BROWSER_NOTE
    }
  } catch (err) {
    return refuse('SCREENSHOT_FAILED', { detail: deps.scrub(errorText(err)) })
  }
}

/* ------------------------------------------------------------------------------------------------ */
/* browser_console                                                                                    */
/* ------------------------------------------------------------------------------------------------ */

export interface ConsoleArgs {
  paneId: string
  mode?: 'tail' | 'since'
  lines?: number
  since?: string
  levels?: ConsoleLevel[]
  clear?: boolean
}

export const CONSOLE_DEFAULT_LINES = 100
export const CONSOLE_MAX_LINES = 500

export async function consoleVerb(
  args: ConsoleArgs,
  deps: BrowserReadDeps
): Promise<Record<string, unknown>> {
  const opened = await openRead('browser_console', args.paneId, deps)
  if ('refusal' in opened) return opened.refusal
  const { ctx } = opened

  const mode = args.mode ?? (args.since !== undefined ? 'since' : 'tail')
  const lines = args.lines ?? CONSOLE_DEFAULT_LINES
  if (!Number.isInteger(lines) || lines < 1 || lines > CONSOLE_MAX_LINES) {
    return refuseBadArgs(`\`lines\` must be an integer between 1 and ${CONSOLE_MAX_LINES}.`)
  }
  if (mode === 'since' && args.since === undefined) {
    return refuseBadArgs('`mode: "since"` needs the `since` cursor a previous read returned.')
  }
  if (args.levels?.some((l) => !(CONSOLE_LEVELS as readonly string[]).includes(l))) {
    return refuseBadArgs(`\`levels\` entries are: ${CONSOLE_LEVELS.join(', ')}.`)
  }
  deps.registry.touch(ctx.paneId)

  const res = ctx.readers.console.read({
    mode,
    lines,
    ...(args.since !== undefined ? { since: args.since } : {}),
    ...(args.levels && args.levels.length > 0 ? { levels: args.levels } : {}),
    ...(args.clear === true ? { clear: true } : {})
  })
  if (!res.ok) {
    return res.error === 'CURSOR_EXPIRED'
      ? refuse('CURSOR_EXPIRED')
      : refuseBadArgs('Bad console read.')
  }
  return {
    ...ctx.ack,
    entries: res.entries.map((e) => ({
      ts: e.ts,
      level: e.level,
      source: e.source,
      text: deps.scrub(e.text),
      ...(e.url !== undefined ? { url: scrubUrl(e.url) || deps.scrub(e.url) } : {}),
      ...(e.line !== undefined ? { line: e.line } : {}),
      ...(e.stack !== undefined ? { stack: deps.scrub(e.stack) } : {})
    })),
    cursor: res.cursor,
    droppedEntries: res.droppedEntries,
    untrustedNote: BROWSER_NOTE,
    note: BROWSER_NOTE
  }
}

/* ------------------------------------------------------------------------------------------------ */
/* browser_network                                                                                    */
/* ------------------------------------------------------------------------------------------------ */

export interface NetworkArgs {
  paneId: string
  action: 'start' | 'read' | 'stop'
  maxMinutes?: number
  bodies?: boolean
  headers?: boolean
  filter?: string
  since?: string
  limit?: number
}

export const NETWORK_DEFAULT_LIMIT = 100
export const NETWORK_MAX_LIMIT = 500

export async function networkVerb(
  args: NetworkArgs,
  deps: BrowserReadDeps
): Promise<Record<string, unknown>> {
  const opened = await openRead('browser_network', args.paneId, deps, args.action)
  if ('refusal' in opened) return opened.refusal
  const { ctx } = opened

  if (
    args.maxMinutes !== undefined &&
    (args.maxMinutes < 1 || args.maxMinutes > MAX_CAPTURE_MINUTES)
  ) {
    return refuseBadArgs(`\`maxMinutes\` must be between 1 and ${MAX_CAPTURE_MINUTES}.`)
  }
  const limit = args.limit ?? NETWORK_DEFAULT_LIMIT
  if (!Number.isInteger(limit) || limit < 1 || limit > NETWORK_MAX_LIMIT) {
    return refuseBadArgs(`\`limit\` must be an integer between 1 and ${NETWORK_MAX_LIMIT}.`)
  }
  // Recording what an external site's requests carry is observing traffic the page did not mean to expose, so on
  // an external page it is a lease (spec §7.1). The lease arrives with the input verbs; until then it refuses.
  // `stop` only ever reduces what is observed, so it is always allowed.
  if (args.action !== 'stop' && ctx.ack.origin === 'external') {
    return refuse('NOT_YET_AVAILABLE', { feature: 'Network capture on an external page' })
  }

  const rec = deps.registry.get(ctx.paneId)!
  const token = deps.registry.beginWrite(rec.paneId)
  try {
    if (args.action === 'start') {
      const status = ctx.readers.startCapture({
        maxMinutes: args.maxMinutes ?? DEFAULT_CAPTURE_MINUTES,
        bodies: args.bodies === true,
        headers: args.headers === true
      })
      const report = deps.registry.endWrite(token)
      return {
        ...ctx.ack,
        active: status.active,
        expiresAt: status.expiresAt,
        bodies: status.bodies,
        headers: status.headers,
        othersWrote: report.othersWrote,
        operatorInteracted: report.operatorInteracted,
        note: BROWSER_NOTE
      }
    }
    if (args.action === 'stop') {
      const status = ctx.readers.stopCapture('stopped')
      const report = deps.registry.endWrite(token)
      return {
        ...ctx.ack,
        active: status.active,
        expiresAt: null,
        othersWrote: report.othersWrote,
        operatorInteracted: report.operatorInteracted,
        note: BROWSER_NOTE
      }
    }
    const res = ctx.readers.capture.read({
      limit,
      ...(args.since !== undefined ? { since: args.since } : {}),
      ...(args.filter !== undefined ? { filter: args.filter } : {})
    })
    const report = deps.registry.endWrite(token)
    if (!res.ok) return refuse('CURSOR_EXPIRED')
    const status = ctx.readers.capture.status()
    return {
      ...ctx.ack,
      active: status.active,
      expiresAt: status.expiresAt,
      entries: res.entries.map((e) => scrubEntry(e, deps.scrub)),
      cursor: res.cursor,
      droppedEntries: res.droppedEntries,
      othersWrote: report.othersWrote,
      operatorInteracted: report.operatorInteracted,
      untrustedNote: BROWSER_NOTE,
      note: BROWSER_NOTE
    }
  } catch (err) {
    deps.registry.endWrite(token)
    throw err
  }
}

function scrubEntry(e: NetworkEntry, scrub: (t: string) => string): NetworkEntry {
  return {
    ...e,
    url: scrub(e.url),
    ...(e.initiator !== undefined ? { initiator: scrub(e.initiator) } : {}),
    ...(e.failure !== undefined ? { failure: scrub(e.failure) } : {}),
    ...(e.body !== undefined ? { body: { ...e.body, text: scrub(e.body.text) } } : {}),
    ...(e.requestHeaders ? { requestHeaders: scrubValues(e.requestHeaders, scrub) } : {}),
    ...(e.responseHeaders ? { responseHeaders: scrubValues(e.responseHeaders, scrub) } : {})
  }
}

function scrubValues(
  h: Record<string, string>,
  scrub: (t: string) => string
): Record<string, string> {
  return Object.fromEntries(Object.entries(h).map(([k, v]) => [k, scrub(v)]))
}

/* ------------------------------------------------------------------------------------------------ */
/* browser_wait_for                                                                                   */
/* ------------------------------------------------------------------------------------------------ */

export interface WaitForArgs {
  paneId: string
  selector?: string
  text?: string
  textGone?: string
  url?: string
  networkIdleMs?: number
  timeoutMs?: number
}

const MAX_PAGE_TEXT_CHARS = 2_000_000

export async function waitForVerb(
  args: WaitForArgs,
  deps: BrowserReadDeps
): Promise<Record<string, unknown>> {
  const opened = await openRead('browser_wait_for', args.paneId, deps)
  if ('refusal' in opened) return opened.refusal
  const { ctx } = opened
  const host = deps.host

  const conds: WaitConditions = {}
  if (args.selector !== undefined) conds.selector = args.selector
  if (args.text !== undefined) conds.text = args.text
  if (args.textGone !== undefined) conds.textGone = args.textGone
  if (args.networkIdleMs !== undefined) {
    if (
      !Number.isInteger(args.networkIdleMs) ||
      args.networkIdleMs < 50 ||
      args.networkIdleMs > 30_000
    ) {
      return refuseBadArgs('`networkIdleMs` must be an integer between 50 and 30000.')
    }
    conds.networkIdleMs = args.networkIdleMs
  }
  if (args.url !== undefined) {
    const re = compileUrlPattern(args.url)
    if (!re)
      return refuseBadArgs('`url` must be a valid JavaScript regex source of 1 to 200 characters.')
    conds.url = re
  }
  if (Object.keys(conds).length === 0) {
    return refuseBadArgs(
      'Pass at least one of `selector`, `text`, `textGone`, `url`, `networkIdleMs`.'
    )
  }
  const timeoutMs = args.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_WAIT_TIMEOUT_MS) {
    return refuseBadArgs(`\`timeoutMs\` must be an integer between 100 and ${MAX_WAIT_TIMEOUT_MS}.`)
  }
  for (const t of [args.text, args.textGone]) {
    if (t !== undefined && (t.length === 0 || t.length > 1_000)) {
      return refuseBadArgs('`text` and `textGone` must be 1 to 1000 characters.')
    }
  }
  // A selector that is not valid CSS can never match: tell the caller now rather than time out.
  if (conds.selector !== undefined) {
    try {
      await queryBackendNodeId(host, ctx.paneId, conds.selector)
    } catch (err) {
      if (isSelectorSyntaxError(err))
        return refuseBadArgs('`selector` is not a valid CSS selector.')
    }
  }
  deps.registry.touch(ctx.paneId)

  const paneId = ctx.paneId
  const outcome = await runWait(conds, timeoutMs, {
    now: deps.now,
    sleep: deps.sleep,
    probes: {
      selectorPresent: async (selector) =>
        (await queryBackendNodeId(host, paneId, selector)) !== null,
      pageText: async () => {
        const res = (await host.cdp(paneId, 'Runtime.evaluate', {
          expression: 'document.body ? document.body.innerText : ""',
          returnByValue: true
        })) as { result?: { value?: unknown } }
        const v = res.result?.value
        return typeof v === 'string' ? v.slice(0, MAX_PAGE_TEXT_CHARS) : ''
      },
      currentUrl: () => host.info(paneId)?.url ?? '',
      networkIdle: (ms) => ctx.readers.idle.isIdle(ms),
      paneOpen: () => deps.registry.get(paneId) !== undefined && host.info(paneId) !== undefined,
      disconnected: () => deps.access.isDisconnected(paneId)
    }
  })
  const live = host.info(paneId)
  const ack = live && deps.registry.get(paneId) ? { ...ctx.ack, url: scrubUrl(live.url) } : ctx.ack
  return {
    ...ack,
    wait: {
      reason: outcome.reason,
      waitedMs: outcome.waitedMs,
      // A URL match is shown as the page's address without its query string; the others echo what the caller sent.
      ...(outcome.match !== undefined
        ? {
            match: outcome.reason === 'url' ? scrubUrl(live?.url ?? '') : deps.scrub(outcome.match)
          }
        : {})
    },
    untrustedNote: BROWSER_NOTE,
    note: BROWSER_NOTE
  }
}
