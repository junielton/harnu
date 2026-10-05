/**
 * The pure, thread-agnostic half of the Kokoro engine (BUG-117): everything
 * about *how* `kokoro-js` turns text into audio, with no opinion on which
 * thread runs it.
 *
 * `speech-kokoro.ts` (the renderer's UI thread) and `speech-kokoro-worker-core.ts`
 * (the dedicated Worker BUG-117 introduced) both import this module — it is the
 * one place `applyKokoroEnv` and the boot sequence are defined, so the two
 * threads can never drift into configuring the engine differently.
 */

/** Minimal shape of the `KokoroTTS` class we load out of the mirror. */
export interface KokoroModule {
  KokoroTTS: {
    from_pretrained(
      modelId: string,
      opts: { dtype: string; device: string | null }
    ): Promise<KokoroTts>
  }
  env: { wasmPaths: string }
}

export interface KokoroTts {
  generate(text: string, opts: { voice: string; speed?: number }): Promise<RawAudioLike>
}

export interface RawAudioLike {
  audio: Float32Array
  sampling_rate: number
}

/** The transformers.js `env` we have to point at the local mirror. */
export interface TransformersEnv {
  remoteHost: string
  remotePathTemplate: string
  allowLocalModels: boolean
  allowRemoteModels: boolean
  useBrowserCache: boolean
  backends: { onnx: { wasm: { wasmPaths: string; numThreads: number; proxy: boolean } } }
}

/** Mirrors `KokoroRuntimeConfig` in `src/main/speech-kokoro-plan.ts`. */
export interface KokoroRuntimeConfig {
  entryUrl: string
  transformersUrl: string
  wasmPaths: string
  remoteHost: string
  remotePathTemplate: string
  modelId: string
  dtype: string
}

/** Load an ES module by URL. Injected so tests never touch a real import. */
export interface KokoroLoader {
  load(url: string): Promise<unknown>
}

/**
 * The runtime settings transformers.js needs to stay off the network — and, as
 * important, off whichever thread calls `generate()`.
 *
 * `numThreads` and `proxy` are two different mechanisms, and BUG-117 is the
 * reason they must never be conflated again:
 *
 * - `numThreads: 1` disables onnxruntime-web's **internal** multi-threaded WASM
 *   pool. That pool needs `SharedArrayBuffer`, which needs `crossOriginIsolated`,
 *   which a `file://` renderer is not. onnxruntime-web would fall back to 1
 *   thread on its own; pinning it here just makes that a decision instead of a
 *   console warning.
 * - `proxy` would additionally hand the WASM binding itself — session creation
 *   *and* `generate()` — to a worker THAT ONNXRUNTIME-WEB SPAWNS ITSELF, by
 *   reloading its own module (`new Worker(new URL(import.meta.url))`) under a
 *   **different** file than the one this env applies to
 *   (`onnxruntime-web`'s own `dist/ort.bundle.min.mjs`, not the
 *   `@huggingface/transformers`-bundled `ort-wasm-*.jsep.mjs` this install
 *   actually downloads). That file was never part of the download plan, so
 *   `proxy: true` fails outright — measured live against a real install as
 *   `no available backend found. ERR: [wasm] [object Event]` — for every voice
 *   already on an operator's disk, not just a hypothetical edge case.
 *
 * So `proxy` stays `false` here. What actually keeps `generate()` off the
 * renderer's UI thread is that this whole module now runs **inside a
 * dedicated Worker we own** (`speech-kokoro-worker.ts`) instead of on the
 * caller's thread — see that file's module doc.
 */
export function applyKokoroEnv(env: TransformersEnv, runtime: KokoroRuntimeConfig): void {
  env.remoteHost = runtime.remoteHost
  env.remotePathTemplate = runtime.remotePathTemplate
  env.allowLocalModels = false
  env.allowRemoteModels = true
  env.useBrowserCache = false
  env.backends.onnx.wasm.wasmPaths = runtime.wasmPaths
  env.backends.onnx.wasm.numThreads = 1
  env.backends.onnx.wasm.proxy = false
}

/**
 * Load the engine once. Callers cache the returned promise (see
 * `speech-kokoro-worker-core.ts`'s `engine` closure) so N utterances queued
 * behind a cold start share one ~92 MB model load rather than racing, and a
 * failed load can be retried after an install completes.
 */
export async function bootKokoroEngine(
  loader: KokoroLoader,
  runtime: KokoroRuntimeConfig
): Promise<KokoroTts> {
  const mod = (await loader.load(runtime.entryUrl)) as KokoroModule
  // transformers.js is already in the module graph the mirror served; reach
  // its `env` through the same origin so both halves share one instance.
  const transformers = (await loader.load(runtime.transformersUrl)) as { env: TransformersEnv }
  applyKokoroEnv(transformers.env, runtime)
  mod.env.wasmPaths = runtime.wasmPaths
  return mod.KokoroTTS.from_pretrained(runtime.modelId, {
    dtype: runtime.dtype,
    device: 'wasm'
  })
}
