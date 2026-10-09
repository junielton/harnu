# T447 — Worked example: `decision-log` (§14 of the spec)

**Part of:** [`00-spec.md`](00-spec.md) · **Card:** T447 · **Status:** specified (not implemented)

This file is §14 of the spec, split out for length. It types against the contract in
[`01-contract.md`](01-contract.md). Section references below point at `00-spec.md`.

A third-party mod that records decisions to Harnu memory with `/decide`, keeps them locally when
Harnu is not there, and draws the session's mission step above the prompt. It exercises a command,
a write, a typed refusal, the outside fallback and a subscription.

This example has **not** been run through `claude plugin validate` or `claude plugin test`: this
unit is spec-only, and writing it into a mods folder would load it. It is checked in W5 (§15).

`.claude-plugin/plugin.json`

```json
{
  "name": "decision-log",
  "version": "0.1.0",
  "description": "Record decisions to Harnu memory with /decide and show the mission step above the prompt",
  "dependencies": ["harnu"],
  "types": "./types/index.d.ts"
}
```

`hooks/hooks.json`

```json
{ "modules": ["./register.tsx"] }
```

`types/index.d.ts`

```ts
export type DecisionLogLast = {
  text: string
  at: number
  where: 'harnu' | 'local'
}

declare module 'claude-code' {
  interface PluginState {
    'decision-log': { last: DecisionLogLast | null; isHidden: boolean }
  }
}
```

`hooks/register.tsx`

```tsx
import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { DecisionLogLast } from '../types'

const last = atom({ plugin: 'decision-log', key: 'last' } as const, null)
const isHidden = atom({ plugin: 'decision-log', key: 'isHidden' } as const, false)
// Published by the `harnu` mod (its contract declares PluginState['harnu']).
const mission = atom({ plugin: 'harnu', key: 'mission' } as const, null)

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'decide',
      description: 'Record a decision (what and why) in Harnu memory'
    })
    // Without Harnu the noun is absent (assumption A4); everything below checks first.
    if ('harnu' in $) await $.harnu.watch({ topic: 'mission' })

    return next(e)
  })

  on('command.run', { command: 'decide' }, async ($, e) => {
    const text = e.args.trim()
    if (text === '') return { text: 'Usage: /decide <what was decided, and why>' }
    const at = await $.clock.now()

    if ('harnu' in $) {
      const res = await $.harnu.memoryAppend({ page: 'decisions', entry: `- ${text}` })
      if (res.ok) {
        await update($, last, (): DecisionLogLast => ({ text, at, where: 'harnu' }))

        return { text: 'Decision recorded in Harnu memory.' }
      }
      if (res.error === 'FOLDER_NOT_ALLOWED' || res.error === 'CONFIRM_DENIED') {
        // The operator said no: do not keep a copy that looks like it was saved.
        return { text: `Harnu refused it: ${res.message}` }
      }
    }

    // Outside Harnu, no MCP, or Harnu not running: keep it in this mod's own store.
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

`tests/decide.test.ts` (the primary fake of §12.1)

```ts
import { expect, test } from 'claude-code/testing'

test('/decide writes through $.harnu and reports success', async ($, on) => {
  const seen: unknown[] = []
  // Bottom hook: stands for the `harnu` noun (assumption A5).
  on('harnu.memoryAppend', (_$, e) => {
    seen.push(e)
    return { value: { ok: true, page: 'decisions' } }
  })
  on('harnu.watch', () => ({ value: { ok: true, topic: 'mission' } }))

  const out = await $.command.run({ command: 'decide', args: 'Use SQLite for the cache' })

  expect(seen).toEqual([{ page: 'decisions', entry: '- Use SQLite for the cache' }])
  expect(out).toEqual({ text: 'Decision recorded in Harnu memory.' })
})

test('/decide keeps the decision locally when Harnu refuses with NO_MCP', async ($, on) => {
  on('harnu.memoryAppend', () => ({
    value: { ok: false, error: 'NO_MCP', message: 'This session has no Harnu MCP.' }
  }))
  const out = await $.command.run({ command: 'decide', args: 'Ship on Friday' })
  expect(out).toEqual({
    text: 'Harnu is not reachable here; decision kept locally (decision-log store).'
  })
})
```

The two `$.command.run` calls show the intent; the exact `CommandRunInput` a test passes
(`TYPES:1792-1819`: `command`, `args`, `origin`, presentation) is fixed in W5 when the example is
validated.
