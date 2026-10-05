/**
 * Lesson parser (T120 — Harnu Learn mode). Pure, framework-free: a lesson's
 * markdown string in, an ordered list of segments out.
 *
 * WHY IT SPLITS THE DOCUMENT: the T74 markdown seam (`renderMarkdown`) returns a
 * sanitized HTML STRING that `MarkdownRenderer` `v-html`s — a Vue component can
 * never be mounted inside that. So a lesson is cut into alternating `prose`
 * segments (rendered by the untouched `MarkdownRenderer`) and `quiz` segments
 * (rendered by `QuizBlock.vue`), which keeps the sanitizer the single audited
 * sink and adds no HTML-injection surface.
 *
 * Grammar (docs/specs/2026-07-11-harnu-learn-mode-design.md), inside a ```quiz fence:
 *   q: <question>            (required)
 *   - [ ] <option>           (an option; `[x]` marks it correct)
 *   open: true               (free-text question — no options, no local grading)
 *   explain: <text>          (optional; revealed only after grading)
 *
 * A MALFORMED fence is never fatal: it degrades to a prose segment carrying the
 * fence verbatim, so it renders as a plain code block and the lesson survives.
 */

export interface QuizOption {
  text: string
  correct: boolean
}

export interface QuizSpec {
  /** Stable within a lesson: 'q1', 'q2', … in document order (1-based). */
  id: string
  question: string
  /** Free-text question: no options, graded by the teacher, not by us. */
  open: boolean
  /** More than one correct option → checkboxes; correct = exact set match. */
  multi: boolean
  options: QuizOption[]
  explain: string | null
  /**
   * `mode: check` in the file: the block grades ON THE SPOT and does not freeze the
   * lesson (retrieval practice in the middle of the material). `exam` (the default)
   * keeps T120's single submit. An unknown value degrades to `exam`, so an author's
   * typo cannot break the lesson.
   */
  checkpoint: boolean
}

export type LessonSegment = { kind: 'prose'; markdown: string } | { kind: 'quiz'; spec: QuizSpec }

/** An opening ```quiz fence (allowing indentation and trailing spaces). */
const QUIZ_OPEN = /^[ \t]*```[ \t]*quiz[ \t]*$/
/** Any closing fence. */
const QUIZ_CLOSE = /^[ \t]*```[ \t]*$/
const OPTION_LINE = /^[ \t]*-[ \t]*\[([ xX])\][ \t]*(.*)$/
const KEY_LINE = /^[ \t]*(q|open|explain|mode)[ \t]*:[ \t]*(.*)$/i

/**
 * Parse ONE quiz fence body. Returns null when the block is malformed — the
 * caller then keeps the fence as prose (degrade, never throw).
 */
function parseQuizBody(body: string[], id: string): QuizSpec | null {
  let question = ''
  let open = false
  let explain: string | null = null
  let checkpoint = false
  const options: QuizOption[] = []

  for (const line of body) {
    const opt = OPTION_LINE.exec(line)
    if (opt) {
      const text = opt[2].trim()
      if (text) options.push({ text, correct: opt[1].toLowerCase() === 'x' })
      continue
    }
    const kv = KEY_LINE.exec(line)
    if (!kv) continue // unknown line: ignored, not fatal
    const key = kv[1].toLowerCase()
    const value = kv[2].trim()
    if (key === 'q') question = value
    else if (key === 'open') open = /^(true|yes|1)$/i.test(value)
    else if (key === 'explain') explain = value || null
    else if (key === 'mode') checkpoint = value.toLowerCase() === 'check'
  }

  if (!question) return null // no question → not a quiz
  if (open) return { id, question, open: true, multi: false, options: [], explain, checkpoint }

  const correctCount = options.filter((o) => o.correct).length
  // A closed question needs options AND an answer key — without one we'd render an
  // ungradable widget, so degrade to a code block instead of shipping a dead quiz.
  if (options.length === 0 || correctCount === 0) return null

  return { id, question, open: false, multi: correctCount > 1, options, explain, checkpoint }
}

/** Split a lesson into ordered prose/quiz segments. Never throws. */
export function parseLesson(src: string): LessonSegment[] {
  const text = typeof src === 'string' ? src : ''
  const lines = text.split('\n')
  const segments: LessonSegment[] = []
  let prose: string[] = []
  let quizCount = 0

  const flushProse = (): void => {
    if (prose.length === 0) return
    const markdown = prose.join('\n')
    if (markdown.trim()) segments.push({ kind: 'prose', markdown })
    prose = []
  }

  for (let i = 0; i < lines.length; i++) {
    if (!QUIZ_OPEN.test(lines[i])) {
      prose.push(lines[i])
      continue
    }

    // Collect the fence body up to the closing ```.
    const body: string[] = []
    let j = i + 1
    let closed = false
    for (; j < lines.length; j++) {
      if (QUIZ_CLOSE.test(lines[j])) {
        closed = true
        break
      }
      body.push(lines[j])
    }

    const spec = closed ? parseQuizBody(body, `q${quizCount + 1}`) : null
    if (spec) {
      flushProse()
      segments.push({ kind: 'quiz', spec })
      quizCount++
      i = j // skip past the closing fence
    } else {
      // Malformed (or unterminated) → keep the raw fence line as prose: markdown-it
      // renders the block as a plain code fence and the lesson still reads.
      prose.push(lines[i])
    }
  }

  flushProse()
  return segments
}

export function hasQuiz(segments: LessonSegment[]): boolean {
  return segments.some((s) => s.kind === 'quiz')
}

/**
 * The optional frontmatter `session:` override — the teacher session results are
 * injected into when present (otherwise: the currently selected session).
 * Deliberately a small scan, not a YAML dependency: the lesson frontmatter is a
 * flat key/value block and we only read ONE key.
 */
export function lessonSessionOverride(src: string): string | null {
  const text = typeof src === 'string' ? src : ''
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!fm) return null
  const hit = /^[ \t]*session[ \t]*:[ \t]*(.+?)[ \t]*$/im.exec(fm[1])
  const value = hit?.[1]?.replace(/^["']|["']$/g, '').trim()
  return value ? value : null
}

/** A learner's answer to one question. */
export type QuizAnswer = { kind: 'choice'; selected: number[] } | { kind: 'open'; text: string }

export interface QuizResult {
  spec: QuizSpec
  answer: QuizAnswer | null
  /** `null` for an open question — the TEACHER grades those, not Harnu. */
  correct: boolean | null
}

/** Grade one question against its embedded key. Multi = exact set match. */
export function gradeQuiz(spec: QuizSpec, answer: QuizAnswer | null): QuizResult {
  if (spec.open) return { spec, answer, correct: null }
  const selected =
    answer?.kind === 'choice' ? [...new Set(answer.selected)].sort((a, b) => a - b) : []
  const key = spec.options.map((o, i) => (o.correct ? i : -1)).filter((i) => i >= 0)
  const correct = selected.length === key.length && selected.every((i, n) => i === key[n])
  return { spec, answer, correct }
}

export interface LessonScore {
  correct: number
  /** Locally gradable questions — open ones are excluded from the score. */
  gradable: number
}

export function scoreLesson(results: QuizResult[]): LessonScore {
  const gradable = results.filter((r) => r.correct !== null)
  return { correct: gradable.filter((r) => r.correct === true).length, gradable: gradable.length }
}

/** Human-readable label for a question id ('q1' → 'Q1'). */
function label(spec: QuizSpec): string {
  return spec.id.replace(/^q/, 'Q')
}

/** Stands in for a question the learner left blank. Rendered UNQUOTED (see {@link quoted}). */
const NO_ANSWER = '(no answer)'

function answerText(result: QuizResult): string {
  const { spec, answer } = result
  if (!answer) return NO_ANSWER
  if (answer.kind === 'open') return answer.text.trim() || NO_ANSWER
  const picked = [...new Set(answer.selected)]
    .sort((a, b) => a - b)
    .map((i) => spec.options[i]?.text)
    .filter((t): t is string => Boolean(t))
  return picked.length ? picked.join(', ') : NO_ANSWER
}

/**
 * Quote a learner's answer — except the blank sentinel, which stays bare so the
 * teacher reads `answered: (no answer)` as "nothing was given" and not as a
 * learner who literally typed the words "(no answer)".
 */
function quoted(text: string): string {
  return text === NO_ANSWER ? NO_ANSWER : `"${text}"`
}

function keyText(spec: QuizSpec): string {
  return spec.options
    .filter((o) => o.correct)
    .map((o) => o.text)
    .join(', ')
}

/**
 * The ONE message injected into the teacher session. Deterministic and
 * plain-text: the teacher reads it as a normal user turn, so it must be legible
 * without any Harnu-side context. Open answers travel VERBATIM — grading them is
 * exactly the teacher's job.
 *
 * `kind` (T123) marks WHICH delivery this is, on the first line, because the
 * teacher cannot otherwise tell a checkpoint (mid-lesson practice, `checkOne`)
 * apart from an exam (the whole-lesson `submitLesson`) — both used to render as
 * `n/m`, so a single mid-lesson checkpoint could be misread as assessment
 * evidence and mastery could get recorded off ONE practice question. `exam` is
 * the default: the wire format for an exam delivery is byte-identical to before
 * this change, and every existing caller/test keeps working untouched. A
 * `checkpoint` delivery never renders a score (not even `0/0` for an open
 * checkpoint) — only the `— checkpoint` marker followed by the per-question
 * verdict lines.
 */
export function formatLessonSummary(
  fileName: string,
  results: QuizResult[],
  kind: 'exam' | 'checkpoint' = 'exam'
): string {
  const lines: string[] = [
    kind === 'checkpoint'
      ? `[harnu-lesson] ${fileName} — checkpoint`
      : `[harnu-lesson] ${fileName} — ${scoreLesson(results).correct}/${scoreLesson(results).gradable}`
  ]

  const rights = results.filter((r) => r.correct === true)
  if (rights.length) lines.push(rights.map((r) => `${label(r.spec)} ✓`).join('  '))

  for (const r of results.filter((r) => r.correct === false)) {
    lines.push(
      `${label(r.spec)} ✗  answered: ${quoted(answerText(r))} · correct: "${keyText(r.spec)}"`
    )
  }
  for (const r of results.filter((r) => r.spec.open)) {
    lines.push(`${label(r.spec)} (open) answered: ${quoted(answerText(r))}`)
  }
  return lines.join('\n')
}
