import { describe, it, expect } from 'vitest'
import {
  createKokoroWorkerHandler,
  type KokoroWorkerRequest
} from '../src/renderer/src/lib/speech-kokoro-worker-core'
import type { KokoroLoader, TransformersEnv } from '../src/renderer/src/lib/speech-kokoro-env'

const runtime = {
  entryUrl: 'harnu-voice://kokoro/npm/kokoro-js@1.2.1/+esm',
  transformersUrl: 'harnu-voice://kokoro/npm/@huggingface/transformers@3.5.1/+esm',
  wasmPaths: 'harnu-voice://kokoro/npm/@huggingface/transformers@3.5.1/dist/',
  remoteHost: 'harnu-voice://kokoro/hf/',
  remotePathTemplate: '{model}/',
  modelId: 'onnx-community/Kokoro-82M-v1.0-ONNX',
  dtype: 'q8'
}

function request(overrides: Partial<KokoroWorkerRequest> = {}): KokoroWorkerRequest {
  return { id: 1, runtime, text: 'hi', voice: 'af_heart', ...overrides }
}

function envStub(): TransformersEnv {
  return {
    remoteHost: '',
    remotePathTemplate: '',
    allowLocalModels: true,
    allowRemoteModels: false,
    useBrowserCache: true,
    backends: { onnx: { wasm: { wasmPaths: '', numThreads: 4, proxy: true } } }
  }
}

describe('createKokoroWorkerHandler', () => {
  it('resolves with the generated audio, tagged with the request id', async () => {
    const audio = { audio: new Float32Array([1, 2, 3]), sampling_rate: 24000 }
    const loader: KokoroLoader = {
      load: (url) =>
        Promise.resolve(
          url === runtime.transformersUrl
            ? { env: envStub() }
            : {
                KokoroTTS: {
                  from_pretrained: () => Promise.resolve({ generate: () => Promise.resolve(audio) })
                },
                env: {}
              }
        )
    }
    const handle = createKokoroWorkerHandler(loader)
    const response = await handle(request({ id: 42 }))
    expect(response).toEqual({ id: 42, ok: true, audio: audio.audio, samplingRate: 24000 })
  })

  it('boots once and reuses the engine for a second request', async () => {
    let bootCount = 0
    const loader: KokoroLoader = {
      load: (url) => {
        if (url === runtime.transformersUrl) return Promise.resolve({ env: envStub() })
        bootCount += 1
        return Promise.resolve({
          KokoroTTS: {
            from_pretrained: () =>
              Promise.resolve({
                generate: () => Promise.resolve({ audio: new Float32Array(), sampling_rate: 24000 })
              })
          },
          env: {}
        })
      }
    }
    const handle = createKokoroWorkerHandler(loader)
    await handle(request({ id: 1 }))
    await handle(request({ id: 2 }))
    expect(bootCount).toBe(1)
  })

  it('clears the cached engine after a boot failure so a retry re-boots', async () => {
    let installed = false
    const loader: KokoroLoader = {
      load: (url) => {
        if (!installed) return Promise.reject(new Error('not installed'))
        if (url === runtime.transformersUrl) return Promise.resolve({ env: envStub() })
        return Promise.resolve({
          KokoroTTS: {
            from_pretrained: () =>
              Promise.resolve({
                generate: () => Promise.resolve({ audio: new Float32Array(), sampling_rate: 24000 })
              })
          },
          env: {}
        })
      }
    }
    const handle = createKokoroWorkerHandler(loader)
    const first = await handle(request({ id: 1 }))
    expect(first).toEqual({ id: 1, ok: false, message: 'not installed' })
    installed = true
    const second = await handle(request({ id: 2 }))
    expect(second.ok).toBe(true)
  })

  it('does NOT clear the cached engine after a generate() failure — only a bad boot forces a reload', async () => {
    let bootCount = 0
    let shouldFail = true
    const loader: KokoroLoader = {
      load: (url) => {
        if (url === runtime.transformersUrl) return Promise.resolve({ env: envStub() })
        bootCount += 1
        return Promise.resolve({
          KokoroTTS: {
            from_pretrained: () =>
              Promise.resolve({
                generate: () =>
                  shouldFail
                    ? Promise.reject(new Error('onnx session failed'))
                    : Promise.resolve({ audio: new Float32Array(), sampling_rate: 24000 })
              })
          },
          env: {}
        })
      }
    }
    const handle = createKokoroWorkerHandler(loader)
    const first = await handle(request({ id: 1 }))
    expect(first).toEqual({ id: 1, ok: false, message: 'onnx session failed' })
    shouldFail = false
    const second = await handle(request({ id: 2 }))
    expect(second.ok).toBe(true)
    expect(bootCount).toBe(1)
  })
})
