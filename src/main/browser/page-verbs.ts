/**
 * The page-side verbs of unit U2 (T564, spec §5, §6.2): `browser_set_data`, `browser_patch` and the `path` /
 * `html` forms of `browser_open`. Pure functions over the injected {@link BrowserVerbDeps} (the page seam
 * included); the MCP handlers supply the real ones, the tests fakes.
 */
import * as path from 'node:path'
import { MAX_DATA_BYTES } from './page-state'
import { MAX_PANEL_HTML_BYTES } from './page-content'
import {
  MAX_PATCH_HTML_BYTES,
  buildPatchScript,
  isPatchMode,
  patchNeedsHtml,
  type PatchMode
} from './page-patch'
import { jailVerbPath } from './page-url'
import { MAX_AGENT_PANES_PER_FOLDER, type BrowserPaneRecord } from './registry'
import { classifyOrigin } from './origin-class'
import {
  BROWSER_NOTE,
  ackBase,
  emptyLive,
  gate,
  originOf,
  refuse,
  refuseBadArgs,
  sessionNotFound,
  type BrowserVerbDeps,
  type OpenArgs
} from './verbs-core'

export const PANEL_DIR = '.harnu/out/panels'

/** A file name for a panel from the name the agent gave it: lowercase, `a-z0-9-`, never empty. */
export function panelSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '')
  return slug === '' ? 'panel' : slug
}

function bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/* ------------------------------------------------------------------------------------------------ */
/* browser_set_data                                                                                  */
/* ------------------------------------------------------------------------------------------------ */

export interface SetDataArgs {
  paneId: string
  data?: unknown
  merge?: boolean
  expectRev?: number
}

export async function setDataVerb(
  args: SetDataArgs,
  deps: BrowserVerbDeps
): Promise<Record<string, unknown>> {
  const g = await gate('browser_set_data', args.paneId, deps)
  if ('refusal' in g) return g.refusal
  const rec = g.rec!
  if (!('data' in args) || args.data === undefined) {
    return refuseBadArgs(
      'Pass `data`: any JSON value (an object to merge into, or the whole state).'
    )
  }
  if (args.expectRev !== undefined && (!Number.isInteger(args.expectRev) || args.expectRev < 0)) {
    return refuseBadArgs('`expectRev` must be a non-negative integer.')
  }
  const target = await deps.pages.locate(g.live?.url ?? '')
  if (!target) return refuse('NOT_A_PAGE_PANE', { folder: rec.folder })

  const token = deps.registry.beginWrite(rec.paneId)
  let result: Awaited<ReturnType<typeof deps.pages.state.set>>
  try {
    result = await deps.pages.state.set(target.folder, target.relPath, args.data, {
      ...(args.merge === true ? { merge: true } : {}),
      ...(args.expectRev !== undefined ? { expectRev: args.expectRev } : {})
    })
  } catch (err) {
    deps.registry.endWrite(token)
    throw err
  }
  const report = deps.registry.endWrite(token)
  if (!result.ok) {
    return result.code === 'DATA_TOO_LARGE'
      ? refuse('DATA_TOO_LARGE', { folder: rec.folder, limitBytes: MAX_DATA_BYTES })
      : refuse('REV_CONFLICT', { folder: rec.folder, currentRev: result.currentRev })
  }
  // `delivered: false` means no loaded page took it; the value is applied at next load from the sidecar.
  const reached = deps.pages.pushData(target.folder, target.relPath, result.state)
  return {
    ...ackBase(rec, g.live, g.origin ?? 'page'),
    rev: result.state.rev,
    bytes: result.bytes,
    delivered: reached > 0,
    persisted: true,
    othersWrote: report.othersWrote,
    operatorInteracted: report.operatorInteracted
  }
}

/* ------------------------------------------------------------------------------------------------ */
/* browser_patch                                                                                     */
/* ------------------------------------------------------------------------------------------------ */

export interface PatchArgs {
  paneId: string
  selector?: string
  mode?: string
  html?: string
}

export async function patchVerb(
  args: PatchArgs,
  deps: BrowserVerbDeps
): Promise<Record<string, unknown>> {
  const g = await gate('browser_patch', args.paneId, deps)
  if ('refusal' in g) return g.refusal
  const rec = g.rec!
  const selector = args.selector?.trim() ?? ''
  if (selector === '' || selector.length > 1000) {
    return refuseBadArgs('Pass a CSS `selector` (1 to 1000 characters).')
  }
  if (!isPatchMode(args.mode)) {
    return refuseBadArgs('`mode` must be one of inner, outer, append, prepend, remove.')
  }
  const mode: PatchMode = args.mode
  if (patchNeedsHtml(mode) && args.html === undefined) {
    return refuseBadArgs(`mode "${mode}" needs \`html\`.`)
  }
  if (args.html !== undefined && bytes(args.html) > MAX_PATCH_HTML_BYTES) {
    return refuse('HTML_TOO_LARGE', { folder: rec.folder, limitBytes: MAX_PATCH_HTML_BYTES })
  }

  const token = deps.registry.beginWrite(rec.paneId)
  let outcome: Awaited<ReturnType<typeof deps.pages.runPatch>>
  try {
    outcome = await deps.pages.runPatch(
      rec.paneId,
      buildPatchScript({ selector, mode, ...(args.html !== undefined ? { html: args.html } : {}) })
    )
  } catch (err) {
    deps.registry.endWrite(token)
    throw err
  }
  const report = deps.registry.endWrite(token)
  // A page that never became ready is not a selector that matched nothing: say which it was (F8).
  if (outcome === null) return refuse('PAGE_NOT_READY', { folder: rec.folder })
  if (outcome.badSelector !== undefined || outcome.matched === 0) {
    return refuse('SELECTOR_NOT_FOUND', { folder: rec.folder, selector })
  }
  return {
    ...ackBase(rec, g.live, g.origin ?? 'page'),
    matched: outcome.matched,
    applied: outcome.applied,
    othersWrote: report.othersWrote,
    operatorInteracted: report.operatorInteracted,
    note: BROWSER_NOTE
  }
}

/* ------------------------------------------------------------------------------------------------ */
/* browser_open({ path }) and browser_open({ html, name })                                           */
/* ------------------------------------------------------------------------------------------------ */

export async function openPageFileVerb(
  args: OpenArgs,
  deps: BrowserVerbDeps
): Promise<Record<string, unknown>> {
  const owner = args.ownerSessionId ?? null
  if (owner !== null && !deps.sessionKnown(owner)) return { ok: false, ...sessionNotFound() }

  const folder = await deps.pages.folderFor(args.folder)
  if (!folder)
    return refuse('PATH_NOT_ALLOWED', { folder: args.folder, jailReason: 'unknown folder' })

  // The `html` form names its file BEFORE anything is written, so every refusal below (the cap included) happens
  // with the disk untouched (F7). The path form is jailed first, then deduped, then capped.
  let htmlPanel: { slug: string; rel: string } | null = null
  let rawPath: string
  if (args.html !== undefined) {
    if (args.name === undefined || args.name.trim() === '') {
      return refuseBadArgs('`html` needs a `name` for the panel file.')
    }
    if (bytes(args.html) > MAX_PANEL_HTML_BYTES) {
      return refuse('HTML_TOO_LARGE', { folder: args.folder, limitBytes: MAX_PANEL_HTML_BYTES })
    }
    const slug = panelSlug(args.name)
    htmlPanel = { slug, rel: `${PANEL_DIR}/${slug}.html` }
    rawPath = htmlPanel.rel
    // A new panel pane counts toward the cap; rewriting the file a pane already shows does not.
    const agentPanes = deps.registry.agentPanesIn(args.folder)
    if (
      !deps.registry.findPagePane(args.folder, htmlPanel.rel) &&
      agentPanes.length >= MAX_AGENT_PANES_PER_FOLDER
    ) {
      return refuse('PANE_LIMIT', {
        folder: args.folder,
        reusablePaneIds: agentPanes.map((p) => p.paneId)
      })
    }
    // Writing the file is the same act as the agent's own Write, through a verified real directory.
    const written = await deps.pages.writePanel(args.folder, htmlPanel.slug, args.html)
    if (!written.ok) {
      return refuse('PATH_NOT_ALLOWED', { folder: args.folder, jailReason: written.reason })
    }
    rawPath = written.relPath
  } else {
    rawPath = args.path ?? ''
  }

  const verdict = await jailVerbPath({ folder, rawPath, fs: deps.pages.fs })
  if (!verdict.ok) {
    return verdict.reason === 'not-found'
      ? refuseBadArgs(`No such file: ${path.basename(rawPath) || rawPath}.`)
      : refuse('PATH_NOT_ALLOWED', { folder: args.folder, jailReason: verdict.reason })
  }

  // Page panes dedupe on the file (spec §2.2, §6.2): reuse the one that is already showing it.
  const existing = deps.registry.findPagePane(args.folder, verdict.relPath)
  if (existing) {
    deps.registry.touch(existing.paneId)
    const live = deps.host.info(existing.paneId)
    return {
      ...ackBase(existing, live, originOf(existing, live, deps)),
      path: verdict.relPath,
      reused: true,
      ownerSessionId: existing.ownerSessionId,
      openedBy: existing.openedBy
    }
  }

  const agentPanes = deps.registry.agentPanesIn(args.folder)
  if (agentPanes.length >= MAX_AGENT_PANES_PER_FOLDER) {
    return refuse('PANE_LIMIT', {
      folder: args.folder,
      reusablePaneIds: agentPanes.map((p) => p.paneId)
    })
  }

  const paneId = deps.newPaneId()
  const now = deps.now()
  const url = deps.pages.urlFor(verdict.realFolder, verdict.relPath)
  const rec: BrowserPaneRecord = {
    paneId,
    folder: args.folder,
    name: args.name?.trim() || path.basename(verdict.relPath),
    openedBy: 'agent',
    partition: 'agent',
    ownerSessionId: owner,
    createdAt: now,
    lastActiveAt: now,
    seenHosts: new Set<string>(),
    // Our own file is the expected case: never flagged "opened by agent".
    flagged: null,
    pagePath: verdict.relPath,
    allowNetwork: false
  }
  deps.registry.add(rec)
  try {
    deps.host.create({ paneId, folder: args.folder, partition: rec.partition, url })
    const shown = await deps.showPane({
      worktreePath: args.folder,
      paneId,
      name: rec.name,
      url,
      openedBy: 'agent',
      ownerSessionId: owner,
      partition: rec.partition,
      pagePath: verdict.relPath
    })
    if (!shown) throw new Error('the renderer did not show the pane')
  } catch (err) {
    deps.host.destroy(paneId)
    deps.registry.remove(paneId)
    deps.access.forget(paneId)
    throw err
  }
  const live = deps.host.info(paneId)
  return {
    ...ackBase(rec, live?.url ? live : { ...(live ?? emptyLive()), url }, classifyOrigin(url)),
    path: verdict.relPath,
    reused: false,
    ownerSessionId: owner,
    openedBy: 'agent'
  }
}
