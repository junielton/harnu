/**
 * Campaign ch.5a (T597, spec §3.7 + Amendment b) — the steward's three hooks, as pure transforms
 * on a parsed `.claude/settings.local.json`, and the Mission Brief the compaction hook prints.
 *
 * Harnu installs, when a mission with a steward is created, and removes at close:
 *   - `SessionStart` (matcher `compact`) → prints the Mission Brief, so a resumed owner never
 *     re-derives dispatch state with `gh`/`get_fleet`;
 *   - `PreCompact` → `recordMissionCompaction` (the compaction ledger row, Amendment b);
 *   - `Stop` / `SubagentStop` → wakes the steward of any mission the stopping session is a child of.
 *
 * The user's own hooks are never touched: our handlers are recognised by their loopback URL shape
 * (`isStewardHook`) — not by a sentinel key, which Claude Code strips when it rewrites the file
 * (the same reason `hook-installer.ts` identifies its handlers by URL). Every function here
 * returns a NEW object and leaves its input alone; the fs half is `steward-shell.ts`.
 */

import type { Mission, MissionStep } from './mission-core'

type Handler = Record<string, unknown>
type Entry = { matcher?: string; hooks: Handler[] }
type HookConfig = Record<string, Entry[]>
type Settings = Record<string, unknown>

/** The route families the hook bridge serves for a steward. */
export const STEWARD_HOOK_ROUTES = ['brief', 'precompact', 'wake'] as const

const HOOK_TIMEOUT_S = 10

/** `http://127.0.0.1:<port>/steward/<token>/<route>` followed by anything up to whitespace. */
const OURS =
  /^curl -s -X POST --data-binary @- http:\/\/127\.0\.0\.1:\d+\/steward\/[^/\s]+\/(brief|precompact|wake)( |$)/

/** True for a hook handler this module installed. A user hook that only mentions the path is not ours. */
export function isStewardHook(handler: unknown): boolean {
  if (!handler || typeof handler !== 'object') return false
  const h = handler as Handler
  return h.type === 'command' && typeof h.command === 'string' && OURS.test(h.command)
}

function handlerFor(
  port: number,
  token: string,
  route: (typeof STEWARD_HOOK_ROUTES)[number]
): Handler {
  // `|| true`: a hook must never fail a session, whether Harnu is down or the token is stale.
  return {
    type: 'command',
    command: `curl -s -X POST --data-binary @- http://127.0.0.1:${port}/steward/${token}/${route} || true`,
    timeout: HOOK_TIMEOUT_S
  }
}

/** The `hooks` fragment Harnu owns for stewards. */
export function stewardHookFragment(input: { port: number; token: string }): HookConfig {
  const { port, token } = input
  return {
    SessionStart: [{ matcher: 'compact', hooks: [handlerFor(port, token, 'brief')] }],
    PreCompact: [{ hooks: [handlerFor(port, token, 'precompact')] }],
    Stop: [{ hooks: [handlerFor(port, token, 'wake')] }],
    SubagentStop: [{ hooks: [handlerFor(port, token, 'wake')] }]
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Strip our handlers from one event's entries. An entry that held ours and has nothing else left
 * is dropped; every other entry — including a user's empty one — is kept as it was.
 */
function stripOurs(entries: unknown[]): { kept: unknown[]; removed: boolean } {
  let removed = false
  const kept: unknown[] = []
  for (const e of entries) {
    if (!isObject(e) || !Array.isArray(e.hooks)) {
      kept.push(e)
      continue
    }
    const left = e.hooks.filter((h) => !isStewardHook(h))
    if (left.length === e.hooks.length) {
      kept.push(e)
      continue
    }
    removed = true
    if (left.length > 0) kept.push({ ...e, hooks: left })
  }
  return { kept, removed }
}

/** Install (or refresh) the steward hooks. Idempotent; replaces a stale port/token instead of adding beside it. */
export function mergeStewardHooks(
  existing: unknown,
  input: { port: number; token: string }
): Settings {
  const base: Settings = isObject(existing) ? structuredClone(existing) : {}
  const hooks: Record<string, unknown> = isObject(base.hooks) ? { ...base.hooks } : {}
  const fragment = stewardHookFragment(input)
  for (const [event, ours] of Object.entries(fragment)) {
    const current = hooks[event]
    // A value we do not understand is the user's: leave that event alone rather than overwrite it.
    if (current !== undefined && !Array.isArray(current)) continue
    const { kept } = stripOurs(current ?? [])
    hooks[event] = [...kept, ...ours]
  }
  base.hooks = hooks
  return base
}

/** Remove the steward hooks and nothing else; the inverse of {@link mergeStewardHooks}. */
export function removeStewardHooks(existing: unknown): Settings {
  const base: Settings = isObject(existing) ? structuredClone(existing) : {}
  if (!isObject(base.hooks)) return base
  const hooks: Record<string, unknown> = { ...base.hooks }
  let touched = false
  for (const [event, value] of Object.entries(hooks)) {
    if (!Array.isArray(value)) continue
    const { kept, removed } = stripOurs(value)
    if (!removed) continue
    touched = true
    if (kept.length === 0) delete hooks[event]
    else hooks[event] = kept
  }
  if (!touched) return base
  if (Object.keys(hooks).length === 0) delete base.hooks
  else base.hooks = hooks
  return base
}

// ── the Mission Brief ────────────────────────────────────────────────────────

/** ≈ 1.5k tokens at ~4 characters each. */
export const BRIEF_MAX_CHARS = 6000
/** Budget for the step table; the declared end, blockers and ledger tail are never traded for it. */
const STEPS_BUDGET = 2400
const LEDGER_ROWS = 8
const TITLE_CHARS = 70

type GateStates = Partial<Record<'pr' | 'ci' | 'main' | 'verifier' | 'checks', string>>

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

function gateText(g: GateStates | undefined): string {
  if (!g) return ''
  const parts = (['pr', 'ci', 'main', 'verifier', 'checks'] as const)
    .filter((k) => g[k] !== undefined && g[k] !== 'na')
    .map((k) => `${k}:${g[k]}`)
  return parts.length > 0 ? ` · ${parts.join(' ')}` : ''
}

function stepLine(s: MissionStep, gates: Record<string, GateStates> | undefined): string {
  return `- ${s.id} [${s.proof}] ${clip(s.title, TITLE_CHARS)}${gateText(gates?.[s.id])}`
}

/**
 * The Mission Brief: everything a resumed owner needs to continue without re-deriving state. A
 * budgeted text — the ledger tail and the step table shrink to fit {@link BRIEF_MAX_CHARS}, the
 * declared end and the open blockers never do.
 */
export function buildMissionBrief(input: {
  mission: Mission
  title: string
  gates?: Record<string, GateStates>
}): string {
  const { mission: m, gates } = input
  const head = [
    `# Mission Brief — ${clip(input.title, 100)} (${m.id})`,
    'Harnu re-injected this after a context compaction. It is the mission as recorded now; trust it over memory.',
    '',
    '## Declared end',
    `${m.declaredEnd.kind}: ${clip(m.declaredEnd.target, 400)}`,
    `Proof: ${clip(m.declaredEnd.evidence, 400)}`
  ]

  const blockers = [
    ...m.blockers.map(
      (b) => `- mission [${b.owner}] ${clip(b.reason, 160)} → ${clip(b.unblocks, 120)}`
    ),
    ...m.steps.flatMap((s) =>
      s.blockers.map(
        (b) => `- ${s.id} [${b.owner}] ${clip(b.reason, 160)} → ${clip(b.unblocks, 120)}`
      )
    )
  ]
  const blockerBlock = ['', '## Open blockers', ...(blockers.length > 0 ? blockers : ['- none'])]

  // Every step is listed with its gates. Only when the table would blow its budget do the finished
  // steps collapse into a count, so the budget is spent on what is still open.
  const finished = m.steps.filter((s) => s.proof === 'verified' || s.proof === 'self-verified')
  const fits = (list: readonly MissionStep[]): boolean =>
    list.reduce((n, s) => n + stepLine(s, gates).length + 1, 0) <= STEPS_BUDGET
  const listed = fits(m.steps) ? m.steps : m.steps.filter((s) => !finished.includes(s))
  const stepLines: string[] = []
  let used = 0
  for (const s of listed) {
    const line = stepLine(s, gates)
    if (used + line.length + 1 > STEPS_BUDGET) break
    stepLines.push(line)
    used += line.length + 1
  }
  const hidden = m.steps.length - stepLines.length
  const stepBlock = [
    '',
    `## Steps (${finished.length} of ${m.steps.length} verified)`,
    ...stepLines,
    ...(hidden > 0 ? [`- … ${hidden} more steps — mission_get lists them`] : [])
  ]

  const rows = (m.ledger ?? []).slice(-LEDGER_ROWS)
  const ledgerBlock = [
    '',
    '## Ledger (newest last)',
    ...(rows.length > 0
      ? rows.map(
          (r) =>
            `- ${r.at.slice(0, 16)} ${r.kind} ${r.ref}${r.detail ? ` ${clip(r.detail, 40)}` : ''}${r.stepId ? ` (${r.stepId})` : ''}`
        )
      : ['- empty'])
  ]

  const foot = [
    '',
    "Do not re-derive this with `gh` or `get_fleet`: mission_get returns the same, derived fresh. Merging, closing, choosing a decision, ticking a check and marking a human step verified are the operator's doors — ask them, do not try."
  ]

  let text = [...head, ...blockerBlock, ...stepBlock, ...ledgerBlock, ...foot].join('\n')
  // Last resort on a mission whose own prose is huge: cut the tail, never the head.
  if (text.length > BRIEF_MAX_CHARS) text = `${text.slice(0, BRIEF_MAX_CHARS - 1)}…`
  return text
}
