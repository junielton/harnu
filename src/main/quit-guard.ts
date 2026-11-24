/**
 * T579 — pure core of the "confirm before quitting while agents are working" guard.
 *
 * Quitting Harnu kills every PTY (`before-quit` → `killAllPtys`), so a session that is mid-turn
 * loses that turn. This module decides WHEN to warn and WHAT the native dialog says; the
 * electron shell that intercepts `close` / `before-quit` and shows the dialog lives in
 * `quit-confirm.ts`. Everything here is free of `electron` / `fs` imports so it is unit-tested.
 */

/** Why the app is quitting. Only `'user'` (X button, Ctrl+Q, app menu) is ever confirmed. */
export type QuitReason = 'user' | 'update-install' | 'system-shutdown'

export interface QuitGuardInput {
  /** `getTaskStates()` — the same map the BUG-54 `lastShutdown` snapshot reads. */
  taskStates: Iterable<readonly [string, string]>
  /** The persisted preference (Settings → General → "Confirm before quitting"). */
  confirmEnabled: boolean
  reason: QuitReason
  /** Labels of markdown panes with unsaved edits (`unsaved-drafts.ts`). Default none. */
  unsavedFiles?: readonly string[]
}

export interface QuitGuardDecision {
  confirm: boolean
  /** The `working` sessions, in task-state order. Empty unless the preference is on. */
  sessionIds: string[]
  /** The unsaved files, whatever the preference says. Empty for a non-user quit. */
  unsavedFiles: string[]
  /** Offer "Don't ask again". Never with unsaved files: losing work is not a preference. */
  allowDontAsk: boolean
}

/**
 * Should this quit attempt ask first? Only `taskState === 'working'` counts — idle, parked
 * (hibernated), done and errored sessions never do — and an updater restart or an OS
 * shutdown is never blocked, whatever the preference says. Unsaved markdown files always
 * ask on a user quit, even with the preference off.
 */
export function decideQuitConfirm(input: QuitGuardInput): QuitGuardDecision {
  if (input.reason !== 'user') {
    return { confirm: false, sessionIds: [], unsavedFiles: [], allowDontAsk: true }
  }
  const sessionIds: string[] = []
  if (input.confirmEnabled) {
    for (const [sessionId, state] of input.taskStates) {
      if (state === 'working') sessionIds.push(sessionId)
    }
  }
  const unsavedFiles = [...(input.unsavedFiles ?? [])]
  return {
    confirm: sessionIds.length > 0 || unsavedFiles.length > 0,
    sessionIds,
    unsavedFiles,
    allowDontAsk: unsavedFiles.length === 0
  }
}

// ---- Preference -----------------------------------------------------------

export interface QuitGuardPrefs {
  version: 1
  /** Ask before quitting while agents are working. Default ON. */
  confirmOnQuit: boolean
}

export function defaultQuitGuardPrefs(): QuitGuardPrefs {
  return { version: 1, confirmOnQuit: true }
}

/** Tolerates junk — a corrupt prefs file must fall back to the safe default (ask). */
export function normalizeQuitGuardPrefs(raw: unknown): QuitGuardPrefs {
  const fallback = defaultQuitGuardPrefs()
  if (!raw || typeof raw !== 'object') return fallback
  const r = raw as Record<string, unknown>
  return {
    version: 1,
    confirmOnQuit: typeof r.confirmOnQuit === 'boolean' ? r.confirmOnQuit : fallback.confirmOnQuit
  }
}

// ---- Dialog content -------------------------------------------------------

/** How many session names the dialog lists before collapsing the rest into "and N more". */
export const QUIT_DIALOG_MAX_NAMES = 5

/**
 * The dialog copy. Templates use `{app}`, `{count}` and `{n}` placeholders. The renderer owns
 * the i18n catalogs, so it answers the main process's request with these in the user's locale;
 * {@link DEFAULT_QUIT_STRINGS} is the English fallback for when the renderer is hung or gone
 * (the whole point of a native dialog is that it works then).
 */
export interface QuitDialogStrings {
  /** One working session. */
  messageOne: string
  /** Several working sessions. */
  messageMany: string
  /** Appended below the names. */
  detail: string
  /** Last list line when names were cut off. */
  andMore: string
  quitAnyway: string
  cancel: string
  dontAskAgain: string
  /** One file with unsaved changes. */
  unsavedOne: string
  /** Several files with unsaved changes. */
  unsavedMany: string
  /** Appended below the file names. */
  unsavedDetail: string
  quitWithoutSaving: string
}

export const DEFAULT_QUIT_STRINGS: QuitDialogStrings = {
  messageOne: '1 agent is still working',
  messageMany: '{count} agents are still working',
  detail: 'Quitting {app} now interrupts them.',
  andMore: 'and {n} more',
  quitAnyway: 'Quit anyway',
  cancel: 'Cancel',
  dontAskAgain: "Don't ask again",
  unsavedOne: '1 file has unsaved changes',
  unsavedMany: '{count} files have unsaved changes',
  unsavedDetail: 'Quitting {app} now discards them.',
  quitWithoutSaving: 'Quit without saving'
}

/** First 8 characters of a session id — the label of last resort. */
export function shortSessionId(sessionId: string): string {
  return sessionId.slice(0, 8)
}

function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in vars ? String(vars[key]) : whole
  )
}

/**
 * Readable names for the working sessions: the resolved label when there is a non-blank one,
 * else the short id. Pure; `labels` is whatever the renderer could resolve (maybe nothing).
 */
export function resolveSessionNames(
  sessionIds: readonly string[],
  labels: Readonly<Record<string, string>>
): string[] {
  return sessionIds.map((id) => {
    const label = labels[id]
    return typeof label === 'string' && label.trim() ? label.trim() : shortSessionId(id)
  })
}

export interface QuitDialogContent {
  message: string
  detail: string
  /** Button labels in display order; Cancel is last and is both default and cancel. */
  buttons: [string, string]
  defaultId: number
  cancelId: number
  checkboxLabel: string
}

function bulletLines(names: readonly string[], strings: QuitDialogStrings): string[] {
  const shown = names.slice(0, QUIT_DIALOG_MAX_NAMES)
  const lines = shown.map((n) => `• ${n}`)
  if (names.length > shown.length) {
    lines.push(`• ${fill(strings.andMore, { n: names.length - shown.length })}`)
  }
  return lines
}

/**
 * Compose the native-dialog content. Names are capped at {@link QUIT_DIALOG_MAX_NAMES}. With
 * unsaved files the dialog leads with them (what a quit loses for good), then adds the working
 * agents, and drops the "Don't ask again" checkbox (`checkboxLabel: ''`).
 */
export function buildQuitDialogContent(args: {
  appName: string
  names: readonly string[]
  unsavedNames?: readonly string[]
  strings: QuitDialogStrings
}): QuitDialogContent {
  const { appName, names, strings } = args
  const unsavedNames = args.unsavedNames ?? []
  const count = names.length
  const sentence = fill(strings.detail, { app: appName })
  const agentLines = bulletLines(names, strings)
  if (unsavedNames.length === 0) {
    return {
      message: fill(count === 1 ? strings.messageOne : strings.messageMany, {
        app: appName,
        count
      }),
      detail: agentLines.length > 0 ? `${agentLines.join('\n')}\n\n${sentence}` : sentence,
      buttons: [strings.quitAnyway, strings.cancel],
      defaultId: 1,
      cancelId: 1,
      checkboxLabel: strings.dontAskAgain
    }
  }
  const unsavedCount = unsavedNames.length
  const blocks = [
    `${bulletLines(unsavedNames, strings).join('\n')}\n\n${fill(strings.unsavedDetail, { app: appName })}`
  ]
  if (count > 0) {
    const agentsMessage = fill(count === 1 ? strings.messageOne : strings.messageMany, {
      app: appName,
      count
    })
    blocks.push(`${agentsMessage}\n${agentLines.join('\n')}\n\n${sentence}`)
  }
  return {
    message: fill(unsavedCount === 1 ? strings.unsavedOne : strings.unsavedMany, {
      app: appName,
      count: unsavedCount
    }),
    detail: blocks.join('\n\n'),
    buttons: [strings.quitWithoutSaving, strings.cancel],
    defaultId: 1,
    cancelId: 1,
    checkboxLabel: ''
  }
}

/**
 * Accept the renderer's strings only if every field is a non-empty string; otherwise fall
 * back to English wholesale (a half-translated dialog is worse than an English one).
 */
export function normalizeQuitStrings(raw: unknown): QuitDialogStrings {
  if (!raw || typeof raw !== 'object') return DEFAULT_QUIT_STRINGS
  const r = raw as Record<string, unknown>
  const out = {} as Record<keyof QuitDialogStrings, string>
  for (const key of Object.keys(DEFAULT_QUIT_STRINGS) as (keyof QuitDialogStrings)[]) {
    const v = r[key]
    if (typeof v !== 'string' || !v.trim()) return DEFAULT_QUIT_STRINGS
    out[key] = v
  }
  return out
}
