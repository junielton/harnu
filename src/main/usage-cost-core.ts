/**
 * Pure cost-computation core for the "real cost engine" (T47 P5). Given the
 * raw JSONL lines of ONE transcript file (a session's main file, or one of its
 * `subagents/agent-*.jsonl` companions), this module dedupes the block-split
 * assistant records, prices each deduped request against the published Claude
 * pricing table, and folds the result into compact per-(day, model, session)
 * buckets that the shell (`usage-cost.ts`) can cache per-file and merge across
 * the whole `~/.claude/projects/` tree.
 *
 * Zero fs/electron deps — unit-tested in the `node` vitest env
 * (`tests/usage-cost-core.test.ts`). Mirrors the pure/shell split used across
 * the codebase (see `usage-history-core.ts` for the sibling engine).
 *
 * ## The dominant gotcha
 * One API response is split into N assistant JSONL records — one per content
 * block (thinking / text / each tool_use) — all sharing the same
 * `requestId` (fallback `message.id`) and carrying the IDENTICAL full `usage`.
 * Naive summing overcounts ~2.61×. We dedupe by that key and count usage
 * exactly ONCE per group (semantics #1).
 */

// ---- Pricing ----------------------------------------------------------------

/** $/Mtok rates for one pricing tier, plus the label surfaced in rollups. */
export interface PricingTier {
  label: string
  inPerM: number
  outPerM: number
  cacheWritePerM: number
  cacheReadPerM: number
}

/** $ per web_search request (flat, not per-token). */
export const WEB_SEARCH_COST_USD = 0.01

// Rates transcribed verbatim from the CLI's own `utils/modelCost.ts`. Each tier's `cacheWritePerM`
// is the FLAT (5-minute-TTL) rate = 1.25× input; since C6 cache writes are
// priced by TTL when the record carries the `cache_creation` breakdown
// (1h = 2× input — see `priceTokens`), with this flat rate as the fallback.
// The recipe's "the CLI ignores the 1h/5m split" note is stale: oracle
// validation against the CLI's persisted per-model costs proved the current
// CLI bills 1h writes at 2× input (bit-exact across every compared session).
export const TIER_SONNET: PricingTier = {
  label: 'sonnet-3.5-4.6',
  inPerM: 3,
  outPerM: 15,
  cacheWritePerM: 3.75,
  cacheReadPerM: 0.3
}
/**
 * Sonnet 5 — same sticker rates as the 3.5-4.6 line (verified published
 * rates, C5). NOTE: Sonnet 5 has an introductory price ($2/$10) through
 * 2026-08-31 which we deliberately do NOT model — deterministic sticker-rate
 * pricing beats a temporarily-accurate date branch.
 */
export const TIER_SONNET_5: PricingTier = {
  label: 'sonnet-5',
  inPerM: 3,
  outPerM: 15,
  cacheWritePerM: 3.75,
  cacheReadPerM: 0.3
}
export const TIER_OPUS_4: PricingTier = {
  label: 'opus-4-4.1',
  inPerM: 15,
  outPerM: 75,
  cacheWritePerM: 18.75,
  cacheReadPerM: 1.5
}
export const TIER_OPUS_45: PricingTier = {
  label: 'opus-4.5-4.6',
  inPerM: 5,
  outPerM: 25,
  cacheWritePerM: 6.25,
  cacheReadPerM: 0.5
}
/** Opus 4.6 with `usage.speed === 'fast'` — a flat 6× multiplier on the 4.5/4.6 tier. */
export const TIER_OPUS_46_FAST: PricingTier = {
  label: 'opus-4.6-fast',
  inPerM: 30,
  outPerM: 150,
  cacheWritePerM: 37.5,
  cacheReadPerM: 3.0
}
/** Opus 4.7/4.8 — verified published rates (C5), same numbers as the 4.5/4.6 tier. */
export const TIER_OPUS_47_48: PricingTier = {
  label: 'opus-4.7-4.8',
  inPerM: 5,
  outPerM: 25,
  cacheWritePerM: 6.25,
  cacheReadPerM: 0.5
}
/**
 * Opus 4.7/4.8 with `usage.speed === 'fast'`. Fast mode exists for these
 * tiers at premium pricing, but the multiplier is NOT in our published
 * reference — we apply the same 6× precedent as Opus 4.6 fast and mark the
 * request `estimated: true` (unverified rate), per the C5 delta.
 */
export const TIER_OPUS_47_48_FAST: PricingTier = {
  label: 'opus-4.7-4.8-fast',
  inPerM: 30,
  outPerM: 150,
  cacheWritePerM: 37.5,
  cacheReadPerM: 3.0
}
/**
 * Fable 5 / Mythos 5 — verified published rates (C5). Cache write = 1.25×
 * input, cache read = 0.1× input, consistent with every other tier. Fable has
 * no fast mode: `speed` is ignored for this family.
 */
export const TIER_FABLE_5: PricingTier = {
  label: 'fable-mythos-5',
  inPerM: 10,
  outPerM: 50,
  cacheWritePerM: 12.5,
  cacheReadPerM: 1.0
}
export const TIER_HAIKU_35: PricingTier = {
  label: 'haiku-3.5',
  inPerM: 0.8,
  outPerM: 4,
  cacheWritePerM: 1.0,
  cacheReadPerM: 0.08
}
export const TIER_HAIKU_45: PricingTier = {
  label: 'haiku-4.5',
  inPerM: 1,
  outPerM: 5,
  cacheWritePerM: 1.25,
  cacheReadPerM: 0.1
}
/**
 * Default tier priced for any model id we don't recognize (a brand-new /
 * renamed / date-stamped model, or a typo). The stated default: Sonnet rates —
 * the most common mid-tier family, so an unrecognized model neither wildly
 * over- nor under-counts. The affected bucket is ALWAYS marked `estimated`
 * (semantics #6) so the UI can hint "this number is a guess", never silently.
 */
export const TIER_DEFAULT_UNKNOWN: PricingTier = { ...TIER_SONNET, label: 'unknown-default' }

interface ModelPricing {
  tier: PricingTier
  estimated: boolean
}

/**
 * Match `<family>-<major>[-<minor>]`, where `<minor>` is only accepted as a
 * plausible version digit (1-2 digits, e.g. `-5`, `-6`, `-1`) and NOT
 * confused with a trailing date-stamp suffix (e.g. `-20250514`,
 * `-20251001`): the `(?!\d)` lookahead rejects a 1-2 digit group that is
 * immediately followed by more digits, which is exactly what a YYYYMMDD
 * stamp looks like. This lets `claude-opus-4-20250514` (no minor) and
 * `claude-opus-4-1-20250805` (minor `1`) both resolve correctly.
 */
function familyVersion(id: string, family: string): { major: number; minor: number | null } | null {
  const m = id.match(new RegExp(`${family}-(\\d+)(?:-(\\d{1,2})(?!\\d))?`))
  if (!m) return null
  return { major: Number(m[1]), minor: m[2] === undefined ? null : Number(m[2]) }
}

/**
 * Canonicalize a raw `message.model` id (e.g. `claude-sonnet-4-6`,
 * `claude-haiku-4-5-20251001`, `claude-opus-4-8`, `claude-fable-5`) to a
 * pricing tier. Parses the family + major.minor version out of the id
 * (tolerating a trailing date-stamp suffix, e.g. `-20250929`) rather than
 * matching exact strings, so dated snapshots of a known family/version still
 * price correctly. Anything outside the known family/version ranges — a
 * future major line (`opus-5`, `sonnet-6`), an unversioned alias, or an
 * unrelated family — falls back to {@link TIER_DEFAULT_UNKNOWN} with
 * `estimated: true`.
 */
export function canonicalizeModel(modelId: string, speed: string | null): ModelPricing {
  const id = modelId.toLowerCase()

  const opus = familyVersion(id, 'opus')
  if (opus) {
    const { major, minor } = opus
    if (major === 4 && (minor === null || minor === 1)) {
      return { tier: TIER_OPUS_4, estimated: false }
    }
    if (major === 4 && (minor === 5 || minor === 6)) {
      if (minor === 6 && speed === 'fast') return { tier: TIER_OPUS_46_FAST, estimated: false }
      return { tier: TIER_OPUS_45, estimated: false }
    }
    if (major === 4 && (minor === 7 || minor === 8)) {
      // Fast mode exists here but its multiplier is unpublished: 6× precedent
      // applied, flagged estimated (see TIER_OPUS_47_48_FAST).
      if (speed === 'fast') return { tier: TIER_OPUS_47_48_FAST, estimated: true }
      return { tier: TIER_OPUS_47_48, estimated: false }
    }
  }

  const sonnet = familyVersion(id, 'sonnet')
  if (sonnet) {
    const { major, minor } = sonnet
    if (major === 4 && (minor === null || (minor >= 0 && minor <= 6))) {
      return { tier: TIER_SONNET, estimated: false }
    }
    if (major === 3 && minor !== null && minor >= 5 && minor <= 7) {
      return { tier: TIER_SONNET, estimated: false }
    }
    if (major === 5 && minor === null) {
      return { tier: TIER_SONNET_5, estimated: false }
    }
  }

  const haiku = familyVersion(id, 'haiku')
  if (haiku) {
    const { major, minor } = haiku
    if (major === 3 && minor === 5) return { tier: TIER_HAIKU_35, estimated: false }
    if (major === 4 && minor === 5) return { tier: TIER_HAIKU_45, estimated: false }
  }

  // Fable 5 / Mythos 5 — no fast mode in this family, so `speed` is ignored.
  const fable = familyVersion(id, 'fable') ?? familyVersion(id, 'mythos')
  if (fable && fable.major === 5 && fable.minor === null) {
    return { tier: TIER_FABLE_5, estimated: false }
  }

  return { tier: TIER_DEFAULT_UNKNOWN, estimated: true }
}

// ---- Token/usage shapes -----------------------------------------------------

/** The token components we price + track separately (semantics #8). */
export interface TokenBreakdown {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export function emptyTokenBreakdown(): TokenBreakdown {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
}

function addTokens(a: TokenBreakdown, b: TokenBreakdown): TokenBreakdown {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens
  }
}

/**
 * TTL breakdown of one request's cache-write tokens, from
 * `usage.cache_creation` (`ephemeral_1h_input_tokens` / `ephemeral_5m_input_tokens`).
 * `null` when the record carries no breakdown (old transcripts / older CLI
 * versions) — then the flat rate applies to the whole `cacheWriteTokens`.
 */
export interface CacheWriteSplit {
  oneHourTokens: number
  fiveMinTokens: number
}

/** Cache-write $/Mtok by TTL, derived from the tier's input rate (C6). */
export function cacheWrite5mPerM(tier: PricingTier): number {
  return tier.inPerM * 1.25
}
export function cacheWrite1hPerM(tier: PricingTier): number {
  return tier.inPerM * 2
}

/**
 * Price one token breakdown + web-search count against a tier.
 *
 * Cache writes are priced by TTL (C6 — validated bit-exact against the CLI's
 * persisted per-model costs): 5-minute-TTL writes at 1.25× the input rate,
 * 1-hour-TTL writes at 2× the input rate, both derived from `tier.inPerM`.
 * When `cacheWriteSplit` is absent (old transcripts that don't carry the
 * `cache_creation` breakdown) the whole `cacheWriteTokens` is priced at the
 * tier's flat `cacheWritePerM` (= 1.25× input on every tier) — tokens are
 * never dropped. Any positive remainder between the total and the split's sum
 * is also priced at the flat rate, for the same never-drop reason.
 */
export function priceTokens(
  tokens: TokenBreakdown,
  webSearchRequests: number,
  tier: PricingTier,
  cacheWriteSplit?: CacheWriteSplit | null
): number {
  let cacheWriteCost: number
  if (cacheWriteSplit) {
    const { oneHourTokens, fiveMinTokens } = cacheWriteSplit
    const remainder = Math.max(0, tokens.cacheWriteTokens - oneHourTokens - fiveMinTokens)
    cacheWriteCost =
      (oneHourTokens / 1_000_000) * cacheWrite1hPerM(tier) +
      (fiveMinTokens / 1_000_000) * cacheWrite5mPerM(tier) +
      (remainder / 1_000_000) * tier.cacheWritePerM
  } else {
    cacheWriteCost = (tokens.cacheWriteTokens / 1_000_000) * tier.cacheWritePerM
  }
  return (
    (tokens.inputTokens / 1_000_000) * tier.inPerM +
    (tokens.outputTokens / 1_000_000) * tier.outPerM +
    (tokens.cacheReadTokens / 1_000_000) * tier.cacheReadPerM +
    cacheWriteCost +
    webSearchRequests * WEB_SEARCH_COST_USD
  )
}

// ---- Line parsing (fail-safe: never throws) ---------------------------------

/** One deduped, priced request extracted from a transcript line group. */
export interface PricedRequest {
  requestId: string
  timestampMs: number
  /** Raw `message.model` id, for display / debugging. */
  model: string
  tierLabel: string
  estimated: boolean
  tokens: TokenBreakdown
  /** TTL breakdown of `tokens.cacheWriteTokens`; `null` = record had none (flat-priced). */
  cacheWriteSplit: CacheWriteSplit | null
  webSearchRequests: number
  costUsd: number
}

interface RawAssistantRecord {
  requestId: string
  timestampMs: number
  model: string
  speed: string | null
  tokens: TokenBreakdown
  cacheWriteSplit: CacheWriteSplit | null
  webSearchRequests: number
}

function numOrZero(x: unknown): number {
  return typeof x === 'number' && Number.isFinite(x) ? x : 0
}

/**
 * Parse one raw JSONL line into a candidate assistant-usage record, or `null`
 * when the line should be skipped entirely: not JSON, not `type: 'assistant'`,
 * no `message.usage`, `message.model === '<synthetic>'`, `isMeta`, or
 * `isApiErrorMessage`. A `system`/`compact_boundary` record is already
 * excluded by the `type === 'assistant'` check — no special-casing needed.
 * The assistant call that GENERATES a compact summary is a normal assistant
 * record with real usage and is intentionally NOT filtered here: it is
 * billed, so it must be kept (semantics #3).
 */
export function parseAssistantLine(line: string): RawAssistantRecord | null {
  const trimmed = line.trim()
  if (!trimmed) return null

  let raw: unknown
  try {
    raw = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const rec = raw as Record<string, unknown>

  if (rec.type !== 'assistant') return null
  if (rec.isMeta === true) return null
  if (rec.isApiErrorMessage === true) return null

  const message = rec.message
  if (!message || typeof message !== 'object') return null
  const msg = message as Record<string, unknown>

  const model = msg.model
  if (typeof model !== 'string' || model === '<synthetic>') return null

  const usage = msg.usage
  if (!usage || typeof usage !== 'object') return null
  const u = usage as Record<string, unknown>

  const requestId =
    typeof rec.requestId === 'string' ? rec.requestId : typeof msg.id === 'string' ? msg.id : null
  if (!requestId) return null

  const timestamp = rec.timestamp
  const timestampMs = typeof timestamp === 'string' ? Date.parse(timestamp) : NaN
  if (!Number.isFinite(timestampMs)) return null

  const serverToolUse = u.server_tool_use
  const webSearchRequests =
    serverToolUse && typeof serverToolUse === 'object'
      ? numOrZero((serverToolUse as Record<string, unknown>).web_search_requests)
      : 0

  const speed = typeof u.speed === 'string' ? u.speed : null

  // TTL breakdown of the cache writes (C6). Absent/malformed → null, and the
  // flat rate applies downstream — tokens are never dropped.
  const cacheCreation = u.cache_creation
  const cacheWriteSplit: CacheWriteSplit | null =
    cacheCreation && typeof cacheCreation === 'object'
      ? {
          oneHourTokens: numOrZero(
            (cacheCreation as Record<string, unknown>).ephemeral_1h_input_tokens
          ),
          fiveMinTokens: numOrZero(
            (cacheCreation as Record<string, unknown>).ephemeral_5m_input_tokens
          )
        }
      : null

  return {
    requestId,
    timestampMs,
    model,
    speed,
    tokens: {
      inputTokens: numOrZero(u.input_tokens),
      outputTokens: numOrZero(u.output_tokens),
      cacheReadTokens: numOrZero(u.cache_read_input_tokens),
      cacheWriteTokens: numOrZero(u.cache_creation_input_tokens)
    },
    cacheWriteSplit,
    webSearchRequests
  }
}

/**
 * Parse + dedupe a whole file's lines into priced requests. One API response
 * spans multiple JSONL lines (one per content block) sharing the same
 * `requestId` (fallback `message.id`) and an IDENTICAL `usage` — keep only
 * the FIRST occurrence per group so usage is counted exactly once
 * (semantics #1). Never throws: unparseable/irrelevant lines are silently
 * skipped (fail-safe, matches `statusline-parse.ts`'s style).
 */
export function priceFileLines(lines: readonly string[]): PricedRequest[] {
  const seen = new Map<string, RawAssistantRecord>()
  for (const line of lines) {
    const rec = parseAssistantLine(line)
    if (!rec) continue
    if (!seen.has(rec.requestId)) seen.set(rec.requestId, rec)
  }

  const out: PricedRequest[] = []
  for (const rec of seen.values()) {
    const { tier, estimated } = canonicalizeModel(rec.model, rec.speed)
    const costUsd = priceTokens(rec.tokens, rec.webSearchRequests, tier, rec.cacheWriteSplit)
    out.push({
      requestId: rec.requestId,
      timestampMs: rec.timestampMs,
      model: rec.model,
      tierLabel: tier.label,
      estimated,
      tokens: rec.tokens,
      cacheWriteSplit: rec.cacheWriteSplit,
      webSearchRequests: rec.webSearchRequests,
      costUsd
    })
  }
  return out
}

// ---- cwd recovery --------------------------------------------------------------

/**
 * First top-level `cwd` string found in a transcript's lines — the REAL
 * project path, unlike the slug decode (dashes were slashes) which mangles
 * any project name containing `-` or `_` (`my-cool_project` decodes to
 * `my/cool/project`). Mirrors `claude-reader.ts`'s header recovery: JSONL
 * lines carry the session's `cwd` verbatim, so reading it back is lossless.
 * Returns `null` when no line carries a usable cwd (caller falls back to the
 * lossy decode). Never throws — garbage lines are skipped.
 */
export function extractFirstCwd(lines: readonly string[]): string | null {
  for (const line of lines) {
    if (!line.includes('"cwd"')) continue
    try {
      const obj = JSON.parse(line) as { cwd?: unknown }
      if (obj && typeof obj.cwd === 'string' && obj.cwd) return obj.cwd
    } catch {
      // torn/invalid line — keep scanning
    }
  }
  return null
}

// ---- Day keying --------------------------------------------------------------

/**
 * Local-timezone `YYYY-MM-DD` for an epoch-ms timestamp — matches
 * `usage-history-core.ts`'s `localDayKey` and the pane's "days are grouped in
 * your local timezone" copy. Each deduped REQUEST is keyed to the local day of
 * its OWN timestamp (semantics #7) — NOT the session's first-message day like
 * the CLI's `/cost` stats do. We diverge deliberately: a long-running session
 * that crosses midnight should split its spend across the days it actually
 * ran in, so "how much did I spend today" stays true even for sessions that
 * started yesterday.
 */
export function localDayKey(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// ---- Per-file buckets (the cache unit) ---------------------------------------

/**
 * One compact (day, model, session) aggregate. This is the shape cached per
 * file (keyed by `(path, size, mtimeMs)` in the shell) — far smaller than the
 * raw per-request list, and trivially additive across files: summing same-key
 * buckets from many files/sessions reproduces the full-tree rollup with no
 * re-parse.
 */
export interface CostBucket {
  day: string
  model: string
  tierLabel: string
  estimated: boolean
  projectPath: string
  sessionId: string
  isSubagent: boolean
  requestCount: number
  tokens: TokenBreakdown
  webSearchRequests: number
  costUsd: number
}

export interface FileBucketMeta {
  sessionId: string
  projectPath: string
  isSubagent: boolean
}

function bucketKey(b: Pick<CostBucket, 'day' | 'model' | 'sessionId' | 'isSubagent'>): string {
  return `${b.day} ${b.model} ${b.sessionId} ${b.isSubagent ? 1 : 0}`
}

/**
 * Parse + dedupe + price ONE file's lines and fold them into day×model×session
 * buckets. This is the function the shell calls per-file and caches the
 * result of (semantics #4: main files and `subagents/agent-*.jsonl` files
 * never overlap — call this once per file, merge the results, never double).
 */
export function buildFileCostBuckets(
  lines: readonly string[],
  meta: FileBucketMeta,
  dayKey: (ms: number) => string = localDayKey
): CostBucket[] {
  const priced = priceFileLines(lines)
  const byKey = new Map<string, CostBucket>()
  for (const p of priced) {
    const day = dayKey(p.timestampMs)
    const key = bucketKey({
      day,
      model: p.model,
      sessionId: meta.sessionId,
      isSubagent: meta.isSubagent
    })
    let b = byKey.get(key)
    if (!b) {
      b = {
        day,
        model: p.model,
        tierLabel: p.tierLabel,
        estimated: p.estimated,
        projectPath: meta.projectPath,
        sessionId: meta.sessionId,
        isSubagent: meta.isSubagent,
        requestCount: 0,
        tokens: emptyTokenBreakdown(),
        webSearchRequests: 0,
        costUsd: 0
      }
      byKey.set(key, b)
    }
    b.requestCount++
    b.tokens = addTokens(b.tokens, p.tokens)
    b.webSearchRequests += p.webSearchRequests
    b.costUsd += p.costUsd
    // estimated is sticky: if ANY contributing request in the bucket was
    // priced on the default/unknown tier, the whole bucket is flagged.
    if (p.estimated) b.estimated = true
  }
  return [...byKey.values()]
}

/**
 * Merge buckets from many files (already deduped within each file) into one
 * flat list, summing same-key buckets. Safe to call with buckets spanning the
 * whole `~/.claude/projects/` tree — dedup never crosses files (a `requestId`
 * group is always fully contained in one file), so summing here never
 * double-counts.
 */
export function mergeCostBuckets(bucketLists: readonly (readonly CostBucket[])[]): CostBucket[] {
  const byKey = new Map<string, CostBucket>()
  for (const list of bucketLists) {
    for (const b of list) {
      const key = bucketKey(b)
      const existing = byKey.get(key)
      if (!existing) {
        byKey.set(key, { ...b, tokens: { ...b.tokens } })
        continue
      }
      existing.requestCount += b.requestCount
      existing.tokens = addTokens(existing.tokens, b.tokens)
      existing.webSearchRequests += b.webSearchRequests
      existing.costUsd += b.costUsd
      if (b.estimated) existing.estimated = true
    }
  }
  return [...byKey.values()]
}

// ---- Rollups ------------------------------------------------------------------

export interface DailyCostRollup {
  day: string
  costUsd: number
  requestCount: number
  tokens: TokenBreakdown
  webSearchRequests: number
  /** Distinct sessions with ≥1 priced request attributed to this day. */
  sessionsWorked: number
  estimated: boolean
}

/** Fold merged buckets into per-day totals + the "sessions worked that day" count. */
export function buildDailyCostRollup(buckets: readonly CostBucket[]): DailyCostRollup[] {
  const byDay = new Map<
    string,
    {
      costUsd: number
      requestCount: number
      tokens: TokenBreakdown
      webSearchRequests: number
      sessions: Set<string>
      estimated: boolean
    }
  >()
  for (const b of buckets) {
    let d = byDay.get(b.day)
    if (!d) {
      d = {
        costUsd: 0,
        requestCount: 0,
        tokens: emptyTokenBreakdown(),
        webSearchRequests: 0,
        sessions: new Set(),
        estimated: false
      }
      byDay.set(b.day, d)
    }
    d.costUsd += b.costUsd
    d.requestCount += b.requestCount
    d.tokens = addTokens(d.tokens, b.tokens)
    d.webSearchRequests += b.webSearchRequests
    d.sessions.add(b.sessionId)
    if (b.estimated) d.estimated = true
  }
  return [...byDay.entries()]
    .map(([day, d]) => ({
      day,
      costUsd: d.costUsd,
      requestCount: d.requestCount,
      tokens: d.tokens,
      webSearchRequests: d.webSearchRequests,
      sessionsWorked: d.sessions.size,
      estimated: d.estimated
    }))
    .sort((a, b) => a.day.localeCompare(b.day))
}

export interface ModelCostRollup {
  model: string
  tierLabel: string
  estimated: boolean
  costUsd: number
  requestCount: number
  tokens: TokenBreakdown
}

/** Fold merged buckets into per-model totals (all days, all sessions). */
export function buildModelCostRollup(buckets: readonly CostBucket[]): ModelCostRollup[] {
  const byModel = new Map<string, ModelCostRollup>()
  for (const b of buckets) {
    let m = byModel.get(b.model)
    if (!m) {
      m = {
        model: b.model,
        tierLabel: b.tierLabel,
        estimated: b.estimated,
        costUsd: 0,
        requestCount: 0,
        tokens: emptyTokenBreakdown()
      }
      byModel.set(b.model, m)
    }
    m.costUsd += b.costUsd
    m.requestCount += b.requestCount
    m.tokens = addTokens(m.tokens, b.tokens)
    if (b.estimated) m.estimated = true
  }
  return [...byModel.values()].sort((a, b) => b.costUsd - a.costUsd)
}

export interface ProjectCostRollup {
  projectPath: string
  costUsd: number
  requestCount: number
  sessionCount: number
  estimated: boolean
}

/** Fold merged buckets into per-project totals. */
export function buildProjectCostRollup(buckets: readonly CostBucket[]): ProjectCostRollup[] {
  const byProject = new Map<
    string,
    { costUsd: number; requestCount: number; sessions: Set<string>; estimated: boolean }
  >()
  for (const b of buckets) {
    let p = byProject.get(b.projectPath)
    if (!p) {
      p = { costUsd: 0, requestCount: 0, sessions: new Set(), estimated: false }
      byProject.set(b.projectPath, p)
    }
    p.costUsd += b.costUsd
    p.requestCount += b.requestCount
    p.sessions.add(b.sessionId)
    if (b.estimated) p.estimated = true
  }
  return [...byProject.entries()]
    .map(([projectPath, p]) => ({
      projectPath,
      costUsd: p.costUsd,
      requestCount: p.requestCount,
      sessionCount: p.sessions.size,
      estimated: p.estimated
    }))
    .sort((a, b) => b.costUsd - a.costUsd)
}

export interface SessionCostRollup {
  sessionId: string
  projectPath: string
  costUsd: number
  requestCount: number
  firstDay: string
  lastDay: string
  estimated: boolean
}

/** Fold merged buckets into per-session totals (across every day it ran). */
export function buildSessionCostRollup(buckets: readonly CostBucket[]): SessionCostRollup[] {
  const bySession = new Map<
    string,
    {
      projectPath: string
      costUsd: number
      requestCount: number
      days: Set<string>
      estimated: boolean
    }
  >()
  for (const b of buckets) {
    let s = bySession.get(b.sessionId)
    if (!s) {
      s = {
        projectPath: b.projectPath,
        costUsd: 0,
        requestCount: 0,
        days: new Set(),
        estimated: false
      }
      bySession.set(b.sessionId, s)
    }
    s.costUsd += b.costUsd
    s.requestCount += b.requestCount
    s.days.add(b.day)
    if (b.estimated) s.estimated = true
  }
  return [...bySession.entries()]
    .map(([sessionId, s]) => {
      const days = [...s.days].sort()
      return {
        sessionId,
        projectPath: s.projectPath,
        costUsd: s.costUsd,
        requestCount: s.requestCount,
        firstDay: days[0],
        lastDay: days[days.length - 1],
        estimated: s.estimated
      }
    })
    .sort((a, b) => b.costUsd - a.costUsd)
}
