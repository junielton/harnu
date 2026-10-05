/**
 * BUG-117: the dedicated Worker that keeps Kokoro synthesis off the renderer's
 * UI thread.
 *
 * `kokoro-js` + `@huggingface/transformers` run entirely in here, loaded by
 * the same dynamic `import()` from the `harnu-voice://` mirror the renderer
 * thread used to do directly — still nothing bundled, still nothing
 * `package.json` names, still asserted by `scripts/ci/voice-licence-gate.mjs`
 * (a Worker script is part of the renderer bundle same as any other chunk; the
 * gate scans the built artifact, not which thread requests it).
 *
 * The only thing running on the main thread now is `speech-kokoro.ts`'s
 * request/response plumbing — it hands this Worker a piece of text and gets
 * back a `Float32Array` to hand to WebAudio. Session creation and `generate()`
 * — the synchronous WASM compute that used to freeze every session's terminal
 * for the duration of an utterance — both happen here instead.
 *
 * This file is the thin, untestable shell (`self`/`postMessage`, no jsdom
 * equivalent in this project's `node`-environment test runner — see
 * `vitest.config.mts`'s coverage excludes). Every actual decision — the
 * request/response contract, the cached-engine lifecycle, error
 * classification — lives in `speech-kokoro-worker-core.ts` and is unit-tested
 * there with a fake loader.
 */

import { createKokoroWorkerHandler, type KokoroWorkerRequest } from './speech-kokoro-worker-core'
import type { KokoroLoader } from './speech-kokoro-env'

const realLoader: KokoroLoader = {
  // `@vite-ignore` because the URL is a runtime value pointing at a file in
  // userData — there is nothing for the bundler to resolve, and trying would
  // pull the very packages this card must not bundle into the worker chunk.
  load: (url) => import(/* @vite-ignore */ url)
}

const handle = createKokoroWorkerHandler(realLoader)

self.onmessage = async (event: MessageEvent<KokoroWorkerRequest>) => {
  const response = await handle(event.data)
  if (response.ok) {
    self.postMessage(response, { transfer: [response.audio.buffer] })
  } else {
    self.postMessage(response)
  }
}
