import { describe, it, expect } from 'vitest'
import { speechDropReason, speechProbeView } from '../src/renderer/src/lib/voice-probe'
import { clampSpeechText } from '../src/renderer/src/lib/speech'
import { shouldSpeak } from '../src/renderer/src/lib/speech-focus'
import { i18n } from '@renderer/i18n'
import en from '../src/renderer/src/i18n/en.json'
import ptBR from '../src/renderer/src/i18n/pt-BR.json'

/**
 * BUG-104 — the wording half of the fix. The Test button's only output is audio,
 * so every phase and every outcome has to come back as a KEY that resolves to a
 * real sentence. These tests are about that mapping being total: no phase the
 * engine can report renders as nothing, which is the bug one layer down.
 */

const BASE = {
  text: 'harnu — feat t216 is waiting for you',
  maxChars: 800,
  enabled: true,
  muted: false,
  source: 'human' as const
}

describe('AC-3 — a drop carries the REASON, re-derived the way the gate reads it', () => {
  it('reports nothing to drop when the engine would speak it', () => {
    expect(speechDropReason(BASE)).toBeNull()
  })

  it('names the master switch when voice is off', () => {
    expect(speechDropReason({ ...BASE, enabled: false })).toBe('disabled')
  })

  it('names the mute when voice is muted', () => {
    expect(speechDropReason({ ...BASE, muted: true })).toBe('muted')
  })

  it('names an empty phrase — checked BEFORE the gate, as the engine does', () => {
    // Same order as `speak()`: the clamp runs first, so an empty phrase with the
    // engine ALSO switched off still reports the phrase, not the switch.
    expect(speechDropReason({ ...BASE, text: '   ' })).toBe('empty')
    expect(speechDropReason({ ...BASE, text: '   ', enabled: false })).toBe('empty')
  })

  it('names the focus rule for an agent utterance the operator is already reading', () => {
    expect(
      speechDropReason({ ...BASE, source: 'agent', windowFocused: true, isSelected: true })
    ).toBe('focus')
    // A human press is never suppressed by focus — that is the rule, not a bug.
    expect(speechDropReason({ ...BASE, windowFocused: true, isSelected: true })).toBeNull()
  })
})

describe('AC-1/AC-2 — the click and the wait are rendered, not inferred', () => {
  it('gives the click its own pending phase, marked busy', () => {
    const view = speechProbeView('pending')
    expect(view.messageKey).toBe('voice.test.pending')
    expect(view.busy).toBe(true)
  })

  it('gives the utterance a speaking phase, still busy', () => {
    const view = speechProbeView('speaking')
    expect(view.messageKey).toBe('voice.test.speaking')
    expect(view.busy).toBe(true)
  })

  it('renders nothing at all before the first press', () => {
    const view = speechProbeView('idle')
    expect(view.messageKey).toBeNull()
    expect(view.busy).toBe(false)
  })
})

describe('AC-3 — every outcome the engine can report renders distinctly', () => {
  const cases = [
    ['spoken', 'voice.test.spoken', 'ok'],
    ['stopped', 'voice.test.stopped', 'info'],
    ['dropped', 'voice.test.dropped.unknown', 'info']
  ] as const

  it.each(cases)('%s renders its own line and tone', (phase, key, tone) => {
    const view = speechProbeView(phase)
    expect(view.messageKey).toBe(key)
    expect(view.tone).toBe(tone)
    expect(view.busy).toBe(false)
  })

  it('gives each drop reason a line of its own', () => {
    const keys = (['empty', 'disabled', 'muted', 'focus', 'unknown'] as const).map(
      (dropReason) => speechProbeView('dropped', { dropReason }).messageKey
    )
    expect(new Set(keys).size).toBe(5)
  })

  it('claims no reason when it has none, instead of guessing one', () => {
    // A drop the re-derivation could not account for must not be reported as an
    // empty phrase — a wrong reason is worse than no reason.
    expect(speechProbeView('dropped', { dropReason: null }).messageKey).toBe(
      'voice.test.dropped.unknown'
    )
    expect(i18n.global.t('voice.test.dropped.unknown')).not.toMatch(/phrase|off|muted/i)
  })

  it('the four terminal phases never share a message key', () => {
    const keys = [
      speechProbeView('spoken').messageKey,
      speechProbeView('dropped', { dropReason: 'muted' }).messageKey,
      speechProbeView('stopped').messageKey,
      speechProbeView('failed', { errorCode: 'command-not-found' }).messageKey
    ]
    expect(new Set(keys).size).toBe(4)
  })
})

describe('AC-4 — a failure names WHAT failed, and blames no volume knob', () => {
  it('borrows the engine error vocabulary, which names the fault', () => {
    const view = speechProbeView('failed', { errorCode: 'command-not-found' })
    expect(view.messageKey).toBe('voice.error.commandNotFound')
    expect(view.tone).toBe('warn')
    expect(i18n.global.t(view.messageKey!)).toContain('PATH')
  })

  it('falls back to a plain "could not speak it" when the engine coded nothing', () => {
    expect(speechProbeView('failed', { errorCode: null }).messageKey).toBe('voice.test.failed')
  })

  it('mentions the operator audio hardware ONLY where there is evidence it played', () => {
    // The `spoken` line may point at the volume — the app knows the utterance
    // finished, so the remaining explanation really is outside it. No failure or
    // drop line may, and that asymmetry is the acceptance criterion.
    const volume = /volume|output device|speaker|volume do sistema|dispositivo de saída/i
    expect(en.voice.test.spoken).toMatch(volume)

    const mustNotBlame = [
      en.voice.test.failed,
      en.voice.test.stopped,
      ...Object.values(en.voice.test.dropped),
      ...Object.values(en.voice.error),
      ptBR.voice.test.failed,
      ptBR.voice.test.stopped,
      ...Object.values(ptBR.voice.test.dropped),
      ...Object.values(ptBR.voice.error)
    ]
    for (const line of mustNotBlame) expect(line).not.toMatch(volume)
  })
})

describe('AC-7 — every key this module can emit exists in BOTH locales', () => {
  const phases = ['pending', 'speaking', 'spoken', 'stopped', 'failed'] as const
  const drops = ['empty', 'disabled', 'muted', 'focus', 'unknown'] as const

  it('resolves every phase key in en and pt-BR', () => {
    const keys = [
      ...phases.map((p) => speechProbeView(p).messageKey),
      ...drops.map((d) => speechProbeView('dropped', { dropReason: d }).messageKey),
      'voice.test.coldModel',
      'voice.voices.preview',
      'voice.voices.inUse',
      'voice.voices.listAria'
    ].filter((k): k is string => k !== null)

    for (const key of keys) {
      for (const locale of ['en', 'pt-BR'] as const) {
        const text = i18n.global.t(key, { name: 'Heart' }, { locale })
        // vue-i18n echoes the key back when it is missing — a silent hole the
        // schema alone does not catch for a key built at runtime.
        expect(text, `${key} @ ${locale}`).not.toBe(key)
        expect(text.length, `${key} @ ${locale}`).toBeGreaterThan(0)
      }
    }
  })
})

describe('the re-derivation cannot drift from the gate it mirrors', () => {
  /**
   * `speechDropReason` is a SECOND projection of the decision `speak()` already
   * makes, which is exactly the shape that rots in silence
   * (docs/lessons/code-patterns/003-derived-classifier-must-mirror-its-canonical-source.md).
   * So it is pinned against the canonical pair — `clampSpeechText` then
   * `shouldSpeak` — over the whole input space rather than trusted to keep
   * matching by inspection.
   */
  it('answers "would this be dropped?" identically to the engine, for every input', () => {
    const texts = ['harnu — feat t216 is waiting for you', '   ', '', '--- ']
    const bools = [true, false]
    let checked = 0

    for (const text of texts) {
      for (const enabled of bools) {
        for (const muted of bools) {
          for (const source of ['human', 'agent'] as const) {
            for (const windowFocused of bools) {
              for (const isSelected of bools) {
                const ctx = {
                  text,
                  maxChars: 800,
                  enabled,
                  muted,
                  source,
                  windowFocused,
                  isSelected
                }
                // The canonical answer, in the engine's own order.
                const engineDrops =
                  !clampSpeechText(text, 800) ||
                  !shouldSpeak({ source, enabled, muted, windowFocused, isSelected })
                expect(speechDropReason(ctx) !== null, JSON.stringify(ctx)).toBe(engineDrops)
                checked += 1
              }
            }
          }
        }
      }
    }
    expect(checked).toBe(texts.length * 2 ** 5)
  })

  it('never returns "focus" for a reason the gate refuses for another cause', () => {
    // `focus` is the ONLY label delegated wholesale to `shouldSpeak`, so it must
    // never absorb a refusal that has a name of its own.
    for (const enabled of [true, false]) {
      for (const muted of [true, false]) {
        const reason = speechDropReason({
          text: 'something to say',
          maxChars: 800,
          enabled,
          muted,
          source: 'agent',
          windowFocused: true,
          isSelected: true
        })
        if (!enabled) expect(reason).toBe('disabled')
        else if (muted) expect(reason).toBe('muted')
        else expect(reason).toBe('focus')
      }
    }
  })
})
