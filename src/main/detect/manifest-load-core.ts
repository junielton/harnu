/**
 * Manifest parse + validate + compile core (A2 two-tier state detection — T4).
 *
 * Turns the UNTRUSTED raw JSON of a detector manifest (a builtin bundled with
 * the app, or a user override at `~/.claude/detectors/<agent>.json`) into the
 * {@link CompiledManifest} that `screen-detect-core` matches against — or a
 * typed rejection with a reason. The on-disk format is JSON (not Herdr's TOML)
 * because the whole Harnu ecosystem is JSON (`settings.json`, `claude-boot.json`,
 * `harnu.mcp.json`) — no new parser. Shape is modelled on the design example.
 *
 * Pure (no fs/electron) per ADR-0001 — the I/O shell (read file, chokidar
 * hot-reload, plan T9) calls `JSON.parse` and hands the result here. Two
 * resilience rules the loader must honor, both tested:
 *
 *  - A STRUCTURALLY invalid manifest (not an object, no `agent`, `rules` not an
 *    array) is REJECTED with a reason — a bad file never silently behaves as an
 *    empty matcher.
 *  - A single BROKEN regex (or malformed rule) is SKIPPED, never fatal — one
 *    uncompilable pattern must not take down the rest of the set ("a broken
 *    regex must not break the whole set").
 *
 * Override precedence: `resolveManifest(builtin, override)` shallow-overlays the
 * override's top-level keys onto the builtin (override wins per key; absent keys
 * inherit the builtin), then compiles the result — so an override that only
 * tweaks `scan.lines` or `fallback` keeps the builtin's `rules`.
 */

import type {
  CompiledManifest,
  CompiledMatch,
  CompiledRule,
  ScreenState
} from './screen-detect-core'

/** Default bottom-N to scan when a manifest omits `scan.lines`. */
export const DEFAULT_SCAN_LINES = 30
/** Default resolved state when no rule matches. */
export const DEFAULT_FALLBACK: ScreenState = 'idle'

/** The valid `ScreenState` literals, for runtime enum validation. */
const SCREEN_STATES: ReadonlySet<string> = new Set<ScreenState>(['blocked', 'working', 'idle'])

/**
 * The raw on-disk manifest shape — every field optional/unknown because it
 * comes from an untrusted file. The compiler narrows it.
 */
export interface RawManifest {
  agent?: unknown
  match?: unknown
  scan?: unknown
  rules?: unknown
  fallback?: unknown
  osc?: unknown
}

/** Compile an array of pattern strings to flag-free regexes, dropping broken ones. */
function compilePatterns(patterns: unknown): RegExp[] {
  if (!Array.isArray(patterns)) return []
  return patterns.map(compilePattern).filter((re): re is RegExp => re !== null)
}

/**
 * Compile the `match` classifier block. Reads `titleRegex` (a single string),
 * `contentAny` (on-screen markers), and `process` (foreground-process-name
 * patterns, resolved in main). A broken/absent `titleRegex` → null; broken
 * content/process patterns are dropped. `process` accepts an array of strings
 * (regex patterns) — a bare string is also tolerated as a single pattern.
 */
function compileMatch(raw: unknown): CompiledMatch {
  if (!isRecord(raw)) return { titleRegex: null, contentAny: [], process: [] }
  const proc = typeof raw.process === 'string' ? [raw.process] : raw.process
  return {
    titleRegex: compilePattern(raw.titleRegex),
    contentAny: compilePatterns(raw.contentAny),
    process: compilePatterns(proc)
  }
}

/** Result of {@link parseManifest}: a compiled manifest or a rejection reason. */
export type ManifestParseResult =
  { ok: true; manifest: CompiledManifest } | { ok: false; error: string }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isScreenState(v: unknown): v is ScreenState {
  return typeof v === 'string' && SCREEN_STATES.has(v)
}

/**
 * Compile one pattern string to a flag-free `RegExp`, or `null` if it doesn't
 * compile. Flag-free keeps `.test` stateless (no shared `lastIndex`) and keeps
 * matching case-SENSITIVE, which the manifests rely on (design lists `Esc to
 * interrupt` and `esc to stop` as separate alternatives).
 */
function compilePattern(pattern: unknown): RegExp | null {
  if (typeof pattern !== 'string' || pattern.length === 0) return null
  try {
    return new RegExp(pattern)
  } catch {
    return null // a broken regex is dropped, never fatal
  }
}

/**
 * Compile one raw rule. Returns `null` when the rule is unusable (bad `state`,
 * `any` not an array, or every pattern broken) so the caller can skip it
 * without rejecting the whole manifest.
 */
function compileRule(raw: unknown): CompiledRule | null {
  if (!isRecord(raw)) return null
  if (!isScreenState(raw.state)) return null
  if (!Array.isArray(raw.any)) return null
  const any = raw.any.map(compilePattern).filter((re): re is RegExp => re !== null)
  if (any.length === 0) return null // no compilable pattern → drop the rule
  return { state: raw.state, any }
}

/** Read `scan.lines` (a positive integer) or fall back to the default. */
function readScanLines(scan: unknown): number {
  if (isRecord(scan)) {
    const lines = scan.lines
    if (typeof lines === 'number' && Number.isInteger(lines) && lines > 0) return lines
  }
  return DEFAULT_SCAN_LINES
}

/**
 * Validate + compile a raw manifest object. Structural failures reject with a
 * reason; soft failures (broken rules/patterns) are skipped. The result, when
 * `ok`, is ready for `matchManifest`.
 */
export function parseManifest(raw: unknown): ManifestParseResult {
  if (!isRecord(raw)) return { ok: false, error: 'manifest must be a JSON object' }
  if (typeof raw.agent !== 'string' || raw.agent.length === 0) {
    return { ok: false, error: 'manifest must have a non-empty "agent"' }
  }
  if (!Array.isArray(raw.rules)) {
    return { ok: false, error: `manifest "${raw.agent}" must have a "rules" array` }
  }
  const rules = raw.rules.map(compileRule).filter((r): r is CompiledRule => r !== null)
  return {
    ok: true,
    manifest: {
      agent: raw.agent,
      match: compileMatch(raw.match),
      scanLines: readScanLines(raw.scan),
      rules,
      fallback: isScreenState(raw.fallback) ? raw.fallback : DEFAULT_FALLBACK
    }
  }
}

/**
 * Shallow-overlay an override onto a builtin at the RAW level (before compile).
 * Override keys replace builtin keys wholesale (nested objects are replaced, not
 * deep-merged — a `rules` override replaces the whole array, never concatenates,
 * so an override is always a predictable superset/replacement). Absent override
 * keys inherit the builtin. Returns a fresh object; inputs are untouched.
 */
export function mergeRawManifests(builtin: RawManifest, override: RawManifest): RawManifest {
  const out: RawManifest = { ...builtin }
  for (const key of Object.keys(override) as (keyof RawManifest)[]) {
    if (override[key] !== undefined) out[key] = override[key]
  }
  return out
}

/**
 * Resolve the effective manifest for an agent from its builtin and an optional
 * local override, then compile. With no override this is just
 * `parseManifest(builtin)`; with one, the override's top-level keys win (see
 * {@link mergeRawManifests}). Local override precedence mirrors Herdr's model.
 */
export function resolveManifest(
  builtin: RawManifest,
  override: RawManifest | null
): ManifestParseResult {
  return parseManifest(override ? mergeRawManifests(builtin, override) : builtin)
}
