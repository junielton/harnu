# T453 — Prototype: the mod half

**Part of:** [`00-spec.md`](00-spec.md) §11 (C-5) · **Tests and runs:**
[`03-prototype-tests.md`](03-prototype-tests.md)

The minimal hooks module for the core mechanism: the detector (`hooks/core.ts`, pure, zero
imports), the in-session seat (`hooks/register.tsx`) and its state contract. It was written and run
from the session scratchpad, never from this repo, and is pasted here whole. It is a prototype:
names, thresholds and copy follow the spec, but the production mod (W1, `00-spec.md` §12) adds the
`/retry-breaker` command, the `userConfig` switch and the copy review.

Toolchain: types written by Claude Code **2.1.295** (the `plugin-authoring` skill's
`types/claude-code.d.ts`); `claude plugin validate` and `claude plugin test` run on **2.1.296**,
the CLI installed when this spec was written; TypeScript 5.9.3.

## 1. Layout

```text
retry-breaker/
  .claude-plugin/plugin.json
  hooks/hooks.json
  hooks/core.ts        the detector (§3 of the spec), shared with Harnu's host twin
  hooks/register.tsx   the in-session seat: observe, notice, dialog, refuse, abort
  types/index.d.ts     the $.state contract
  tests/breaker.test.ts
```

## 2. Manifests

`.claude-plugin/plugin.json`:

```json
{
  "name": "retry-breaker",
  "version": "0.1.0",
  "description": "Notices the same failing tool call repeating, tells the model, and asks the person before it repeats again.",
  "types": "./types/index.d.ts",
  "author": {
    "name": "Harnu"
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
    }
  }
}
```

## 4. `hooks/core.ts`

```ts
// The detector: pure functions, zero imports, so Harnu's host can run the same
// definition over a transcript that the mod runs in-session (spec §3, §7).

export type ErrorClass =
  | 'person'
  | 'interrupted'
  | 'permission'
  | 'invalid-input'
  | 'edit-mismatch'
  | 'not-found'
  | 'timeout'
  | 'exit-nonzero'
  | 'other'

export type Failure = { at: number; head: string }

export type Entry = {
  /** `exact:<callSig>|<errSig>` or `same-error:<tool>|<errSig>`. */
  key: string
  rule: 'exact' | 'same-error'
  tool: string
  sig: string
  count: number
  /** Calls seen in this loop when the last failure landed (the call window). */
  lastIndex: number
  failures: Failure[]
  denied: number
}

export type Ledger = {
  /** Calls seen per loop (`main` or a subagent's agentId). */
  seen: Record<string, number>
  entries: Record<string, Entry[]>
  muted: string[]
}

export const RULES = {
  exact: { notice: 3, ask: 4, deny: 5 },
  sameError: { notice: 4, ask: 5 },
  windowCalls: 20,
  windowMs: 10 * 60_000,
  abortAfterDenied: 2
} as const

export const MUTATING = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

const POLLER =
  /\b(sleep|until|while|watch|wait-for|wait-on)\b|--watch\b|\bgh (pr checks|run (view|watch))\b|\bkubectl rollout status\b/

/** cyrb53: a 53-bit string hash, synchronous (the module has no Node crypto). */
export function hash(text: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

function canon(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canon).join(',') + ']'
  if (value !== null && typeof value === 'object') {
    const rec = value as Record<string, unknown>
    return (
      '{' +
      Object.keys(rec)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canon(rec[k]))
        .join(',') +
      '}'
    )
  }
  return JSON.stringify(value) ?? 'null'
}

const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined ? '' : String(v))

/** What "the same call" compares, per tool (spec §3.1). */
export function callSig(tool: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>
  switch (tool) {
    case 'Bash':
      return 'Bash:' + hash(str(i.command).replace(/\s+/g, ' ').trim())
    case 'Edit':
      return 'Edit:' + hash(str(i.file_path) + '\0' + str(i.old_string))
    case 'Read':
      return 'Read:' + hash(str(i.file_path) + '\0' + str(i.offset) + '\0' + str(i.limit))
    case 'Write':
      return 'Write:' + hash(str(i.file_path))
    case 'NotebookEdit':
      return 'NotebookEdit:' + hash(str(i.notebook_path) + '\0' + str(i.cell_id))
    case 'Grep':
    case 'Glob':
      return tool + ':' + hash(str(i.pattern) + '\0' + str(i.path) + '\0' + str(i.glob))
    case 'Agent':
      return 'Agent:' + hash(str(i.subagent_type) + '\0' + str(i.isolation))
    default: {
      const rest = { ...i }
      delete rest.description
      return tool + ':' + hash(canon(rest))
    }
  }
}

/** Polling is repetition by design: never counted (spec §3.3, X5). */
export function isPoll(tool: string, input: unknown): boolean {
  if (tool !== 'Bash') return false
  return POLLER.test(str((input as Record<string, unknown> | undefined)?.command))
}

/** Error classes (spec §3.2). The first three are never counted. */
export function classify(text: string): ErrorClass {
  const t = text.slice(0, 2000)
  if (/The user doesn't want to proceed|The user wants to clarify/.test(t)) return 'person'
  if (/^\[Request interrupted|Interrupted by user|\[Tool call interrupted/.test(t))
    return 'interrupted'
  if (
    /auto mode cannot determine|rate-limited\), so auto|requested permissions to .* but you haven't granted|This command requires approval|Permission to use .* (has been )?denied/.test(
      t
    )
  )
    return 'permission'
  if (/InputValidationError|Input validation error|could not be parsed as JSON/.test(t))
    return 'invalid-input'
  if (/String to replace not found|No changes to make|Found \d+ matches of the string/.test(t))
    return 'edit-mismatch'
  if (/does not exist|ENOENT|No such file or directory|NOT_FOUND|not found/i.test(t))
    return 'not-found'
  if (/timed out|timeout/i.test(t)) return 'timeout'
  if (/^Exit code \d+/.test(t)) return 'exit-nonzero'
  return 'other'
}

export const COUNTED = (c: ErrorClass): boolean =>
  c !== 'person' && c !== 'interrupted' && c !== 'permission'

/** What "the same error" compares: volatile tokens folded (spec §3.2). */
export function errSig(text: string): string {
  return hash(normalizeError(text))
}

export function normalizeError(text: string): string {
  return text
    .replace(/\n*\[retry-breaker\][^\n]*/g, '') // our own notice, as stored
    .slice(0, 4000)
    .replace(/<\/?tool_use_error>/g, '')
    .replace(/\b[0-9a-f]{7,40}\b/gi, 'H')
    .replace(/\d+(\.\d+)?/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600)
}

/** A bare exit status says nothing about the cause: no same-error rule on it. */
export function isGeneric(text: string): boolean {
  return /^(Exit code N|N)$/.test(normalizeError(text))
}

export const emptyLedger = (): Ledger => ({ seen: {}, entries: {}, muted: [] })

/** Counts one call into the loop's window; returns the call's index. */
export function tick(l: Ledger, loop: string): number {
  l.seen[loop] = (l.seen[loop] ?? 0) + 1
  return l.seen[loop]
}

function expire(l: Ledger, loop: string, now: number): void {
  const idx = l.seen[loop] ?? 0
  l.entries[loop] = (l.entries[loop] ?? []).filter(
    (e) =>
      idx - e.lastIndex <= RULES.windowCalls &&
      now - (e.failures.at(-1)?.at ?? now) <= RULES.windowMs
  )
}

/** A success resets its own signature and, after a mutation, every Bash entry. */
export function recordSuccess(
  l: Ledger,
  loop: string,
  tool: string,
  sig: string,
  now: number
): void {
  expire(l, loop, now)
  l.entries[loop] = (l.entries[loop] ?? []).filter(
    (e) =>
      e.sig !== sig &&
      !(e.rule === 'same-error' && e.tool === tool) &&
      !(MUTATING.has(tool) && e.tool === 'Bash')
  )
}

export type Verdict = { entry: Entry; rung: 0 | 1 | 2 | 3 }

/** Counts one failure under both rules and returns the higher rung it reaches. */
export function recordFailure(
  l: Ledger,
  loop: string,
  tool: string,
  sig: string,
  text: string,
  now: number,
  poll: boolean
): Verdict | null {
  expire(l, loop, now)
  if (poll) return null
  const list = (l.entries[loop] ??= [])
  const err = errSig(text)
  const head = text.replace(/\s+/g, ' ').trim().slice(0, 160)
  const bump = (key: string, rule: Entry['rule']): Entry => {
    let e = list.find((x) => x.key === key)
    if (!e)
      list.push(
        (e = {
          key,
          rule,
          tool,
          sig,
          count: 0,
          lastIndex: 0,
          failures: [],
          denied: 0
        })
      )
    e.count += 1
    e.lastIndex = l.seen[loop] ?? 0
    e.failures = [...e.failures, { at: now, head }].slice(-4)
    return e
  }
  const verdicts: Verdict[] = []
  const ex = bump(`exact:${sig}|${err}`, 'exact')
  const r = RULES.exact
  verdicts.push({
    entry: ex,
    rung: ex.count >= r.deny ? 3 : ex.count >= r.ask ? 2 : ex.count >= r.notice ? 1 : 0
  })
  if (!isGeneric(text)) {
    const se = bump(`same-error:${tool}|${err}`, 'same-error')
    const q = RULES.sameError
    verdicts.push({
      entry: se,
      rung: se.count >= q.ask ? 2 : se.count >= q.notice ? 1 : 0
    })
  }
  const live = verdicts.filter((v) => !l.muted.includes(v.entry.key))
  live.sort((a, b) => b.rung - a.rung)
  return live[0] ?? null
}

/** The exact entry a new call would repeat, if it has reached the refusal rung. */
export function refusalFor(l: Ledger, loop: string, sig: string): Entry | null {
  const e = (l.entries[loop] ?? []).find((x) => x.rule === 'exact' && x.sig === sig)
  if (!e || l.muted.includes(e.key) || e.count < RULES.exact.ask) return null
  return e
}

export function noticeText(e: Entry): string {
  const n = e.count
  return e.rule === 'exact'
    ? `[retry-breaker] This exact ${e.tool} call has now failed ${n} times with the same error. ` +
        `Repeating it unchanged will fail again: change the input, check the cause, or stop and say what blocks you.`
    : `[retry-breaker] ${e.tool} has failed ${n} times with the same error across different inputs. ` +
        `The cause is likely outside the input: check it, or stop and say what blocks you.`
}

export function refusalReason(e: Entry): string {
  return (
    `retry-breaker: this exact ${e.tool} call already failed ${e.count} times with the same error ` +
    `("${e.failures.at(-1)?.head ?? ''}"). Change the call or the cause first. ` +
    `The person can lift this with /retry-breaker reset.`
  )
}
```

## 5. `hooks/register.tsx`

```tsx
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { RetryBreakerLedger, RetryBreakerStorm } from '../types'
import {
  classify,
  COUNTED,
  callSig,
  emptyLedger,
  isPoll,
  noticeText,
  recordFailure,
  recordSuccess,
  refusalFor,
  refusalReason,
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

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const role = await $.env.get('HARNU_SESSION_ROLE')
    await update($, attended, () => e.isInteractive && role !== 'agent' && role !== 'tick')
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await update($, turnId, () => e.turnId)
    // A prompt the person typed is an intervention: the main loop starts over.
    if (e.text.trim() !== '')
      await update($, ledger, (l) => ({
        ...l,
        entries: { ...l.entries, main: [] }
      }))
    return next(e)
  })

  // Bash-safe: tool.check, never tool.call (ADR-0018 D6, #92533).
  on('tool.check', async ($, e, next) => {
    const v = await next(e)
    if (e.tool_use_id) verdicts.set(e.tool_use_id, v.decision)
    if (v.decision === 'deny' || !e.tool_use_id) return v
    const loop = e.agentId ?? 'main'
    const l = await read($, ledger)
    const hit = refusalFor(l, loop, callSig(e.tool, e.input))
    if (!hit) return v
    const reason = refusalReason(hit)
    if (await read($, attended)) return { decision: 'ask' as const, reason }
    await update($, ledger, (x) => ({
      ...x,
      entries: {
        ...x.entries,
        [loop]: (x.entries[loop] ?? []).map((y) =>
          y.key === hit.key ? { ...y, denied: y.denied + 1 } : y
        )
      }
    }))
    const id = await read($, turnId)
    if (loop === 'main' && id && hit.denied + 1 > RULES.abortAfterDenied)
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
    const loop = e.agentId ?? 'main'
    const now = await $.clock.now()
    let changed = false
    let raised: RetryBreakerStorm | null = null
    const l: RetryBreakerLedger = JSON.parse(JSON.stringify(await read($, ledger)))
    const isAttended = await read($, attended)
    const content = (e.message.content as Block[]).map((b) => {
      const call = b.type === 'tool_result' && b.tool_use_id ? calls.get(b.tool_use_id) : undefined
      if (!call || !b.tool_use_id) return b
      calls.delete(b.tool_use_id)
      tick(l, loop)
      const sig = callSig(call.tool, call.input)
      if (!b.is_error) {
        recordSuccess(l, loop, call.tool, sig, now)
        return b
      }
      const text = textOf(b.content)
      // Refused before it ran: the permission layer's, never a failure (§3.2).
      const verdict = verdicts.get(b.tool_use_id)
      if (verdict === 'deny' || (verdict === 'ask' && !isAttended)) return b
      if (!COUNTED(classify(text))) return b
      const v = recordFailure(l, loop, call.tool, sig, text, now, isPoll(call.tool, call.input))
      if (!v || v.rung === 0) return b
      if (v.rung >= 2) raised = { loop, entry: v.entry }
      changed = true
      return { ...b, content: withNotice(b.content, noticeText(v.entry)) }
    })
    await update($, ledger, () => l)
    if (raised) await escalate($, loop, raised)
    return changed
      ? next({
          ...e,
          message: {
            ...e.message,
            content: content as typeof e.message.content
          }
        })
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
      await update($, ledger, (l) => ({
        ...l,
        muted: [...l.muted, s.entry.key]
      }))
      await update($, storm, () => null)
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

## 6. `tsconfig.json` (kept outside the mod folder)

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

## 7. Real output

`claude plugin validate`:

```text
$ claude --version
2.1.296 (Claude Code)

$ claude plugin validate retry-breaker
Validating plugin manifest: retry-breaker/.claude-plugin/plugin.json

  ❯ types ./types/index.d.ts declares on $: nothing (no EngineInterface member)
  ❯ types ./types/index.d.ts declares state: retry-breaker.ledger, retry-breaker.storm, retry-breaker.turnId, retry-breaker.attended

Validating hooks: retry-breaker/hooks/hooks.json

  ❯ ./register.tsx hooks: session.start, turn.start, tool.check, session.append{door=response}, session.append{door=tool-result}, ui.render{component=Pane, requestId=retry-breaker}
  ❯ ./register.tsx gating hook with .catch: tool.check
  ❯ ./register.tsx gating hook with .catch: session.append{door=response}
  ❯ ./register.tsx gating hook with .catch: session.append{door=tool-result}
  ❯ ./register.tsx calls: $.clock.now, $.env.get, $.model.fork, $.state.get, $.state.set, $.turn.abort, $.ui.close, $.ui.log (via escalate), $.ui.notify (via escalate), $.ui.open (via escalate), $.ui.resolve
  ❯ ./register.tsx env writes: nothing
  ❯ ./register.tsx env reads: HARNU_SESSION_ROLE
  ❯ ./register.tsx state writes: retry-breaker.attended, retry-breaker.ledger, retry-breaker.storm, retry-breaker.turnId
  ❯ ./register.tsx state reads: retry-breaker.attended, retry-breaker.ledger, retry-breaker.storm, retry-breaker.turnId

✔ Validation passed
```

Type-check:

```text
$ tsc -p tsconfig.json   # TypeScript 5.9.3
exit 0
```

What validate reports is the audit surface §10.3 of the spec predicts from: six hooks, three of them
gating with a `.catch`, one env read (`HARNU_SESSION_ROLE`), and no `tool.call`, no `$.mcp.call`, no
`$.fs`, no `$.process`.
