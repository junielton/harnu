/**
 * The pure core of the Kokoro voice download (T241, ADR-0012 option C).
 *
 * ADR-0012 accepted **option C: runtime opt-in download, nothing in the
 * installer**. The load-bearing consequence — and the reason this module exists
 * at all — is that the download has to fetch the **code** as well as the
 * weights. The dangerous artifact is not the 92 MB of Apache-2.0 weights; it is
 * `phonemizer`, a small npm package that inlines a compiled espeak-ng (GPLv3).
 * Bundling the library and downloading only the model is option B wearing a
 * disguise, and it relicenses Harnu's shipped binary as GPLv3.
 *
 * So: `kokoro-js`, `phonemizer`, `@huggingface/transformers`, the ONNX runtime
 * and the weights are ALL fetched at runtime into `userData`, and none of them
 * appears in `package.json` or in the packaged build. `scripts/ci/voice-licence-gate.mjs`
 * asserts that against the built artifact on every CI run.
 *
 * Everything here is pure: the manifest, the byte accounting, the mirror path
 * derivation, the resume arithmetic, the rewrite rules and the URL→file
 * resolution. The env-bound half (fetch, fs, `protocol.handle`, IPC) is
 * `speech-kokoro.ts`, which is the shell ADR-0001 lets us keep out of coverage.
 *
 * ## How the mirror works
 *
 * The renderer cannot `require` an npm package, and a browser cannot resolve a
 * bare specifier. jsDelivr's `/+esm` endpoint solves both: it serves each
 * package as a browser-ready ES module whose only imports are **root-relative
 * `/npm/...` paths**. Mirroring that path space verbatim under the install root
 * and serving it from a custom scheme means the import graph resolves offline
 * with no bundler, no import map and no specifier rewriting:
 *
 *   harnu-voice://kokoro/npm/kokoro-js@1.2.1/+esm
 *     └─ imports "/npm/phonemizer@1.2.1/+esm"  →  harnu-voice://kokoro/npm/phonemizer@1.2.1/+esm
 *
 * The one thing that does need rewriting is a hardcoded `huggingface.co` URL in
 * `kokoro-js`'s voice loader — see {@link KOKORO_REWRITES}.
 */

/** Custom scheme the mirror is served from. Registered as privileged in `index.ts`. */
export const KOKORO_PROTOCOL = 'harnu-voice'

/** Single host under that scheme, so a root-relative `/npm/...` import resolves. */
export const KOKORO_HOST = 'kokoro'

export const KOKORO_ORIGIN = `${KOKORO_PROTOCOL}://${KOKORO_HOST}`

/**
 * The scheme installs made before the Capy → Harnu rename baked into the
 * mirrored `kokoro-js` entry file (see {@link KOKORO_REWRITES}). Still registered
 * and served by the same handler so those installs keep playing offline, and
 * rewritten away on disk by {@link migrateLegacyKokoroOrigin}.
 */
export const KOKORO_LEGACY_PROTOCOL = 'capy-voice'

const KOKORO_LEGACY_ORIGIN = `${KOKORO_LEGACY_PROTOCOL}://${KOKORO_HOST}`

/** Directory under `userData` holding the whole download. Removing it uninstalls (AC-9). */
export const KOKORO_INSTALL_DIR = 'voice-kokoro'

/** In-progress downloads live here and are wiped on cancel (AC-5). */
export const KOKORO_STAGING_DIR = '.staging'

/** Written last, and only on success — its absence means "not installed" (AC-5). */
export const KOKORO_MANIFEST_FILE = 'install.json'

/** Bumped when the layout or the pinned versions change incompatibly. */
export const KOKORO_INSTALL_VERSION = 1

/**
 * Everything version-shaped, pinned in one place. A floating version would make
 * the licence gate, the byte counts and the rewrite assertion all drift.
 */
export const KOKORO_PIN = {
  kokoro: '1.2.1',
  transformers: '3.5.1',
  modelId: 'onnx-community/Kokoro-82M-v1.0-ONNX',
  revision: 'main',
  /** q8 — 92.4 MB, the sensible default (fp32 is 326 MB for no audible gain here). */
  dtype: 'q8',
  modelFile: 'onnx/model_quantized.onnx',
  defaultVoice: 'af_heart'
} as const

/** jsDelivr serves the `/+esm` graph; the model and voices come from the Hub. */
export const KOKORO_CDN_ORIGIN = 'https://cdn.jsdelivr.net'
export const KOKORO_HUB_ORIGIN = 'https://huggingface.co'

/** The entry point of the `/npm/...` mirror — the crawl seed and the import URL. */
export const KOKORO_ENTRY_PATH = `/npm/kokoro-js@${KOKORO_PIN.kokoro}/+esm`

/** Where onnxruntime-web looks for its WASM, once we point `wasmPaths` at it. */
export const KOKORO_ORT_DIR = `/npm/@huggingface/transformers@${KOKORO_PIN.transformers}/dist/`

/** Local stand-in for `https://huggingface.co/` in transformers.js's `env.remoteHost`. */
export const KOKORO_HUB_MIRROR_PREFIX = '/hf/'

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

export type KokoroAssetKind = 'code' | 'runtime' | 'model' | 'voice' | 'meta'

export interface KokoroAsset {
  /** Mirror path, always starting with `/`. Doubles as the served URL path. */
  path: string
  /** Absolute URL to fetch it from. */
  url: string
  kind: KokoroAssetKind
  /**
   * Exact size in bytes when it is known ahead of time (verified against the
   * upstream metadata on 2026-09-03), `null` for the crawled code tier whose
   * membership is only known once the graph is walked.
   */
  bytes: number | null
}

/**
 * The `/npm/...` graph is discovered, not enumerated: the crawl starts at
 * {@link KOKORO_ENTRY_PATH} and follows every root-relative import. Measured at
 * 5 files / ~2.24 MB on 2026-09-03; the caps below are the blast radius if
 * upstream ever restructures, not a prediction.
 */
export const KOKORO_CODE_MAX_FILES = 32
export const KOKORO_CODE_MAX_BYTES = 16 * 1024 * 1024
/** What the consent step quotes for the code tier, since it cannot be exact. */
export const KOKORO_CODE_APPROX_BYTES = 2_400_000

/** Sizes verified against jsDelivr and the Hub file listing on 2026-09-03. */
const ORT_MJS_BYTES = 44_484
const ORT_WASM_BYTES = 21_596_019
const MODEL_Q8_BYTES = 92_361_116
const VOICE_BYTES = 522_240

/** Every voice embedding is the same fixed size — 511 KB of style vectors. */
export const KOKORO_VOICE_BYTES = VOICE_BYTES

function hubAsset(file: string, kind: KokoroAssetKind, bytes: number | null): KokoroAsset {
  return {
    path: `${KOKORO_HUB_MIRROR_PREFIX}${KOKORO_PIN.modelId}/${file}`,
    url: `${KOKORO_HUB_ORIGIN}/${KOKORO_PIN.modelId}/resolve/${KOKORO_PIN.revision}/${file}`,
    kind,
    bytes
  }
}

/**
 * The ONNX runtime binary. transformers.js otherwise points `wasmPaths` at
 * jsDelivr at first inference — which would make "works offline" a lie the
 * first time the operator is on a plane.
 */
export function kokoroRuntimeAssets(): KokoroAsset[] {
  return [
    {
      path: `${KOKORO_ORT_DIR}ort-wasm-simd-threaded.jsep.mjs`,
      url: `${KOKORO_CDN_ORIGIN}${KOKORO_ORT_DIR}ort-wasm-simd-threaded.jsep.mjs`,
      kind: 'runtime',
      bytes: ORT_MJS_BYTES
    },
    {
      path: `${KOKORO_ORT_DIR}ort-wasm-simd-threaded.jsep.wasm`,
      url: `${KOKORO_CDN_ORIGIN}${KOKORO_ORT_DIR}ort-wasm-simd-threaded.jsep.wasm`,
      kind: 'runtime',
      bytes: ORT_WASM_BYTES
    }
  ]
}

/** Config + tokenizer + the q8 weights. The 92 MB everybody thinks is the problem. */
export function kokoroModelAssets(): KokoroAsset[] {
  return [
    hubAsset('config.json', 'meta', 44),
    hubAsset('tokenizer.json', 'meta', 3497),
    hubAsset('tokenizer_config.json', 'meta', 113),
    hubAsset(KOKORO_PIN.modelFile, 'model', MODEL_Q8_BYTES)
  ]
}

/** One small file per voice — the second tier of the download. */
export function kokoroVoiceAssets(voices: readonly string[]): KokoroAsset[] {
  return dedupeVoices(voices).map((id) => hubAsset(`voices/${id}.bin`, 'voice', VOICE_BYTES))
}

/** Voice ids are a path segment; reject anything that isn't the upstream shape. */
export function isKokoroVoiceId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z]{2}_[a-z]+$/.test(value)
}

function dedupeVoices(voices: readonly string[]): string[] {
  const out: string[] = []
  for (const v of voices) {
    if (!isKokoroVoiceId(v)) continue
    if (!out.includes(v)) out.push(v)
  }
  if (out.length === 0) out.push(KOKORO_PIN.defaultVoice)
  return out
}

// ---------------------------------------------------------------------------
// Licences — what the consent step has to say out loud (AC-4, AC-7)
// ---------------------------------------------------------------------------

export interface KokoroLicence {
  component: string
  spdx: string
  holder: string
  url: string
  /** Anything the bare SPDX id would hide. Only `phonemizer` has one, and it matters. */
  note?: string
}

/**
 * The attribution the consent step must surface. `phonemizer`'s entry is the
 * whole point of ADR-0012: it *declares* Apache-2.0 while shipping a compiled
 * espeak-ng, which is GPLv3. Harnu never redistributes those bytes — the
 * operator fetches them to their own machine — but they must be told what they
 * are fetching and under what terms.
 */
export const KOKORO_LICENCES: readonly KokoroLicence[] = Object.freeze([
  {
    component: `kokoro-js@${KOKORO_PIN.kokoro}`,
    spdx: 'Apache-2.0',
    holder: 'hexgrad',
    url: 'https://www.npmjs.com/package/kokoro-js'
  },
  {
    component: `@huggingface/transformers@${KOKORO_PIN.transformers}`,
    spdx: 'Apache-2.0',
    holder: 'Hugging Face',
    url: 'https://www.npmjs.com/package/@huggingface/transformers'
  },
  {
    component: 'onnxruntime-web',
    spdx: 'MIT',
    holder: 'Microsoft',
    url: 'https://www.npmjs.com/package/onnxruntime-web'
  },
  {
    component: `phonemizer@${KOKORO_PIN.kokoro}`,
    spdx: 'Apache-2.0',
    holder: 'Xenova',
    url: 'https://www.npmjs.com/package/phonemizer',
    note:
      'Declares Apache-2.0 but embeds a compiled espeak-ng, which is GPL-3.0-or-later. ' +
      'Harnu never ships these bytes — this download puts them on your machine, for your ' +
      'own use. See docs/adr/0012.'
  },
  {
    component: KOKORO_PIN.modelId,
    spdx: 'Apache-2.0',
    holder: 'hexgrad / onnx-community',
    url: `${KOKORO_HUB_ORIGIN}/${KOKORO_PIN.modelId}`
  }
])

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export interface KokoroInstallPlan {
  voices: string[]
  /** Fixed-size assets, in download order: runtime, then model, then voices. */
  assets: KokoroAsset[]
  /** Sum of the known sizes. */
  exactBytes: number
  /** Estimate for the crawled code tier, which has no size until it is walked. */
  approxBytes: number
  /** What the consent step quotes. Always an approximation — say so when rendering. */
  totalBytes: number
  licences: readonly KokoroLicence[]
  /** Seed of the `/npm/...` crawl. */
  codeSeed: string
}

/**
 * Everything a consent step needs in one object (AC-4): what is fetched, how
 * big it is, and under what terms. Deliberately data, not UI — the Voice
 * settings pane (T239) renders this; this card ships no pane.
 */
export function kokoroInstallPlan(voices: readonly string[] = []): KokoroInstallPlan {
  const wanted = dedupeVoices(voices)
  const assets = [...kokoroRuntimeAssets(), ...kokoroModelAssets(), ...kokoroVoiceAssets(wanted)]
  const exactBytes = assets.reduce((sum, a) => sum + (a.bytes ?? 0), 0)
  return {
    voices: wanted,
    assets,
    exactBytes,
    approxBytes: KOKORO_CODE_APPROX_BYTES,
    totalBytes: exactBytes + KOKORO_CODE_APPROX_BYTES,
    licences: KOKORO_LICENCES,
    codeSeed: KOKORO_ENTRY_PATH
  }
}

// ---------------------------------------------------------------------------
// Crawling the `/+esm` graph
// ---------------------------------------------------------------------------

/**
 * Root-relative `/npm/...` specifiers imported by a `/+esm` module.
 *
 * Anchored on `from` / `import` immediately followed by the quote (minified
 * output has no space) AND on the `/npm/` prefix — the pair is what keeps a
 * `"/npm/..."`-looking substring inside some unrelated string literal out of
 * the graph.
 */
export function extractEsmImports(source: string): string[] {
  const out: string[] = []
  const re = /(?:\bfrom|\bimport)\s*\(?\s*["'](\/npm\/[^"']+)["']/g
  for (const m of source.matchAll(re)) {
    const spec = m[1]
    if (spec && !out.includes(spec)) out.push(spec)
  }
  return out
}

/** Absolute jsDelivr URL for a mirror path. */
export function cdnUrlFor(mirrorPath: string): string {
  return `${KOKORO_CDN_ORIGIN}${mirrorPath}`
}

export interface CrawlGuard {
  files: number
  bytes: number
}

/**
 * Bound the crawl. Upstream restructuring should fail the install loudly rather
 * than quietly pull down an unbounded graph into the operator's `userData`.
 */
export function crawlWithinBudget(guard: CrawlGuard): boolean {
  return guard.files <= KOKORO_CODE_MAX_FILES && guard.bytes <= KOKORO_CODE_MAX_BYTES
}

// ---------------------------------------------------------------------------
// The one rewrite
// ---------------------------------------------------------------------------

export interface KokoroRewrite {
  /** Mirror path of the file to patch. */
  path: string
  find: string
  replace: string
  /** How many occurrences must be found. A mismatch fails the install. */
  expect: number
  why: string
}

/**
 * `kokoro-js` loads a voice embedding from a **hardcoded** `huggingface.co`
 * URL, checking a CacheStorage entry first. That cache is unavailable on the
 * `file://` origin a packaged renderer runs from, so without this the voice
 * fetch would go to the network on every utterance — and fail on a plane, which
 * is the entire point of the feature.
 *
 * So the mirrored copy — the operator's own copy, on their own disk — has that
 * one string pointed at the local mirror. Apache-2.0 permits the modification;
 * the assertion below is what stops it becoming a silent no-op if upstream
 * changes the string.
 */
export const KOKORO_REWRITES: readonly KokoroRewrite[] = Object.freeze([
  {
    path: KOKORO_ENTRY_PATH,
    find: `${KOKORO_HUB_ORIGIN}/${KOKORO_PIN.modelId}/resolve/${KOKORO_PIN.revision}/voices/`,
    replace: `${KOKORO_ORIGIN}${KOKORO_HUB_MIRROR_PREFIX}${KOKORO_PIN.modelId}/voices/`,
    expect: 1,
    why: "kokoro-js's voice loader hardcodes huggingface.co; offline needs the local mirror"
  }
])

/**
 * Point a mirrored file that was written under the old scheme at the current
 * one. Returns the input untouched (same string) when there is nothing to do, so
 * callers can compare by identity before writing.
 */
export function migrateLegacyKokoroOrigin(source: string): string {
  return source.includes(KOKORO_LEGACY_ORIGIN)
    ? source.split(KOKORO_LEGACY_ORIGIN).join(KOKORO_ORIGIN)
    : source
}

export class KokoroRewriteError extends Error {
  constructor(rewrite: KokoroRewrite, found: number) {
    super(
      `voice install: expected ${rewrite.expect} occurrence(s) of "${rewrite.find}" in ` +
        `${rewrite.path}, found ${found}. Upstream changed — the offline voice would ` +
        `silently go to the network, so the install is refused.`
    )
    this.name = 'KokoroRewriteError'
  }
}

/**
 * Apply every rewrite registered for `path`. Throws {@link KokoroRewriteError}
 * when the occurrence count is not what was declared — a rewrite that silently
 * matched nothing is worse than a failed install, because the failure would
 * only surface as "voice doesn't work offline" months later.
 */
export function applyKokoroRewrites(path: string, source: string): string {
  let out = source
  for (const rule of KOKORO_REWRITES) {
    if (rule.path !== path) continue
    const found = out.split(rule.find).length - 1
    if (found !== rule.expect) throw new KokoroRewriteError(rule, found)
    out = out.split(rule.find).join(rule.replace)
  }
  return out
}

// ---------------------------------------------------------------------------
// Serving the mirror
// ---------------------------------------------------------------------------

/** Top-level directories the protocol will serve. Anything else is a 404. */
const SERVED_ROOTS = ['npm', 'hf']

/**
 * Map a `harnu-voice://kokoro/<path>` request onto a file under the install
 * root, or `null` when it must not be served.
 *
 * The renderer is sandboxed and this handler runs in main, so a traversal here
 * would read arbitrary files with the app's privileges. Rejected: absent or
 * relative paths, `.`/`..` segments (before AND after decoding), NUL bytes,
 * anything outside the two served roots, and — belt and braces — any result
 * that does not stay under `root` after joining.
 *
 * `join` is injected so the rule is testable on both path flavours without
 * touching `node:path` from a pure module.
 */
export function resolveKokoroAssetPath(
  root: string,
  pathname: string,
  join: (...parts: string[]) => string = (...parts) => parts.join('/')
): string | null {
  if (!root || typeof pathname !== 'string' || !pathname.startsWith('/')) return null
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null
  const segments = decoded.slice(1).split('/')
  if (segments.length < 2) return null
  if (!SERVED_ROOTS.includes(segments[0] as string)) return null
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') return null
  }
  const resolved = join(root, ...segments)
  const prefix = root.endsWith('/') ? root : `${root}/`
  if (!resolved.startsWith(prefix) && !resolved.startsWith(`${root}\\`)) return null
  return resolved
}

/** Content type for a mirrored file. `+esm` has no extension and must be JS. */
export function kokoroContentType(pathname: string): string {
  if (pathname.endsWith('/+esm')) return 'text/javascript'
  if (pathname.endsWith('.mjs') || pathname.endsWith('.js')) return 'text/javascript'
  if (pathname.endsWith('.wasm')) return 'application/wasm'
  if (pathname.endsWith('.json')) return 'application/json'
  return 'application/octet-stream'
}

// ---------------------------------------------------------------------------
// Resume / cancel arithmetic (AC-5)
// ---------------------------------------------------------------------------

export interface ResumeDecision {
  /** `'fresh'` starts at 0, `'range'` continues, `'done'` needs no request. */
  mode: 'fresh' | 'range' | 'done'
  /** First byte to request; only meaningful for `'range'`. */
  offset: number
}

/**
 * What to do with a `.part` file left by an interrupted download.
 *
 * An interruption (crash, quit, network drop) leaves the partial on disk and
 * the next install resumes it. A **cancel** does not: it deletes the partials
 * (see {@link cancelCleanupTargets}), because AC-5 says a cancel leaves nothing
 * behind. Those two are deliberately different, and this is the seam where the
 * difference lives.
 *
 * A partial larger than the expected size is a corrupt or stale file — start
 * over rather than resume into a wrong offset.
 */
export function resumeDecision(partialBytes: number, expectedBytes: number | null): ResumeDecision {
  const have = Number.isFinite(partialBytes) && partialBytes > 0 ? Math.floor(partialBytes) : 0
  if (have <= 0) return { mode: 'fresh', offset: 0 }
  if (expectedBytes === null) return { mode: 'fresh', offset: 0 }
  if (have > expectedBytes) return { mode: 'fresh', offset: 0 }
  if (have === expectedBytes) return { mode: 'done', offset: expectedBytes }
  return { mode: 'range', offset: have }
}

/** `Range` header for a resumed download. */
export function rangeHeader(offset: number): string {
  return `bytes=${Math.max(0, Math.floor(offset))}-`
}

/** Why an in-flight download stopped. Only one of these deletes anything. */
export type KokoroAbortReason = 'cancel' | 'quit' | 'failure'

/**
 * What an aborted download deletes.
 *
 * A **cancel** deletes: AC-5 says a cancel leaves no partial file and no
 * half-installed module, and a half-populated mirror is exactly that. On a first
 * install that means the whole directory; on an addition to a working install
 * only the staging area, so cancelling an extra voice can never destroy the
 * voice the operator already had.
 *
 * A **quit** and a **failure** delete nothing. Neither is a request to throw the
 * download away — the `.part` files are what let the next run resume instead of
 * re-fetching 92 MB. `install.json` is written last, so an interrupted download
 * still reads as "not installed" rather than as a broken one.
 */
export function abortCleanupTargets(
  reason: KokoroAbortReason,
  hadCompleteInstall: boolean
): ('root' | 'staging')[] {
  if (reason !== 'cancel') return []
  return hadCompleteInstall ? ['staging'] : ['root']
}

// ---------------------------------------------------------------------------
// Install manifest
// ---------------------------------------------------------------------------

export interface KokoroInstallManifest {
  version: number
  kokoro: string
  transformers: string
  modelId: string
  modelFile: string
  voices: string[]
  bytes: number
  installedAt: string
}

export function buildInstallManifest(
  voices: readonly string[],
  bytes: number,
  now: Date
): KokoroInstallManifest {
  return {
    version: KOKORO_INSTALL_VERSION,
    kokoro: KOKORO_PIN.kokoro,
    transformers: KOKORO_PIN.transformers,
    modelId: KOKORO_PIN.modelId,
    modelFile: KOKORO_PIN.modelFile,
    voices: dedupeVoices(voices),
    bytes: Math.max(0, Math.floor(bytes)),
    installedAt: now.toISOString()
  }
}

/**
 * Parse `install.json`. Anything unreadable, from a different layout version,
 * or pinned to different upstream versions reads as **not installed** — the
 * mirror on disk would not match what this build expects to import.
 */
export function parseInstallManifest(raw: string | null): KokoroInstallManifest | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const o = parsed as Record<string, unknown>
  if (o.version !== KOKORO_INSTALL_VERSION) return null
  if (o.kokoro !== KOKORO_PIN.kokoro) return null
  if (o.transformers !== KOKORO_PIN.transformers) return null
  if (o.modelId !== KOKORO_PIN.modelId) return null
  const voices = Array.isArray(o.voices) ? o.voices.filter(isKokoroVoiceId) : []
  if (voices.length === 0) return null
  return {
    version: KOKORO_INSTALL_VERSION,
    kokoro: KOKORO_PIN.kokoro,
    transformers: KOKORO_PIN.transformers,
    modelId: KOKORO_PIN.modelId,
    modelFile: typeof o.modelFile === 'string' ? o.modelFile : KOKORO_PIN.modelFile,
    voices,
    bytes: typeof o.bytes === 'number' && Number.isFinite(o.bytes) ? o.bytes : 0,
    installedAt: typeof o.installedAt === 'string' ? o.installedAt : ''
  }
}

/** Which of `wanted` still has to be fetched. Empty means nothing to download. */
export function missingVoices(
  manifest: KokoroInstallManifest | null,
  wanted: readonly string[]
): string[] {
  const have = new Set(manifest?.voices ?? [])
  return dedupeVoices(wanted).filter((v) => !have.has(v))
}

// ---------------------------------------------------------------------------
// What the renderer is told
// ---------------------------------------------------------------------------

/**
 * The URLs and transformers.js settings the backend needs. Main owns these —
 * the renderer never derives a path into `userData` itself, and there is
 * exactly one source of truth for the pinned versions.
 */
export interface KokoroRuntimeConfig {
  entryUrl: string
  /** transformers.js, reached by its mirror URL so both halves share one instance. */
  transformersUrl: string
  wasmPaths: string
  remoteHost: string
  remotePathTemplate: string
  modelId: string
  dtype: string
}

export function kokoroRuntimeConfig(): KokoroRuntimeConfig {
  return {
    entryUrl: `${KOKORO_ORIGIN}${KOKORO_ENTRY_PATH}`,
    transformersUrl: `${KOKORO_ORIGIN}/npm/@huggingface/transformers@${KOKORO_PIN.transformers}/+esm`,
    wasmPaths: `${KOKORO_ORIGIN}${KOKORO_ORT_DIR}`,
    remoteHost: `${KOKORO_ORIGIN}${KOKORO_HUB_MIRROR_PREFIX}`,
    remotePathTemplate: '{model}/',
    modelId: KOKORO_PIN.modelId,
    dtype: KOKORO_PIN.dtype
  }
}

/** What `speech:kokoro:status` answers. The renderer's whole view of the install. */
export interface KokoroStatus {
  installed: boolean
  /** Present only once an install has completed. */
  manifest: KokoroInstallManifest | null
  /** A download is running right now. */
  installing: boolean
  /** Where it all lives, so a settings pane can show it (AC-4). */
  directory: string
  runtime: KokoroRuntimeConfig
}

export interface KokoroProgress {
  phase: 'code' | 'runtime' | 'model' | 'voice' | 'verifying' | 'done' | 'cancelled' | 'failed'
  /** Mirror path of whatever is being fetched. */
  asset: string
  receivedBytes: number
  /** Best known total; grows as the crawled tier is discovered. */
  totalBytes: number
  error?: string
}

/**
 * Progress fraction, clamped. Reported separately from the raw byte counts so a
 * UI never has to guard against a `totalBytes` of 0 on the first tick.
 */
export function progressFraction(received: number, total: number): number {
  if (!Number.isFinite(received) || !Number.isFinite(total) || total <= 0) return 0
  return Math.min(1, Math.max(0, received / total))
}
