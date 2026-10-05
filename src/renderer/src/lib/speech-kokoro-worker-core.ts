/**
 * The pure request/response logic `speech-kokoro-worker.ts` runs inside the
 * dedicated Worker (BUG-117) — split out so it is testable with a fake
 * {@link KokoroLoader} and never a real `self`/`postMessage`/thread boundary,
 * matching this codebase's pure-core / thin-shell convention.
 */

import {
  bootKokoroEngine,
  type KokoroLoader,
  type KokoroRuntimeConfig,
  type KokoroTts
} from './speech-kokoro-env'

export interface KokoroWorkerRequest {
  id: number
  runtime: KokoroRuntimeConfig
  text: string
  voice: string
}

export interface KokoroWorkerSuccess {
  id: number
  ok: true
  audio: Float32Array
  samplingRate: number
}

export interface KokoroWorkerFailure {
  id: number
  ok: false
  message: string
}

export type KokoroWorkerResponse = KokoroWorkerSuccess | KokoroWorkerFailure

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Build the request handler for one worker's lifetime. `engine` is captured in
 * this closure exactly like the pre-BUG-117 `speak()` captured it: a boot
 * failure clears it (so a later retry, after an install, reloads); a
 * `generate()` failure after a successful boot does not (a transient synthesis
 * error shouldn't force a full model reload for the next utterance).
 */
export function createKokoroWorkerHandler(
  loader: KokoroLoader
): (request: KokoroWorkerRequest) => Promise<KokoroWorkerResponse> {
  let engine: Promise<KokoroTts> | null = null

  return async function handle(request: KokoroWorkerRequest): Promise<KokoroWorkerResponse> {
    let tts: KokoroTts
    try {
      engine ??= bootKokoroEngine(loader, request.runtime)
      tts = await engine
    } catch (err) {
      engine = null
      return { id: request.id, ok: false, message: messageOf(err) }
    }

    try {
      const audio = await tts.generate(request.text, { voice: request.voice })
      return { id: request.id, ok: true, audio: audio.audio, samplingRate: audio.sampling_rate }
    } catch (err) {
      return { id: request.id, ok: false, message: messageOf(err) }
    }
  }
}
