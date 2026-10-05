import { createI18n } from 'vue-i18n'
import en from './en.json'
import ptBR from './pt-BR.json'

export type MessageSchema = typeof en

export const SUPPORTED_LOCALES = ['en', 'pt-BR'] as const
export type Locale = (typeof SUPPORTED_LOCALES)[number]

const STORAGE_KEY = 'om2tab.locale'

function isSupported(value: string): value is Locale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value)
}

/**
 * Pick the initial locale, honoring (in order):
 *   1. user override stored under `om2tab.locale`,
 *   2. `navigator.language` (and its variants) when it matches a supported tag,
 *   3. `'en'` fallback.
 *
 * Matching is best-effort: we try the full tag first (e.g. `pt-BR`), then the
 * base language (`pt`) against any supported tag that starts with the same
 * prefix.
 */
function detectInitialLocale(): Locale {
  // 1. Persisted user choice wins.
  try {
    const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null
    if (stored && isSupported(stored)) return stored
  } catch {
    // localStorage can throw in restricted contexts; fall through.
  }

  // 2. Navigator language. Try the full tag, then the base subtag.
  if (typeof navigator !== 'undefined') {
    const candidates: string[] = []
    if (navigator.language) candidates.push(navigator.language)
    if (Array.isArray(navigator.languages)) candidates.push(...navigator.languages)

    for (const raw of candidates) {
      if (!raw) continue
      if (isSupported(raw)) return raw
      const base = raw.split('-')[0]?.toLowerCase()
      if (!base) continue
      const match = SUPPORTED_LOCALES.find((loc) => loc.toLowerCase().split('-')[0] === base)
      if (match) return match
    }
  }

  // 3. Fallback.
  return 'en'
}

const initialLocale = detectInitialLocale()

export const i18n = createI18n<{ message: MessageSchema }, Locale>({
  legacy: false,
  locale: initialLocale,
  fallbackLocale: 'en',
  messages: { en, 'pt-BR': ptBR }
})

/**
 * Push the EFFECTIVE active locale to the main process (T85). Main caches +
 * persists it so `harnu-features.ts` can tell every spawned session which language
 * to write project memory in — the renderer is the only owner of the Settings
 * locale (`om2tab.locale`). Best-effort: the preload bridge is absent in
 * non-Electron contexts (unit env / SSR), where this is a silent no-op.
 */
function syncLocaleToMain(locale: Locale): void {
  try {
    const bridge = (globalThis as { api?: { setAppLocale?: (l: string) => unknown } }).api
    bridge?.setAppLocale?.(locale)
  } catch {
    // best-effort — a missing bridge must never break i18n init.
  }
}

// Boot: report the initial effective locale so main has it before the first spawn.
syncLocaleToMain(initialLocale)

/**
 * The user's persisted locale override, or `null` when none is set (i.e. the app
 * is following the system/`navigator` language). Reads the same key
 * `detectInitialLocale` honors, so the Settings language row can reflect whether
 * a manual choice or "System default" is active.
 */
export function getStoredLocale(): Locale | null {
  try {
    const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null
    return stored && isSupported(stored) ? stored : null
  } catch {
    return null
  }
}

/**
 * Switch the active locale live and persist the choice so it survives reloads.
 *
 * - Pass a supported `Locale` to pin it (persisted under `om2tab.locale`).
 * - Pass `null` for "System default": drop the override key and re-run detection
 *   (`navigator.language` → `'en'`), applying the detected locale immediately.
 *
 * No-op for an unsupported non-null locale.
 */
export function setLocale(locale: Locale | null): void {
  // i18n.global.locale is a WritableComputedRef<Locale> in composition mode
  // (legacy: false), but the generic signature loses that detail — hence the
  // double-cast through `unknown`.
  const global = i18n.global as unknown as { locale: { value: Locale } }

  if (locale === null) {
    // "System default" — remove the override, then apply the freshly detected one.
    try {
      if (typeof localStorage !== 'undefined') localStorage.removeItem(STORAGE_KEY)
    } catch {
      // ignore — best-effort.
    }
    global.locale.value = detectInitialLocale()
    // T85: report the newly EFFECTIVE locale (post-detection) to main.
    syncLocaleToMain(global.locale.value)
    return
  }

  if (!isSupported(locale)) return
  global.locale.value = locale
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, locale)
  } catch {
    // ignore — best-effort persistence.
  }
  // T85: report the newly effective locale to main so the preamble stays in sync.
  syncLocaleToMain(locale)
}
