import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  createSystemCommandBackend,
  resetUtteranceIds,
  type SpeechCommandPort,
  type SpeechSayOutcome
} from '../src/renderer/src/lib/speech-system-command'
import { speechErrorCodeOf, type SpeechUtterance } from '../src/renderer/src/lib/speech-backend'
import { SPEECH_BACKENDS } from '../src/renderer/src/lib/speech-registry'

const utterance = (text: string): SpeechUtterance => ({ text, source: 'human' })

function fakePort(outcome: SpeechSayOutcome | (() => Promise<SpeechSayOutcome>)): {
  port: SpeechCommandPort
  calls: { id: string; text: string }[]
  cancelled: string[]
} {
  const calls: { id: string; text: string }[] = []
  const cancelled: string[] = []
  return {
    calls,
    cancelled,
    port: {
      say(req) {
        calls.push(req)
        return typeof outcome === 'function' ? outcome() : Promise.resolve(outcome)
      },
      cancel(id) {
        cancelled.push(id)
      }
    }
  }
}

describe('createSystemCommandBackend', () => {
  beforeEach(() => resetUtteranceIds())
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window
  })

  it('sends only an id and the utterance — never an executable', async () => {
    const { port, calls } = fakePort({ ok: true })
    const backend = createSystemCommandBackend({ port })
    await backend.speak(utterance('all green'), new AbortController().signal)
    expect(calls).toEqual([{ id: 'speech-1', text: 'all green' }])
    expect(calls[0]).not.toHaveProperty('command')
  })

  it('gives each utterance its own id so a cancel addresses the right process', async () => {
    const { port, calls } = fakePort({ ok: true })
    const backend = createSystemCommandBackend({ port })
    await backend.speak(utterance('a'), new AbortController().signal)
    await backend.speak(utterance('b'), new AbortController().signal)
    expect(calls.map((c) => c.id)).toEqual(['speech-1', 'speech-2'])
  })

  it('propagates the failure code the main process reported', async () => {
    const { port } = fakePort({ ok: false, error: 'command-not-found', detail: 'spawn ENOENT' })
    const backend = createSystemCommandBackend({ port })
    const err = await backend
      .speak(utterance('hi'), new AbortController().signal)
      .catch((e: unknown) => e)
    expect(speechErrorCodeOf(err)).toBe('command-not-found')
    expect((err as Error).message).toContain('spawn ENOENT')
  })

  it('falls back to command-failed for an unrecognised failure code', async () => {
    const { port } = fakePort({ ok: false, error: 'something-new' })
    const backend = createSystemCommandBackend({ port })
    const err = await backend
      .speak(utterance('hi'), new AbortController().signal)
      .catch((e: unknown) => e)
    expect(speechErrorCodeOf(err)).toBe('command-failed')
  })

  it('cancels the in-flight utterance in main when the signal aborts', async () => {
    let settle: (o: SpeechSayOutcome) => void = () => {}
    const { port, cancelled } = fakePort(
      () => new Promise<SpeechSayOutcome>((resolve) => (settle = resolve))
    )
    const backend = createSystemCommandBackend({ port })
    const controller = new AbortController()
    const promise = backend.speak(utterance('long one'), controller.signal)

    controller.abort()
    expect(cancelled).toEqual(['speech-1'])

    // A killed process reports back; an aborted utterance must resolve quietly.
    settle({ ok: false, error: 'command-failed', detail: 'terminated' })
    await expect(promise).resolves.toBeUndefined()
  })

  it('does nothing at all when the signal is already aborted', async () => {
    const { port, calls } = fakePort({ ok: true })
    const backend = createSystemCommandBackend({ port })
    const controller = new AbortController()
    controller.abort()
    await backend.speak(utterance('hi'), controller.signal)
    expect(calls).toEqual([])
  })

  it('reports bridge-unavailable rather than throwing when window.api is missing', async () => {
    const backend = createSystemCommandBackend()
    const err = await backend
      .speak(utterance('hi'), new AbortController().signal)
      .catch((e: unknown) => e)
    expect(speechErrorCodeOf(err)).toBe('bridge-unavailable')
  })

  it('uses the preload bridge when it is there', async () => {
    const calls: unknown[] = []
    ;(globalThis as { window?: unknown }).window = {
      api: {
        speechSay: (req: unknown) => {
          calls.push(req)
          return Promise.resolve({ ok: true })
        },
        speechCancel: () => {}
      }
    }
    const backend = createSystemCommandBackend()
    await backend.speak(utterance('hi'), new AbortController().signal)
    expect(calls).toEqual([{ id: 'speech-1', text: 'hi' }])
  })
})

describe('the backend registry (AC-5)', () => {
  it('holds every registered implementation, and only those', () => {
    // T237 shipped one; T241 added `kokoro` behind the same seam. This list is
    // the whole wiring surface — a backend that is not here cannot be selected.
    expect(Object.keys(SPEECH_BACKENDS).sort()).toEqual(['kokoro', 'system-command'])
  })

  it('builds a backend whose id matches its registry key', () => {
    const backend = SPEECH_BACKENDS['system-command']()
    expect(backend.id).toBe('system-command')
    expect(typeof backend.speak).toBe('function')
  })
})
