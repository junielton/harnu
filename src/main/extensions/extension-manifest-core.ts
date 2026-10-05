/**
 * Extension manifest parse + validate core (T137 — Extension SDK Phase 1).
 *
 * Turns the UNTRUSTED raw JSON of `~/.claude/capy-extensions/<id>/manifest.json`
 * into a {@link ParsedExtensionManifest}, or a typed rejection with a reason —
 * the same two-tier resilience shape as the detector triad
 * (`detect/manifest-load-core.ts`), generalized once so future `contributes`
 * keys (modes, T138+) fold in without a redesign:
 *
 *  - a STRUCTURALLY invalid manifest (not an object, no `id`/`label`, `id`
 *    mismatching its folder name) is REJECTED with a reason — the whole
 *    extension never loads;
 *  - each `contributes` key is validated INDEPENDENTLY, and within a key each
 *    entry is validated independently — a single malformed theme or board
 *    template must never disable a working sibling contribution.
 *
 * Per ADR-0002 §2.2, extension content is held to a STRICTER bar than in-repo
 * content: a theme missing any of the 36 tokens is dropped, never silently
 * inherits a default (unlike `themes.css`'s convention-only contract).
 *
 * Pure (no fs/electron) — the I/O shell (`extensions-loader.ts`) reads the
 * directory + `JSON.parse`s the file and hands the result here.
 */

import { CARD_KINDS, isCardKind, type CardKind } from '../roadmap-core'

/** A folder/manifest id — restricted to CSS-selector-safe, path-safe characters. */
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// ---- top-level manifest -----------------------------------------------------

/** The raw on-disk manifest shape — every field unknown, it comes from disk. */
export interface RawExtensionManifest {
  id?: unknown
  label?: unknown
  version?: unknown
  contributes?: unknown
}

/** A structurally-valid manifest, `contributes` kept raw for per-key validation. */
export interface ParsedExtensionManifest {
  id: string
  label: string
  version: string
  contributesRaw: Record<string, unknown>
}

export type ManifestParseResult =
  { ok: true; manifest: ParsedExtensionManifest } | { ok: false; error: string }

/**
 * Validate the manifest's structural shape. `folderId` is the directory name
 * the manifest was read from — the manifest's own `id` must match it exactly
 * (fail-closed against a spoofed/duplicated id rather than silently trusting
 * whichever wins a Map insert).
 */
export function parseExtensionManifest(raw: unknown, folderId: string): ManifestParseResult {
  if (!isRecord(raw)) return { ok: false, error: 'manifest must be a JSON object' }
  if (!isNonEmptyString(raw.id) || !ID_PATTERN.test(raw.id)) {
    return { ok: false, error: 'manifest must have a non-empty, path-safe "id"' }
  }
  if (raw.id !== folderId) {
    return {
      ok: false,
      error: `manifest "id" ("${raw.id}") must match its folder name ("${folderId}")`
    }
  }
  if (!isNonEmptyString(raw.label)) {
    return { ok: false, error: `manifest "${folderId}" must have a non-empty "label"` }
  }
  if (raw.version !== undefined && !isNonEmptyString(raw.version)) {
    return { ok: false, error: `manifest "${folderId}" has a non-string "version"` }
  }
  if (raw.contributes !== undefined && !isRecord(raw.contributes)) {
    return { ok: false, error: `manifest "${folderId}" has a non-object "contributes"` }
  }
  return {
    ok: true,
    manifest: {
      id: raw.id,
      label: raw.label,
      version: isNonEmptyString(raw.version) ? raw.version : '0.0.0',
      contributesRaw: isRecord(raw.contributes) ? raw.contributes : {}
    }
  }
}

// ---- contributes.themes — the 36-token contract (ADR-0002 §2.2) ------------

/** The 20 UI tokens every theme must define (mirrors `themes.css`'s `--color-*` block). */
const UI_TOKEN_KEYS = [
  'bg',
  'sidebar',
  'surface',
  'surface2',
  'border',
  'border2',
  'text',
  'text2',
  'text3',
  'text4',
  'textDisabled',
  'accent',
  'accentSoft',
  'accentLine',
  'accentInk',
  'green',
  'greenSoft',
  'red',
  'redSoft',
  'warning'
] as const

/** The 16 ANSI tokens every theme must define, in xterm order (mirrors `--term-ansi-*`). */
const ANSI_TOKEN_KEYS = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite'
] as const

export type ExtensionThemeTokens = Record<(typeof UI_TOKEN_KEYS)[number], string> & {
  ansi: Record<(typeof ANSI_TOKEN_KEYS)[number], string>
}

/** A validated theme contribution, namespaced so it can never collide with a builtin or a sibling extension's theme. */
export interface ExtensionTheme {
  /** `ext-<extensionId>-<rawId>` — the value this theme is addressed by everywhere (persisted, `data-theme`). */
  id: string
  rawId: string
  extensionId: string
  extensionLabel: string
  label: string
  dark: boolean
  tokens: ExtensionThemeTokens
}

function parseThemeTokens(raw: unknown): ExtensionThemeTokens | null {
  if (!isRecord(raw)) return null
  for (const key of UI_TOKEN_KEYS) {
    if (!isNonEmptyString(raw[key])) return null
  }
  if (!isRecord(raw.ansi)) return null
  for (const key of ANSI_TOKEN_KEYS) {
    if (!isNonEmptyString(raw.ansi[key])) return null
  }
  const tokens = { ansi: {} } as ExtensionThemeTokens
  for (const key of UI_TOKEN_KEYS) tokens[key] = raw[key] as string
  for (const key of ANSI_TOKEN_KEYS)
    tokens.ansi[key] = (raw.ansi as Record<string, unknown>)[key] as string
  return tokens
}

/** Validate one raw theme entry, or `null` if unusable — dropped, never fatal to the pack. */
function parseThemeEntry(
  raw: unknown,
  extensionId: string,
  extensionLabel: string
): ExtensionTheme | null {
  if (!isRecord(raw)) return null
  if (!isNonEmptyString(raw.id) || !ID_PATTERN.test(raw.id)) return null
  if (!isNonEmptyString(raw.label)) return null
  if (typeof raw.dark !== 'boolean') return null
  const tokens = parseThemeTokens(raw.tokens)
  if (!tokens) return null
  return {
    id: `ext-${extensionId}-${raw.id}`,
    rawId: raw.id,
    extensionId,
    extensionLabel,
    label: raw.label,
    dark: raw.dark,
    tokens
  }
}

/**
 * Validate `contributes.themes` (an array). Each entry is independent — one
 * malformed theme (a missing token, a bad id) is dropped with a logged reason,
 * the rest of the array still loads.
 */
export function parseThemeContributions(
  raw: unknown,
  extensionId: string,
  extensionLabel: string,
  onReject?: (reason: string) => void
): ExtensionTheme[] {
  if (!Array.isArray(raw)) return []
  const out: ExtensionTheme[] = []
  for (const [i, entry] of raw.entries()) {
    const theme = parseThemeEntry(entry, extensionId, extensionLabel)
    if (theme) out.push(theme)
    else onReject?.(`theme #${i} in "${extensionId}" is missing a required field or token`)
  }
  return out
}

// ---- contributes.boardTemplates ---------------------------------------------

/** A validated `kind → relative path` board template contribution. */
export type BoardTemplateContributions = Partial<Record<CardKind, string>>

/**
 * Validate `contributes.boardTemplates` (an object keyed by {@link CardKind}).
 * An unknown kind key or a non-string path is dropped independently — never
 * fatal to sibling kinds or to the extension's other `contributes` keys.
 */
export function parseBoardTemplateContributions(
  raw: unknown,
  onReject?: (reason: string) => void
): BoardTemplateContributions {
  if (!isRecord(raw)) return {}
  const out: BoardTemplateContributions = {}
  for (const [kind, relPath] of Object.entries(raw)) {
    if (!isCardKind(kind)) {
      onReject?.(`boardTemplates key "${kind}" is not one of ${CARD_KINDS.join('|')}`)
      continue
    }
    if (!isNonEmptyString(relPath)) {
      onReject?.(`boardTemplates["${kind}"] must be a non-empty path string`)
      continue
    }
    out[kind] = relPath
  }
  return out
}

// ---- contributes.modes — a distributable session contract (T138) ----------

/**
 * A validated `contributes.modes` entry. `doc` is kept as the RAW relative
 * path (unresolved) — the registry fold (`extension-registry.ts`) resolves it
 * against the extension's own directory, mirroring `boardTemplates`; the
 * doc's CONTENT is read fresh at spawn time by `extensions-loader.ts`'s
 * `resolveModeContract`, never cached, so an edit is hot with no watcher
 * event needed (the same property board templates already have).
 */
export interface ExtensionMode {
  /** `ext-<extensionId>-<rawId>` — namespaced so it can never collide with a
   * builtin mode id or a sibling extension's mode (mirrors `ExtensionTheme.id`). */
  id: string
  rawId: string
  extensionId: string
  extensionLabel: string
  label: string
  /** A lucide glyph name from the documented subset; `''` falls back to the
   * renderer's default icon (mirrors the builtin registry's own fallback). */
  icon: string
  /** Relative path (from the extension's folder) to the contract's .md file. */
  doc: string
}

function parseModeEntry(
  raw: unknown,
  extensionId: string,
  extensionLabel: string
): ExtensionMode | null {
  if (!isRecord(raw)) return null
  if (!isNonEmptyString(raw.id) || !ID_PATTERN.test(raw.id)) return null
  if (!isNonEmptyString(raw.label)) return null
  if (!isNonEmptyString(raw.doc)) return null
  if (raw.icon !== undefined && typeof raw.icon !== 'string') return null
  return {
    id: `ext-${extensionId}-${raw.id}`,
    rawId: raw.id,
    extensionId,
    extensionLabel,
    label: raw.label,
    icon: isNonEmptyString(raw.icon) ? raw.icon : '',
    doc: raw.doc
  }
}

/**
 * Validate `contributes.modes` (an array). Each entry is independent — one
 * malformed mode (a missing `doc`, a bad id) is dropped with a logged reason,
 * the rest of the array still loads (same per-entry fail-soft as themes).
 */
export function parseModeContributions(
  raw: unknown,
  extensionId: string,
  extensionLabel: string,
  onReject?: (reason: string) => void
): ExtensionMode[] {
  if (!Array.isArray(raw)) return []
  const out: ExtensionMode[] = []
  for (const [i, entry] of raw.entries()) {
    const mode = parseModeEntry(entry, extensionId, extensionLabel)
    if (mode) out.push(mode)
    else
      onReject?.(`mode #${i} in "${extensionId}" is missing a required field ("id"/"label"/"doc")`)
  }
  return out
}
