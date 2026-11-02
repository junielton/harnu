/**
 * T611 U1 — the GitHub budget poller and its IPC surface.
 *
 * Reads `gh api rate_limit` (free: it does not count against the REST limit) every 60 s and feeds the
 * shared tracker. When `gh` is missing or not signed in the budget is `unavailable` and polling backs
 * off to 10 minutes; a transient failure backs off exponentially up to the same ceiling — never a
 * retry storm. While the budget is `exhausted` one extra poll is scheduled just after the reset so
 * normal polling resumes on its own. The renderer reads it through `github-budget:*` (U2 builds the
 * pill and the Settings pane on this; U3 the MCP verb).
 */

import { BrowserWindow, ipcMain } from 'electron'
import { isGhThrottled, runGh, runGhBudgetProbe } from './gh-runner'
import {
  classifyPollFailure,
  normalizeBudgetPrefs,
  parseRateLimit,
  type BudgetPrefs,
  type BudgetSnapshot,
  type BudgetTracker,
  type PollFailure,
  type RateLimitBuckets
} from './github-budget-core'
import { readBudgetPrefs, writeBudgetPrefs } from './github-budget-prefs'
import { githubBudget } from './github-budget-tracker'

export const POLL_INTERVAL_MS = 60_000
export const UNAVAILABLE_BACKOFF_MS = 10 * 60_000
/** A poll scheduled for an `exhausted` reset lands this long after it. */
export const RESET_SLACK_MS = 2_000

export type ProbeResult =
  { ok: true; buckets: RateLimitBuckets } | { ok: false; reason: PollFailure }

/** One `gh api rate_limit`, parsed. Never throws. */
export async function probeRateLimit(
  run: () => Promise<{ stdout: string }> = runGhBudgetProbe
): Promise<ProbeResult> {
  try {
    const { stdout } = await run()
    const buckets = parseRateLimit(stdout)
    return buckets ? { ok: true, buckets } : { ok: false, reason: 'error' }
  } catch (err) {
    return { ok: false, reason: classifyPollFailure(err) }
  }
}

/** A GitHub login: letters, digits and hyphens (a `[bot]` suffix for app tokens). */
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\[bot\])?$/

/**
 * The signed-in user of the `gh` token: `gh api user --jq .login` through the shared runner
 * (consumer `budget`, REST; it is one point, counted like any other call). Resolves `null` when the
 * call ran but gave no usable login; REJECTS when the call could not run at all (the budget is spent
 * and the runner refused it), so the poller knows it has not really tried.
 */
export async function probeLogin(
  run: () => Promise<{ stdout: string }> = () =>
    runGh(['api', 'user', '--jq', '.login'], {
      consumer: 'budget',
      resource: 'rest',
      timeout: 15_000,
      maxBuffer: 1 << 16
    })
): Promise<string | null> {
  try {
    const login = (await run()).stdout.trim()
    return LOGIN_RE.test(login) ? login : null
  } catch (err) {
    if (isGhThrottled(err)) throw err
    return null
  }
}

export interface PollerDeps {
  tracker: BudgetTracker
  probe: () => Promise<ProbeResult>
  /**
   * Resolve the `gh` login. Asked at the first good poll of the app run and again after each time
   * the budget was `unavailable` and came back — never otherwise. Rejecting means "could not run":
   * it is asked again at the next good poll.
   */
  resolveLogin?: () => Promise<string | null>
  now: () => number
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
}

export interface BudgetPoller {
  start(): void
  stop(): void
  /** Poll now (also reschedules). Resolves when the tracker has the answer. */
  pollNow(): Promise<void>
}

/** Delay before the poll after one that ended `reason` (`null` = it worked). */
export function nextPollDelayMs(args: {
  reason: PollFailure | null
  consecutiveErrors: number
  exhaustedResetAt: number | null
  now: number
}): number {
  let delay = POLL_INTERVAL_MS
  if (args.reason === 'missing' || args.reason === 'unauthenticated') {
    delay = UNAVAILABLE_BACKOFF_MS
  } else if (args.reason === 'error') {
    delay = Math.min(
      UNAVAILABLE_BACKOFF_MS,
      POLL_INTERVAL_MS * 2 ** Math.min(args.consecutiveErrors, 4)
    )
  }
  if (args.exhaustedResetAt !== null) {
    const untilReset = Math.max(RESET_SLACK_MS, args.exhaustedResetAt + RESET_SLACK_MS - args.now)
    delay = Math.min(delay, untilReset)
  }
  return delay
}

export function createBudgetPoller(deps: PollerDeps): BudgetPoller {
  let timer: unknown = null
  let running = false
  let consecutiveErrors = 0
  let inFlight: Promise<void> | null = null
  /** The login lookup has run (answer or not) since the budget was last `unavailable`. */
  let loginTried = false

  const schedule = (reason: PollFailure | null): void => {
    if (!running) return
    if (timer !== null) deps.clearTimer(timer)
    const snap = deps.tracker.snapshot()
    const delay = nextPollDelayMs({
      reason,
      consecutiveErrors,
      exhaustedResetAt: snap.throttle.state === 'exhausted' ? snap.throttle.resetAt : null,
      now: deps.now()
    })
    timer = deps.setTimer(() => void pollNow(), delay)
  }

  function pollNow(): Promise<void> {
    if (inFlight) return inFlight
    inFlight = (async () => {
      const result = await deps.probe()
      deps.tracker.applyPoll(result)
      consecutiveErrors = !result.ok && result.reason === 'error' ? consecutiveErrors + 1 : 0
      // Missing or signed out: the tracker forgot the login, so the next good poll asks again.
      if (!result.ok && result.reason !== 'error') loginTried = false
      schedule(result.ok ? null : result.reason)
      if (result.ok && deps.resolveLogin && !loginTried && deps.tracker.snapshot().login === null) {
        try {
          const login = await deps.resolveLogin()
          loginTried = true
          if (login !== null) deps.tracker.setLogin(login)
        } catch {
          /* could not run (budget spent): not a try; the next good poll asks again */
        }
      }
    })().finally(() => {
      inFlight = null
    })
    return inFlight
  }

  let offRateLimit: (() => void) | null = null

  return {
    start() {
      if (running) return
      running = true
      // AC-9: a rate-limit message from gh means look at the buckets now (the poll is free).
      offRateLimit = deps.tracker.onRateLimit(() => void pollNow())
      void pollNow()
    },
    stop() {
      running = false
      offRateLimit?.()
      offRateLimit = null
      if (timer !== null) deps.clearTimer(timer)
      timer = null
    },
    pollNow
  }
}

let poller: BudgetPoller | null = null

function broadcast(snap: BudgetSnapshot): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('github-budget:changed', snap)
  }
}

/**
 * Boot wiring (called once from `src/main/index.ts`): load the prefs into the tracker, register the
 * IPC, push every change to the windows, and start the poller.
 */
export function registerGithubBudget(): void {
  ipcMain.handle('github-budget:snapshot', (): BudgetSnapshot => {
    githubBudget.tick()
    return githubBudget.snapshot()
  })
  ipcMain.handle('github-budget:prefs', async (): Promise<BudgetPrefs> => readBudgetPrefs())
  ipcMain.handle('github-budget:setPrefs', async (_e, raw: unknown): Promise<BudgetPrefs> => {
    const next = await writeBudgetPrefs(normalizeBudgetPrefs(raw))
    githubBudget.setPrefs(next)
    return next
  })
  githubBudget.onChange(broadcast)
  void readBudgetPrefs().then((prefs) => {
    githubBudget.setPrefs(prefs)
    if (poller) return
    poller = createBudgetPoller({
      tracker: githubBudget,
      probe: () => probeRateLimit(),
      resolveLogin: () => probeLogin(),
      now: () => Date.now(),
      setTimer: (fn, ms) => {
        const t = setTimeout(fn, ms)
        t.unref?.()
        return t
      },
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>)
    })
    poller.start()
  })
}

/** Stop polling (app quit). */
export function stopGithubBudget(): void {
  poller?.stop()
  poller = null
}
