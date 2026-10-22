/**
 * The three verbs of unit U5 (T564, spec §6.1 rows 16–18): `browser_emulate`, `browser_upload` and
 * `browser_download`, as pure functions over injected dependencies, on the same pipeline as the acting verbs
 * (`runWrite`: gate → the pane's write queue → the gate again → `agentInput` stamped → the work → an ACK that says
 * whether anyone else wrote). The MCP handlers supply the real dependencies; the tests supply fakes.
 *
 * Every decision lives in a pure module: `emulation` (merge, refusals, CDP commands), `upload-plan` (the path jail),
 * `download-plan` (naming, the one-shot allowance). This file only sequences them.
 */
import { errorText, performClick, runWrite } from './act-verbs'
import type { ActCtx, BrowserActDeps, BrowserActHost } from './act-verbs'
import {
  checkEmulateArgs,
  deviceActive,
  mergeEmulation,
  summarizeEmulation,
  type EmulateArgs
} from '../../shared/browser-emulation'
import { DEFAULT_DOWNLOAD_TIMEOUT_MS, type DownloadArm } from './download-plan'
import { planUpload, type UploadIo } from './upload-plan'
import { refuse, refuseBadArgs, type Refusal } from './verbs-core'

/** What the view host adds for emulation, zoom and downloads (`view-host.ts` implements it over Electron). */
export interface BrowserDeviceHost extends BrowserActHost {
  /**
   * Put the pane's emulation record (`rec.emulation`, already updated) on the page: the device metrics at the fit
   * scale, touch, user agent and media features. `reloadForTouch` reloads a loaded page whose touch just turned on
   * (touch only exists if it was on when the page started, spec §9.2). Resolves with what is in effect.
   */
  applyEmulation(
    paneId: string,
    opts: { reloadForTouch: boolean }
  ): Promise<{ fitScale: number | null; reloaded: boolean }>
  /** The zoom factor in effect now (1 in device mode). */
  zoomOf(paneId: string): number
  /** Set the zoom of the page's origin: clamped, remembered, applied. Returns the factor in effect. */
  setZoom(paneId: string, factor: number): number
  /** Arm the one-shot download allowance for the pane (spec §3.2). */
  armDownload(paneId: string, opts: { name?: string; timeoutMs: number }): DownloadArm
  /** Start a download of `url` through the pane's session (`webContents.downloadURL`). */
  downloadUrl(paneId: string, url: string): void
}

export interface BrowserDeviceDeps extends BrowserActDeps {
  host: BrowserDeviceHost
  /** The filesystem the upload jail reads (the real one in the service, a fake in tests). */
  uploadIo: UploadIo
}

/* ------------------------------------------------------------------------------------------------ */
/* browser_emulate                                                                                    */
/* ------------------------------------------------------------------------------------------------ */

export interface EmulateVerbArgs extends EmulateArgs {
  paneId: string
}

export async function emulateVerb(
  args: EmulateVerbArgs,
  deps: BrowserDeviceDeps,
  key: object = args
): Promise<Record<string, unknown>> {
  return runWrite('browser_emulate', args as never, key, deps, async (ctx) => {
    const { paneId, ...rest } = args
    const rec = ctx.rec
    const prev = rec.emulation ?? {}
    // The pane may have changed while this call waited in the queue (the operator picked a device): judge the rule
    // again against what is on the pane now, so `zoom` can never land on a device.
    const refusal = checkEmulateArgs(rest, { deviceActive: deviceActive(prev) })
    if (refusal) {
      return refusal.code === 'BAD_ARGS'
        ? refuseBadArgs(refusal.detail)
        : refuse('ZOOM_IN_DEVICE_MODE', { folder: rec.folder, detail: refusal.detail })
    }
    // A call that only sets the zoom leaves the device settings alone.
    const onlyZoom = Object.entries(rest).every(([k, v]) => k === 'zoom' || v === undefined)
    const next = mergeEmulation(prev, rest)
    rec.emulation = next
    let applied: { fitScale: number | null; reloaded: boolean } = {
      fitScale: null,
      reloaded: false
    }
    try {
      if (!onlyZoom) applied = await deps.host.applyEmulation(paneId, { reloadForTouch: true })
      if (rest.zoom !== undefined) deps.host.setZoom(paneId, rest.zoom)
    } catch (err) {
      // Put the record back: the page did not take the change, so the picker must not claim it did.
      rec.emulation = prev
      await deps.host.applyEmulation(paneId, { reloadForTouch: false }).catch(() => undefined)
      return refuse('EMULATION_FAILED', { folder: rec.folder, detail: deps.scrub(errorText(err)) })
    }
    return {
      emulation: summarizeEmulation(next),
      zoom: deps.host.zoomOf(paneId),
      ...(applied.fitScale !== null
        ? { fitScale: Math.round(applied.fitScale * 1000) / 1000 }
        : {}),
      ...(applied.reloaded ? { reloaded: true } : {})
    }
  })
}

/* ------------------------------------------------------------------------------------------------ */
/* browser_upload                                                                                     */
/* ------------------------------------------------------------------------------------------------ */

export interface UploadArgs {
  paneId: string
  ref: string
  paths: string[]
}

interface DescribedNode {
  node?: { nodeName?: string; attributes?: string[] }
}

/** Attribute lookup in CDP's flat `[name, value, name, value, …]` list. */
function attr(list: readonly string[] | undefined, name: string): string | undefined {
  if (!list) return undefined
  for (let i = 0; i + 1 < list.length; i += 2) {
    if (list[i]!.toLowerCase() === name) return list[i + 1]
  }
  return undefined
}

export async function uploadVerb(
  args: UploadArgs,
  deps: BrowserDeviceDeps,
  key: object = args
): Promise<Record<string, unknown>> {
  return runWrite('browser_upload', args as never, key, deps, async (ctx) => {
    const folder = ctx.rec.folder
    const resolved = ctx.readers.refs.resolve(args.ref)
    if (!resolved.ok) return refuse(resolved.error, { folder })
    let described: DescribedNode
    try {
      described = (await deps.host.cdp(ctx.rec.paneId, 'DOM.describeNode', {
        backendNodeId: resolved.backendNodeId
      })) as DescribedNode
    } catch {
      return refuse('REF_STALE', { folder })
    }
    const node = described.node
    const isFileInput =
      node?.nodeName?.toLowerCase() === 'input' &&
      attr(node.attributes, 'type')?.toLowerCase() === 'file'
    if (!isFileInput) return refuse('NOT_A_FILE_INPUT', { folder })
    if (args.paths.length > 1 && attr(node?.attributes, 'multiple') === undefined) {
      return refuseBadArgs(
        'That file input takes one file (it has no `multiple`). Pass a single path, or a different input.'
      )
    }
    const plan = await planUpload({ folder, paths: args.paths, io: deps.uploadIo })
    if (!plan.ok)
      return refuse(plan.code === 'BAD_ARGS' ? 'UPLOAD_PATH_DENIED' : plan.code, {
        folder,
        detail: plan.detail
      })
    try {
      await deps.host.cdp(ctx.rec.paneId, 'DOM.setFileInputFiles', {
        files: plan.files.map((f) => f.path),
        backendNodeId: resolved.backendNodeId
      })
    } catch (err) {
      return refuse('INPUT_FAILED', { folder, detail: deps.scrub(errorText(err)) })
    }
    return { files: plan.files.map((f) => ({ name: f.name, bytes: f.bytes })) }
  })
}

/* ------------------------------------------------------------------------------------------------ */
/* browser_download                                                                                   */
/* ------------------------------------------------------------------------------------------------ */

export interface DownloadArgs {
  paneId: string
  url?: string
  ref?: string
  name?: string
  timeoutMs?: number
}

export async function downloadVerb(
  args: DownloadArgs,
  deps: BrowserDeviceDeps,
  key: object = args
): Promise<Record<string, unknown>> {
  return runWrite('browser_download', args as never, key, deps, async (ctx: ActCtx) => {
    const folder = ctx.rec.folder
    const paneId = ctx.rec.paneId
    const arm = deps.host.armDownload(paneId, {
      ...(args.name !== undefined ? { name: args.name } : {}),
      timeoutMs: args.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS
    })
    try {
      if (args.url !== undefined) {
        try {
          deps.host.downloadUrl(paneId, args.url)
        } catch (err) {
          return refuse('DOWNLOAD_FAILED', { folder, detail: deps.scrub(errorText(err)) })
        }
      } else {
        const clicked = await performClick({ ref: args.ref ?? '' }, ctx, deps)
        if (isRefusal(clicked)) return clicked
      }
      const result = await arm.result
      if (!result.ok) return refuse(result.code, { folder, detail: result.detail })
      return { path: result.path, bytes: result.bytes, mime: result.mime, name: result.name }
    } finally {
      arm.disarm()
    }
  })
}

function isRefusal(v: unknown): v is Refusal {
  return typeof v === 'object' && v !== null && (v as { ok?: unknown }).ok === false
}
