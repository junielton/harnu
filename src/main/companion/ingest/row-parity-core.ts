/**
 * The `row` parity comparison, pure (T455 spec §7.3 with the W0 findings' §8 amendments and the
 * classes the W1 verifiers established). No I/O, no clock: the row adapter hands it the push, the
 * cold baseline and what the legacy reader shows, at a main-loop turn end, and writes what comes
 * back to the `row` ledger stream. Texts live only in this call's arguments: a record carries the
 * group, a verdict, a class and two numbers, never a text (§5.5 rule 3).
 *
 * Texts are compared after the renderer's one normalizer (`firstRealPrompt`), so the push's 240
 * and the reader's 120 characters are not a divergence. A divergence gets a NAMED class only when
 * a mechanical rule below says so; anything else is `unexplained`. The classes:
 *
 *   E-HEAD           the reader froze at its 2 MiB head cap (spec §7.3)
 *   E-ORIGIN         the legacy names a machine-origin row: a peer message, a task notification
 *                    (spec §7.3, A-P1; W0 measured it as the peer share)
 *   E-TEAMMATE       the legacy's last prompt is a teammate message (W0 §3.4, M3a)
 *   E-SCHEDULED      the legacy's last prompt is a `/loop` re-fire (W0 §3.4, M3a)
 *   E-PLUGIN-BRIDGE  the legacy names a `plugin` or `bridge` row the fold skips by default
 *                    (W1; the operator's open call between M3a and P2W2 §7.7)
 *   E-HEADLESS       a `claude -p` session: its prompts are origin `sdk`, so no last prompt is
 *                    pushed (W1)
 *   E-RAWCAP         the legacy's first row is longer than the fold's RAW_MAX: a wrapper closing
 *                    past it makes the push `null` (W1 round 3)
 *   E-RAWCAP-WINDOW  the legacy's first row has no word boundary inside the 8 KiB redaction window:
 *                    the push is `null` (W1 round 3)
 *   E-REDACT         the push carries a `[REDACTED:<rule>]` placeholder where the legacy shows the
 *                    text; everything before it agrees (spec §5.5 rule 2). Added by W2, see
 *                    docs/dev/companion-mod.md
 *   E-STOPLESS       the turn ended without an answer (interrupt, refusal, error) (spec §7.3)
 *   E-TAIL           `tools` only: the reader's 512 KB tail holds fewer calls than five minutes
 *   E-SUBAGENT       `tools` only: a subagent called tools in the window
 *
 * `title` and `tools` are legacy-owned (§7.1): recorded, never gating (see parity-row-rule.ts).
 */

import { firstRealPrompt } from '../../claude-reader-derive'
import { RAW_MAX, REDACT_WINDOW } from '../../../../resources/companion/hooks/lib/row-fold'
import type { RowGroup } from '../arbitration-core'

export const ROW_CLASSES = [
  'E-HEAD',
  'E-ORIGIN',
  'E-TEAMMATE',
  'E-SCHEDULED',
  'E-PLUGIN-BRIDGE',
  'E-HEADLESS',
  'E-RAWCAP',
  'E-RAWCAP-WINDOW',
  'E-REDACT',
  'E-STOPLESS',
  'E-TAIL',
  'E-SUBAGENT'
] as const
export type RowClass = (typeof ROW_CLASSES)[number]

const ALL_CLASSES: ReadonlySet<RowClass> = new Set(ROW_CLASSES)

/** The match window of the `activity` group (§7.3). */
export const ACTIVITY_MATCH_MS = 2_500
/** The reader's head cap (`claude-reader.ts` MAX_SCAN_BYTES): head fields freeze past it. */
export const HEAD_CAP_BYTES = 2 * 1024 * 1024
/** The reader's tail window (`claude-reader.ts` TAIL_WINDOW_BYTES). */
export const TAIL_WINDOW_BYTES = 512 * 1024
/** How much of a legacy last-prompt line names a stored row (W0 §3.3). */
const NAME_PREFIX = 40

export type RowVerdict = 'match' | 'diverge' | 'unaligned' | 'unknown' | 'no-legacy'

/** A stored user row, classed by its shape as W0's `p1-prompts.ts` classes it. */
export type StoredShape =
  | 'typed'
  | 'command'
  | 'scheduled'
  | 'peer'
  | 'task-notification'
  | 'teammate'
  | 'plugin-bridge'
  | 'other'

/** The push as the adapter holds it (absent text = unknown), plus the 5-minute tool windows. */
export interface RowPushView {
  firstPrompt?: string | null
  lastPrompt?: string | null
  lastAssistant?: string | null
  title?: string | null
  userRows: number
  lastRowAt: number | null
  lastUuid: string | null
  /** Main-loop tool calls in the last five minutes, from the pushed samples; null = unknown. */
  toolCalls5m: number | null
  subagentToolCalls5m: number
}

/** The cold baseline: the reader's view of the history this process loaded (§6.2). */
export interface RowBaseline {
  firstPrompt: string
  lastPrompt: string
  userMessageCount: number
}

export interface RowLegacyView {
  /** The reader's header (`firstRealPrompt` of the head, the `last-prompt` line, …). */
  firstPrompt: string
  lastPrompt: string
  customTitle: string
  userMessageCount: number
  mtimeMs: number
  size: number
  /** The newest main-loop assistant text in the tail; null when none. */
  lastAssistant: string | null
  /** Whether the push's `lastUuid` is a row of the tail; null when the push has none. */
  uuidFound: boolean | null
  /** Main-loop rows with a uuid after that one, attachments included (M1: the push is behind). */
  rowsAfter: number
  /** The tail's main-loop user rows with text, oldest first, as the CLI would name them. */
  recentPrompts: readonly { text: string; shape: StoredShape }[]
  /** The row the reader took as the first prompt; null when not read. */
  firstRow: { shape: StoredShape; rawLength: number; windowWord: boolean } | null
  /** `stall-detect`'s calls in its 5-minute window over the tail; null = unknown. */
  toolCalls5m: number | null
}

export interface RowCompareInput {
  push: RowPushView
  baseline: RowBaseline | null
  legacy: RowLegacyView | null
  /** The binding's profile is `headless` (`claude -p`). */
  headless: boolean
  /** `turn.completed.reason`. */
  turnReason: string
}

/** One ledger record's detail: exactly the five keys of spec §7.3, none of them `DENIED_KEY`. */
export interface RowGroupRecord {
  group: RowGroup
  verdict: RowVerdict
  /** `none` unless the verdict is `diverge`; then a class or `unexplained`, `field:` for prompts. */
  cls: string
  /** Text lengths for the text groups, the two counts for `count` and `tools`, Δ ms for `activity`. */
  lenPush: number | null
  lenLegacy: number | null
}

export const GROUP_ORDER: readonly RowGroup[] = [
  'prompt',
  'count',
  'activity',
  'assistant',
  'title',
  'tools'
]

/**
 * The renderer's normalizer (meta wrappers stripped, whitespace collapsed, 120 chars), then the
 * trailing space its cut can leave: the reader's stored value went through it once already, and a
 * second pass trims that space, so without the `trimEnd` the same text compares unequal.
 */
export const normalizeRowText = (s: string): string => firstRealPrompt([s]).trimEnd()

const PLACEHOLDER = '[REDACTED:'

/** The push redacted a secret the legacy shows: everything before the placeholder agrees. */
function redacted(push: string, legacy: string): boolean {
  const at = push.indexOf(PLACEHOLDER)
  return at >= 0 && legacy.length >= at && push.slice(0, at) === legacy.slice(0, at)
}

const shapeClass = (shape: StoredShape): RowClass | null => {
  switch (shape) {
    case 'teammate':
      return 'E-TEAMMATE'
    case 'scheduled':
      return 'E-SCHEDULED'
    case 'peer':
    case 'task-notification':
      return 'E-ORIGIN'
    case 'plugin-bridge':
      return 'E-PLUGIN-BRIDGE'
    default:
      return null
  }
}

export function compareRowGroups(
  x: RowCompareInput,
  classes: ReadonlySet<RowClass> = ALL_CLASSES
): RowGroupRecord[] {
  /** The first candidate class that applies and is named; else `unexplained`. */
  const pick = (...cands: (RowClass | null | false)[]): string => {
    for (const c of cands) if (c && classes.has(c)) return c
    return 'unexplained'
  }
  const L = x.legacy
  const P = x.push
  const record = (
    group: RowGroup,
    verdict: RowVerdict,
    cls = 'none',
    lenPush: number | null = null,
    lenLegacy: number | null = null
  ): RowGroupRecord => ({ group, verdict, cls, lenPush, lenLegacy })

  if (L === null) return GROUP_ORDER.map((g) => record(g, 'no-legacy'))
  // M1 (widened after W1 round 3): the push has folded a row the file does not hold yet, or its
  // uuid sits behind the file's last row. Either way this sample is skipped, never a divergence.
  if (P.lastUuid !== null && (L.uuidFound === false || L.rowsAfter > 0)) {
    return GROUP_ORDER.map((g) => record(g, 'unaligned'))
  }
  const headCapped = L.size >= HEAD_CAP_BYTES

  // ---- prompt -------------------------------------------------------------------------------
  const parts: string[] = []
  let lens: [number, number] | null = null
  let compared = false
  if (P.lastPrompt !== undefined) {
    compared = true
    const push = normalizeRowText(P.lastPrompt ?? x.baseline?.lastPrompt ?? '')
    const legacy = normalizeRowText(L.lastPrompt)
    lens = [push.length, legacy.length]
    if (push !== legacy) {
      const key = legacy.slice(0, NAME_PREFIX)
      const row =
        key === ''
          ? undefined
          : [...L.recentPrompts].reverse().find((r) => normalizeRowText(r.text).startsWith(key))
      parts.push(
        `last:${pick(
          x.headless && (P.lastPrompt === null || P.lastPrompt === '') && 'E-HEADLESS',
          redacted(push, legacy) && 'E-REDACT',
          row ? shapeClass(row.shape) : null
        )}`
      )
    }
  }
  const baseFirst = x.baseline && x.baseline.firstPrompt !== '' ? x.baseline.firstPrompt : null
  if (baseFirst !== null || P.firstPrompt !== undefined) {
    compared = true
    const push = normalizeRowText(baseFirst ?? P.firstPrompt ?? '')
    const legacy = normalizeRowText(L.firstPrompt)
    if (push !== legacy) {
      if (parts.length === 0) lens = [push.length, legacy.length]
      const fr = L.firstRow
      const pushNull = baseFirst === null && P.firstPrompt === null
      parts.push(
        `first:${pick(
          legacy === '' && headCapped && 'E-HEAD',
          redacted(push, legacy) && 'E-REDACT',
          fr ? shapeClass(fr.shape) : null,
          fr !== null && pushNull && fr.rawLength > RAW_MAX && 'E-RAWCAP',
          fr !== null && pushNull && !fr.windowWord && 'E-RAWCAP-WINDOW'
        )}`
      )
    }
  }
  const prompt = !compared
    ? record('prompt', 'unknown')
    : parts.length > 0
      ? record('prompt', 'diverge', parts.join('+'), lens?.[0] ?? null, lens?.[1] ?? null)
      : record('prompt', 'match', 'none', lens?.[0] ?? null, lens?.[1] ?? null)

  // ---- count --------------------------------------------------------------------------------
  const composed = (x.baseline?.userMessageCount ?? 0) + P.userRows
  const count =
    composed === L.userMessageCount
      ? record('count', 'match', 'none', composed, L.userMessageCount)
      : record('count', 'diverge', pick(headCapped && 'E-HEAD'), composed, L.userMessageCount)

  // ---- activity -----------------------------------------------------------------------------
  let activity: RowGroupRecord
  if (P.lastRowAt === null) activity = record('activity', 'unknown')
  else {
    const delta = Math.round(P.lastRowAt - L.mtimeMs)
    activity =
      Math.abs(delta) <= ACTIVITY_MATCH_MS
        ? record('activity', 'match', 'none', delta, null)
        : record('activity', 'diverge', 'unexplained', delta, null)
  }

  // ---- assistant ----------------------------------------------------------------------------
  let assistant: RowGroupRecord
  if (P.lastAssistant === undefined) assistant = record('assistant', 'unknown')
  else {
    const push = normalizeRowText(P.lastAssistant ?? '')
    const legacy = normalizeRowText(L.lastAssistant ?? '')
    assistant =
      push === legacy
        ? record('assistant', 'match', 'none', push.length, legacy.length)
        : record(
            'assistant',
            'diverge',
            pick(x.turnReason !== 'answer' && 'E-STOPLESS', redacted(push, legacy) && 'E-REDACT'),
            push.length,
            legacy.length
          )
  }

  // ---- title (legacy-owned, M2: the custom title alone) -------------------------------------
  let title: RowGroupRecord
  if (P.title === undefined) title = record('title', 'unknown')
  else {
    const push = normalizeRowText(P.title ?? '')
    const legacy = normalizeRowText(L.customTitle)
    title =
      push === legacy
        ? record('title', 'match', 'none', push.length, legacy.length)
        : record(
            'title',
            'diverge',
            pick(redacted(push, legacy) && 'E-REDACT'),
            push.length,
            legacy.length
          )
  }

  // ---- tools (legacy-owned) -----------------------------------------------------------------
  let tools: RowGroupRecord
  if (P.toolCalls5m === null || L.toolCalls5m === null) tools = record('tools', 'unknown')
  else if (P.toolCalls5m === L.toolCalls5m) {
    tools = record('tools', 'match', 'none', P.toolCalls5m, L.toolCalls5m)
  } else {
    tools = record(
      'tools',
      'diverge',
      pick(
        L.toolCalls5m < P.toolCalls5m && L.size > TAIL_WINDOW_BYTES && 'E-TAIL',
        P.subagentToolCalls5m > 0 && 'E-SUBAGENT'
      ),
      P.toolCalls5m,
      L.toolCalls5m
    )
  }

  return [prompt, count, activity, assistant, title, tools]
}

/** Whether `text`, whitespace collapsed, has a word boundary inside the redaction window. */
export function hasWindowWord(text: string): boolean {
  const one = text.replace(/\s+/g, ' ').trim()
  if (one.length <= REDACT_WINDOW) return true
  for (let i = REDACT_WINDOW; i > 0; i--) if (one.charCodeAt(i) === 0x20) return true
  return false
}
