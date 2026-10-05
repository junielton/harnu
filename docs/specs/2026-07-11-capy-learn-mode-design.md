# Capy Learn mode — interactive lessons in the viewer pane

**Date:** 2026-07-11 · **Status:** Draft (spec approved in brainstorm, pending user review)

## Motivation

The `/teach` skill (user-level, `~/.claude/skills/teach/`) already carries strong pedagogy — MISSION.md grounding, learning records, zone of proximal development, retrieval practice, quizzes. Its weak spot is the output: each lesson is a self-contained static HTML file opened in the external browser. The quiz is dead-ended — the learner answers on the page and the teacher (the Claude session) never finds out.

**The core pain this feature solves: the feedback loop.** Quiz results must reach the teacher session live, so it can explain mistakes, write learning records, and calibrate the next lesson.

## Decisions (from brainstorm)

1. **Pain = feedback to the teacher**, not lesson aesthetics or an embedded browser.
2. **Loop = live, same session.** Results are injected into the teacher session's conversation the moment the learner submits.
3. **Engine = markdown + rich fenced blocks**, not a proprietary JSON schema and not a webview. Lessons stay human-readable files; rendering extends the existing `MarkdownRenderer` seam (T74).
4. **Open-ended questions ship in v1** alongside multiple choice.

## Architecture

The `/teach` skill keeps owning all pedagogy. Only its output changes: instead of HTML, it writes `lessons/NNNN-name.md` (markdown + quiz blocks) and calls the existing `open_file` MCP verb. No new MCP verb. Capy gains one capability: the markdown viewer renders quiz blocks as interactive widgets and routes results back to a session.

```
teach skill ──writes──▶ lessons/0002-agents.md ──open_file──▶ MarkdownPane
                                                                  │ renders
                                                            QuizBlock.vue
                                                                  │ learner submits
                                              local grading (embedded answer key)
                                                                  │ one summary message
                                              PTY injection (prompt-submit.ts machinery)
                                                                  ▼
                                                        teacher session reacts
```

## Lesson format (the contract)

A lesson is a normal markdown file. Images are standard `![](...)`. One new fenced block type:

### Multiple choice (`quiz`)

````markdown
```quiz
q: Where does an agent definition live?
- [ ] In RAM during execution
- [x] In .claude/agents/*.md
- [ ] In the Capy sidebar
explain: Subagent is a relationship; agent is a file.
```
````

- Exactly one `[x]` → rendered as radio buttons (single choice).
- Multiple `[x]` → rendered as checkboxes (multi-select; correct = exact set match).
- `explain:` (optional) is hidden until submission, then always revealed after grading.
- The answer key is embedded because the author (the teacher model) knows the answer at authoring time. The rendered pane never shows the key before submission.

### Open-ended (`quiz` with `open: true`)

````markdown
```quiz
q: In your own words: why does the word "subagent" exist if an agent is an agent?
open: true
```
````

- Rendered as a textarea. There is no local grading — the learner's free-text answer travels in the injected message and the teacher evaluates it in conversation. This is where the model genuinely grades.

### Frontmatter (optional)

```yaml
---
capy-lesson: true # explicit marker; renderer may also detect quiz blocks
session: <capy-session-id> # explicit teacher override for result injection
---
```

## Interaction & grading flow

1. **Answering is stateful in the pane.** Options are real radio/checkbox inputs; the learner can change answers freely. Multiple quiz blocks in one lesson form one "exam".
2. **Submit → instant local grading.** A "Submit" affordance per lesson (not per question) compares selections against the embedded key: each question turns green/red, `explain` is revealed. No model roundtrip — this is the tight feedback loop the skill demands.
3. **One summary message to the teacher.** After grading, Capy injects a single message into the teacher session using the existing bracketed-paste + quiescence-submit machinery (`prompt-submit.ts` — same tested path as MCP `prePrompt`):

```
[capy-lesson] 0002-agents.md — 4/5
Q1 ✓  Q2 ✓  Q4 ✓  Q5 ✓
Q3 ✗  answered: "In RAM during execution" · correct: ".claude/agents/*.md"
Q6 (open) answered: "<learner's free text>"
```

The teacher then interprets: explains the _why_ behind mistakes, grades open answers, writes learning records, plans the next lesson.

4. **Teacher session resolution.** The MCP layer has no per-session identity (confirmed in `tool-catalog.ts`), so:
   - frontmatter `session:` wins when present;
   - otherwise inject into the **currently selected session** (in practice: the session the learner is studying with);
   - no live session → keep local feedback, show a toast ("no live teacher session — results not delivered"), do not queue.

## Components

| Unit                                    | Responsibility                                                                    | Notes                                                                                                                       |
| --------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `src/renderer/src/lib/lesson-blocks.ts` | Pure parser: fence text → `QuizSpec` (question, options, key, open flag, explain) | Framework-free, unit-tested like `prompt-submit.ts`                                                                         |
| `QuizBlock.vue`                         | Interactive widget: inputs, grading render, per-question state                    | Plugged into the `lib/markdown.ts` → `MarkdownRenderer` seam (T74 was built to be this extension point); design tokens only |
| Exam state + submit                     | Collect all quiz blocks in a pane, grade, build the summary payload               | Lives with `MarkdownPane`'s lesson mode                                                                                     |
| Result injection                        | Renderer → main → target session PTY write + quiescence submit                    | Reuses `prompt-submit.ts`; zero new timing code                                                                             |

**Error handling:** a malformed quiz block degrades to a plain code fence (never breaks the lesson). PTY-busy timing is already handled by the quiescence submitter. Missing target session → toast, as above.

## Dependencies

- **Image preview bug is a prerequisite**: roadmap card _"Explorer/MarkdownPane can't preview images — binary-file guard blocks them"_ must land, or lessons render without their diagrams/figures.

## Repo contracts this feature owes

- `design.md` §6: quiz widget component spec (states: unanswered / selected / graded-correct / graded-wrong / open-question; motion per §7) — **before** implementation, same change.
- i18n: every new string in **both** `en.json` and `pt-BR.json`.
- `CHANGELOG.md` entry.
- `docs/capy-features.md` + version-marker bump — this **is** agent-facing: agents must learn "write lessons as markdown with ```quiz blocks, open them with `open_file`, results come back as a `[capy-lesson]` user message".
- The user's personal `/teach` skill gains a "inside Capy, emit .md+quiz instead of HTML" section (outside this repo; follow-up, not part of the Capy change).

## Out of scope (v1)

- Generic mini-browser / `<webview>` pane (valid tangent, separate feature).
- Image-generation API keys in Capy Settings — the agent already generates images via its own skills and saves files.
- Mermaid/diagram block (ASCII fences work today; later).
- Spaced-repetition scheduler UI.
- Capy writing learning records itself — that is the teacher's job upon receiving results, per the skill.

## Testing

- `lesson-blocks.ts`: unit tests — grammar variants (radio/multi/open), malformed input degrades gracefully.
- `QuizBlock.vue`: component test — select → submit → graded render; summary payload shape.
- Injection path: already covered by `tests/prompt-submit.test.ts`; add one integration-shaped test for payload formatting.
- Manual: real `/teach` lesson end-to-end in dev (author lesson → open_file → answer → teacher receives `[capy-lesson]` message).
