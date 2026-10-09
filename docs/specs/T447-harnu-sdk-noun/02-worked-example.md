# T447 — Worked example: `decision-log` (§14 of the spec)

**Part of:** [`00-spec.md`](00-spec.md) · **Card:** T447 · **Status:** specified (not implemented)

This file is §14 of the spec, split out for length. It types against the contract in
[`01-contract.md`](01-contract.md). Section references point at `00-spec.md`.

A third-party mod that records decisions to Harnu memory with `/decide`, reports a write the
operator has not approved yet as pending, keeps decisions in its own store when Harnu is not there,
and draws the session's mission step above the prompt. It exercises a command, a write, a typed
refusal, the pending path, the "no Harnu at all" path and a subscription (the `harnu.mission` atom,
§10.2).

## Run on Claude Code 2.1.295

The files below were extracted verbatim into a scratch folder `decision-log/` and checked on
2026-10-09. For `tsc`, the folder also held what the engine lays for a loaded dependency:
`.claude-plugin/types/claude-code/index.d.ts` (the 2.1.295 API) and
`.claude-plugin/types/harnu/index.d.ts` (the contract of `01-contract.md`), with the `tsconfig.json`
from the API file's header. No `harnu` mod was installed: validation ran with the dependency
absent.

`claude plugin validate .`:

```
Validating plugin manifest: <decision-log>/.claude-plugin/plugin.json

  ❯ types ./types/index.d.ts declares on $: nothing (no EngineInterface member)
  ❯ types ./types/index.d.ts declares state: decision-log.last, decision-log.isHidden

Validating hooks: <decision-log>/hooks/hooks.json

  ❯ ./register.tsx hooks: session.start, command.run{command=decide}, ui.render{component=AbovePrompt}
  ❯ ./register.tsx answers its own command: command.run{command=decide}
  ❯ ./register.tsx calls: $.clock.now, $.command.register, $.harnu.memoryAppend, $.harnu.watch, $.state.get, $.state.set, $.store.get, $.store.set, $.ui.resolve
  ❯ ./register.tsx state writes: decision-log.isHidden, decision-log.last
  ❯ ./register.tsx state reads: decision-log.isHidden, decision-log.last, harnu.mission
  ❯ ./register.tsx state of other plugins, not checked (run validate in a session with them enabled): harnu.mission

✔ Validation passed
```

`claude plugin test .`:

```
tests/decide.test.ts:
(pass) /decide writes through $.harnu [28.13ms]
(pass) /decide reports a pending approval, never success [12.54ms]
(pass) /decide keeps the decision locally when Harnu answers NO_MCP [12.80ms]
(pass) /decide works with no harnu mod loaded at all [9.86ms]

 4 pass
 0 fail
Ran 4 tests across 1 file. [0.16s]
```

`npx -p typescript@5.6 tsc -p .`: no output, exit 0.

**What the first run caught.** The first version detected the noun with a promise `.catch()`. With
no `harnu` mod loaded, `$.harnu` is `undefined`, so the call throws before any promise exists, and
the test without a provider failed:

```
(fail) /decide works with no harnu mod loaded at all
  HooksError: no implementation for command.run
  …
    decision-log's command.run hook was skipped: decision-log: undefined is not an object
    (evaluating '$.harnu.memoryAppend')
```

The version below uses `try/catch` (§11.3). The same run showed that a test's `$` has no `store`
noun to read back, so the local-fallback test asserts through a `store.set` hook instead.

## `.claude-plugin/plugin.json`

```json
{
  "name": "decision-log",
  "version": "0.1.0",
  "description": "Record decisions to Harnu memory with /decide and show the mission step above the prompt",
  "author": { "name": "Example Author" },
  "dependencies": ["harnu"],
  "types": "./types/index.d.ts"
}
```

## `hooks/hooks.json`

```json
{ "modules": ["./register.tsx"] }
```

## `types/index.d.ts`

```ts
export type DecisionLogLast = {
  text: string
  at: number
  where: 'harnu' | 'pending' | 'local'
}

declare module 'claude-code' {
  interface PluginState {
    'decision-log': { last: DecisionLogLast | null; isHidden: boolean }
  }
}
```

## `hooks/register.tsx`

```tsx
import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { DecisionLogLast } from '../types'

const last = atom({ plugin: 'decision-log', key: 'last' } as const, null)
const isHidden = atom({ plugin: 'decision-log', key: 'isHidden' } as const, false)
// Published by the `harnu` mod: its contract declares PluginState['harnu'].
const mission = atom({ plugin: 'harnu', key: 'mission' } as const, null)

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'decide',
      description: 'Record a decision (what and why) in Harnu memory'
    })
    // With no `harnu` mod loaded, `$.harnu` is undefined and the call throws (§11.3).
    try {
      await $.harnu.watch({ topic: 'mission' })
    } catch {
      // no harnu mod: the band simply never shows
    }

    return next(e)
  })

  on('command.run', { command: 'decide' }, async ($, e) => {
    const text = e.args.trim()
    if (text === '') return { text: 'Usage: /decide <what was decided, and why>' }
    const at = await $.clock.now()

    // `null` means no `harnu` mod is loaded at all: the call threw (§11.3).
    let res: Awaited<ReturnType<typeof $.harnu.memoryAppend>> | null = null
    try {
      res = await $.harnu.memoryAppend({ page: 'decisions', entry: `- ${text}` })
    } catch {
      res = null
    }

    if (res !== null && res.ok) {
      await update($, last, (): DecisionLogLast => ({ text, at, where: 'harnu' }))

      return { text: 'Decision recorded in Harnu memory.' }
    }
    if (res !== null && res.error === 'PENDING') {
      // Not recorded yet: the operator has to answer in the Approval Inbox.
      await update($, last, (): DecisionLogLast => ({ text, at, where: 'pending' }))

      return { text: `Waiting for your approval in Harnu (${res.approvalId ?? 'no id'}).` }
    }
    if (
      res !== null &&
      (res.error === 'FOLDER_NOT_ALLOWED' ||
        res.error === 'CONFIRM_DENIED' ||
        res.error === 'PATH_ESCAPE')
    ) {
      // The operator said no: do not keep a copy that looks saved.
      return { text: `Harnu refused it: ${res.message}` }
    }

    // No harnu mod, outside Harnu, no MCP, or Harnu not running: keep it in this mod's store.
    const kept = ((await $.store.get('pending')) as string[] | undefined) ?? []
    await $.store.set('pending', [...kept, text])
    await update($, last, (): DecisionLogLast => ({ text, at, where: 'local' }))

    return { text: 'Harnu is not reachable here; decision kept locally (decision-log store).' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const m = await read($, mission)
    if (e.props.hasSurvey || m === null || (await read($, isHidden))) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const p = m.progress
    const where = p.allDone
      ? `Step ${p.total} of ${p.total} ✓`
      : p.current === null
        ? `${p.done} of ${p.total} done`
        : p.current.from === p.current.to
          ? `Step ${p.current.from} of ${p.total}`
          : `Steps ${p.current.from}–${p.current.to} of ${p.total}`

    return (
      <Box>
        <Text dimColor>
          {m.title} · {where}
          {m.blocked ? ' · blocked' : ''}
          {m.stale ? ' · stale' : ''}{' '}
        </Text>
        <Button key="hide" label="Hide" onPress={() => update($, isHidden, () => true)} />
      </Box>
    )
  })
}
```

## `tests/decide.test.ts`

The stand-in provider of §12.1 at the default `user` tier (the tier Harnu stages the real mod at; the kit gives the same result at every tier), plus per-test answers from bottom hooks.

```ts
import { expect, mock, test } from 'claude-code/testing'
import type { Register } from 'claude-code'

// A stand-in `harnu` mod: adds the noun with answers that always succeed. A test that needs
// another answer hooks the method's event (`harnu.memoryAppend`) beneath it. Self-contained, as
// an inline plugin must be: it closes over nothing of this file.
const fakeHarnu: Register = (on) => {
  on('engine.create', async (_$, e, next) => {
    const built = await next(e)
    return {
      ...built,
      harnu: {
        watch: async (a: { topic: string }) => ({ ok: true, topic: a.topic }),
        memoryAppend: async (a: { page: string }) => ({ ok: true, page: a.page })
      }
    } as never
  })
}
const HARNU = { plugins: [{ name: 'harnu', register: fakeHarnu }] }

const decide = (args: string) =>
  ({
    command: 'decide',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 }
  }) as const

test('/decide writes through $.harnu', HARNU, async ($, on) => {
  mock.clock(on, { now: 1_000 })
  const seen: unknown[] = []
  on('harnu.memoryAppend', (_$, e, next) => {
    seen.push(e)
    return next(e)
  })

  const out = await $.command.run(decide('Use SQLite for the cache'))

  expect(seen).toEqual([{ page: 'decisions', entry: '- Use SQLite for the cache' }])
  expect(out).toEqual({ text: 'Decision recorded in Harnu memory.' })
})

test('/decide reports a pending approval, never success', HARNU, async ($, on) => {
  mock.clock(on, { now: 1_000 })
  on('harnu.memoryAppend', () => ({
    value: { ok: false, error: 'PENDING', approvalId: 'appr-1', message: 'Parked.' }
  }))

  const out = await $.command.run(decide('Ship on Friday'))

  expect(out).toEqual({ text: 'Waiting for your approval in Harnu (appr-1).' })
})

test('/decide keeps the decision locally when Harnu answers NO_MCP', HARNU, async ($, on) => {
  mock.clock(on, { now: 1_000 })
  const kept: unknown[] = []
  on('store.get', () => ({ value: undefined }))
  on('store.set', (_$, e) => {
    kept.push(e)
    return { value: undefined }
  })
  on('harnu.memoryAppend', () => ({
    value: { ok: false, error: 'NO_MCP', message: 'This session has no Harnu MCP.' }
  }))

  const out = await $.command.run(decide('Ship on Friday'))

  expect(out).toEqual({
    text: 'Harnu is not reachable here; decision kept locally (decision-log store).'
  })
  expect(kept).toEqual([{ key: 'pending', value: ['Ship on Friday'] }])
})

test('/decide works with no harnu mod loaded at all', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  mock.store(on)

  const out = await $.command.run(decide('Ship on Friday'))

  expect(out).toEqual({
    text: 'Harnu is not reachable here; decision kept locally (decision-log store).'
  })
})
```
