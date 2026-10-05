import { describe, it, expect } from 'vitest'
import {
  createKokoroBackend,
  kokoroErrorFrom,
  type KokoroInstallSnapshot,
  type KokoroPort,
  type KokoroAudioSink,
  type KokoroWorkerLike,
  type RawAudioLike
} from '../src/renderer/src/lib/speech-kokoro'
import {
  createKokoroWorkerHandler,
  type KokoroWorkerRequest,
  type KokoroWorkerResponse
} from '../src/renderer/src/lib/speech-kokoro-worker-core'
import type { KokoroLoader } from '../src/renderer/src/lib/speech-kokoro-env'
import { SpeechError, speechErrorCodeOf } from '../src/renderer/src/lib/speech-backend'
import type { SpeechUtterance } from '../src/renderer/src/lib/speech-backend'
import { SPEECH_BACKENDS } from '../src/renderer/src/lib/speech-registry'
import { SpeechService } from '../src/renderer/src/lib/speech'

const utterance = (text: string): SpeechUtterance => ({ text, source: 'human' })

const runtime = {
  entryUrl: 'harnu-voice://kokoro/npm/kokoro-js@1.2.1/+esm',
  transformersUrl: 'harnu-voice://kokoro/npm/@huggingface/transformers@3.5.1/+esm',
  wasmPaths: 'harnu-voice://kokoro/npm/@huggingface/transformers@3.5.1/dist/',
  remoteHost: 'harnu-voice://kokoro/hf/',
  remotePathTemplate: '{model}/',
  modelId: 'onnx-community/Kokoro-82M-v1.0-ONNX',
  dtype: 'q8'
}

const audio: RawAudioLike = { audio: new Float32Array([0.1, -0.1, 0.2]), sampling_rate: 24000 }

interface Harness {
  port: KokoroPort
  /**
   * BUG-117: `speak()` no longer boots the engine or calls `generate()`
   * itself — it hands text to a Worker. `workerFactory` stands in for the
   * real `new Worker(...)`: it wires the SAME pure `createKokoroWorkerHandler`
   * production code runs inside the Worker to a fake `postMessage`/`onmessage`
   * round trip, so every test below still exercises the exact boot/generate
   * contract without a real thread (this project's tests run in a plain
   * `node` environment — no jsdom `Worker`).
   */
  workerFactory: () => KokoroWorkerLike
  loaded: string[]
  generated: { text: string; voice: string }[]
}

function harness(
  snapshot: Partial<KokoroInstallSnapshot> = {},
  generate: (text: string, voice: string) => Promise<RawAudioLike> = () => Promise.resolve(audio)
): Harness {
  const loaded: string[] = []
  const generated: { text: string; voice: string }[] = []
  const env = {
    remoteHost: '',
    remotePathTemplate: '',
    allowLocalModels: true,
    allowRemoteModels: false,
    useBrowserCache: true,
    backends: { onnx: { wasm: { wasmPaths: '', numThreads: 4, proxy: true } } }
  }
  const tts = {
    generate(text: string, opts: { voice: string }) {
      generated.push({ text, voice: opts.voice })
      return generate(text, opts.voice)
    }
  }
  const loader: KokoroLoader = {
    load(url) {
      loaded.push(url)
      if (url === runtime.transformersUrl) return Promise.resolve({ env })
      return Promise.resolve({
        KokoroTTS: { from_pretrained: () => Promise.resolve(tts) },
        env: {}
      })
    }
  }
  // One handler per harness — its internal `engine` cache lives exactly as
  // long as a real Worker's would, across every `workerFactory()` call below.
  const handle = createKokoroWorkerHandler(loader)

  function workerFactory(): KokoroWorkerLike {
    const worker = {
      onmessage: null,
      onerror: null,
      postMessage(message: KokoroWorkerRequest) {
        handle(message).then((response: KokoroWorkerResponse) => {
          worker.onmessage?.({ data: response } as MessageEvent<KokoroWorkerResponse>)
        })
      },
      terminate() {
        // No real thread in the fake — nothing to tear down.
      }
    } as KokoroWorkerLike
    return worker
  }

  return {
    loaded,
    generated,
    workerFactory,
    port: {
      status: () =>
        Promise.resolve({
          installed: true,
          runtime,
          manifest: { voices: ['af_heart'] },
          ...snapshot
        } as KokoroInstallSnapshot)
    }
  }
}

function recordingSink(): { sink: KokoroAudioSink; played: RawAudioLike[] } {
  const played: RawAudioLike[] = []
  return {
    played,
    sink: {
      play(a) {
        played.push(a)
        return Promise.resolve()
      }
    }
  }
}

describe('createKokoroBackend', () => {
  it('registers under the seam T237 defined (AC-1)', () => {
    expect(SPEECH_BACKENDS.kokoro).toBeTypeOf('function')
    expect(SPEECH_BACKENDS.kokoro().id).toBe('kokoro')
    // The other backend is untouched by this card.
    expect(SPEECH_BACKENDS['system-command']().id).toBe('system-command')
  })

  it('speaks through the mirror and plays the generated audio', async () => {
    const h = harness()
    const { sink, played } = recordingSink()
    const backend = createKokoroBackend({ port: h.port, sink, workerFactory: h.workerFactory })
    await backend.speak(utterance('the pull request is open'), new AbortController().signal)
    expect(h.generated).toEqual([{ text: 'the pull request is open', voice: 'af_heart' }])
    expect(played).toEqual([audio])
  })

  it('loads every module from harnu-voice://, never from the network', async () => {
    const h = harness()
    const { sink } = recordingSink()
    await createKokoroBackend({ port: h.port, sink, workerFactory: h.workerFactory }).speak(
      utterance('hi'),
      new AbortController().signal
    )
    expect(h.loaded.length).toBeGreaterThan(0)
    for (const url of h.loaded) {
      expect(url.startsWith('harnu-voice://')).toBe(true)
    }
  })

  // BUG-117: before this card, `speak()` booted the engine and called
  // `generate()` directly — synchronous WASM compute on the renderer's own UI
  // thread, freezing every session for the duration of each utterance. Now it
  // only ever talks to a Worker; a future edit that inlines the old
  // boot+generate call back into `speak()` would never invoke `workerFactory`
  // and this test would catch it.
  it('delegates synthesis to a dedicated Worker instead of running inference on the caller (BUG-117)', async () => {
    const h = harness()
    let workerFactoryCalls = 0
    const backend = createKokoroBackend({
      port: h.port,
      sink: recordingSink().sink,
      workerFactory: () => {
        workerFactoryCalls += 1
        return h.workerFactory()
      }
    })
    await backend.speak(utterance('hi'), new AbortController().signal)
    expect(workerFactoryCalls).toBe(1)
  })

  it('NEVER starts a download when nothing is installed (AC-3)', async () => {
    // The one behaviour this card cannot get wrong: selecting the backend, or
    // speaking with it, must not trigger a ~119 MB fetch. The status snapshot
    // says nothing is installed, so `speak()` must refuse before ever asking
    // for a Worker — and the failure is a reported code, not a silent stall.
    const h = harness({ installed: false, manifest: null })
    let workerFactoryCalls = 0
    const backend = createKokoroBackend({
      port: h.port,
      sink: recordingSink().sink,
      workerFactory: () => {
        workerFactoryCalls += 1
        return h.workerFactory()
      }
    })
    const err = await backend.speak(utterance('hi'), new AbortController().signal).catch((e) => e)
    expect(speechErrorCodeOf(err)).toBe('model-missing')
    expect(workerFactoryCalls).toBe(0)
    expect(h.loaded).toEqual([])
    expect(h.generated).toEqual([])
  })

  it('leaves the engine reloadable after a failed boot', async () => {
    let installed = false
    const h = harness()
    const port: KokoroPort = {
      status: () => Promise.resolve({ installed, runtime, manifest: null } as KokoroInstallSnapshot)
    }
    const backend = createKokoroBackend({
      port,
      sink: recordingSink().sink,
      workerFactory: h.workerFactory
    })
    await backend.speak(utterance('a'), new AbortController().signal).catch(() => {})
    installed = true
    await backend.speak(utterance('b'), new AbortController().signal)
    expect(h.generated.map((g) => g.text)).toEqual(['b'])
  })

  it('boots the engine once for a queue of utterances', async () => {
    const h = harness()
    const { sink } = recordingSink()
    const backend = createKokoroBackend({ port: h.port, sink, workerFactory: h.workerFactory })
    await backend.speak(utterance('a'), new AbortController().signal)
    await backend.speak(utterance('b'), new AbortController().signal)
    expect(h.loaded.filter((u) => u === runtime.entryUrl)).toHaveLength(1)
  })

  it('does nothing at all when the signal is already aborted', async () => {
    const h = harness()
    const controller = new AbortController()
    controller.abort()
    await createKokoroBackend({
      port: h.port,
      sink: recordingSink().sink,
      workerFactory: h.workerFactory
    }).speak(utterance('hi'), controller.signal)
    expect(h.loaded).toEqual([])
  })

  it('discards audio generated after the mute (AC-1: the mute still works)', async () => {
    const controller = new AbortController()
    const h = harness({}, async (text) => {
      controller.abort()
      return { ...audio, text } as unknown as RawAudioLike
    })
    const { sink, played } = recordingSink()
    await createKokoroBackend({ port: h.port, sink, workerFactory: h.workerFactory }).speak(
      utterance('hi'),
      controller.signal
    )
    expect(played).toEqual([])
  })

  it('coerces an unavailable voice rather than synthesising Portuguese as English', async () => {
    const h = harness()
    await createKokoroBackend({
      port: h.port,
      sink: recordingSink().sink,
      workerFactory: h.workerFactory,
      voice: 'pf_dora'
    }).speak(utterance('olá'), new AbortController().signal)
    expect(h.generated[0]?.voice).toBe('af_heart')
  })

  // T239 — the Voice pane changes voices at runtime. The getter form is what
  // makes that cheap: the Worker survives, so the loaded model does too. If
  // this ever regresses to a captured string, changing voice silently costs a
  // full 92 MB model reload.
  it('reads a getter-provided voice FRESH on every utterance', async () => {
    const h = harness()
    let chosen = 'af_heart'
    const backend = createKokoroBackend({
      port: h.port,
      sink: recordingSink().sink,
      workerFactory: h.workerFactory,
      voice: () => chosen
    })
    const signal = new AbortController().signal

    await backend.speak(utterance('first'), signal)
    chosen = 'bm_george'
    await backend.speak(utterance('second'), signal)

    // Same worker, two voices — no rebuild was needed to change it.
    expect(h.generated.map((g) => g.voice)).toEqual(['af_heart', 'bm_george'])
    expect(h.loaded.filter((u) => u.includes('kokoro-js'))).toHaveLength(1)
  })

  it('coerces a getter that answers with an unknown voice, same as the string form', async () => {
    const h = harness()
    await createKokoroBackend({
      port: h.port,
      sink: recordingSink().sink,
      workerFactory: h.workerFactory,
      voice: () => 'pm_alex'
    }).speak(utterance('olá'), new AbortController().signal)
    expect(h.generated[0]?.voice).toBe('af_heart')
  })

  it('reports a bridge-less window instead of throwing something unclassified', async () => {
    const backend = createKokoroBackend({ sink: recordingSink().sink })
    const err = await backend.speak(utterance('hi'), new AbortController().signal).catch((e) => e)
    expect(speechErrorCodeOf(err)).toBe('bridge-unavailable')
  })

  it('classifies a synthesis failure as engine-unavailable', async () => {
    const h = harness({}, () => Promise.reject(new Error('onnx session failed')))
    const err = await createKokoroBackend({
      port: h.port,
      sink: recordingSink().sink,
      workerFactory: h.workerFactory
    })
      .speak(utterance('hi'), new AbortController().signal)
      .catch((e) => e)
    expect(speechErrorCodeOf(err)).toBe('engine-unavailable')
    expect((err as Error).message).toContain('onnx session failed')
  })

  it('propagates an audio-output failure as its own code', async () => {
    const h = harness()
    const sink: KokoroAudioSink = {
      play: () => Promise.reject(new SpeechError('audio-unavailable', 'no AudioContext'))
    }
    const err = await createKokoroBackend({ port: h.port, sink, workerFactory: h.workerFactory })
      .speak(utterance('hi'), new AbortController().signal)
      .catch((e) => e)
    expect(speechErrorCodeOf(err)).toBe('audio-unavailable')
  })

  it('fails every in-flight request and drops the worker when the worker itself crashes', async () => {
    const h = harness()
    let created = 0
    const backend = createKokoroBackend({
      port: h.port,
      sink: recordingSink().sink,
      workerFactory: () => {
        created += 1
        if (created === 1) {
          // First worker: never responds, then reports an error event.
          const dead = {
            onmessage: null,
            onerror: null,
            postMessage() {
              queueMicrotask(() =>
                dead.onerror?.({ message: 'script failed to load' } as ErrorEvent)
              )
            },
            terminate() {
              // No real thread in the fake — nothing to tear down.
            }
          } as KokoroWorkerLike
          return dead
        }
        return h.workerFactory()
      }
    })
    const err = await backend.speak(utterance('a'), new AbortController().signal).catch((e) => e)
    expect(speechErrorCodeOf(err)).toBe('engine-unavailable')
    // The NEXT speak() gets a fresh worker rather than reusing the dead one.
    await backend.speak(utterance('b'), new AbortController().signal)
    expect(created).toBe(2)
    expect(h.generated.map((g) => g.text)).toEqual(['b'])
  })
})

describe('the engine above the seam is untouched (AC-1)', () => {
  it('queues, serialises and mutes a kokoro backend exactly like any other', async () => {
    const h = harness()
    const { sink, played } = recordingSink()
    const service = new SpeechService({
      resolveBackend: () =>
        createKokoroBackend({ port: h.port, sink, workerFactory: h.workerFactory }),
      prefs: { enabled: true, muted: false, backend: 'kokoro', maxChars: 800 }
    })
    await Promise.all([
      service.speak('first', { source: 'human' }),
      service.speak('second', { source: 'human' })
    ])
    expect(h.generated.map((g) => g.text)).toEqual(['first', 'second'])
    expect(played).toHaveLength(2)
    expect(service.state.lastError).toBeNull()
  })

  it('reports a missing download through the engine state, never as a throw', async () => {
    const h = harness({ installed: false, manifest: null })
    const service = new SpeechService({
      resolveBackend: () =>
        createKokoroBackend({
          port: h.port,
          sink: recordingSink().sink,
          workerFactory: h.workerFactory
        }),
      prefs: { enabled: true, muted: false, backend: 'kokoro', maxChars: 800 }
    })
    await service.speak('hi', { source: 'human' })
    expect(service.state.lastError).toBe('model-missing')
  })
})

describe('kokoroErrorFrom', () => {
  it('keeps a SpeechError as it is', () => {
    const err = new SpeechError('model-missing', 'x')
    expect(kokoroErrorFrom(err)).toBe(err)
  })

  it('wraps anything else with the detail preserved for logs', () => {
    expect(kokoroErrorFrom('boom').code).toBe('engine-unavailable')
    expect(kokoroErrorFrom('boom').message).toContain('boom')
  })
})
