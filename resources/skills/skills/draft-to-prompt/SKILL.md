---
name: draft-to-prompt
description: Transform a rough idea, voice-note-style draft, or vague request into a production-quality prompt for Claude models (Haiku, Sonnet, Opus, Fable 5). Use this skill whenever the user shares a messy prompt draft and asks to improve/refine it, asks "help me write a prompt for X", asks which model or technique fits a task, or mentions prompt engineering, prompt refinement, or converting an idea into a prompt — even if they don't say the word "prompt" but are clearly describing a task they want to delegate to an AI model. Also use it when the user wants a boot prompt for a new session, worktree, or dispatched agent.
---

# Draft to Prompt (v3)

Turn a rough draft into a finished prompt through three phases: **Elicit → Route → Assemble & Critique**. Maintain a visible state block throughout so the user always knows what's decided and what's missing.

The core belief of this skill: the biggest quality lever is not "which technique" but **which model, which execution harness, and which prompt shape that combination wants**. Techniques are internal vocabulary, not a menu to show the user.

Routing has two independent axes, decided in Phase 2:

1. **Model** — the cheapest model that clears the task's bar (Fable is a last resort, not a default).
2. **Harness** — whether the prompt needs to bootstrap a long-running structure (a loop, a Mission, an orchestration) or is a plain one-shot.

---

## Phase 1 — Elicit

Extract from the user's draft (and conversation history) before asking anything:

- **Goal**: the actual outcome wanted, in one sentence
- **Why**: what the result is for, who consumes it
- **Decided**: constraints, formats, sources already fixed by the user
- **Pending**: decisions that materially change the prompt
- **Inputs needed**: documents, data, research, examples — does the prompt need them attached, or should the target model fetch them?
- **Success criteria**: how the user will judge "this worked"
- **Lifespan**: one answer and done? A session that runs for hours? A mission coordinating other agents? This feeds the harness decision.

Then render the state block and keep it updated every turn:

```
## Prompt state
✅ Decided: ...
⏳ Pending (needs user): ...
🔎 Needs research/sources: ...
📎 Inputs to attach: ...
```

Rules for this phase:

- Ask only about pending items that **materially change the prompt**. For everything else, make a sensible assumption and declare it inline ("Assuming X — correct me if wrong"). Never ask more than 2-3 questions per turn.
- If the draft is already complete enough, skip straight to Phase 2 and say so.
- Do not advance to assembly while a critical pending item is open.

## Phase 2 — Route

Two decisions, made silently, each stated with a one-line justification — don't lecture about the matrix.

### 2a. Model — climb the ladder from the bottom

Cost reality (USD per MTok, in/out — verify occasionally, these drift): **Haiku 4.5 = 1/5 · Sonnet 5 = 3/15 · Opus 4.8 = 5/25 · Fable 5 = 10/50**. (Written without dollar-digit sequences on purpose: the skill loader substitutes `$N` patterns with invocation arguments.) Fable output costs 2× Opus and 10× Haiku — and that multiplies across subagents (see "Model mechanics" below). So: pick the **cheapest model that clears the bar**, and escalate only on evidence, not vibes.

- **Haiku (low/medium effort)** — mechanical, unambiguous, single-surface: rename, color change, config tweak, format conversion, summarizing the last 20 commits. If a competent junior could do it without asking questions, it's Haiku.
- **Sonnet (the default workhorse)** — well-defined features, repeatable transforms, most coding tasks, high-volume recurring jobs. When in doubt between Haiku and Sonnet, take Sonnet; when in doubt between Sonnet and anything above, take Sonnet and add better boundaries to the prompt.
- **Opus (high effort)** — genuinely hard reasoning: gnarly debugging, architecture with real trade-offs, multi-file features where judgment quality dominates. Also the fallback for domains that trip Fable's classifiers (offensive security, biology/chemistry).
- **Fable 5 — last resort, opt-in only.** Reach for it when (a) the task **already failed** on Opus or is visibly beyond it (week-long autonomous missions, massive ambiguous audits, frontier synthesis), AND (b) the user has accepted the cost — say the number ("this bills at USD 10 in / 50 out per MTok, ~2× Opus"). If the user explicitly asks for Fable on a task lower rungs handle, deliver the prompt but push back with the cheaper routing in the same breath; let them overrule.

Effort: recommend it alongside the model (`low` for mechanical work, `high` default on Opus/Fable, `xhigh` only for the most capability-sensitive step). Higher effort doesn't change the per-token price, it spends more tokens — same cost lever, smaller.

### 2b. Harness — match the structure to the lifespan

Independent of model. A trivial task on a big model is waste; a mission without a harness is abandonment. Calibrate:

- **None (default)** — one-shot answers and single-session tasks that end when the turn ends. Changing a button color needs a Haiku prompt, not an orchestrator.
- **/loop** — ONE recurring check on external state: babysit a CI run, poll a deploy, re-run a status skill. The prompt should tell the session to invoke the loop skill self-paced (or with an interval matched to how fast the watched thing changes).
- **The mission stack (orchestration + mission + loop)** — multi-executor coordination: dispatching workers to worktrees/sessions, tracking approvals and evidence, surviving interruptions. Inside Harnu the pieces are bundled skills: the boot prompt instructs the session to (1) invoke `harnu:orchestrate-delivery` for the coordination-only contract (decompose, dispatch, verify), (2) invoke `harnu:mission` with `set <objective>` so the mission state lives in a structured Harnu Mission (born active: the end agreed with the operator in chat is the agreement, and only the operator ends it), (3) drive ticks with the loop skill, self-paced. See `references/harness-routing.md` for the exact boot-prompt wording and a worked template.

Before prescribing a harness, confirm those skills exist in the target environment (they're in the session's available-skills list — bundled Harnu skills arrive namespaced `harnu:` and only when the operator switched them on in Settings → Skills). If absent, fall back to describing the equivalent behavior inline (a persistent state file + a self-scheduled check cadence) rather than naming skills that won't resolve.

### Model mechanics — what a prompt can and cannot control

Get these wrong and the prompt makes promises the platform won't keep. Verified against Anthropic docs (citations in `references/harness-routing.md`):

- **Prompt text CANNOT change a running session's model.** Only `/model` (user gesture), the `--model` CLI flag, `ANTHROPIC_MODEL`, or settings.json do. So the model choice belongs in the **run instructions** ("boot this session with `--model haiku`" / "switch with /model before pasting"), never as an instruction inside the prompt body ("use Sonnet for this" is a no-op).
- **Subagents inherit the parent session's model by default.** Resolution order: `CLAUDE_CODE_SUBAGENT_MODEL` env → per-call `model` parameter on the Agent tool → agent frontmatter `model` field (`haiku`/`sonnet`/`opus`/`fable`/full id/`inherit`, default `inherit`) → parent's model. Two consequences to design around:
  - A big-model session fanning out inherits big-model billing on every subagent. When routing a Fable/Opus session that will spawn workers, **pin cheap subagent models in the prompt** ("spawn file-sweep subagents with model: haiku").
  - The inverse composes beautifully: a cheap session CAN spawn one targeted expensive subagent for the hard core. Prefer "Sonnet session + one Opus subagent for the gnarly part" over "Opus session for everything".
- **Slash commands are parsed only at the start of a USER message** — a prompt that embeds "then run /loop 10m" mid-text does nothing by itself. But skills are model-invocable through the Skill tool (unless the skill sets `disable-model-invocation`), so the correct phrasing in a boot prompt is "**invoke the loop skill** (self-paced) to keep ticking" — an instruction to use a tool, not magic slash text. Alternative when composing a Harnu/CLI boot: make the pasted message literally START with the slash command.

### Prompt shape by model

|               | Fable 5                                                                                                       | Opus / Sonnet / Haiku                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Structure     | Goal + Why + Boundaries + Verification + Output                                                               | Role + Context + Task + Constraints + Format                                           |
| Detail level  | Direction, not steps. Short instructions, model fills gaps                                                    | More explicit steps and edge cases pay off (the cheaper the model, the more explicit)  |
| Reasoning     | Never ask to show/explain reasoning (triggers `reasoning_extraction` refusal). Adaptive thinking is always on | CoT ("think step by step") still helps on hard problems; skip it on Haiku-trivial work |
| Examples      | Few-shot for format/tone only                                                                                 | Few-shot broadly useful                                                                |
| Verification  | Explicit self-verification via fresh-context verifier subagent at intervals                                   | Ask for a final self-check pass                                                        |
| Scope control | Add "don't add features/refactor/abstract beyond the task" for coding                                         | Usually unnecessary on well-bounded tasks; add it when the task is open-ended          |

## Phase 3 — Assemble & Critique

Write the prompt using the shape from Phase 2, then run the anti-pattern checklist **before** showing it. Fix violations silently; mention only the interesting ones.

### Routing & mechanics checklist (all models)

- [ ] Prompt body tells the session which model to "use" → **move to run instructions** (prompt text can't switch models).
- [ ] Big-model session that will fan out, without pinned subagent models → pin cheap models per subagent call.
- [ ] Long-lived mission without a harness → add the mission stack (orchestration + mission + loop) or at minimum a persistent state file.
- [ ] Harness bolted onto a task that ends in one sitting → remove it; ceremony is cost too.
- [ ] Slash command embedded mid-prompt as if it self-executes → rephrase as "invoke the X skill", or restructure so the pasted message starts with the command.
- [ ] Fable routed without evidence lower rungs fail, or without the cost stated → downgrade or surface the price.

### Fable 5 anti-pattern checklist

- [ ] Asks the model to show/explain/output its reasoning or thought process → **remove** (refusal risk). Evidence citations (file + line, source + link) are fine — that's grounding, not chain of thought.
- [ ] Over-prescriptive step-by-step recipe where direction would do → collapse into goal + boundaries.
- [ ] Long-horizon task without a verification instruction → add fresh-context verifier subagent.
- [ ] Claims/findings without an evidence requirement → add "every claim must cite its source/file/session".
- [ ] Coding task without scope boundary → add the no-unrequested-refactor line.
- [ ] Missing "why" → add it; Fable uses purpose to make better judgment calls.
- [ ] Mentions of context budget/limits → remove or add "you have ample context remaining".

### Universal checklist (all models)

- [ ] Output format explicit (structure, length, what leads)?
- [ ] Boundaries stated (what NOT to do)?
- [ ] Inputs referenced by real paths/names, not "the file"?
- [ ] Success criteria expressible? If yes, in the prompt.
- [ ] Anything the target model can't know (dates, internal names, paths) filled in or flagged as `[FILL]`?

### Technique vocabulary (internal — apply, don't name-drop)

- **Few-shot**: the highest-ROI technique for format, tone, and edge-case behavior. Prefer 1-3 tight examples over paragraphs of description.
- **Direction stimulus**: hints, keywords, and constraints inside the prompt. Always cheap, always useful.
- **ReAct**: on modern Claude this is tool/agent design, not prompt phrasing. If the task needs it, recommend tools/subagents instead of writing "reason then act".
- **Manual CoT**: useful on Opus/Sonnet for hard reasoning; harmful on Fable 5 (redundant + refusal risk).
- **Self-consistency / ToT / SoT**: legacy scaffolding. On Fable 5, replace with a verifier subagent or a second review pass. On Opus, use only if the user explicitly wants multi-sample robustness and accepts the cost.
- **Zero-shot / in-context instruction**: the default; only worth mentioning when the user asks why no examples were included.

## Output format

Deliver in this order:

1. Updated **Prompt state** block (only if items are still pending; omit when everything is resolved)
2. The final prompt in a single fenced code block, ready to paste
3. A short "what I changed and why" — max 4-5 bullets in prose, tied to the routing decision
4. **Run instructions** — this is where model choice actually happens, since the prompt can't set it: target model + effort, HOW to apply it (`--model` at boot / `/model` before pasting / dispatch config), pinned subagent models if any, harness bootstrapping steps if any, and anything to fill in before running

If critical items are still pending, deliver the best current draft anyway, with `[FILL: ...]` markers, and list the open questions after it. Never hold the draft hostage to questions.

## Examples

**Example 1 — trivial, cheap, no harness:**
Input: "a prompt to change the submit button in LoginForm.vue to green"
Route: Haiku, low effort. Mechanical single-file change; no harness.
Shape: Role + task + file path + "change only the color token, touch nothing else". Run instructions: boot with `--model haiku`.

**Example 2 — repeatable transform:**
Input: "a prompt to turn release notes into a LinkedIn post, I'll run it every week"
Route: Sonnet. Short, repeatable, cost-sensitive (recurring = cost multiplies).
Shape: Role + task + 2 few-shot examples of past posts (ask user for them → goes to 📎 Inputs) + format constraints (length, tone, no hashtags spam).

**Example 3 — mission stack:**
Input: "a boot prompt for a session that coordinates feature X in a worktree: dispatch executors, demand evidence, call me only at the gates, run on its own until it's done"
Route: Opus high (coordination judgment, but specs already exist — Fable only if the mission has genuinely frontier ambiguity). Harness: the mission stack.
Shape: Goal/Why/Boundaries + "invoke `harnu:orchestrate-delivery` (coordination-only contract), then `harnu:mission` with `set <objective>`, then drive ticks with the loop skill, self-paced" + pinned cheap models for worker subagents + verification via evidence, not self-reports. Template in `references/harness-routing.md`.

**Example 4 — anti-pattern fixes:**
Draft contains: "use the opus model for this and explain your reasoning step by step"
Fix 1: "use opus" moves to run instructions (prompt text can't switch models).
Fix 2 (if routed to Fable): replace reasoning request with "cite the evidence behind each conclusion (source + location)". Tell the user why in one line.
