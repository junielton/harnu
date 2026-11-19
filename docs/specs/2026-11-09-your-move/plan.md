# Your Move Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Anything only the operator can unblock becomes a persistent card in a global queue with a running clock, answerable from the card, and it leaves only when the operator has dealt with it.

**Architecture:** A main-process feature under `src/main/your-move/`: pure reducers over one atomically written JSON state, a transcript segment builder tagged by `origin.kind`, and an isolated Haiku judge that runs after a `Stop` hook has already been answered. Structured sources (missions, human-gating tools, deaths, judge failures, the `your_move` verb) write the same store. The renderer extends `SidebarReturnZone.vue` from that store; answers reuse the existing `session.userTurn` paste path and close only on the matching `UserPromptSubmit`.

**Tech Stack:** Electron main (Node), Vue 3, Pinia, Tailwind v4 tokens, vue-i18n 11, zod, vitest 2, the `claude` CLI in `-p` mode.

**Spec:** `docs/specs/2026-11-09-your-move/spec.md` and `design.md` beside it, committed on `feat/your-move`. Frozen gate v1 and the eval harness stay in `<main checkout>/.harnu/out/your-move/gate/` (gitignored).

## Global Constraints

- Stack of five PRs in order, U1 based on `feat/your-move` and each later one branched from the previous: `feat/your-move-u1-core` → `-u2-sources` → `-u3-agent` → `-u4-queue` → `-u5-reach`. U5 does not merge until the maintainer has reviewed a week of Observe cards and accepted the misses and the noise (spec "Rollout").
- Test shorthand used below: `T <file>` means `nice -n 19 npx vitest run <file> --maxWorkers=4`. Whole suite: `nice -n 19 npx vitest run --maxWorkers=8`. Never exceed 10 workers in total.
- The bridge keeps answering 200 with no decision field. No code path in this feature delays or blocks a hook.
- Cursor advances only after a verdict is stored, in the same atomic write. A judge failure never advances it.
- `claude` argv for the judge, verbatim: `-p --model haiku --effort low --no-session-persistence --setting-sources '' --strict-mcp-config --disable-slash-commands --tools ''`, plus `--system-prompt-file <gate> --output-format json`, prompt on stdin, cwd an empty directory, env `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` and `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`.
- Judge concurrency is never above half the cores. Assistant text is never truncated; tool entries stay summarized.
- Blocked folders (`agentDenied`) are never read. Archived sessions are not inspected.
- Agents can never close a card. Opening a session never closes a card. Tool permissions get no card.
- Recall over noise: all confidence levels render and sound the same; `confidence` is stored for measurement only.
- Judge output is untrusted: rendered with text interpolation only, never `v-html`; `link` accepted only when `http:` or `https:`.
- Repository contracts per PR: `CHANGELOG.md` dated entry; `design.md` first for any UI; both `en.json` and `pt-BR.json` for any key; `docs/user/` for any user-visible surface; `docs/harnu-features.md` with marker bump (currently `v130`) for agent-facing changes; English only outside i18n resources; neutral vocabulary (`Acme`, `PROJ-231`, `org/proj/www`) in fixtures and docs.
- Do not copy `sidebar-options.html` into the repo: it holds Portuguese prose and `english-gate.mjs` would fail. Its anatomy is restated in Task 15.
- All main-process code lives under `src/main/your-move/`; `ipc.ts` is the only electron-bound file there. Docs are owed wherever a task names them.
- Every unit exit: `npm run typecheck`, `npm run lint`, whole suite, `npm run build`, all passing.

## Review Focus

1. The operator has unsent text in the composer when they click an answer: the paste joins the draft, the session gets both, and the card still closes because the match is by inclusion (Task 17).
2. A model-supplied option starts with `/`, `!` or `#`, or carries escape bytes: it is never typed into the PTY; the button degrades to Open session (Task 17).
3. The setting goes Off and back on days later: cursors are dropped so history is not judged and quota is not spent on it (Task 6).
4. Auth or rate-limit failure across 30 sessions: one failure card per session, one chime, and no session is re-judged more often than the retry budget allows (Tasks 10 and 19).
5. Harnu's own headless `claude -p` runs (the auto-namer in `haiku.ts`, the usage poller) fire the global `Stop` hook: they are never judged (Task 8).

## U1: Core, in Observe mode

### Task 1: Card state and store

**Files:**

- Create: `src/main/your-move/core.ts`, `src/main/your-move/store.ts`
- Test: `tests/your-move/core.test.ts`, `tests/your-move/store.test.ts`

**Interfaces:**

- Produces, in `core.ts`:

```ts
export const CARD_KINDS = ['decide', 'go_no_go', 'provide', 'do', 'check'] as const
export type CardKind = (typeof CARD_KINDS)[number]
export type CardSource = 'judge' | 'verb' | 'mission' | 'human-gate' | 'death' | 'judge-failure'
export type CardLane = 'live' | 'observe' | 'mid-turn'
export type CloseReason =
  | 'answered'
  | 'judge'
  | 'not-for-me'
  | 'already-handled'
  | 'source-resolved'
  | 'archived'
  | 'folder-removed'
export type DeliveryFailure = 'wake-timeout' | 'process-gone' | 'not-confirmed' | 'refused'
export interface CardDelivery {
  state: 'queued' | 'sent' | 'failed'
  text: string
  at: number
  failure?: DeliveryFailure
}
export interface MissionPointer {
  missionId: string
  root: string
  item: MissionYouItem
}
export interface YourMoveCard {
  id: string
  sessionId: string
  folder: string
  kind: CardKind
  ask: string
  askKey?: { key: string; params: Record<string, string> } // system cards: rendered through $t
  context?: string
  blocks?: string
  options?: string[]
  recommended?: string
  link?: string
  confidence?: 'high' | 'low'
  evidence?: string
  source: CardSource
  sourceKey?: string
  lane: CardLane
  mission?: MissionPointer
  openedAt: number
  updatedAt: number
  closedAt?: number
  closedBy?: CloseReason
  delivery?: CardDelivery
  cue?: { lastCuedAt: number; nudges: number }
}
export interface SessionCursor {
  offset: number
  shadowOffset?: number
  lastInspectedAt: number
}
export interface YourMoveState {
  version: 1
  cards: YourMoveCard[]
  cursors: Record<string, SessionCursor>
}
export interface JudgeNew {
  kind: CardKind
  ask: string
  context?: string
  blocks?: string
  options?: string[]
  recommended?: string
  link?: string
  confidence?: 'high' | 'low'
  evidence?: string
}
export interface Verdict {
  new: JudgeNew[]
  update: { id: string; ask: string }[]
  close: string[]
}
export interface StructuredDraft extends Omit<JudgeNew, 'confidence' | 'evidence'> {
  sessionId: string
  folder: string
  source: CardSource
  sourceKey: string
  lane: CardLane
  askKey?: YourMoveCard['askKey']
  mission?: MissionPointer
}
export function emptyState(): YourMoveState
export function openCardsFor(s: YourMoveState, sessionId: string, lane: CardLane): YourMoveCard[]
export function applyVerdict(
  s: YourMoveState,
  input: {
    sessionId: string
    folder: string
    verdict: Verdict
    newIds: string[]
    hasOperatorEntry: boolean
    lane: CardLane
    now: number
  }
): YourMoveState
export function advanceCursor(
  s: YourMoveState,
  sessionId: string,
  field: 'offset' | 'shadowOffset',
  to: number,
  now: number
): YourMoveState
export function closeCard(
  s: YourMoveState,
  cardId: string,
  reason: CloseReason,
  now: number
): YourMoveState
export function upsertStructured(
  s: YourMoveState,
  draft: StructuredDraft,
  mintId: () => string,
  now: number
): YourMoveState
export function reconcileSource(
  s: YourMoveState,
  scope: { source: CardSource; sessionId?: string; missionIds?: readonly string[] },
  owed: readonly StructuredDraft[],
  mintId: () => string,
  now: number
): YourMoveState
export function closeForSessions(
  s: YourMoveState,
  ids: readonly string[],
  reason: CloseReason,
  now: number
): YourMoveState
export function closeForFolder(
  s: YourMoveState,
  folder: string,
  reason: CloseReason,
  now: number
): YourMoveState
export function resetCursors(s: YourMoveState): YourMoveState
export function pruneClosed(s: YourMoveState, now: number): YourMoveState // closed older than 30 days; at most 1000 closed
```

- Produces, in `store.ts`:

```ts
export interface YourMoveStore {
  state(): YourMoveState // deep copy
  transact<T>(decide: (s: YourMoveState) => { next: YourMoveState; result: T }): Promise<T>
  onChange(cb: (s: YourMoveState) => void): () => void
}
export function openYourMoveStore(filePath: string): Promise<YourMoveStore>
export function setYourMoveStore(s: YourMoveStore | null): void
export function getYourMoveStore(): YourMoveStore | null
```

- [ ] **Step 1: Write the failing tests**

```ts
it('update refreshes ask and updatedAt, never openedAt')
// applyVerdict with update:[{id:'a',ask:'new'}] at now=9 on openedAt=1 → ask 'new', updatedAt 9, openedAt 1
it('close is ignored without an [OPERATOR] entry')
// hasOperatorEntry:false, close:['a'] → card still open
it('close applies with an [OPERATOR] entry and records closedBy judge')
it('unknown ids in update and close are ignored, cards of other sessions untouched')
it('recommended not among options is dropped; link not http(s) is dropped')
// link 'javascript:alert(1)' and 'file:///etc/passwd' → undefined
it('upsertStructured with a known sourceKey keeps openedAt and refreshes ask')
it('reconcileSource closes in-scope cards whose key is no longer owed as source-resolved')
it('reconcileSource never touches cards of another mission id or session')
it('resetCursors drops every cursor and keeps every card')
// store.test.ts, real temp dir
it('persists across reopen, file mode 0600')
it('corrupt JSON opens empty and the next write repairs it')
it('a failed write leaves state and listeners exactly as they were')
```

- [ ] **Step 2:** Run `T tests/your-move/core.test.ts` and `T tests/your-move/store.test.ts`. Expected: FAIL, modules not found.
- [ ] **Step 3: Implement** the signatures above. Model `store.ts` on `openSessionArchive` in `src/main/session-archive-core.ts` (queue, commit-then-swap, `atomicWriteFile` mode `0o600`, listener isolation). `core.ts` has no `node:` import and imports `MissionYouItem` as a type only.
- [ ] **Step 4:** Run the same two commands. Expected: PASS.
- [ ] **Step 5: Commit** `feat(your-move): card state and persistent store`.

### Task 2: Segment builder

**Files:**

- Create: `src/main/your-move/segment.ts`, `src/main/your-move/transcript.ts`
- Test: `tests/your-move/segment.test.ts`, `tests/your-move/transcript.test.ts`

**Interfaces:**

- Produces:

```ts
export type SegmentTag = 'OPERATOR' | 'AGENT_MESSAGE' | 'ASSISTANT' | 'TOOL'
export interface SegmentEntry {
  tag: SegmentTag
  from?: string
  text: string
}
export function buildSegment(lines: readonly Record<string, unknown>[]): SegmentEntry[]
export function renderForJudge(
  open: readonly { id: string; ask: string }[],
  entries: readonly SegmentEntry[]
): string
export function splitSegment(entries: readonly SegmentEntry[], maxChars: number): SegmentEntry[][]
export function hasOperatorEntry(entries: readonly SegmentEntry[]): boolean
export function isJudgeable(entries: readonly SegmentEntry[]): boolean // any non-TOOL entry
export function hasAssistantText(entries: readonly SegmentEntry[]): boolean
// transcript.ts
export interface ReadResult {
  lines: Record<string, unknown>[]
  nextOffset: number
  size: number
  shrunk: boolean
}
export function readFrom(path: string, offset: number): Promise<ReadResult>
```

- [ ] **Step 1: Write the failing tests**

```ts
it('origin human starting "[Harnu ·" is AGENT_MESSAGE from human')
it.each(['peer', 'task-notification', 'external'])('origin %s is AGENT_MESSAGE from that kind')
it('missing origin on a non-meta user entry is AGENT_MESSAGE from external')
it('isMeta entries are dropped unless origin kind is peer')
it('tool_result user entries, isCompactSummary and isSidechain entries are dropped')
it('assistant text of 50_000 chars is carried whole')
it('tool_use is summarized: name plus JSON input cut at 120 chars, at most 3 per assistant entry')
it('renderForJudge matches the spike format')
// 'OPEN_CARDS: [...]\n\nSEGMENT:\n[OPERATOR] x\n[AGENT_MESSAGE from peer] y'
it('splitSegment keeps order and never drops text, cutting an oversized entry into same-tag parts')
// transcript.test.ts
it('returns only complete lines; nextOffset stops after the last newline')
it('a malformed JSON line is skipped and the offset still passes it')
it('offset beyond size reports shrunk:true and nextOffset:size')
```

- [ ] **Step 2:** Run both test files. Expected: FAIL, modules not found.
- [ ] **Step 3: Implement.** Port `segments_of` from `real.py` without its 700 and 900 char cuts and without starting a new segment at each inbound entry. Stream with `fs.createReadStream(path, { start: offset })`.
- [ ] **Step 4:** Run both test files. Expected: PASS.
- [ ] **Step 5: Commit** `feat(your-move): transcript segments tagged by origin`.

### Task 3: Gate v2 resource and verdict parsing

**Files:**

- Create: `resources/your-move/gate-v2.md`, `src/main/your-move/gate.ts`
- Modify: `electron-builder.yml` (`extraResources`, after the `resources/skills` entry)
- Test: `tests/your-move/gate.test.ts`

**Interfaces:**

- Produces:

```ts
export const GATE_V2_SHA256: string
export function buildJudgeArgs(gatePath: string): string[]
export function parseVerdict(
  stdout: string
): { ok: true; verdict: Verdict; costUsd: number } | { ok: false; reason: string }
export function judgeConcurrency(cores: number): number // max(1, min(4, floor(cores / 2)))
```

- [ ] **Step 1: Create the resource.** Copy `gate-v1.md` and change only these three places.
      Rule 9, first sentence, becomes:

```
9. If the segment restates the same item as one in OPEN_CARDS, put its id and a refreshed one-line `ask` in `update` and do not file it again.
```

After the line beginning "Write `ask` in one line" add:

```
Also fill these when the segment supports them, and omit them when it does not: `context`, one sentence on why this is needed; `blocks`, what cannot move until this is answered; `recommended`, the option the session recommends, copied exactly from `options`; `link`, only for kind `do`, a URL the operator must open.
```

Replace the reply shape line with:

```
{"new":[{"kind":"decide|go_no_go|provide|do|check","ask":"...","context":"...","blocks":"...","options":["..."],"recommended":"...","link":"...","confidence":"high|low","evidence":"short quote from the segment"}],"update":[{"id":"card-id","ask":"..."}],"close":["card-id"]}
```

- [ ] **Step 2: Write the failing tests**

```ts
it('buildJudgeArgs is exact')
// ['-p','--model','haiku','--effort','low','--no-session-persistence','--setting-sources','',
//  '--strict-mcp-config','--disable-slash-commands','--tools','',
//  '--system-prompt-file','/g.md','--output-format','json']
it('parses the CLI json envelope, reading result and total_cost_usd')
it('rejects an unknown kind, a missing ask, and update entries that are bare strings')
it('judgeConcurrency: 20→4, 8→4, 4→2, 3→1, 1→1, never above half the cores')
it('gate-v2.md hash equals GATE_V2_SHA256') // sha256 of the file; a wording change must re-run Task 4
```

- [ ] **Step 3:** Run `T tests/your-move/gate.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 4: Implement** with zod, and add to `electron-builder.yml`: `- from: 'resources/your-move'` / `to: 'your-move'`.
- [ ] **Step 5:** Run the test. Expected: PASS.
- [ ] **Step 6: Commit** `feat(your-move): gate v2 prompt and verdict parsing`.

### Task 4: Re-run the eval against gate v2

This task blocks the U1 merge. It spends roughly US$ 1 of quota and adds no code to the repo.
**Files:** only under `<main checkout>/.harnu/out/your-move/gate/`, which is gitignored.

**Acceptance bar (spec "Gate v2 schema"):** synthetic misses at most 2 of 486 on valid positives; real turns at least 59 of 62 caught. Only recall is a bar. Report the false-alarm rate (v1: 27 of 510) but do not gate on it.

- [ ] **Step 1: Patch the harness.** `score()` at `run.py:229` does `set(verdict.get("update") or [])`, which raises on v2's objects. Normalize with `[u["id"] if isinstance(u, dict) else u for u in ...]`. `EMPTY` at `run.py:20` points at a scratch directory from an earlier session: set it to a new empty directory. Keep `WORKERS = 8`.
- [ ] **Step 2: Run the synthetic set on the frozen v1 cases.** Copy `data-v1/audit-v1.jsonl` to `data-v1/audit-v2.jsonl` first, so the 28 fixtures the blind audit already removed stay removed.

```bash
cd <main checkout>/.harnu/out/your-move/gate
export DATA_DIR=$PWD/data-v1 GATE_FILE=<worktree>/resources/your-move/gate-v2.md GATE_TAG=v2
nice -n 19 python3 run.py judge && nice -n 19 python3 run.py audit && python3 run.py report
```

Expected: the final line reads `miss rate` with at most 2 misses of 486.

- [ ] **Step 3: Score the real turns from the frozen sample.** Do NOT run `real.py` (it re-samples live transcripts at `real.py:87`) or `label_real.py` (it skips ids already in `real-haiku.jsonl`, so v2 would never run). Write `real_v2.py` beside them: import `run.py`, load `data-v1/real-sample.jsonl`, call `run.ask("haiku", run.GATE, run.render(s))` through `run.pmap` into `real-haiku-v2.jsonl`, then compute the ground truth `P` and print caught counts.

```python
# P = turns flagged by both v1 Haiku and Fable, plus disagreements the operator ruled "yes".
# "unsure" is excluded. On the frozen data |both| = 46 and ruled yes = 16, so |P| = 62.
P = {i for i in sample if h1[i].get("new") and fable[i].get("waiting")} | {i for i, a in answers.items() if a == "yes"}
caught = sum(1 for i in P if v2[i].get("new"))
```

Expected: `caught >= 59`.

- [ ] **Step 4: Decide.** If either bar fails, stop and report the failing cases. Adjust only the wording added in Task 3, update `GATE_V2_SHA256`, and repeat. Do not touch rules 1 to 12.
- [ ] **Step 5:** Record both results in the U1 PR description, including the false-alarm rate and the measurement date.

### Task 5: Judge runner and inspector

**Files:**

- Create: `src/main/your-move/judge.ts`, `src/main/your-move/inspector.ts`
- Test: `tests/your-move/judge.test.ts`, `tests/your-move/inspector.test.ts`

**Interfaces:**

- Produces:

```ts
// judge.ts
export type JudgeOutcome =
  | { ok: true; verdict: Verdict; costUsd: number; durationMs: number }
  | { ok: false; reason: string }
export interface JudgeRunner {
  run(input: string): Promise<JudgeOutcome>
  closeAll(): void
}
export function createJudgeRunner(deps: {
  binary: () => Promise<string>
  gatePath: string
  emptyDir: string
  env: NodeJS.ProcessEnv
  cores: number
  delay?: (ms: number) => Promise<void>
}): JudgeRunner
// inspector.ts
export type Trigger = 'stop' | 'mid-turn' | 'manual'
export interface InspectRequest {
  sessionId: string
  folder: string
  transcriptPath: string
  trigger: Trigger
  lastAssistantMessage?: string
}
export type InspectOutcome = 'first-sight' | 'skipped' | 'empty' | 'judged' | 'failed'
export interface InspectorDeps {
  store: YourMoveStore
  read: typeof readFrom
  judge: JudgeRunner['run']
  now(): number
  mintId(): string
  isBlocked(folder: string): boolean
  isArchived(id: string): boolean
  isFolderOff(folder: string): boolean
  mode(): YourMoveMode
  midTurnLive(): boolean
  classify(lines: readonly unknown[]): 'interactive' | 'programmatic' | null
  onFailure?(req: InspectRequest, reason: string): void
  onSuccess?(req: InspectRequest): void
  appendInspection?(row: Record<string, unknown>): void
}
export function laneFor(mode: YourMoveMode, trigger: Trigger, midTurnLive: boolean): CardLane
export function createInspector(deps: InspectorDeps): {
  request(r: InspectRequest): Promise<InspectOutcome>
  idle(): Promise<void>
}
export const MAX_SEGMENT_CHARS = 300_000
```

- [ ] **Step 1: Write the failing tests**

```ts
// inspector.test.ts, fake deps
it('off mode, a blocked folder, an archived session, a per-folder off all skip without reading')
it('a programmatic transcript skips without judging and without a cursor')
it(
  'stop and manual with no cursor start at most 256 KiB back, aligned after a newline, and judge that tail'
) // recall over noise: a session first seen at its Stop may already be waiting
it('mid-turn with no cursor sets it to end of file, returns first-sight, calls no judge')
it('a verdict and the cursor land in one transact')
// a store whose transact rejects → cursor unchanged, no cards
it('judge failure leaves the cursor where it was and calls onFailure')
it('a segment of only TOOL entries advances the cursor without a judge call')
it('a split segment judges parts in order, each part seeing cards filed by earlier parts')
it('a card the operator closed during a multi-part run stays closed at commit')
it('two requests during a run coalesce into one rerun; never two judges for one session')
it('a shrunk file resets the cursor to end of file and logs the row')
it('laneFor: observe→observe; live stop→live; mid-turn→mid-turn; mid-turn with midTurnLive→live')
it('mid-turn moves shadowOffset and never offset')
it('the judge sees only open cards of its own lane')
// judge.test.ts, fake binary script on PATH-less absolute path
it('sends the prompt on stdin, not argv')
it('runs in emptyDir with both CLAUDE_CODE_DISABLE_* vars set')
it('retries a bad-JSON reply 3 times with growing delay, then ok:false')
it('never runs more than judgeConcurrency children at once')
```

- [ ] **Step 2:** Run both files. Expected: FAIL, modules not found.
- [ ] **Step 3: Implement.** Use `child_process.spawn`, not `runHaiku`: `haiku.ts` passes the prompt in argv, runs from the home directory and has no isolation flags. Timeout 120 s per attempt, 3 attempts, delay `4000 * attempt`. Lower priority with `os.setPriority(child.pid, os.constants.priority.PRIORITY_LOW)` inside try/catch. Mint part ids before folding so a re-fold at commit reuses them.
- [ ] **Step 4:** Run both files. Expected: PASS.
- [ ] **Step 5: Commit** `feat(your-move): judge runner and inspector`.

### Task 6: Setting and debug view

**Files:**

- Create: `src/main/your-move/prefs.ts`, `src/main/your-move/ipc.ts`, `src/renderer/src/components/YourMovePane.vue`
- Modify: `src/main/index.ts` (`registerYourMove`, `closeYourMove` on quit), `src/preload/index.ts`, `src/renderer/src/components/SettingsDialog.vue` (tab entry beside `hibernationPolicy` at line 294, render at 1270), `src/renderer/src/i18n/en.json`, `pt-BR.json`, `design.md` (§6, first), `CLAUDE.md` (entity map row), `docs/user/settings.md`, `CHANGELOG.md`
- Test: `tests/your-move/prefs.test.ts`, `tests/your-move/pane.test.ts`

**Interfaces:**

- Produces:

```ts
export type YourMoveMode = 'off' | 'observe' | 'live'
export interface YourMovePrefs {
  version: 1
  mode?: YourMoveMode
  disabledFolders: string[]
  firstRunNoticeSeen: boolean
  midTurnLive: boolean
}
export const DEFAULT_YOUR_MOVE_MODE: YourMoveMode // 'off' until U5
export function effectiveMode(p: YourMovePrefs): YourMoveMode
export function needsCursorReset(prev: YourMoveMode, next: YourMoveMode): boolean // true only leaving 'off'
export function readYourMovePrefs(path: string): Promise<YourMovePrefs>
export function writeYourMovePrefs(
  path: string,
  patch: Partial<YourMovePrefs>
): Promise<YourMovePrefs>
export function registerYourMove(
  getWindow: () => BrowserWindow | null,
  deps: { getBridge(): CommandBridge | undefined }
): void
export function closeYourMove(): void
export type CardView = YourMoveCard & { answerable: boolean; optionDeliverable: boolean[] }
```

IPC: `yourMove:list` → `CardView[]` (open plus the newest 200 closed), `yourMove:prefs:get`, `yourMove:prefs:set`, `yourMove:inspectNow`, event `yourMove:changed`. Files in `<userData>`: `your-move.json`, `your-move-prefs.json`, `your-move-inspections.jsonl`, and an empty `your-move/empty/` directory. Gate path uses the same packaged/dev split as `bundled-skills.ts:99`. Binary from `resolveClaudePath`, env from `sanitizeSpawnEnv`, `isBlocked` from `readUserProjects()` `agentDenied` via `isFolderDenied`, `isArchived` from `getSessionArchive()`, `classify` from `classifyTranscriptLines` (`claude-watcher.ts:880`).

- [ ] **Step 1: Edit `design.md` first:** a §6 entry for the Your move Settings pane using existing rows and tokens only. Add the `CLAUDE.md` map row.
- [ ] **Step 2: Write the failing tests**

```ts
it('effectiveMode: unset reads DEFAULT_YOUR_MOVE_MODE; an explicit choice wins')
it('needsCursorReset: off→observe and off→live true; observe→live false; live→off false')
it('a disabledFolders path disables nested folders')
// pane.test.ts, @vitest-environment jsdom
it('renders Off, Observe and Live and calls yourMoveSetPrefs on change')
it('lists stored cards as text; markup in ask is shown literally')
it('Inspect now calls yourMoveInspectNow with the selected session')
```

- [ ] **Step 3:** Run both files. Expected: FAIL.
- [ ] **Step 4: Implement.** Pane strings through `$t` in both locales. In U1 a `live` selection behaves like `observe` for rendering, since no zone reads cards yet; the pane says so. `yourMove:prefs:set` runs `resetCursors` in the store when `needsCursorReset(prev, next)` is true (Review Focus 3).
- [ ] **Step 5:** Run both files. Expected: PASS.
- [ ] **Step 6:** Add `docs/user/settings.md` section and `CHANGELOG.md` entry under `### Added`, today's date.
- [ ] **Step 7: Commit** `feat(your-move): Off, Observe and Live setting with a debug view`.

**U1 exit:** the Global Constraints checks pass, Task 4's numbers are in the PR, and in a second instance (`docs/dev/live-verify-second-instance.md`) Observe plus Inspect now stores a card.

---

## U2: Sources

### Task 7: Carry hook payload fields to in-main observers

**Files:**

- Modify: `src/main/hook-bridge.ts:198-207`, `src/main/detect/task-state-hub.ts:17-30,102-116,219-233`, `src/main/hook-settings-blob.ts:18-24,91-100`
- Test: `tests/your-move/hook-payload.test.ts`; extend the existing hook-blob test

**Interfaces:**

- Produces: `BridgeEvent` and `HookTaskEvent` gain `payload?: HookPayload`.

```ts
export interface HookPayload {
  transcriptPath?: string
  cwd?: string
  prompt?: string
  lastAssistantMessage?: string
}
```

- [ ] **Step 1: Write the failing tests**

```ts
it('a Stop POST reaches observers with transcriptPath, cwd and lastAssistantMessage')
it('a UserPromptSubmit POST reaches observers with prompt')
it('the renderer claude:hook payload carries none of these fields')
it('the response body is still {} with no decision field')
it('the per-session blob subscribes StopFailure')
```

- [ ] **Step 2:** Run the new file. Expected: FAIL.
- [ ] **Step 3: Implement.** Read `transcript_path`, `cwd`, `prompt`, `last_assistant_message` from the body as strings. Pass `payload` to observers only. Add `StopFailure` to `buildHookSettingsBlob` and to its header comment; today it exists only in the global install (`hook-installer.ts:45`).
- [ ] **Step 4:** Run the new file and `T tests/hook-settings-blob.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(hooks): pass transcript and prompt fields to in-main observers`.

### Task 8: Stop-driven inspection

**Files:**

- Create: `src/main/your-move/triggers.ts`
- Modify: `src/main/your-move/ipc.ts`, `CHANGELOG.md`
- Test: `tests/your-move/triggers.test.ts`

**Interfaces:**

- Produces:

```ts
export const STOP_SETTLE_MS = 2_000
export function createTriggers(deps: {
  inspector: ReturnType<typeof createInspector>
  store: YourMoveStore
  locate(sessionId: string): Promise<string | null>
  now(): number
  setTimer(fn: () => void, ms: number): unknown
  ensureCursor(sessionId: string, path: string): Promise<void>
  delay(ms: number): Promise<void>
}): { onTaskEvent(ev: HookTaskEvent): void; dispose(): void }
```

`locate` falls back to `~/.claude/projects/*/<id>.jsonl` for a companion-sourced event with no `transcriptPath`.

- [ ] **Step 1: Write the failing tests**

```ts
it(
  'SessionStart and UserPromptSubmit on an unseen session set the cursor, so the first turn is judged'
)
it('Stop requests one inspection after STOP_SETTLE_MS, after the handler returned')
it('two Stop events inside the settle window request one inspection')
it(
  'when lastAssistantMessage is absent from the segment, re-reads up to 3 times, then appends it as a final ASSISTANT entry'
)
it('an event for a programmatic transcript files nothing') // Review Focus 5: fixture entrypoint 'sdk-cli'
it('an event from a subagent (agentId set) requests nothing')
```

- [ ] **Step 2:** Run the file. Expected: FAIL.
- [ ] **Step 3: Implement** `onTaskEvent` and wire it in `ipc.ts` through `addTaskEventObserver`. Pass the fallback text through `InspectRequest.lastAssistantMessage`; the inspector appends it when the tail lacks it.
- [ ] **Step 4:** Run the file. Expected: PASS.
- [ ] **Step 5:** `CHANGELOG.md` entry. **Commit** `feat(your-move): inspect sessions after Stop`.

### Task 9: Five-minute inspection without a Stop

**Files:**

- Modify: `src/main/your-move/triggers.ts`, `src/main/your-move/ipc.ts`
- Test: `tests/your-move/mid-turn.test.ts`

**Interfaces:**

- Produces: `export const MID_TURN_AFTER_MS = 5 * 60_000`, `export const SWEEP_MS = 60_000`, `createMidTurnSweep(deps): { tick(): Promise<void>; dispose(): void }`.
- [ ] **Step 1: Write the failing tests**

```ts
it(
  'requests trigger mid-turn when lastInspectedAt is older than 5 minutes and new assistant text exists'
)
it('does nothing when only TOOL entries were added, and leaves shadowOffset alone')
it('files lane mid-turn cards that the queue never shows while midTurnLive is false')
it('a later Stop still judges the same text on the live cursor') // the guard for separate cursors
```

- [ ] **Step 2:** Run the file. Expected: FAIL.
- [ ] **Step 3: Implement.** Iterate `getTaskStates()` every `SWEEP_MS`. Mid-turn uses `shadowOffset` only: if it advanced the main cursor while its cards stay hidden, a real pending item would be consumed by a card nobody sees. `midTurnLive` is a pref with no UI; flipping it is the maintainer's call after the observation week.
- [ ] **Step 4:** Run the file. Expected: PASS.
- [ ] **Step 5: Commit** `feat(your-move): observe long turns with no Stop`.

### Task 10: Death and judge-failure cards

**Files:**

- Modify: `src/main/pty.ts` (the `pty:write` handler at 866; `onExit` at 1950), `src/main/your-move/triggers.ts`, `src/main/your-move/ipc.ts`
- Test: `tests/your-move/death.test.ts`

**Interfaces:**

- Produces:

```ts
// pty.ts
export function setPtyExitObserver(fn: ((x: PtyExitFact) => void) | null): void
export interface PtyExitFact {
  sessionKey: string
  reason: PtyExitReason
  removedFirst: boolean
  taskState?: TaskState
  lastCtrlCAt?: number
  now: number
}
// triggers.ts
export const CTRL_C_GRACE_MS = 5_000
export function isDeathExit(x: PtyExitFact): boolean
export function deathDraft(input: {
  sessionId: string
  folder: string
  failureReason?: FailureReason
  lane: CardLane
}): StructuredDraft
export function failureDraft(input: {
  sessionId: string
  folder: string
  reason: string
  lane: CardLane
}): StructuredDraft
```

Keys: `death:<sessionId>`, `judge-failure:<sessionId>`. Both use `askKey` (`yourMove.system.stopped`, `yourMove.system.couldNotCheck`) and kind `do`; both are Open session only. `deathDraft`'s English `ask` is `Session stopped: <reason>`.

- [ ] **Step 1: Write the failing tests**

```ts
it('StopFailure files one death card per session')
it('a natural exit while working counts')
it.each([
  ['Harnu quit or operator close', { removedFirst: true }],
  ['hibernation', { reason: 'park' }],
  ['Ctrl+C', { lastCtrlCAt: 'now-1s' }],
  ['exit while idle', { taskState: 'idle' }]
])('%s does not count')
it('a later Stop closes the death card as source-resolved')
it('judge failure opens one card per streak, not one per attempt')
it('a success closes the failure card; a later failure opens a new one')
it('a 30-session failure wave leaves 30 cards and cursors unmoved') // Review Focus 4
it('failed inspections retry only on the next trigger, never in a loop')
```

- [ ] **Step 2:** Run the file. Expected: FAIL.
- [ ] **Step 3: Implement.** `removedFirst` is `ptys.get(id) !== rec` at exit: `killAllPtys` (1062) and destroy (1273) delete the record before the exit lands. Read `getTaskState(key)` before `pruneTaskState` at 1951. Note `\x03` in `pty:write` on the record.
- [ ] **Step 4:** Run the file and `T tests/pty-terminal-close.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(your-move): death and judge-failure cards`.

### Task 11: Mission source

**Files:**

- Create: `src/main/your-move/source-mission.ts`
- Modify: `src/main/mission-ipc.ts:495` (observer after the list resolves), `src/main/your-move/ipc.ts`
- Test: `tests/your-move/source-mission.test.ts`

**Interfaces:**

- Produces:

```ts
export function missionDrafts(
  view: Pick<MissionView, 'root' | 'mission' | 'you'>,
  lane: CardLane
): StructuredDraft[]
export function reconcileMissions(
  s: YourMoveState,
  result: MissionListResult,
  queriedRoots: readonly string[],
  lane: CardLane,
  mintId: () => string,
  now: number
): YourMoveState
// mission-ipc.ts
export function setMissionListObserver(
  fn: ((r: MissionListResult, roots: string[]) => void) | null
): void
```

Mapping, with `sourceKey` always `<missionId>:<suffix>`:

| `youItems` kind            | Card kind  | Key suffix             |
| -------------------------- | ---------- | ---------------------- |
| `rescope`                  | `go_no_go` | `rescope:<end.target>` |
| `close`                    | `go_no_go` | `close`                |
| `steward-paused`           | `do`       | `steward-paused`       |
| `blocker`                  | `do`       | `blocker:<reason>`     |
| `checks`                   | `check`    | `checks`               |
| `human-steps`              | `check`    | `human-steps`          |
| `review-import`            | `check`    | `review-import`        |
| `main-red`                 | `do`       | `main-red:<stepId>`    |
| `approvals`, `needs-input` | no card    |                        |

`sessionId` is `mission.owner.sessionId`, `folder` is `root`, `ask` is the English `youSentence(item)` (export it from `tool-handlers.ts`). `mission` carries the pointer so the renderer can use `youRowText` for the visible line.

- [ ] **Step 1: Write the failing tests**

```ts
it('maps each owed kind to the table above, and approvals and needs-input to nothing')
it('a cleared blocker closes its card as source-resolved')
it('a mission absent from the result under a queried root closes its cards')
it('a mission under a root that was not queried is untouched')
it('an unreadable mission file closes nothing') // result.unreadable non-empty → skip absence closing
it('a mission card never writes to the mission') // no door or mission_* call in the module
```

- [ ] **Step 2:** Run the file. Expected: FAIL.
- [ ] **Step 3: Implement.** Reuses the renderer's existing 20 s `mission:list` poll, so no extra GitHub budget is spent.
- [ ] **Step 4:** Run the file. Expected: PASS.
- [ ] **Step 5:** `CHANGELOG.md`. **Commit** `feat(your-move): cards from mission blockers and owed items`.

### Task 12: AskUserQuestion source, and closes on archive and folder removal

**Files:**

- Create: `src/main/your-move/source-gate.ts`
- Modify: `src/main/your-move/ipc.ts`, `src/main/your-move/triggers.ts`, `src/main/user-projects.ts` (`onFolderRemoved`, fired by `removeUserProject` at 1472 and the ghost removals at 1559 and 1666)
- Test: `tests/your-move/source-gate.test.ts`

**Interfaces:**

- Consumes: `HUMAN_GATING_TOOLS`, `lastChainParticipant`, `toolUseNames` from `src/main/transcript-truth.ts`.
- Produces:

```ts
export interface PendingGate {
  toolUseId: string
  tool: string
  question: string
}
export function pendingHumanGate(lines: readonly Record<string, unknown>[]): PendingGate | null
export function gateDraft(
  g: PendingGate,
  sessionId: string,
  folder: string,
  lane: CardLane
): StructuredDraft
export function onFolderRemoved(listener: (path: string) => void): () => void
```

Key `gate:<toolUseId>`, source `human-gate`, kind `decide`, no options, so the view model gives Open session only. Hooks cannot supply this: `tool_name` is not forwarded and `PreToolUse` is global-install only. Detect from the transcript tail (last 128 KiB) on each `needs-input` edge and each sweep tick.

- [ ] **Step 1: Write the failing tests**

```ts
it(
  'a last assistant entry with an AskUserQuestion tool_use and no result is pending, stop_reason null included'
)
it('ExitPlanMode is pending too') // retiring the 10-minute path must not orphan it
it('a tool_result after it is not pending')
it('the answered gate closes as source-resolved')
it('no card for a generic permission prompt')
it('archiving a session closes its cards as archived')
it('removing a folder closes its cards as folder-removed; hiding it does not')
```

- [ ] **Step 2:** Run the file. Expected: FAIL.
- [ ] **Step 3: Implement.** `question` is the first `questions[].question` or, for `ExitPlanMode`, a fixed `askKey`. Subscribe `getSessionArchive().onChange`.
- [ ] **Step 4:** Run the file. Expected: PASS.
- [ ] **Step 5:** `CHANGELOG.md`; `docs/user/settings.md` lists what files a card. **Commit** `feat(your-move): AskUserQuestion cards and closes on archive or removal`.

**U2 exit:** the Global Constraints checks pass. In a second instance with Observe on, a real prose question stored a card with no latency added to the session.

---

## U3: Agent surface

### Task 13: The `your_move` verb

**Files:**

- Modify: `src/main/mcp/tool-catalog.ts` (the silent-allow list near 208; entry after `hide_folder` at 2113), `src/main/mcp/validate.ts` (schema, parser, map at 1977), `src/main/mcp/plan-input.ts` (translator, map at 542), `src/main/mcp/tool-handlers.ts` (handler, map at 7682), `src/main/your-move/core.ts`, `tests/mcp-tool-catalog.test.ts` (`MUTATE_TOOLS` and the runs-free list at 304)
- Test: `tests/your-move/verb.test.ts`

**Interfaces:**

- Produces:

```ts
export const YOUR_MOVE_LIMIT_PER_HOUR = 30
export function fileFromVerb(
  s: YourMoveState,
  input: {
    folder: string
    sessionId: string
    kind: CardKind
    ask: string
    blocks?: string
    options?: string[]
    recommended?: string
    cardId?: string
    lane: CardLane
  },
  mintId: () => string,
  now: number
): { state: YourMoveState; cardId: string; refreshed: boolean } | { error: 'CARD_NOT_FOUND' }
```

Schema: `folder` absolute, `sessionId` non-empty, `kind` enum, `ask` 1 to 500, `blocks` to 500, `options` at most 6 of 1 to 120, `recommended` to 120, `cardId` optional. ACK: `{ ok: true, op: 'your_move', cardId, refreshed }`. `silentAllowInAgentFolder: true`, `alwaysAllowable: true`, not a grant-only verb.

- [ ] **Step 1: Write the failing tests**

```ts
it('files a card and returns its id')
it('cardId refreshes ask and updatedAt and keeps openedAt')
it('cardId of a closed card or another session is CARD_NOT_FOUND')
it('the 31st call within an hour for one session is YOUR_MOVE_RATE_LIMIT and appends an audit row')
it('mode off, or that folder off, is YOUR_MOVE_OFF and files nothing')
it('observe files lane observe; live files lane live')
it('the schema has no close field and the catalog has no close verb')
```

- [ ] **Step 2:** Run `T tests/your-move/verb.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Rate slot as `takePeerMessageSlot` at `tool-handlers.ts:2465`, keyed on the session and the UTC hour.
- [ ] **Step 4:** Run it and `T tests/mcp-tool-catalog.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(mcp): your_move verb`, together with the docs in Task 14 so the CI gates pass on the PR.

### Task 14: The `harnu:your-move` skill and docs

**Files:**

- Create: `resources/skills/skills/your-move/SKILL.md`
- Modify: `resources/skills/CATALOG.md` (marker to `v19`, new row), `docs/harnu-features.md` (marker to `v131`), `docs/user/agent-control.md`, `docs/user/bundled-skills.md`, `CHANGELOG.md`
- Test: `tests/your-move/skill.test.ts`

**Interfaces:**

- Produces: a skill with frontmatter `name: your-move`, directory name equal.
  Content, in this order: the end-of-turn test ("if the operator never comes back, does this still get done?"); the five kinds with one example each, using neutral names; how to write a self-contained card (never "D-9 is unanswered", always what D-9 is); when to call `your_move`, and that it cannot close; that the judge is the guarantee and the skill improves quality. Run `/harnu-awareness` for the doc tone rules.
- [ ] **Step 1: Write the failing test**

```ts
it('frontmatter name equals the directory and description names when not to use it')
it('mentions all five kinds, your_move, and the end-of-turn test')
it('the catalog marker is greater than v18 and lists your-move')
it(
  'docs/harnu-features.md marker is greater than v130 and documents cardId, the cap and YOUR_MOVE_OFF'
)
```

- [ ] **Step 2:** Run the file. Expected: FAIL.
- [ ] **Step 3: Write the skill and docs**, confirming behavior against the code in Task 13.
- [ ] **Step 4:** Run the file, `T tests/awareness-gate.test.ts`, `T tests/bundled-skills-core.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(skills): harnu:your-move`.

**U3 exit:** the Global Constraints checks pass; a session in a second instance calls `your_move` and the card appears in the debug list.

---

## U4: Queue UI

### Task 15: `design.md`, view model and store

**Files:**

- Create: `src/renderer/src/lib/your-move-view.ts`, `src/renderer/src/stores/your-move.ts`
- Modify: `design.md` ("`RETURN HERE` zone" at 2331, the Floating panels note at 4163, §9 only if a token is needed), `src/main/your-move/ipc.ts` (`yourMove:exit`), `src/preload/index.ts`
- Test: `tests/your-move/view.test.ts`, `tests/your-move/exit.test.ts`

**Interfaces:**

- Produces:

```ts
export function formatClock(ms: number): string // '02m 03s', '1h 02m 03s', '2d 03h 04m'
export function sortOldestFirst(cards: readonly CardView[]): CardView[]
export function queueCards(cards: readonly CardView[]): CardView[] // open, lane live
export type CardAction =
  | { type: 'answer'; request: AnswerRequest }
  | { type: 'open-session' }
  | { type: 'open-link'; url: string }
  | { type: 'open-mission'; missionId: string }
  | { type: 'looks-wrong' }
export interface CardButton {
  id: string
  label?: string
  labelKey?: string
  recommended?: boolean
  action: CardAction
}
export function buttonsFor(card: CardView): CardButton[]
export type AnswerRequest =
  | { kind: 'option'; index: number }
  | { kind: 'go' | 'no-go'; label: string }
  | { kind: 'done' | 'looks-right' }
// store
export const useYourMoveStore: () => {
  cards: CardView[]
  mode: YourMoveMode
  queue: CardView[]
  count: number
  oldestAt: number | null
  init(): Promise<void>
  exit(cardId: string, label: 'not-for-me' | 'already-handled'): Promise<void>
  answer(card: CardView, req: AnswerRequest): Promise<void>
}
```

`yourMove:exit` closes the card with that reason and appends `{ ts, label, card }` to `<userData>/your-move-labels.jsonl` (0600).
Anatomy to record in `design.md`: kind badge, `folder · session`, running clock (top line); one-line ask below; expanded: context, what it blocks, buttons. Eyebrow: uppercase title, count, oldest clock, in `--color-warning`. Card: `bg-warning-soft`, `border-warning-line`, `--radius`. Recommended button: `border-accent`. No new tokens are expected: `--color-warning-soft` and `-line` exist. Zone cap: `min(380px, 45vh)`, the rows scroll, the eyebrow stays. Default and Floating panels layouts both.

- [ ] **Step 1: Edit `design.md`** per the anatomy above; keep the legacy row text until U5.
- [ ] **Step 2: Write the failing tests**

```ts
it('formatClock: 123_000→02m 03s; 3_723_000→1h 02m 03s; 183_840_000→2d 03h 04m')
it('queue is open cards of lane live only, oldest first')
it('decide: one button per option, recommended first and marked, then Open session')
it('go_no_go: Go, No-go, Open session')
it('do: Open link when http(s), Done, Open session; no link button otherwise')
it('check: Looks right, Something is wrong, Open session')
it('provide: Open session only')
it('mission card: Open session and Open mission only')
it('human-gate, death, judge-failure: Open session only')
it('not answerable: answer buttons gone, Open session stays')
it('an option with optionDeliverable false is an Open session action') // Review Focus 2
it('exit not-for-me and already-handled close the card and log separate labels')
```

- [ ] **Step 3:** Run both files. Expected: FAIL.
- [ ] **Step 4: Implement.** Until U5, the store's `answer` calls `sessions.activateSession(card.sessionId)`.
- [ ] **Step 5:** Run both files. Expected: PASS.
- [ ] **Step 6: Commit** `feat(your-move): queue view model and exits`.

### Task 16: Card component and extended Return here

**Files:**

- Create: `src/renderer/src/components/YourMoveCard.vue`
- Modify: `src/renderer/src/components/SidebarReturnZone.vue`, `src/renderer/src/i18n/en.json`, `pt-BR.json`, `tests/floating-panels.test.ts:314`, `CLAUDE.md` (map row), `docs/user/sessions.md`, `CHANGELOG.md`
- Test: `tests/your-move/card.test.ts`

**Interfaces:**

- Consumes: Task 15. New keys under `yourMove.*`: `kind.*`, `buttons.*`, `exits.notForMe`, `exits.alreadyHandled`, `delivery.*`, `system.*`.
- [ ] **Step 1: Write the failing tests** (jsdom, `@vue/test-utils`)

```ts
it('shows kind, folder and session, clock and ask; expanded shows context and buttons')
it('markup in ask, context and options renders as literal text')
it('every card has Not for me and Already handled; neither sends anything to the session')
it('renders no × and no dismiss control')
it('the eyebrow shows the count and the oldest clock')
it('in mode live the zone lists cards; in off and observe it keeps the legacy rows')
it('opening the session leaves the card in the queue')
```

Update `tests/floating-panels.test.ts:314` to `/max-height:\s*min\(380px,\s*45vh\)/`.

- [ ] **Step 2:** Run the file. Expected: FAIL.
- [ ] **Step 3: Implement.** Keep `data-island="sidebar-return"` and the divider so the Floating panels rules at `main.css:945,961` still apply. Tailwind tokens only. Add keys to both locales in this change.
- [ ] **Step 4:** Run it and `T tests/floating-panels.test.ts`. Expected: PASS.
- [ ] **Step 5:** `npm run typecheck`. Expected: exit 0 (i18n parity is enforced by `vue-tsc`).
- [ ] **Step 6: Verify visually.** Launch a second instance per `docs/dev/live-verify-second-instance.md`, in both the default and the Floating panels layouts, with long and short asks and enough cards to scroll. Ask the operator to look before calling it done.
- [ ] **Step 7:** `docs/user/sessions.md` section; `CHANGELOG.md`. **Commit** `feat(your-move): Return here shows cards with a running clock`.

**U4 exit:** the Global Constraints checks pass.

---

## U5: Reach and answering

### Task 17: Answer core

**Files:**

- Create: `src/main/your-move/answer.ts`
- Modify: `src/main/your-move/ipc.ts` (`toCardView`)
- Test: `tests/your-move/answer.test.ts`

**Interfaces:**

- Produces:

```ts
export function sanitizeAnswerText(raw: string): string // strips C0 and ESC, collapses whitespace, max 500
export function isDeliverableText(text: string): boolean // non-empty; first char not / ! #
export function answerText(card: YourMoveCard, req: AnswerRequest): string | null
export function matchesAnswer(prompt: string, sent: string): boolean // normalized inclusion
export type PumpDecision = 'deliver' | 'wait' | 'wake'
export function pumpDecision(x: { taskState?: TaskState; hibernated: boolean }): PumpDecision
export const CONFIRM_TIMEOUT_MS = 30_000
export function restoreAfterBoot(s: YourMoveState, now: number): YourMoveState // queued and sent become failed, 'process-gone'
```

- [ ] **Step 1: Write the failing tests**

```ts
it('option index sends the option text; out of range is null')
it('Go and No-go send their visible label')
it('done sends "Done: <ask>" and looks-right sends "Looks right: <ask>"')
it('sanitize removes ESC sequences and newlines') // '\x1b[31mhi\nthere' → 'hi there'
it.each(['/exit', '!rm -rf x', '#note'])('%s is not deliverable') // Review Focus 2
it('matchesAnswer accepts a prompt that also holds the operator draft') // Review Focus 1
it('pumpDecision: working and needs-input wait; hibernated wakes; idle or undefined delivers')
it('restoreAfterBoot fails in-flight deliveries and keeps the cards open')
```

- [ ] **Step 2:** Run the file. Expected: FAIL.
- [ ] **Step 3: Implement.** `toCardView` fills `answerable` from `sessionOwnedByHarnu` and `optionDeliverable` from `isDeliverableText`.
- [ ] **Step 4:** Run the file. Expected: PASS.
- [ ] **Step 5: Commit** `feat(your-move): answer text rules`.

### Task 18: Delivery through the user-turn path

**Files:**

- Modify: `src/main/your-move/answer.ts`, `src/main/your-move/ipc.ts`, `src/main/browser/page-delivery.ts:20-33,75-77`, `src/renderer/src/stores/command-router.ts:329,502`, `src/renderer/src/stores/command-dispatch.ts:169-229`, `src/renderer/src/stores/your-move.ts`, `src/preload/index.ts`, `docs/user/sessions.md`, `CHANGELOG.md`
- Test: `tests/your-move/delivery.test.ts`

**Interfaces:**

- Consumes: `deliverUserTurn`, `waitForSessionReady`, `isHibernated`, `getTaskState`, `getBridge`.
- Produces:

```ts
export function createAnswerer(deps: {
  store: YourMoveStore
  deliver: typeof deliverUserTurn
  taskState(id: string): TaskState | undefined
  hibernated(id: string): boolean
  owned(id: string): boolean
  now(): number
  setTimer(fn: () => void, ms: number): unknown
}): {
  answer(cardId: string, req: AnswerRequest): Promise<{ ok: boolean; code?: string }>
  onTaskEvent(ev: HookTaskEvent): void
  onProcessGone(sessionId: string): void
}
```

`UserTurnPayload.source` gains `'your-move'`. `DeliveryDeps` gains optional `waitForComposerReady?(sessionId: string, ms: number): Promise<boolean>`, called after `waitForSessionReady`; the answerer supplies it from a `SessionStart` or idle observer with a 15 s cap (`prompt-inject-gate.ts` explains why process-ready is not composer-ready).

- [ ] **Step 1: Write the failing tests**

```ts
it('an idle session is delivered at once and the card stays open with delivery sent')
it('the card closes as answered only after the matching UserPromptSubmit')
it('no matching prompt within 30 s marks delivery failed not-confirmed; the card stays open')
it('a working session queues; the Stop edge delivers it')
it('a needs-input session queues: nothing is pasted into a dialog')
it('a parked session is woken, then waits for composer ready, then delivered')
it('wake timeout marks delivery failed wake-timeout and keeps the card')
it('process exit while queued marks process-gone')
it('a session with no Harnu process is refused and nothing is typed')
it('a second answer on a card already in flight is refused')
it('source your-move posts no page-event toast or Activity row')
```

- [ ] **Step 2:** Run the file. Expected: FAIL.
- [ ] **Step 3: Implement.** The store's `answer` becomes `window.api.yourMoveAnswer`; `looks-wrong` still opens the session. Delivery failure renders through `yourMove.delivery.*`.
- [ ] **Step 4:** Run it, `T tests/browser-page-watch-delivery.test.ts` and `T tests/command-router-user-turn.test.ts`. Expected: PASS.
- [ ] **Step 5:** `docs/user/sessions.md`; `CHANGELOG.md`. **Commit** `feat(your-move): answer from the card`.

### Task 19: Chime, push and reminders

**Files:**

- Create: `src/main/your-move/reach.ts`
- Modify: `src/main/your-move/ipc.ts`, `src/renderer/src/stores/your-move.ts`, `src/renderer/src/stores/sessions.ts` (a `notifyYourMove` beside `maybeNotify` at 4457), `src/renderer/src/stores/missions.ts:257-260`
- Test: `tests/your-move/reach.test.ts`

**Interfaces:**

- Produces:

```ts
export const REMINDER_MS: readonly number[] // 30 min, 1 h, 2 h, 4 h
export const WAVE_WINDOW_MS = 60_000
export type Cue =
  | { type: 'card'; cardId: string; sessionId: string; ask: string; reminder: boolean }
  | { type: 'wave'; count: number; sessionIds: string[] }
export function decideCues(
  s: YourMoveState,
  now: number,
  lastWaveCueAt: number | null
): { cues: Cue[]; next: YourMoveState; lastWaveCueAt: number | null }
```

Event `yourMove:cue` on a 5 s tick. Renderer: `notifyYourMove` runs `decideNotification('idle', 'needs-input', ...)`, `dispatchNotification`, and on the OS channel `pushSend`, so prefs, the selected-session rule and push opt-ins are the existing ones.

- [ ] **Step 1: Write the failing tests**

```ts
it('a new live card cues once; a later tick does not repeat it')
it('observe and mid-turn lanes never cue')
it('REMINDER_MS equals BLOCKING_NUDGE_MS from lib/mission-cue')
it('reminders fire at 30 min, 1 h, 2 h, 4 h after the previous one')
it('after the fourth, a reminder repeats every 4 h') // advance 40 h → 4 + 9 total
it('12 deaths in one tick are one wave cue') // Review Focus 4
it('12 judge failures in one tick are one wave cue')
it('a human-gate card does not cue when filed but does remind') // the needs-input path already chimed
it('selected session: card is shown, no sound') // decideNotification with isSelected
it(
  'in live mode the mission cue plays no sound for a mission whose item has a live card, and still posts its Activity row'
)
it('with live mode on but the folder switched off, the mission cue still sounds') // no card exists there, so muting would be silent
```

- [ ] **Step 2:** Run the file. Expected: FAIL.
- [ ] **Step 3: Implement.** In `missions.ts`, skip `playNotificationSound` and `requestAttention` only when an open live card exists for that mission item; every other case keeps the existing cue.
- [ ] **Step 4:** Run the file and `T tests/mission-cue.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(your-move): chime, push and reminders that never go silent`.

### Task 20: First-run notice, Live by default, retire the 10-minute path

**Files:**

- Modify: `src/main/your-move/prefs.ts`, `src/renderer/src/App.vue` (sticky toast beside the updater toasts at 1816), `src/renderer/src/components/SidebarReturnZone.vue`, `src/renderer/src/stores/closure-core.ts`, `src/renderer/src/stores/sessions.ts:51,2215-2225,6311`, `tests/closure.test.ts`, `design.md:2331-2371`, `src/renderer/src/i18n/en.json`, `pt-BR.json`, `docs/harnu-features.md` (marker bump: cards now reach the operator by default), `docs/user/settings.md`, `docs/user/sessions.md`, `CHANGELOG.md`
- Test: `tests/your-move/rollout.test.ts`

**Interfaces:**

- Produces: `DEFAULT_YOUR_MOVE_MODE = 'live'`, `export function shouldShowFirstRunNotice(p: YourMovePrefs): boolean` (`effectiveMode` is `live` and the notice is unseen).
  Notice copy, `en.json`: title "Your move is on"; body "Harnu reads each finished turn with a small Haiku call to catch anything waiting on you. It spends your own Claude quota, about US$ 0.0004 per inspection."; action "Turn it off". Translate into `pt-BR.json`.
- [ ] **Step 1: Confirm the exit criterion.** The maintainer has accepted a week of Observe cards. If not, stop here.
- [ ] **Step 2: Write the failing tests**

```ts
it('an install with no explicit mode reads live')
it('an install that chose off or observe keeps it')
it('the notice shows once for a default live install and never for off')
it('Turn it off writes mode off and marks the notice seen')
it('closure-core no longer exports selectForgotten or isAwaitingReturn')
it('FORGOTTEN_THRESHOLD_MS still exists for the fleet return-here state')
it('the zone renders cards only and the store has no forgottenSessions')
```

- [ ] **Step 3:** Run the file. Expected: FAIL.
- [ ] **Step 4: Edit `design.md`:** drop the legacy forgotten-session rule, × and the 168 px cap from the section.
- [ ] **Step 5: Implement.** Keep `FORGOTTEN_THRESHOLD_MS` and `fleet-state.ts:278`: Fleet rail states are a non-goal. Remove `sidebar.returnHere.dismiss` from both locales. Keep `markSessionSeen` if `git grep` still finds another caller.
- [ ] **Step 6:** Run the file, `T tests/closure.test.ts`, `T tests/floating-panels.test.ts`. Expected: PASS.
- [ ] **Step 7:** Docs and `CHANGELOG.md`. **Commit** `feat(your-move): Live by default with a first-run notice`.

**U5 exit:** the Global Constraints checks pass. In a second instance: a real prose question files a card, Go sends it and the card closes on `UserPromptSubmit`, a parked session wakes and answers, a reminder fires under fake-shortened intervals, and the operator has looked at the result.

---

## Self-review

- **Spec coverage.** Sources: Tasks 5, 8, 10, 11, 12, 13. Judge mechanics: 2, 3, 5, 7, 8, 9. Lifecycle: 1, 10, 11, 12, 18. Queue and buttons: 15, 16. Answering: 17, 18. Sound and reach: 19. Skill and verb: 13, 14. Rollout: 6, 9, 20. Gate v2 and its bar: 3, 4. Contracts: named per task.
- **Step scan.** Each test step names its tests and pinned values; each code step names signatures and files.
- **Type consistency.** `CardLane`, `StructuredDraft`, `CardView`, `AnswerRequest` and `reconcileSource` keep one spelling across tasks. `AnswerRequest` is declared in Task 15 and consumed in 17 and 18.
- **Review Focus.** Items 1 and 2 are pinned in Task 17, 3 in Task 6, 4 in Tasks 10 and 19, 5 in Task 8.
- **Proportion.** Signatures, test names and assertions, with bodies only where the spec fixes exact copy (gate wording, notice text) or where the harness needs the ground-truth formula.
