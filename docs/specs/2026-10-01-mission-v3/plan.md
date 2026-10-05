# Mission v3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Mission UI and verbs answer "where is it, what is done, what is left, what is waiting on me" correctly and fast. Progress is computed once on the server and shown by position, not by proof.

**Architecture:**

- **S1** adds a pure progress module and reshapes the core and MCP layer: no draft, scope as attachment, checks, close/discard door, `you` list.
- **S2** makes reads fast and stable: parallel derive, PR cache, sticky link resolutions in a sidecar, doors that return the view.
- **S3** renders the server's numbers.
- **S4** aligns the skills, evals and docs.
- **S5** amends the earlier specs.

Each slice stacks on the one below.

**Tech Stack:** Electron main (TypeScript, zod, js-yaml), Vue 3 + Pinia + vue-i18n@11, vitest, the local CI `scripts/ci/local-pipeline.sh`.

**Spec:** `docs/specs/2026-10-01-mission-v3/spec.md` (rev 2), committed with this plan by Task 1.1 (scrubbed of client identifiers). Executors read both, plus `.capy/out/mission-monitor/findings.md` for evidence.

## Global Constraints

**Repo contracts:**

- `design.md` is edited BEFORE any renderer change. Tokens only.
- New i18n keys go in `en.json` AND `pt-BR.json` in the same commit.
- Every behavior change gets a `CHANGELOG.md` entry under the day it lands.
- Any change to `tool-catalog.ts` or to an ACK updates `docs/capy-features.md`, bumps its marker by one, and updates `docs/user/agent-control.md`.
- English only. No client identifiers: no client repo names, tracker ids or client paths in committed files. Use the neutral vocabulary in CLAUDE.md.

**Process:**

- Merge bar: `scripts/ci/local-pipeline.sh --base <branch below>` green.
- Node via mise: `export PATH="$(ls -d ~/.local/share/mise/installs/node/*/bin | tail -1):$PATH"`.
- The RTK shell proxy can garble output. Redirect to a file and Read it, or run `node node_modules/vitest/vitest.mjs run <file>`.

**Model invariants (spec):**

- The headline is "Step N of M": N = the current step, a range when parallel, ✓ only when all done.
- Proof never sets N.
- Legacy files must keep parsing: `draft` stays in the status enum; the fixed-start step stays on disk.
- Reads never write the mission file.

## Review Focus

- **A mission whose ONLY open step sits before the last done step** (the tools-listing case: end verified, sign-off open). It must read "Step M of M" with no ✓ and list the open step as left behind. Test in Task 1.2.
- **A legacy draft that is dead** (no children, last write days ago). After normalization it is `active` + stale. It must produce no cue and no `you` item, and must stay discardable. Test in Task 1.4 and Task 3.4.
- **A door clicked twice quickly** (double Close). The second call must be a no-op or `MISSION_CLOSED`, never a crash or a resurrected view. Test in Task 2.3.
- **GitHub unreachable for a mission never resolved before** (a cold cache). Links read `unknown` (unproven, `stale: true`). Nothing in the cache is written as a downgrade. Test in Task 2.2.
- **An operator check label duplicating a verifier check label** (different case). Exactly one check per step, and the source stays the first creator's. Test in Task 1.5.

---

## Slice S1 — core + MCP (branch `feat/t381-s1-mission-core`, base `origin/main`)

### Task 1.1: Commit the spec and plan (scrubbed)

**Files:**

- Create: `docs/specs/2026-10-01-mission-v3/spec.md`
- Create: `docs/specs/2026-10-01-mission-v3/plan.md`

- [ ] **Step 1:** Copy both files. In the copies, replace every client-identifying string with the neutral vocabulary: client repo names, tracker ids, client paths, mission titles that name client features. For example, a client feature title becomes "proj FAQ section", and a tracker id becomes "PROJ-231". Keep every number and shape. Then run `node node_modules/vitest/vitest.mjs run tests/no-client-identifiers.test.ts`; it must pass.
- [ ] **Step 2:** Commit `docs(mission): add the Mission v3 spec and plan`.

### Task 1.2: The progress module (pure)

**Files:**

- Create: `src/main/mission-progress.ts`
- Test: `tests/mission-progress.test.ts`
- Create: `tests/fixtures/mission-v3/*.json` (the operator-reviewed fixtures below)

**Interfaces:**

- Consumes: `Mission`, `MissionStep` from `src/main/mission-core.ts`; `MissionChildState` from `src/main/mcp/fleet-snapshot.ts`.
- Produces:

  ```ts
  export type StepState = 'verified' | 'done' | 'running' | 'waiting' | 'blocked' | 'todo'
  export interface StepSignalsLite {
    stepId: string
    children: Pick<MissionChildState, 'sessionId' | 'taskState'>[]
    existenceProven: boolean
  }
  export interface MissionProgress {
    total: number
    current: { from: number; to: number } | null
    allDone: boolean
    done: number
    verified: number
    states: Record<string, StepState>
    leftBehind: string[]
    unprovable: string[]
    computedAt: string
  }
  export function computeProgress(
    mission: Mission,
    signals: StepSignalsLite[],
    now: number
  ): MissionProgress
  export function progressHeadline(p: MissionProgress): {
    kind: 'single' | 'range' | 'done'
    n: number
    to: number
    m: number
  }
  ```

- [ ] **Step 1: Write the fixtures.** These are the operator-reviewed expected values (spec §8 S-1, rev 2), with neutral titles. Each fixture is `{ name, mission, signals, expect }`, where `mission.steps` carries only the fields `computeProgress` reads: `id`, `kind`, `verification`, `proof`, `verifiedBy`, `blockers`, `links`, `addedAt`. Leading `fixed-start` = a legacy fixed start (excluded from progress).

  | name                                          | steps after the legacy fixed start (state per step)                                                                                        | expect                                                                       |
  | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
  | `faq-like`                                    | verified · todo (existence, no links) · verified ×5 · todo (human) · todo (fixed-end)                                                      | `current {8,8}`, M 9, done 6, verified 6, leftBehind [2nd], unprovable [2nd] |
  | `hero-like`                                   | waiting (session link, idle) · todo (human) · verified · verified · done (claimed) · verified · verified · todo (human) · todo (fixed-end) | `current {8,8}`, M 9, done 5, verified 4, leftBehind [2nd]                   |
  | `tools-listing-like`                          | verified ×3 · todo (human sign-off) · verified (fixed-end)                                                                                 | `current {5,5}`, allDone false, leftBehind [4th]                             |
  | `blocked-like`                                | verified ×4 · blocked · todo · todo                                                                                                        | `current {5,5}`, M 7                                                         |
  | `delivered`                                   | verified ×5 (incl. fixed-end)                                                                                                              | `current null`, allDone true                                                 |
  | `self-verified-all`                           | done ×10 (self-verified met)                                                                                                               | allDone true, verified 0, done 10                                            |
  | `nothing`                                     | todo ×6                                                                                                                                    | `current {1,1}`, done 0                                                      |
  | `proven-start` (fixed start proven, excluded) | verified · done · todo (fixed-end)                                                                                                         | `current {3,3}`, M 3                                                         |
  | `parallel`                                    | verified ×3 · running ×4 (child working) · todo · todo (fixed-end)                                                                         | `current {4,7}`                                                              |
  | `blocked-future`                              | verified ×2 · todo · todo · todo · todo · todo · blocked · todo (fixed-end)                                                                | `current {3,3}` (blocked does not advance)                                   |
  | `owner-only-working`                          | verified · todo (only link = owner session, working) · todo                                                                                | step 2 `todo`, `current {2,2}`                                               |
  | `added-mid-flight`                            | verified · todo (addedAt AFTER the 3rd's verifiedBy.at) · verified · todo                                                                  | leftBehind []                                                                |
  | `needs-human`                                 | verified · (verifiedBy.verdict needs-human, proof self-verified) · todo                                                                    | step 2 `done`, `current {3,3}`                                               |

- [ ] **Step 2: Write the failing test.**

  ```ts
  import { readdirSync, readFileSync } from 'node:fs'
  import path from 'node:path'
  import { describe, expect, it } from 'vitest'
  import { computeProgress, progressHeadline } from '../src/main/mission-progress'

  const dir = path.join(__dirname, 'fixtures/mission-v3')
  const fixtures = readdirSync(dir).map((f) => JSON.parse(readFileSync(path.join(dir, f), 'utf8')))

  describe('computeProgress — operator-reviewed fixtures (spec §8 S-1)', () => {
    it.each(fixtures.map((f) => [f.name, f]))('%s', (_n, f) => {
      const p = computeProgress(f.mission, f.signals, Date.parse('2026-10-01T12:00:00Z'))
      expect({
        current: p.current,
        allDone: p.allDone,
        total: p.total,
        done: p.done,
        verified: p.verified,
        leftBehind: p.leftBehind,
        unprovable: p.unprovable
      }).toMatchObject(f.expect)
    })
  })

  describe('progressHeadline', () => {
    it('is a range for parallel, done for allDone, single otherwise', () => {
      const base = {
        total: 9,
        done: 0,
        verified: 0,
        states: {},
        leftBehind: [],
        unprovable: [],
        computedAt: ''
      }
      expect(
        progressHeadline({ ...base, current: { from: 4, to: 7 }, allDone: false })
      ).toMatchObject({ kind: 'range', n: 4, to: 7, m: 9 })
      expect(progressHeadline({ ...base, current: null, allDone: true })).toMatchObject({
        kind: 'done',
        n: 9,
        m: 9
      })
      expect(
        progressHeadline({ ...base, current: { from: 8, to: 8 }, allDone: false })
      ).toMatchObject({ kind: 'single', n: 8, m: 9 })
    })
  })
  ```

- [ ] **Step 3: Run it, expect FAIL** (module missing).

- [ ] **Step 4: Implement** `src/main/mission-progress.ts`:

  ```ts
  /**
   * Mission v3 §3.1 — the ONE progress computation. Pure; every surface (pill,
   * chip, mission_get, mission_list, skills) renders its output and never recounts.
   */
  import type { Mission, MissionStep } from './mission-core'
  import type { MissionChildState } from './mcp/fleet-snapshot'

  export type StepState = 'verified' | 'done' | 'running' | 'waiting' | 'blocked' | 'todo'
  export interface StepSignalsLite {
    stepId: string
    children: Pick<MissionChildState, 'sessionId' | 'taskState'>[]
    existenceProven: boolean
  }
  export interface MissionProgress {
    total: number
    current: { from: number; to: number } | null
    allDone: boolean
    done: number
    verified: number
    states: Record<string, StepState>
    leftBehind: string[]
    unprovable: string[]
    computedAt: string
  }

  const OPERATOR = 'operator'

  function stepState(
    step: MissionStep,
    sig: StepSignalsLite | undefined,
    owner: string
  ): StepState {
    const by = step.verifiedBy
    if (
      step.proof === 'verified' ||
      (step.verification === 'existence' && sig?.existenceProven) ||
      (step.verification === 'human' && step.proof === 'verified' && by?.sessionId === OPERATOR)
    )
      return 'verified'
    if (
      step.proof === 'claimed' ||
      (step.proof === 'self-verified' && by?.verdict === 'met') ||
      by?.verdict === 'needs-human'
    )
      return 'done'
    const builders = (sig?.children ?? []).filter((c) => c.sessionId !== owner)
    if (builders.some((c) => c.taskState === 'working')) return 'running'
    if (step.blockers.length > 0) return 'blocked'
    if (builders.length > 0) return 'waiting'
    return 'todo'
  }

  const isDone = (s: StepState): boolean => s === 'verified' || s === 'done'

  export function computeProgress(
    mission: Mission,
    signals: StepSignalsLite[],
    now: number
  ): MissionProgress {
    const sig = new Map(signals.map((s) => [s.stepId, s]))
    const steps = mission.steps.filter((s) => s.kind !== 'fixed-start')
    const st = steps.map((s) => stepState(s, sig.get(s.id), mission.owner.sessionId))
    const lastDone = st.map(isDone).lastIndexOf(true)
    const lastDoneAt = lastDone >= 0 ? Date.parse(steps[lastDone].verifiedBy?.at ?? '') : NaN
    const running = st.flatMap((s, i) => (s === 'running' ? [i] : []))
    const allDone = steps.length > 0 && st.every(isDone)
    let current: MissionProgress['current'] = null
    if (!allDone) {
      if (running.length > 0)
        current = { from: running[0] + 1, to: running[running.length - 1] + 1 }
      else {
        let i = st.findIndex((s, k) => k > lastDone && !isDone(s))
        if (i === -1) i = steps.length - 1
        current = { from: i + 1, to: i + 1 }
      }
    }
    const leftBehind = steps
      .filter((s, i) => {
        if (i >= lastDone || st[i] !== 'todo') return false
        const added = Date.parse(s.addedAt ?? '')
        return !(Number.isFinite(added) && Number.isFinite(lastDoneAt) && added > lastDoneAt)
      })
      .map((s) => s.id)
    const reachedOrCurrent = (i: number): boolean => i <= Math.max(lastDone, (current?.to ?? 0) - 1)
    const unprovable = steps
      .filter(
        (s, i) =>
          s.verification === 'existence' &&
          reachedOrCurrent(i) &&
          !s.links.some((l) => l.kind !== 'session')
      )
      .map((s) => s.id)
    return {
      total: steps.length,
      current,
      allDone,
      done: st.filter(isDone).length,
      verified: st.filter((s) => s === 'verified').length,
      states: Object.fromEntries(steps.map((s, i) => [s.id, st[i]])),
      leftBehind,
      unprovable,
      computedAt: new Date(now).toISOString()
    }
  }

  export function progressHeadline(p: MissionProgress): {
    kind: 'single' | 'range' | 'done'
    n: number
    to: number
    m: number
  } {
    if (p.allDone || !p.current) return { kind: 'done', n: p.total, to: p.total, m: p.total }
    return {
      kind: p.current.from === p.current.to ? 'single' : 'range',
      n: p.current.from,
      to: p.current.to,
      m: p.total
    }
  }
  ```

  `addedAt` lands on `MissionStep` in Task 1.3. Until then, type it as `(s as MissionStep & { addedAt?: string }).addedAt`, or do Task 1.3's schema step first.

- [ ] **Step 5: Run, expect PASS.** Commit `feat(mission): compute progress once, by position (Mission v3 §3.1)`.

### Task 1.3: Schema — scope, checks, closedAs, addedAt, via, passthrough, draft normalization

**Files:**

- Modify: `src/main/mission-core.ts` (types around `:56-120`, zod `:123-185`, `parseMissionFile`)
- Test: `tests/mission-core.test.ts`

**Interfaces — produces on `Mission` / `MissionStep`:**

- `scope?: StepLink[]`
- `closedAs?: 'delivered' | 'discarded'`
- `closeReason?: string`
- `declaredEndApproval?: { at; bodyHash; via?: 'chat' | 'operator' }`
- `MissionStep.checks?: Check[]`
- `MissionStep.addedAt?: string`
- `export interface Check { id: string; label: string; source: 'agent' | 'operator' | 'verifier'; createdAt: string; ticked?: { at: string } }`
- `export function missionScope(m: Mission): StepLink[]`: `m.scope` if set, else the legacy fixed-start step's links.

- [ ] **Step 1: Failing tests:**
  - (a) A file with `status: draft` parses as `status: 'active'`.
  - (b) A file with an unknown top-level key, step key or link key round-trips through `parseMissionFile` → `serializeMission` and still contains that key (passthrough).
  - (c) `checks`, `scope`, `closedAs`, `addedAt` and `via` round-trip.
  - (d) `missionScope` returns the legacy fixed-start links when `scope` is absent.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement:**
  - Add the fields and zod schemas.
  - Add `.passthrough()` on `MissionSchema`, `MissionStepSchema`, `StepLinkSchema`, `BlockerSchema` and the new `CheckSchema`.
  - In `parseMissionFile`, after a successful parse: `if (m.status === 'draft') m.status = 'active'`.
  - Keep `'draft'` in the enum.
- [ ] **Step 4:** Run `tests/mission-*.test.ts`. Fix the tests that pin `draft` after parse; list them in the commit body.
- [ ] **Step 5: Commit** `feat(mission): v3 schema — scope, checks, close outcome, passthrough; read legacy drafts as active`.

### Task 1.4: Create, reason rule, scope links, import — no draft, no fixed start

**Files:**

- Modify: `src/main/mcp/tool-handlers.ts`:
  - `missionCreateHandler` `:2540+`;
  - `fixedFrame` use;
  - `missionAddStepHandler` (`REASON_REQUIRED` at `~:3682`);
  - `missionLinkChildHandler`;
  - `missionImportLegacyHandler` `~:2955-2970`.
- Modify: `src/main/mission-core.ts` (`fixedFrame()` → end-only for new missions)
- Modify: `src/main/mcp/tool-catalog.ts` (`mission_create.steps`, `mission_add_step.links`, `mission_link_child.scope`)
- Test: `tests/mission-handlers.test.ts`, `tests/mission-verbs-contract.test.ts`

**Interfaces:**

- `mission_create { …, scope?, steps?: { title: string; verification: 'existence' | 'verifier' | 'human' }[] }` writes:
  - `status: 'active'`;
  - `declaredEndApproval: { at: now, bodyHash, via: 'chat' }`;
  - the given steps followed by the fixed end;
  - `scope` on the mission;
  - no fixed start.
- `isStarted(m: Mission): boolean`: any step has a non-scope link OR a proof ≠ `unproven`.
- `mission_add_step` requires `reason` only when `isStarted(m)`. It sets `addedAt: now` always and `addedReason` only when started. It accepts `links?: StepLink[]`; worktree links on a fixed start go through `checkScopePath`.
- `mission_link_child { scope: true, link }` (no `stepId`) appends to `mission.scope` via `checkScopePath`.
- `mission_import_legacy` writes `active`, no fixed frame, the legacy scope into `scope`, and keeps `legacy.needsReview`.

- [ ] **Step 1: Failing tests:**
  - (a) `create` → `active`, `via: 'chat'`, `steps.length === given + 1`, no `fixed-start`.
  - (b) Steps given at create carry no `addedReason`.
  - (c) `add_step` without a reason succeeds before start; is refused `REASON_REQUIRED` after a child link; stores `addedAt`.
  - (d) `link_child { scope: true }` appends a contained path; is refused `BAD_SCOPE_PATH` for `.git` or outside paths.
  - (e) `import_legacy` → `active`, no fixed-start step, `needsReview` kept.
  - (f) The contract suite schema accepts `steps` / `links` / `scope`.
- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement.**
- [ ] **Step 4:** Run the mission suites and fix the pinned draft/fixed-frame assertions (`mission-handlers.test.ts:~1000` reason rule, the frame tests). Then update the catalog text, `docs/capy-features.md` (bump the marker), `docs/user/agent-control.md` and CHANGELOG: "Missions start active; the end you agree in chat is the agreement".
- [ ] **Step 5: Commit** `feat(mission): missions are born active with their plan; scope is an attachment`.

### Task 1.5: Checks — verb, needs-human, operator doors

**Files:**

- Modify: `src/main/mission-core.ts`. Add:
  - `applyAddCheck(m, stepId, label, source, at)`;
  - `applyTickCheck(m, stepId, checkId, { at, ticked })`;
  - `applyDeleteCheck(m, stepId, checkId)`.
- Modify: `src/main/mcp/tool-handlers.ts`:
  - new `missionAddCheckHandler`;
  - `missionVerifyStepHandler` `:~3719`: `needs-human` keeps `proof` = label, stores the verdict, and adds a check from `checkLabel ?? first line of evidence`.
- Modify: `src/main/mcp/tool-catalog.ts` (new `mission_add_check`; `mission_verify_step.checkLabel`)
- Modify: `src/main/mission-ipc.ts` (doors `addCheck`, `tickCheck`, `deleteCheck`)
- Test: `tests/mission-handlers.test.ts`, `tests/mission-operator-doors.test.ts`, `tests/mission-verbs-contract.test.ts`

**Interfaces:**

- `mission_add_check { folder, missionId, stepId, label }` → `{ ok, stepId, checks }`. Refused `MISSION_CLOSED` on closed missions.
- Doors: `{ door: 'addCheck', stepId, label } | { door: 'tickCheck', stepId, checkId, ticked: boolean } | { door: 'deleteCheck', stepId, checkId }`.
- Label dedupe: case-insensitive per step. The first creator's `source` wins.

- [ ] **Step 1: Failing tests:**
  - (a) The agent verb adds a check with `source: 'agent'`.
  - (b) The same label in different case is stored once (Review Focus).
  - (c) `verify_step` with `needs-human` → the check exists with `source: 'verifier'`, and `computeProgress` reads the step as `done`.
  - (d) A later `met` verify leaves the check unticked.
  - (e) No MCP verb or arg writes `ticked`: the contract suite asserts there is no `ticked` in any input schema.
  - (f) The operator doors tick, untick and delete; the agent has no delete.
- [ ] **Step 2: Run, expect FAIL. Step 3: Implement.**
- [ ] **Step 4:** Update docs (capy-features: `mission_add_check`, the `needs-human` → check behavior, "only the operator ticks"). Run the suites.
- [ ] **Step 5: Commit** `feat(mission): human checks — agent, verifier and operator create them; only the operator ticks`.

### Task 1.6: Close / discard door, closeWarnings, request_close without draft, MISSION_CLOSED

**Files:**

- Modify: `src/main/mission-core.ts`:
  - replace `applyOperatorApprove` / `applyOperatorClose` with `applyOperatorEnd(m, { at, closedAs, reason? })`;
  - `closeWarnings(m, progress): CloseWarning[]`;
  - `requestCloseRefusal` loses `MISSION_DRAFT`.
- Modify: `src/main/mission-ipc.ts`:
  - door `end` replaces `approve` / `close`;
  - `MissionView.closeWarnings` replaces `closeRefusal`;
  - the view carries `progress`.
- Modify: `src/main/mcp/tool-handlers.ts`: `missionRequestCloseHandler`; `editMission` keeps refusing closed missions with `MISSION_CLOSED`.
- Test: `tests/mission-operator-doors.test.ts`, `tests/mission-ipc.test.ts`, `tests/mission-core.test.ts`

**Interfaces:**

- `CloseWarning = { kind: 'end-unverified' | 'left-behind' | 'checks-open' | 'blockers-open' | 'rescope-staged'; detail: string }`.
- `applyOperatorEnd` works on any non-closed mission. It sets `status: 'closed'`, `closedAs`, `closeReason?`, removes `pendingClose`, and appends a Log line (`### <at> · operator ended (<closedAs>)`).
- On an already-closed mission it throws `MISSION_CLOSED`. The door returns `{ ok: false, error }`, and the store treats it as a no-op (Review Focus: double Close).

- [ ] **Step 1: Failing tests:**
  - (a) The operator ends an active mission with an unverified end, a left-behind step, an open check and a blocker → closed; `closeWarnings` beforehand lists all four.
  - (b) Discard writes `closedAs: 'discarded'` + the reason.
  - (c) A second end → `MISSION_CLOSED`.
  - (d) An agent verb on a closed mission → `MISSION_CLOSED`.
  - (e) `request_close` works on a former draft (now active) and never returns `MISSION_DRAFT`.
  - (f) The IPC view has no `closeRefusal` and has `closeWarnings` + `progress`.
- [ ] **Step 2: Run, expect FAIL. Step 3: Implement. Step 4:** Update the pinned tests (`mission-operator-doors.test.ts:158-166`, `mission-ipc.test.ts:199`) and the docs.
- [ ] **Step 5: Commit** `feat(mission): one operator end door (close or discard) with warnings, never refusals`.

### Task 1.7: `you` list + progress on mission_get / mission_list

**Files:**

- Modify: `src/main/mcp/tool-handlers.ts`:
  - `youItem` / `youLine` (`~:2842-2875`) → `youItems(m, children, progress): YouItem[]` + `youLine(items)`;
  - `missionGetHandler` adds `derived.progress` and `you: string` + `youItems`;
  - `missionListHandler` adds `progress` from a module-level cache: `lastProgress: Map<missionId, MissionProgress>`, written by every derive and read by `mission_list`.
- Modify: `src/main/mission-ipc.ts` (the view carries `you: YouItem[]`)
- Modify: `src/main/mcp/tool-catalog.ts` (descriptions)
- Test: `tests/mission-handlers.test.ts`, `tests/mission-derived-signals.test.ts`, `tests/mission-verbs-contract.test.ts`

**Interfaces:**

```ts
type YouItem =
  | { kind: 'rescope'; end: DeclaredEnd }
  | { kind: 'close' }
  | { kind: 'blocker'; reason: string; unblocks: string }
  | { kind: 'checks'; count: number; stepIds: string[] }
  | { kind: 'human-steps'; stepIds: string[] }
  | { kind: 'review-import' }
  | { kind: 'approvals'; count: number; sessionId: string }
  | { kind: 'needs-input'; sessionId: string }
```

- Order as listed.
- **Due checks** = unticked checks on steps whose state ≠ `todo` / `blocked`.
- **`human-steps`** = `human` steps that are current or left behind and unticked.
- **`review-import`** = `legacy.needsReview` includes `'declaredEnd'`.

- [ ] **Step 1: Failing tests:**
  - (a) A mission with an operator blocker AND 2 due checks AND an unticked current human step → `you` has three items in order, and `youLine` reads the first + "(+2 more)".
  - (b) A dead legacy draft (no links, old `updatedAt`) → `you` is empty (Review Focus).
  - (c) `mission_list` rows carry `progress` after one `mission_get`, and are `progress: null` before any derive.
  - (d) `mission_get.derived.progress` equals `computeProgress` for the same input.
- [ ] **Step 2: Run, expect FAIL. Step 3: Implement. Step 4:** Docs (capy-features: `you` list, `progress`, `mission_list.progress` may lag one poll). Run the full suite, then `scripts/ci/local-pipeline.sh --base origin/main`.
- [ ] **Step 5: Commit** `feat(mission): a you-list and server-side progress on mission_get and mission_list`.

---

## Slice S2 — speed + sticky proof (branch `feat/t381-s2-mission-reads`, base S1)

### Task 2.1: Parallel `mission:list` + scan cache

**Files:**

- Modify: `src/main/mission-ipc.ts` (the list loop `~:91`)
- Create: `src/main/map-limit.ts`
- Test: `tests/mission-ipc.test.ts`, `tests/map-limit.test.ts`

**Interfaces:**

- `export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]>` (order-preserving).
- `scanFolders` is memoized for 10 s inside `mission-ipc.ts`.

- [ ] **Step 1: Failing tests:**
  - `mapLimit` never runs more than `limit` jobs at once and keeps order.
  - A `mission:list` over 9 stub missions, each derive taking 500 ms, completes in < 1.5 s.
- [ ] **Step 2–4:** Implement; replace the sequential `for … await deriveMissionSignals` with `mapLimit(…, 4, …)`; run.
- [ ] **Step 5: Commit** `perf(mission): derive missions in parallel for the list`.

### Task 2.2: Single-flight PR cache + sticky link resolutions

**Files:**

- Modify: `src/main/pr-stack.ts` (`findPrsForWorktrees` uses a per-root `fetchPrsCached(root)`: single-flight promise, 60 s TTL, failures not cached)
- Create: `src/main/mission-link-cache.ts`
- Modify: `src/main/mcp/tool-handlers.ts` (`resolve` in `deriveMissionSignals` `~:3174-3213`)
- Test: `tests/pr-stack.test.ts` (or the existing pr-stack test file), `tests/mission-link-cache.test.ts`, `tests/mission-derived-signals.test.ts`

**Interfaces:**

- `getLastKnown(root, kind, ref)`;
- `rememberResolved(root, kind, ref, { state, prNumber?, mergedAt? })`;
- persisted (debounced) to `<userData>/mission-link-cache.json`.

**Resolution rules:**

- `gh` unavailable, or PR not found → use last-known, set `stale: true`; never write a downgrade.
- A worktree path missing while a merged PR is known for its branch → stays resolved.
- Downgrade only on PR `CLOSED` and not merged.

- [ ] **Step 1: Failing tests:**
  - (a) Two concurrent `findPrsForWorktrees` for the same root call the `gh` stub once.
  - (b) A failure is not cached: the next call retries.
  - (c) A link resolved OPEN, then `gh` unavailable → still resolved, `stale: true`.
  - (d) PR not found after merged → stays proven.
  - (e) A cold cache + `gh` unavailable → unresolved + `stale: true`, and nothing is written to the sidecar (Review Focus).
  - (f) Closed-unmerged → downgrades.
  - (g) 10 consecutive `mission_get` calls leave the mission file's `updatedAt` and bytes unchanged.
- [ ] **Step 2–4:** Implement and run.
- [ ] **Step 5: Commit** `fix(mission): a link that resolved once survives an unreachable GitHub`.

### Task 2.3: Doors return the view

**Files:**

- Modify: `src/main/mission-ipc.ts` (`mission:operatorDoor` returns `{ ok: true, view: MissionView | null }`; `null` when closed)
- Test: `tests/mission-ipc.test.ts`

- [ ] **Step 1: Failing tests:**
  - A tick returns the re-derived view of that mission only, and does not call the full list.
  - `end` returns `view: null`.
  - A double `end` → the second returns `{ ok: false, error: 'MISSION_CLOSED…' }` (Review Focus).
- [ ] **Step 2–4:** Implement and run. Run `scripts/ci/local-pipeline.sh --base origin/feat/t381-s1-mission-core`.
- [ ] **Step 5: Commit** `perf(mission): operator doors answer with the mission they changed`.

---

## Slice S3 — renderer (branch `feat/t381-s3-mission-ui`, base S2)

### Task 3.1: design.md + i18n first

- [ ] **Step 1:** Edit `design.md` §6 "Mission progress":
  - the pill headline variants ("Step N of M", "Steps a–b of M", "Step M of M ✓");
  - the popover header line;
  - the seven step visuals, using existing tokens only (✓ filled `text-green`; ✓ hollow `text-text-3`; ● `anim-pulse-dot` accent; ◐ `text-text-3`; ⚠ `text-warning`; ○ `text-text-4`; ↩ `text-warning`);
  - the checks list (checkbox row, "+ check" input, delete on hover);
  - the end dialog (Close as delivered / Discard + reason + warnings list);
  - the go-to-session icon (lucide `LogIn`, replacing `ExternalLink`);
  - the chip tone equal to the pill tone (the `flagged` variant removed);
  - §8 copy.
- [ ] **Step 2:** Add the i18n keys in both locales:
  - `mission.headline.single|range|done`;
  - `mission.header.counts`, `mission.header.leftBehind`;
  - `mission.state.waiting`;
  - `mission.checks.add|placeholder|delete|due`;
  - `mission.end.title|asDelivered|asDiscarded|reason|warnings.*`;
  - `mission.you.more`;
  - `mission.child.goTo`, `mission.child.notLoaded`.

  Remove `mission.pill`, `draftCallout.*`, `sub.draft` and `state.draft`.

- [ ] **Step 3: Commit** `docs(design): Mission v3 progress, checks and end dialog`.

### Task 3.2: mission-view renders server progress

**Files:**

- Modify: `src/renderer/src/lib/mission-view.ts` (drop `stepDone` / `doneCount` / `stepIndex` recounting; build `StepModel`s from `view.progress.states` + `leftBehind`; drop draft from `missionState`; `flagged` removed)
- Test: `tests/mission-view.test.ts`

- [ ] **Step 1: Failing tests:** for each fixture of Task 1.2 (reuse the JSON), `buildMissionModel` yields:
  - the headline kind / n / m;
  - per-step visuals;
  - the left-behind marks;
  - the current marker on step `current.from`.

  The model's numbers equal `view.progress`, with no recount.

- [ ] **Step 2–4:** Implement; flip or remove the pinned v2 tests (`mission-view.test.ts:191, :214`, etc.).
- [ ] **Step 5: Commit** `feat(mission): the renderer shows the server's progress`.

### Task 3.3: Pill, chip, popover, rail, checks UI, go-to-session

**Files:**

- Modify: `MissionPill.vue`, `SidebarFolder.vue` (mission chip `:424`, `:917`), `MissionPopover.vue`, `MissionStepRail.vue`
- Test: `tests/mission-copy.test.ts` (mounted)

- [ ] **Step 1: Failing mounted tests:**
  - The `faq-like` fixture renders "Step 8 of 9" in the pill and the popover, and the chip reads "8/9" with the same tone class as the pill.
  - `parallel` renders "Steps 4–7 of 9".
  - `delivered` renders "Step 5 of 5" + ✓.
  - The checks UI ticks through `runDoor({door:'tickCheck'…})`.
  - A child row appears once (dedupe).
  - Go-to-session on an unknown id pushes a toast.
- [ ] **Step 2–4:** Implement; no draft callout; no Approve button.
- [ ] **Step 5: Commit** `feat(mission): pill, chip and popover read where the work is`.

### Task 3.4: End dialog + store patch-on-door + cue from the you-list

**Files:**

- Modify: `MissionCloseConfirmDialog.vue` → close/discard choice + reason + `closeWarnings`.
- Modify: `stores/missions.ts`:
  - `runDoor` catches errors → toast; on `view: null` removes the mission from `views`; on a view, patches it;
  - no `refreshAfterWrite` await in the door path.
- Modify: `lib/mission-cue.ts`:
  - keys from `you` items (`kind` + count);
  - cue on appear or grow only;
  - no draft kind.
- Test: `tests/missions-store.test.ts`, `tests/mission-cue.test.ts`, `tests/mission-close-confirm.test.ts`

- [ ] **Step 1: Failing tests:**
  - Confirming end removes the mission from the store before any list refresh, and the dialog unmounts within one tick.
  - An IPC rejection → toast + dialog closed.
  - The cue fires when due checks go 1 → 2, not when they go 2 → 1.
  - A dead legacy draft never cues (Review Focus).
  - Discard writes the reason.
- [ ] **Step 2–4:** Implement. Do a visual proof in an isolated instance: clean env, `env -u CLAUDE_CODE_CHILD_SESSION -u CLAUDECODE -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_MESSAGING_SOCKET`, `APPIMAGELAUNCHER_DISABLE=1` if launching an AppImage. Capture the pill and popover for `faq-like`, `parallel` and `delivered`, plus the end dialog with warnings. Save the captures under `docs/specs/2026-10-01-mission-v3/captures/`.
- [ ] **Step 5:** CHANGELOG + `docs/user/` mission page. Run `scripts/ci/local-pipeline.sh --base origin/feat/t381-s2-mission-reads`. Commit `feat(mission): end a mission from one dialog that closes at once; cue on new debts only`.

---

## Slice S4 — skills, evals, agent docs (branch `feat/t381-s4-mission-skills`, base S3)

### Task 4.1: Skills

**Files:**

- `resources/skills/skills/{status,mission,orchestrate-delivery,delivery-verifier,delivery-watchdog}/SKILL.md`
- tests pinning skill content (`tests/mission-v2-skills.test.ts` → extend into `mission-v3-skills.test.ts`)

- [ ] **Step 1: Failing grep tests:**
  - No skill mentions Approve, draft-approval or "Scope confirmed" as a step.
  - `status` names `derived.progress` and `you`, and has no "steps proven" recount.
  - `orchestrate-delivery` and `mission` carry:
    - "1 unit = 1 PR = 1 step";
    - "sign-offs become checks";
    - `mission_create { steps }`;
    - the proof-label rule;
    - "on MISSION_CLOSED stop the loop".
  - `delivery-verifier` says `needs-human` creates a check (`checkLabel`).
  - `delivery-watchdog` has no draft skip and reads `progress`.
- [ ] **Step 2–4:** Edit the skills. Fix the `status` duplicated-lines example.
- [ ] **Step 5: Commit** `feat(skills): render server progress, use checks for sign-offs, drop approval ceremony`.

### Task 4.2: Evals + shadow retirement

**Files:**

- `scripts/eval/mission-behavior/**`
- `scripts/eval/mission-behavior/divergence-checker.mjs` (delete)
- `tests/mission-divergence-checker.test.ts` (delete)
- `tests/mission-v2-eval-scenarios.test.ts` → v3

- [ ] **Step 1:** Rewrite every scenario that references draft, Approve or the fixed start. Add `signoff-as-check`: the owner told "the designer must sign off the section" adds a check on the section's step, and adds no new step. Keep every scenario's broken copies.
- [ ] **Step 2:** Remove the shadow dual-write and the divergence checker, plus their mentions in skills and docs. Close T371 in the PR text.
- [ ] **Step 3:** Run the offline grader tests. Run ONE full `npm run eval:mission -- --model sonnet` (~$1–2, operator-approved method) and record the table.
- [ ] **Step 4:** `docs/capy-features.md` (marker +1) and `docs/user/agent-control.md` are true to S1–S3. Run the local pipeline against S3.
- [ ] **Step 5: Commit** `test(eval): Mission v3 scenarios; retire the shadow mirror`.

---

## Slice S5 — amendments (branch `feat/t381-s5-mission-docs`, base S4)

### Task 5.1: Amend T358, v2 and ADR-0015

- [ ] **Step 1:** In `docs/specs/2026-09-26-mission-progress/design.md`, add "Amended 2026-10-01 by Mission v3" notes to:
  - decision 4 (fixed frame → end only + scope attachment);
  - decision 8 (proof is a detail, not the counter);
  - decision 14 (no start approval; the operator ends with close or discard);
  - §8 (unchanged formula, but legacy drafts now read active).

  In `docs/specs/2026-09-29-mission-v2/spec.md`, add a "superseded in part by v3" header listing §3.1, §3.2, §3.5 and the S3 draft cue.

  In ADR-0015, add a dated note: the approval model and the checks trust model.

- [ ] **Step 2:** Set `docs/specs/2026-10-01-mission-v3/spec.md` to status "implemented" with the slice PR numbers and a deviations list. Run the local pipeline.
- [ ] **Step 3: Commit** `docs(mission): amend T358, v2 and ADR-0015 for Mission v3`.

---

## Orchestration notes

**Method:** one Capy session per slice, stacked. Each executor commits and stands down; a separate shipper opens the PR against the branch below; blind per-AC verifiers grade it.

**AC map:**

| Slice | ACs                                              |
| ----- | ------------------------------------------------ |
| S1    | AC-1, AC-3, AC-4, AC-5 (core), AC-6, AC-9, AC-10 |
| S2    | AC-7, AC-8, AC-5 (door speed)                    |
| S3    | AC-2, AC-5 (UI)                                  |
| S4    | AC-11                                            |
| All   | AC-12                                            |

AC-1's expected values are the Task 1.2 fixture table, which the operator reviewed on 2026-10-01.
