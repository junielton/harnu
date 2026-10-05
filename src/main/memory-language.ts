/**
 * The project-memory LANGUAGE rule (T85), as a pure string builder.
 *
 * Harnu's Settings locale is the single source of truth for the language of every
 * PERSISTED shared artifact — the `hot` snapshot, decisions, digests, roadmap /
 * kanban cards, session summaries — regardless of the language a session happens
 * to be chatting in. That locale lives only in the renderer (`om2tab.locale`); the
 * main process caches it (see `app-locale.ts`) and this module turns it into the
 * ONE runtime line appended to the self-awareness preamble (`harnu-features.ts`).
 *
 * Framework-free + side-effect-free per ADR-0001 (pure-core / thin-shell) so it is
 * unit-testable without electron — the env-bound preamble assembly is the shell.
 */

/** Human display name per supported locale tag (falls back to the raw tag). */
const LOCALE_NAMES: Record<string, string> = {
  en: 'English',
  'pt-BR': 'Portuguese (Brazil)'
}

/** Resolve a friendly display name for a locale tag (the raw tag if unknown). */
export function localeDisplayName(locale: string): string {
  return LOCALE_NAMES[locale] ?? locale
}

/**
 * The single runtime line the self-awareness preamble appends (T85): it tells the
 * session which language to WRITE project-memory content in, decoupled from the
 * chat language. A prompt-level contract (there is no server-side language check),
 * so the wording is unambiguous about scope: only `.harnu/memory/` writes.
 *
 * @param locale - the effective app locale (e.g. `en`, `pt-BR`).
 * @returns one Markdown line for the preamble.
 */
export function memoryLanguageLine(locale: string): string {
  const name = localeDisplayName(locale)
  return (
    `**Project-memory language.** The Harnu app language is **${name}** (\`${locale}\`). ` +
    `Write ALL project-memory content — the \`hot\` snapshot, decisions, digests, roadmap / ` +
    `kanban cards, and session summaries — in that language, whatever language you are chatting ` +
    `in. This applies only to what is persisted to \`.harnu/memory/\`; keep talking to the user ` +
    `in their own language.`
  )
}
