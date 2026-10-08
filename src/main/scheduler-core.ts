/**
 * T291 — Scheduler Workers: the pure core.
 *
 * A worker is a definition; this module answers the only two questions the
 * engine has, and both are pure: WHO is due right now, and WHAT argv does a
 * tick get (see `tickArgv`). Framework-free and side-effect-free (no electron,
 * no node:fs) so it is exhaustively unit-tested per ADR-0001; the env-bound
 * driver lives in `scheduler-shell.ts`. The imports are
 * `hook-settings-blob.ts` and `mcp/config-file.ts` (the server-name constants),
 * both pure for the same reason.
 *
 * The three rules encoded in `dueWorkers` exist to stop a 5-minute worker
 * becoming a fire: never overlap a worker with itself (skip, never queue — a
 * queueing sensor avalanches after one bad night), never exceed the global
 * concurrency ceiling (each tick is a `claude` process worth hundreds of MB),
 * and never consider a disabled worker.
 */

import { injectHookSettings } from './hook-settings-blob'
import { MCP_TOOLS } from './mcp/tool-catalog'
import { ALLOWED_TOOLS_RULES, MCP_SERVER_NAMES, mcpToolName } from './mcp/config-file'

/** How much a tick is allowed to do. See the spec §4.4/§4.5. */
export type WorkerMode = 'observe' | 'act'

/** Terminal state of one tick. `stopped` is an operator action, not a failure. */
export type RunStatus = 'ok' | 'error' | 'timeout' | 'skipped' | 'stopped'

/**
 * T304 — how much of its own machinery a worker reports (spec §5.3 extended).
 *
 * `silent` is not "no notifications": the two terminal cases the scheduler has
 * always owned — a worker disabled by its failure streak, a worker whose folder
 * vanished — fire in every state. What the three states select is what happens
 * PER TICK, and the default is deliberately nothing: a 5-minute worker fires
 * 288 times a day, and a notification per tick is a notification nobody reads.
 *
 * The division of labour this encodes: **the prompt owns "tell me when
 * something is interesting"** (`mcp__harnu__notify` is allowlisted for
 * `observe` and unrestricted for `act`, so a worker already speaks for itself),
 * **the scheduler owns "tell me the machinery broke"**. Turning this up is how
 * you hear the machinery; leaving it `silent` is how you avoid hearing the same
 * finding twice.
 */
export type NotifyOn = 'silent' | 'failure' | 'every'

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface Worker {
  id: string
  name: string
  enabled: boolean
  /** Free text. Names skills inline; there is no attach-skills field by design. */
  prompt: string
  /** REQUIRED — the tick's cwd and the source of its staged skills. */
  folder: string
  everyMinutes: number
  runOnBoot: boolean
  model: string
  effort: Effort
  mode: WorkerMode
  timeoutSeconds: number
  /** Prepend the previous run's result as one line. */
  carryLastResult: boolean
  /**
   * How loudly this worker reports its own ticks. Optional so a worker
   * persisted before T304 resolves to `silent` — see `resolveNotifyOn`.
   */
  notifyOn?: NotifyOn
  /** Retired (BUG-164): kept so saved workers load; `observe` has no shell, so it grants nothing. */
  extraReadCommands?: string[]
  /**
   * BUG-166: `observe` only. Opt-in to `WebFetch`. Off unless this is the literal `true`: a tick that
   * can `Read` any file the operator can read and also reach the internet can send what it read
   * anywhere (a URL query is enough), and a prompt injection in anything it reads is enough to
   * make it try. Optional so a worker persisted before the field existed type-checks; the store
   * resolves it to `false` on load.
   */
  allowNetwork?: boolean
  /** Advanced: replaces the default system prompt. */
  systemPrompt?: string
  /** Consecutive failures. Three disables the worker. */
  failureStreak: number
}

export interface Run {
  workerId: string
  startedAt: number
  endedAt: number
  durationMs: number
  status: RunStatus
  result: string
  terminalReason: string
  numTurns: number
  costUsd: number
  tokens: { in: number; out: number; cacheRead: number; cacheWrite: number }
  denials: string[]
}

/**
 * A brand-new worker, as the form first shows it.
 *
 * It is deliberately born DISARMED. Creating a worker and arming one are two
 * different acts, and conflating them meant a worker created at 14:00:01 was
 * already due at 14:00:30 with whatever half of the form had been typed by
 * then. `enabled` is the operator's switch, not a side effect of clicking New.
 */
export function newWorker(id: string): Worker {
  return {
    id,
    name: '',
    enabled: false,
    prompt: '',
    folder: '',
    everyMinutes: 30,
    runOnBoot: false,
    model: 'haiku',
    effort: 'low',
    mode: 'observe',
    timeoutSeconds: 300,
    carryLastResult: false,
    notifyOn: 'silent',
    allowNetwork: false,
    failureStreak: 0
  }
}

/** Each tick is a full `claude` process; two at once is the machine's budget. */
export const MAX_CONCURRENT_TICKS = 2

/** Consecutive failures that disable a worker. */
export const FAILURE_STREAK_LIMIT = 3

/**
 * Epoch-ms at which `worker` next becomes due. A worker with no recorded run is
 * due immediately (`0`), so a worker that is armed for the first time fires on
 * the very next beat instead of waiting out a whole cadence.
 *
 * This function answers only "when", never "whether": a brand-new worker is
 * also due immediately, which is why `dueWorkers` — not this function — is
 * where the blank-prompt and `enabled` gates live.
 */
export function nextRunAt(worker: Worker, lastRunAt: number | undefined): number {
  if (lastRunAt === undefined) return 0
  return lastRunAt + worker.everyMinutes * 60_000
}

/**
 * The workers that should start on this beat, in list order, capped by the
 * global ceiling. `running` is the ids of ticks alive right now — a worker in
 * it is skipped entirely rather than queued.
 */
export function dueWorkers(
  workers: readonly Worker[],
  lastRunAt: Readonly<Record<string, number>>,
  running: readonly string[],
  now: number
): Worker[] {
  const slots = MAX_CONCURRENT_TICKS - running.length
  if (slots <= 0) return []
  const out: Worker[] = []
  for (const w of workers) {
    if (out.length >= slots) break
    if (!w.enabled) continue
    // A worker with nothing to say has nothing to run. Without this, a worker
    // created seconds ago — still carrying the empty prompt the form starts
    // with — is already due (`nextRunAt` returns 0) and spawns `claude -p ''`,
    // which fails, and three of those disable it before anyone finished typing.
    if (w.prompt.trim().length === 0) continue
    if (running.includes(w.id)) continue
    if (nextRunAt(w, lastRunAt[w.id]) > now) continue
    out.push(w)
  }
  return out
}

/**
 * Fold one finished run into the worker's failure streak. `stopped` and
 * `skipped` are deliberately inert: the operator interrupting a tick, or a tick
 * that never started because the previous one was still alive, is not the
 * worker misbehaving, and counting either would disable a healthy worker.
 */
export function nextFailureState(
  streak: number,
  status: RunStatus
): { streak: number; disable: boolean } {
  if (status === 'stopped' || status === 'skipped') return { streak, disable: false }
  if (status === 'ok') return { streak: 0, disable: false }
  const next = streak + 1
  return { streak: next, disable: next >= FAILURE_STREAK_LIMIT }
}

// ── run notifications (T304) ────────────────────────────────────────────────

/**
 * The state a worker resolves to. Absent means `silent`, which is what makes
 * T304 additive: every worker persisted before it — and every one whose
 * `schedulers.json` still predates the field — keeps behaving exactly as it did.
 */
export const NOTIFY_ON_VALUES: readonly NotifyOn[] = ['silent', 'failure', 'every']

export function resolveNotifyOn(worker: Pick<Worker, 'notifyOn'>): NotifyOn {
  // A value read off disk is whatever the file said, not necessarily one of the
  // three — a hand-edited or half-written `schedulers.json` must resolve to the
  // quiet state, never to an unknown one that then falls through to `every`.
  const raw = worker.notifyOn as string | undefined
  return NOTIFY_ON_VALUES.includes(raw as NotifyOn) ? (raw as NotifyOn) : 'silent'
}

/**
 * Whether ONE finished tick should raise a notification of the scheduler's own.
 *
 * Two statuses are inert in every state, for the same reason `nextFailureState`
 * treats them as inert:
 *
 * - `stopped` — the operator pressed Stop. Notifying someone about the thing
 *   they just did themselves is noise, and it is not a failure.
 * - `skipped` — the tick never ran (its predecessor was still alive, or the
 *   concurrency ceiling was full). There is no run to report on.
 *
 * `every` is a superset of `failure`, not an alternative to it: the operator
 * who asked to hear about every run did not ask to stop hearing about the
 * failed ones.
 */
export function shouldNotifyRun(worker: Pick<Worker, 'notifyOn'>, status: RunStatus): boolean {
  const mode = resolveNotifyOn(worker)
  if (mode === 'silent') return false
  if (status === 'stopped' || status === 'skipped') return false
  if (mode === 'failure') return status === 'error' || status === 'timeout'
  return true
}

/**
 * Cap for any text stored on a `Run`.
 *
 * The error path always had it (`stdout.slice(0, 4000)`); the success path did
 * not, and `result` comes straight off the model — a chatty worker writes an
 * unbounded string into an append-only file, 200 records deep, every cadence.
 * One limit, both paths (T303).
 */
export const RUN_RESULT_LIMIT = 4000

/** Every stored `Run.result` goes through this, whatever produced it. */
export function capResult(text: string): string {
  return text.length > RUN_RESULT_LIMIT ? text.slice(0, RUN_RESULT_LIMIT) : text
}

/**
 * The one-line body of a per-run notification. Pure so the wording is a test
 * rather than a string buried in the spawn path.
 *
 * A failed tick leads with WHY (`terminalReason` when the process gave one,
 * the status otherwise) — that is the whole reason the operator turned this on.
 * A successful tick leads with what the worker said, because a "ran fine" with
 * no content is exactly the notification that trains people to ignore them.
 */
export function runNotificationText(run: Run): string {
  const detail = run.result.trim().replace(/\s+/g, ' ')
  if (run.status === 'ok') {
    return detail.length > 0 ? capNotification(detail) : 'Finished with no result.'
  }
  const reason = run.terminalReason.trim() || run.status
  return detail.length > 0
    ? capNotification(`${run.status} (${reason}) — ${detail}`)
    : `${run.status} (${reason})`
}

/** A notification body is a glance, not a transcript. */
const NOTIFICATION_LIMIT = 240

function capNotification(text: string): string {
  return text.length > NOTIFICATION_LIMIT ? `${text.slice(0, NOTIFICATION_LIMIT - 1)}…` : text
}

// ── tickArgv — the permission contract as argv ──────────────────────────────

/**
 * Native tools an `observe` tick may use. Read-only by construction.
 *
 * There is NO `Bash(...)` rule here, deliberately (BUG-164). A prefix rule such as
 * `Bash(git log:*)` authorizes the command followed by ANY arguments, and cannot
 * express "no `--output` anywhere": git's `--output=<path>` writes an arbitrary file,
 * so a commit message written over `.git/config` sets `core.fsmonitor` and the next
 * `git status` runs it. Flag-by-flag filtering is a losing game, so an observe tick
 * gets no shell and reads git/PR facts through Harnu's read verbs instead
 * (`list_worktrees`, `mission_get`, `get_fleet`). Never re-add `Bash` here.
 *
 * This list is passed twice, and the two flags do different jobs. `--tools` decides which
 * built-in tools the CLI LOADS at all; `--allowedTools` only auto-approves a call to one
 * that is loaded. Without `--tools` the CLI also loads `Monitor` (a shell by another name),
 * `EnterWorktree` (runs `git worktree add`, which fires `post-checkout` hooks), the
 * Cron tools, Workflow, RemoteTrigger, `SendMessage` and `ToolSearch`, none of which a
 * `Bash` deny touches (verified against claude 2.1.294). MCP verbs are not built-ins:
 * `--tools` leaves them alone and they stay gated by the allow list below.
 *
 * `Skill` is here because a worker prompt may say "use the X skill" in prose; the
 * `/skill` slash form works without it. A skill is text, not a capability, and whatever
 * it asks for still has to pass the list above.
 *
 * `WebFetch` is NOT here: it is opt-in per worker, see {@link OBSERVE_NETWORK_TOOLS}.
 */
export const OBSERVE_TOOLS: readonly string[] = ['Read', 'Grep', 'Glob', 'Skill']

/**
 * The one network tool, added to an `observe` tick only when the worker has `allowNetwork: true`
 * (BUG-166). `Read` is unrestricted, so a tick that can also `WebFetch` can exfiltrate any file the
 * operator can read: a URL query carries it. Opt-in, per worker, with a warning in the UI and a
 * confirm on the agent verbs.
 */
export const OBSERVE_NETWORK_TOOLS: readonly string[] = ['WebFetch']

/**
 * Native tools an `observe` tick is explicitly denied. Redundant with `--tools` on purpose:
 * a deny rule beats any allow rule, so if the CLI ever loads one of these anyway, or a rule
 * reaches the allowlist by another route, the call is still refused. Bare `Bash` matters
 * most; `Monitor` and `EnterWorktree` are the two that were found loaded and callable.
 */
export const OBSERVE_TOOLS_DENY: readonly string[] = [
  'Edit',
  'Write',
  'NotebookEdit',
  'Task',
  'Agent',
  'Bash',
  'Monitor',
  'EnterWorktree',
  'ExitWorktree',
  'CronCreate',
  'CronDelete',
  'Workflow',
  'RemoteTrigger',
  'PushNotification',
  'SendMessage',
  'ToolSearch'
]

/**
 * Verb names (no prefix) an `observe` tick may call.
 *
 * Harnu's own spawn path passes a server-level `--allowedTools mcp__harnu` (T93)
 * so no verb prompts on first call. For a tick that would be a hole, not a
 * convenience: `create_session` and `submit_manifest` would let a "read-only"
 * worker spawn an unrestricted agent, and the native allowlist does not cover
 * the MCP surface at all.
 */
const OBSERVE_ALLOW_VERBS: readonly string[] = [
  'memory_read',
  'memory_query',
  'get_fleet',
  'get_session',
  'list_worktrees',
  // T328: read-only, so an observe worker can watch for zombie containers.
  // Its stop/start/remove siblings (T329) belong on the deny list below.
  'list_containers',
  // T445: read-only, so a delivery-watchdog can report how many items are ready to clean. Its sibling
  // `release_worktree` writes a mark and belongs on the deny list below.
  'list_cleanup',
  // T369 (Mission progress S8): the two Mission READ verbs, so an observe-mode
  // `delivery-watchdog` can read a mission's stored state and its derived
  // `stale` flag. Every mission WRITE verb is on the deny list below.
  'mission_get',
  'mission_list',
  'create_card',
  'update_card',
  'notify'
]

/**
 * Every verb the Harnu control server exposes, by name: the tool catalog, which is also what the
 * server registers. The deny list below is derived from it so it cannot fall behind.
 */
const CATALOG_VERBS: readonly string[] = MCP_TOOLS.map((t) => t.name)

/** `mcp__<server>__<verb>` for every verb under EVERY server name (current, then legacy). */
function underAllServerNames(verbs: readonly string[]): readonly string[] {
  return MCP_SERVER_NAMES.flatMap((server) => verbs.map((verb) => mcpToolName(verb, server)))
}

/**
 * Harnu verbs an `observe` tick may call, BY NAME, under BOTH the `mcp__harnu__`
 * prefix and the pre-rename `mcp__capy__` one. A tick only ever registers the
 * current server, so the legacy names are inert there — they are listed so the
 * lists cannot drift out of step if a legacy-named server ever reappears.
 */
export const OBSERVE_MCP_ALLOW: readonly string[] = underAllServerNames(OBSERVE_ALLOW_VERBS)

/**
 * Verbs an `observe` tick must never reach, under BOTH prefixes: every verb in the tool catalog
 * that is not in {@link OBSERVE_ALLOW_VERBS}. Derived, never hand-curated (BUG-166 delta 1): a
 * hand list missed `update_worker`, `delete_worker`, `plan_mission`, `get_approval`, `open_file`,
 * `speak` and `archive_card`, and a verb added tomorrow would have been missed too. A new verb is
 * denied in observe until someone allows it by name. A security boundary: a verb missing under
 * either prefix would be a leak.
 */
export const OBSERVE_MCP_DENY: readonly string[] = underAllServerNames(
  CATALOG_VERBS.filter((verb) => !OBSERVE_ALLOW_VERBS.includes(verb))
)

export interface TickContext {
  /**
   * T389: the staged companion mod directory, when the mod is on for this tick. Emitted BEFORE
   * the skills `--plugin-dir` so the companion is always the first plugin dir.
   */
  companionPluginDir?: string
  /** The folder's staged bundled-skills dir, when it has any enabled. */
  pluginDir?: string
  /** Harnu's own `--mcp-config` document, when the control server is up. */
  mcpConfigPath?: string
  /** Previous run's result, used only when `carryLastResult`. */
  lastResult?: string
  /**
   * Harnu's inline hook-settings blob (`hook-bridge.ts#hookSettingsBlobJson`),
   * when the Hook Bridge is up and per-session injection is not opted out.
   *
   * Passed IN rather than read here on purpose: `tickArgv` is pure (see its own
   * doc comment), and calling the provider from inside it would make the argv a
   * function of live process state instead of its arguments — every permission
   * assertion in `tests/scheduler-argv.test.ts` would then need a running
   * bridge. The shell (`scheduler-shell.ts#startTick`) fills this the same way
   * the PTY path does.
   */
  hookSettingsJson?: string
}

// ── extraReadCommands — retired (BUG-164) ───────────────────────────────────
//
// `extraReadCommands` used to let an operator add `Bash(...)` rules to an `observe`
// allowlist, guarded by a verb allowlist and a writing-flag filter (BUG-108). That
// guard was the wrong shape of defense: `observe` now has no shell at all (see
// {@link OBSERVE_TOOLS}), so no rule can widen it. The field stays on the `Worker`
// record so a saved worker still loads and the MCP/UI surfaces keep their types, but
// it grants nothing, and every entry is reported as refused.

/**
 * Split configured extra read commands into the ones that widen the allowlist
 * (always none: `observe` has no shell) and the ones that were refused. `rejected`
 * exists so the shell can put the refusal in front of the operator instead of
 * dropping it in silence (see `scheduler-shell.ts#completeTick`).
 */
export function partitionExtraReadCommands(rules: readonly string[] | undefined): {
  accepted: string[]
  rejected: string[]
} {
  return { accepted: [], rejected: [...(rules ?? [])] }
}

/**
 * The complete argv for one tick, minus the binary. Pure on purpose: every
 * permission decision in the spec is an assertion in `tests/scheduler-argv.ts`
 * with nothing spawned, so the security contract is a test rather than a
 * comment.
 */
export function tickArgv(worker: Worker, ctx: TickContext): string[] {
  const workerPrompt = migrateLegacySkillMentions(worker.prompt)
  const prompt =
    worker.carryLastResult && ctx.lastResult
      ? `Last run: ${ctx.lastResult}\n\n${workerPrompt}`
      : workerPrompt

  const argv: string[] = ['-p', '--model', worker.model, '--effort', worker.effort]

  if (ctx.companionPluginDir) argv.push('--plugin-dir', ctx.companionPluginDir)
  if (ctx.pluginDir) argv.push('--plugin-dir', ctx.pluginDir)

  // Born lean: the user's MCP servers and settings are dropped, and the Harnu
  // preamble is never injected — it describes UI a headless tick cannot use.
  argv.push('--strict-mcp-config')
  if (ctx.mcpConfigPath) argv.push('--mcp-config', ctx.mcpConfigPath)
  argv.push('--setting-sources', '')
  argv.push('--no-session-persistence')
  // Always `json` (BUG-115). The alternative branch selected `stream-json` for
  // a `keepTranscript` field nothing ever consumed — no transcript was written
  // anywhere — while `runFromResult` parses the LAST line of stdout as the
  // whole document, which for a stream is one event, not the result. A flag
  // that only made the reader wrong is not an option worth keeping.
  argv.push('--output-format', 'json')

  if (worker.mode === 'act') {
    argv.push('--permission-mode', 'bypassPermissions')
    if (ctx.mcpConfigPath) argv.push('--allowedTools', ALLOWED_TOOLS_RULES.join(','))
  } else {
    // `extraReadCommands` is deliberately not consulted: observe has no shell (BUG-164).
    // Only the literal `true` opts in to the network (BUG-166).
    const builtIns = [
      ...OBSERVE_TOOLS,
      ...(worker.allowNetwork === true ? OBSERVE_NETWORK_TOOLS : [])
    ]
    const allow = [...builtIns]
    // The built-in tool set is an allowlist, not "everything minus a deny list".
    argv.push('--tools', builtIns.join(','))
    if (ctx.mcpConfigPath) allow.push(...OBSERVE_MCP_ALLOW)
    argv.push('--allowedTools', allow.join(','))
    // Denying the non-allowed Harnu verbs by name, not just leaving them unallowed, drops them
    // from the roster the CLI shows the model: an unallowed verb is otherwise still listed and
    // only refused when called.
    const deny = [...OBSERVE_TOOLS_DENY]
    if (worker.allowNetwork !== true) deny.push(...OBSERVE_NETWORK_TOOLS)
    if (ctx.mcpConfigPath) deny.push(...OBSERVE_MCP_DENY)
    argv.push('--disallowedTools', deny.join(','))
  }

  if (worker.systemPrompt)
    argv.push('--system-prompt', migrateLegacySkillMentions(worker.systemPrompt))

  // Emitted last, after a `--` end-of-options separator: `prompt` is free text
  // an operator can edit to anything, and `-p` takes no value, so it lands as
  // a bare positional. Without `--` a prompt that happens to equal a real flag
  // (e.g. `--dangerously-skip-permissions`) is parsed as that flag instead of
  // literal text — confirmed against the live `claude` binary. Same fix as
  // `claude-args.ts`'s `prePrompt` (`OPTIONS_END`).
  argv.push('--', prompt)

  // Harnu's own hooks, injected as an inline `--settings` source (BUG-111). A
  // tick runs with `--setting-sources ''`, which drops the user's
  // `settings.json` and with it the globally-installed Harnu hooks, so without
  // this a tick is invisible to the Hook Bridge in BOTH modes. `act` is the
  // mode that needs it most — nothing else observes an unattended writer — but
  // `observe` has no second net either, and the blob is loopback-only,
  // observation-only and read-only with respect to disk, so it costs nothing
  // to give both. `injectHookSettings` is separator-aware: it rewrites only
  // the option portion and re-appends the `--` and the prompt untouched.
  if (ctx.hookSettingsJson) return injectHookSettings(argv, ctx.hookSettingsJson)

  return argv
}

// ── skill mentions (T305) ───────────────────────────────────────────────────

/**
 * One `/skill` mention inside a worker's prompt.
 *
 * The `/` must sit at a WORD BOUNDARY — start of the string or right after
 * whitespace. A prompt is full of paths (`src/main/`, `docs/user/`), and a
 * naive `/` would turn every one of them into a mention (and, in the form,
 * would pop the autocomplete open on every path the operator types).
 *
 * A namespace is part of the name: `harnu:mission` and `dtk:review` are as real
 * a mention as `land-prs`, so the separator is captured rather than ending the
 * match.
 */
export const SKILL_MENTION_RE =
  /(?:^|\s)\/([A-Za-z0-9][A-Za-z0-9._-]*(?::[A-Za-z0-9][A-Za-z0-9._-]*)?)/g

/**
 * Rewrite pre-rename `/capy:<skill>` mentions to `/harnu:<skill>`.
 *
 * The staged plugin is now named `harnu`, so the CLI no longer knows a `capy:`
 * namespace: a persisted worker prompt that still says `/capy:mission` would reach
 * the model as a command nothing answers to. Applied to the text handed to the
 * CLI at spawn time (the stored prompt is the operator's and is left alone); the
 * same word-boundary rule as `SKILL_MENTION_RE`, so a path like `src/capy:x` is
 * not touched.
 */
export function migrateLegacySkillMentions(prompt: string): string {
  return prompt.replace(/(^|\s)\/capy:(?=[A-Za-z0-9])/g, '$1/harnu:')
}

/**
 * The skills a prompt names, de-duplicated, in first-appearance order.
 *
 * **This is a VIEW of the prompt string, never state stored beside it.** The
 * form recomputes it on every render and the tick recomputes it from the same
 * string at spawn time, which is what makes "delete the text, lose the skill"
 * and "type the name by hand, gain the skill" true by construction. A
 * `skills: string[]` persisted on `Worker` would drift from the prompt the
 * first time anyone edited it without the picker — the exact bug this shape
 * makes unrepresentable.
 *
 * A trailing `.` or `-` is trimmed: `use /land-prs.` names `land-prs`, not
 * `land-prs.` — sentence punctuation is not part of a skill id.
 */
export function parseSkillMentions(prompt: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const m of prompt.matchAll(SKILL_MENTION_RE)) {
    const name = m[1].replace(/[.\-_]+$/, '')
    if (!name || seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}
