# T456 — Prototype and runs (`01-prototype.md`)

Companion to [`00-spec.md`](00-spec.md). Everything here was run on 2026-10-09 with the Claude Code
**2.1.295** binary this session runs (`~/.local/share/claude/versions/2.1.295`). The `claude` on
`PATH` is 2.1.296, and the types the spec cites are 2.1.295's, so every run below pins 2.1.295.
The sources lived in the session scratchpad (`<scratchpad>` below) and are pasted verbatim. Paths
are shortened: `<worktree>` is this branch's checkout. Two symlinks in the scratchpad keep the
sources short: `wt` points at `<worktree>` and `pa-types` at the `plugin-authoring` skill's
`types/` folder, which holds the 2.1.295 `claude-code.d.ts`. Every source was formatted with the
repo's Prettier config before its final run, so the blocks below are byte-for-byte what ran.

- §P1 — the **mod half**: a hooks module that answers `park.query` from in-process facts, its
  test, and the `validate` / `test` / `tsc` output; a negative control; the Settings → Mods chips.
- §P2 — the **host half's bounds core** (pure) and a run against a mod that never stops saying
  busy.
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

/** One reason a session gives for not being parked now (spec §5.3). */
export type ParkBusyReason =
  | { kind: 'turn' }
  | { kind: 'permission'; count: number }
  | { kind: 'background-task'; count: number; types: string[] }
  | { kind: 'background-subagent'; count: number }
  | { kind: 'scheduled-wakeup'; count: number; recurring: number }
  | { kind: 'remote-surface'; surfaces: string[] }

/** `CommandResultData['park.query']` (spec §5.4). */
export type ParkQueryData = { busy: ParkBusyReason[]; retryAfterMs?: number }

type StopTask = { id: string; type: string }

/** What the mod keeps between events. The companion keeps it in its `fleet` state key. */
export interface ParkFacts {
  activeTurnId: string | null
  /** `tool_use_id`s whose permission verdict was `ask` and that have not run yet. */
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

  // Observe-only at a gating site: a failure here must not change the verdict (spec §8.2).
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (verdict.decision === 'ask' && e.tool_use_id !== undefined && e.agentId === undefined) {
      facts = { ...facts, asks: [...facts.asks, e.tool_use_id] }
    }
    return verdict
  }).catch(($, e, next) => next(e))

  on('classic.PostToolUse', ($, e, next) => {
    facts = { ...facts, asks: facts.asks.filter((id) => id !== e.tool_use_id) }
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
/* eslint-disable @typescript-eslint/no-explicit-any -- test code passes engine inputs loosely */
import { expect, test } from 'claude-code/testing'

const base = { session_id: 's-1', transcript_path: '/tmp/x.jsonl', cwd: '/tmp/x' }
const START = { cwd: '/tmp/x', surface: 'terminal', isInteractive: true } as const

/** The engine's own answers beneath the plugin; `surfaces` is what `$.session.surfaces()` reads. */
function engine(on: any, surfaces: string[] = ['terminal'], verdict = 'allow') {
  on('session.start', async (_$: any, e: any) => ({ cwd: e.cwd }))
  on('command.register', async (_$: any, e: any) => ({ value: { command: e.name } }))
  on('session.surfaces', async () => ({ value: surfaces }))
  on('turn.start', async (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', async () => ({ text: '' }))
  on('tool.check', async () => ({ decision: verdict }))
  on('classic.PostToolUse', async () => ({}))
  on('classic.Stop', async () => ({}))
  on('classic.SubagentStop', async () => ({}))
}

async function probe($: any): Promise<any> {
  const r = await $.command.run({ command: 'park-probe', args: '' })
  return JSON.parse(r.text)
}

const stop = (background_tasks: unknown[], session_crons: unknown[] = []) => ({
  ...base,
  hook_event_name: 'Stop',
  stop_hook_active: false,
  background_tasks,
  session_crons
})

const complete = (turnId: string) => ({
  answer: '',
  durationMs: 1,
  isAborted: false,
  turnId,
  reason: 'answer'
})

test('an idle session with nothing running is not busy', async ($: any, on: any) => {
  engine(on)
  await $.session.start(START)
  await $.classic.Stop(stop([], []))
  expect(await probe($)).toEqual({ busy: [] })
})

test('background shell, monitor and a wakeup from the last Stop', async ($: any, on: any) => {
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

test('a subagent that already stopped is not counted', async ($: any, on: any) => {
  engine(on)
  await $.session.start(START)
  await $.classic.SubagentStop({
    ...base,
    hook_event_name: 'SubagentStop',
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

test('a turn in flight is busy, and its end clears it', async ($: any, on: any) => {
  engine(on)
  await $.session.start(START)
  await $.turn.start({ text: 'p', turnId: 't1' })
  expect(await probe($)).toEqual({ busy: [{ kind: 'turn' }], retryAfterMs: 120_000 })
  await $.turn.complete(complete('t1'))
  expect(await probe($)).toEqual({ busy: [] })
})

test('an open permission ask is busy until the tool runs', async ($: any, on: any) => {
  engine(on, ['terminal'], 'ask')
  await $.session.start(START)
  await $.tool.check({ tool: 'Bash', input: { command: 'git push' }, tool_use_id: 'u1' })
  expect((await probe($)).busy).toEqual([{ kind: 'permission', count: 1 }])
  await $.classic.PostToolUse({
    ...base,
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: {},
    tool_response: {},
    tool_use_id: 'u1'
  })
  expect((await probe($)).busy).toEqual([])
})

test('an attached phone is busy, read at ask time', async ($: any, on: any) => {
  engine(on, ['terminal', 'mobile'])
  await $.session.start(START)
  expect((await probe($)).busy).toEqual([{ kind: 'remote-surface', surfaces: ['mobile'] }])
})
```

The test's `engine()` answers, beneath the plugin, every event and `$` call the plugin reaches.
The kit has no bottom of its own for them (REF 81). Two gotchas from T447 shaped it: no
`'x' in $` anywhere, and every `$` the module calls is stubbed (`command.register`,
`session.surfaces`). The module calls no `$.clock`, so no `clock.now` stub is needed.

### P1.2 `claude plugin validate`

```text
$ claude plugin validate <scratchpad>/harnu-park-negotiator
Validating plugin manifest: <scratchpad>/harnu-park-negotiator/.claude-plugin/plugin.json

Validating hooks: <scratchpad>/harnu-park-negotiator/hooks/hooks.json

  ❯ ./register.ts hooks: session.start, command.run{command=park-probe}, turn.start, turn.complete, tool.check, classic.PostToolUse, classic.Stop, classic.SubagentStop
  ❯ ./register.ts answers its own command: command.run{command=park-probe}
  ❯ ./register.ts gating hook with .catch: tool.check
  ❯ ./register.ts gating hook with .catch: classic.PostToolUse
  ❯ ./register.ts gating hook with .catch: classic.Stop
  ❯ ./register.ts gating hook with .catch: classic.SubagentStop
  ❯ ./register.ts calls: $.command.register, $.session.surfaces

✔ Validation passed
```

### P1.3 `claude plugin test`

```text
$ claude plugin test <scratchpad>/harnu-park-negotiator

tests/park.test.ts:
(pass) an idle session with nothing running is not busy [26.03ms]
(pass) background shell, monitor and a wakeup from the last Stop [11.62ms]
(pass) a subagent that already stopped is not counted [10.70ms]
(pass) a turn in flight is busy, and its end clears it [10.38ms]
(pass) an open permission ask is busy until the tool runs [10.33ms]
(pass) an attached phone is busy, read at ask time [9.02ms]

 6 pass
 0 fail
Ran 6 tests across 1 file. [0.17s]
```

**Negative control.** The same module with its `classic.Stop` hook deleted, against the same test
file. The two tests that depend on the Stop snapshot fail, and the rest pass, so those tests
exercise the hook rather than pass by default:

```text
(pass) an idle session with nothing running is not busy [25.94ms]
(fail) background shell, monitor and a wakeup from the last Stop [11.55ms]
(fail) a subagent that already stopped is not counted [10.63ms]
(pass) a turn in flight is busy, and its end clears it [10.76ms]
(pass) an open permission ask is busy until the tool runs [12.06ms]
(pass) an attached phone is busy, read at ask time [9.58ms]
 4 pass
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
only import is `node:path`) were run on two `claude plugin validate --json` reports, through Node
22's type stripping. The first report is the prototype's. The second is a copy of the companion
Harnu staged on this machine (`~/.config/harnu/companion/0.1.0/harnu-companion`). The source tree's
`resources/companion` does not validate on its own, because `hooks/coords.gen.ts` is generated at
build time (`scripts/ci/mod-step.mjs:81`).

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
validate.json ok=true hooks=session.start,command.run,turn.start,turn.complete,tool.check,classic.PostToolUse,classic.Stop,classic.SubagentStop
  calls=command.register,session.surfaces
  chips=["prompts","permissions"]
validate-companion.json ok=true hooks=session.start,classic.SessionStart,session.end,prompt.submit,turn.start,turn.complete,tool.check,classic.PermissionRequest,classic.Notification,classic.PostToolUse,classic.Stop,classic.SubagentStart,classic.SubagentStop,classic.PostToolUseFailure,classic.StopFailure,session.measure,plugin.register
  calls=clock.after,clock.every,clock.now,clock.sleep,env.get,fs.read,http.fetch,session.compact,session.id,session.model,session.usage,session.version,state.get,state.set,turn.abort,ui.status,ui.toast
  chips=["network","files","prompts","permissions","gate","env"]
```

## P2. The host half's bounds core

Pure, with `now` injected, in the style of `fleet-policy.ts`. Type-checked with
`tsc --noEmit --strict` (exit 0). The coordinator around it (`requestPark`, the enqueue and the
5 s race, the ledger write) is specified in spec §5.1 and §9.2 and is not prototyped.

`park-negotiation-core.ts`

```ts
// T456 host-side core sketch (spec §6). PURE: no electron, no clock; `now` is injected.

export type ParkCause = 'cap' | 'sweep' | 'manual'

/** What the session said, or that it said nothing. */
export type Answer =
  { kind: 'busy'; reasons: string[]; retryAfterMs?: number } | { kind: 'free' } | { kind: 'silent' } // timeout, NO_BINDING, MODE_SHADOW, CMD_* — anything but a result

/** One cold episode of one session: opened by the first decline, closed by a main turn or focus. */
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
 * `ask` means "consult": `park.query` where the channel can carry it, else the answer is `silent` and
 * the legacy Stop facts stand in (`applyAnswer`). Either way a busy answer opens or advances the episode.
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
```

`simulate.mts`: the sweep's 60 s cadence over 6 h, against a mod that never stops answering busy.

```ts
// Drives the core with the sweep's 60 s cadence against a mod that never stops saying busy.
import {
  decide,
  applyAnswer,
  DEFAULT_NEGOTIATION as S,
  type Episode
} from './park-negotiation-core.ts'
function run(
  label: string,
  hint: number | undefined,
  memMb: number | null = 20_000,
  legacy = false
) {
  let ep: Episode | null = null,
    asks = 0
  for (let t = 0; t <= 6 * 3_600_000; t += 60_000) {
    const d = decide({ now: t, cause: 'sweep', episode: ep, settings: S, memAvailableMb: memMb })
    if (d.action === 'park')
      return console.log(
        label.padEnd(34),
        `parked at ${t / 60_000} min, why=${d.why}, questions=${asks}, declines=${ep?.declines ?? 0}`
      )
    if (d.action === 'ask') {
      asks++
      ep = legacy
        ? applyAnswer(ep, { kind: 'silent' }, ['scheduled-wakeup'], t, S)
        : applyAnswer(
            ep,
            { kind: 'busy', reasons: ['background-task'], retryAfterMs: hint },
            [],
            t,
            S
          )
    }
  }
  console.log(label, 'never parked')
}
run('busy forever, hint 1 ms (clamped)', 1)
run('busy forever, no hint', undefined)
run('busy forever, hint 1 h (clamped)', 3_600_000)
run('busy forever, memory under floor', 1, 1_000)
run('legacy: wakeup in every Stop', undefined, null, true)
const manual = decide({ now: 0, cause: 'manual', episode: null, settings: S, memAvailableMb: null })
console.log('operator Park now'.padEnd(34), JSON.stringify(manual))
const free = applyAnswer(null, { kind: 'free' }, [], 0, S)
const silentNoFacts = applyAnswer(null, { kind: 'silent' }, [], 0, S)
console.log('answer free → episode'.padEnd(34), JSON.stringify(free), '(null = park now)')
console.log(
  'silent, no legacy facts → episode'.padEnd(34),
  JSON.stringify(silentNoFacts),
  '(null = park now)'
)
```

```text
$ node --experimental-strip-types simulate.mts
busy forever, hint 1 ms (clamped)  parked at 8 min, why=limit, questions=8, declines=8
busy forever, no hint              parked at 71 min, why=limit, questions=8, declines=8
busy forever, hint 1 h (clamped)   parked at 120 min, why=limit, questions=4, declines=4
busy forever, memory under floor   parked at 0 min, why=memory-pressure, questions=0, declines=0
legacy: wakeup in every Stop       parked at 71 min, why=limit, questions=8, declines=8
operator Park now                  {"action":"park","why":"operator"}
answer free → episode              null (null = park now)
silent, no legacy facts → episode  null (null = park now)
```

## P3. The failure, reproduced against the shipped policy

`repro.mts` imports the shipped `src/main/fleet-policy.ts` unchanged. It is a leaf module with no
imports, so Node 22 runs it with type stripping. The script feeds it the `LiveSession` shape that
`pty.ts:583-610` builds. Each row's `taskState` is what the hub reports for that situation (spec
§3.6).

```ts
// Feeds the shipped pure policy the snapshot pty.ts#fleetSnapshot builds for a session that is idle
// at its prompt while a background task it started still runs: the hub says 'idle' (a background
// SHELL does not hold the state, P4W4 E4), and the PTY has been silent since the turn ended.
import { evaluateFleet, explainFleet, DEFAULT_POLICY } from '../wt/src/main/fleet-policy.ts'
const now = 10_000_000_000
const min = 60_000
const s = (key: string, idleMin: number, taskState: any = 'idle') => ({
  sessionKey: key,
  kind: 'claude-resume' as const,
  taskState,
  lastFocusedAt: now - idleMin * min,
  lastActivityAt: now - idleMin * min,
  isSelected: false,
  hasPendingApproval: false
})
// 1) cap: 5 live, one cold for 16 min with a background 'npm run e2e' started at its last turn.
const fleet = [s('bg-e2e', 16), s('a', 1), s('b', 2), s('c', 3), s('d', 4)]
console.log('cap victims:', evaluateFleet(fleet, now, DEFAULT_POLICY, 'cap'))
console.log('explain:', JSON.stringify(explainFleet(fleet, now, DEFAULT_POLICY)[0]))
// 2) sweep: a /loop session waiting on a 61-minute ScheduleWakeup, nothing else running.
console.log('sweep victims:', evaluateFleet([s('loop-wakeup', 61)], now, DEFAULT_POLICY, 'sweep'))
// 3) a background subagent holds 'working' (P1W5): immune only until hardIdleMs.
console.log(
  'sweep victims (working, 61 min silent):',
  evaluateFleet([s('bg-agent', 61, 'working')], now, DEFAULT_POLICY, 'sweep')
)
```

```text
$ node --experimental-strip-types repro.mts
cap victims: [ 'bg-e2e' ]
explain: {"sessionKey":"bg-e2e","parkable":true,"idleMs":960000,"reason":"lru","sweepRank":null}
sweep victims: [ 'loop-wakeup' ]
sweep victims (working, 61 min silent): [ 'bg-agent' ]
```

## P4. The A1 measurement (not run)

This script would settle assumption A1: does an idle interactive `claude` with a background task
emit PTY bytes? It spawns `claude --model haiku` under a pseudo-terminal in an empty scratch folder,
with a minimal environment (no Harnu tokens, so no companion binding). It asks for one
`sleep 300` with `run_in_background`, then counts the bytes per 10 s window for 230 s, and kills
the process and its descendants. Starting it was **refused by this session's permission classifier**
(it spawns a new agent), and it was not retried. It is the first step of the W0 spike.

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
