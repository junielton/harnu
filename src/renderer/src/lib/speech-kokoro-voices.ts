/**
 * The Kokoro voice catalog and, more importantly, what it does **not** offer
 * (T241, AC-8).
 *
 * ## Why Portuguese is not here
 *
 * The Kokoro-82M model itself does have Portuguese voices (`pf_dora`,
 * `pm_alex`, `pm_santa`), and the phonemizer `kokoro-js` bundles is an espeak-ng
 * build that can phonemise Portuguese. Neither fact helps, because `kokoro-js`
 * hardcodes its language map to `en-us` / `en-gb` and exports a `VOICES` object
 * containing only the 28 English voices. Downloading more does not unlock
 * Portuguese; unlocking it needs a fork of that language map, which is
 * explicitly out of scope for this card.
 *
 * So this module states that in data. A locale is either `available` or
 * `unavailable` **with a reason** — there is no third state where a caller
 * offers a voice that will not work. Being visibly unavailable is the
 * requirement; being silently broken is the failure mode this exists to stop.
 */

export type KokoroLocaleStatus = 'available' | 'unavailable'

export interface KokoroLocale {
  /** BCP-47 tag, matching the app's own locale ids where they overlap. */
  locale: string
  status: KokoroLocaleStatus
  /** i18n key explaining an `unavailable`. Null when the locale works. */
  reasonKey: string | null
}

export interface KokoroVoice {
  id: string
  name: string
  locale: string
  gender: 'female' | 'male'
  /** Upstream's own overall grade (`VOICES.md`). `A` is the best on offer. */
  grade: string
}

const F = 'female' as const
const M = 'male' as const

/**
 * The 28 voices `kokoro-js@1.2.1` exposes — American (`af_`/`am_`) and British
 * (`bf_`/`bm_`) English, and nothing else. Kept in sync with upstream's
 * `VOICES` export; `speech-kokoro-voices.test.ts` asserts the shape and the
 * English-only invariant that AC-8 rests on.
 */
export const KOKORO_VOICES: readonly KokoroVoice[] = Object.freeze([
  { id: 'af_heart', name: 'Heart', locale: 'en-US', gender: F, grade: 'A' },
  { id: 'af_bella', name: 'Bella', locale: 'en-US', gender: F, grade: 'A-' },
  { id: 'af_nicole', name: 'Nicole', locale: 'en-US', gender: F, grade: 'B-' },
  { id: 'af_aoede', name: 'Aoede', locale: 'en-US', gender: F, grade: 'C+' },
  { id: 'af_kore', name: 'Kore', locale: 'en-US', gender: F, grade: 'C+' },
  { id: 'af_sarah', name: 'Sarah', locale: 'en-US', gender: F, grade: 'C+' },
  { id: 'af_nova', name: 'Nova', locale: 'en-US', gender: F, grade: 'C' },
  { id: 'af_sky', name: 'Sky', locale: 'en-US', gender: F, grade: 'C-' },
  { id: 'af_alloy', name: 'Alloy', locale: 'en-US', gender: F, grade: 'C' },
  { id: 'af_jessica', name: 'Jessica', locale: 'en-US', gender: F, grade: 'D' },
  { id: 'af_river', name: 'River', locale: 'en-US', gender: F, grade: 'D' },
  { id: 'am_michael', name: 'Michael', locale: 'en-US', gender: M, grade: 'C+' },
  { id: 'am_fenrir', name: 'Fenrir', locale: 'en-US', gender: M, grade: 'C+' },
  { id: 'am_puck', name: 'Puck', locale: 'en-US', gender: M, grade: 'C+' },
  { id: 'am_echo', name: 'Echo', locale: 'en-US', gender: M, grade: 'D' },
  { id: 'am_eric', name: 'Eric', locale: 'en-US', gender: M, grade: 'D' },
  { id: 'am_liam', name: 'Liam', locale: 'en-US', gender: M, grade: 'D' },
  { id: 'am_onyx', name: 'Onyx', locale: 'en-US', gender: M, grade: 'D' },
  { id: 'am_santa', name: 'Santa', locale: 'en-US', gender: M, grade: 'D-' },
  { id: 'am_adam', name: 'Adam', locale: 'en-US', gender: M, grade: 'F+' },
  { id: 'bf_emma', name: 'Emma', locale: 'en-GB', gender: F, grade: 'B-' },
  { id: 'bf_isabella', name: 'Isabella', locale: 'en-GB', gender: F, grade: 'C' },
  { id: 'bf_alice', name: 'Alice', locale: 'en-GB', gender: F, grade: 'D' },
  { id: 'bf_lily', name: 'Lily', locale: 'en-GB', gender: F, grade: 'D' },
  { id: 'bm_george', name: 'George', locale: 'en-GB', gender: M, grade: 'C' },
  { id: 'bm_fable', name: 'Fable', locale: 'en-GB', gender: M, grade: 'C' },
  { id: 'bm_lewis', name: 'Lewis', locale: 'en-GB', gender: M, grade: 'D+' },
  { id: 'bm_daniel', name: 'Daniel', locale: 'en-GB', gender: M, grade: 'D' }
])

/** The voice a first install fetches when the caller names none. */
export const KOKORO_DEFAULT_VOICE = 'af_heart'

/** i18n key for the one reason any locale is currently unavailable. */
export const KOKORO_ENGLISH_ONLY_KEY = 'voice.kokoro.englishOnly'

/**
 * Every locale the app itself speaks, answered honestly for this engine. The
 * app ships `en` and `pt-BR`; `pt-BR` is `unavailable` with a reason, which is
 * exactly what AC-8 asks for.
 */
export const KOKORO_LOCALES: readonly KokoroLocale[] = Object.freeze([
  { locale: 'en-US', status: 'available', reasonKey: null },
  { locale: 'en-GB', status: 'available', reasonKey: null },
  { locale: 'pt-BR', status: 'unavailable', reasonKey: KOKORO_ENGLISH_ONLY_KEY }
])

/**
 * Is this engine usable for `locale`? Matches on the language subtag, so `pt`,
 * `pt-BR` and `pt-PT` all answer the same way, and an unknown locale answers
 * `unavailable` rather than optimistically `available`.
 */
export function kokoroLocaleSupport(locale: string): KokoroLocale {
  const lang = String(locale ?? '')
    .split('-')[0]
    ?.toLowerCase()
  const hit = KOKORO_LOCALES.find((l) => l.locale.split('-')[0]?.toLowerCase() === lang)
  return (
    hit ?? {
      locale: String(locale ?? ''),
      status: 'unavailable',
      reasonKey: KOKORO_ENGLISH_ONLY_KEY
    }
  )
}

/** Voices offered for a locale — empty for anything the engine cannot speak. */
export function kokoroVoicesFor(locale: string): KokoroVoice[] {
  if (kokoroLocaleSupport(locale).status !== 'available') return []
  const lang = String(locale).split('-')[0]?.toLowerCase()
  return KOKORO_VOICES.filter((v) => v.locale.split('-')[0]?.toLowerCase() === lang)
}

export function isKokoroVoice(id: unknown): id is string {
  return typeof id === 'string' && KOKORO_VOICES.some((v) => v.id === id)
}

/** Coerce a stored/agent-supplied voice id to one that exists. */
export function resolveKokoroVoice(id: unknown): string {
  return isKokoroVoice(id) ? id : KOKORO_DEFAULT_VOICE
}
