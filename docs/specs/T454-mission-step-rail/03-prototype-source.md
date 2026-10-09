# T454 — Prototype source (round 3)

The prototype mod described in [`01-prototype.md`](01-prototype.md): its manifest, contract and
hooks module, split out for length. Its tests and type-check config are in
[`04-prototype-tests.md`](04-prototype-tests.md). Part of the [T454 spec](00-spec.md). Extract the files below into a folder named
`rail-proto` and run `claude plugin validate`, `claude plugin test` and `tsc -p` as
[`01-prototype.md`](01-prototype.md) §3 shows.

### `.claude-plugin/plugin.json`

```json
{
  "name": "rail-proto",
  "version": "0.1.0",
  "description": "T454 prototype: the mod half of the mission step rail above the prompt.",
  "author": {
    "name": "Harnu"
  },
  "types": "./types/index.d.ts"
}
```

### `hooks/hooks.json`

```json
{ "modules": ["./register.ts"] }
```

### `types/index.d.ts`

```ts
// T454 prototype contract. Self-contained (no import), as the engine requires.
export type RailStepState = 'verified' | 'done' | 'running' | 'waiting' | 'blocked' | 'todo'
export type RailAction = 'claim' | 'block' | 'unblock' | 'log'
/** What the host pushes (the proposed `ui.band.set` `rail` field). The mod never recounts. */
export type RailView = {
  v: 1
  /** The host's revision for this binding; a press names it and nothing else. */
  rev: number
  role: 'owner' | 'child'
  /** `progressHeadline(derived.progress)` for the owner; the child's own step position for a child. */
  headline: { kind: 'single' | 'range' | 'done' | 'empty'; n: number; to: number; m: number }
  /** Owner only: the pill's primary state word, absent for active / total-changed. */
  state?: 'blocked' | 'needs you' | 'stale' | 're-scope pending' | 'delivered'
  step?: {
    title: string
    level: 'existence' | 'verifier' | 'human'
    proof: 'unproven' | 'claimed' | 'self-verified' | 'verified'
    state: RailStepState
    blocker?: { reason: string; owner: 'agent' | 'operator' }
  }
  staleMin?: number
  actions: readonly RailAction[]
  /** The outcome of the last press, for one revision. */
  result?: { action: RailAction; ok: boolean; code?: string }
  /** The mod's clock + TTL at apply time. */
  expiresAt: number
}
/** Why a final row stands: the rail went away, the step changed, or Harnu stopped answering. */
export type RailGone = 'gone' | 'changed' | 'unreachable'
/** What a field or confirm pinned when it opened: the revision and step number the person saw. */
export type RailPin = { rev: number; n: string }
export type RailMode =
  | { kind: 'idle' }
  | ({ kind: 'confirm-claim' } & RailPin)
  | ({ kind: 'block' } & RailPin)
  | ({ kind: 'log' } & RailPin)
  | { kind: 'sent'; action: RailAction }
  | { kind: 'unreachable'; action: RailAction; text?: string; rev: number; n: string }
  /** `unsaved`: a press the person started was lost; drawn until Dismiss, whatever the focus. */
  | { kind: 'final'; why: RailGone; unsaved: boolean }

declare module 'claude-code' {
  interface PluginState {
    'rail-proto': { rail: RailView | null; mode: RailMode }
  }
}
```

### `hooks/rail-core.ts`

```ts
import type { RailAction, RailGone, RailMode, RailView } from '../types'

/** Pure and `$`-free: what the row says at a given `bodyColumns` (spec §6.2). */

export const RAIL_MIN_COLUMNS = 40
export const CHIP_BELOW_COLUMNS = 60
/** A title or reason shorter than this after truncation is dropped instead. */
export const PART_MIN = 12

export type KeyId = RailAction | 'yes' | 'no' | 'retry' | 'dismiss'
export interface Key {
  id: KeyId
  hotkey: string
  label: string
  /** Never cut by width: the band keeps a focusable element (F-1). */
  keep?: true
}

const KEY: Record<KeyId, Omit<Key, 'keep'>> = {
  claim: { id: 'claim', hotkey: 'c', label: 'Claim' },
  block: { id: 'block', hotkey: 'b', label: 'Block' },
  unblock: { id: 'unblock', hotkey: 'u', label: 'Clear block' },
  log: { id: 'log', hotkey: 'l', label: 'Log' },
  yes: { id: 'yes', hotkey: 'y', label: 'Claim' },
  no: { id: 'no', hotkey: 'n', label: 'Cancel' },
  retry: { id: 'retry', hotkey: 'r', label: 'Retry' },
  dismiss: { id: 'dismiss', hotkey: 'x', label: 'Dismiss' }
}
const key = (id: KeyId, keep = false): Key => (keep ? { ...KEY[id], keep: true } : { ...KEY[id] })

const LEVEL: Record<'existence' | 'verifier' | 'human', string> = {
  existence: 'Existence check',
  verifier: 'Verifier',
  human: 'Human'
}

/** A note replaces the status word; its `short` form is never cut. */
export interface Note {
  full: string
  short: string
}

export interface RowSpec {
  lead?: { full: string; chip: string }
  title?: string
  status?: string
  reason?: string
  note?: Note
  level?: string
  stale?: string
  keys: Key[]
}

export interface RailRow {
  text: string
  keys: Key[]
}

export function headlineText(h: RailView['headline']): { full: string; chip: string } | null {
  if (h.kind === 'empty') return null
  if (h.kind === 'done') return { full: `Step ${h.m} of ${h.m} ✓`, chip: `${h.m}/${h.m} ✓` }
  if (h.kind === 'range')
    return { full: `Steps ${h.n}–${h.to} of ${h.m}`, chip: `${h.n}–${h.to}/${h.m}` }
  return { full: `Step ${h.n} of ${h.m}`, chip: `${h.n}/${h.m}` }
}

/**
 * The step's word, first match wins (spec §6.1). It reads the derived state the host sent and the
 * stored proof; it never decides which step is done.
 */
export function statusWord(step: NonNullable<RailView['step']>): string {
  if (step.state === 'verified') return '✓ Verified'
  if (step.state === 'done') {
    return step.proof === 'claimed' || step.proof === 'self-verified' ? 'Claimed' : 'Done'
  }
  if (step.blocker) return 'Blocked'
  if (step.state === 'running') return 'Running'
  if (step.state === 'waiting') return 'Waiting'
  return 'To do'
}

export function cut(text: string, max: number): string | null {
  if (max < PART_MIN) return null
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`
}

export function formatStale(min: number): string {
  if (min < 60) return `${min}m`
  if (min < 24 * 60) return `${Math.floor(min / 60)}h ${min % 60}m`
  return `${Math.floor(min / 1440)}d ${Math.floor((min % 1440) / 60)}h`
}

export function keysWidth(keys: readonly Key[]): number {
  return keys.reduce((w, k, i) => w + (i ? 2 : 0) + k.hotkey.length + 2 + k.label.length, 0)
}

function text(s: RowSpec, chip: boolean): string {
  const parts: string[] = []
  if (s.lead) parts.push(chip ? s.lead.chip : s.lead.full)
  if (s.title) parts.push(s.title)
  if (s.note) parts.push(s.note.full)
  else if (s.status) parts.push(s.reason ? `${s.status}: ${s.reason}` : s.status)
  if (s.level) parts.push(s.level)
  if (s.stale) parts.push(s.stale)
  return `◆ ${parts.join(' · ')}`
}

const width = (s: RowSpec, chip: boolean): number =>
  text(s, chip).length + (s.keys.length ? 2 + keysWidth(s.keys) : 0)

/**
 * Fits a row to `columns` by cutting, in this order (spec §6.2): the level, the stale age, the
 * title (truncated, then dropped), the blocker reason (the same), the note's long form, the keys
 * not marked `keep` (last first), the lead's long form, and the lead itself when a note stands.
 * Never cut: the status word, a note's short form, a `keep` key.
 */
export function fitRow(spec: RowSpec, columns: number): RailRow {
  const s: RowSpec = { ...spec, keys: [...spec.keys] }
  let chip = false
  const fits = (): boolean => width(s, chip) <= columns
  const steps: (() => void)[] = [
    () => void (s.level = undefined),
    () => void (s.stale = undefined),
    () => {
      if (!s.title) return
      const without = width({ ...s, title: undefined }, chip)
      s.title = cut(s.title, columns - without - 3) ?? undefined
    },
    () => {
      if (!s.reason) return
      const without = width({ ...s, reason: undefined }, chip)
      s.reason = cut(s.reason, columns - without - 2) ?? undefined
    },
    () => void (s.note = s.note ? { full: s.note.short, short: s.note.short } : undefined)
  ]
  for (const step of steps) {
    if (fits()) break
    step()
  }
  while (!fits()) {
    const i = s.keys.map((k) => !k.keep).lastIndexOf(true)
    if (i < 0) break
    s.keys.splice(i, 1)
  }
  if (!fits()) chip = true
  if (!fits() && s.note) s.lead = undefined
  return { text: text(s, chip), keys: s.keys }
}

const GONE: Record<RailGone, { kept: Note; lost: Note }> = {
  gone: {
    kept: { full: 'Mission closed or step unlinked.', short: 'No step now.' },
    lost: {
      full: 'Mission closed or step unlinked. Nothing was saved.',
      short: 'Nothing was saved.'
    }
  },
  changed: {
    kept: { full: 'The step changed.', short: 'Step changed.' },
    lost: { full: 'The step changed. Nothing was saved.', short: 'Nothing was saved.' }
  },
  unreachable: {
    kept: { full: 'Harnu is not reachable.', short: 'Not reachable.' },
    lost: { full: 'Harnu is not reachable. Nothing was saved.', short: 'Nothing was saved.' }
  }
}

const REFUSAL: Record<string, string> = {
  MISSION_CLOSED: 'mission closed',
  FOLDER_NOT_ALLOWED: 'this folder is blocked for agents',
  RAIL_STALE: 'the step changed, look again',
  PROOF_NOT_CLAIMABLE: 'already verified',
  TOO_FAST: 'too fast, try again'
}

/**
 * The row for everything but the two modal kinds that draw their own controls (the claim confirm
 * and an `Input`). `held`: the band drew a focusable element in its last frame, so this one must
 * draw one too (F-1); `null` = no row.
 */
export function railRow(
  rail: RailView | null,
  mode: RailMode,
  columns: number,
  held: boolean
): RailRow | null {
  const head = rail ? headlineText(rail.headline) : null
  if (mode.kind === 'final') {
    if (!mode.unsaved && !held) return null
    const g = GONE[mode.why]
    return fitRow({ note: mode.unsaved ? g.lost : g.kept, keys: [key('dismiss', true)] }, columns)
  }
  if (mode.kind === 'unreachable') {
    return fitRow(
      {
        ...(head && rail?.role === 'child' ? { lead: head } : {}),
        ...(rail?.step ? { title: rail.step.title } : {}),
        note: GONE.unreachable.lost,
        keys: [key('retry'), key('dismiss', true)]
      },
      columns
    )
  }
  if (rail === null || head === null) return null
  if (rail.role === 'owner' || !rail.step) {
    const owner: RowSpec = {
      lead: { full: `Harnu ${head.full}`, chip: `Harnu ${head.chip}` },
      ...(rail.state ? { status: rail.state } : {}),
      keys: held ? [key('dismiss', true)] : []
    }
    if (!held && columns < RAIL_MIN_COLUMNS) return null
    return fitRow(owner, columns)
  }
  const step = rail.step
  const keys = rail.actions.map((a, i) => key(a, i === 0))
  if (keys.length === 0 && held) keys.push(key('dismiss', true))
  if (!held && columns < RAIL_MIN_COLUMNS) return null
  let note: Note | undefined
  if (mode.kind === 'sent') note = { full: 'Saving…', short: 'Saving…' }
  else if (rail.result && !rail.result.ok) {
    const why = REFUSAL[rail.result.code ?? ''] ?? 'Harnu refused it'
    note = { full: `Not saved: ${why}.`, short: 'Not saved.' }
  } else if (rail.result?.ok && rail.result.action === 'log')
    note = { full: 'Logged.', short: 'Logged.' }
  return fitRow(
    {
      lead: head,
      title: step.title,
      status: statusWord(step),
      ...(step.blocker && !note ? { reason: step.blocker.reason } : {}),
      ...(note ? { note } : {}),
      level: LEVEL[step.level],
      ...(rail.staleMin !== undefined
        ? { stale: `mission stale ${formatStale(rail.staleMin)}` }
        : {}),
      keys
    },
    columns
  )
}

/** The claim confirm, longest text that fits; its two keys are never cut. */
export function confirmRow(stepN: string, level: string, columns: number): RailRow {
  const note =
    level === 'human' ? 'You still mark it verified in Harnu.' : 'A verifier still checks it.'
  const long = [key('yes', true), key('no', true)]
  const short = [
    { ...KEY.yes, label: 'Yes', keep: true as const },
    { ...KEY.no, label: 'No', keep: true as const }
  ]
  const tries: RailRow[] = [
    { text: `◆ Claim step ${stepN} as done? ${note}`, keys: long },
    { text: `◆ Claim step ${stepN} as done?`, keys: long },
    { text: `◆ Claim step ${stepN}?`, keys: short },
    { text: '◆ Claim?', keys: short }
  ]
  return tries.find((r) => r.text.length + 2 + keysWidth(r.keys) <= columns) ?? tries[3]!
}

/** The `Input` row's texts by width: the field itself is never cut. */
export function inputLabels(
  kind: 'block' | 'log',
  stepN: string,
  columns: number
): { label: string; placeholder?: string; submitLabel: string } {
  const submitLabel = kind === 'block' ? 'raise' : 'log'
  if (columns >= 90) {
    return kind === 'block'
      ? {
          label: `◆ Blocker on step ${stepN}`,
          placeholder: 'what blocks it (Enter on empty cancels)',
          submitLabel
        }
      : {
          label: `◆ Log on step ${stepN}`,
          placeholder: 'note (Enter on empty cancels)',
          submitLabel
        }
  }
  if (columns >= CHIP_BELOW_COLUMNS) {
    return kind === 'block'
      ? { label: `◆ Blocker on step ${stepN}`, placeholder: 'what blocks it', submitLabel }
      : { label: `◆ Log on step ${stepN}`, placeholder: 'note', submitLabel }
  }
  return { label: kind === 'block' ? '◆ Block' : '◆ Log', submitLabel }
}

/**
 * What a push or an expiry does to the mode (spec §7.5). An open confirm or `Input` is left alone:
 * only the person ends it (live E15: a key the band does not bind goes to the prompt, so closing
 * the field under the person's typing would send the rest of it there). Its target is checked
 * when the person ends it (`checkTarget`). An idle rail whose line goes away becomes a final row
 * that is drawn only while the band was holding a focusable element. `why` is the cause of a `null`.
 */
export function reconcile(mode: RailMode, rail: RailView | null, why: RailGone): RailMode {
  if (rail === null && mode.kind === 'idle') return { kind: 'final', why, unsaved: false }
  if (rail !== null && mode.kind === 'final' && !mode.unsaved) return { kind: 'idle' }
  return mode
}

/** Whether the press the person just finished may be sent; else the final row that says why. */
export function checkTarget(
  rail: RailView | null,
  action: RailAction,
  why: RailGone
): RailMode | null {
  if (rail === null) return { kind: 'final', why, unsaved: true }
  if (!rail.actions.includes(action)) return { kind: 'final', why: 'changed', unsaved: true }
  return null
}
```

### `hooks/rail-view.tsx`

```tsx
import type { Elements } from 'claude-code'

import type { KeyId, RailRow } from './rail-core'

/** The rail's trees. Pure: they receive the resolved elements and closures, never `$` (MOD-1). */
export interface RailHandlers {
  key: (id: KeyId) => void
  submit: (kind: 'block' | 'log', text: string) => void
}

export function rowTree(els: Elements['terminal'], row: RailRow, on: RailHandlers): JSX.Element {
  const { Box, Button, Text } = els
  return (
    <Box>
      <Text dimColor wrap="truncate-end">
        {row.text}
      </Text>
      {row.keys.map((k) => (
        <Box key={`gap-${k.id}`}>
          <Text>{'  '}</Text>
          <Button
            key={`rail-${k.id}`}
            hotkey={k.hotkey}
            plain
            label={k.label}
            onPress={() => on.key(k.id)}
          />
        </Box>
      ))}
    </Box>
  )
}

export function inputTree(
  els: Elements['terminal'],
  kind: 'block' | 'log',
  labels: { label: string; placeholder?: string; submitLabel: string },
  on: RailHandlers
): JSX.Element {
  const { Box, Input } = els
  return (
    <Box>
      <Input
        key={`rail-${kind}`}
        autoFocus
        label={labels.label}
        {...(labels.placeholder ? { placeholder: labels.placeholder } : {})}
        submitLabel={labels.submitLabel}
        onSubmit={(value) => on.submit(kind, value)}
      />
    </Box>
  )
}

/** The rail's row above whatever the plugins beneath drew: it wraps, never replaces (P4W2 §7.4). */
export function stack(
  els: Elements['terminal'],
  row: JSX.Element,
  below: JSX.Element
): JSX.Element {
  const { Box } = els
  return (
    <Box flexDirection="column">
      {row}
      {below}
    </Box>
  )
}
```

### `hooks/register.ts`

```ts
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { RailAction, RailGone, RailMode, RailView } from '../types'
import { checkTarget, confirmRow, inputLabels, railRow, reconcile, type KeyId } from './rail-core'
import { inputTree, rowTree, stack, type RailHandlers } from './rail-view'

/**
 * T454 prototype, the mod half. In the spec this lives in `harnu-companion`: the host pushes the
 * rail in `ui.band.set` over the command channel and a press leaves as a `ui.action` edge event.
 * Here one POST to a stand-in host carries both directions so `claude plugin test` can script it.
 */
const HOST = 'http://localhost:47999/rail'
const POLL_MS = 2_000
const TTL_MS = 90_000
const TEXT_MAX = 200

const railRef = atom({ plugin: 'rail-proto', key: 'rail' } as const, null)
const modeRef = atom({ plugin: 'rail-proto', key: 'mode' } as const, { kind: 'idle' } as RailMode)

/** Per band instance: did its last frame draw a Button or an Input? (F-1, spec §7.5) */
const lastFocusable = new Map<string, boolean>()
/** Why the line last went away: the host pushed `null`, or its TTL ran out. */
let goneWhy: RailGone = 'gone'

type Pushed = Omit<RailView, 'expiresAt'>
type RailEvent = { t: 'ui.action'; d: { name: `step.${RailAction}`; rev: number; text?: string } }

/** One round trip: send queued events, apply the band the host answers. Never rejects. */
async function sync($: EngineInterface, events: RailEvent[]): Promise<boolean> {
  try {
    const res = await $.http.fetch(HOST, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events })
    })
    if (!res.ok) return false
    const body = JSON.parse(res.text) as { band?: Pushed | null }
    if (body.band === undefined) return true
    const now = await $.clock.now()
    const pushed = body.band === null ? null : { ...body.band, expiresAt: now + TTL_MS }
    // A lower revision never overwrites a higher one (P4W2 §7.4, `n`).
    const next = await update($, railRef, (prev) =>
      prev && pushed && prev.rev > pushed.rev ? prev : pushed
    )
    if (next === null) goneWhy = 'gone'
    await update($, modeRef, (m) => reconcile(m, next, 'gone'))
    return true
  } catch {
    return false
  }
}

async function tick($: EngineInterface): Promise<void> {
  await sync($, [])
  const now = await $.clock.now()
  const rail = await read($, railRef)
  if (rail && rail.expiresAt <= now) {
    // A dead host cannot leave a stale step on screen, nor a stale mode behind it.
    goneWhy = 'unreachable'
    await update($, railRef, () => null)
    await update($, modeRef, (m) => reconcile(m, null, 'unreachable'))
  }
}

/**
 * What the person saw when a key was drawn: the revision and the step number of that frame. A
 * press names this revision, never the current one: the host answers `RAIL_STALE` when the step
 * that revision showed is no longer the one it resolves (spec §7.3). The label of an open field
 * keeps naming the step it opened on.
 */
interface Seen {
  rev: number
  n: string
}

const stepNOf = (rail: RailView | null): string =>
  rail?.headline.kind === 'single' ? String(rail.headline.n) : 'this'

/** A press carries the action and the revision the person saw. Never a step id (spec §7.3). */
async function send(
  $: EngineInterface,
  action: RailAction,
  seen: Seen,
  text?: string
): Promise<void> {
  const rail = await read($, railRef)
  const gone = checkTarget(rail, action, goneWhy)
  if (gone) {
    await update($, modeRef, () => gone)
    return
  }
  await update($, modeRef, (): RailMode => ({ kind: 'sent', action }))
  const d = {
    name: `step.${action}` as const,
    rev: seen.rev,
    ...(text !== undefined ? { text } : {})
  }
  const ok = await sync($, [{ t: 'ui.action', d }])
  await update($, modeRef, (m): RailMode =>
    ok
      ? m.kind === 'sent'
        ? { kind: 'idle' }
        : m
      : { kind: 'unreachable', action, rev: seen.rev, n: seen.n, ...(text ? { text } : {}) }
  )
}

async function onKey($: EngineInterface, id: KeyId, requestId: string, seen: Seen): Promise<void> {
  const mode = await read($, modeRef)
  const idle = (): RailMode => ({ kind: 'idle' })
  if (id === 'dismiss') {
    // The one press that may leave the band with nothing focusable: the person asked for it.
    lastFocusable.set(requestId, false)
    await update($, modeRef, idle)
    return
  }
  if (id === 'retry' && mode.kind === 'unreachable') {
    return send($, mode.action, { rev: mode.rev, n: mode.n }, mode.text)
  }
  if (id === 'yes' && mode.kind === 'confirm-claim') {
    return send($, 'claim', { rev: mode.rev, n: mode.n })
  }
  if (id === 'no') {
    await update($, modeRef, idle)
    return
  }
  if (mode.kind !== 'idle') return // a press while saving does nothing
  if (id === 'claim') {
    await update($, modeRef, (): RailMode => ({ kind: 'confirm-claim', ...seen }))
  } else if (id === 'block' || id === 'log') {
    await update($, modeRef, (): RailMode => ({ kind: id, ...seen }))
  } else if (id === 'unblock') await send($, 'unblock', seen)
}

function handlers($: EngineInterface, requestId: string, seen: Seen): RailHandlers {
  return {
    key: (id) => {
      void onKey($, id, requestId, seen).catch(() => undefined)
    },
    submit: (kind, value) => {
      void (async () => {
        const mode = await read($, modeRef)
        const text = value.trim().slice(0, TEXT_MAX)
        if (text === '' || (mode.kind !== 'block' && mode.kind !== 'log')) {
          await update($, modeRef, (): RailMode => ({ kind: 'idle' }))
        } else await send($, kind, { rev: mode.rev, n: mode.n }, text)
      })().catch(() => undefined)
    }
  }
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    void tick($).catch(() => undefined)
    $.clock.every(POLL_MS, () => {
      void tick($).catch(() => undefined)
    })
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    try {
      if (e.surface !== 'terminal' || e.props.hasSurvey) return below
      const rail = await read($, railRef)
      const mode = await read($, modeRef)
      const cols = e.props.bodyColumns
      const held = lastFocusable.get(e.requestId) ?? false
      const els = $.ui.resolve(e)
      const seen: Seen = { rev: rail?.rev ?? 0, n: stepNOf(rail) }
      const act = handlers($, e.requestId, seen)
      // An open Input or confirm stays drawn whatever the push, the TTL or the width (spec §7.5),
      // and keeps naming the step it opened on.
      if (mode.kind === 'block' || mode.kind === 'log') {
        lastFocusable.set(e.requestId, true)
        return stack(
          els,
          inputTree(els, mode.kind, inputLabels(mode.kind, mode.n, cols), act),
          below
        )
      }
      const row =
        mode.kind === 'confirm-claim'
          ? confirmRow(mode.n, rail?.step?.level ?? 'verifier', cols)
          : railRow(rail, mode, cols, held)
      lastFocusable.set(e.requestId, (row?.keys.length ?? 0) > 0)
      return row === null ? below : stack(els, rowTree(els, row, act), below)
    } catch {
      return below // fail open: the band is never worse than without the rail
    }
  })
}
```
