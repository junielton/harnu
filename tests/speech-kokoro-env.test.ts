import { describe, it, expect } from 'vitest'
import {
  applyKokoroEnv,
  bootKokoroEngine,
  type KokoroLoader,
  type TransformersEnv
} from '../src/renderer/src/lib/speech-kokoro-env'

const runtime = {
  entryUrl: 'harnu-voice://kokoro/npm/kokoro-js@1.2.1/+esm',
  transformersUrl: 'harnu-voice://kokoro/npm/@huggingface/transformers@3.5.1/+esm',
  wasmPaths: 'harnu-voice://kokoro/npm/@huggingface/transformers@3.5.1/dist/',
  remoteHost: 'harnu-voice://kokoro/hf/',
  remotePathTemplate: '{model}/',
  modelId: 'onnx-community/Kokoro-82M-v1.0-ONNX',
  dtype: 'q8'
}

function fakeEnv(): TransformersEnv {
  return {
    remoteHost: '',
    remotePathTemplate: '',
    allowLocalModels: true,
    allowRemoteModels: false,
    useBrowserCache: true,
    backends: { onnx: { wasm: { wasmPaths: '', numThreads: 4, proxy: true } } }
  }
}

describe('applyKokoroEnv', () => {
  it('points transformers.js at the mirror and off the network', () => {
    const env = fakeEnv()
    applyKokoroEnv(env, runtime)
    expect(env.remoteHost).toBe(runtime.remoteHost)
    expect(env.useBrowserCache).toBe(false)
    expect(env.backends.onnx.wasm.wasmPaths).toBe(runtime.wasmPaths)
  })

  it('pins single-threaded WASM — a file:// renderer is not crossOriginIsolated', () => {
    const env = fakeEnv()
    applyKokoroEnv(env, runtime)
    expect(env.backends.onnx.wasm.numThreads).toBe(1)
  })

  // BUG-117: `proxy: true` was tried as the fix and measured broken against a
  // real install — onnxruntime-web's own proxy worker reloads a DIFFERENT file
  // (`onnxruntime-web`'s own `dist/ort.bundle.min.mjs`) than the one this
  // install actually downloads (`@huggingface/transformers`'s
  // `ort-wasm-*.jsep.mjs`), so it fails outright ("no available backend
  // found") for every voice already on an operator's disk. `proxy` stays
  // `false` here; keeping inference off the renderer's UI thread is instead
  // this whole module running inside `speech-kokoro-worker.ts`'s dedicated
  // Worker, never on the caller's thread. See that file's module doc.
  it('does not ask onnxruntime-web for its own internal proxy worker (BUG-117)', () => {
    const env = fakeEnv()
    applyKokoroEnv(env, runtime)
    expect(env.backends.onnx.wasm.proxy).toBe(false)
  })
})

describe('bootKokoroEngine', () => {
  it('loads the entry and transformers modules, applies the env, and boots from_pretrained', async () => {
    const loaded: string[] = []
    const env = fakeEnv()
    const tts = {
      generate: () => Promise.resolve({ audio: new Float32Array(), sampling_rate: 24000 })
    }
    let fromPretrainedArgs: unknown[] = []
    const loader: KokoroLoader = {
      load(url) {
        loaded.push(url)
        if (url === runtime.transformersUrl) return Promise.resolve({ env })
        return Promise.resolve({
          KokoroTTS: {
            from_pretrained: (...args: unknown[]) => {
              fromPretrainedArgs = args
              return Promise.resolve(tts)
            }
          },
          env: {}
        })
      }
    }
    const result = await bootKokoroEngine(loader, runtime)
    expect(result).toBe(tts)
    expect(loaded).toEqual([runtime.entryUrl, runtime.transformersUrl])
    expect(env.remoteHost).toBe(runtime.remoteHost)
    expect(fromPretrainedArgs).toEqual([runtime.modelId, { dtype: runtime.dtype, device: 'wasm' }])
  })
})
