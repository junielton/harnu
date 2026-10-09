# T453 — Prototype: tests and live runs

**Part of:** [`00-spec.md`](00-spec.md) §7 and §11 (C-1, C-5) · **Source:**
[`02-prototype.md`](02-prototype.md)

Two kinds of evidence. `claude plugin test` exercises the mod's own logic against the engine's
kit, where the test answers everything beneath the plugin (`reference.md:81`). The live runs load
the mod into real headless sessions with `claude -p --plugin-dir`, so the engine itself raises the
events: they are what proves the mechanisms the design hinges on (§3).

## 1. `tests/breaker.test.ts`

The kit stubs every `$` call the plugin makes beneath it (`mock.clock`, `mock.env`, and one test
hook per `ui.*` / `turn.abort` call): a call with no answer beneath it fails the test with
`no implementation for <event>`, and an answer in the wrong shape (`{ isPlaced: true }` instead of
`{ value: { isPlaced: true } }`) is skipped. Both happened on the first run and are fixed below.

```ts
import { errSig } from '../hooks/core'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

type Seen = { opened: string[]; aborted: string[]; logged: string[] }

// Everything beneath the plugin that it calls, answered from memory.
function world(on: On, role?: string, verdict: 'allow' | 'ask' = 'allow'): Seen {
  const seen: Seen = { opened: [], aborted: [], logged: [] }
  mock.clock(on, { now: 1_000_000 })
  mock.env(on, role ? { HARNU_SESSION_ROLE: role } : {})
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('tool.check', () => ({ decision: verdict }))
  on('ui.open', ($, e) => {
    seen.opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('ui.notify', () => ({
    value: { isSent: false as const, reason: 'no-surface' as const }
  }))
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
  await $.session.start({
    cwd: '/repo',
    surface: isInteractive ? 'terminal' : null,
    isInteractive
  })
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

const MISSING = {
  error: 'Exit code 1\ncat: /repo/missing.txt: No such file or directory'
}
const cat = { command: 'cat /repo/missing.txt' }

test('the third identical failure carries a notice the model reads', async ($, on) => {
  world(on)
  await start($)
  expect(await call($, 'Bash', cat, MISSING)).not.toContain('retry-breaker')
  expect(await call($, 'Bash', cat, MISSING)).not.toContain('retry-breaker')
  expect(await call($, 'Bash', cat, MISSING)).toContain('failed 3 times with the same error')
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

test('a real edit between runs resets a failing command', async ($, on) => {
  world(on)
  await start($)
  const tests = { command: 'npm test' }
  const red = { error: 'Exit code 1\nFAIL src/a.test.ts > adds' }
  await call($, 'Bash', tests, red)
  await call($, 'Bash', tests, red)
  await call($, 'Edit', { file_path: '/repo/src/a.ts', old_string: 'a - b' }, { ok: 'edited' })
  expect(await call($, 'Bash', tests, red)).not.toContain('retry-breaker')
})

test('attended: the fourth opens the dialog, the fifth is put to the person', async ($, on) => {
  const seen = world(on)
  await start($)
  for (let i = 0; i < 4; i++) await call($, 'Bash', cat, MISSING)
  expect(seen.opened).toEqual(['retry-breaker'])
  const v = await $.tool.check({
    tool: 'Bash',
    input: cat,
    tool_use_id: 'toolu_next'
  })
  expect(v.decision).toBe('ask')
  expect(v.reason).toContain('failed 4 times')
  expect(seen.aborted).toEqual([])
})

test('unattended: refused with the reason, then the turn is ended', async ($, on) => {
  const seen = world(on, 'agent')
  await start($)
  for (let i = 0; i < 4; i++) await call($, 'Bash', cat, MISSING)
  expect(seen.opened).toEqual([])
  expect(seen.logged.length).toBe(1)
  for (let i = 0; i < 3; i++) {
    const v = await $.tool.check({
      tool: 'Bash',
      input: cat,
      tool_use_id: `toolu_r${i}`
    })
    expect(v.decision).toBe('deny')
    expect(v.reason).toContain('/retry-breaker reset')
  }
  expect(seen.aborted).toEqual(['turn-1'])
  // Another call is never refused.
  expect(
    (
      await $.tool.check({
        tool: 'Bash',
        input: { command: 'ls' },
        tool_use_id: 'toolu_x'
      })
    ).decision
  ).toBe('allow')
})

test('the same error across different inputs warns at four', async ($, on) => {
  world(on)
  await start($)
  const gone = {
    error: 'Agent type "verifier" not found. Available agents: general-purpose'
  }
  let last = ''
  for (let i = 0; i < 4; i++)
    last = await call(
      $,
      'Agent',
      { subagent_type: 'verifier', prompt: `try ${i}`, isolation: `w${i}` },
      gone
    )
  expect(last).toContain('across different inputs')
})

test('a subagent counts apart and never opens the dialog', async ($, on) => {
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
  expect(v.decision).toBe('ask')
})

test('the dialog shows the failures and "Let it retry" lifts the refusal', async ($, on) => {
  world(on)
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
  const v = await $.tool.check({
    tool: 'Bash',
    input: cat,
    tool_use_id: 'toolu_after'
  })
  expect(v.decision).toBe('allow')
})

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
(pass) the third identical failure carries a notice the model reads [39.52ms]
(pass) polls, person refusals and a success in between never add up [32.78ms]
(pass) a real edit between runs resets a failing command [20.15ms]
(pass) attended: the fourth opens the dialog, the fifth is put to the person [22.10ms]
(pass) unattended: refused with the reason, then the turn is ended [20.96ms]
(pass) the same error across different inputs warns at four [18.50ms]
(pass) a subagent counts apart and never opens the dialog [19.79ms]
(pass) the dialog shows the failures and "Let it retry" lifts the refusal [28.19ms]
(pass) unattended: a call nobody could approve is never a failure [18.83ms]
(pass) a stored notice does not change what counts as the same error [0.19ms]

 10 pass
 0 fail
Ran 10 tests across 1 file. [0.33s]
```

Two tests were added because a run found a real defect, not to raise the count:

- "polls, person refusals and a success in between never add up" failed first: polls were kept out
  of the exact rule but still counted under the same-error rule. The fix keeps a poll out of both
  (spec §3.4 X5).
- "unattended: a call nobody could approve is never a failure" pins the defect live run 1 found
  (§3).
- "a stored notice does not change what counts as the same error" pins what the transcript check
  found (§3, run 3): the host twin reads stored results, which carry the notice.

## 3. Live runs

Each run loaded an instrumented copy of the prototype (the same module plus `$.ui.log(..., { to:
'debug' })` lines prefixed `PROBE`) from the scratchpad into a headless session in a throwaway git
repository, `--debug-file` capturing the log. Paths below are replaced by `<scratch>`.

| Run | Model  | What it proves                                                                                                                                | Result                                                                                                                                      |
| --- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | haiku  | `session.append` sees the `tool_use` (door `response`) and its `tool_result` (door `tool-result`) under one id; `tool.check` sees the verdict | proven; and a defect: the headless `ask` became `This command requires approval`, which the classifier counted                              |
| 2   | haiku  | the fix: an `ask` with nobody attending is a permission outcome                                                                               | proven: no result counted                                                                                                                   |
| 3   | haiku  | the notice reaches the model; the refusal reaches the model with its reason; the transcript stores both                                       | proven                                                                                                                                      |
| 4   | haiku  | the abort cap in a natural loop                                                                                                               | not reached: the model stopped at the first refusal                                                                                         |
| 5   | sonnet | a worktree-isolated subagent: `agentId` on both events, the notice inside the subagent's loop                                                 | proven                                                                                                                                      |
| 6   | sonnet | Bash in a worktree subagent with the mod loaded                                                                                               | inconclusive: the operator's own Bash-rewrite PreToolUse hook made Claude Code's worktree guard refuse the command (the corpus class of E3) |
| 7   | haiku  | abort with cap 0                                                                                                                              | not reached: the model stopped after the notice at 3                                                                                        |
| 8   | sonnet | Bash in a worktree subagent with the mod loaded (plain `pwd`)                                                                                 | proven: it ran in the subagent's worktree (#92533 does not occur)                                                                           |
| 9   | haiku  | `$.turn.abort` from `tool.check`, with probe-only thresholds (refuse the 2nd attempt, cap 0)                                                  | proven                                                                                                                                      |

Runs 1 and 2 used `Bash` with an allow rule; the operator's user-level `PreToolUse` hook on `Bash`
rewrites commands, so the rewritten command no longer matched the rule and the verdict stayed
`ask`. Runs 3–9 use `Read` of a missing file, which needs no permission. That `tool.check` works on
`Bash`, and does not break worktree agents, is T389's smoke B1.2/B1.6/B4
(`docs/specs/T389-companion-mod/P3W2-structured-sentinel.md:48-53`) and this spec's run 8.

### Run 3 — notice, refusal, transcript

Prompt (abridged): "Use the Read tool on `<scratch>/probe/repo/missing.txt` … make the exact same
Read call again, unchanged, … until you have made 8 calls in total or a call is refused … quote
verbatim every line starting with `[retry-breaker]` …".

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

The model's answer (session `f0a283f0-deb3-4291-997c-df91c4e83201`), abridged:

```text
Calls made: 5. Calls 1–4 failed with "File does not exist". Call 5 was refused by the retry-breaker plugin.

> [retry-breaker] This exact Read call has now failed 3 times with the same error. Repeating it unchanged will fail again: change the input, check the cause, or stop and say what blocks you.
> [retry-breaker] This exact Read call has now failed 4 times with the same error. …

"Permission to use Read denied by plugin retry-breaker: retry-breaker: this exact Read call already failed 4 times with the same error (...). Change the call or the cause first. The person can lift this with /retry-breaker reset."
```

The stored transcript (`~/.claude/projects/<slug>/f0a283f0-….jsonl`) holds the notice text 3 times
and the refusal text 2 times: the rewrite is what the transcript file keeps, as the event's doc says
(`types/claude-code.d.ts:4349-4357`).

### Run 5 — a worktree-isolated subagent

Prompt (abridged): one `Agent` call, `subagent_type: general-purpose`, `isolation: "worktree"`; the
subagent reads `missing.txt` three times, then runs `pwd && git branch --show-current`.

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

The subagent issued the three `Read` calls in one response (three `tool_use` rows first, then three
results); they still counted 1, 2, 3, and the notice landed in the subagent's own loop. It reported
its working directory as `<scratch>/probe/repo/.claude/worktrees/agent-a1d2888bafc76d450`.

### Run 8 — Bash in a worktree subagent

```text
PROBE start interactive=false role=undefined
PROBE response tool_use id=toolu_01XX9u4njDf5jagEErgDtquf name=Agent agent=undefined
PROBE check tool=Agent id=toolu_01XX9u4njDf5jagEErgDtquf agent=undefined verdict=allow
PROBE response tool_use id=toolu_01JYp5fC8nMKCxHHX4geNfZf name=Bash agent=a21d5b305c894331d
PROBE check tool=Bash id=toolu_01JYp5fC8nMKCxHHX4geNfZf agent=a21d5b305c894331d verdict=allow
```

Answer: the subagent's `pwd` printed `<scratch>/probe/repo/.claude/worktrees/agent-a21d5b305c894331d`.
With the breaker's `session.append` and `tool.check` hooks loaded, a worktree-isolated agent's Bash
ran in its own worktree.

### Run 9 — `$.turn.abort`

The probe copy refused the 2nd identical attempt and aborted at once (`ask: 1`, `abortAfterDenied:
0`), which only a probe does.

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

The `-p` result was `subtype: "success"`, `result: ""`: the model's closing "DONE" never came. A
host that reads only `subtype` sees a successful run. See spec §5.4 and F-3.

### Runs 4 and 7 — the model stops on its own

Told to keep going "even when a call is refused or advice appears", Haiku still stopped at the
first refusal (run 4), and in run 7 at the notice on the 3rd failure. That is the behaviour the
ladder is built to produce, and it is also why the abort rung needed a probe-only threshold to be
seen at all.
