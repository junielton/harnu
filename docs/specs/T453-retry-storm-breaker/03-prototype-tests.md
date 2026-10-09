# T453 — Prototype: tests and live runs

**Part of:** [`00-spec.md`](00-spec.md) §7 and §11 (C-1, C-5) · **Source:**
[`02-prototype.md`](02-prototype.md), [`04-detector-core.md`](04-detector-core.md)

Two kinds of evidence. `claude plugin test` exercises the mod's logic against the engine's kit, where
the test answers everything beneath the plugin (`reference.md:81`). The live runs load the mod into
real sessions (`claude -p --plugin-dir`, and an interactive `claude --plugin-dir` driven in tmux), so
the engine itself raises the events and draws the dialog. They are what proves the mechanisms the
design hinges on (§3).

## 1. `tests/breaker.test.ts`

The kit stubs every `$` call the plugin makes beneath it (`mock.clock`, `mock.env`, and one test
hook per `command.register`, `ui.*` and `turn.abort` call). A call with no answer beneath it fails
with `no implementation for <event>`; an answer in the wrong shape (`{ isPlaced: true }` instead of
`{ value: { isPlaced: true } }`) is skipped. `$.command.run` takes `origin` and `presentation`
from the test.

```ts
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { errSig, isMutation, isPoll, isServerWait } from '../hooks/core'

type Seen = { opened: string[]; aborted: string[]; logged: string[] }

const ENFORCE = { options: { level: 'enforce' } }

// Everything beneath the plugin that it calls, answered from memory.
function world(on: On, role?: string, verdict: 'allow' | 'ask' = 'allow'): Seen {
  const seen: Seen = { opened: [], aborted: [], logged: [] }
  mock.clock(on, { now: 1_000_000 })
  mock.env(on, role ? { HARNU_SESSION_ROLE: role } : {})
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.check', () => ({ decision: verdict }))
  on('ui.open', ($, e) => {
    seen.opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('ui.notify', () => ({ value: { isSent: false as const, reason: 'no-surface' as const } }))
  on('ui.log', ($, e) => {
    seen.logged.push(e.text)
    return { value: undefined }
  })
  on('turn.abort', ($, e) => {
    seen.aborted.push(e.turnId)
    return { value: undefined }
  })
  return seen
}

async function start($: Engine, isInteractive = true): Promise<void> {
  await $.session.start({ cwd: '/repo', surface: isInteractive ? 'terminal' : null, isInteractive })
  await $.turn.start({ text: 'fix the build', turnId: 'turn-1' })
}

let n = 0
// One model call and its result, as the engine appends them.
async function call(
  $: Engine,
  tool: string,
  input: Record<string, unknown>,
  result: { error: string } | { ok: string },
  agentId?: string
): Promise<string> {
  const id = `toolu_${++n}`
  await $.session.append({
    door: 'response',
    origin: { kind: 'model', model: 'test' },
    uuid: `u-${id}-a`,
    ...(agentId ? { agentId } : {}),
    message: {
      type: 'assistant',
      role: 'assistant',
      content: [{ type: 'tool_use', id, name: tool, input }]
    }
  })
  const isError = 'error' in result
  const stored = await $.session.append({
    door: 'tool-result',
    origin: { kind: 'tool', tool },
    uuid: `u-${id}-r`,
    ...(agentId ? { agentId } : {}),
    message: {
      type: 'user',
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: id,
          is_error: isError,
          content: isError ? result.error : result.ok
        }
      ]
    }
  })
  return JSON.stringify(stored.message?.content)
}

const MISSING = { error: 'Exit code 1\ncat: /repo/missing.txt: No such file or directory' }
const cat = { command: 'cat /repo/missing.txt' }

test('the third identical failure carries a notice the model reads', async ($, on) => {
  world(on)
  await start($)
  expect(await call($, 'Bash', cat, MISSING)).not.toContain('retry-breaker')
  expect(await call($, 'Bash', cat, MISSING)).not.toContain('retry-breaker')
  expect(await call($, 'Bash', cat, MISSING)).toContain('failed 3 times with the same error')
})

test('polling is read from the command words, not from a substring', () => {
  const bash = (command: string) => ({ command })
  expect(isPoll('Bash', bash('sleep 30 && gh pr view 41'), '')).toBe(true)
  expect(isPoll('Bash', bash('until curl -sf localhost:5173; do sleep 1; done'), '')).toBe(true)
  expect(isPoll('Bash', bash('gh pr checks 41'), '')).toBe(true)
  expect(isPoll('Bash', bash('grep -r sleep src'), '')).toBe(false)
  expect(isPoll('Bash', bash('npm run test:watch'), '')).toBe(false)
  expect(isPoll('Bash', bash('echo "sleep 5"'), '')).toBe(false)
  expect(isPoll('Bash', bash('ls | while read f; do cat "$f"; done'), '')).toBe(false)
  expect(isPoll('mcp__harnu__get_session', { sessionId: 's' }, 'SESSION_NOT_FOUND')).toBe(true)
  expect(isPoll('mcp__harnu__update_card', { slug: 'x' }, 'NOT_FOUND: card not found')).toBe(false)
})

test('wrapped waits are read through bash -c and timeout options', () => {
  const bash = (command: string) => ({ command })
  expect(
    isPoll('Bash', bash("timeout 60 bash -c 'until curl -sf localhost:5173; do sleep 1; done'"), '')
  ).toBe(true)
  expect(isPoll('Bash', bash('sh -c "while ! nc -z localhost 5432; do sleep 1; done"'), '')).toBe(
    true
  )
  expect(isPoll('Bash', bash('timeout -s KILL 30 sleep 20'), '')).toBe(true)
  expect(isPoll('Bash', bash("timeout --signal=KILL -k 5 30 bash -lc 'sleep 3'"), '')).toBe(true)
  expect(isPoll('Bash', bash("bash -c 'cat a.ts | head'"), '')).toBe(false)
  expect(isPoll('Bash', bash('timeout 30 cat a.ts'), '')).toBe(false)
})

test('waiting for a server, whatever the client, and an edit by any route never add up', () => {
  const refused =
    'Exit code 7\ncurl: (7) Failed to connect to localhost port 5173: Connection refused'
  for (const [tool, input] of [
    ['Bash', { command: 'curl -sf http://localhost:5173/health' }],
    ['Bash', { command: 'psql -h localhost -c "select 1"' }],
    ['Bash', { command: 'npx playwright test' }],
    ['Bash', { command: 'docker compose exec db pg_isready' }],
    ['WebFetch', { url: 'http://localhost:5173/', prompt: 'status' }]
  ] as const)
    expect(isServerWait(tool, input, refused)).toBe(true)
  expect(
    isServerWait(
      'Bash',
      { command: 'curl -sf x' },
      'curl: (22) The requested URL returned error: 502'
    )
  ).toBe(true)
  expect(
    isServerWait('Bash', { command: 'cat /repo/missing.txt' }, 'cat: missing.txt: No such file')
  ).toBe(false)
  expect(isServerWait('Bash', { command: 'npm test' }, 'FAIL src/a.test.ts line 502')).toBe(false)
  expect(isMutation('Bash', { command: "sed -i 's/a/b/' src/a.ts" })).toBe(true)
  expect(isMutation('Bash', { command: 'npx prettier --write src' })).toBe(true)
  expect(isMutation('Bash', { command: 'echo x > src/a.ts' })).toBe(true)
  expect(isMutation('Bash', { command: 'git status && cat a.ts 2>&1 | head' })).toBe(false)
  expect(isMutation('Bash', { command: 'grep -rn foo src > /dev/null' })).toBe(false)
  expect(isMutation('Bash', { command: "bash -c 'sed -i s/a/b/ a.ts'" })).toBe(true)
  expect(isMutation('Bash', { command: "bash -c 'cat a.ts'" })).toBe(false)
  expect(isMutation('mcp__harnu__update_card', {})).toBe(true)
  expect(isMutation('mcp__harnu__get_fleet', {})).toBe(false)
})

test('polls, person refusals and a success in between never add up', async ($, on) => {
  world(on)
  await start($)
  const poll = { command: 'gh pr checks 41' }
  for (let i = 0; i < 5; i++)
    expect(await call($, 'Bash', poll, { error: 'Exit code 8\nverify\tpending\t0' })).not.toContain(
      'retry-breaker'
    )
  const no = {
    error: "The user doesn't want to proceed with this tool use. The tool use was rejected."
  }
  for (let i = 0; i < 5; i++)
    expect(await call($, 'Edit', { file_path: '/repo/a.ts', old_string: 'x' }, no)).not.toContain(
      'retry-breaker'
    )
  await call($, 'Bash', cat, MISSING)
  await call($, 'Bash', cat, MISSING)
  await call($, 'Bash', cat, { ok: 'hello' })
  expect(await call($, 'Bash', cat, MISSING)).not.toContain('retry-breaker')
})

test('re-running tests after a sed edit or an MCP write starts over', async ($, on) => {
  world(on)
  await start($)
  const tests = { command: 'npm test' }
  const red = { error: 'Exit code 1\nFAIL src/a.test.ts > adds' }
  await call($, 'Bash', tests, red)
  await call($, 'Bash', tests, red)
  await call($, 'Bash', { command: "sed -i 's/a - b/a + b/' src/a.ts" }, { ok: '' })
  expect(await call($, 'Bash', tests, red)).not.toContain('retry-breaker')
  await call($, 'Bash', tests, red)
  await call($, 'mcp__ide__apply_edit', { path: 'src/a.ts' }, { ok: 'applied' })
  expect(await call($, 'Bash', tests, red)).not.toContain('retry-breaker')
  // A read in between is no edit: the third identical failure still warns.
  await call($, 'Bash', { command: 'cat src/a.ts' }, { ok: 'a + b' })
  expect(await call($, 'Bash', tests, red)).not.toContain('retry-breaker')
  expect(await call($, 'Bash', tests, red)).toContain('failed 3 times')
})

test(
  'attended: the fourth opens the dialog, the fifth is refused with the reason, no abort',
  ENFORCE,
  async ($, on) => {
    const seen = world(on)
    await start($)
    for (let i = 0; i < 4; i++) await call($, 'Bash', cat, MISSING)
    expect(seen.opened).toEqual(['retry-breaker'])
    for (let i = 0; i < 3; i++) {
      const v = await $.tool.check({ tool: 'Bash', input: cat, tool_use_id: `toolu_next${i}` })
      expect(v.decision).toBe('deny')
      expect(v.reason).toContain('failed 4 times')
    }
    expect(seen.aborted).toEqual([])
  }
)

test('level notice (the default) never refuses', async ($, on) => {
  world(on, 'agent')
  await start($)
  for (let i = 0; i < 6; i++) await call($, 'Bash', cat, MISSING)
  const v = await $.tool.check({ tool: 'Bash', input: cat, tool_use_id: 'toolu_n' })
  expect(v.decision).toBe('allow')
})

test('unattended: refused with the reason, then the turn is ended', ENFORCE, async ($, on) => {
  const seen = world(on, 'agent')
  await start($)
  for (let i = 0; i < 4; i++) await call($, 'Bash', cat, MISSING)
  expect(seen.opened).toEqual([])
  expect(seen.logged.length).toBe(1)
  for (let i = 0; i < 3; i++) {
    const v = await $.tool.check({ tool: 'Bash', input: cat, tool_use_id: `toolu_r${i}` })
    expect(v.decision).toBe('deny')
    expect(v.reason).toContain('/retry-breaker reset')
  }
  expect(seen.aborted).toEqual(['turn-1'])
  // Another call is never refused.
  const other = await $.tool.check({
    tool: 'Bash',
    input: { command: 'ls' },
    tool_use_id: 'toolu_x'
  })
  expect(other.decision).toBe('allow')
})

test(
  '/retry-breaker reset lifts the refusal and leaves a notice in the transcript',
  ENFORCE,
  async ($, on) => {
    world(on, 'agent')
    const session = mock.session(on)
    await start($)
    for (let i = 0; i < 4; i++) await call($, 'Bash', cat, MISSING)
    const before = await $.tool.check({ tool: 'Bash', input: cat, tool_use_id: 'toolu_a' })
    expect(before.decision).toBe('deny')
    const r = await $.command.run({
      command: 'retry-breaker',
      args: 'reset',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 120 }
    })
    expect(JSON.stringify(r)).toContain('cleared')
    const after = await $.tool.check({ tool: 'Bash', input: cat, tool_use_id: 'toolu_b' })
    expect(after.decision).toBe('allow')
    const notices = session.appended().filter((row) => row.message.type === 'system')
    expect(JSON.stringify(notices.map((row) => row.message.content))).toContain(
      '[retry-breaker] reset'
    )
  }
)

test('the same error across different inputs warns at four', async ($, on) => {
  world(on)
  await start($)
  const gone = { error: 'Agent type "verifier" not found. Available agents: general-purpose' }
  let last = ''
  for (let i = 0; i < 4; i++)
    last = await call($, 'Agent', { subagent_type: `verifier-${i}`, prompt: `try ${i}` }, gone)
  expect(last).toContain('across different inputs')
})

test('a subagent counts apart and never opens the dialog', ENFORCE, async ($, on) => {
  const seen = world(on)
  await start($)
  for (let i = 0; i < 4; i++) await call($, 'Bash', cat, MISSING, 'agent-7')
  expect(seen.opened).toEqual([])
  expect(await call($, 'Bash', cat, MISSING)).not.toContain('retry-breaker')
  const v = await $.tool.check({
    tool: 'Bash',
    input: cat,
    tool_use_id: 'toolu_s',
    agentId: 'agent-7'
  })
  expect(v.decision).toBe('deny')
})

test(
  'the dialog shows the failures and "Let it retry" lifts the refusal',
  ENFORCE,
  async ($, on) => {
    world(on)
    const session = mock.session(on)
    await start($)
    for (let i = 0; i < 4; i++) await call($, 'Bash', cat, MISSING)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({
        plugin: 'retry-breaker',
        surface,
        component: 'Pane',
        requestId: 'retry-breaker',
        props: {
          title: 'Retry storm',
          isFocused: true,
          bodyColumns: 120,
          placement: 'dock',
          scroll: { offset: 0, bodyRows: 20 },
          view: {}
        }
      })
      expect(await ui.find({ type: 'Text', text: /failed 4× the same way/ })).toBeDefined()
      expect(await ui.find({ key: 'stop' })).toBeDefined()
      if (surface === 'desktop') await ui.press({ key: 'retry' })
      await ui.unmount()
    }
    const v = await $.tool.check({ tool: 'Bash', input: cat, tool_use_id: 'toolu_after' })
    expect(v.decision).toBe('allow')
    const notices = session.appended().filter((row) => row.message.type === 'system')
    expect(JSON.stringify(notices.map((row) => row.message.content))).toContain(
      '[retry-breaker] muted'
    )
  }
)

test('unattended: a call nobody could approve is never a failure', async ($, on) => {
  world(on, 'tick', 'ask')
  await start($, false)
  const refused = { error: 'This command requires approval' }
  for (let i = 0; i < 5; i++) {
    const id = `toolu_ask${i}`
    await $.session.append({
      door: 'response',
      origin: { kind: 'model', model: 'test' },
      uuid: `u-${id}-a`,
      message: {
        type: 'assistant',
        role: 'assistant',
        content: [{ type: 'tool_use', id, name: 'Bash', input: cat }]
      }
    })
    expect((await $.tool.check({ tool: 'Bash', input: cat, tool_use_id: id })).decision).toBe('ask')
    const stored = await $.session.append({
      door: 'tool-result',
      origin: { kind: 'tool', tool: 'Bash' },
      uuid: `u-${id}-r`,
      message: {
        type: 'user',
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: refused.error }]
      }
    })
    expect(JSON.stringify(stored.message?.content)).not.toContain('retry-breaker')
  }
})

test('a stored notice does not change what counts as the same error', () => {
  expect(
    errSig('Exit code 1\nnot found\n\n[retry-breaker] This exact Bash call has now failed 3 times')
  ).toBe(errSig('Exit code 1\nnot found'))
})
```

## 2. Real output of `claude plugin test`

```text
$ claude plugin test retry-breaker

tests/breaker.test.ts:
(pass) the third identical failure carries a notice the model reads [44.08ms]
(pass) polling is read from the command words, not from a substring [0.68ms]
(pass) wrapped waits are read through bash -c and timeout options [0.41ms]
(pass) waiting for a server, whatever the client, and an edit by any route never add up [0.62ms]
(pass) polls, person refusals and a success in between never add up [36.45ms]
(pass) re-running tests after a sed edit or an MCP write starts over [40.18ms]
(pass) attended: the fourth opens the dialog, the fifth is refused with the reason, no abort [39.47ms]
(pass) level notice (the default) never refuses [42.98ms]
(pass) unattended: refused with the reason, then the turn is ended [27.67ms]
(pass) /retry-breaker reset lifts the refusal and leaves a notice in the transcript [48.60ms]
(pass) the same error across different inputs warns at four [30.75ms]
(pass) a subagent counts apart and never opens the dialog [30.78ms]
(pass) the dialog shows the failures and "Let it retry" lifts the refusal [37.17ms]
(pass) unattended: a call nobody could approve is never a failure [40.64ms]
(pass) a stored notice does not change what counts as the same error [0.35ms]

 15 pass
 0 fail
Ran 15 tests across 1 file. [0.55s]
```

Tests that exist because a run found a defect:

- "polls, person refusals and a success in between never add up": polls had been kept out of the
  exact rule only.
- "polling is read from the command words, not from a substring": `grep -r sleep` and
  `npm run test:watch` had been excluded by a substring rule (round-1 verifier).
- "waiting for a server and an edit by any route never add up": the tokenizer had split `2>&1` at
  the `&`, which made `1` a command word and every such command a mutation.
- "wrapped waits are read through bash -c and timeout options": a `timeout 60 bash -c 'until curl …;
do sleep 1; done'` read as command word `bash`, and `timeout -s KILL 30 …` as `KILL`, so their
  `Exit code 124` fed the exact rule (round-2 verifier E7).
- "waiting for a server, whatever the client": `psql`, `npx playwright test`, `docker compose exec …
pg_isready` and `WebFetch` to localhost failing with a refusal were counted; X7 now reads the text.
- "unattended: a call nobody could approve is never a failure": live run 1.
- "a stored notice does not change what counts as the same error": the transcript check of run 3.

## 3. Live runs

Each run loaded an instrumented copy of the prototype (the same module plus `$.ui.log(..., { to:
'debug' })` lines prefixed `PROBE`) from the scratchpad into a session in a throwaway git repository,
with `--debug-file` capturing the log. Paths are replaced by `<scratch>`. Runs 1–9 used the round-1
build; runs 10–12 the round-2 build (run 10 before rung 3 became a `deny` everywhere, run 11 after).

| Run | Session                                 | What it proves                                                                                                                                     | Result                                                                                            |
| --- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 1   | `-p`, haiku                             | `session.append` sees the `tool_use` (door `response`) and its `tool_result` (door `tool-result`) under one id; `tool.check` sees the verdict      | proven; and a defect: a headless `ask` became `This command requires approval`, which was counted |
| 2   | `-p`, haiku                             | the fix: an `ask` with nobody attending is a permission outcome                                                                                    | proven                                                                                            |
| 3   | `-p`, haiku                             | the notice reaches the model; the refusal reaches it with its reason; the transcript stores both                                                   | proven                                                                                            |
| 4   | `-p`, haiku                             | the abort cap in a natural loop                                                                                                                    | not reached: the model stopped at the first refusal                                               |
| 5   | `-p`, sonnet                            | a worktree-isolated subagent: `agentId` on both events, the notice in the subagent's loop                                                          | proven                                                                                            |
| 6   | `-p`, sonnet                            | Bash in a worktree subagent                                                                                                                        | inconclusive: the operator's own Bash-rewrite hook tripped Claude Code's worktree guard           |
| 7   | `-p`, haiku                             | abort with cap 0                                                                                                                                   | not reached: the model stopped after the notice                                                   |
| 8   | `-p`, sonnet                            | Bash in a worktree subagent (plain `pwd`)                                                                                                          | proven: it ran in its own worktree                                                                |
| 9   | `-p`, haiku                             | `$.turn.abort` from `tool.check`, probe-only thresholds                                                                                            | proven                                                                                            |
| 10  | **interactive**, tmux, haiku            | `isInteractive: true`; `/retry-breaker`; the dialog drawn live; "Ask why"; an `ask` in manual mode and in auto mode; `/retry-breaker reset` stored | proven, with two findings (§3.2)                                                                  |
| 11  | **interactive**, tmux, haiku            | the round-2 rung 3: a `deny` with its reason in an attended session in auto mode, and no abort                                                     | proven                                                                                            |
| 12  | `-p`, haiku, `HARNU_SESSION_ROLE=agent` | the role variable reaches `$.env.get` (A5)                                                                                                         | proven                                                                                            |

Runs 1 and 2 used `Bash` with an allow rule; the operator's user-level `PreToolUse` hook on `Bash`
rewrites commands, so the rewritten command no longer matched the rule and the verdict stayed `ask`.
Later runs use `Read` of a missing file, which needs no permission. That `tool.check` works on `Bash`
and leaves worktree agents alone is T389's smoke B1.2/B1.6/B4
(`docs/specs/T389-companion-mod/P3W2-structured-sentinel.md:48-53`) and this spec's run 8.

### 3.1 Run 3: notice, refusal, transcript

```text
PROBE start interactive=false role=undefined
PROBE response tool_use id=toolu_01X4YJDgSTJibYbrash9Tzhy name=Read agent=undefined
PROBE check tool=Read id=toolu_01X4YJDgSTJibYbrash9Tzhy agent=undefined verdict=allow
PROBE result id=toolu_01X4YJDgSTJibYbrash9Tzhy agent=undefined rung=0 count=1 class=not-found
PROBE response tool_use id=toolu_01ABKz72YvbYtu7kxz6UoG5X name=Read agent=undefined
PROBE check tool=Read id=toolu_01ABKz72YvbYtu7kxz6UoG5X agent=undefined verdict=allow
PROBE result id=toolu_01ABKz72YvbYtu7kxz6UoG5X agent=undefined rung=0 count=2 class=not-found
PROBE response tool_use id=toolu_01RZcqfCaypYDeqc7QGk5A58 name=Read agent=undefined
PROBE check tool=Read id=toolu_01RZcqfCaypYDeqc7QGk5A58 agent=undefined verdict=allow
PROBE result id=toolu_01RZcqfCaypYDeqc7QGk5A58 agent=undefined rung=1 count=3 class=not-found
PROBE response tool_use id=toolu_015AhGZgz8rhMrZs9NMqizHC name=Read agent=undefined
PROBE check tool=Read id=toolu_015AhGZgz8rhMrZs9NMqizHC agent=undefined verdict=allow
PROBE result id=toolu_015AhGZgz8rhMrZs9NMqizHC agent=undefined rung=2 count=4 class=not-found
PROBE response tool_use id=toolu_015qAVt9d6u4P6qxnhW8S6Rf name=Read agent=undefined
PROBE check tool=Read id=toolu_015qAVt9d6u4P6qxnhW8S6Rf agent=undefined verdict=allow
PROBE deny id=toolu_015qAVt9d6u4P6qxnhW8S6Rf denied=1 turn=ec098148-8fc7-446e-94cb-5dee44c31451
```

The model quoted both notices verbatim and the refusal: `Permission to use Read denied by plugin
retry-breaker: retry-breaker: this exact Read call already failed 4 times with the same error (...).
Change the call or the cause first. The person can lift this with /retry-breaker reset.` The stored
transcript (`~/.claude/projects/<slug>/f0a283f0-….jsonl`) holds the notice text **4** times and the
refusal text **4** times (counted as occurrences; the round-1 text said 3 and 2, which were line
counts).

### 3.2 Run 10: the attended half, interactive

**Evidence on disk (kept outside this repo).** The session's transcript is
`~/.claude/projects/<tmp-slug>/c6c7f554-5513-48b2-8445-315cbd92b8f2.jsonl` (the `<tmp-slug>` is the
scratchpad's `/tmp` path with the slashes turned into dashes; it holds the `[retry-breaker] reset`
notice once and a `local_command` row for each `/retry-breaker` call). The debug file was
`<scratch>/probe/live.debug`, from which every `PROBE` and `tool.check` excerpt below is copied. In it:
`PROBE start interactive=true role=undefined` is line 1 of the hook output, and the "Ask why" answer
is `PROBE fork isAnswered=true The Read failed because \`missing.txt\` does not exist at that path, …`
(the full text is drawn in the dialog, item 5).

`claude --plugin-dir <scratch>/probe/live --model haiku` in a detached tmux session (160 × 48),
keys sent with `tmux send-keys`, the screen read with `tmux capture-pane`. The session opened in the
operator's default permission mode, **auto**; it was cycled to **manual** with shift+tab for the
first storm and back to auto for the second.

1. **`isInteractive: true`** at `session.start`:

   ```text
   PROBE start interactive=true role=undefined
   ```

2. **The command.** `/retry-breaker enforce` printed `retry-breaker: Retry-breaker: level enforce for
this session.` `/retry-breaker reset` later printed `Retry-breaker: every count and mute
cleared.`, and the transcript stored the system notice `[retry-breaker] reset` (1 occurrence).
3. **The dialog, drawn by the terminal** on the 4th identical failure, the four failures side by side
   (paths cut by the column width):

   ```text
   ╭──────────────────────────────────────────────────────────────────────────────────────────────✕─╮
   │ Read failed 4× the same way (exact)                                                              │
   │ #1                       #2                       #3                       #4                    │
   │ File does not exist.     File does not exist.     File does not exist.     File does not exist.  │
   │ Note: your current       Note: your current       Note: your current       Note: your current    │
   │ working directory is     working directory is     working directory is     working directory is  │
   │ <scratch>/probe/repo     <scratch>/probe/repo     <scratch>/probe/repo     <scratch>/probe/repo  │
   │ [ Stop the turn ][ Let it retry ][ Ask why ]                                                     │
   ╰──────────────────────────────────────────────────────────────────────────────────────────────────╯
   ```

4. **An `ask` in manual mode reached the person, without its reason.** The 5th identical call drew
   the engine's own permission dialog:

   ```text
    Read file
    Read(<scratch>/probe/repo/missing.txt)
    Do you want to proceed?
    ❯ 1. Yes
      2. Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session
      3. No
    Esc to cancel · Tab to amend
   ```

   The breaker's reason appears nowhere on screen; it is only in the debug log (`tool.check Read
toolu_…: allow -> ask by plugin retry-breaker: retry-breaker: this exact Read call already failed 4
times …`). Answering "3. No" interrupted the turn (`Interrupted · What should Claude do
instead?`), and the refused call's result, `The user doesn't want to proceed …`, was not counted
   (X1).

5. **"Ask why".** The dialog takes keys only once focused (`ctrl+x tab`): a `w` sent while a turn
   ran went to the composer, and in tmux the chord focused the pane in 2 of 4 tries. Focused right
   after the interrupted turn, the fork answered `nothing-to-fork` and the dialog showed `no answer
(nothing-to-fork)`. Focused after a turn that ended normally, it answered:

   ```text
   PROBE fork isAnswered=true The Read failed because `missing.txt` does not exist at that path, which is the condition this test set up. The retry-breaker flagged repeats s…
   ```

   and the dialog drew the answer between the failures and the buttons.

6. **An `ask` in auto mode was settled by the mode, not by a person.** The 5th and 6th identical calls
   ran:

   ```text
   PROBE check tool=Read id=toolu_01Kwxati44cbiyKFSDmHniLv verdict=allow
   PROBE ask id=toolu_01Kwxati44cbiyKFSDmHniLv
   tool.check Read toolu_01Kwxati44cbiyKFSDmHniLv: allow -> ask by plugin retry-breaker: retry-breaker: this exact Read call already failed 4 times with the same error ("Fil
   Skipping auto mode classifier for Read: would be allowed in acceptEdits mode
   PROBE error id=toolu_01Kwxati44cbiyKFSDmHniLv verdict=allow head=File does not exist. Note: your current working directory is
   PROBE result id=toolu_01Kwxati44cbiyKFSDmHniLv rung=2 count=5
   ```

   No one was asked, and the reason was never shown. This, with item 4, is why rung 3 is now a `deny`
   in every mode (`00-spec.md` §5.1, §6.2).

### 3.3 Run 11: the round-2 rung 3, attended, auto mode

Transcript: `~/.claude/projects/<tmp-slug>/1c450945-c1bb-4ee0-92ed-93ab0cdbd8fb.jsonl`; debug file
`<scratch>/probe/live2.debug`, from which the excerpt below is copied.

The same set-up, the final build, auto mode, `/retry-breaker enforce`. Told to make the same call 6
times, the model stopped by itself after the notice on the 3rd failure. Told that advice is not a
refusal, it made the call 4 more times. The 4th opened the dialog, and the 5th was refused:

```text
PROBE check tool=Read id=toolu_01NuaQBk2yJpJHAmTwSQpv1s verdict=allow
PROBE check tool=Read id=toolu_01JQMun3LcCmSvexF8xLLs8c verdict=allow
PROBE check tool=Read id=toolu_013awpGUDKzkYZ9WyotHkFCS verdict=allow
PROBE check tool=Read id=toolu_01WSknJqgWW2VZAL53f6Zm1N verdict=allow
PROBE check tool=Read id=toolu_01G2XoPUtM3ysVF8rUoAiKWM verdict=allow
PROBE check tool=Read id=toolu_01L1mhzwi8Jo6BDKU3XSppfe verdict=allow
PROBE check tool=Read id=toolu_018jQUx7YDfEgmwspFoB51SR verdict=allow
PROBE check tool=Read id=toolu_01KUj4UFWoKxScbEQJVD24KC verdict=allow
PROBE deny id=toolu_01KUj4UFWoKxScbEQJVD24KC attended=true
```

The model's answer quoted the refusal verbatim: `Permission to use Read denied by plugin
retry-breaker: retry-breaker: this exact Read call already failed 4 times with the same error ("File
does not exist. …"). Change the call or the cause first. The person can lift this with
/retry-breaker reset.` No `$.turn.abort` line: the session is attended, so the turn went on, and the
dialog stayed open with its [Stop]. Pressing `r` for "Let it retry" did not reach the dialog in this
run (the chord did not focus it), so the mute notice is proven in the kit only. The reset notice,
written the same way through `$.session.append`, is proven live (run 10).

### 3.4 Run 12: `HARNU_SESSION_ROLE`

```text
$ HARNU_SESSION_ROLE=agent claude -p --model haiku --plugin-dir <scratch>/probe/live "Reply with the single word OK."
PROBE start interactive=false role=agent
```

### 3.5 Runs 5 and 8: worktree-isolated subagents

Run 5 (three `Read` calls in one response inside an `isolation: "worktree"` subagent):

```text
PROBE start interactive=false role=undefined
PROBE response tool_use id=toolu_01Gixr3D76XRAB2KbHgdaEoj name=Agent agent=undefined
PROBE check tool=Agent id=toolu_01Gixr3D76XRAB2KbHgdaEoj agent=undefined verdict=allow
PROBE response tool_use id=toolu_01AFq6fqGXN3waASm9xdvhkK name=Read agent=a1d2888bafc76d450
PROBE response tool_use id=toolu_01MxMpAckx5rCSErDtZt8iKL name=Read agent=a1d2888bafc76d450
PROBE response tool_use id=toolu_01Ep9D2RTMUCWqukiPpYQdNS name=Read agent=a1d2888bafc76d450
PROBE check tool=Read id=toolu_01AFq6fqGXN3waASm9xdvhkK agent=a1d2888bafc76d450 verdict=allow
PROBE result id=toolu_01AFq6fqGXN3waASm9xdvhkK agent=a1d2888bafc76d450 rung=0 count=1 class=not-found
PROBE check tool=Read id=toolu_01MxMpAckx5rCSErDtZt8iKL agent=a1d2888bafc76d450 verdict=allow
PROBE result id=toolu_01MxMpAckx5rCSErDtZt8iKL agent=a1d2888bafc76d450 rung=0 count=2 class=not-found
PROBE check tool=Read id=toolu_01Ep9D2RTMUCWqukiPpYQdNS agent=a1d2888bafc76d450 verdict=allow
PROBE result id=toolu_01Ep9D2RTMUCWqukiPpYQdNS agent=a1d2888bafc76d450 rung=1 count=3 class=not-found
PROBE response tool_use id=toolu_01EghNSVU1XhWT2QMXL3gZpP name=Bash agent=a1d2888bafc76d450
PROBE check tool=Bash id=toolu_01EghNSVU1XhWT2QMXL3gZpP agent=a1d2888bafc76d450 verdict=ask
```

Run 8: the subagent's `pwd` printed `<scratch>/probe/repo/.claude/worktrees/agent-a21d5b305c894331d`.
With the breaker's `session.append` and `tool.check` hooks loaded, a worktree-isolated agent's Bash ran
in its own worktree.

### 3.6 Run 9: `$.turn.abort`

The probe copy refused the 2nd identical attempt and aborted at once (probe-only thresholds).

```text
PROBE start interactive=false role=undefined
PROBE response tool_use id=toolu_012A3JHUdEQqTmdcbZfQkVaN name=Read agent=undefined
PROBE check tool=Read id=toolu_012A3JHUdEQqTmdcbZfQkVaN agent=undefined verdict=allow
PROBE result id=toolu_012A3JHUdEQqTmdcbZfQkVaN agent=undefined rung=2 count=1 class=not-found
PROBE response tool_use id=toolu_01Qn9MtqeAhyqSv4uPruayxh name=Read agent=undefined
PROBE check tool=Read id=toolu_01Qn9MtqeAhyqSv4uPruayxh agent=undefined verdict=allow
PROBE deny id=toolu_01Qn9MtqeAhyqSv4uPruayxh denied=1 turn=0fe5797e-d0e9-4fbd-8fa9-acceea01cdcf
PROBE abort turn=0fe5797e-d0e9-4fbd-8fa9-acceea01cdcf
$.turn.abort (retry-breaker): cancelled turn 0fe5797e-d0e9-4fbd-8fa9-acceea01cdcf
```

The `-p` result was `subtype: "success"`, `result: ""`: the model's closing "DONE" never came. A host
that reads only `subtype` sees a successful run (spec F-3).

### 3.7 Runs 4 and 7: the model stops on its own

Told to keep going "even when a call is refused or advice appears", Haiku still stopped at the first
refusal (run 4), and in run 7 at the notice on the 3rd failure; in run 11 it stopped at the notice
again. That is the behaviour the ladder exists to produce, and it is why the abort rung needed a
probe-only threshold to be seen at all.
