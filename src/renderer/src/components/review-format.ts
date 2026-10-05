/**
 * T164 U3 — Review pane: the renderer's pure layer.
 *
 * Everything `ReviewPane.vue` needs to turn U2's structured snapshot into
 * something a human reads, expressed as pure functions with no Vue, no IPC and
 * no i18n lookups of its own. The split mirrors `PrStackCanvas.vue` ↔
 * `pr-stack-format.ts`.
 *
 * Three jobs live here:
 *
 *  1. **Receipts + flags.** `review-core.ts` deliberately emits FACTS
 *     (`{ kind: 'no-commits', data: { branch } }`) and never a sentence — its
 *     own header says so. This module turns a fact into an i18n KEY plus its
 *     params; the wording lives in `en.json`/`pt-BR.json`, and the rendering in
 *     the component. Rule R2 is enforced structurally: there is no code path
 *     here that can emit an "all clear" descriptor, and every status dot is
 *     built as a `{ dot, word }` pair so a dot can never appear alone.
 *  2. **Diff render plan.** Which files open expanded, where the unchanged
 *     gaps between hunks are, and how many rows are worth highlighting.
 *  3. **Row segmentation.** lowlight's hast tree (ADR-0011) composed with U2's
 *     word-level `spans`, flattened into the nested `mark → parts` shape the
 *     approved spec's markup uses.
 *
 * Visual contract: `docs/specs/2026-08-25-t164-review-pane/spec.html`.
 */

import { createLowlight } from 'lowlight'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import { shortAgo } from './pr-stack-format'
import type {
  ContractFlag,
  DiffFile,
  DiffHunk,
  DiffSpan,
  Discrepancy,
  DiscrepancySeverity,
  ReviewEvidence,
  SessionEndState
} from '../../../main/review-core'

// ═══════════════════════════════════════════════════════════════════════════
// 1. Paths
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Split a path into its directory prefix (rendered `--text-4`) and its basename
 * (rendered `--text`), the two-tone treatment the spec's `.file-path` uses. The
 * prefix keeps its trailing slash so the two halves concatenate back verbatim.
 */
export function splitPath(path: string): { dir: string; base: string } {
  const cut = path.lastIndexOf('/')
  if (cut < 0) return { dir: '', base: path }
  return { dir: path.slice(0, cut + 1), base: path.slice(cut + 1) }
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. Receipts — the ledger row
// ═══════════════════════════════════════════════════════════════════════════

/** Which hue a 6px status dot carries. Never rendered without {@link Receipt.word}. */
export type DotTone = 'ok' | 'warn' | 'bad' | 'idle'

/**
 * One label/value pair in the receipts strip.
 *
 * `word` is what makes the dot legible without colour (design.md §2): a
 * `Receipt` that carries a `dot` ALWAYS carries a `word`, which is why they are
 * one optional pair rather than two independent fields.
 */
export interface Receipt {
  /** i18n key suffix under `review.receipt.*` — the LABEL, not the value. */
  key: string
  /** Literal value, when the value is a number or an already-formatted string. */
  value?: string
  /** i18n key suffix under `review.value.*`, when the value is a word. */
  valueKey?: string
  /** `--text-3` instead of `--text`: nothing to report is still evidence. */
  dim?: boolean
  /** `--red` on the value — the spec's `.num-del` on a zero-commits branch. */
  alarm?: boolean
  /** Rendered as `+n −m` in `--green`/`--red` instead of a plain value. */
  lines?: { added: number; deleted: number }
  /** Status dot; only ever set together with a `valueKey`. */
  dot?: DotTone
}

/** The word + dot a session end state renders as. */
const SESSION_DOTS: Record<SessionEndState, DotTone> = {
  // `done` is deliberately NOT green. A green "ended done" is exactly the
  // completion-looking badge rule R2 exists to forbid — the session asserting
  // done is the claim under review, not a result.
  done: 'idle',
  running: 'ok',
  hibernated: 'idle',
  killed: 'bad',
  'stand-down': 'warn'
}

const CI_DOTS: Record<string, DotTone> = {
  passing: 'ok',
  pending: 'warn',
  failing: 'bad',
  unknown: 'idle'
}

/**
 * The freshness pair: is the copy being read still the PR's head?
 *
 * A BOOLEAN, not an age (T246). "The head commit is 3 days old" describes the
 * code rather than the operator's copy, and a three-day-old head can be
 * perfectly current — an age there would make someone worry for nothing. The
 * age survives only as the fallback when there is no `headRefOid` to compare
 * against, where saying it plainly is exactly right because a boolean is not
 * available and pretending otherwise would be the all-clear mistake again.
 *
 * `current` carries NO dot and no hue. R2 holds here as everywhere: this is a
 * statement about one ref, and the moment it renders as a green mark it starts
 * reading as a verdict on the review.
 */
function headReceipts(head: ReviewEvidence['head'], now: number): Receipt[] {
  if (head.freshness !== 'unknown') {
    return [{ key: 'head', valueKey: `head.${head.freshness}` }]
  }
  // A local branch with no PR to compare against says nothing at all — the
  // pre-T246 strip, unchanged.
  if (head.kind !== 'pr') return []
  if (head.fetchedAt !== null) {
    return [{ key: 'fetched', value: shortAgo(new Date(head.fetchedAt).toISOString(), now) }]
  }
  return [{ key: 'head', valueKey: 'head.unknown', dim: true }]
}

/**
 * The receipts strip for one evidence set, in the spec's order.
 *
 * The three variants in the approved spec (`evidence-header`,
 * `evidence-header--git-only`, `evidence-header--no-commits`) are not three
 * layouts — they are this one list with different pairs present. A pair with
 * nothing to report is dimmed, never dropped, EXCEPT where the spec drops it
 * outright (`lines` on a branch that changed nothing; the PR pairs on a repo
 * with no remote, which the `remote` pair replaces).
 */
export function receiptsFor(
  evidence: ReviewEvidence,
  hasCard: boolean,
  now = Date.now()
): Receipt[] {
  const out: Receipt[] = []
  const head = evidence.head
  const readable = head.state === 'ready'

  // T246 — an unreadable head reports `—`, never `0`.
  //
  // `commitsAhead` is `0` both for a branch with nothing on it and for a ref
  // this machine has never fetched, and the red `0` is the loudest thing in
  // the strip. Rendering it for an unfetched PR would tell an operator, in the
  // pane's strongest voice, that someone else's work is empty.
  if (!readable) {
    out.push({ key: 'commits', valueKey: 'unknown', dim: true })
    out.push({ key: 'files', valueKey: 'unknown', dim: true })
  } else {
    out.push({
      key: 'commits',
      value: String(evidence.commitsAhead),
      // A zero here is the headline discrepancy, so it is the one count that
      // takes the removal hue instead of dimming into the background.
      alarm: evidence.commitsAhead === 0
    })
    out.push({
      key: 'files',
      value: String(evidence.filesChanged),
      dim: evidence.filesChanged === 0
    })
    if (evidence.added > 0 || evidence.deleted > 0) {
      out.push({ key: 'lines', lines: { added: evidence.added, deleted: evidence.deleted } })
    }
  }

  // The worktree pair is about the folder the review runs IN. On a foreign PR
  // that folder is the repo's main checkout and its uncommitted files are the
  // operator's own — saying `clean` or counting them there would be a claim
  // about the wrong tree, so the pair is dropped rather than dimmed.
  if (head.kind === 'local') {
    if (evidence.dirtyCount > 0) {
      out.push({ key: 'uncommitted', value: String(evidence.dirtyCount), dim: true })
    } else {
      out.push({ key: 'worktree', valueKey: 'clean', dim: true })
    }
  }

  out.push(...headReceipts(head, now))

  if (evidence.session) {
    out.push({
      key: 'session',
      valueKey: `session.${evidence.session}`,
      dot: SESSION_DOTS[evidence.session]
    })
  }

  if (evidence.pr.applicable) {
    const pr = evidence.pr.pr
    if (pr) {
      out.push({ key: 'ci', valueKey: `ci.${pr.ci}`, dot: CI_DOTS[pr.ci] ?? 'idle' })
      out.push({ key: 'pr', value: `#${pr.number} ${pr.state.toLowerCase()}` })
      if (pr.reviewDecision) {
        out.push({ key: 'prReview', value: pr.reviewDecision.toLowerCase().replace(/_/g, ' ') })
      } else {
        out.push({ key: 'prReview', valueKey: 'none', dim: true })
      }
    } else {
      out.push({ key: 'pr', valueKey: 'none', dim: true })
    }
  } else {
    out.push({
      key: 'remote',
      valueKey: evidence.pr.reason === 'no-remote' ? 'localOnly' : 'ghUnavailable',
      dim: true
    })
  }

  if (!hasCard) out.push({ key: 'intent', valueKey: 'noCardBound', dim: true })

  return out
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. Discrepancy strip
// ═══════════════════════════════════════════════════════════════════════════

/**
 * One rendered line in the discrepancy strip: a severity glyph plus a sentence
 * assembled from an i18n key. `code` is the path/branch that renders in the
 * inline `code` chip — kept out of `params` so the component can place it in
 * its own element instead of interpolating markup into a string.
 */
export interface FlagLine {
  severity: DiscrepancySeverity
  /** i18n key suffix under `review.flag.*`. */
  key: string
  params: Record<string, string | number>
}

export const SEVERITY_GLYPH: Record<DiscrepancySeverity, string> = {
  bad: '✕',
  warn: '!',
  info: '·'
}

/** How many sensitive paths get their own line before the rest are summarised. */
const SENSITIVE_LINE_CAP = 3

/**
 * The discrepancy strip for one evidence set.
 *
 * Two things this does beyond a 1:1 map, both taken from the approved spec:
 *
 *  - **`sensitive-paths` fans out.** U2 emits ONE discrepancy carrying every
 *    flagged path; the spec renders one line per path ("touches `x` — sensitive
 *    path, read it in full"). Past {@link SENSITIVE_LINE_CAP} the tail collapses
 *    into a count so a diff touching forty sensitive files does not push the
 *    diff itself off the screen.
 *  - **`contract-unmet` folds into the contract ledger line** built by
 *    {@link contractLineParts}, instead of producing its own row. The approved
 *    spec renders contract state as exactly one line naming every contract
 *    ("`CHANGELOG.md` touched · `docs/user/` not touched · i18n not
 *    applicable"), and an unmet contract stays fully named there — this drops a
 *    duplicate row, never a fact.
 *
 * Some sentences change with context rather than with the fact: "no commits" on
 * a branch whose session claims done is a different sentence from the same fact
 * with no session bound, and both are in the spec. That choice is made here
 * because it is a wording decision, which is exactly what U2 refused to make.
 */
export function flagLinesFor(evidence: ReviewEvidence): FlagLine[] {
  const out: FlagLine[] = []
  for (const d of evidence.discrepancies) {
    out.push(...linesForDiscrepancy(d, evidence))
  }
  return out
}

function linesForDiscrepancy(d: Discrepancy, evidence: ReviewEvidence): FlagLine[] {
  switch (d.kind) {
    case 'no-commits':
      return [
        {
          severity: d.severity,
          key: evidence.session === 'done' ? 'noCommitsSessionDone' : 'noCommits',
          params: { branch: d.data.branch ?? evidence.branch }
        }
      ]
    case 'dirty-tree':
      return [
        {
          severity: d.severity,
          // With nothing committed, uncommitted files are the likeliest place
          // the work actually is — a different sentence from "the diff below
          // does not include them" (both are in the approved spec).
          key: evidence.commitsAhead === 0 ? 'dirtyMaybeUnsaved' : 'dirtyNotInDiff',
          params: { n: d.data.count ?? 0 }
        }
      ]
    case 'behind-base':
      return [
        {
          severity: d.severity,
          key: 'behindBase',
          params: { n: d.data.count ?? 0, base: d.data.base ?? evidence.base }
        }
      ]
    case 'sensitive-paths': {
      const paths = d.data.paths ?? []
      const lines: FlagLine[] = paths
        .slice(0, SENSITIVE_LINE_CAP)
        .map((p) => ({ severity: d.severity, key: 'sensitivePath', params: { path: p } }))
      if (paths.length > SENSITIVE_LINE_CAP) {
        lines.push({
          severity: d.severity,
          key: 'sensitiveMore',
          params: { n: paths.length - SENSITIVE_LINE_CAP }
        })
      }
      return lines
    }
    // Folded into the contract ledger line — see the doc comment above.
    case 'contract-unmet':
      return []
    case 'ci-failing':
      return [{ severity: d.severity, key: 'ciFailing', params: { pr: d.data.pr ?? 0 } }]
    case 'ci-pending':
      return [{ severity: d.severity, key: 'ciPending', params: { pr: d.data.pr ?? 0 } }]
    case 'pr-draft':
      return [{ severity: d.severity, key: 'prDraft', params: { pr: d.data.pr ?? 0 } }]
    case 'pr-merged':
      return [{ severity: d.severity, key: 'prMerged', params: { pr: d.data.pr ?? 0 } }]
    // T246 — every one of these is a reason there is no diff, or a reason the
    // diff below may not be the current one. None of them may share a sentence
    // with `no-commits`: "nothing was read" and "nothing is there" are the two
    // readings this card exists to keep apart.
    case 'head-not-fetched':
      return [{ severity: d.severity, key: 'headNotFetched', params: {} }]
    case 'head-fetch-failed':
      return [{ severity: d.severity, key: 'headFetchFailed', params: {} }]
    case 'base-unresolved':
      return [
        {
          severity: d.severity,
          key: 'baseUnresolved',
          params: { base: d.data.base ?? evidence.base }
        }
      ]
    case 'head-moved':
      return [{ severity: d.severity, key: 'headMoved', params: { pr: d.data.pr ?? 0 } }]
    case 'head-local-differs':
      return [{ severity: d.severity, key: 'headLocalDiffers', params: { pr: d.data.pr ?? 0 } }]
    case 'refresh-failed':
      return [{ severity: d.severity, key: 'refreshFailed', params: {} }]
    case 'no-pr':
      return [{ severity: d.severity, key: 'noPr', params: {} }]
    case 'no-remote':
      return [{ severity: d.severity, key: 'noRemote', params: {} }]
    case 'gh-unavailable':
      return [{ severity: d.severity, key: 'ghUnavailable', params: {} }]
    default:
      return []
  }
}

/**
 * One fragment of the contract ledger line: the contract's file/dir (rendered in
 * a `code` chip) and the state word beside it.
 */
export interface ContractPart {
  id: ContractFlag['id']
  /** The path the chip shows; empty for the i18n-parity pair, which has two. */
  code: string
  /** i18n key suffix under `review.contract.*`. */
  stateKey: 'touched' | 'notTouched' | 'notApplicable'
}

const CONTRACT_CODE: Record<ContractFlag['id'], string> = {
  changelog: 'CHANGELOG.md',
  awareness: 'docs/harnu-features.md',
  userDocs: 'docs/user/',
  i18n: 'i18n'
}

/**
 * The contract ledger line, in the spec's order and phrasing. `required: false`
 * is "not applicable" and NEVER a pass mark — `review-core.ts` is explicit that
 * the distinction is what keeps this line from reading as a completion badge.
 */
export function contractLineParts(contracts: readonly ContractFlag[]): ContractPart[] {
  // Nothing triggered any contract — a line reading "not applicable" four times
  // carries no information, and R2 is satisfied by absence rather than by a row
  // announcing that there is nothing to say.
  if (!contracts.some((c) => c.required)) return []
  const order: ContractFlag['id'][] = ['changelog', 'awareness', 'userDocs', 'i18n']
  const byId = new Map(contracts.map((c) => [c.id, c]))
  const out: ContractPart[] = []
  for (const id of order) {
    const c = byId.get(id)
    if (!c) continue
    out.push({
      id,
      code: CONTRACT_CODE[id],
      stateKey: !c.required ? 'notApplicable' : c.satisfied ? 'touched' : 'notTouched'
    })
  }
  return out
}

/**
 * Severity of the contract ledger line. It stays `info` even with an unmet
 * contract, matching the approved spec, which renders exactly that combination
 * on a `flag--info` row — the sentence names the gap, the glyph does not have
 * to shout it a second time.
 */
export const CONTRACT_LINE_SEVERITY: DiscrepancySeverity = 'info'

// ═══════════════════════════════════════════════════════════════════════════
// 4. Session end state
// ═══════════════════════════════════════════════════════════════════════════

/** The subset of the session shape this module reads. Structural, not imported. */
export interface SessionEndStateInput {
  taskState?: 'working' | 'needs-input' | 'idle' | 'completed' | 'failed' | 'stopped'
  hibernated?: boolean
}

/**
 * Map Harnu's live task-state vocabulary onto U2's `SessionEndState`.
 *
 * t125 (the completion sensor) is NOT built — PRD D3 decoupled this pane from
 * it on purpose — so this is the best evidence that actually exists today, and
 * it is deliberately conservative: `idle` yields `null` rather than `done`,
 * because "the session stopped writing" is not the session reporting done, and
 * inventing a `done` here would put an assertion in the receipts that nothing
 * on disk supports.
 */
export function sessionEndStateOf(session: SessionEndStateInput | null): SessionEndState | null {
  if (!session) return null
  if (session.hibernated) return 'hibernated'
  switch (session.taskState) {
    case 'completed':
      return 'done'
    case 'failed':
      return 'killed'
    case 'stopped':
      return 'stand-down'
    case 'working':
    case 'needs-input':
      return 'running'
    default:
      return null
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. Diff render plan
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Rows rendered expanded before the remaining files start collapsed. PRD §6
 * asks for per-file collapse above a threshold; this is that threshold, and it
 * is what keeps a 5,000-line diff from building 5,000 rows of DOM on open
 * (AC-11). Sensitive files are exempt — R3 says a flagged file renders
 * expanded, and a budget is not allowed to overrule an accountability rule.
 */
export const AUTO_EXPAND_ROW_BUDGET = 900

/**
 * Rows past which syntax highlighting stops and rows render as plain text.
 * Word-level marks keep working past this point: §4.3 ranks them above syntax
 * colour, and they cost a string slice rather than a tokenise.
 */
export const HIGHLIGHT_ROW_BUDGET = 2500

/**
 * Which files open expanded, keyed by path.
 *
 * `viewed` (T243) collapses a file the operator has already read — the whole
 * ergonomic point of the mark, and the reason a nine-file diff stops swallowing
 * the place you left off. It never applies to a sensitive file: R3 says a
 * blast-radius file renders expanded, and having-been-read does not outrank
 * sensitivity any more than a row budget does.
 */
export function autoExpanded(
  files: readonly DiffFile[],
  sensitive: ReadonlySet<string>,
  budget = AUTO_EXPAND_ROW_BUDGET,
  viewed: ReadonlySet<string> = new Set()
): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  let spent = 0
  for (const f of files) {
    const rows = f.hunks.reduce((n, h) => n + h.rows.length, 0)
    if (sensitive.has(f.path)) {
      out[f.path] = true
      spent += rows
      continue
    }
    if (f.binary) {
      out[f.path] = false
      continue
    }
    if (viewed.has(f.path)) {
      out[f.path] = false
      continue
    }
    // The first file still to be READ always opens: a diff whose every file is
    // collapsed reads as an empty pane, which is the one thing PRD AC2 forbids.
    // A diff whose files are all collapsed because they were all read is a
    // different fact, and every header still states it.
    const first = !Object.values(out).some((open) => open)
    if (first || spent + rows <= budget) {
      out[f.path] = true
      spent += rows
    } else {
      out[f.path] = false
    }
  }
  return out
}

/**
 * The number of unchanged lines git skipped before a hunk, or `0` when there is
 * no gap to report.
 *
 * Only LEADING and BETWEEN gaps are knowable: a trailing gap would need the
 * file's line count, which a unified diff never carries.
 */
export function gapBefore(hunks: readonly DiffHunk[], index: number): number {
  const hunk = hunks[index]
  if (!hunk) return 0
  if (index === 0) return Math.max(0, hunk.oldStart - 1)
  const prev = hunks[index - 1]
  return Math.max(0, hunk.oldStart - (prev.oldStart + prev.oldLines))
}

/** `@@ -a,b +c,d @@ heading` exactly as git prints it, for the hunk label. */
export function hunkLabel(hunk: DiffHunk): string {
  const head = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`
  return hunk.heading ? `${head} ${hunk.heading}` : head
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. Syntax highlighting (ADR-0011)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Grammars registered EXPLICITLY — never the auto-registering bundle, which
 * pulls ~2.7 MB of languages into the renderer (ADR-0011 §2).
 */
const lowlight = createLowlight({ bash, css, javascript, json, markdown, typescript, xml })

const EXT_GRAMMAR: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  // ADR-0011 §3: highlight.js has no Vue grammar. `xml` sub-highlights <style>
  // as CSS and <script> as JavaScript, so a `lang="ts"` block loses its type
  // syntax and nothing else. Less colour, never wrong colour.
  vue: 'xml',
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  svg: 'xml',
  css: 'css',
  scss: 'css',
  json: 'json',
  jsonc: 'json',
  md: 'markdown',
  markdown: 'markdown',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash'
}

/** The grammar for a path, or `null` when nothing is registered for it. */
export function grammarFor(path: string): string | null {
  const base = splitPath(path).base
  const dot = base.lastIndexOf('.')
  if (dot < 0) return null
  return EXT_GRAMMAR[base.slice(dot + 1).toLowerCase()] ?? null
}

/** One coloured run inside a row. `cls` is empty for unhighlighted text. */
export interface RowPart {
  text: string
  cls: string
}

/**
 * A run of parts sharing one word-level mark. The nesting is deliberate: the
 * approved spec wraps the syntax spans INSIDE a single `w-add`/`w-del` element,
 * so one contiguous edit gets one rounded background rather than one per token.
 */
export interface RowSegment {
  mark: 'add' | 'del' | null
  parts: RowPart[]
}

/** A hast-ish node, structurally typed so this module never imports @types/hast. */
interface HastNode {
  type: string
  value?: string
  tagName?: string
  properties?: { className?: unknown }
  children?: HastNode[]
}

/** Flatten lowlight's tree into `{ text, cls }` runs, in document order. */
function flattenHast(nodes: readonly HastNode[], inherited: string, out: RowPart[]): void {
  for (const node of nodes) {
    if (node.type === 'text') {
      if (node.value) out.push({ text: node.value, cls: inherited })
      continue
    }
    const raw = node.properties?.className
    const own = Array.isArray(raw) ? raw.filter((c): c is string => typeof c === 'string') : []
    // Deepest scope wins: `hljs-title hljs-function` and its parent's class map
    // onto the same seven buckets, and stacking them would let two buckets
    // fight for one run's colour.
    const cls = own.length > 0 ? own.join(' ') : inherited
    if (node.children) flattenHast(node.children, cls, out)
  }
}

/** Tokenise one line, degrading to a single unhighlighted run on any failure. */
function highlightParts(text: string, grammar: string | null): RowPart[] {
  // An empty row (a blank line in the diff) has nothing to colour and nothing
  // to render — returning a zero-length part would put an empty span in the DOM
  // once per blank line, which on a big diff is thousands of dead nodes.
  if (text.length === 0) return []
  if (!grammar) return [{ text, cls: '' }]
  try {
    const tree = lowlight.highlight(grammar, text) as unknown as HastNode
    const out: RowPart[] = []
    flattenHast(tree.children ?? [], '', out)
    // A grammar that matched nothing still has to render the line.
    if (out.length === 0) return [{ text, cls: '' }]
    return out
  } catch {
    return [{ text, cls: '' }]
  }
}

/** Is character index `i` inside any of `spans`? */
function markAt(spans: readonly DiffSpan[] | undefined, i: number): boolean {
  if (!spans) return false
  for (const s of spans) if (i >= s.start && i < s.end) return true
  return false
}

/**
 * One diff row → the nested `mark → parts` structure the template renders.
 *
 * Splits the highlighted runs at every word-mark boundary, then regroups
 * consecutive runs that share a mark, so the mark's rounded background spans the
 * whole edit and the syntax colours survive underneath it.
 */
export function rowSegments(
  text: string,
  spans: readonly DiffSpan[] | undefined,
  mark: 'add' | 'del' | null,
  grammar: string | null
): RowSegment[] {
  const parts = highlightParts(text, grammar)
  if (!mark || !spans || spans.length === 0) {
    return parts.length > 0 ? [{ mark: null, parts }] : []
  }

  const segments: RowSegment[] = []
  let cursor = 0
  for (const part of parts) {
    let runStart = 0
    let runMarked = markAt(spans, cursor)
    for (let i = 1; i <= part.text.length; i++) {
      const marked = i < part.text.length ? markAt(spans, cursor + i) : !runMarked
      if (marked === runMarked && i < part.text.length) continue
      const slice = part.text.slice(runStart, i)
      if (slice.length > 0) {
        const wanted = runMarked ? mark : null
        const tail = segments.at(-1)
        if (tail && tail.mark === wanted) tail.parts.push({ text: slice, cls: part.cls })
        else segments.push({ mark: wanted, parts: [{ text: slice, cls: part.cls }] })
      }
      runStart = i
      runMarked = marked
    }
    cursor += part.text.length
  }
  return segments
}
