# ADR-0001 — Coverage as a reliable regression gate (including for agent-written code)

**Status:** Accepted
**Date:** 2026-06-25
**Author:** junielton
**Deciders:** junielton
**Technical context:** Capy's testing strategy (Electron + Vue, Vitest)

> First ADR in this repo. It also establishes the convention: ADRs live in
> `docs/adr/NNNN-slug.md`, numbered, in English, in the format below (context →
> decision → alternatives → consequences). An ADR records a **forward-looking
> decision**; it differs from `docs/lessons/` (retrospective) and
> `docs/superpowers/specs/` (feature design).

---

## 1. Context

We want to raise test coverage to **as close to 100% as possible, to prevent
regressions** — and, in parallel, build **confidence in agents that write code
AND the tests themselves**. The two goals are coupled: an agent is only
trustworthy if the pipeline objectively fails whatever it gets wrong.

State at the time of the decision (measured with `@vitest/coverage-v8`):

- **56.9% lines/statements** in aggregate (`src/main/**` + `src/renderer/src/**`).
- Pure logic that **has** tests sits at 90–100%. The gap is three very different
  kinds of code:
  1. **Pure logic** (parsers, stores, libs) — cleanly and deterministically testable.
  2. **Electron/IPC glue** (`pty.ts`, `claude-watcher.ts`, `menu.ts`, `*-ipc.ts`,
     `updater.ts`, `dialog.ts`, `external.ts`, `statusline.ts`) — only coverable with
     heavy mocks of `electron`/`node-pty`/`chokidar`/`fs`; tests end up brittle.
  3. **`.vue` components** (41 of 42 with no unit test) — today partially covered by
     e2e Playwright.

### The core problem: coverage measures execution, not assertion

High coverage does **not** prevent regressions; **assertion** does. A "green" line
covered by a test that doesn't verify behavior gives false confidence. This isn't
theoretical in this repo — we've been burned twice already, documented in:

- [`docs/lessons/testing/001-blind-assertion-false-green.md`](../lessons/testing/001-blind-assertion-false-green.md)
  — an assertion whose observation channel ran through the very code being fixed:
  green, blind to the change.
- [`docs/lessons/testing/003-assert-expected-from-requirement-not-implementation.md`](../lessons/testing/003-assert-expected-from-requirement-not-implementation.md)
  — the expected value copied from the (buggy) implementation instead of the
  requirement: green, shipped a user-visible bug.

An **agent** optimizing for "make the threshold pass" is an industrial generator of
this pattern (`expect(result).toBeDefined()` covers the line and protects nothing).
So **a coverage threshold alone isn't enough** to trust agent-written tests.

---

## 2. Decision

Adopt a **convention-based strategy** that makes coverage a _meaningful_ regression
gate, held up by four locks:

### 2.1 Pure-core / thin-shell separation (the convention)

One rule, fits in a sentence:

> **Logic goes in a pure module** (no `import` of `electron`/`node-pty`/`chokidar`/`fs`)
> → covered to ~100%, threshold enforces it.
> **Wiring goes in a thin shell** (`*-ipc.ts`, registrars, entry points) → excluded
> from the metric by **glob pattern**, not a hand-maintained list.

When a glue file (e.g. `pty.ts`) mixes both, **extract the pure logic** into a
testable module — exactly like the existing
`src/renderer/src/components/spawn-spec.ts` (100%), leaving only the wiring in the
original file.

### 2.2 Coverage scope by glob

- `coverage.include`: all logic (`src/main/**/*.ts`, `src/renderer/src/**/*.ts`)
  **and** the `.vue` files.
- `coverage.exclude`: wiring shells, by pattern (`**/*-ipc.ts`) plus a **small,
  comment-justified** set of env-bound entry points (`src/main/index.ts`,
  `src/renderer/src/main.ts`, `src/main/pty.ts`, `src/main/claude-watcher.ts`).
  Every exclusion carries its reason inline.

### 2.3 `.vue` covered by component tests

Add component tests with `@vue/test-utils` (jsdom), alongside the e2e Playwright
suite, which continues covering integration flows.

### 2.4 Coverage threshold in CI (the "code without tests" lock)

Configure `coverage.thresholds` in Vitest, **pinned to the real ceiling once**
the extraction+testing work is done (so the build doesn't break mid-effort), then
ratcheted upward. Fails the build if coverage drops → nobody adds new logic
without a test.

### 2.5 Mutation testing on pure modules (the "test that doesn't assert" lock)

Add **StrykerJS** targeting the pure modules. It mutates the code (swaps `>`↔`>=`,
removes lines, inverts `&&`) and runs the suite: a **surviving** mutant means a
weak assertion; a **killed** mutant means an assertion that actually protects. The
_mutation score_ is the metric that **can't be inflated with an empty test** — it's
proof the test would catch the regression.

Synergy with 2.1: mutation testing is slow and only works well on fast,
deterministic code — i.e., **exactly the pure modules** the convention isolates.
The excluded glue never even enters the picture.

---

## 3. Alternatives considered

### Option A — Mock all the glue (`vi.mock` of electron/node-pty/chokidar/fs)

- ✅ Higher coverage number (glue moves off 0%).
- ❌ **Brittle** tests: the mock imitates the node-pty/Electron surface and breaks on
  any refactor with no real bug. Turns into debt that only grows; these are the
  tests that become `.skip` six months later.
- ❌ Bad for agents: pushes the agent to write mocks of APIs it doesn't fully
  understand — exactly where it hallucinates most.
- ❌ Covers wiring, not behavior: the real flow (node-pty talking to a shell,
  backpressure, native ABI) never actually runs.
- **Rejected.**

### Option B — Hybrid (mock part of the glue, exclude part)

- ✅ Good number with little excluded code.
- ❌ The **rule** is "it depends": for every new glue file, decide mock vs. exclude.
  Doesn't fit in one person's head, let alone an agent's → doesn't scale cognitively.
- **Rejected** — the deciding axis is _scalability and continuity_, and on that axis
  the hybrid is the worst of the three.

### Option C (chosen) — Pure-core/thin-shell convention + threshold + mutation testing

- ✅ A single, pattern-based rule that outlives its author.
- ✅ Self-enforcing: new logic lands in a non-excluded module → CI requires a test.
- ✅ Ideal ground for mutation testing (fast/deterministic).
- ✅ High global number **and** every percentage point corresponds to genuinely
  tested behavior.

---

## 4. Consequences

### Positive

- **One sentence for the next dev or agent:** "logic in a pure module, wiring in
  `*-ipc`."
- **Confidence in agents** becomes a property of the pipeline, not a matter of
  discipline: CI objectively fails (a) logic without a test (threshold) and (b) a
  test that runs but doesn't assert (mutation score). The agent can't route around
  the gates.
- Stable tests (no brittle mocks of native APIs).
- Coverage becomes a _meaningful_ regression gate, not a vanity number.

### Costs / negatives

- Initial **extraction refactor**: pulling pure logic out of `pty.ts`,
  `claude-watcher.ts`, etc. into their own modules. (This is what makes the
  codebase durably testable — not wasted work.)
- **Stryker is slow** (runs the suite per mutant). Mitigated by restricting it to
  pure modules and running the full sweep on a scheduled CI job, not every push.
- **Naming discipline** for shells (`*-ipc.ts` suffix) — becomes a review item.
- Env-bound glue (`pty.ts`, `claude-watcher.ts`) drops out of the denominator: its
  protection now depends on **e2e Playwright**, not unit tests. Accepted explicitly.

### Confidence stack (summary)

| Lock                       | Catches what                            | Enforced by |
| -------------------------- | --------------------------------------- | ----------- |
| `typecheck` + `lint`       | type errors, broken contracts           | CI          |
| Convention (pure module)   | makes code testable without mocks       | rule/review |
| Coverage threshold         | new logic **without a test**            | CI          |
| Mutation testing (Stryker) | a test that **runs but doesn't assert** | CI          |

---

## 5. Follow-up

- **Implementation spec** (in `docs/superpowers/specs/`) detailing: the per-file
  extraction list, attack order, `include`/`exclude`/`thresholds` configuration,
  Stryker setup and mutation-score targets, and the ratchet plan.
- Record the pure-core/thin-shell convention in `CLAUDE.md` (architecture/testing
  section) once the spec settles on the exact globs.

---

## Related

- [`docs/lessons/testing/001-blind-assertion-false-green.md`](../lessons/testing/001-blind-assertion-false-green.md)
- [`docs/lessons/testing/003-assert-expected-from-requirement-not-implementation.md`](../lessons/testing/003-assert-expected-from-requirement-not-implementation.md)
- `src/renderer/src/components/spawn-spec.ts` — example of an extracted pure core (100%)
