import { app, ipcMain, protocol, type BrowserWindow } from 'electron'
import { createReadStream } from 'node:fs'
import { promises as fs } from 'node:fs'
import { Readable } from 'node:stream'
import * as path from 'node:path'
import {
  applyKokoroRewrites,
  abortCleanupTargets,
  cdnUrlFor,
  crawlWithinBudget,
  extractEsmImports,
  kokoroContentType,
  kokoroInstallPlan,
  kokoroRuntimeConfig,
  missingVoices,
  parseInstallManifest,
  buildInstallManifest,
  rangeHeader,
  migrateLegacyKokoroOrigin,
  resolveKokoroAssetPath,
  resumeDecision,
  isKokoroVoiceId,
  KOKORO_ENTRY_PATH,
  KOKORO_HOST,
  KOKORO_INSTALL_DIR,
  KOKORO_MANIFEST_FILE,
  KOKORO_LEGACY_PROTOCOL,
  KOKORO_PROTOCOL,
  KOKORO_STAGING_DIR,
  type KokoroAsset,
  type KokoroInstallManifest,
  type KokoroInstallPlan,
  type KokoroProgress,
  type KokoroStatus
} from './speech-kokoro-plan'

/**
 * Main-process half of the Kokoro voice download (T241, ADR-0012 option C).
 *
 * Thin by construction — every decision (what to fetch, where it lands, how to
 * resume, what a cancel deletes, how a URL maps to a file) is pure and tested in
 * `speech-kokoro-plan.ts`. This file only performs the effect: HTTP, fs, the
 * `harnu-voice://` protocol handler and the IPC surface. Same split, and same
 * coverage exclusion, as `speech.ts` (ADR-0001).
 *
 * **Nothing here runs on its own.** There is no first-use trigger, no lazy
 * fetch, no "enable voice and we'll grab it" path: `speech:kokoro:install` is
 * the only thing that touches the network, and it is only ever called by an
 * explicit operator action (AC-3).
 *
 * **Why the download includes the code.** `phonemizer` inlines a compiled
 * espeak-ng (GPLv3). Shipping it would relicense Harnu's binary; fetching it here,
 * onto the operator's own machine, does not. See `speech-kokoro-plan.ts` and
 * ADR-0012 — and `scripts/ci/voice-licence-gate.mjs`, which fails the build if
 * either package ever appears in the packaged artifact.
 */

/** Progress events go to every window; the settings pane subscribes. */
const PROGRESS_CHANNEL = 'speech:kokoro:progress'

let getWindow: (() => BrowserWindow | null) | null = null
let running: InstallRun | null = null

interface InstallRun {
  controller: AbortController
  voices: string[]
  hadCompleteInstall: boolean
  /**
   * Why the run was aborted. Only an operator `cancel` deletes what was
   * fetched; a `quit` is an interruption, and interruptions are resumable.
   */
  abortReason: 'cancel' | 'quit' | null
  /** Resolves when the run has finished writing, so `remove` can wait for it. */
  settled?: Promise<void>
}

function installRoot(): string {
  return path.join(app.getPath('userData'), KOKORO_INSTALL_DIR)
}

function stagingRoot(): string {
  return path.join(installRoot(), KOKORO_STAGING_DIR)
}

/** Mirror path (`/npm/...`) → absolute file under the install root. */
function filePathFor(mirrorPath: string): string {
  return path.join(installRoot(), ...mirrorPath.slice(1).split('/'))
}

function stagingPathFor(mirrorPath: string): string {
  return path.join(stagingRoot(), ...mirrorPath.slice(1).split('/')) + '.part'
}

async function sizeOf(file: string): Promise<number> {
  try {
    return (await fs.stat(file)).size
  } catch {
    return 0
  }
}

async function readManifest(): Promise<KokoroInstallManifest | null> {
  try {
    return parseInstallManifest(
      await fs.readFile(path.join(installRoot(), KOKORO_MANIFEST_FILE), 'utf8')
    )
  } catch {
    return null
  }
}

function emit(progress: KokoroProgress): void {
  try {
    getWindow?.()?.webContents.send(PROGRESS_CHANNEL, progress)
  } catch {
    // A closing window must never abort a download.
  }
}

// ---------------------------------------------------------------------------
// Downloading
// ---------------------------------------------------------------------------

interface Totals {
  received: number
  total: number
  /** Last emit, so a 92 MB stream does not send ~1500 IPC messages. */
  lastEmit: number
}

/** Progress ticks at most this often. Fast enough for a bar, cheap enough for IPC. */
const PROGRESS_INTERVAL_MS = 200

/**
 * Emit a progress tick, rate-limited. `force` bypasses the limit for the edges
 * a UI must not miss — the start and end of an asset — so a bar never sticks at
 * a stale value when a file finishes between two ticks.
 */
function tick(totals: Totals, phase: KokoroProgress['phase'], asset: string, force = false): void {
  const now = Date.now()
  if (!force && now - totals.lastEmit < PROGRESS_INTERVAL_MS) return
  totals.lastEmit = now
  emit({ phase, asset, receivedBytes: totals.received, totalBytes: totals.total })
}

/**
 * Fetch one asset into staging and move it into place.
 *
 * Resumes from a `.part` left by an interruption via a `Range` request, and
 * only renames once the bytes are all there — so an interrupted install never
 * leaves a truncated file that would look complete on the next run.
 */
async function fetchAsset(
  asset: KokoroAsset,
  signal: AbortSignal,
  totals: Totals,
  phase: KokoroProgress['phase']
): Promise<number> {
  const finalPath = filePathFor(asset.path)
  const existing = await sizeOf(finalPath)
  if (existing > 0 && (asset.bytes === null || existing === asset.bytes)) {
    totals.received += existing
    tick(totals, phase, asset.path, true)
    return existing
  }

  const partPath = stagingPathFor(asset.path)
  const decision = resumeDecision(await sizeOf(partPath), asset.bytes)
  await fs.mkdir(path.dirname(partPath), { recursive: true })

  if (decision.mode !== 'done') {
    const headers: Record<string, string> = {}
    if (decision.mode === 'range') headers.Range = rangeHeader(decision.offset)
    const res = await fetch(asset.url, { signal, headers })
    if (!res.ok || !res.body) {
      throw new Error(`voice install: ${asset.url} responded ${res.status}`)
    }
    // A server that ignored the Range gave us the whole file: restart the part.
    const append = decision.mode === 'range' && res.status === 206
    const handle = await fs.open(partPath, append ? 'a' : 'w')
    try {
      let written = append ? decision.offset : 0
      totals.received += written
      for await (const chunk of Readable.fromWeb(
        res.body as Parameters<typeof Readable.fromWeb>[0]
      )) {
        const buf = chunk as Buffer
        await handle.write(buf)
        written += buf.length
        totals.received += buf.length
        tick(totals, phase, asset.path)
      }
      if (asset.bytes !== null && written !== asset.bytes) {
        throw new Error(`voice install: ${asset.path} is ${written} bytes, expected ${asset.bytes}`)
      }
    } finally {
      await handle.close()
    }
  } else {
    totals.received += decision.offset
  }

  await fs.mkdir(path.dirname(finalPath), { recursive: true })
  await fs.rename(partPath, finalPath)
  return asset.bytes ?? (await sizeOf(finalPath))
}

/**
 * Walk the `/+esm` graph from the entry module, mirroring every root-relative
 * import. Text assets go through `applyKokoroRewrites`, which refuses the
 * install if the one URL it has to patch is not where it was.
 */
async function fetchCodeGraph(signal: AbortSignal, totals: Totals): Promise<number> {
  const seen = new Set<string>()
  const queue = [KOKORO_ENTRY_PATH]
  let bytes = 0
  while (queue.length > 0) {
    const mirrorPath = queue.shift() as string
    if (seen.has(mirrorPath)) continue
    seen.add(mirrorPath)
    if (!crawlWithinBudget({ files: seen.size, bytes })) {
      throw new Error('voice install: the module graph is larger than expected — refusing')
    }

    const finalPath = filePathFor(mirrorPath)
    let source: string
    const cached = await sizeOf(finalPath)
    if (cached > 0) {
      // A cached entry file may still carry the pre-rename scheme; fix it on disk
      // before it is reused.
      if (mirrorPath === KOKORO_ENTRY_PATH) await migrateInstalledMirror()
      source = await fs.readFile(finalPath, 'utf8')
    } else {
      const res = await fetch(cdnUrlFor(mirrorPath), { signal })
      if (!res.ok)
        throw new Error(`voice install: ${cdnUrlFor(mirrorPath)} responded ${res.status}`)
      source = applyKokoroRewrites(mirrorPath, await res.text())
      await fs.mkdir(path.dirname(finalPath), { recursive: true })
      const staged = stagingPathFor(mirrorPath)
      await fs.mkdir(path.dirname(staged), { recursive: true })
      await fs.writeFile(staged, source, 'utf8')
      await fs.rename(staged, finalPath)
    }
    const size = Buffer.byteLength(source)
    bytes += size
    totals.received += size
    totals.total = Math.max(totals.total, totals.received)
    tick(totals, 'code', mirrorPath, true)
    for (const spec of extractEsmImports(source)) queue.push(spec)
  }
  return bytes
}

async function removeDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true })
}

/**
 * Download everything, in the order a consent step promised: code, runtime,
 * model, voices. Writes `install.json` last — until it exists, a status read
 * says "not installed", so a crash halfway is never mistaken for a usable one.
 */
async function runInstall(plan: KokoroInstallPlan, run: InstallRun): Promise<KokoroStatus> {
  const totals: Totals = { received: 0, total: plan.totalBytes, lastEmit: 0 }
  try {
    await fs.mkdir(installRoot(), { recursive: true })
    await fetchCodeGraph(run.controller.signal, totals)
    for (const asset of plan.assets) {
      const phase: KokoroProgress['phase'] =
        asset.kind === 'voice' ? 'voice' : asset.kind === 'runtime' ? 'runtime' : 'model'
      await fetchAsset(asset, run.controller.signal, totals, phase)
    }
    tick(totals, 'verifying', '', true)

    const previous = await readManifest()
    const voices = [...new Set([...(previous?.voices ?? []), ...plan.voices])]
    const manifest = buildInstallManifest(voices, totals.received, new Date())
    await fs.writeFile(
      path.join(installRoot(), KOKORO_MANIFEST_FILE),
      JSON.stringify(manifest, null, 2),
      'utf8'
    )
    await removeDir(stagingRoot())
    emit({ phase: 'done', asset: '', receivedBytes: totals.received, totalBytes: totals.received })
    return status(manifest, false)
  } catch (err) {
    if (!run.controller.signal.aborted) {
      // A genuine failure (network drop, a 500, a full disk) deliberately
      // leaves everything on disk: the `.part` files are what let the next
      // attempt resume instead of re-fetching 92 MB. `install.json` was never
      // written, so the status still reads "not installed" — an interrupted
      // download is visible as unfinished, not as broken.
      emit({
        phase: 'failed',
        asset: '',
        receivedBytes: totals.received,
        totalBytes: totals.total,
        error: err instanceof Error ? err.message : String(err)
      })
      throw err
    }
    // A CANCEL is the opposite, and AC-5 is explicit about it: leave no partial
    // file and no half-installed module. Cancelling a first install removes the
    // whole directory; cancelling an addition to a working install removes only
    // the staging area, so the voices already there survive.
    //
    // A QUIT aborts the same signal but is NOT a cancel — the operator did not
    // ask to throw the download away, they asked to close the app. Deleting
    // ~90 MB of progress on the way out (and racing the shutdown while doing
    // it) would be the worst of both. So a quit falls through and resumes on
    // the next run, exactly like a crash.
    for (const target of abortCleanupTargets(run.abortReason ?? 'quit', run.hadCompleteInstall)) {
      await removeDir(target === 'root' ? installRoot() : stagingRoot())
    }
    emit({
      phase: 'cancelled',
      asset: '',
      receivedBytes: totals.received,
      totalBytes: totals.total
    })
    return status(await readManifest(), false)
  }
}

function status(manifest: KokoroInstallManifest | null, installing: boolean): KokoroStatus {
  return {
    installed: manifest !== null,
    manifest,
    installing,
    directory: installRoot(),
    runtime: kokoroRuntimeConfig()
  }
}

// ---------------------------------------------------------------------------
// The `harnu-voice://` protocol
// ---------------------------------------------------------------------------

/**
 * Must run before `app.whenReady()`. Registers the scheme as standard (so
 * root-relative imports inside the mirrored modules resolve), secure (so WASM
 * and module loading are allowed), fetch-capable and CORS-enabled — the page
 * itself is on `file://`, so every request into the mirror is cross-origin.
 */
export function registerKokoroScheme(): void {
  const privileges = {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true,
    bypassCSP: false
  }
  // The legacy scheme is registered too: installs made before the rename have it
  // baked into the mirrored entry file on disk.
  protocol.registerSchemesAsPrivileged([
    { scheme: KOKORO_PROTOCOL, privileges },
    { scheme: KOKORO_LEGACY_PROTOCOL, privileges }
  ])
}

/** Serve the mirror. Called from `app.whenReady()`. */
export function registerKokoroProtocol(): void {
  protocol.handle(KOKORO_PROTOCOL, serveMirror)
  protocol.handle(KOKORO_LEGACY_PROTOCOL, serveMirror)
  void migrateInstalledMirror()
}

/**
 * Rewrite a mirrored entry file written under the old scheme to the current one,
 * so the legacy alias can be dropped later. Best effort: the alias keeps the
 * install playing whether or not this runs or succeeds.
 */
export async function migrateInstalledMirror(): Promise<void> {
  const file = filePathFor(KOKORO_ENTRY_PATH)
  try {
    const source = await fs.readFile(file, 'utf8')
    const migrated = migrateLegacyKokoroOrigin(source)
    if (migrated === source) return
    const staged = stagingPathFor(KOKORO_ENTRY_PATH)
    await fs.mkdir(path.dirname(staged), { recursive: true })
    await fs.writeFile(staged, migrated, 'utf8')
    await fs.rename(staged, file)
  } catch {
    // not installed, or unreadable — nothing to migrate
  }
}

async function serveMirror(request: Request): Promise<Response> {
  const url = new URL(request.url)
  if (url.hostname !== KOKORO_HOST) return new Response('not found', { status: 404 })
  const file = resolveKokoroAssetPath(installRoot(), url.pathname, path.join)
  if (!file) return new Response('not found', { status: 404 })
  let size: number
  try {
    const stat = await fs.stat(file)
    if (!stat.isFile()) return new Response('not found', { status: 404 })
    size = stat.size
  } catch {
    return new Response('not found', { status: 404 })
  }
  const body = Readable.toWeb(createReadStream(file)) as ReadableStream<Uint8Array>
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': kokoroContentType(url.pathname),
      'content-length': String(size),
      'access-control-allow-origin': '*',
      'cache-control': 'no-store'
    }
  })
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function requestedVoices(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.filter(isKokoroVoiceId)
}

export function registerKokoroHandlers(window: () => BrowserWindow | null): void {
  getWindow = window

  ipcMain.handle('speech:kokoro:status', async (): Promise<KokoroStatus> => {
    return status(await readManifest(), running !== null)
  })

  // Pure data — what the consent step has to state before anything is fetched
  // (AC-4): the size, what is fetched, where it lands, the licence terms.
  ipcMain.handle('speech:kokoro:plan', (_e, voices: unknown): KokoroInstallPlan => {
    return kokoroInstallPlan(requestedVoices(voices))
  })

  // The ONLY network door. Nothing else in the voice stack calls it (AC-3).
  ipcMain.handle('speech:kokoro:install', async (_e, voices: unknown): Promise<KokoroStatus> => {
    if (running) return status(await readManifest(), true)
    const existing = await readManifest()
    const wanted = requestedVoices(voices)
    // On a fresh install, download what was asked for (or the default voice).
    // On an existing one, download only what is missing — and when nothing is,
    // re-plan the voices already there so the run is a cheap repair pass rather
    // than an unrequested extra voice. (`kokoroInstallPlan([])` would default to
    // af_heart, which is the right answer for a first install and the wrong one
    // for an operator who deliberately installed only bm_george.)
    let planned = wanted
    if (existing) {
      const missing = missingVoices(existing, wanted.length > 0 ? wanted : existing.voices)
      planned = missing.length > 0 ? missing : existing.voices
    }
    const plan = kokoroInstallPlan(planned)
    const run: InstallRun = {
      controller: new AbortController(),
      voices: plan.voices,
      hadCompleteInstall: existing !== null,
      abortReason: null
    }
    running = run
    const settled = runInstall(plan, run)
    run.settled = settled.then(
      () => undefined,
      () => undefined
    )
    try {
      return await settled
    } finally {
      running = null
    }
  })

  ipcMain.handle('speech:kokoro:cancel', (): boolean => {
    if (!running) return false
    running.abortReason = 'cancel'
    running.controller.abort()
    return true
  })

  // AC-9: reclaim the disk and return to the pre-download state. A running
  // install is cancelled first, so remove can never race the downloader.
  ipcMain.handle('speech:kokoro:remove', async (): Promise<KokoroStatus> => {
    // Abort first, then WAIT for the download to actually stop. Deleting the
    // directory while a stream is still writing would recreate it chunk by
    // chunk and leave orphaned files behind a "removed" status (AC-9).
    const inflight = running
    if (inflight) inflight.abortReason = 'cancel'
    inflight?.controller.abort()
    await inflight?.settled
    await removeDir(installRoot())
    return status(null, false)
  })
}

/**
 * Stop an in-flight download on quit, next to `killAllSpeech`.
 *
 * Marked `quit`, not `cancel`: the partial files stay on disk and the next
 * launch resumes them. Quitting the app is not a request to discard a 92 MB
 * download.
 */
export function cancelKokoroInstall(): void {
  if (!running) return
  running.abortReason = 'quit'
  running.controller.abort()
}
