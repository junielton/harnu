# T453 — Prototype: the mod half

**Part of:** [`00-spec.md`](00-spec.md) §11 (C-5) · **Detector:**
[`04-detector-core.md`](04-detector-core.md) · **Tests and live runs:**
[`03-prototype-tests.md`](03-prototype-tests.md)

The minimal hooks module for the core mechanism: the in-session seat (`hooks/register.tsx`), its
manifest with the `level` option, and its state contract. The detector it imports,
`hooks/core.ts`, is in its own file because it is normative (it is the definition, `00-spec.md` §3)
and because Harnu's host twin imports it too. Written and run from the session scratchpad, never from
this repo, and pasted whole.

Toolchain: types written by Claude Code **2.1.295** (the `plugin-authoring` skill's
`types/claude-code.d.ts`); `claude plugin validate`, `claude plugin test` and every live run on
**2.1.296**; TypeScript 5.9.3.

## 1. Layout

```text
retry-breaker/
  .claude-plugin/plugin.json   manifest, with the `level` userConfig option
  hooks/hooks.json
  hooks/core.ts                the detector (04-detector-core.md), shared with Harnu's host twin
  hooks/register.tsx           observe, notice, dialog, refuse, abort, /retry-breaker
  types/index.d.ts             the $.state contract
  tests/breaker.test.ts        (03-prototype-tests.md)
```

## 2. Manifests

`.claude-plugin/plugin.json`. The `level` field is a picker over its `options` in the config menu
(`reference.md:74`); the default is `notice` (`00-spec.md` §10.1):

```json
{
  "name": "retry-breaker",
  "version": "0.1.0",
  "description": "Notices the same failing tool call repeating, tells the model and the person, and can refuse the repeat.",
  "types": "./types/index.d.ts",
  "author": {
    "name": "Harnu"
  },
  "userConfig": {
    "level": {
      "type": "string",
      "title": "Level",
      "description": "off: nothing. notice: tell the model, then the person. enforce: also refuse the 5th identical attempt and, unattended, end the turn.",
      "options": ["off", "notice", "enforce"],
      "default": "notice"
    }
  }
}
```

`hooks/hooks.json`:

```json
{ "modules": ["./register.tsx"] }
```

## 3. `types/index.d.ts`

```ts
export type RetryBreakerFailure = { at: number; head: string }

export type RetryBreakerEntry = {
  key: string
  rule: 'exact' | 'same-error'
  tool: string
  sig: string
  count: number
  lastIndex: number
  failures: RetryBreakerFailure[]
  since: number
  denied: number
}

export type RetryBreakerLedger = {
  seen: Record<string, number>
  entries: Record<string, RetryBreakerEntry[]>
  muted: string[]
}

/** The storm the dialog shows, and what Harnu's host-side twin reports. */
export type RetryBreakerStorm = {
  loop: string
  entry: RetryBreakerEntry
  why?: string
}

declare module 'claude-code' {
  interface PluginState {
    'retry-breaker': {
      ledger: RetryBreakerLedger
      storm: RetryBreakerStorm | null
      turnId: string | null
      attended: boolean
      level: string | null
    }
  }
}
```

## 4. `hooks/register.tsx`

```tsx
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { RetryBreakerLedger, RetryBreakerStorm } from '../types'
import {
  callSig,
  emptyLedger,
  exclusion,
  MUTE_NOTICE,
  noticeText,
  recordFailure,
  recordSuccess,
  refusalFor,
  refusalReason,
  RESET_NOTICE,
  resetLedger,
  RULES,
  tick
} from './core'

const PANE = 'retry-breaker'
const ledger = atom(
  { plugin: 'retry-breaker', key: 'ledger' } as const,
  emptyLedger() as RetryBreakerLedger
)
const storm = atom(
  { plugin: 'retry-breaker', key: 'storm' } as const,
  null as RetryBreakerStorm | null
)
const turnId = atom({ plugin: 'retry-breaker', key: 'turnId' } as const, null as string | null)
const attended = atom({ plugin: 'retry-breaker', key: 'attended' } as const, false)
/** The session's level: the `level` option, until `/retry-breaker off|notice|enforce` says otherwise. */
const level = atom({ plugin: 'retry-breaker', key: 'level' } as const, null as string | null)

type Block = {
  type: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  is_error?: boolean
  content?: unknown
}

// tool_use id -> the call as the model made it, and the permission verdict it got.
const calls = new Map<string, { tool: string; input: unknown }>()
const verdicts = new Map<string, string>()

const textOf = (c: unknown): string =>
  typeof c === 'string'
    ? c
    : Array.isArray(c)
      ? c
          .map((b: Block & { text?: string }) => (b?.type === 'text' ? (b.text ?? '') : ''))
          .join('\n')
      : ''

const withNotice = (c: unknown, notice: string): unknown =>
  Array.isArray(c) ? [...c, { type: 'text', text: notice }] : `${textOf(c)}\n\n${notice}`

const clone = (l: RetryBreakerLedger): RetryBreakerLedger => JSON.parse(JSON.stringify(l))

async function escalate($: EngineInterface, loop: string, s: RetryBreakerStorm): Promise<void> {
  await update($, storm, () => s)
  if (!(await read($, attended)) || loop !== 'main') {
    $.ui.log(`retry-breaker: ${s.entry.tool} failed ${s.entry.count}× the same way (${loop})`)
    return
  }
  void $.ui.notify(`${s.entry.tool} failed ${s.entry.count}× the same way`, {
    title: 'Retry storm'
  })
  void $.ui.open({
    id: PANE,
    title: 'Retry storm',
    focus: true,
    closeOnEscape: true,
    holdToasts: true
  })
}

// The `level` option as loaded (a reload runs `register` again and re-reads it).
let configured = 'notice'

async function levelNow($: EngineInterface): Promise<string> {
  return (await read($, level)) ?? configured
}

/** A reset or a mute, said in the transcript as a notice the model never reads (spec §5.4). */
async function record($: EngineInterface, text: string): Promise<void> {
  await $.session.append({ message: { type: 'system', content: [{ type: 'text', text }] } })
}

export const register: Register = (on, options) => {
  configured = typeof options.level === 'string' ? options.level : 'notice'

  on('session.start', async ($, e, next) => {
    const role = await $.env.get('HARNU_SESSION_ROLE')
    await update(
      $,
      attended,
      () => e.isInteractive && role !== 'agent' && role !== 'tick' && role !== 'read-only'
    )
    await $.command.register({
      name: 'retry-breaker',
      description: 'Retry-storm breaker: status, reset, or set the level (off, notice, enforce)',
      argumentHint: 'status | reset | off | notice | enforce'
    })
    return next(e)
  })

  on('command.run', { command: 'retry-breaker' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'reset') {
      await update($, ledger, (l) => {
        const x = clone(l)
        resetLedger(x)
        return x
      })
      await update($, storm, () => null)
      await record($, RESET_NOTICE)
      return { text: 'Retry-breaker: every count and mute cleared.' }
    }
    if (arg === 'off' || arg === 'notice' || arg === 'enforce') {
      await update($, level, () => arg)
      return { text: `Retry-breaker: level ${arg} for this session.` }
    }
    const l = await read($, ledger)
    const open = Object.values(l.entries)
      .flat()
      .filter((x) => x.count >= 2)
    return {
      text:
        `Retry-breaker: level ${await levelNow($)}. ` +
        (open.length
          ? open.map((x) => `${x.tool} ×${x.count} (${x.rule})`).join(', ')
          : 'No repeated failure.')
    }
  })

  on('turn.start', async ($, e, next) => {
    await update($, turnId, () => e.turnId)
    // R4: a prompt the person typed is an intervention: the main loop starts over.
    if (e.text.trim() !== '')
      await update($, ledger, (l) => {
        const x = clone(l)
        resetLedger(x, 'main')
        return x
      })
    return next(e)
  })

  // Bash-safe: tool.check, never tool.call (ADR-0018 D6, #92533).
  on('tool.check', async ($, e, next) => {
    const v = await next(e)
    if (e.tool_use_id) verdicts.set(e.tool_use_id, v.decision)
    if (v.decision === 'deny' || !e.tool_use_id || (await levelNow($)) !== 'enforce') return v
    const loop = e.agentId ?? 'main'
    const hit = refusalFor(await read($, ledger), loop, callSig(e.tool, e.input))
    if (!hit) return v
    // Always a deny with the reason, never an ask: live, an ask's reason is not drawn in the
    // terminal dialog and auto mode settles an ask without anyone (spec §5.1, run 10).
    const reason = refusalReason(hit)
    await update($, ledger, (x) => ({
      ...x,
      entries: {
        ...x.entries,
        [loop]: (x.entries[loop] ?? []).map((y) =>
          y.key === hit.key ? { ...y, denied: y.denied + 1 } : y
        )
      }
    }))
    // R4 of the ladder: only unattended, only the main loop. A person has the dialog's [Stop].
    const id = await read($, turnId)
    if (
      loop === 'main' &&
      id &&
      !(await read($, attended)) &&
      hit.denied + 1 > RULES.abortAfterDenied
    )
      void $.turn.abort({ turnId: id })
    verdicts.set(e.tool_use_id, 'deny')
    return { decision: 'deny' as const, reason }
  }).catch(($, e, next) => next(e))

  on('session.append', { door: 'response' }, ($, e, next) => {
    for (const b of e.message.content as Block[])
      if (b.type === 'tool_use' && b.id && b.name) calls.set(b.id, { tool: b.name, input: b.input })
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.append', { door: 'tool-result' }, async ($, e, next) => {
    if ((await levelNow($)) === 'off') return next(e)
    const loop = e.agentId ?? 'main'
    const now = await $.clock.now()
    let changed = false
    let raised: RetryBreakerStorm | null = null
    const isAttended = await read($, attended)
    const l = clone(await read($, ledger))
    const content = (e.message.content as Block[]).map((b) => {
      const call = b.type === 'tool_result' && b.tool_use_id ? calls.get(b.tool_use_id) : undefined
      if (!call || !b.tool_use_id) return b
      calls.delete(b.tool_use_id)
      tick(l, loop)
      if (!b.is_error) {
        recordSuccess(l, loop, call.tool, call.input, now)
        return b
      }
      // X3/X4: refused before it ran, by the permission layer or by this mod. Never a failure.
      const verdict = verdicts.get(b.tool_use_id)
      if (verdict === 'deny' || (verdict === 'ask' && !isAttended)) return b
      const text = textOf(b.content)
      if (exclusion(call.tool, call.input, text)) return b
      const v = recordFailure(l, loop, call.tool, call.input, text, now)
      if (!v || v.rung === 0) return b
      if (v.rung === 2) raised = { loop, entry: v.entry }
      changed = true
      return { ...b, content: withNotice(b.content, noticeText(v.entry)) }
    })
    await update($, ledger, () => l)
    if (raised) await escalate($, loop, raised)
    return changed
      ? next({ ...e, message: { ...e.message, content: content as typeof e.message.content } })
      : next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const s = await read($, storm)
    if (!s) return <Text dimColor>No retry storm right now.</Text>
    const shown = s.entry.failures
    const width = Math.max(20, Math.floor(e.props.bodyColumns / Math.max(1, shown.length)) - 1)
    const stop = async () => {
      const id = await read($, turnId)
      if (id) await $.turn.abort({ turnId: id })
      await $.ui.close({ id: PANE })
    }
    const letRetry = async () => {
      await update($, ledger, (l) => ({ ...l, muted: [...l.muted, s.entry.key] }))
      await update($, storm, () => null)
      await record($, `${MUTE_NOTICE} ${s.entry.key}`)
      await $.ui.close({ id: PANE })
    }
    const askWhy = async () => {
      const r = await $.model.fork({
        prompt: `Your ${s.entry.tool} call failed ${s.entry.count} times with the same error. In three sentences: why, and what should change?`
      })
      await update($, storm, (x) =>
        x ? { ...x, why: r.isAnswered ? r.text : `no answer (${r.reason})` } : x
      )
    }
    return (
      <Box flexDirection="column">
        <Text bold>
          {s.entry.tool} failed {s.entry.count}× the same way ({s.entry.rule})
        </Text>
        <Box flexDirection="row">
          {shown.map((f, i) => (
            <Box key={`f${i}`} width={width} flexDirection="column" marginRight={1}>
              <Text dimColor>#{s.entry.count - shown.length + i + 1}</Text>
              <Text>{f.head}</Text>
            </Box>
          ))}
        </Box>
        {s.why !== undefined && <Text>{s.why}</Text>}
        <Box flexDirection="row">
          <Button key="stop" hotkey="s" variant="primary" label="Stop the turn" onPress={stop} />
          <Button key="retry" hotkey="r" label="Let it retry" onPress={letRetry} />
          <Button key="why" hotkey="w" label="Ask why" onPress={askWhy} />
        </Box>
      </Box>
    )
  })
}
```

## 5. `tsconfig.json` (kept outside the mod folder)

The header of the types file prescribes these options (`types/claude-code.d.ts:67-76`); `include`
names the types file, as the skill says to do before the engine lays types beside a mod.

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
    "<skill>/types/claude-code.d.ts",
    "retry-breaker/hooks",
    "retry-breaker/types",
    "retry-breaker/tests"
  ]
}
```

## 6. Real output

`claude plugin validate`:

```text
$ claude --version
2.1.296 (Claude Code)

$ claude plugin validate retry-breaker
Validating plugin manifest: retry-breaker/.claude-plugin/plugin.json

  ❯ types ./types/index.d.ts declares on $: nothing (no EngineInterface member)
  ❯ types ./types/index.d.ts declares state: retry-breaker.ledger, retry-breaker.storm, retry-breaker.turnId, retry-breaker.attended, retry-breaker.level

Validating hooks: retry-breaker/hooks/hooks.json

  ❯ ./register.tsx hooks: session.start, command.run{command=retry-breaker}, turn.start, tool.check, session.append{door=response}, session.append{door=tool-result}, ui.render{component=Pane, requestId=retry-breaker}
  ❯ ./register.tsx answers its own command: command.run{command=retry-breaker}
  ❯ ./register.tsx gating hook with .catch: tool.check
  ❯ ./register.tsx gating hook with .catch: session.append{door=response}
  ❯ ./register.tsx gating hook with .catch: session.append{door=tool-result}
  ❯ ./register.tsx calls: $.clock.now, $.command.register, $.env.get, $.model.fork, $.session.append (via record), $.state.get, $.state.set, $.turn.abort, $.ui.close, $.ui.log (via escalate), $.ui.notify (via escalate), $.ui.open (via escalate), $.ui.resolve
  ❯ ./register.tsx env writes: nothing
  ❯ ./register.tsx env reads: HARNU_SESSION_ROLE
  ❯ ./register.tsx state writes: retry-breaker.attended, retry-breaker.ledger, retry-breaker.level, retry-breaker.storm, retry-breaker.turnId
  ❯ ./register.tsx state reads: retry-breaker.attended, retry-breaker.ledger, retry-breaker.level, retry-breaker.storm, retry-breaker.turnId

✔ Validation passed
```

Type-check:

```text
$ tsc -p tsconfig.json   # TypeScript 5.9.3
exit 0
```

Validate reports seven hooks: three gating with a `.catch`, and the `command.run` hook "answers its
own command". It reports one env read (`HARNU_SESSION_ROLE`). There is no `tool.call`, no
`$.mcp.call`, no `$.fs` and no `$.process`. This is the surface §10.3 of the spec reads its audit chips
from.
