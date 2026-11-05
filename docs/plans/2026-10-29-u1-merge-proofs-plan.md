# U1 — Merge proofs (squash containment + stacked landing) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A worktree whose local tip is contained in a merged PR's head — and whose PR content provably reached the default branch, directly or through a merged stacked base — is strongly merged, so the autopilot cleans it instead of parking it in "Needs review".

**Architecture:** Two new facts are probed by the scanner shell and delivered to the pure classifier (ADR-0001: the classifier never probes): `tipInPrHead` and `prLandedInDefault`. `resolveFate` treats a `gh-merged` signal as strong when the tip equals the PR head (today) **or** when `tipInPrHead === true && prLandedInDefault === true` (new). `MergeSignal` does not change, so `MERGE_SIGNAL_OVERRIDES_ANCESTRY` needs no new decision.

**Tech Stack:** TypeScript (Electron main), vitest, git CLI, gh CLI.

**Spec:** `docs/specs/2026-10-29-autonomous-cleanup-design.md` — §4 U1, §7 C2, §9.

## Global Constraints

- English only in code, comments, tests, commit messages (CLAUDE.md language policy).
- `CHANGELOG.md` entry in the same change (`## 2026-10-29` → `### Fixed`).
- No network writes: never `git fetch`, never create refs. A PR head or merge commit absent from the local object store yields `null`, never `false` or `true`.
- Positive-only evidence: only `=== true` may strengthen a fate; `false` and `null` leave it exactly as today.
- Existing behavior of the `tip === headRefOid` path is unchanged (it does not check the base).
- Old gh cache entries lack the new fields: they must parse to `null` and the cache version must NOT be bumped (same reasoning as `headRefOid`, `scan-core.ts:139-145`).
- Gates before done: `npm run typecheck`, `npm run lint`, `npx vitest run`, `npm run build`.

## Review Focus

1. PR head commit missing locally (branch pushed from another machine, never fetched) → `tipInPrHead: null` → stays "Needs review". Pinned in Task 3.
2. Branch reused after its merge (new commits on top) → tip not contained → not strong. Pinned in Task 2.
3. Stacked base PR still OPEN or CLOSED, or a base whose own base is not the default branch → `prLandedInDefault` false/null → not strong. Pinned in Task 1.
4. A strongly merged worktree with tracked-dirty files still lands in review, not ready (strength never bypasses the dirty gate). Pinned in Task 2.
5. Pre-change gh cache entries (no `baseRefName` / `mergeCommit`) → nulls → exactly today's verdicts. Pinned in Task 1.

---

### Task 1: PR facts carry `baseRefName` and `mergeCommitOid`; pure landing rule

**Files:**

- Modify: `src/main/reaper/reaper-core.ts` (`PrFacts`, ~line 76; `BranchFacts`, ~line 90)
- Modify: `src/main/reaper/scan-core.ts` (PR parse, ~lines 120-160; new pure fn)
- Modify: `src/main/reaper/scanner-shell.ts` (`--json` field lists at ~325 and ~385)
- Test: `tests/reaper-scan-core.test.ts`

**Interfaces:**

- Produces:
  - `PrFacts.baseRefName: string | null`, `PrFacts.mergeCommitOid: string | null`
  - `BranchFacts.tipInPrHead: boolean | null`, `BranchFacts.prLandedInDefault: boolean | null` (wired as `null` in this task; Task 3 fills them)
  - `export function prLandedInDefault(pr: PrFacts, basePr: PrFacts | null, defaultBranch: string, mergeCommitInBaseHead: boolean | null): boolean | null` in `scan-core.ts`

- [ ] **Step 1: Write the failing tests** (`describe('prLandedInDefault')` and parse cases)

```ts
const base = (o: Partial<PrFacts> = {}): PrFacts => ({
  number: 97,
  state: 'MERGED',
  reviewDecision: null,
  ci: 'unknown',
  mergedAt: 'x',
  headRefOid: 'basehead',
  baseRefName: 'main',
  mergeCommitOid: 'm97',
  ...o
})
const child = (o: Partial<PrFacts> = {}): PrFacts =>
  base({
    number: 84,
    headRefOid: 'h84',
    baseRefName: 'feat/agent-terminals',
    mergeCommitOid: 'm84',
    ...o
  })

it('true when the PR merged straight into the default branch', () =>
  expect(prLandedInDefault(child({ baseRefName: 'main' }), null, 'main', null)).toBe(true))
it('true when merged into a stacked base whose PR merged into default and contains the merge commit', () =>
  expect(prLandedInDefault(child(), base(), 'main', true)).toBe(true))
it('false when the base PR is OPEN or CLOSED', () => {
  expect(prLandedInDefault(child(), base({ state: 'OPEN' }), 'main', true)).toBe(false)
  expect(prLandedInDefault(child(), base({ state: 'CLOSED' }), 'main', true)).toBe(false)
})
it('false when the base head does not contain the merge commit', () =>
  expect(prLandedInDefault(child(), base(), 'main', false)).toBe(false))
it('null for an unknown base PR, a two-hop base, unknown containment, or a non-MERGED PR', () => {
  expect(prLandedInDefault(child(), null, 'main', true)).toBeNull()
  expect(prLandedInDefault(child(), base({ baseRefName: 'feat/other' }), 'main', true)).toBeNull()
  expect(prLandedInDefault(child(), base(), 'main', null)).toBeNull()
  expect(prLandedInDefault(child({ state: 'OPEN' }), base(), 'main', true)).toBeNull()
})
it('parses baseRefName and mergeCommit.oid, null when absent (old cache entries)', () => {
  // feed parseGhPrListResult one entry with { baseRefName: 'main', mergeCommit: { oid: 'abc' } }
  // and one without both fields; expect { baseRefName: 'main', mergeCommitOid: 'abc' } and { null, null }
})
```

- [ ] **Step 2: Run to verify they fail**
      Run: `npx vitest run tests/reaper-scan-core.test.ts`
      Expected: FAIL — `prLandedInDefault` not exported / fields undefined.

- [ ] **Step 3: Implement**
  - Add the two `PrFacts` fields (doc comment: "null when gh did not supply it — an entry cached before U1; degrades to today's verdicts") and the two `BranchFacts` fields (doc comment: positive-only evidence, computed by the scanner).
  - In the PR parse (`scan-core.ts` ~145) read `raw.baseRefName` (non-empty string) and `raw.mergeCommit?.oid` (non-empty string), else `null`.
  - Add `mergeCommit` to the bulk `--json` list (`scanner-shell.ts` ~385) and `baseRefName,mergeCommit` to `lookupPrForBranch` (~325).
  - `prLandedInDefault`: `pr.state !== 'MERGED'` → null; `pr.baseRefName === defaultBranch` → true; `basePr === null` → null; `basePr.state !== 'MERGED'` → false; `basePr.baseRefName !== defaultBranch` → null; else return `mergeCommitInBaseHead`.
  - Every `BranchFacts` literal in `scan-core.ts` (~699, ~728, ~759) and every test `facts()` helper gets `tipInPrHead: null, prLandedInDefault: null`.

- [ ] **Step 4: Run to verify they pass**
      Run: `npx vitest run tests/reaper-scan-core.test.ts tests/gc-fate-core.test.ts && npm run typecheck:node`
      Expected: PASS, no type errors.

- [ ] **Step 5: Commit**
      `git commit -m "feat(gc): carry PR base and merge commit into branch facts (U1)"`

### Task 2: `resolveFate` — containment makes a merged PR strong

**Files:**

- Modify: `src/main/gc/fate-core.ts:82-92` (`resolveFate`) and its header comment (`:70-80`)
- Test: `tests/gc-fate-core.test.ts`; `tests/` bundle-core bucket test (the file that tests `bucketOf` — grep `bucketOf` in `tests/`)

**Interfaces:**

- Consumes: `BranchFacts.tipInPrHead`, `BranchFacts.prLandedInDefault` (Task 1).
- Produces: no new exports; `FateResult.strong` semantics extended.

- [ ] **Step 1: Write the failing tests**

```ts
it('strong when the merged PR head contains the local tip and the content landed', () =>
  expect(
    resolveFate(
      facts({ pr: pr({ headRefOid: 'newer' }), tipInPrHead: true, prLandedInDefault: true }),
      TIP
    )
  ).toEqual({ fate: 'merged', signal: 'gh-merged', strong: true }))
it('weak when containment is unknown or false (head missing locally, branch reused after merge)', () => {
  expect(
    resolveFate(
      facts({ pr: pr({ headRefOid: 'newer' }), tipInPrHead: null, prLandedInDefault: true }),
      TIP
    ).strong
  ).toBe(false)
  expect(
    resolveFate(
      facts({ pr: pr({ headRefOid: 'newer' }), tipInPrHead: false, prLandedInDefault: true }),
      TIP
    ).strong
  ).toBe(false)
})
it('weak when the stacked base never landed', () =>
  expect(
    resolveFate(
      facts({ pr: pr({ headRefOid: 'newer' }), tipInPrHead: true, prLandedInDefault: false }),
      TIP
    ).strong
  ).toBe(false))
it('the tip === head path is unchanged and ignores the new facts', () =>
  expect(
    resolveFate(facts({ pr: pr(), tipInPrHead: null, prLandedInDefault: null }), TIP).strong
  ).toBe(true))
it('an upstream-unverified PR never becomes strong through containment', () =>
  expect(
    resolveFate(
      facts({
        pr: pr({ headRefOid: 'newer' }),
        prProvenance: 'upstream-unverified',
        tipInPrHead: true,
        prLandedInDefault: true
      }),
      TIP
    ).fate
  ).not.toBe('merged'))
// bundle-core: a strongly merged (containment) worktree with trackedDirty: true buckets 'review', not 'ready'
```

- [ ] **Step 2: Run to verify they fail**
      Run: `npx vitest run tests/gc-fate-core.test.ts`
      Expected: FAIL on the first and third cases (strong is false / true respectively).

- [ ] **Step 3: Implement** — in `resolveFate`, `strong` gains one disjunct:
      `(signal === 'gh-merged' && f.tipInPrHead === true && f.prLandedInDefault === true)`. Update the header comment's rule list (strong = git-local proof, gh-merged with head === tip, or gh-merged with tip contained in head and landing proven).

- [ ] **Step 4: Run to verify they pass**
      Run: `npx vitest run tests/gc-fate-core.test.ts tests/` + the bundle test file
      Expected: PASS; existing fate tests unchanged.

- [ ] **Step 5: Commit**
      `git commit -m "feat(gc): a merged PR whose head contains the tip is strong proof (U1)"`

### Task 3: Scanner probes the two facts

**Files:**

- Modify: `src/main/reaper/scanner-shell.ts` (new probe next to `probeSquashEquivalence`, ~line 584; call site ~767; pass into the scan-core input ~795)
- Modify: `src/main/reaper/scan-core.ts` (`RepoScanInput` gets `tipInPrHeadByBranch: Map<string, boolean | null>` and `prLandedByBranch: Map<string, boolean | null>`; the three `BranchFacts` literals read them with `?? null`)
- Test: `tests/reaper-scan-core.test.ts`

**Interfaces:**

- Consumes: `prLandedInDefault` (Task 1), `revParse`/`runFile`/`GIT_OPTS` already in `scanner-shell.ts`.
- Produces: `async function probeMergedPrContainment(repoPath: string, defaultBranch: string, refs: LocalBranchRef[], prByBranch: Map<string, PrFacts>): Promise<{ tipInPrHead: Map<string, boolean | null>; landed: Map<string, boolean | null> }>`

- [ ] **Step 1: Write the failing test** — scan-core builds `BranchFacts` from the new input maps: a worktree whose branch is in `tipInPrHeadByBranch` (true) and `prLandedByBranch` (true) gets both facts `true`; a branch absent from the maps gets `null` for both.

- [ ] **Step 2: Run to verify it fails**
      Run: `npx vitest run tests/reaper-scan-core.test.ts`
      Expected: FAIL — facts are `null`.

- [ ] **Step 3: Implement `probeMergedPrContainment`** — candidates only: branch has a MERGED PR with a non-null `headRefOid !== ref.sha` (the equal case is already strong). Per candidate:
  - `git cat-file -e <headRefOid>^{commit}`; failure → both `null`.
  - `git merge-base --is-ancestor <ref.sha> <headRefOid>` → exit 0 `true`, exit 1 `false`, anything else `null`.
  - Landing: `basePr = prByBranch.get(pr.baseRefName)` (null when absent or `baseRefName` null); when `pr.baseRefName !== defaultBranch`, `basePr` merged, and both `pr.mergeCommitOid` and `basePr.headRefOid` exist locally, run `merge-base --is-ancestor <mergeCommitOid> <basePr.headRefOid>` for `mergeCommitInBaseHead`; then `prLandedInDefault(...)`.
  - Memoize per `(repoPath, ref.sha, headRefOid)` like `squashProbeCache`. Never fetch.
    Wire both maps into the scan-core input.

- [ ] **Step 4: Run to verify it passes, then the full gates**
      Run: `npx vitest run && npm run typecheck && npm run lint`
      Expected: all PASS.

- [ ] **Step 5: Live verification (isolated instance, never the operator's)**
      Follow `docs/dev/live-verify-second-instance.md` with `--user-data-dir=/tmp/harnu-verify` (autopilot is off in a fresh userData). Call `list_cleanup` for this repo over CDP and confirm:
      `card/T537-…`, `fix/gc-archives-trash`, `fix/gc-guided-actions`, `fix/gc-orphans` → bucket `ready`; the 9 `feat/t474-*` / `refactor/t474-b0` → still `review` (`weak-merge-signal`); `card/BUG-217-…` → still `review`. Tear down only the PIDs you started.

- [ ] **Step 6: CHANGELOG + commit**
      `CHANGELOG.md`, `## 2026-10-29` → `### Fixed`: "Cleanup now recognizes a worktree as merged when its PR was squash-merged after more commits were pushed from elsewhere, so it can be cleaned instead of waiting in Needs review." If `docs/user/` describes "weakly proven" merges, adjust that sentence.
      `git commit -m "feat(reaper): probe merged-PR containment and stacked landing (U1)"`

---

## Out of this plan (later units, one plan each)

- **U2 Shelve/restore + Archived sidebar section** — needs a `design.md` §6 entry and mockup first (D-B), the ignored-files snapshot, the resume hook in `pty.ts`, and the orphan-transcript exclusion (C3). Planned after U1 lands.
- **U3 Docker park/garbage/capacity** and **U4 digest + stranded-work alert** — planned after U2; U3's park depends on U2's "shelved" state.
