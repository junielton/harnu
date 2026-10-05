import { describe, it, expect } from 'vitest'
import {
  isKokoroVoice,
  kokoroLocaleSupport,
  kokoroVoicesFor,
  resolveKokoroVoice,
  KOKORO_DEFAULT_VOICE,
  KOKORO_ENGLISH_ONLY_KEY,
  KOKORO_LOCALES,
  KOKORO_VOICES
} from '../src/renderer/src/lib/speech-kokoro-voices'
import en from '../src/renderer/src/i18n/en.json'
import ptBR from '../src/renderer/src/i18n/pt-BR.json'

describe('KOKORO_VOICES', () => {
  it('is exactly the 28 voices kokoro-js@1.2.1 exposes', () => {
    expect(KOKORO_VOICES).toHaveLength(28)
    expect(new Set(KOKORO_VOICES.map((v) => v.id)).size).toBe(28)
  })

  it('is English only — the invariant AC-8 rests on', () => {
    // The Kokoro MODEL has pf_dora / pm_alex / pm_santa. kokoro-js does not
    // expose them: its language map is hardcoded to en-us / en-gb. Downloading
    // more bytes does not change that; a fork of the map would, and that is
    // out of scope for T241.
    expect(KOKORO_VOICES.every((v) => v.locale.startsWith('en-'))).toBe(true)
    expect(KOKORO_VOICES.some((v) => v.id.startsWith('pf_') || v.id.startsWith('pm_'))).toBe(false)
  })

  it('carries upstream grades so a caller can pick a good voice', () => {
    expect(KOKORO_VOICES.find((v) => v.id === 'af_heart')?.grade).toBe('A')
    expect(KOKORO_VOICES.find((v) => v.id === 'am_adam')?.grade).toBe('F+')
  })

  it('defaults to the best-graded voice', () => {
    expect(KOKORO_DEFAULT_VOICE).toBe('af_heart')
    expect(KOKORO_VOICES.find((v) => v.id === KOKORO_DEFAULT_VOICE)?.grade).toBe('A')
  })
})

describe('kokoroLocaleSupport (AC-8)', () => {
  it('marks pt-BR unavailable WITH a reason — never silently broken', () => {
    const pt = kokoroLocaleSupport('pt-BR')
    expect(pt.status).toBe('unavailable')
    expect(pt.reasonKey).toBe(KOKORO_ENGLISH_ONLY_KEY)
  })

  it('answers the same for every Portuguese variant', () => {
    for (const tag of ['pt', 'pt-BR', 'pt-PT', 'PT-br']) {
      expect(kokoroLocaleSupport(tag).status).toBe('unavailable')
    }
  })

  it('marks English available', () => {
    expect(kokoroLocaleSupport('en-US').status).toBe('available')
    expect(kokoroLocaleSupport('en').status).toBe('available')
    expect(kokoroLocaleSupport('en-GB').reasonKey).toBeNull()
  })

  it('treats an unknown locale as unavailable, not optimistically available', () => {
    const de = kokoroLocaleSupport('de-DE')
    expect(de.status).toBe('unavailable')
    expect(de.reasonKey).toBe(KOKORO_ENGLISH_ONLY_KEY)
  })

  it('offers no voices at all for a locale it cannot speak', () => {
    expect(kokoroVoicesFor('pt-BR')).toEqual([])
    expect(kokoroVoicesFor('de-DE')).toEqual([])
  })

  it('offers every English voice to any English locale', () => {
    // The split is American vs British accent, not two separate catalogs — an
    // operator on en-US may well want bm_george.
    expect(kokoroVoicesFor('en-US')).toHaveLength(28)
    expect(kokoroVoicesFor('en-GB')).toHaveLength(28)
  })

  it('covers every locale the app itself ships', () => {
    // If Harnu adds a locale, this list has to answer for it — otherwise the
    // pane would fall back to the generic "unavailable" without a considered
    // reason.
    for (const tag of ['en', 'pt-BR']) {
      const lang = tag.split('-')[0]
      expect(KOKORO_LOCALES.some((l) => l.locale.split('-')[0] === lang)).toBe(true)
    }
  })
})

describe('the reason string exists in both locales', () => {
  it('is a real i18n key, not a dangling one', () => {
    const read = (obj: unknown, key: string): unknown =>
      key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | null)?.[k], obj)
    expect(typeof read(en, KOKORO_ENGLISH_ONLY_KEY)).toBe('string')
    expect(typeof read(ptBR, KOKORO_ENGLISH_ONLY_KEY)).toBe('string')
  })
})

describe('resolveKokoroVoice', () => {
  it('keeps a real voice', () => {
    expect(resolveKokoroVoice('bm_george')).toBe('bm_george')
  })

  it('coerces anything else to the default rather than failing at synthesis', () => {
    for (const bad of ['pf_dora', 'nope', '', null, undefined, 42]) {
      expect(resolveKokoroVoice(bad)).toBe(KOKORO_DEFAULT_VOICE)
    }
  })

  it('rejects a Portuguese voice id even though the model has one', () => {
    expect(isKokoroVoice('pf_dora')).toBe(false)
  })
})
