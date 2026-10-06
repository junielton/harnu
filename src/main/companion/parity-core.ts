/**
 * The parity ledger, pure (T389 P1W4 §7.5): the record shape and its scrubbing, the line format,
 * the rotation and retention decisions, and the comparator framework (rules, report, gate). No
 * I/O, no clock, no Electron; `parity-ledger.ts` is the shell that writes the files.
 *
 * Scrubbing (QA-9, SEC-8): no prompt text, no tool input, no absolute path, no token, no `conn`.
 * Every record is built here, so a field outside the rules below cannot reach a line.
 */

import { createHash } from 'node:crypto'
import type { FactSource, OwnReason } from './arbitration-core'
import type { FactFamily } from './mode'

/** Streams that are not a fact family: features with their own key (contract §11.5). */
export type FeatureKey = 'channel' | 'stamp' | 'sentinel' | 'external'
export type ParityStream = FactFamily | FeatureKey
export type Disposition = 'applied' | 'record-only' | 'dropped'
export type DetailValue = string | number | boolean | null

export interface ParityRecord {
  v: 1
  stream: ParityStream
  source: FactSource
  /** Who was authoritative when it was recorded. */
  owner: FactSource
  /** Why; P5W1 counts legacy sessions by it. */
  reason: OwnReason
  disposition: Disposition
  /** First 12 hex of SHA256(installSalt + sid): never the sid. */
  sk: string
  /** Host receive time, epoch ms. */
  t: number
  /** Source event time. */
  ts?: number
  /** Normalized fact key, stream-defined, e.g. `state:working`. */
  k: string
  d?: Record<string, DetailValue>
  cli: string
  mod: string | null
}

export interface ParityInput {
  stream: ParityStream
  source: FactSource
  owner: FactSource
  reason: OwnReason
  disposition: Disposition
  sid: string
  /** The per-install salt, so a label cannot be matched across installs. */
  salt: string
  t: number
  ts?: number
  k: string
  d?: Record<string, unknown>
  cli: string
  mod: string | null
}

// ---- scrubbing -----------------------------------------------------------------------------

/** A short identifier: letters, digits and a few separators. A `/`, a space or a quote is not one. */
const SAFE_VALUE = /^[A-Za-z0-9_.:+-]{0,48}$/
/** A token- or conn-shaped value (`c_…`, `sp_…`, `b_…`): safe by charset, refused by shape. */
const SECRET_SHAPE = /^(c|sp|b|tok|key)_[0-9a-f-]{12,}$/i
/** A detail key that names something the ledger must never carry. */
const DENIED_KEY =
  /(path|file|prompt|text|conn|token|spawn|cwd|dir|input|command|message|secret|auth|sid|session|body|url|env)/i
const SAFE_KEY = /^[A-Za-z][A-Za-z0-9_]{0,31}$/

const isSafeString = (v: string): boolean => SAFE_VALUE.test(v) && !SECRET_SHAPE.test(v)

function scrubDetail(d: Record<string, unknown>): Record<string, DetailValue> {
  const out: Record<string, DetailValue> = {}
  for (const [key, value] of Object.entries(d)) {
    if (!SAFE_KEY.test(key) || DENIED_KEY.test(key)) continue
    if (value === null || typeof value === 'boolean') out[key] = value
    else if (typeof value === 'number') {
      if (Number.isFinite(value)) out[key] = value
    } else if (typeof value === 'string' && isSafeString(value)) out[key] = value
  }
  return out
}

function normalizeKey(k: string): string {
  return k.length > 0 && k.length <= 64 && /^[A-Za-z0-9_.:+-]+$/.test(k) && !SECRET_SHAPE.test(k)
    ? k
    : 'redacted'
}

export function sessionLabel(salt: string, sid: string): string {
  return createHash('sha256').update(`${salt}${sid}`).digest('hex').slice(0, 12)
}

export function buildParityRecord(i: ParityInput): ParityRecord {
  const detail = i.d ? scrubDetail(i.d) : undefined
  return {
    v: 1,
    stream: i.stream,
    source: i.source,
    owner: i.owner,
    reason: i.reason,
    disposition: i.disposition,
    sk: sessionLabel(i.salt, i.sid),
    t: i.t,
    ...(i.ts !== undefined && Number.isFinite(i.ts) ? { ts: i.ts } : {}),
    k: normalizeKey(i.k),
    ...(detail && Object.keys(detail).length > 0 ? { d: detail } : {}),
    cli: normalizeKey(i.cli),
    mod: i.mod === null ? null : normalizeKey(i.mod)
  }
}

// ---- the line format -----------------------------------------------------------------------

export const serializeParityRecord = (rec: ParityRecord): string => JSON.stringify(rec) + '\n'

/** Skips a torn, foreign or future-version line instead of throwing. */
export function parseParityLines(text: string): ParityRecord[] {
  const out: ParityRecord[] = []
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      const r = JSON.parse(line) as Partial<ParityRecord>
      if (
        r.v === 1 &&
        typeof r.stream === 'string' &&
        typeof r.sk === 'string' &&
        typeof r.k === 'string' &&
        typeof r.t === 'number'
      ) {
        out.push(r as ParityRecord)
      }
    } catch {
      // a torn last line after a crash
    }
  }
  return out
}

// ---- rotation and retention ----------------------------------------------------------------

export const PARITY_ROTATE_BYTES = 5 * 1024 * 1024
export const PARITY_GENERATIONS = 3
export const PARITY_RETENTION_MS = 14 * 86_400_000

export const rotationNeeded = (
  currentSize: number,
  adding: number,
  limit: number = PARITY_ROTATE_BYTES
): boolean => currentSize > 0 && currentSize + adding > limit

/** The generation files older than the retention window. The live file is never expired here. */
export function expiredGenerations(
  files: readonly { name: string; mtimeMs: number }[],
  now: number
): string[] {
  return files
    .filter((f) => /\.\d+\.ndjson$/.test(f.name) && now - f.mtimeMs > PARITY_RETENTION_MS)
    .map((f) => f.name)
}

// ---- the comparator ------------------------------------------------------------------------

export interface Divergence {
  sk: string
  at: number
  legacy: string | null
  companion: string | null
  /** A class named by the rule = explained; null = unexplained. */
  class: string | null
}

export interface ParityRule {
  stream: ParityStream
  /** One session's records, oldest first. */
  compare(sessionRecords: ParityRecord[]): Divergence[]
}

export interface ParityReport {
  sessions: number
  facts: number
  explained: Record<string, number>
  unexplained: Divergence[]
}

const rules = new Map<ParityStream, ParityRule>()

export function registerParityRule(rule: ParityRule): void {
  rules.set(rule.stream, rule)
}

export function resetParityRulesForTests(): void {
  rules.clear()
}

export function parityReport(stream: ParityStream, records: readonly ParityRecord[]): ParityReport {
  const mine = records.filter((r) => r.stream === stream)
  const bySession = new Map<string, ParityRecord[]>()
  for (const r of mine) {
    const list = bySession.get(r.sk) ?? []
    list.push(r)
    bySession.set(r.sk, list)
  }
  const report: ParityReport = {
    sessions: bySession.size,
    facts: mine.length,
    explained: {},
    unexplained: []
  }
  const rule = rules.get(stream)
  if (!rule) return report
  for (const [sk, list] of bySession) {
    list.sort((a, b) => a.t - b.t)
    let divergences: Divergence[]
    try {
      divergences = rule.compare(list)
    } catch {
      // a rule that cannot judge a session never passes it
      divergences = [{ sk, at: list[0].t, legacy: null, companion: null, class: null }]
    }
    for (const d of divergences) {
      if (d.class === null) report.unexplained.push(d)
      else report.explained[d.class] = (report.explained[d.class] ?? 0) + 1
    }
  }
  return report
}

export function gateStatus(
  report: ParityReport,
  gate: { minSessions: number; minFacts?: number }
): { pass: boolean; why: string[] } {
  const why: string[] = []
  if (report.sessions < gate.minSessions) {
    why.push(`sessions ${report.sessions} < ${gate.minSessions}`)
  }
  if (gate.minFacts !== undefined && report.facts < gate.minFacts) {
    why.push(`facts ${report.facts} < ${gate.minFacts}`)
  }
  if (report.unexplained.length > 0) why.push(`${report.unexplained.length} unexplained`)
  return { pass: why.length === 0, why }
}
