# Mission v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Mission feature tell the truth about progress, make operator-owned waits loud, and let a normal orchestration reach `closed` honestly.

**Architecture:** Five stacked slices on one branch each (S1 → S2 → S3 → S4 → S5, each PR based on the branch below).

- **S1** changes the main-process mission rules and the MCP ACK shapes.
- **S2 and S3** change renderer derivation and the cue. Each lives behind a pure function in `src/renderer/src/lib/`, so it can be unit-tested.
- **S4** rewrites the bundled skills and adds behavior-eval scenarios.
- **S5** amends the T358 spec and the ADR.

No new dependencies.

**Tech Stack:** Electron + TypeScript main process, Vue 3 + Pinia + vue-i18n@11 renderer, vitest, the repo's local CI (`scripts/ci/local-pipeline.sh`).

**Spec:** `.capy/out/t373-mission-v2/spec.md` (revision 2). Executors read it before starting. It is untracked, so S1's first commit copies it to `docs/specs/2026-09-29-mission-v2/spec.md` and later slices read it from there.

## Global Constraints

**Repo contracts (CLAUDE.md)**

- `design.md` is edited BEFORE any renderer change. Tokens only: no raw colors or sizes.
- Every new i18n key goes into BOTH `src/renderer/src/i18n/en.json` and `pt-BR.json` in the same commit.
- Every behavior change adds a dated `CHANGELOG.md` entry under `## 2026-09-29` (or the day it lands).
- Any change to `src/main/mcp/tool-catalog.ts` or an ACK shape updates `docs/capy-features.md` and bumps its `<!-- capy-features vN -->` marker. Any MCP verb change updates `docs/user/agent-control.md`.
- English only everywhere outside the i18n files. No client identifiers.

**Merge bar and toolchain**

- The merge bar is `scripts/ci/local-pipeline.sh --base <branch below>` green. GitHub Actions never runs on this repo.
- Node comes from mise: prefix `PATH="$(ls -d ~/.local/share/mise/installs/node/*/bin | tail -1):$PATH"`.
- The RTK shell proxy can garble output. When a result looks empty, redirect it to a file and Read the file, or run the binary via node (`node node_modules/vitest/vitest.mjs run <file>`).

**Behavior rules from the spec**

- The fixed end keeps `verification: 'verifier'`. Custom steps keep the independent-session rule unchanged.
- The stall formula (T358 design §8) is NOT changed.
- Dispatch is NOT gated on mission status.

## Review Focus

- **A legacy/imported mission, or one with zero custom steps.** The end must stay `self-verified` and the close must be refused, with no crash on an empty author set. Test in Task 1.2.
- **A `scope` path that is a symlink resolving outside the repo, or `../..`.** It must be refused at create. It must never be linked or reported as proven. Test in Task 1.4.
- **App restart with two missions already owed.** Exactly one combined cue; no cue per mission and no cue on every 20 s poll. Test in Task 3.1.
- **A draft mission that gets approved while the popover is open.** The counter must not jump backwards: draft already counts done steps. Test in Task 2.1.
- **An owner that raises an operator blocker and clears it inside one 20 s poll window.** No cue fires for a blocker the operator never saw, and no stale re-nudge follows. Test in Task 3.1 (a transition seen only when it survives to a poll).

---

## Slice S1 — core rules and MCP (branch `feat/t373-s1-mission-core`, base `origin/main`)

### Task 1.1: Commit the spec

**Files:**

- Create: `docs/specs/2026-09-29-mission-v2/spec.md` (copy of `.capy/out/t373-mission-v2/spec.md`)

- [ ] **Step 1:** Copy the file verbatim, commit `docs(mission): add the Mission v2 spec`.

### Task 1.2: The fixed end's author set

**Files:**

- Modify: `src/main/mcp/tool-handlers.ts:3714-3717` (`verificationLabel`) and its call at `:3748`
- Test: `tests/mission-handlers.test.ts` (existing suite; change the pinned cases at `:1317-1343` and `:1449-1450`)

**Interfaces:**

- Produces: `verificationLabel(mission: Mission, step: MissionStep, callerId: string): 'verified' | 'self-verified'`

- [ ] **Step 1: Write the failing tests** (add to `tests/mission-handlers.test.ts`, in the `mission_verify_step` describe block, using the suite's existing helpers for creating a mission and calling handlers — read the top of the file for their names)

```ts
it('verifies the fixed end as verified when the caller built no step', async () => {
  // mission with one custom step linked to session EXEC, owner OWNER verifies stp-3 then the end
  const { missionId, endId } = await seedMissionWithCustomStep({ childSession: EXEC })
  await verify(missionId, 'stp-3', OWNER, 'met')
  const ack = await verify(missionId, endId, OWNER, 'met')
  expect(ack.proof).toBe('verified')
})

it('keeps the fixed end self-verified when the caller built a step', async () => {
  const { missionId, endId } = await seedMissionWithCustomStep({ childSession: EXEC })
  const ack = await verify(missionId, endId, EXEC, 'met')
  expect(ack.proof).toBe('self-verified')
})

it('keeps the fixed end self-verified when no step has a session link', async () => {
  const { missionId, endId } = await seedMissionWithCustomStep({ childSession: null })
  const ack = await verify(missionId, endId, OWNER, 'met')
  expect(ack.proof).toBe('self-verified')
})
```

If the helpers `seedMissionWithCustomStep` / `verify` do not exist, write them at the top of the new describe block, composing the suite's existing `mission_create` / `mission_add_step` / `mission_link_child` / `mission_verify_step` handler calls. The call shapes are in `tool-catalog.ts`.

- [ ] **Step 2: Run the tests, expect FAIL.** `node node_modules/vitest/vitest.mjs run tests/mission-handlers.test.ts -t "fixed end"`. The first case returns `self-verified`.

- [ ] **Step 3: Implement**

```ts
/**
 * design §1.3 / §13 Resolved A — `verified` only when the step has at least one
 * author session and the DECLARED caller id is none of them; otherwise
 * `self-verified`. A custom step's authors are its own `session` links. The
 * fixed end is built by the whole mission, so its authors are every custom
 * step's `session` links (Mission v2 §3.5) — the owner, who built none, lands
 * `verified`; with no author at all the end stays `self-verified`.
 */
function verificationLabel(
  mission: Mission,
  step: MissionStep,
  callerId: string
): 'verified' | 'self-verified' {
  const sources =
    step.kind === 'fixed-end' ? mission.steps.filter((s) => s.kind === 'custom') : [step]
  const authors = sources.flatMap((s) =>
    s.links.filter((l) => l.kind === 'session').map((l) => l.ref)
  )
  return authors.length > 0 && !authors.includes(callerId) ? 'verified' : 'self-verified'
}
```

Change the call to `verificationLabel(m, step, callerId)`.

- [ ] **Step 4: Update the pinned cases** at `:1317-1343` and `:1449-1450`. They assert that the owner's end-verify is `self-verified` without custom session links; keep that expectation where the seed has no session link, and flip it only where the seed links a child.

- [ ] **Step 5: Run the whole mission suite, expect PASS.** `node node_modules/vitest/vitest.mjs run tests/mission-*.test.ts`

- [ ] **Step 6: Commit** `feat(mission): verify the fixed end against every session that built a step`

### Task 1.3: `closeReadiness` and the re-scope refusal

**Files:**

- Modify: `src/main/mission-core.ts` (add `requestCloseRefusal` beside `closeRefusal`, `:508`)
- Modify: `src/main/mcp/tool-handlers.ts:3763-3799` (`missionRequestCloseHandler` uses it), `:3308-3319` (`missionGetHandler` adds `closeReadiness`)
- Test: `tests/mission-core.test.ts`, `tests/mission-handlers.test.ts`

**Interfaces:**

- Produces: `requestCloseRefusal(mission: Mission): { code: 'MISSION_DRAFT' | 'MISSION_CLOSED' | 'END_NOT_VERIFIED' | 'OPEN_BLOCKERS' | 'RESCOPE_PENDING'; reason: string } | null`
- Produces: `mission_get` ACK field `closeReadiness: null | { code, reason }`

- [ ] **Step 1: Write the failing core tests** in `tests/mission-core.test.ts`, using the file's existing mission factory:

```ts
describe('requestCloseRefusal', () => {
  it('refuses a draft', () => {
    expect(requestCloseRefusal(mission({ status: 'draft' }))?.code).toBe('MISSION_DRAFT')
  })
  it('refuses an end that is not verified', () => {
    expect(
      requestCloseRefusal(mission({ status: 'active', endProof: 'self-verified' }))?.code
    ).toBe('END_NOT_VERIFIED')
  })
  it('refuses open blockers', () => {
    expect(
      requestCloseRefusal(mission({ status: 'active', endProof: 'verified', blockers: 1 }))?.code
    ).toBe('OPEN_BLOCKERS')
  })
  it('refuses a staged re-scope', () => {
    expect(
      requestCloseRefusal(mission({ status: 'active', endProof: 'verified', pendingRescope: true }))
        ?.code
    ).toBe('RESCOPE_PENDING')
  })
  it('allows a verified end with nothing open', () => {
    expect(requestCloseRefusal(mission({ status: 'active', endProof: 'verified' }))).toBeNull()
  })
})
```

The factory keys (`endProof`, `blockers`, `pendingRescope`) are illustrative. Adapt them to the factory's real options, or build the mission literal inline from `fixedFrame()`.

- [ ] **Step 2: Run, expect FAIL** (`requestCloseRefusal` is not exported).

- [ ] **Step 3: Implement** in `mission-core.ts`:

```ts
/**
 * What `mission_request_close` would refuse right now (Mission v2 §3.5) — the
 * same checks, in the same order, so `mission_get.closeReadiness` and the verb
 * can never disagree. `null` = a request would land `delivered` + `pendingClose`.
 */
export function requestCloseRefusal(mission: Mission): {
  code:
    'MISSION_DRAFT' | 'MISSION_CLOSED' | 'END_NOT_VERIFIED' | 'OPEN_BLOCKERS' | 'RESCOPE_PENDING'
  reason: string
} | null {
  if (mission.status === 'draft') {
    return {
      code: 'MISSION_DRAFT',
      reason: `mission ${mission.id} is still draft — the operator never approved it into active, so there is nothing to close yet.`
    }
  }
  if (mission.status === 'closed') {
    return { code: 'MISSION_CLOSED', reason: `mission ${mission.id} is already closed.` }
  }
  const end = fixedEndStep(mission)
  if (end?.proof !== 'verified') {
    return {
      code: 'END_NOT_VERIFIED',
      reason: `the fixed end (${end?.id ?? 'missing'}) is ${end?.proof ?? 'missing'} — verify it with mission_verify_step from a session that built none of the steps.`
    }
  }
  const open = openBlockerCount(mission)
  if (open > 0) {
    return {
      code: 'OPEN_BLOCKERS',
      reason: `mission ${mission.id} has ${open} open blocker(s) — clear them with mission_clear_blocker first.`
    }
  }
  if (mission.pendingRescope) {
    return {
      code: 'RESCOPE_PENDING',
      reason: 'a re-scope is staged — the operator approves or rejects it first.'
    }
  }
  return null
}
```

In `missionRequestCloseHandler`, replace the inline checks with:

```ts
const refused = requestCloseRefusal(m)
if (refused) return { ok: false, error: `${refused.code}: ${refused.reason}` }
```

In `missionGetHandler`'s ACK, after `you`, add `closeReadiness: requestCloseRefusal(mission)`.

- [ ] **Step 4: Add a handler test.** `mission_get.closeReadiness` equals the error code that `mission_request_close` returns for the same mission, for the draft, self-verified-end and staged-re-scope cases. Also check that `request_close` now refuses `RESCOPE_PENDING`.

- [ ] **Step 5: Run the mission suites, expect PASS.** Fix any test that pinned the old error text. The codes are unchanged except the new `RESCOPE_PENDING` / `MISSION_CLOSED`.

- [ ] **Step 6: Commit** `feat(mission): report close readiness on mission_get and refuse a close over a staged re-scope`

### Task 1.4: `scope` on `mission_create`

**Files:**

- Modify: `src/main/mcp/tool-handlers.ts:2540-2601` (`missionCreateHandler`), `:3054` (existence error text)
- Modify: `src/main/mcp/tool-catalog.ts` (the `mission_create` schema: add `scope`; the `mission_link_child` text around `:1385` says a path link may point at any file or directory in the repo)
- Test: `tests/mission-handlers.test.ts`, `tests/mission-verbs-contract.test.ts` (the contract suite checks the schema)

**Interfaces:**

- Consumes: `fixedFrame()` from `mission-core.ts` (the fixed start is `steps[0]`, `kind: 'fixed-start'`)
- Produces: `mission_create` arg `scope?: string[]`, stored as `{ kind: 'worktree', ref: <repo-relative path> }` links on the fixed start

- [ ] **Step 1: Write the failing tests:**

```ts
it('links scope paths to the fixed start and proves it', async () => {
  writeRepoFile('docs/spec.md', '# spec')
  const created = await createMission({ scope: ['docs/spec.md'] })
  const got = await getMission(created.missionId)
  const start = got.mission.steps.find((s) => s.kind === 'fixed-start')
  expect(start.links).toEqual([{ kind: 'worktree', ref: 'docs/spec.md' }])
  expect(got.derived.steps.find((s) => s.stepId === start.id).existence.proven).toBe(true)
})

it.each([['../outside.md'], ['/etc/hostname'], ['link-out']])(
  'refuses a scope path outside the repo: %s',
  async (p) => {
    symlinkRepoPath('link-out', os.tmpdir()) // a symlink escaping the repo
    const res = await createMissionRaw({ scope: [p] })
    expect(res.isError).toBe(true)
    expect(res.text).toMatch(/^BAD_SCOPE_PATH/)
  }
)
```

Use the suite's existing temp-repo helpers. If none exists for writing files or symlinks, use `fs.writeFileSync` / `fs.symlinkSync` under the test repo root.

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement.** In `missionCreateHandler`, after `declaredEnd`, read `args.scope`. When present:
  - require `string[]`, at most 20 entries, each non-empty;
  - for each entry, `const abs = path.resolve(root, p)`;
  - refuse unless `abs === root || abs.startsWith(root + path.sep)`;
  - if the path exists, `const real = await fs.realpath(abs)` and refuse unless `real` is inside `await fs.realpath(root)`;
  - store `path.relative(root, abs)`;
  - error text: `BAD_SCOPE_PATH: "<p>" is outside this repo — scope paths are repo-relative files or directories.`

Pass the links into the fixed frame:

```ts
steps: fixedFrame().map((s) => (s.kind === 'fixed-start' ? { ...s, links: scopeLinks } : s)),
```

Change the `existenceOf` empty-links reason to `'no artifact link (a path in the repo, a card or a PR) to check'`.

- [ ] **Step 4: Add `scope` to the catalog schema.** Use `z.array(z.string().min(1)).max(20).optional()` and a description: "Repo-relative paths of the documents that fix the scope (spec, PRD, ADR). They are linked to the fixed start 'Scope confirmed', which Capy proves by checking they exist." Update the `mission_link_child` link-kind text as described above. Then run `tests/mission-verbs-contract.test.ts`.

- [ ] **Step 5: Run the mission suites, expect PASS. Commit** `feat(mission): link the scope documents to the fixed start at creation`

### Task 1.5: PR base and the child-state wording

**Files:**

- Modify: `src/main/mcp/tool-handlers.ts:2964-2985` (`MissionPrSummary`, `prSummary`), `:3003-3010` and `:3199-3210` (the `pr` link signal)
- Modify: `src/main/mcp/tool-catalog.ts` (the `mission_get` description)
- Test: `tests/mission-handlers.test.ts` (the derived-signals block that already stubs `findPrsForWorktrees`)

**Interfaces:**

- Consumes: `PrEntry.baseRefName` (`src/main/pr-stack.ts:81`)
- Produces: `MissionPrSummary.baseRefName: string`, `pr` link signal `baseRefName?: string`

- [ ] **Step 1: Failing test.** With the stubbed join returning `{ number: 5, state: 'MERGED', baseRefName: 'stack/w2-base', … }`, `derived.steps[i].links` for a `pr` link to `#5` carries `baseRefName: 'stack/w2-base'`, and the same PR summarized under a worktree link carries it too.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Add `baseRefName: p.baseRefName` to `prSummary`, and `baseRefName: pr.baseRefName` to the `pr` branch of `resolve`.
- [ ] **Step 4: Update the `mission_get` description.** Append: "Each child carries `taskState` (what the session is doing: working / idle / needs-input …) and `status` (the sidebar row's state) — read `taskState` to know whether it is working. `closeReadiness` is what `mission_request_close` would refuse right now, or `null`."
- [ ] **Step 5: Docs for the whole slice.**
  - `docs/capy-features.md`: `scope` on create, `closeReadiness`, the fixed end's author rule, `baseRefName`, the `taskState` note. Bump the marker by one.
  - `docs/user/agent-control.md`: the same, in plain prose.
  - `CHANGELOG.md` `### Changed`: "Missions can now be closed after a normal orchestration: the orchestrator's verification of the final step counts when it built none of the steps." `### Added`: "`mission_create` takes the scope documents and proves "Scope confirmed" from them; `mission_get` says whether a close would be accepted."
- [ ] **Step 6: Run the full suite and the local pipeline** `scripts/ci/local-pipeline.sh --base origin/main`, expect green. **Commit** `feat(mission): report each PR's base branch and document the S1 verbs`

---

## Slice S2 — progress truth and honest approval in the UI (branch `feat/t373-s2-mission-ui`, base S1)

### Task 2.1: Counter = done steps, draft keeps its progress

**Files:**

- Modify: `design.md`:
  - Mission pill in §6: the counter reads "{done} of {total} done";
  - the draft rows at `:5143-5144`: draft shows real progress, with the copy below.
- Modify: `src/renderer/src/lib/mission-view.ts:58-73` (`MissionModel`), `:136-160` (`buildMissionModel`)
- Modify: `src/renderer/src/components/MissionPill.vue:101`, `MissionPopover.vue:47-48`, `SidebarFolder.vue:424, :917`
- Modify: `src/renderer/src/i18n/en.json` + `pt-BR.json` (`mission` block, `:2990`)
- Test: `tests/mission-view.test.ts` (flip `:191` and `:214`)

**Interfaces:**

- Produces: `MissionModel.doneCount: number` (the count of `done[]`). `stepIndex` stays: it is the position of the current step, used by the rail only.

- [ ] **Step 1: Edit design.md first** as described in "Files" and commit it with the code at the end of the task.

- [ ] **Step 2: Failing tests** in `tests/mission-view.test.ts`:

```ts
it('counts done steps, not the first open position', () => {
  const view = viewWith({
    status: 'active',
    proofs: ['unproven', 'verified', 'verified', 'unproven']
  }) // fixed start unproven
  expect(buildMissionModel(view, NOW).doneCount).toBe(2)
})
it('counts done steps in draft too', () => {
  const view = viewWith({ status: 'draft', proofs: ['unproven', 'verified', 'unproven'] })
  const model = buildMissionModel(view, NOW)
  expect(model.doneCount).toBe(1)
  expect(model.steps[1].done).toBe(true)
})
it('counts a delivered mission as all done', () => {
  const view = viewWith({
    status: 'delivered',
    proofs: ['verified', 'verified', 'verified'],
    existenceProven: true
  })
  expect(buildMissionModel(view, NOW).doneCount).toBe(3)
})
```

`viewWith` is illustrative. Reuse the file's existing view factory and pass the step proofs through it.

- [ ] **Step 3: Run, expect FAIL.**

- [ ] **Step 4: Implement** in `buildMissionModel`:
  - `const done = m.steps.map((s) => stepDone(view, s))` (drop `!draft &&`);
  - keep `currentIdx = draft ? -1 : firstOpen` (draft still has no current step);
  - add `doneCount: done.filter(Boolean).length` to the returned model and the interface.

- [ ] **Step 5: i18n.**
  - Replace `"pill": "Step {n} of {m}"` with `"pill": "{done} of {total} done"`.
  - Remove `countDraft`.
  - Change `sub.draft` to "Not approved yet — progress is tracked; the end is not agreed".
  - Change `draftCallout.body` to "Approve the declared end below. Work may already be running — approving agrees the end, it does not start anything."
  - Add `draftCallout.endLabel` = "Declared end".
  - Add the matching pt-BR translations to `pt-BR.json`.

- [ ] **Step 6: Consumers.**
  - `MissionPill.vue:101` and `MissionPopover.vue:47-48` use `t('mission.pill', { done: model.doneCount, total: model.stepTotal })`, with no draft branch.
  - `SidebarFolder.vue:424` uses the same key with `done`.
  - `SidebarFolder.vue:917` shows `{{ missionOf(s)!.doneCount }}/{{ missionOf(s)!.stepTotal }}`.

- [ ] **Step 7: Run the renderer tests and `npm run typecheck`, expect PASS. Commit** `feat(mission): count done steps in the pill and keep progress visible in draft`

### Task 2.2: Show the declared end in the approval callout

**Files:**

- Modify: `design.md` §6 Mission popover: the draft callout shows `kind · target` and the evidence line above the Approve button
- Modify: `src/renderer/src/components/MissionPopover.vue:140-160` (the draft callout)
- Test: the component test for `MissionPopover` if one exists (`tests/mission-popover*.test.ts`), else `tests/mission-view.test.ts`, plus a new check that no renderer string claims nothing runs

- [ ] **Step 1: Failing test.** Add a test (in the renderer i18n test file, or a new `tests/mission-copy.test.ts`) that reads both locale JSONs and asserts that no string under `mission` matches `/nothing runs|nada roda/i`. If a popover component test exists, also assert that the draft callout renders `mission.declaredEnd.target`.
- [ ] **Step 2: Run, expect FAIL** (only if Task 2.1 was skipped; otherwise the copy test already passes, and the component assertion fails).
- [ ] **Step 3: Implement.** Inside the draft callout, above the Approve button, render `$t('mission.draftCallout.endLabel')` and `{{ view.mission.declaredEnd.kind }} · {{ view.mission.declaredEnd.target }}` (`text-text-2`), plus the evidence on a second line (`text-text-3`). Use the existing typography classes from the popover's end-step block; do not invent new sizes.
- [ ] **Step 4: Visual proof.** Launch an isolated instance per `docs/dev/live-verify-second-instance.md`.
  - Unset `CLAUDE_CODE_CHILD_SESSION CLAUDECODE CLAUDE_CODE_SESSION_ID CLAUDE_CODE_MESSAGING_SOCKET` first.
  - Seed a draft mission with one verified step and capture the popover. Attach the capture to the PR.
  - Tear down only the processes you started.
- [ ] **Step 5: `CHANGELOG.md` `### Changed`:** "The mission pill counts finished steps ("3 of 10 done") and keeps counting while the mission awaits approval; the approval callout shows the end you are agreeing to." Run the local pipeline against the S1 branch. **Commit** `feat(mission): show the declared end in the approval callout`

---

## Slice S3 — owed-to-operator cue (branch `feat/t373-s3-mission-cue`, base S2)

### Task 3.1: Pure cue decision

**Files:**

- Create: `src/renderer/src/lib/mission-cue.ts`
- Test: `tests/mission-cue.test.ts`

**Interfaces:**

- Consumes: `MissionView` (`src/main/mission-ipc.ts`), `view.you.kind`, `view.mission.status`, `view.mission.blockers` / step blockers
- Produces:

```ts
export const RENUDGE_MS = 30 * 60 * 1000
export type OwedKey = string // `${kind}:${detail}` — a new key = a new thing owed
export interface CueMemory {
  owed: Map<string, { key: OwedKey; firstOwedAt: number; lastCuedAt: number }>
  primed: boolean
}
export interface CueDecision {
  cue: boolean
  missionIds: string[]
  memory: CueMemory
}
export function owedKey(view: MissionView): OwedKey | null
export function decideCue(
  views: readonly MissionView[],
  memory: CueMemory,
  now: number
): CueDecision
```

- [ ] **Step 1: Failing tests:**

```ts
import { decideCue, owedKey, RENUDGE_MS, type CueMemory } from '../src/renderer/src/lib/mission-cue'

const empty = (): CueMemory => ({ owed: new Map(), primed: false })
const T0 = 1_790_000_000_000

describe('owedKey', () => {
  it('is null when nothing is owed or only approvals/needs-input are owed', () => {
    expect(owedKey(view({ you: { kind: 'clear' } }))).toBeNull()
    expect(owedKey(view({ you: { kind: 'approvals', count: 1, sessionId: 's' } }))).toBeNull()
    expect(owedKey(view({ you: { kind: 'needs-input', sessionId: 's' } }))).toBeNull()
  })
  it('keys an operator blocker by its reason, a draft, a re-scope and a close', () => {
    expect(
      owedKey(view({ you: { kind: 'blocker', reason: 'merge #6', unblocks: 'merged' } }))
    ).toBe('blocker:merge #6')
    expect(owedKey(view({ status: 'draft', you: { kind: 'clear' } }))).toBe('draft')
    expect(owedKey(view({ you: { kind: 'rescope', end: END } }))).toBe(`rescope:${END.target}`)
    expect(owedKey(view({ you: { kind: 'close' } }))).toBe('close')
  })
})

describe('decideCue', () => {
  it('gives one combined cue on the first poll when missions are already owed', () => {
    const d = decideCue([owedView('a', 'draft'), owedView('b', 'close')], empty(), T0)
    expect(d.cue).toBe(true)
    expect(d.missionIds.sort()).toEqual(['a', 'b'])
    expect(d.memory.primed).toBe(true)
  })
  it('does not cue again on the next poll', () => {
    const first = decideCue([owedView('a', 'draft')], empty(), T0)
    expect(decideCue([owedView('a', 'draft')], first.memory, T0 + 20_000).cue).toBe(false)
  })
  it('cues a new owed item after priming', () => {
    const first = decideCue([], empty(), T0)
    const d = decideCue([owedView('a', 'blocker:merge')], first.memory, T0 + 20_000)
    expect(d).toMatchObject({ cue: true, missionIds: ['a'] })
  })
  it('cues when the owed item changes on the same mission', () => {
    const first = decideCue([owedView('a', 'blocker:merge #1')], empty(), T0)
    expect(decideCue([owedView('a', 'blocker:merge #2')], first.memory, T0 + 20_000).cue).toBe(true)
  })
  it('re-nudges after RENUDGE_MS while unchanged, then waits another RENUDGE_MS', () => {
    const first = decideCue([owedView('a', 'close')], empty(), T0)
    const second = decideCue([owedView('a', 'close')], first.memory, T0 + RENUDGE_MS + 1)
    expect(second.cue).toBe(true)
    expect(decideCue([owedView('a', 'close')], second.memory, T0 + RENUDGE_MS + 20_000).cue).toBe(
      false
    )
  })
  it('forgets an item that is no longer owed, so a later one cues fresh', () => {
    const first = decideCue([owedView('a', 'blocker:x')], empty(), T0)
    const cleared = decideCue([], first.memory, T0 + 20_000)
    expect(cleared.memory.owed.has('a')).toBe(false)
  })
})
```

Write the `view` / `owedView` factories at the top of the test file. They build a minimal `MissionView` (`mission: { id, status }`, `you`, and an empty `derived`) cast to `MissionView`.

- [ ] **Step 2: Run, expect FAIL** (the module does not exist).

- [ ] **Step 3: Implement** `mission-cue.ts`:

```ts
/**
 * Mission v2 §3.4 — decide when the operator must HEAR that a mission owes them
 * something. Pure: the store feeds it each poll's views and keeps the memory.
 * Approvals and needs-input are left out on purpose — the Approval Inbox and
 * the task-state notifications already chime for them.
 */
import type { MissionView } from '../../../main/mission-ipc'

export const RENUDGE_MS = 30 * 60 * 1000
export type OwedKey = string
export interface CueMemory {
  owed: Map<string, { key: OwedKey; firstOwedAt: number; lastCuedAt: number }>
  primed: boolean
}
export interface CueDecision {
  cue: boolean
  missionIds: string[]
  memory: CueMemory
}

export function owedKey(view: MissionView): OwedKey | null {
  const you = view.you
  if (you.kind === 'blocker') return `blocker:${you.reason}`
  if (you.kind === 'rescope') return `rescope:${you.end.target}`
  if (you.kind === 'close') return 'close'
  if (view.mission.status === 'draft') return 'draft'
  return null
}

export function decideCue(
  views: readonly MissionView[],
  memory: CueMemory,
  now: number
): CueDecision {
  const next = new Map<string, { key: OwedKey; firstOwedAt: number; lastCuedAt: number }>()
  const cueIds: string[] = []
  for (const v of views) {
    const key = owedKey(v)
    if (!key) continue
    const prev = memory.owed.get(v.mission.id)
    if (!prev || prev.key !== key) {
      next.set(v.mission.id, { key, firstOwedAt: now, lastCuedAt: now })
      cueIds.push(v.mission.id)
    } else if (now - prev.lastCuedAt > RENUDGE_MS) {
      next.set(v.mission.id, { ...prev, lastCuedAt: now })
      cueIds.push(v.mission.id)
    } else {
      next.set(v.mission.id, prev)
    }
  }
  return { cue: cueIds.length > 0, missionIds: cueIds, memory: { owed: next, primed: true } }
}
```

(On the first poll, `memory.owed` is empty, so every owed mission lands in one combined decision. That is the restart rule: one cue, many ids.)

- [ ] **Step 4: Run, expect PASS. Commit** `feat(mission): decide when a mission's debt to the operator should be heard`

### Task 3.2: Wire the cue into the store

**Files:**

- Modify: `design.md`, next to "Safety confirms — sound + attention" (`:618`). A mission that starts owing the operator a merge, key, decision, re-scope approval, close or draft approval plays the confirm chime, requests OS attention and posts one Activity entry. It repeats every 30 min while unchanged. Approvals and needs-input are excluded (they already chime).
- Modify: `src/renderer/src/stores/missions.ts:32-41` (`load`)
- Modify: `src/renderer/src/i18n/en.json` + `pt-BR.json`:
  - `mission.cue.one` = "Mission “{title}” needs you: {what}"
  - `mission.cue.many` = "{n} missions need you"
- Test: `tests/missions-store.test.ts` (create, if absent, with a Pinia test instance and a stubbed `window.api`)

**Interfaces:**

- Consumes: `decideCue`, `CueMemory` (Task 3.1); `playNotificationSound` (`src/renderer/src/lib/notification-sound`); `window.api.requestAttention()`. For Activity, find how the renderer posts an Activity entry today: grep `stores/` for `activity` / `pushActivity`. Use that function; if it lives only in main, add nothing new and cue sound + attention only (then say so in the PR).

- [ ] **Step 1: Failing store test.**
  - Stub `window.api.missionList` to return one draft view, then run `refresh()`.
  - Expect `playNotificationSound` (mocked with `vi.mock('../src/renderer/src/lib/notification-sound')`) called once, and `requestAttention` once.
  - Run `refresh()` again with the same view: still once.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** In `load()`, after `views.value = res.views`:

```ts
const decision = decideCue(res.views, cueMemory, Date.now())
cueMemory = decision.memory
if (decision.cue) {
  playNotificationSound()
  void window.api.requestAttention()
  postMissionActivity(decision.missionIds, res.views) // the Activity entry via the existing renderer path
}
```

`let cueMemory: CueMemory = { owed: new Map(), primed: false }` lives in the store closure. `postMissionActivity` builds the `mission.cue.one` / `.many` text. `{what}` is the `you` line's reason for a blocker, and the state label (`mission.state.*`) otherwise.

- [ ] **Step 4: Run the renderer tests + `npm run typecheck`, expect PASS.**
- [ ] **Step 5: Manual check** in an isolated instance (same env unset as Task 2.2). Seed a mission with an operator blocker via `mission_set_blocker`: one chime, then silence on the next polls. Note the result in the PR.
- [ ] **Step 6: `CHANGELOG.md` `### Added`:** "When a mission is waiting on you — a merge, a key, a decision, an approval of its end or its close — Capy plays the confirm chime, asks for your attention and reminds you every 30 minutes until it is handled." Run the local pipeline against the S2 branch. **Commit** `feat(mission): chime and ask for attention when a mission waits on the operator`

---

## Slice S4 — skills and behavior evals (branch `feat/t373-s4-mission-skills`, base S3)

### Task 4.1: Skill rules

**Files:**

- Modify: `resources/skills/skills/orchestrate-delivery/SKILL.md`:
  - Phase 1 (`:42-77`);
  - the "Stacked units" part of Phase 2 (`:219-230`);
  - Phase 3 mission paragraph (`:238-249`);
  - Phase 4 end paragraph (`:427-429`).
- Modify: `resources/skills/skills/mission/SKILL.md`:
  - `:50-55` (approval wording);
  - the blocker row / rule near `:279`;
  - the `mission done` section `:386-391`.
- Modify: `resources/skills/skills/delivery-verifier/SKILL.md:215`
- Test: `tests/bundled-skills*.test.ts` (whatever pins skill content, e.g. frontmatter / staging), plus Task 4.2's evals

- [ ] **Step 1: `orchestrate-delivery`:**
  - Move `mission_create` into **Phase 1**, after the topology line and before any dispatch. Text:
    > "Propose the declared end from the spec (kind, target, evidence) and confirm it with the operator in ONE AskUserQuestion — the proposal is the recommended option. Pass the spec / PRD / ADR paths as `scope`. Dispatch does not wait for the operator's Approve click; tell them the mission is in draft until they approve the end in the Topbar."
  - Remove the Phase 3 sentence "The mission is born `draft`: tell the operator it waits…" and keep the rest of Phase 3.
- [ ] **Step 2: `orchestrate-delivery`, new hard rule under "Resume — every turn re-arms":**
  > "**A turn that ends waiting on the operator raises a blocker.** Before you end a turn whose next move is the operator's — a merge, a key, a credential, a decision — call `mission_set_blocker { owner: 'operator', reason: '<what exactly>', unblocks: '<the observable event>' }`. Capy then chimes, asks for their attention and reminds them every 30 minutes. Clear it with `mission_clear_blocker` on the turn you see it done. Text in the transcript is not a signal: nobody reads it until they come back."
- [ ] **Step 3: `orchestrate-delivery`, stacked units.** Add a checklist step:
  > "Before handing merges to the operator, retarget every stacked PR whose base has landed: `gh pr edit <n> --base <default branch>`, then `gh pr view <n> --json baseRefName` to confirm. A merge into a stack base that never reaches the default branch is a second round-trip for the operator."
- [ ] **Step 4: `orchestrate-delivery`, rule change → `mission_set_end`:**
  > "When the operator changes how the delivery ends (merge policy, target branch, what counts as done), call `mission_set_end` in the same turn with the new end; the operator approves the re-scope in the Topbar."
- [ ] **Step 5: `orchestrate-delivery` Phase 4 end paragraph:**
  > "When every unit is verified and the end's evidence exists, verify the fixed end yourself with `mission_verify_step` (you built none of the steps, so it lands `verified`), read `closeReadiness` on `mission_get`, and call `mission_request_close`. The operator closes."
- [ ] **Step 6: `mission` skill:**
  - Replace `:53-55`'s "never tell the operator it is running before they approved it" with: "Dispatch may run before approval — say so, and say the end still needs their Approve in the Topbar."
  - Add the operator-blocker rule (Step 2 wording) next to the blocker row at `:279`.
  - Add the `mission_set_end` rule (Step 4).
  - Rewrite `mission done` (`:386-391`) to the Step 5 flow.
- [ ] **Step 7: `delivery-verifier:215`.** The fixed end is verified by the orchestrator (a session that built no step) after the per-unit verdicts; `closeReadiness` tells whether the close will land.
- [ ] **Step 8: Run the skill-related tests + `npm test`, expect PASS. Commit** `feat(skills): agree the end up front, flag operator waits, retarget stacks and close missions`

### Task 4.2: Behavior-eval scenarios

**Files:**

- Modify: `scripts/eval/mission-behavior/` (read its README / scenario files first; follow the existing scenario format exactly)

- [ ] **Step 1: Add four scenarios**, each graded only from `.capy/missions/*.md` (the harness's rule):
  1. **operator-wait:** the owner is told "PR #1 is open; the operator must merge it" → grade: an open blocker with `owner: operator`.
  2. **rule-change:** after creation, the operator says "every phase becomes a stacked PR, you never merge" → grade: the stored end differs from the original and `pendingRescope` is set.
  3. **close-end-to-end:** one custom step linked to a child session, verified by the owner; the owner is asked to finish → grade: the end is `verified` and `status: delivered` with `pendingClose`.
  4. **end-before-dispatch:** the owner orchestrates a two-unit objective → grade: the mission file's `createdAt` precedes every child link's first appearance in the log, and `fixed-start` carries at least one scope link.
- [ ] **Step 2: Add a deliberately broken copy per grader** (the harness's convention) and confirm each grader catches it.
- [ ] **Step 3: Run `npm run eval:mission`** (it uses real `claude -p`: tell the operator the cost before running, and run it once). Record the pass/fail table in the PR. Run the local pipeline. **Commit** `test(eval): cover operator waits, end re-scope, close and end-before-dispatch`

---

## Slice S5 — spec amendments (branch `feat/t373-s5-mission-docs`, base S4)

### Task 5.1: Amend the T358 spec and ADR

**Files:**

- Modify: `docs/specs/2026-09-26-mission-progress/design.md`:
  - §1.3: the fixed end's authors = every custom step's session links;
  - §3: `closeReadiness`, `RESCOPE_PENDING` on the request;
  - §10.2 / `:503`: the counter is done-count and draft shows progress.
  - Mark each amendment "Amended 2026-09-29 by Mission v2".
- Modify: `docs/adr/0015-*.md`: a dated note on the fixed end's author set and why (closability without a verbs-holding independent session).
- Modify: `docs/specs/2026-09-29-mission-v2/spec.md`: status → "implemented", with the slice PR numbers.

- [ ] **Step 1: Write the amendments.**
- [ ] **Step 2: Run the local pipeline** (format:check covers markdown). **Commit** `docs(mission): amend the T358 design and ADR-0015 for Mission v2`

---

## Execution notes for the orchestrator

- One Capy session per slice, stacked: each PR is based on the branch below.
- The executor commits and stands down; a separate shipper session opens the PR (never merges).
- A blind verifier grades the slice's ACs from the spec §5 mapping:

| Slice | ACs                    |
| ----- | ---------------------- |
| S1    | AC-3, AC-6, AC-7, AC-8 |
| S2    | AC-1, AC-2, AC-4       |
| S3    | AC-5                   |
| S4    | AC-9                   |
| all   | AC-10                  |

- Open questions Q1 (re-nudge interval) and Q2 (keep the fixed start) must be answered before S3 and S1, respectively. The plan assumes 30 min fixed and keep.
