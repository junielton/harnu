/**
 * Pure transcript scan for the automatic session digest (memory U1, S-1;
 * `docs/specs/2026-11-04-memory-u1-capture/spec.md`, "Definitions the slices share").
 *
 * Folds Claude Code JSONL transcript lines into a bounded {@link TranscriptFacts}: the user-turn
 * count, the first and last timestamps, the windows of git-mutating tool calls, the
 * asked-and-answered pairs of `AskUserQuestion`, and the last assistant message with its open
 * questions. The fold is incremental — `scanTranscriptLines(B, scanTranscriptLines(A))`
 * deep-equals `scanTranscriptLines(A + B)` — so a reader can resume from a stored offset.
 *
 * No I/O and no clock (ADR-0001): the reader in `digest-io.ts` (S-2) feeds the lines, and
 * `gitWindows` takes `now` as an argument. Extraction is structural and model-free (D-2): nothing
 * here looks for keywords, so it works the same in any language.
 */

export interface TranscriptFacts {
  userTurns: number
  /** First parsed line with a timestamp, normalised ISO. */
  firstAt: string | null
  /** Last parsed line with a timestamp, normalised ISO. */
  lastAt: string | null
  /** Closed git-call windows, widened, in result-line order. */
  gitCalls: { startMs: number; endMs: number }[]
  /** Asked-and-answered pairs, the last {@link MAX_PAIRS}. */
  asked: { question: string; answer: string }[]
  /** Open questions of the current last assistant message. */
  openQuestions: string[]
  /** Its text, cut to {@link LAST_TEXT_MAX}. */
  lastAssistantText: string
  lastAssistantId: string | null
  /** The last {@link TAIL_MAX} code points of its uncut text. */
  lastAssistantTail: string
  /** Git and ask calls with no result yet. */
  pending: { id: string; kind: 'git' | 'ask'; startMs: number | null }[]
}

// ---- Limits and patterns (pinned by tests/digest-transcript.test.ts) --------

/** Cut for a question, an answer and an open question (code points). */
export const ITEM_MAX = 300
/** Cut for the last assistant message (code points; the head is kept). */
export const LAST_TEXT_MAX = 1_500
/** How much of the last message's end the open questions are read from (code points). */
export const TAIL_MAX = 65_536
/** Asked-and-answered pairs kept (the latest). */
export const MAX_PAIRS = 10
/** Open questions kept (the latest). */
export const MAX_OPEN_QUESTIONS = 5
/** A git call's window opens this long before the call line. */
export const GIT_WINDOW_BEFORE_MS = 2_000
/** And closes this long after its result line. */
export const GIT_WINDOW_AFTER_MS = 5_000

const GIT_MUTATING = /\bgit\b[^\n]*\b(commit|merge|rebase|cherry-pick|revert|am|pull)\b/
const INLINE_CODE = /`+[^`]*`+/g
/**
 * The spec's question pattern. {@link questionMatches} computes the same matches in linear time
 * (the regex backtracks quadratically on a long run with no terminator); a test pins the two equal.
 */
export const QUESTION = /[^.!?\n]*\?(?=\s|$)/g
const NOT_A_TURN = ['<local-command-', '<command-', '[Request interrupted']
const FENCE = /^\s*(```|~~~)/

// ---- Small helpers -----------------------------------------------------------

type Obj = Record<string, unknown>

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The spec's Cut: by code points, a text longer than `n` keeps `n − 1` of them plus `…`. */
export function cutText(text: string, n: number): string {
  const chars = Array.from(text)
  return chars.length > n ? chars.slice(0, n - 1).join('') + '…' : text
}

/** The last `n` code points of `text`. */
function tailOf(text: string, n: number): string {
  const chars = Array.from(text)
  return chars.length > n ? chars.slice(chars.length - n).join('') : text
}

function timestampMs(entry: Obj): number | null {
  if (typeof entry.timestamp !== 'string') return null
  const ms = Date.parse(entry.timestamp)
  return Number.isFinite(ms) ? ms : null
}

function contentBlocks(entry: Obj): Obj[] {
  const message = entry.message
  if (!isObj(message) || !Array.isArray(message.content)) return []
  return message.content.filter(isObj)
}

/** The operator text of a user line, or null when it has none. */
function operatorText(entry: Obj): string | null {
  const message = entry.message
  if (!isObj(message)) return null
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  const blocks = content.filter(isObj)
  if (blocks.some((b) => b.type === 'tool_result')) return null
  return blocks
    .filter((b) => b.type === 'text')
    .map((b) => (typeof b.text === 'string' ? b.text : ''))
    .join('\n')
}

/**
 * Every match of {@link QUESTION} in `text`, in order, in one pass. A match can neither contain
 * nor cross `.`, `!`, `?` or a newline, so it is the run since the last such terminator plus a
 * `?` that is followed by whitespace or the end.
 */
export function questionMatches(text: string): string[] {
  const out: string[] = []
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c !== '.' && c !== '!' && c !== '?' && c !== '\n') continue
    if (c === '?' && (i + 1 === text.length || /\s/.test(text[i + 1]))) {
      out.push(text.slice(start, i + 1))
    }
    start = i + 1
  }
  return out
}

/** The open questions of a message tail: fences out, inline code blanked, `?` sentences kept. */
function openQuestionsOf(tail: string): string[] {
  const kept: string[] = []
  let inFence = false
  for (const line of tail.split('\n')) {
    if (FENCE.test(line)) {
      inFence = !inFence
      continue
    }
    if (!inFence) kept.push(line)
  }
  const text = kept.join('\n').replace(INLINE_CODE, ' ')
  const found: string[] = []
  for (const match of questionMatches(text)) {
    const q = match.trim()
    if (!q || q === '?' || q.includes('://')) continue
    found.push(cutText(q, ITEM_MAX))
  }
  // Drop exact duplicates, keeping the later one.
  const unique = found.filter((q, i) => found.indexOf(q, i + 1) < 0)
  return unique.slice(-MAX_OPEN_QUESTIONS)
}

function answerText(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (Array.isArray(value)) return value.map((v) => String(v)).join(', ')
  return typeof value === 'string' ? value : String(value)
}

// ---- The scan ----------------------------------------------------------------

export function emptyFacts(): TranscriptFacts {
  return {
    userTurns: 0,
    firstAt: null,
    lastAt: null,
    gitCalls: [],
    asked: [],
    openQuestions: [],
    lastAssistantText: '',
    lastAssistantId: null,
    lastAssistantTail: '',
    pending: []
  }
}

function copyFacts(f: TranscriptFacts): TranscriptFacts {
  return {
    ...f,
    gitCalls: f.gitCalls.map((w) => ({ ...w })),
    asked: f.asked.map((p) => ({ ...p })),
    openQuestions: [...f.openQuestions],
    pending: f.pending.map((p) => ({ ...p }))
  }
}

/** Whether a parsed transcript line is a user turn (the spec's definition). */
export function isUserTurn(entry: Record<string, unknown>): boolean {
  if (entry.type !== 'user') return false
  if (entry.isSidechain === true || entry.isMeta === true || entry.isCompactSummary === true) {
    return false
  }
  const text = operatorText(entry)?.trim()
  if (!text) return false
  return !NOT_A_TURN.some((prefix) => text.startsWith(prefix))
}

function foldAssistant(f: TranscriptFacts, entry: Obj, ms: number | null, blocks: Obj[]): void {
  const sidechain = entry.isSidechain === true
  for (const b of blocks) {
    if (b.type !== 'tool_use' || typeof b.id !== 'string' || !b.id) continue
    if (b.name === 'Bash' && ms !== null) {
      const command = isObj(b.input) ? b.input.command : undefined
      if (typeof command === 'string' && GIT_MUTATING.test(command)) {
        f.pending.push({ id: b.id, kind: 'git', startMs: ms })
      }
    } else if (b.name === 'AskUserQuestion' && !sidechain) {
      f.pending.push({ id: b.id, kind: 'ask', startMs: ms })
    }
  }
  if (sidechain) return
  const texts = blocks.filter((b) => b.type === 'text')
  if (texts.length === 0) return
  const text = texts.map((b) => (typeof b.text === 'string' ? b.text : '')).join('\n\n')
  const message = entry.message
  const rawId = isObj(message) ? message.id : undefined
  const id = typeof rawId === 'string' && rawId ? rawId : null
  if (id !== null && id === f.lastAssistantId) {
    // The same message continues: the head (and so the cut text) only changes while it is short.
    const prevTail = f.lastAssistantTail
    if (Array.from(prevTail).length <= LAST_TEXT_MAX) {
      f.lastAssistantText = cutText(prevTail + '\n\n' + text, LAST_TEXT_MAX)
    }
    f.lastAssistantTail = tailOf(prevTail + '\n\n' + text, TAIL_MAX)
  } else {
    f.lastAssistantId = id
    f.lastAssistantText = cutText(text, LAST_TEXT_MAX)
    f.lastAssistantTail = tailOf(text, TAIL_MAX)
  }
  f.openQuestions = openQuestionsOf(f.lastAssistantTail)
}

function foldUser(f: TranscriptFacts, entry: Obj, ms: number | null, blocks: Obj[]): void {
  if (isUserTurn(entry)) f.userTurns++
  const sidechain = entry.isSidechain === true
  for (const b of blocks) {
    if (b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue
    const at = f.pending.findIndex((p) => p.id === b.tool_use_id)
    if (at < 0) continue
    const call = f.pending[at]
    if (call.kind === 'ask' && sidechain) continue
    f.pending.splice(at, 1)
    if (call.kind === 'git') {
      const start = call.startMs as number
      f.gitCalls.push({
        startMs: start - GIT_WINDOW_BEFORE_MS,
        endMs: (ms ?? start) + GIT_WINDOW_AFTER_MS
      })
      continue
    }
    const result = entry.toolUseResult
    const answers = isObj(result) ? result.answers : undefined
    if (!isObj(answers)) continue
    for (const [key, value] of Object.entries(answers)) {
      const question = key.trim()
      const answer = answerText(value)?.trim()
      if (!question || !answer) continue
      f.asked.push({ question: cutText(question, ITEM_MAX), answer: cutText(answer, ITEM_MAX) })
    }
    if (f.asked.length > MAX_PAIRS) f.asked = f.asked.slice(-MAX_PAIRS)
  }
}

/** Folds lines into a copy of `facts`. scan(A) then scan(B) deep-equals scan(A + B). */
export function scanTranscriptLines(
  lines: Iterable<string>,
  facts?: TranscriptFacts
): TranscriptFacts {
  const f = facts ? copyFacts(facts) : emptyFacts()
  for (const raw of lines) {
    let entry: unknown
    try {
      entry = JSON.parse(raw)
    } catch {
      continue
    }
    if (!isObj(entry)) continue
    const ms = timestampMs(entry)
    if (ms !== null) {
      const iso = new Date(ms).toISOString()
      if (f.firstAt === null) f.firstAt = iso
      f.lastAt = iso
    }
    const blocks = contentBlocks(entry)
    if (entry.type === 'assistant') foldAssistant(f, entry, ms, blocks)
    else if (entry.type === 'user') foldUser(f, entry, ms, blocks)
  }
  return f
}

/** gitCalls plus each pending git call as [startMs − 2,000, nowMs + 5,000]; the whole list
 *  stably sorted by startMs. */
export function gitWindows(
  facts: TranscriptFacts,
  nowMs: number
): { startMs: number; endMs: number }[] {
  const open = facts.pending
    .filter((p) => p.kind === 'git' && p.startMs !== null)
    .map((p) => ({
      startMs: (p.startMs as number) - GIT_WINDOW_BEFORE_MS,
      endMs: nowMs + GIT_WINDOW_AFTER_MS
    }))
  return [...facts.gitCalls.map((w) => ({ ...w })), ...open].sort((a, b) => a.startMs - b.startMs)
}
