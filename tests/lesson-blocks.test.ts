import { describe, expect, it } from 'vitest'
import {
  formatLessonSummary,
  gradeQuiz,
  hasQuiz,
  lessonSessionOverride,
  parseLesson,
  scoreLesson,
  type QuizSpec
} from '../src/renderer/src/lib/lesson-blocks'

const fence = (body: string): string => '```quiz\n' + body + '\n```'

function quizzes(src: string): QuizSpec[] {
  return parseLesson(src).flatMap((s) => (s.kind === 'quiz' ? [s.spec] : []))
}

describe('parseLesson — grammar', () => {
  it('parses a single-choice question into radio shape (exactly one [x])', () => {
    const [q] = quizzes(
      fence('q: Where does an agent live?\n- [ ] In RAM\n- [x] In .claude/agents/*.md')
    )
    expect(q.question).toBe('Where does an agent live?')
    expect(q.open).toBe(false)
    expect(q.multi).toBe(false)
    expect(q.options).toEqual([
      { text: 'In RAM', correct: false },
      { text: 'In .claude/agents/*.md', correct: true }
    ])
    expect(q.explain).toBeNull()
    expect(q.id).toBe('q1')
  })

  it('parses >1 [x] as a multi-select question', () => {
    const [q] = quizzes(fence('q: Which are files?\n- [x] agent\n- [x] skill\n- [ ] subagent'))
    expect(q.multi).toBe(true)
    expect(q.options.filter((o) => o.correct)).toHaveLength(2)
  })

  it('accepts uppercase [X] as correct', () => {
    const [q] = quizzes(fence('q: Q?\n- [X] yes\n- [ ] no'))
    expect(q.options[0].correct).toBe(true)
  })

  it('parses open: true as a free-text question with no options', () => {
    const [q] = quizzes(fence('q: In your own words, why?\nopen: true'))
    expect(q.open).toBe(true)
    expect(q.options).toEqual([])
    expect(q.multi).toBe(false)
  })

  it('captures explain: and keeps it out of the question text', () => {
    const [q] = quizzes(fence('q: Q?\n- [x] a\n- [ ] b\nexplain: Because reasons.'))
    expect(q.explain).toBe('Because reasons.')
    expect(q.question).toBe('Q?')
  })

  it('numbers questions across the whole lesson, in document order', () => {
    const src = `# Lesson\n\n${fence('q: A?\n- [x] a\n- [ ] b')}\n\ntext\n\n${fence('q: B?\nopen: true')}\n`
    expect(quizzes(src).map((q) => q.id)).toEqual(['q1', 'q2'])
  })

  it('splits prose and quiz segments in order, preserving the prose', () => {
    const src = `# Title\n\nintro\n\n${fence('q: A?\n- [x] a\n- [ ] b')}\n\noutro\n`
    const segs = parseLesson(src)
    expect(segs.map((s) => s.kind)).toEqual(['prose', 'quiz', 'prose'])
    expect(segs[0].kind === 'prose' && segs[0].markdown).toContain('# Title')
    expect(segs[2].kind === 'prose' && segs[2].markdown).toContain('outro')
  })

  it('leaves non-quiz fences untouched', () => {
    const src = '```ts\nconst a = 1\n```\n'
    const segs = parseLesson(src)
    expect(segs).toHaveLength(1)
    expect(segs[0].kind).toBe('prose')
    expect(hasQuiz(segs)).toBe(false)
  })
})

describe('parseLesson — malformed blocks degrade to a plain code fence', () => {
  const cases: Record<string, string> = {
    'no q:': fence('- [x] a\n- [ ] b'),
    'no options and not open': fence('q: Dangling?'),
    'no correct option': fence('q: Q?\n- [ ] a\n- [ ] b'),
    'unterminated fence': '```quiz\nq: Q?\n- [x] a\n'
  }
  for (const [name, src] of Object.entries(cases)) {
    it(`degrades: ${name}`, () => {
      const segs = parseLesson(src)
      expect(hasQuiz(segs)).toBe(false)
      expect(segs.every((s) => s.kind === 'prose')).toBe(true)
      // The original text survives verbatim, so markdown-it renders it as a code block.
      expect(segs.map((s) => (s.kind === 'prose' ? s.markdown : '')).join('')).toContain('```quiz')
    })
  }

  it('a malformed block does not kill a valid one in the same lesson', () => {
    const src = `${fence('q: broken')}\n\n${fence('q: Good?\n- [x] a\n- [ ] b')}\n`
    expect(quizzes(src).map((q) => q.question)).toEqual(['Good?'])
  })
})

describe('lessonSessionOverride', () => {
  it('reads session: from frontmatter', () => {
    const src = '---\nharnu-lesson: true\nsession: abc-123\n---\n\n# L\n'
    expect(lessonSessionOverride(src)).toBe('abc-123')
  })
  it('returns null with no frontmatter', () => {
    expect(lessonSessionOverride('# L\n')).toBeNull()
  })
  it('returns null when frontmatter has no session key', () => {
    expect(lessonSessionOverride('---\nharnu-lesson: true\n---\n# L\n')).toBeNull()
  })
})

describe('gradeQuiz', () => {
  const single = quizzes(fence('q: Q?\n- [ ] wrong\n- [x] right'))[0]
  const multi = quizzes(fence('q: Q?\n- [x] a\n- [x] b\n- [ ] c'))[0]
  const open = quizzes(fence('q: Q?\nopen: true'))[0]

  it('marks a correct single choice', () => {
    expect(gradeQuiz(single, { kind: 'choice', selected: [1] }).correct).toBe(true)
  })
  it('marks a wrong single choice', () => {
    expect(gradeQuiz(single, { kind: 'choice', selected: [0] }).correct).toBe(false)
  })
  it('multi requires an EXACT set match (order-insensitive)', () => {
    expect(gradeQuiz(multi, { kind: 'choice', selected: [1, 0] }).correct).toBe(true)
    expect(gradeQuiz(multi, { kind: 'choice', selected: [0] }).correct).toBe(false) // partial
    expect(gradeQuiz(multi, { kind: 'choice', selected: [0, 1, 2] }).correct).toBe(false) // superset
  })
  it('an unanswered choice question is wrong, not null', () => {
    expect(gradeQuiz(single, null).correct).toBe(false)
  })
  it('an open question is never locally graded (correct = null)', () => {
    expect(gradeQuiz(open, { kind: 'open', text: 'whatever' }).correct).toBeNull()
    expect(gradeQuiz(open, null).correct).toBeNull()
  })
})

describe('scoreLesson', () => {
  it('counts only gradable (non-open) questions', () => {
    const [a, b, c] = quizzes(
      `${fence('q: A?\n- [x] r\n- [ ] w')}\n${fence('q: B?\n- [x] r\n- [ ] w')}\n${fence('q: C?\nopen: true')}`
    )
    const results = [
      gradeQuiz(a, { kind: 'choice', selected: [0] }),
      gradeQuiz(b, { kind: 'choice', selected: [1] }),
      gradeQuiz(c, { kind: 'open', text: 'hi' })
    ]
    expect(scoreLesson(results)).toEqual({ correct: 1, gradable: 2 })
  })
})

describe('formatLessonSummary', () => {
  it('builds the [harnu-lesson] payload: score, verdicts, given vs correct, open verbatim', () => {
    const [a, b, c] = quizzes(
      `${fence('q: A?\n- [x] right\n- [ ] wrong')}\n${fence('q: B?\n- [ ] nope\n- [x] yep')}\n${fence('q: C?\nopen: true')}`
    )
    const summary = formatLessonSummary('0002-agents.md', [
      gradeQuiz(a, { kind: 'choice', selected: [0] }),
      gradeQuiz(b, { kind: 'choice', selected: [0] }),
      gradeQuiz(c, { kind: 'open', text: 'my own words' })
    ])
    const lines = summary.split('\n')
    expect(lines[0]).toBe('[harnu-lesson] 0002-agents.md — 1/2')
    expect(summary).toContain('Q1 ✓')
    expect(summary).toContain('Q2 ✗  answered: "nope" · correct: "yep"')
    expect(summary).toContain('Q3 (open) answered: "my own words"')
  })

  it('reports an unanswered question explicitly', () => {
    const [a] = quizzes(fence('q: A?\n- [x] right\n- [ ] wrong'))
    expect(formatLessonSummary('l.md', [gradeQuiz(a, null)])).toContain('answered: (no answer)')
  })

  it('joins a multi-select answer with commas', () => {
    const [a] = quizzes(fence('q: A?\n- [x] one\n- [x] two\n- [ ] three'))
    const s = formatLessonSummary('l.md', [gradeQuiz(a, { kind: 'choice', selected: [0, 2] })])
    expect(s).toContain('answered: "one, three" · correct: "one, two"')
  })

  it('an exam delivery (kind omitted) is byte-identical to before T123 — regression guard', () => {
    const [a, b, c] = quizzes(
      `${fence('q: A?\n- [x] right\n- [ ] wrong')}\n${fence('q: B?\n- [ ] nope\n- [x] yep')}\n${fence('q: C?\nopen: true')}`
    )
    const results = [
      gradeQuiz(a, { kind: 'choice', selected: [0] }),
      gradeQuiz(b, { kind: 'choice', selected: [0] }),
      gradeQuiz(c, { kind: 'open', text: 'my own words' })
    ]
    expect(formatLessonSummary('0002-agents.md', results)).toBe(
      formatLessonSummary('0002-agents.md', results, 'exam')
    )
    expect(formatLessonSummary('0002-agents.md', results).split('\n')[0]).toBe(
      '[harnu-lesson] 0002-agents.md — 1/2'
    )
  })
})

describe('formatLessonSummary — checkpoint delivery (T123)', () => {
  it('marks the first line as a checkpoint, with NO n/m score', () => {
    const [q] = quizzes(fence('q: Q?\n- [x] right\n- [ ] wrong'))
    const summary = formatLessonSummary(
      'lesson.md',
      [gradeQuiz(q, { kind: 'choice', selected: [0] })],
      'checkpoint'
    )
    const lines = summary.split('\n')
    expect(lines[0]).toBe('[harnu-lesson] lesson.md — checkpoint')
    expect(lines[0]).not.toMatch(/\d+\/\d+/)
    expect(summary).toContain('Q1 ✓')
  })

  it('a wrong checkpoint still reports the verdict line, no score on line 1', () => {
    const [q] = quizzes(fence('q: Q?\n- [x] right\n- [ ] wrong'))
    const summary = formatLessonSummary(
      'lesson.md',
      [gradeQuiz(q, { kind: 'choice', selected: [1] })],
      'checkpoint'
    )
    expect(summary.split('\n')[0]).toBe('[harnu-lesson] lesson.md — checkpoint')
    expect(summary).toContain('Q1 ✗  answered: "wrong" · correct: "right"')
  })

  it('an OPEN checkpoint never renders 0/0 — it carries the checkpoint marker instead', () => {
    const [q] = quizzes(fence('mode: check\nq: Why?\nopen: true'))
    const summary = formatLessonSummary(
      'lesson.md',
      [gradeQuiz(q, { kind: 'open', text: 'because' })],
      'checkpoint'
    )
    expect(summary).not.toContain('0/0')
    expect(summary.split('\n')[0]).toBe('[harnu-lesson] lesson.md — checkpoint')
    expect(summary).toContain('Q1 (open) answered: "because"')
  })
})

describe('parseLesson — mode: check | exam (T123)', () => {
  it('mode: check marks the block as a checkpoint', () => {
    const [q] = quizzes(fence('mode: check\nq: Q?\n- [x] a\n- [ ] b'))
    expect(q.checkpoint).toBe(true)
  })

  it('defaults to exam when mode is absent — every T120 lesson keeps working', () => {
    const [q] = quizzes(fence('q: Q?\n- [x] a\n- [ ] b'))
    expect(q.checkpoint).toBe(false)
  })

  it('mode: exam is explicit and equivalent to the default', () => {
    const [q] = quizzes(fence('mode: exam\nq: Q?\n- [x] a\n- [ ] b'))
    expect(q.checkpoint).toBe(false)
  })

  it('an UNKNOWN mode degrades to exam — a typo never breaks the lesson', () => {
    const [q] = quizzes(fence('mode: bogus\nq: Q?\n- [x] a\n- [ ] b'))
    expect(q.checkpoint).toBe(false)
  })

  it('works on an open question too (a checkpoint can be free-text)', () => {
    const [q] = quizzes(fence('mode: check\nq: Why?\nopen: true'))
    expect(q.checkpoint).toBe(true)
    expect(q.open).toBe(true)
  })
})
