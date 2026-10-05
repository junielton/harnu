import { SpeechError, type SpeechBackend, type SpeechUtterance } from './speech-backend'
import { resolveKokoroVoice } from './speech-kokoro-voices'
import type { KokoroRuntimeConfig, RawAudioLike } from './speech-kokoro-env'
import type {
  KokoroWorkerRequest,
  KokoroWorkerResponse,
  KokoroWorkerSuccess
} from './speech-kokoro-worker-core'

export type { KokoroRuntimeConfig, RawAudioLike }

/**
 * The Kokoro speech backend (T241) — a downloaded, offline neural voice.
 *
 * It implements the same {@link SpeechBackend} seam T237 defined, so the queue,
 * the mute, the focus gate and every caller are untouched: this module only
 * knows how a string becomes audio.
 *
 * ## What actually runs, and where (BUG-117)
 *
 * `kokoro-js` (transformers.js + ONNX over WASM) executes inside a **dedicated
 * Worker** (`speech-kokoro-worker.ts`), loaded there by dynamic `import()` from
 * the `harnu-voice://` mirror in `userData`. This file only sends text across
 * and receives an audio buffer back — it never boots the engine or calls
 * `generate()` itself. Before BUG-117 all of that ran synchronously on the
 * renderer's own UI thread, which froze every session's terminal (not just the
 * one speaking) for the duration of each utterance.
 *
 * None of it is bundled: `package.json` never names these packages, and
 * `scripts/ci/voice-licence-gate.mjs` fails the build if `kokoro-js` or
 * `phonemizer` ever reaches the packaged artifact (the Worker chunk is scanned
 * same as any other). That is the whole point of ADR-0012 option C —
 * `phonemizer` inlines a GPLv3 espeak-ng, so Harnu must not distribute it; the
 * operator downloads it to their own machine.
 *
 * ## What this backend will never do
 *
 * **Start a download.** Selecting this backend with nothing installed reports
 * `model-missing` and stays silent. A ~119 MB fetch happens only when the
 * operator explicitly asks for it, through `window.api.speechKokoroInstall`
 * (AC-3). There is no lazy first-use trigger anywhere in this file.
 *
 * ## English only
 *
 * `kokoro-js` hardcodes `en-us`/`en-gb`. See `speech-kokoro-voices.ts` — the
 * catalog says so in data rather than letting a caller pick a voice that would
 * come out as English phonemes with Portuguese spelling (AC-8).
 */

export interface KokoroInstallSnapshot {
  installed: boolean
  runtime: KokoroRuntimeConfig
  manifest: { voices: string[] } | null
}

/** The seam onto the preload bridge — injected in tests, defaulted in the app. */
export interface KokoroPort {
  status(): Promise<KokoroInstallSnapshot>
}

/** Playback seam. WebAudio in the app, a fake in tests. */
export interface KokoroAudioSink {
  play(audio: RawAudioLike, signal: AbortSignal): Promise<void>
}

/**
 * The seam onto the dedicated Worker (BUG-117) — a real `Worker` in the app,
 * a fake in tests. Deliberately the narrowest slice `speak()` needs: a real
 * `Worker`'s richer type satisfies this structurally, so production code never
 * casts.
 */
export interface KokoroWorkerLike {
  postMessage(message: KokoroWorkerRequest): void
  onmessage: ((event: MessageEvent<KokoroWorkerResponse>) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
  terminate(): void
}

export interface KokoroBackendOptions {
  port?: KokoroPort
  sink?: KokoroAudioSink
  /** Builds the Worker the backend talks to. Injected in tests; a real `Worker` in the app. */
  workerFactory?: () => KokoroWorkerLike
  /**
   * Voice id, or a GETTER read fresh on every utterance.
   *
   * The app passes a getter (T239). Passing a fixed string would mean the Voice
   * pane had to rebuild the backend to change voice, and rebuilding discards the
   * cached Worker below — a full model reload for a setting `generate()`
   * already takes per call. Either form is coerced by `resolveKokoroVoice`, so
   * a stale or unknown id still falls back to `af_heart` rather than asking for
   * an embedding that was never downloaded.
   */
  voice?: string | (() => string | undefined)
}

/** The slice of `window.api` this backend needs (see `src/preload/index.ts`). */
interface KokoroBridge {
  speechKokoroStatus(): Promise<KokoroInstallSnapshot>
}

function bridgePort(): KokoroPort | null {
  const api = (globalThis as { window?: { api?: Partial<KokoroBridge> } }).window?.api
  if (!api || typeof api.speechKokoroStatus !== 'function') return null
  const { speechKokoroStatus } = api as KokoroBridge
  return { status: () => speechKokoroStatus() }
}

/**
 * The real Worker, module-typed so it dynamic-imports the mirror the same way
 * `bridgePort` used to. `new URL(..., import.meta.url)` is Vite's documented
 * pattern for bundling a Worker as its own chunk (`electron.vite.config.ts`
 * sets `renderer.worker.format: 'es'` so the chunk stays an ES module, matching
 * `{ type: 'module' }` here).
 */
function createRealKokoroWorker(): KokoroWorkerLike {
  return new Worker(new URL('./speech-kokoro-worker.ts', import.meta.url), { type: 'module' })
}

/**
 * WebAudio playback. Resolves when the buffer finishes, or as soon as the
 * signal aborts — the service discards an aborted utterance either way, and the
 * mute must be instant.
 */
export function createWebAudioSink(): KokoroAudioSink {
  let context: AudioContext | null = null
  return {
    async play(audio, signal) {
      const Ctor = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext
      if (!Ctor) throw new SpeechError('audio-unavailable', 'no AudioContext in this window')
      context ??= new Ctor()
      if (context.state === 'suspended') await context.resume()
      const buffer = context.createBuffer(1, audio.audio.length, audio.sampling_rate)
      // Copy into a plainly-backed Float32Array: `RawAudio` is typed over
      // ArrayBufferLike (it may be SharedArrayBuffer), which `copyToChannel`
      // does not accept.
      buffer.copyToChannel(Float32Array.from(audio.audio), 0)
      const source = context.createBufferSource()
      source.buffer = buffer
      source.connect(context.destination)
      await new Promise<void>((resolve) => {
        const stop = (): void => {
          try {
            source.stop()
          } catch {
            // Already stopped or never started — not an error.
          }
          resolve()
        }
        signal.addEventListener('abort', stop, { once: true })
        source.onended = () => {
          signal.removeEventListener('abort', stop)
          resolve()
        }
        source.start()
      })
    }
  }
}

/**
 * Classify a failure out of the engine. The service reports codes, never raw
 * exception text — a missing download and a broken model are different problems
 * with different fixes, and the operator has to be able to tell them apart.
 */
export function kokoroErrorFrom(err: unknown): SpeechError {
  if (err instanceof SpeechError) return err
  const detail = err instanceof Error ? err.message : String(err)
  return new SpeechError('engine-unavailable', detail)
}

interface PendingRequest {
  resolve(response: KokoroWorkerSuccess): void
  reject(err: unknown): void
}

export function createKokoroBackend(options: KokoroBackendOptions = {}): SpeechBackend {
  let sink: KokoroAudioSink | null = options.sink ?? null
  let worker: KokoroWorkerLike | null = null
  let nextRequestId = 0
  const pending = new Map<number, PendingRequest>()

  /** Resolved per utterance — see {@link KokoroBackendOptions.voice}. */
  function currentVoice(): string {
    return resolveKokoroVoice(typeof options.voice === 'function' ? options.voice() : options.voice)
  }

  /** Fail every in-flight request and drop the worker so the next call gets a fresh one. */
  function failAll(err: unknown): void {
    for (const request of pending.values()) request.reject(err)
    pending.clear()
    worker = null
  }

  /**
   * Get (or create) the Worker this backend talks to. Cached, so N utterances
   * queued behind a cold start share one Worker — and, inside it, one ~92 MB
   * model load — rather than each spawning their own (see
   * `speech-kokoro-worker-core.ts`'s own `engine` cache for the model half of
   * this).
   */
  function ensureWorker(): KokoroWorkerLike {
    if (worker) return worker
    const w = options.workerFactory ? options.workerFactory() : createRealKokoroWorker()
    w.onmessage = (event) => {
      const response = event.data
      const request = pending.get(response.id)
      if (!request) return
      pending.delete(response.id)
      if (response.ok) request.resolve(response)
      else request.reject(new SpeechError('engine-unavailable', response.message))
    }
    // An uncaught failure in the worker itself (e.g. its script failed to
    // load) — fail whatever was waiting rather than hang forever, and let the
    // NEXT speak() spawn a fresh worker instead of reusing a dead one.
    w.onerror = (event) => {
      failAll(new SpeechError('engine-unavailable', event.message || 'kokoro worker crashed'))
    }
    worker = w
    return w
  }

  function requestSynthesis(
    runtime: KokoroRuntimeConfig,
    text: string,
    voice: string
  ): Promise<KokoroWorkerSuccess> {
    const w = ensureWorker()
    const id = ++nextRequestId
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      w.postMessage({ id, runtime, text, voice })
    })
  }

  return {
    id: 'kokoro',
    async speak(utterance: SpeechUtterance, signal: AbortSignal): Promise<void> {
      if (signal.aborted) return

      const port = options.port ?? bridgePort()
      if (!port)
        throw new SpeechError('bridge-unavailable', 'window.api.speechKokoroStatus is missing')

      let snapshot: KokoroInstallSnapshot
      try {
        snapshot = await port.status()
        if (!snapshot.installed) {
          throw new SpeechError('model-missing', 'the offline voice has not been downloaded')
        }
      } catch (err) {
        throw kokoroErrorFrom(err)
      }
      if (signal.aborted) return

      let result: KokoroWorkerSuccess
      try {
        result = await requestSynthesis(snapshot.runtime, utterance.text, currentVoice())
      } catch (err) {
        throw kokoroErrorFrom(err)
      }
      if (signal.aborted) return

      sink ??= createWebAudioSink()
      try {
        await sink.play({ audio: result.audio, sampling_rate: result.samplingRate }, signal)
      } catch (err) {
        throw kokoroErrorFrom(err)
      }
    }
  }
}
