/**
 * Pure core of the statusLine self-heal (BUG-196). `statusline.ts` keeps the Electron/fs shell;
 * every decision lives here so it unit-tests in the `node` vitest env
 * (`tests/statusline-heal-core.test.ts`):
 *
 *  - what a tick found in `settings.json` ({@link classifyStatusLine});
 *  - the evidence line it appends to `<userData>/statusline/heal-log.ndjson`
 *    ({@link buildHealLogLine}, bounded by {@link trimHealLog});
 *  - which live sessions need a restart afterwards ({@link staleProcs}) and whether the operator
 *    is told, with de-duplication ({@link planHealNotice});
 *  - the whole tick, over injected deps ({@link runHealTick}).
 *
 * Nothing here imports electron, node:fs or the settings writer.
 */

/** One live `claude` process Harnu owns, as `livePtyDescriptors()` reports it. */
export interface LiveClaudeProc {
  sessionKey: string
  pid: number
  /** Epoch ms the process was spawned. */
  startedAtMs: number
}

/** What a tick found under `statusLine` in `settings.json`. */
export type StatusLineFinding = 'ok' | 'missing' | 'replaced'

/**
 * Classify the `statusLine` value. `missing` is the only finding the tick heals. `replaced` is a
 * different command sitting where WE installed ours earlier in this run: recorded as evidence but
 * never fought, because it may be a user's own statusLine or another live Harnu instance's writer.
 * Without `wasOurs` a foreign value is simply the user's own and is not a finding at all.
 */
export function classifyStatusLine(
  current: unknown,
  ourCommand: string,
  wasOurs: boolean
): StatusLineFinding {
  if (current == null) return 'missing'
  if (!wasOurs) return 'ok'
  const command =
    typeof current === 'object' ? (current as Record<string, unknown>).command : undefined
  return command === ourCommand ? 'ok' : 'replaced'
}

// ---- Evidence log ---------------------------------------------------------------------------

export const HEAL_LOG_MAX_LINES = 200
export const HEAL_LOG_MAX_BYTES = 64 * 1024

export interface HealLogInput {
  atMs: number
  finding: Exclude<StatusLineFinding, 'ok'>
  /** `settings.json` mtime when the tick looked, or `null` if the file did not exist. */
  settingsMtimeMs: number | null
  procs: readonly LiveClaudeProc[]
}

/** One ndjson line (newline-terminated) of evidence for a tick that found something wrong. */
export function buildHealLogLine(input: HealLogInput): string {
  return (
    JSON.stringify({
      at: new Date(input.atMs).toISOString(),
      finding: input.finding,
      settingsMtimeMs: input.settingsMtimeMs,
      settingsMtime:
        input.settingsMtimeMs === null ? null : new Date(input.settingsMtimeMs).toISOString(),
      claude: input.procs.map((p) => ({
        pid: p.pid,
        sessionKey: p.sessionKey,
        startedAt: new Date(p.startedAtMs).toISOString()
      }))
    }) + '\n'
  )
}

/**
 * Keep the log bounded: the newest {@link HEAL_LOG_MAX_LINES} lines, and within
 * {@link HEAL_LOG_MAX_BYTES}. Older lines are dropped whole, so every kept line still parses.
 */
export function trimHealLog(content: string): string {
  const lines = content.split('\n').filter((l) => l.length > 0)
  let kept = lines.slice(-HEAL_LOG_MAX_LINES)
  let bytes = kept.reduce((n, l) => n + Buffer.byteLength(l) + 1, 0)
  while (kept.length > 1 && bytes > HEAL_LOG_MAX_BYTES) {
    bytes -= Buffer.byteLength(kept[0]) + 1
    kept = kept.slice(1)
  }
  return kept.length ? kept.join('\n') + '\n' : ''
}

// ---- Restart nudge --------------------------------------------------------------------------

/** Never notify more often than this, whatever the sessions are. */
export const HEAL_NOTICE_COOLDOWN_MS = 10 * 60_000
/** The same set of stale sessions is not announced again inside this window. */
export const HEAL_SAME_SET_WINDOW_MS = 60 * 60_000

export interface HealNoticeState {
  /** Sorted session keys of the last notice, joined with `|` (`''` for none). */
  lastKey: string | null
  lastAtMs: number
  /** The foreign command last logged as `replaced`, so a persistent one is logged once. */
  lastReplaced?: string | null
}

export interface HealNotice {
  atMs: number
  /** Sessions whose `claude` started before the heal, sorted. The renderer resolves titles. */
  sessionKeys: string[]
}

/** Processes spawned before the heal: they read `settings.json` at startup and never saw the key. */
export function staleProcs(procs: readonly LiveClaudeProc[], healAtMs: number): LiveClaudeProc[] {
  return procs.filter((p) => p.startedAtMs < healAtMs)
}

/**
 * Decide whether this heal produces an Activity notice. One notice per heal: a repeat inside the
 * cooldown is suppressed whoever is stale (a stripper that fires every minute must not flood the
 * bell), and after it the same set of sessions is not announced again for an hour. A suppressed
 * repeat leaves the state untouched, so it never extends its own window.
 */
export function planHealNotice(
  state: HealNoticeState,
  healAtMs: number,
  procs: readonly LiveClaudeProc[]
): { notice: HealNotice | null; next: HealNoticeState } {
  const sessionKeys = [...new Set(staleProcs(procs, healAtMs).map((p) => p.sessionKey))].sort()
  const key = sessionKeys.join('|')
  const since = healAtMs - state.lastAtMs
  const seenBefore = state.lastKey !== null
  const suppressed =
    seenBefore &&
    (since < HEAL_NOTICE_COOLDOWN_MS || (key === state.lastKey && since < HEAL_SAME_SET_WINDOW_MS))
  if (suppressed) return { notice: null, next: state }
  return {
    notice: { atMs: healAtMs, sessionKeys },
    next: { ...state, lastKey: key, lastAtMs: healAtMs }
  }
}

// ---- The tick -------------------------------------------------------------------------------

export type SettingsRead =
  { kind: 'ok'; statusLine: unknown; mtimeMs: number | null } | { kind: 'unreadable' }

export interface HealTickDeps {
  now(): number
  enabled(): Promise<boolean>
  /** Missing file → `ok` with `statusLine: undefined` and `mtimeMs: null`; corrupt → `unreadable`. */
  readSettings(): Promise<SettingsRead>
  reinstall(): Promise<void>
  appendLog(line: string): Promise<void>
  liveProcs(): readonly LiveClaudeProc[]
  notice(n: HealNotice): void
  /** Whether this run installed our statusLine (so a different value is a `replaced` finding). */
  wasOurs(): boolean
  ourCommand(): string
  /** Mutated in place by the tick (the shell keeps one object for the process lifetime). */
  noticeState: HealNoticeState
}

/**
 * One self-heal tick. Order matters: the evidence line is written BEFORE the re-install, so the
 * `settings.json` mtime it records is the one the stripper left, not our own rewrite. A failure to
 * write the log never blocks the heal.
 */
export async function runHealTick(deps: HealTickDeps): Promise<void> {
  if (!(await deps.enabled())) return
  const read = await deps.readSettings()
  if (read.kind !== 'ok') return // corrupt — never read-modify-write over it
  const finding = classifyStatusLine(read.statusLine, deps.ourCommand(), deps.wasOurs())
  if (finding === 'ok') {
    deps.noticeState.lastReplaced = null
    return
  }

  const atMs = deps.now()
  const procs = deps.liveProcs()
  if (finding === 'replaced') {
    // A foreign value that stays is one finding, not one per minute.
    const command = JSON.stringify(read.statusLine)
    if (deps.noticeState.lastReplaced === command) return
    deps.noticeState.lastReplaced = command
  } else {
    deps.noticeState.lastReplaced = null
  }
  try {
    await deps.appendLog(buildHealLogLine({ atMs, finding, settingsMtimeMs: read.mtimeMs, procs }))
  } catch {
    /* evidence is best-effort: the heal matters more */
  }
  if (finding !== 'missing') return

  await deps.reinstall()
  const { notice, next } = planHealNotice(deps.noticeState, atMs, procs)
  Object.assign(deps.noticeState, next)
  if (notice) deps.notice(notice)
}
