import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  SpeechService,
  shouldSpeak,
  clampSpeechText,
  speechErrorMessageKey,
  type SpeechState
} from '../src/renderer/src/lib/speech'
import { SpeechError, type SpeechBackend } from '../src/renderer/src/lib/speech-backend'
import { DEFAULT_VOICE_PREFS } from '../src/renderer/src/lib/speech-prefs'
import en from '../src/renderer/src/i18n/en.json'
import ptBR from '../src/renderer/src/i18n/pt-BR.json'

/**
 * A backend whose every utterance is held open until the test releases it.
 * `concurrent` records the high-water mark of simultaneously-open utterances —
 * the direct measurement AC-1 asks for.
 */
function controllableBackend(): {
  backend: SpeechBackend
  spoken: string[]
  open: number
  peakConcurrent: number
  release(text: string): void
  reject(text: string, error: unknown): void
  aborted: string[]
} {
  const pending = new Map<string, { resolve: () => void; reject: (e: unknown) => void }>()
  const state = {
    backend: null as unknown as SpeechBackend,
    spoken: [] as string[],
    open: 0,
    peakConcurrent: 0,
    aborted: [] as string[],
    release(text: string) {
      pending.get(text)?.resolve()
    },
    reject(text: string, error: unknown) {
      pending.get(text)?.reject(error)
    }
  }
  state.backend = {
    id: 'system-command',
    speak(utterance, signal) {
      state.spoken.push(utterance.text)
      state.open += 1
      state.peakConcurrent = Math.max(state.peakConcurrent, state.open)
      return new Promise<void>((resolve, reject) => {
        const settle = (fn: () => void): void => {
          state.open -= 1
          pending.delete(utterance.text)
          fn()
        }
        pending.set(utterance.text, {
          resolve: () => settle(resolve),
          reject: (e) => settle(() => reject(e))
        })
        signal.addEventListener(
          'abort',
          () => {
            state.aborted.push(utterance.text)
            settle(resolve)
          },
          { once: true }
        )
      })
    }
  }
  return state
}

function makeService(
  backend: SpeechBackend | null,
  prefs: Partial<typeof DEFAULT_VOICE_PREFS> = {}
): SpeechService {
  return new SpeechService({
    resolveBackend: () => backend,
    prefs: { ...DEFAULT_VOICE_PREFS, enabled: true, ...prefs }
  })
}

/** Let the microtask queue settle so the drain loop advances. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

// A failed utterance is logged by design (`SpeechService.fail`). Several cases
// below fail one on purpose — keep the expected noise out of the test output.
let warn: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  warn.mockRestore()
})

describe('shouldSpeak — only speak what you cannot see', () => {
  const base = { enabled: true, muted: false, windowFocused: false, isSelected: false }

  it('suppresses agent speech for the session the operator is staring at', () => {
    expect(shouldSpeak({ ...base, source: 'agent', windowFocused: true, isSelected: true })).toBe(
      false
    )
  })

  it('speaks for an agent when the window is focused but another session is selected', () => {
    expect(shouldSpeak({ ...base, source: 'agent', windowFocused: true, isSelected: false })).toBe(
      true
    )
  })

  it('speaks for an agent when the window is not focused, selected or not', () => {
    expect(shouldSpeak({ ...base, source: 'agent', windowFocused: false, isSelected: true })).toBe(
      true
    )
  })

  it('never gates human-initiated speech on focus — they asked to be read to', () => {
    expect(shouldSpeak({ ...base, source: 'human', windowFocused: true, isSelected: true })).toBe(
      true
    )
  })

  it('stays quiet when the engine is disabled or muted, whoever asked', () => {
    expect(shouldSpeak({ ...base, source: 'human', enabled: false })).toBe(false)
    expect(shouldSpeak({ ...base, source: 'human', muted: true })).toBe(false)
    expect(shouldSpeak({ ...base, source: 'agent', muted: true })).toBe(false)
  })
})

describe('clampSpeechText', () => {
  it('collapses whitespace so a markdown blob is one breath', () => {
    expect(clampSpeechText('two\n\nlines   here', 100)).toBe('two lines here')
  })

  it('strips leading dashes so the text can never be read as a flag', () => {
    expect(clampSpeechText('--version is fine', 100)).toBe('version is fine')
  })

  it('truncates at a word boundary', () => {
    expect(clampSpeechText('alpha bravo charlie delta', 15)).toBe('alpha bravo')
  })

  it('hard-truncates when there is no usable word boundary', () => {
    expect(clampSpeechText('averyveryverylongword', 6)).toBe('averyv')
  })

  it('returns empty for blank input', () => {
    expect(clampSpeechText('   \n ', 100)).toBe('')
    expect(clampSpeechText(undefined as unknown as string, 100)).toBe('')
  })
})

describe('AC-1 — the queue serialises', () => {
  it('never overlaps two concurrent speak calls: the second plays after the first', async () => {
    const ctl = controllableBackend()
    const svc = makeService(ctl.backend)

    const first = svc.speak('first', { source: 'human' })
    const second = svc.speak('second', { source: 'human' })
    await tick()

    // Only the first is in the backend; the second is waiting behind it.
    expect(ctl.spoken).toEqual(['first'])
    expect(svc.state).toMatchObject({ speaking: true, queued: 1 })

    ctl.release('first')
    await first
    await tick()

    expect(ctl.spoken).toEqual(['first', 'second'])
    ctl.release('second')
    await second

    expect(ctl.peakConcurrent).toBe(1)
    expect(svc.state).toMatchObject({ speaking: false, queued: 0 })
  })

  it('keeps order across many callers and never runs two at once', async () => {
    const ctl = controllableBackend()
    const svc = makeService(ctl.backend)
    const texts = ['one', 'two', 'three', 'four']
    const all = Promise.all(texts.map((t) => svc.speak(t, { source: 'human' })))

    for (const t of texts) {
      await tick()
      expect(ctl.spoken[ctl.spoken.length - 1]).toBe(t)
      ctl.release(t)
    }
    await all
    expect(ctl.spoken).toEqual(texts)
    expect(ctl.peakConcurrent).toBe(1)
  })

  it('resumes after a failed utterance instead of wedging the queue', async () => {
    const ctl = controllableBackend()
    const svc = makeService(ctl.backend)
    const first = svc.speak('boom', { source: 'human' })
    const second = svc.speak('after', { source: 'human' })
    await tick()

    ctl.reject('boom', new SpeechError('command-failed', 'exit 1'))
    await first
    await tick()

    expect(ctl.spoken).toEqual(['boom', 'after'])
    ctl.release('after')
    await second
    expect(svc.state.queued).toBe(0)
  })
})

describe('AC-2 — stop() and mute silence everything, immediately', () => {
  it('aborts what is playing and drains what is queued', async () => {
    const ctl = controllableBackend()
    const svc = makeService(ctl.backend)
    const first = svc.speak('playing', { source: 'human' })
    const second = svc.speak('queued-a', { source: 'human' })
    const third = svc.speak('queued-b', { source: 'human' })
    await tick()
    expect(svc.state).toMatchObject({ speaking: true, queued: 2 })

    svc.stop()

    // Every pending promise settles — nobody awaiting a muted utterance is stranded.
    await Promise.all([first, second, third])
    await tick()

    expect(ctl.aborted).toEqual(['playing'])
    expect(ctl.spoken).toEqual(['playing']) // the drained two never reached the backend
    expect(svc.state).toMatchObject({ speaking: false, queued: 0 })
  })

  it('does not report an aborted utterance as a failure', async () => {
    const ctl = controllableBackend()
    const svc = makeService(ctl.backend)
    const p = svc.speak('playing', { source: 'human' })
    await tick()
    svc.stop()
    await p
    await tick()
    expect(svc.state.lastError).toBeNull()
  })

  it('muting silences and drains, and refuses new utterances until unmuted', async () => {
    const ctl = controllableBackend()
    const svc = makeService(ctl.backend)
    const p = svc.speak('playing', { source: 'human' })
    svc.speak('queued', { source: 'human' })
    await tick()

    svc.setMuted(true)
    await p
    await tick()
    expect(svc.state).toMatchObject({ muted: true, speaking: false, queued: 0 })

    await svc.speak('while muted', { source: 'human' })
    expect(ctl.spoken).toEqual(['playing'])

    svc.setMuted(false)
    const after = svc.speak('after unmute', { source: 'human' })
    await tick()
    expect(ctl.spoken).toEqual(['playing', 'after unmute'])
    ctl.release('after unmute')
    await after
  })

  it('disabling the engine mid-utterance stops it too', async () => {
    const ctl = controllableBackend()
    const svc = makeService(ctl.backend)
    const p = svc.speak('playing', { source: 'human' })
    await tick()
    svc.configure({ enabled: false })
    await p
    await tick()
    expect(ctl.aborted).toEqual(['playing'])
    expect(svc.state).toMatchObject({ enabled: false, speaking: false, queued: 0 })
  })
})

/**
 * T239 — the backend seam gained one parameter: a GETTER for the live prefs, so
 * Kokoro can read the operator's chosen voice per utterance. Two properties have
 * to hold, and neither was covered before.
 */
describe('the backend resolver sees live prefs (T239)', () => {
  it('hands the resolver a getter that reflects the CURRENT prefs, not a snapshot', () => {
    let read: (() => { voice: string }) | null = null
    const svc = new SpeechService({
      resolveBackend: (_id, getPrefs) => {
        read = getPrefs as () => { voice: string }
        return { id: 'kokoro', speak: () => Promise.resolve() }
      },
      prefs: { ...DEFAULT_VOICE_PREFS, enabled: true, backend: 'kokoro', voice: 'af_heart' }
    })

    void svc.speak('hi', { source: 'human' })
    const getPrefs = read as unknown as () => { voice: string }
    expect(getPrefs).toBeTypeOf('function')
    expect(getPrefs().voice).toBe('af_heart')

    svc.configure({ voice: 'bm_george' })
    // The SAME getter now answers with the new voice — no re-resolution needed.
    expect(getPrefs().voice).toBe('bm_george')
  })

  it('does NOT rebuild the backend when only the voice changes', async () => {
    let builds = 0
    const svc = new SpeechService({
      resolveBackend: () => {
        builds += 1
        return { id: 'kokoro', speak: () => Promise.resolve() }
      },
      prefs: { ...DEFAULT_VOICE_PREFS, enabled: true, backend: 'kokoro' }
    })

    await svc.speak('one', { source: 'human' })
    svc.configure({ voice: 'bm_george' })
    await svc.speak('two', { source: 'human' })

    // Rebuilding would throw away Kokoro's loaded ~92 MB model for a setting the
    // engine takes per `generate()` call.
    expect(builds).toBe(1)
  })

  it('DOES rebuild when the backend itself changes', async () => {
    let builds = 0
    const svc = new SpeechService({
      resolveBackend: () => {
        builds += 1
        return { id: 'kokoro', speak: () => Promise.resolve() }
      },
      prefs: { ...DEFAULT_VOICE_PREFS, enabled: true, backend: 'kokoro' }
    })

    await svc.speak('one', { source: 'human' })
    svc.configure({ backend: 'system-command' })
    await svc.speak('two', { source: 'human' })

    expect(builds).toBe(2)
  })
})

describe('AC-3 — a missing command fails soft into a readable state', () => {
  it('never throws into the caller, and records the code', async () => {
    const svc = makeService({
      id: 'system-command',
      speak: () => Promise.reject(new SpeechError('command-not-found', 'spawn ENOENT'))
    })

    // Resolves (never rejects) AND reports the failure as a value — T239's
    // notification path needs to tell a real failure from a deliberate silence.
    await expect(svc.speak('anything', { source: 'human' })).resolves.toBe('failed')
    expect(svc.state.lastError).toBe('command-not-found')
    expect(svc.state.lastErrorDetail).toContain('spawn ENOENT')
    expect(svc.state.speaking).toBe(false)
  })

  it('maps a non-SpeechError throwable onto command-failed rather than leaking it', async () => {
    const svc = makeService({
      id: 'system-command',
      speak: () => Promise.reject(new TypeError('something odd'))
    })
    await svc.speak('anything', { source: 'human' })
    expect(svc.state.lastError).toBe('command-failed')
  })

  it('reports no-backend when the configured backend cannot be resolved', async () => {
    const svc = makeService(null)
    await expect(svc.speak('anything', { source: 'human' })).resolves.toBe('failed')
    expect(svc.state.lastError).toBe('no-backend')
  })

  it('clears the error once an utterance succeeds again', async () => {
    let fail = true
    const svc = makeService({
      id: 'system-command',
      speak: () => (fail ? Promise.reject(new SpeechError('command-failed')) : Promise.resolve())
    })
    await svc.speak('first', { source: 'human' })
    expect(svc.state.lastError).toBe('command-failed')
    fail = false
    await svc.speak('second', { source: 'human' })
    expect(svc.state.lastError).toBeNull()
  })

  it('every error code maps to a key that exists in BOTH locale bundles', () => {
    const bundles: Record<string, unknown>[] = [en, ptBR]
    const codes = [
      'no-backend',
      'invalid-command',
      'command-not-found',
      'command-failed',
      'bridge-unavailable'
    ] as const
    for (const code of codes) {
      const key = speechErrorMessageKey(code)
      expect(key).toBeTruthy()
      for (const bundle of bundles) {
        const value = key!
          .split('.')
          .reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], bundle)
        expect(typeof value, `${key} missing from a locale bundle`).toBe('string')
      }
    }
    expect(speechErrorMessageKey(null)).toBeNull()
  })
})

describe('state and subscribers', () => {
  it('notifies subscribers as the queue advances, and unsubscribes cleanly', async () => {
    const ctl = controllableBackend()
    const svc = makeService(ctl.backend)
    const seen: SpeechState[] = []
    const off = svc.subscribe((s) => seen.push(s))

    const p = svc.speak('hello', { source: 'human' })
    await tick()
    expect(seen.some((s) => s.speaking && s.queued === 0)).toBe(true)
    ctl.release('hello')
    await p
    await tick()
    expect(seen[seen.length - 1]).toMatchObject({ speaking: false, queued: 0 })

    off()
    const before = seen.length
    const quiet = svc.speak('quiet', { source: 'human' })
    await tick()
    ctl.release('quiet')
    await quiet
    expect(seen.length).toBe(before)
  })

  it('survives a subscriber that throws', async () => {
    const ctl = controllableBackend()
    const svc = makeService(ctl.backend)
    svc.subscribe(() => {
      throw new Error('bad subscriber')
    })
    const p = svc.speak('hello', { source: 'human' })
    await tick()
    ctl.release('hello')
    await expect(p).resolves.toBe('spoken')
  })

  it('hands out a copy of the config, never the live object', () => {
    const svc = makeService(null, { command: 'espeak' })
    const cfg = svc.config
    cfg.command = 'tampered'
    expect(svc.config.command).toBe('espeak')
  })

  it('drops a blank or gated utterance without touching the backend', async () => {
    const ctl = controllableBackend()
    const svc = makeService(ctl.backend)
    await svc.speak('   ', { source: 'human' })
    await svc.speak('hidden', {
      source: 'agent',
      focus: { windowFocused: true, isSelected: true }
    })
    expect(ctl.spoken).toEqual([])
  })
})
