# T456 — Prototype and runs (`01-prototype.md`)

Companion to [`00-spec.md`](00-spec.md). Everything here was run on 2026-10-09 with the Claude Code
**2.1.295** binary this session runs (`~/.local/share/claude/versions/2.1.295`). The `claude` on
`PATH` is 2.1.296, and the types the spec cites are 2.1.295's, so every run below pins 2.1.295.
The sources lived in the session scratchpad (`<scratchpad>` below). `<worktree>` is this branch's
checkout. Two symlinks in the scratchpad keep the sources short: `wt` points at `<worktree>`, and
`pa-types` at the `plugin-authoring` skill's `types/` folder, which holds the 2.1.295
`claude-code.d.ts`. Every source was formatted with the repo's Prettier config before its final
run, so the blocks below are byte-for-byte what ran.

- §P1 — the **mod half**: a hooks module that answers `park.query` from in-process facts, its
  typed test, and the `validate` / `test` / `tsc` output; a negative control; the Settings → Mods
  chips.
- §P2 — the **host half's core** (pure): `decide`, `applyAnswer`, `resetEpisode`, `revalidate`,
  its vitest suite, and a mutation check of every guard.
- §P3 — the **policy-level reproduction** of the failure (spec §3.6).
- §P4 — the A1 measurement script, which was **not run** (refused in this session).

## P1. The mod half

In the shipped design this logic is one more `case` in the companion's closed command switch
(`resources/companion/hooks/register.ts:1012-1029`), with the facts kept in its `fleet` state key.
Here a slash command, `/park-probe`, stands in for the command channel, so `claude plugin test`
can drive it end to end. The command and its `command.run` hook are test scaffolding only (spec
§9.3).

### P1.1 Files

`.claude-plugin/plugin.json`

```json
{
  "name": "harnu-park-negotiator",
  "version": "0.1.0",
  "author": { "name": "Harnu" },
  "description": "T456 prototype: answers Harnu's park.query from in-process facts"
}
```

`hooks/hooks.json`

```json
{ "modules": ["./register.ts"] }
```

`hooks/register.ts`

```ts
import type { Register } from 'claude-code'

// T456 prototype: the mod half of negotiated hibernation. In the shipped design this logic lives in
// `resources/companion/` as one more `case` of the closed command switch (`park.query`); here a slash
// command stands in for the command channel so `claude plugin test` can drive it end to end.

/** One reason a session gives for not being parked now (spec §5.2). */
export type ParkBusyReason =
  | { kind: 'turn' }
  | { kind: 'permission'; count: number }
  | { kind: 'background-task'; count: number; types: string[] }
  | { kind: 'background-subagent'; count: number }
  | { kind: 'scheduled-wakeup'; count: number; recurring: number }
  | { kind: 'remote-surface'; surfaces: string[] }

/** `CommandResultData['park.query']` (spec §5.2). */
export type ParkQueryData = { busy: ParkBusyReason[]; retryAfterMs?: number }

type StopTask = { id: string; type: string }

/** What the mod keeps between events. The companion keeps it in its `fleet` state key. */
export interface ParkFacts {
  activeTurnId: string | null
  /**
   * One tool name per permission dialog shown to a person (`classic.PermissionRequest`) whose tool
   * has not settled yet. A `tool.check` verdict of `ask` is not used: in auto mode the classifier,
   * not a person, settles it.
   */
  asks: string[]
  /** The last main-thread `classic.Stop` snapshot, null before the first one. */
  lastStop: { tasks: StopTask[]; crons: { recurring: boolean }[] } | null
  /** Subagents that already stopped: the CLI still lists them as running in the next Stop. */
  stoppedAgents: string[]
}

const STOPPED_MAX = 32
/** As `fleet-sensor.ts` FINISHED: a task in one of these states holds nothing. */
const FINISHED = new Set(['completed', 'failed', 'killed', 'stopped', 'cancelled', 'error'])
const TYPES_MAX = 4
/** Hints, not orders: the host clamps every value (spec §6.2). */
const RETRY_TURN_MS = 120_000
const RETRY_PERMISSION_MS = 300_000

export function emptyFacts(): ParkFacts {
  return { activeTurnId: null, asks: [], lastStop: null, stoppedAgents: [] }
}

/** Pure: the answer to `park.query`, from the facts and the surfaces read at ask time. */
export function answerParkQuery(f: ParkFacts, surfaces: readonly string[]): ParkQueryData {
  const busy: ParkBusyReason[] = []
  const hints: number[] = []
  if (f.activeTurnId !== null) {
    busy.push({ kind: 'turn' })
    hints.push(RETRY_TURN_MS)
  }
  if (f.asks.length > 0) {
    busy.push({ kind: 'permission', count: f.asks.length })
    hints.push(RETRY_PERMISSION_MS)
  }
  const tasks = (f.lastStop?.tasks ?? []).filter(
    (t) => !(t.type === 'subagent' && f.stoppedAgents.includes(t.id))
  )
  const agents = tasks.filter((t) => t.type === 'subagent').length
  const others = tasks.filter((t) => t.type !== 'subagent')
  if (others.length > 0) {
    const types = [...new Set(others.map((t) => t.type))].slice(0, TYPES_MAX)
    busy.push({ kind: 'background-task', count: others.length, types })
  }
  if (agents > 0) busy.push({ kind: 'background-subagent', count: agents })
  const crons = f.lastStop?.crons ?? []
  if (crons.length > 0) {
    const recurring = crons.filter((c) => c.recurring).length
    busy.push({ kind: 'scheduled-wakeup', count: crons.length, recurring })
  }
  const remote = surfaces.filter((s) => s !== 'terminal')
  if (remote.length > 0) busy.push({ kind: 'remote-surface', surfaces: remote })
  return hints.length > 0 ? { busy, retryAfterMs: Math.min(...hints) } : { busy }
}

function stopTasks(raw: unknown): StopTask[] {
  if (!Array.isArray(raw)) return []
  const out: StopTask[] = []
  for (const t of raw) {
    if (t === null || typeof t !== 'object') continue
    const { id, type, status } = t as { id?: unknown; type?: unknown; status?: unknown }
    if (FINISHED.has(String(status))) continue
    if (typeof id === 'string' && typeof type === 'string') out.push({ id, type })
  }
  return out
}

function stopCrons(raw: unknown): { recurring: boolean }[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((c) => c !== null && typeof c === 'object')
    .map((c) => ({ recurring: (c as { recurring?: unknown }).recurring === true }))
}

/** The oldest open dialog for this tool is over once the tool settles, whichever way. */
function settle(asks: readonly string[], tool: string): string[] {
  const i = asks.indexOf(tool)
  return i < 0 ? [...asks] : [...asks.slice(0, i), ...asks.slice(i + 1)]
}

let facts: ParkFacts = emptyFacts()

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    facts = emptyFacts()
    await $.command.register({
      name: 'park-probe',
      description: 'T456 prototype: what this session would answer to park.query'
    })
    return next(e)
  })

  // The stand-in for `case 'park.query'`: surfaces are read at ask time, everything else is kept.
  on('command.run', { command: 'park-probe' }, async ($) => {
    const data = answerParkQuery(facts, await $.session.surfaces())
    return { text: JSON.stringify(data) }
  })

  on('turn.start', ($, e, next) => {
    facts = { ...facts, activeTurnId: e.turnId }
    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    // A subagent's turn ends inside the main turn; only the main loop's end clears it.
    if (e.agentId === undefined) facts = { ...facts, activeTurnId: null, asks: [] }
    return next(e)
  })

  // Observe-only at gating sites: a failure here must not change the answer (spec §9.2).
  on('classic.PermissionRequest', ($, e, next) => {
    facts = { ...facts, asks: [...facts.asks, e.tool_name] }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.PostToolUse', ($, e, next) => {
    facts = { ...facts, asks: settle(facts.asks, e.tool_name) }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.PostToolUseFailure', ($, e, next) => {
    facts = { ...facts, asks: settle(facts.asks, e.tool_name) }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.Stop', ($, e, next) => {
    facts = {
      ...facts,
      lastStop: { tasks: stopTasks(e.background_tasks), crons: stopCrons(e.session_crons) }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.SubagentStop', ($, e, next) => {
    facts = { ...facts, stoppedAgents: [...facts.stoppedAgents, e.agent_id].slice(-STOPPED_MAX) }
    return next(e)
  }).catch(($, e, next) => next(e))
}
```

`tests/park.test.ts`

```ts
import type { On } from 'claude-code'
import { expect, test, type ClassicFields, type Engine } from 'claude-code/testing'
import type { ParkQueryData } from '../hooks/register'

const base = { session_id: 's-1', transcript_path: '/tmp/x.jsonl', cwd: '/tmp/x' }
const START = { cwd: '/tmp/x', surface: 'terminal', isInteractive: true } as const
type Surface = 'terminal' | 'desktop' | 'mobile' | 'vscode'

/** The engine's own answers beneath the plugin; `surfaces` is what `$.session.surfaces()` reads. */
function engine(on: On, surfaces: Surface[] = ['terminal']): void {
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('session.surfaces', async () => ({ value: surfaces }))
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', async () => ({ text: '' }))
  on('classic.PermissionRequest', async () => ({}))
  on('classic.PostToolUse', async () => ({}))
  on('classic.PostToolUseFailure', async () => ({}))
  on('classic.Stop', async () => ({}))
  on('classic.SubagentStop', async () => ({}))
}

async function probe($: Engine): Promise<ParkQueryData> {
  const r = await $.command.run({
    command: 'park-probe',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 }
  })
  return JSON.parse(r.text ?? '{}') as ParkQueryData
}

type StopFields = ClassicFields<'Stop'>
const stop = (
  background_tasks: NonNullable<StopFields['background_tasks']>,
  session_crons: NonNullable<StopFields['session_crons']> = []
): StopFields => ({ ...base, stop_hook_active: false, background_tasks, session_crons })

test('an idle session with nothing running is not busy', async ($, on) => {
  engine(on)
  await $.session.start(START)
  await $.classic.Stop(stop([], []))
  expect(await probe($)).toEqual({ busy: [] })
})

test('background shell, monitor and a wakeup from the last Stop', async ($, on) => {
  engine(on)
  await $.session.start(START)
  await $.classic.Stop(
    stop(
      [
        { id: 'b1', type: 'shell', status: 'running', description: 'push', command: 'git push' },
        { id: 'm1', type: 'monitor', status: 'running', description: 'ci' },
        { id: 'b0', type: 'shell', status: 'completed', description: 'old' }
      ],
      [{ id: 'c1', schedule: '30 14 9 10 *', recurring: false, prompt: '/loop' }]
    )
  )
  const a = await probe($)
  expect(a.busy).toEqual([
    { kind: 'background-task', count: 2, types: ['shell', 'monitor'] },
    { kind: 'scheduled-wakeup', count: 1, recurring: 0 }
  ])
  expect(a.retryAfterMs).toBeUndefined()
  // No command text or prompt leaves the mod: counts and type labels only.
  expect(JSON.stringify(a)).not.toContain('git push')
})

test('a subagent that already stopped is not counted', async ($, on) => {
  engine(on)
  await $.session.start(START)
  await $.classic.SubagentStop({
    ...base,
    stop_hook_active: false,
    agent_id: 'a1',
    agent_transcript_path: '/tmp/a1.jsonl',
    agent_type: 'general-purpose'
  })
  await $.classic.Stop(
    stop([
      { id: 'a1', type: 'subagent', status: 'running', description: 'done already' },
      { id: 'a2', type: 'subagent', status: 'running', description: 'still going' }
    ])
  )
  expect((await probe($)).busy).toEqual([{ kind: 'background-subagent', count: 1 }])
})

test('a turn in flight is busy, and its end clears it', async ($, on) => {
  engine(on)
  await $.session.start(START)
  await $.turn.start({ text: 'p', turnId: 't1' })
  expect(await probe($)).toEqual({ busy: [{ kind: 'turn' }], retryAfterMs: 120_000 })
  await $.turn.complete({
    answer: '',
    durationMs: 1,
    isAborted: false,
    turnId: 't1',
    reason: 'answer'
  } as Parameters<Engine['turn']['complete']>[0])
  expect(await probe($)).toEqual({ busy: [] })
})

test('a permission dialog shown to a person is busy until its tool settles', async ($, on) => {
  engine(on)
  await $.session.start(START)
  await $.classic.PermissionRequest({
    ...base,
    tool_name: 'Bash',
    tool_input: { command: 'git push' }
  })
  expect((await probe($)).busy).toEqual([{ kind: 'permission', count: 1 }])
  await $.classic.PostToolUse({
    ...base,
    tool_name: 'Bash',
    tool_input: {},
    tool_response: {},
    tool_use_id: 'u1'
  })
  expect((await probe($)).busy).toEqual([])
})

test('a denied or failed tool settles its dialog too', async ($, on) => {
  engine(on)
  await $.session.start(START)
  await $.classic.PermissionRequest({ ...base, tool_name: 'Bash', tool_input: {} })
  await $.classic.PermissionRequest({ ...base, tool_name: 'Edit', tool_input: {} })
  expect((await probe($)).busy).toEqual([{ kind: 'permission', count: 2 }])
  await $.classic.PostToolUseFailure({
    ...base,
    tool_name: 'Bash',
    tool_input: {},
    tool_use_id: 'u2',
    error: 'denied'
  })
  expect((await probe($)).busy).toEqual([{ kind: 'permission', count: 1 }])
})

test('an attached phone is busy, read at ask time', async ($, on) => {
  engine(on, ['terminal', 'mobile'])
  await $.session.start(START)
  expect((await probe($)).busy).toEqual([{ kind: 'remote-surface', surfaces: ['mobile'] }])
})
```

The test is typed against the kit: `Engine` from `claude-code/testing`, `On` from `claude-code`,
and the kit's `ClassicFields<E>` for classic inputs, which stamps the envelope fields itself
(TYPES 14939). Its `engine()` answers, beneath the plugin, every event and `$` call the plugin
reaches, because the kit has no bottom of its own for them (REF 81). Two gotchas from T447 shaped
it: no `'x' in $` anywhere, and every `$` the module calls is stubbed (`command.register`,
`session.surfaces`). The module calls no `$.clock`, so it needs no `clock.now` stub.

### P1.2 `claude plugin validate`

```text
$ claude plugin validate <scratchpad>/harnu-park-negotiator
Validating plugin manifest: <scratchpad>/harnu-park-negotiator/.claude-plugin/plugin.json

Validating hooks: <scratchpad>/harnu-park-negotiator/hooks/hooks.json

  ❯ ./register.ts hooks: session.start, command.run{command=park-probe}, turn.start, turn.complete, classic.PermissionRequest, classic.PostToolUse, classic.PostToolUseFailure, classic.Stop, classic.SubagentStop
  ❯ ./register.ts answers its own command: command.run{command=park-probe}
  ❯ ./register.ts gating hook with .catch: classic.PermissionRequest
  ❯ ./register.ts gating hook with .catch: classic.PostToolUse
  ❯ ./register.ts gating hook with .catch: classic.PostToolUseFailure
  ❯ ./register.ts gating hook with .catch: classic.Stop
  ❯ ./register.ts gating hook with .catch: classic.SubagentStop
  ❯ ./register.ts calls: $.command.register, $.session.surfaces

✔ Validation passed
```

### P1.3 `claude plugin test`

```text
$ claude plugin test <scratchpad>/harnu-park-negotiator

tests/park.test.ts:
(pass) an idle session with nothing running is not busy [26.19ms]
(pass) background shell, monitor and a wakeup from the last Stop [18.62ms]
(pass) a subagent that already stopped is not counted [11.83ms]
(pass) a turn in flight is busy, and its end clears it [11.61ms]
(pass) a permission dialog shown to a person is busy until its tool settles [11.52ms]
(pass) a denied or failed tool settles its dialog too [11.19ms]
(pass) an attached phone is busy, read at ask time [11.60ms]

 7 pass
 0 fail
Ran 7 tests across 1 file. [0.20s]
```

**Negative control.** The same module with its `classic.Stop` hook deleted, against the same test
file. The two tests that depend on the Stop snapshot fail and the other five pass, so those tests
exercise the hook rather than passing by default:

```text
(pass) an idle session with nothing running is not busy [25.83ms]
(fail) background shell, monitor and a wakeup from the last Stop [11.97ms]
(fail) a subagent that already stopped is not counted [11.63ms]
(pass) a turn in flight is busy, and its end clears it [11.55ms]
(pass) a permission dialog shown to a person is busy until its tool settles [11.94ms]
(pass) a denied or failed tool settles its dialog too [11.63ms]
(pass) an attached phone is busy, read at ask time [10.50ms]
 5 pass
 2 fail
```

### P1.4 Type-check

`tsconfig.json`, kept outside the mod folder, with the options from the types file's header
(`claude-code.d.ts` lines 67-76):

```json
{
  "compilerOptions": {
    "target": "es2023",
    "lib": ["es2023"],
    "types": [],
    "module": "esnext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "skipLibCheck": true,
    "jsx": "react",
    "jsxFactory": "h",
    "jsxFragmentFactory": "Fragment"
  },
  "include": [
    "../pa-types/claude-code.d.ts",
    "../harnu-park-negotiator/hooks",
    "../harnu-park-negotiator/tests"
  ]
}
```

```text
$ <worktree>/node_modules/.bin/tsc -p <scratchpad>/tsc    # TypeScript 5.9.3
exit 0
```

`tsc --listFilesOnly` confirms that the run included `hooks/register.ts`, `tests/park.test.ts` and
the 2.1.295 types.

### P1.5 Settings → Mods chips

The real `parseValidateReport` and `deriveCapabilities` from `src/main/mods-audit-core.ts` (its
only import is `node:path`) were run, through Node 22's type stripping, on two
`claude plugin validate --json` reports. The first is the prototype's. The second is a copy of the
companion Harnu staged on this machine (`~/.config/harnu/companion/0.1.0/harnu-companion`). The
source tree's `resources/companion` does not validate on its own, because `hooks/coords.gen.ts` is
generated at build time (`scripts/ci/mod-step.mjs:81`). The staged copy was diffed against the
source at this branch's HEAD with `diff -rq`. `hooks/`, `.claude-plugin/` and `types/index.d.ts`
are identical. The copy adds only `hooks/coords.gen.ts`, a `.stamp` and a `tsconfig.json`, and it
lacks `tests/`, `api-surface.json` and `.gitignore`.

`chips.mts`

```ts
import { parseValidateReport, deriveCapabilities } from './wt/src/main/mods-audit-core.ts'
import { readFileSync } from 'node:fs'
for (const f of process.argv.slice(2)) {
  const p = parseValidateReport(JSON.parse(readFileSync(f, 'utf8')))
  console.log(
    f.split('/').pop(),
    'ok=' + p.ok,
    'hooks=' + p.hooks.map((h) => h.event).join(','),
    '\n  calls=' + p.calls.map((c) => c.op).join(','),
    '\n  chips=' + JSON.stringify(deriveCapabilities(p))
  )
}
```

```text
$ node --experimental-strip-types chips.mts validate.json validate-companion.json
validate.json ok=true hooks=session.start,command.run,turn.start,turn.complete,classic.PermissionRequest,classic.PostToolUse,classic.PostToolUseFailure,classic.Stop,classic.SubagentStop
  calls=command.register,session.surfaces
  chips=["prompts","permissions"]
validate-companion.json ok=true hooks=session.start,classic.SessionStart,session.end,prompt.submit,turn.start,turn.complete,tool.check,classic.PermissionRequest,classic.Notification,classic.PostToolUse,classic.Stop,classic.SubagentStart,classic.SubagentStop,classic.PostToolUseFailure,classic.StopFailure,session.measure,plugin.register
  calls=clock.after,clock.every,clock.now,clock.sleep,env.get,fs.read,http.fetch,session.compact,session.id,session.model,session.usage,session.version,state.get,state.set,turn.abort,ui.status,ui.toast
  chips=["network","files","prompts","permissions","gate","env"]
```

## P2. The host half's core

Pure, with `now` injected, in the style of `fleet-policy.ts`. The coordinator around it
(`requestPark`, the enqueue and the 5 s race, the ledger write) is specified in spec §5.1, §5.6 and
§9.2, and is not prototyped. The suite runs with the repo's vitest (2.1.9). The scratchpad's
`host-core/node_modules` is a symlink to the worktree's.

`park-negotiation-core.ts`

```ts
// T456 host-side core sketch (spec §6). PURE: no electron, no clock; `now` is injected.

export type ParkCause = 'cap' | 'sweep' | 'manual'

/** What the session said, or that it said nothing. */
export type Answer =
  { kind: 'busy'; reasons: string[]; retryAfterMs?: number } | { kind: 'free' } | { kind: 'silent' } // timeout, NO_BINDING, MODE_SHADOW, CMD_* — anything but a result

/** One cold episode of one session: opened by the first decline, closed by a reset edge. */
export interface Episode {
  firstDeclineAt: number
  declines: number
  /** No question and no park before this. */
  until: number
  reasons: string[]
}

export interface NegotiationSettings {
  enabled: boolean
  maxDeclines: number
  maxDeferMs: number
  pressureFloorMb: number
}

export interface DecideInput {
  now: number
  cause: ParkCause
  episode: Episode | null
  settings: NegotiationSettings
  memAvailableMb: number | null
}

export type Decision =
  | { action: 'park'; why: 'operator' | 'disabled' | 'memory-pressure' | 'limit' }
  | { action: 'defer'; why: 'deferred' }
  | { action: 'ask' }

export const NEG_QUERY_WAIT_MS = 5_000
export const NEG_RETRY_MIN_MS = 60_000
export const NEG_RETRY_MAX_MS = 1_800_000
export const NEG_RETRY_DEFAULT_MS = 600_000

export const DEFAULT_NEGOTIATION: NegotiationSettings = {
  enabled: true,
  maxDeclines: 8,
  maxDeferMs: 2 * 60 * 60_000,
  pressureFloorMb: 1_536
}

function exhausted(ep: Episode, now: number, s: NegotiationSettings): boolean {
  return ep.declines >= s.maxDeclines || now - ep.firstDeclineAt >= s.maxDeferMs
}

/**
 * Before the question: must we park, are we inside a granted delay, or do we consult the session?
 * `ask` means "consult": `park.query` where the channel can carry it, else the answer is `silent`
 * and the legacy Stop facts stand in (`applyAnswer`). Either way a busy answer opens or advances the
 * episode.
 */
export function decide(i: DecideInput): Decision {
  if (i.cause === 'manual') return { action: 'park', why: 'operator' }
  if (!i.settings.enabled) return { action: 'park', why: 'disabled' }
  if (i.memAvailableMb !== null && i.memAvailableMb < i.settings.pressureFloorMb) {
    return { action: 'park', why: 'memory-pressure' }
  }
  if (i.episode && exhausted(i.episode, i.now, i.settings)) return { action: 'park', why: 'limit' }
  if (i.episode && i.now < i.episode.until) return { action: 'defer', why: 'deferred' }
  return { action: 'ask' }
}

/** After the question (or the legacy facts standing in for it): the next episode, or null to park. */
export function applyAnswer(
  ep: Episode | null,
  answer: Answer,
  legacyBusy: string[],
  now: number,
  s: NegotiationSettings
): Episode | null {
  const busy = answer.kind === 'busy' ? answer.reasons : answer.kind === 'silent' ? legacyBusy : []
  if (busy.length === 0) return null
  const firstDeclineAt = ep?.firstDeclineAt ?? now
  const hint = answer.kind === 'busy' ? answer.retryAfterMs : undefined
  const wait = Math.min(NEG_RETRY_MAX_MS, Math.max(NEG_RETRY_MIN_MS, hint ?? NEG_RETRY_DEFAULT_MS))
  return {
    firstDeclineAt,
    declines: (ep?.declines ?? 0) + 1,
    // Never past the episode's ceiling: the bound is exact, not "ceiling plus one retry".
    until: Math.min(now + wait, firstDeclineAt + s.maxDeferMs),
    reasons: busy
  }
}

/**
 * The edges that may close an episode. Both come from Harnu's own side, never from the mod's
 * sensor traffic: the renderer's focus push, and the legacy `UserPromptSubmit` hook, which is always
 * installed (ARB-1) and carries `source` (types 14661-14667; may be absent while it rolls out).
 */
export type ResetEdge =
  | { kind: 'focus' }
  | {
      kind: 'prompt'
      source?: 'user' | 'sdk' | 'system' | 'loop_wakeup' | 'schedule_wakeup' | 'poll_event'
    }

/**
 * Only a person ends an episode: selecting the session, or typing into it. A wakeup, a task
 * notification or an unlabelled prompt keeps the budget running, so a session whose own crons keep
 * waking it cannot renew its hold for ever.
 */
export function resetEpisode(ep: Episode | null, edge: ResetEdge): Episode | null {
  if (ep === null) return null
  if (edge.kind === 'focus') return null
  return edge.source === 'user' ? null : ep
}

/** What the coordinator reads about the session right before the kill. */
export interface ParkSnapshot {
  ptyId: string
  isSelected: boolean
  lastFocusedAt: number
  /** PTY bytes (`pty.ts` flushNow). */
  lastActivityAt: number
  /** The last legacy `UserPromptSubmit` edge, of any source; null when none was seen. */
  lastPromptAt: number | null
}

export type Revalidation =
  | { ok: true }
  | { ok: false; why: 'gone' | 'respawned' | 'prompted' | 'selected' | 'focused' | 'active' }

/**
 * The check between the answer and `hibernateSession` (spec §5.6). The question opened an async
 * gap of up to `NEG_QUERY_WAIT_MS`; anything that would have kept the session off the victim list
 * then cancels the park now. Manual parks only check that it is the same process.
 */
export function revalidate(
  cause: ParkCause,
  requestedAt: number,
  before: ParkSnapshot,
  now: ParkSnapshot | null
): Revalidation {
  if (now === null) return { ok: false, why: 'gone' }
  if (now.ptyId !== before.ptyId) return { ok: false, why: 'respawned' }
  if (cause === 'manual') return { ok: true }
  if (now.lastPromptAt !== null && now.lastPromptAt > requestedAt) {
    return { ok: false, why: 'prompted' }
  }
  if (now.isSelected) return { ok: false, why: 'selected' }
  if (now.lastFocusedAt > requestedAt) return { ok: false, why: 'focused' }
  if (now.lastActivityAt > requestedAt) return { ok: false, why: 'active' }
  return { ok: true }
}
```

`park-negotiation-core.test.ts`

```ts
import { describe, expect, test } from 'vitest'
import {
  DEFAULT_NEGOTIATION as S,
  NEG_RETRY_DEFAULT_MS,
  NEG_RETRY_MAX_MS,
  NEG_RETRY_MIN_MS,
  applyAnswer,
  decide,
  resetEpisode,
  revalidate,
  type Answer,
  type Episode,
  type NegotiationSettings,
  type ParkSnapshot,
  type ResetEdge
} from './park-negotiation-core'

const MIN = 60_000
const H = 60 * MIN
const busy = (retryAfterMs?: number): Answer => ({
  kind: 'busy',
  reasons: ['background-task'],
  ...(retryAfterMs !== undefined ? { retryAfterMs } : {})
})

/**
 * Drives the core the way the coordinator would: the sweep every 60 s over a session that is a
 * candidate whenever `eligible(t)` says so, answered by `answer(t)`, with `edges(t)` as the reset
 * edges seen at minute t. Returns when it was parked and how many questions it took.
 */
function drive(opts: {
  settings?: NegotiationSettings
  answer: (t: number) => Answer
  eligible?: (t: number) => boolean
  edges?: (t: number) => ResetEdge[]
  memAvailableMb?: number | null
  hours?: number
}) {
  const s = opts.settings ?? S
  let ep: Episode | null = null
  let questions = 0
  let firstDeclineAt: number | null = null
  for (let t = 0; t <= (opts.hours ?? 12) * H; t += MIN) {
    for (const e of opts.edges?.(t) ?? []) ep = resetEpisode(ep, e)
    if (opts.eligible && !opts.eligible(t)) continue
    const d = decide({
      now: t,
      cause: 'sweep',
      episode: ep,
      settings: s,
      memAvailableMb: opts.memAvailableMb ?? null
    })
    if (d.action === 'park') return { parkedAt: t, why: d.why, questions, firstDeclineAt }
    if (d.action === 'ask') {
      questions++
      ep = applyAnswer(ep, opts.answer(t), [], t, s)
      if (ep === null) return { parkedAt: t, why: 'free', questions, firstDeclineAt }
      firstDeclineAt ??= ep.firstDeclineAt
    }
  }
  return { parkedAt: null, why: null, questions, firstDeclineAt }
}

describe('the bound: a mod that never stops saying busy is parked anyway', () => {
  test('after maxDeclines questions when it asks to be asked again soon', () => {
    const r = drive({ answer: () => busy(1) })
    expect(r).toMatchObject({ why: 'limit', questions: S.maxDeclines })
    expect(r.parkedAt).toBe(S.maxDeclines * NEG_RETRY_MIN_MS)
  })

  test('after maxDeferMs when declines alone would never run out', () => {
    const r = drive({ settings: { ...S, maxDeclines: 1_000 }, answer: () => busy(H) })
    expect(r.why).toBe('limit')
    expect(r.parkedAt).toBe(S.maxDeferMs)
  })

  test('the hold past the first decline never exceeds maxDeferMs, whatever the hint', () => {
    for (const hint of [undefined, 1, 59_000, 10 * MIN, 29 * MIN, H, 10 * H]) {
      const r = drive({ settings: { ...S, maxDeclines: 1_000 }, answer: () => busy(hint) })
      expect(r.parkedAt).not.toBeNull()
      expect((r.parkedAt ?? 0) - (r.firstDeclineAt ?? 0)).toBeLessThanOrEqual(S.maxDeferMs)
    }
  })

  test('memory under the floor parks at once and asks nothing', () => {
    const r = drive({ answer: () => busy(), memAvailableMb: S.pressureFloorMb - 1 })
    expect(r).toMatchObject({ parkedAt: 0, why: 'memory-pressure', questions: 0 })
  })

  test('memory at the floor is not pressure', () => {
    const r = drive({ answer: () => busy(), memAvailableMb: S.pressureFloorMb })
    expect(r.why).toBe('limit')
  })

  test('memory pressure overrides an episode inside its granted delay', () => {
    const ep = applyAnswer(null, busy(NEG_RETRY_MAX_MS), [], 0, S)
    const d = decide({ now: MIN, cause: 'sweep', episode: ep, settings: S, memAvailableMb: 1 })
    expect(d).toEqual({ action: 'park', why: 'memory-pressure' })
  })
})

describe('decide', () => {
  test('Park now parks without a question', () => {
    const ep = applyAnswer(null, busy(), [], 0, S)
    expect(
      decide({ now: 0, cause: 'manual', episode: ep, settings: S, memAvailableMb: null })
    ).toEqual({ action: 'park', why: 'operator' })
  })

  test('the switch off is today’s behaviour', () => {
    const off = { ...S, enabled: false }
    expect(
      decide({ now: 0, cause: 'sweep', episode: null, settings: off, memAvailableMb: null })
    ).toEqual({ action: 'park', why: 'disabled' })
  })

  test('inside a granted delay there is no question and no park', () => {
    const ep = applyAnswer(null, busy(), [], 0, S)
    expect(
      decide({ now: MIN, cause: 'sweep', episode: ep, settings: S, memAvailableMb: null })
    ).toEqual({ action: 'defer', why: 'deferred' })
  })
})

describe('applyAnswer', () => {
  test('free and silent-with-no-facts both park', () => {
    expect(applyAnswer(null, { kind: 'free' }, [], 0, S)).toBeNull()
    expect(applyAnswer(null, { kind: 'silent' }, [], 0, S)).toBeNull()
  })

  test('silent falls back to the legacy Stop facts', () => {
    expect(applyAnswer(null, { kind: 'silent' }, ['scheduled-wakeup'], 0, S)).toMatchObject({
      declines: 1,
      until: NEG_RETRY_DEFAULT_MS,
      reasons: ['scheduled-wakeup']
    })
  })

  test('a granted delay never ends past the episode ceiling (the tooltip reads `until`)', () => {
    const late = applyAnswer(null, busy(), [], 0, S) as Episode
    const next = applyAnswer(late, busy(NEG_RETRY_MAX_MS), [], S.maxDeferMs - MIN, S)
    expect(next?.until).toBe(S.maxDeferMs)
  })

  test('a hint is clamped to [NEG_RETRY_MIN_MS, NEG_RETRY_MAX_MS]', () => {
    expect(applyAnswer(null, busy(1), [], 0, S)?.until).toBe(NEG_RETRY_MIN_MS)
    expect(applyAnswer(null, busy(10 * H), [], 0, S)?.until).toBe(NEG_RETRY_MAX_MS)
    expect(applyAnswer(null, busy(), [], 0, S)?.until).toBe(NEG_RETRY_DEFAULT_MS)
  })
})

describe('the episode reset', () => {
  const ep = applyAnswer(null, busy(), [], 0, S)

  test('the operator selecting the session ends it', () => {
    expect(resetEpisode(ep, { kind: 'focus' })).toBeNull()
  })

  test('a prompt typed by a person ends it', () => {
    expect(resetEpisode(ep, { kind: 'prompt', source: 'user' })).toBeNull()
  })

  test('a wakeup, a notification or an unlabelled prompt does not', () => {
    for (const source of ['schedule_wakeup', 'loop_wakeup', 'system', 'sdk', undefined] as const) {
      expect(resetEpisode(ep, { kind: 'prompt', source })).toBe(ep)
    }
  })

  // A recurring cron: each fire runs a turn (2 min of work), then the session is cold again and,
  // under `cap` pressure, a candidate after `lruIdleMs` (15 min). It answers busy (a scheduled
  // wakeup) every time it is asked. `source` is what the legacy `UserPromptSubmit` of each fire says.
  const cron = (source: 'schedule_wakeup' | 'user', everyMin: number) => {
    const every = everyMin * MIN
    const lastFire = (t: number) => Math.floor(t / every) * every
    return drive({
      answer: () => busy(),
      eligible: (t) => t - (lastFire(t) + 2 * MIN) > 15 * MIN,
      edges: (t) => (t > 0 && t % every === 0 ? [{ kind: 'prompt', source }] : []),
      hours: 12
    })
  }

  test.each([60, 90, 150])(
    'a recurring cron every %i min cannot renew the hold under cap pressure',
    (everyMin) => {
      const r = cron('schedule_wakeup', everyMin)
      expect(r.why).toBe('limit')
      expect((r.parkedAt ?? Infinity) - (r.firstDeclineAt ?? 0)).toBeLessThanOrEqual(S.maxDeferMs)
    }
  )

  test('a person typing every hour keeps the same session live', () => {
    expect(cron('user', 60).parkedAt).toBeNull()
  })
})

describe('revalidate, right before the kill', () => {
  const t0 = 1_000 * MIN
  const before: ParkSnapshot = {
    ptyId: 'p1',
    isSelected: false,
    lastFocusedAt: t0 - H,
    lastActivityAt: t0 - H,
    lastPromptAt: t0 - H
  }

  test('nothing happened in the gap: park', () => {
    expect(revalidate('sweep', t0, before, { ...before })).toEqual({ ok: true })
  })

  test.each([
    ['prompted', { lastPromptAt: t0 + 1_000 }],
    ['selected', { isSelected: true }],
    ['focused', { lastFocusedAt: t0 + 1_000 }],
    ['active', { lastActivityAt: t0 + 1_000 }],
    ['respawned', { ptyId: 'p2' }]
  ] as const)('%s in the gap cancels a sweep park', (why, change) => {
    expect(revalidate('sweep', t0, before, { ...before, ...change })).toEqual({ ok: false, why })
  })

  test('a session already gone is not killed twice', () => {
    expect(revalidate('cap', t0, before, null)).toEqual({ ok: false, why: 'gone' })
  })

  test('Park now only checks it is the same process', () => {
    expect(revalidate('manual', t0, before, { ...before, isSelected: true })).toEqual({ ok: true })
    expect(revalidate('manual', t0, before, { ...before, ptyId: 'p2' })).toEqual({
      ok: false,
      why: 'respawned'
    })
  })
})
```

```text
$ ./node_modules/.bin/vitest run --root .
✓ park-negotiation-core.test.ts (28 tests) 11ms
Tests  28 passed (28)
```

```text
$ tsc --noEmit --strict --target es2023 --module esnext --moduleResolution bundler \
    --types node park-negotiation-core.ts park-negotiation-core.test.ts
exit 0
```

**Mutation check.** `mutate.py` removes one guard from a copy of the core in a sibling folder.
The unchanged suite is then run against that copy, once per mutant. Every mutant is caught:

```python
# Applies one named mutant to park-negotiation-core.ts in a copy dir and prints it. Usage: mutate.py <src> <dst> <name>
import sys
src, dst, name = sys.argv[1:4]
s = open(src).read()
M = {
  'no-maxDeclines': ('ep.declines >= s.maxDeclines || ', ''),
  'no-maxDeferMs': (' || now - ep.firstDeclineAt >= s.maxDeferMs', ''),
  'no-memory-floor': ('i.memAvailableMb !== null && i.memAvailableMb < i.settings.pressureFloorMb', 'false'),
  'no-until-cap': ('until: Math.min(now + wait, firstDeclineAt + s.maxDeferMs)', 'until: now + wait'),
  'reset-on-any-prompt': ("return edge.source === 'user' ? null : ep", 'return null'),
  'no-revalidate-prompt': ('now.lastPromptAt !== null && now.lastPromptAt > requestedAt', 'false'),
}
a, b = M[name]
assert a in s, name
open(dst, 'w').write(s.replace(a, b))
```

```text
no-maxDeclines: Tests  1 failed | 27 passed (28)
no-maxDeferMs: Tests  2 failed | 26 passed (28)
no-memory-floor: Tests  2 failed | 26 passed (28)
no-until-cap: Tests  1 failed | 27 passed (28)
reset-on-any-prompt: Tests  2 failed | 26 passed (28)
no-revalidate-prompt: Tests  1 failed | 27 passed (28)
```

## P3. The failure, reproduced against the shipped policy

`repro.mts` imports the shipped `src/main/fleet-policy.ts` unchanged. It is a leaf module with no
imports, so Node 22 runs it with type stripping. The script feeds it the `LiveSession` shape that
`pty.ts:583-610` builds. Each row's `taskState` is what the hub reports for that situation. What
each row rests on (A1, A1b) is stated in spec §3.6.

```ts
// Feeds the shipped pure policy the snapshot pty.ts#fleetSnapshot builds for sessions whose work
// runs outside a turn. Each row's `taskState` is what the hub reports for that case (spec §3.6).
import { evaluateFleet, explainFleet, DEFAULT_POLICY } from '../wt/src/main/fleet-policy.ts'
const now = 10_000_000_000
const min = 60_000
const s = (key: string, idleMin: number, taskState: 'idle' | 'working' = 'idle') => ({
  sessionKey: key,
  kind: 'claude-resume' as const,
  taskState,
  lastFocusedAt: now - idleMin * min,
  lastActivityAt: now - idleMin * min,
  isSelected: false,
  hasPendingApproval: false
})
const warm = [s('a', 1), s('b', 2), s('c', 3), s('d', 4)] // four busy siblings: the fleet is at maxLive
// 1) cap: cold 16 min with a background e2e run started in its last turn (a background shell
//    does not hold the hub state).
console.log(
  '1 cap   bg shell, 16 min  :',
  evaluateFleet([s('bg-e2e', 16), ...warm], now, DEFAULT_POLICY, 'cap')
)
// 2) cap: cold 16 min waiting on a ScheduleWakeup (clamped to 60-3600 s, so the sweep, which needs
//    more than 60 min, never reaches it; the cap does).
console.log(
  '2 cap   wakeup, 16 min    :',
  evaluateFleet([s('loop-wakeup', 16), ...warm], now, DEFAULT_POLICY, 'cap')
)
console.log(
  '2 sweep wakeup, 60 min    :',
  evaluateFleet([s('loop-wakeup', 60)], now, DEFAULT_POLICY, 'sweep')
)
// 3) sweep: a CronCreate job every 90 min, 61 min after its last fire.
console.log(
  '3 sweep cron/90, 61 min   :',
  evaluateFleet([s('cron-every-90m', 61)], now, DEFAULT_POLICY, 'sweep')
)
// 4) sweep: a background subagent holds `working`, which only buys the strict threshold.
console.log(
  '4 sweep bg agent, 61 min  :',
  evaluateFleet([s('bg-agent', 61, 'working')], now, DEFAULT_POLICY, 'sweep')
)
console.log(
  'explain row 1             :',
  JSON.stringify(explainFleet([s('bg-e2e', 16)], now, DEFAULT_POLICY)[0])
)
```

```text
$ node --experimental-strip-types repro.mts
1 cap   bg shell, 16 min  : [ 'bg-e2e' ]
2 cap   wakeup, 16 min    : [ 'loop-wakeup' ]
2 sweep wakeup, 60 min    : []
3 sweep cron/90, 61 min   : [ 'cron-every-90m' ]
4 sweep bg agent, 61 min  : [ 'bg-agent' ]
explain row 1             : {"sessionKey":"bg-e2e","parkable":true,"idleMs":960000,"reason":"lru","sweepRank":null}
```

## P4. The A1 measurement (not run)

This script would settle assumption A1: does an idle interactive `claude` with a background task
emit PTY bytes? It spawns `claude --model haiku` under a pseudo-terminal in an empty scratch folder,
with a minimal environment (no Harnu tokens, so no companion binding). It asks for one
`sleep 300` with `run_in_background`, then counts the bytes per 10 s window for 230 s, and kills
the process and its descendants. Starting it was **refused by this session's permission classifier**
(it spawns a new agent), and it was not retried. It is the first step of the W0 spike; the A1b
variant swaps the prompt for a 300 s `ScheduleWakeup`.

```python
# Measures PTY bytes emitted by an interactive `claude` that sits idle at its prompt while a
# background Bash task it started is still running. Usage: python3 -I run.py <claude-bin> <cwd> <log>
import os, pty, sys, time, select, signal, json, struct, fcntl, termios
binp, cwd, logp = sys.argv[1], sys.argv[2], sys.argv[3]
PROMPT = ("Use the Bash tool with run_in_background set to true to run exactly: sleep 300 . "
          "Do not wait for it, do not check on it. Then reply with the single word: started")
env = {k: os.environ[k] for k in ("HOME", "PATH", "USER", "LANG") if k in os.environ}
env["TERM"] = "xterm-256color"
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd)
    os.execve(binp, [binp, "--model", "haiku", "--allowedTools", "Bash(sleep *)", PROMPT], env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
t0 = time.time(); buf = b""; events = []; trusted = False; idle_from = None
def rd(timeout):
    global buf
    r, _, _ = select.select([fd], [], [], timeout)
    if not r: return b""
    try: d = os.read(fd, 65536)
    except OSError: return b""
    buf += d; events.append((time.time() - t0, len(d))); return d
end = t0 + 230
while time.time() < end:
    d = rd(0.5)
    low = buf[-4000:].lower()
    if not trusted and (b"trust" in low and b"folder" in low):
        time.sleep(1); os.write(fd, b"\r"); trusted = True
    if idle_from is None and b"started" in buf[-20000:] and b"background" in buf.lower():
        pass
# summarise per 10 s window
wins = {}
for t, n in events:
    w = int(t // 10) * 10; wins[w] = wins.get(w, 0) + n
open(logp + ".raw", "wb").write(buf)
json.dump({"windows": wins, "events": len(events)}, open(logp, "w"), indent=1)
os.kill(pid, signal.SIGTERM); time.sleep(1)
try: os.kill(pid, signal.SIGKILL)
except ProcessLookupError: pass
print(json.dumps(wins))
```
