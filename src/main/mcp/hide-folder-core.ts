/**
 * The pure planner behind the `hide_folder` verb (T661): one outcome row per folder path,
 * decided from plain lookups so every branch is testable without electron or fs.
 *
 * The caller hands in paths that are already normalized (the strings `projects.json` stores)
 * and a `hidden` set read from that file INSIDE the store's write lock, so the rows always
 * describe the state the write is about to change (BUG-254: never plan from a stale snapshot).
 *
 * Order per path: `refused` for a blocked folder (asked first, like every other verb, so a
 * blocked path never reveals whether Harnu knows it), then `notFound` (not pinned, not hidden,
 * not a scanned folder), then, unhiding, `shown` / `alreadyVisible`; hiding, `alreadyHidden`
 * (nothing would change, so nothing is refused), a `working` session, a parked approval, and
 * only then `hidden`.
 */

export type HideOutcome =
  'hidden' | 'alreadyHidden' | 'shown' | 'alreadyVisible' | 'notFound' | 'refused'

export type HideRefusal = 'FOLDER_NOT_ALLOWED' | 'SESSION_WORKING' | 'PENDING_APPROVAL'

export interface HideRow {
  path: string
  outcome: HideOutcome
  /** Present exactly when `outcome` is `refused`. */
  reason?: HideRefusal
}

export interface HidePlanDeps {
  /** The hidden set right now, read inside the write lock. */
  hidden: ReadonlySet<string>
  /** Whether Harnu knows this folder: pinned, hidden, or seen in the scanned session history. */
  isKnown: (path: string) => boolean
  /** Whether the operator blocked this folder for agents. */
  isDenied: (path: string) => boolean
  /** Whether a session whose folder is exactly this path is working right now. */
  hasWorkingSession: (path: string) => boolean
  /** Whether an approval is parked for a session whose folder is exactly this path. */
  hasPendingApproval: (path: string) => boolean
}

export interface HidePlan {
  rows: HideRow[]
  /** Paths to add to the hidden set. */
  toHide: string[]
  /** Paths to drop from the hidden set. */
  toShow: string[]
}

export function planHideFolder(
  paths: readonly string[],
  unhide: boolean,
  deps: HidePlanDeps
): HidePlan {
  const rows: HideRow[] = []
  const toHide: string[] = []
  const toShow: string[] = []
  const seen = new Set<string>()

  for (const path of paths) {
    if (seen.has(path)) continue
    seen.add(path)

    if (deps.isDenied(path)) {
      rows.push({ path, outcome: 'refused', reason: 'FOLDER_NOT_ALLOWED' })
      continue
    }
    const isHidden = deps.hidden.has(path)
    if (!isHidden && !deps.isKnown(path)) {
      rows.push({ path, outcome: 'notFound' })
      continue
    }

    if (unhide) {
      if (isHidden) {
        rows.push({ path, outcome: 'shown' })
        toShow.push(path)
      } else {
        rows.push({ path, outcome: 'alreadyVisible' })
      }
      continue
    }

    if (isHidden) {
      rows.push({ path, outcome: 'alreadyHidden' })
      continue
    }
    if (deps.hasWorkingSession(path)) {
      rows.push({ path, outcome: 'refused', reason: 'SESSION_WORKING' })
      continue
    }
    if (deps.hasPendingApproval(path)) {
      rows.push({ path, outcome: 'refused', reason: 'PENDING_APPROVAL' })
      continue
    }
    rows.push({ path, outcome: 'hidden' })
    toHide.push(path)
  }

  return { rows, toHide, toShow }
}

/** `hide 2 hidden, 1 notFound`: counts only, for the audit row (never a path). */
export function summarizeHide(unhide: boolean, rows: readonly HideRow[]): string {
  const counts = new Map<HideOutcome, number>()
  for (const r of rows) counts.set(r.outcome, (counts.get(r.outcome) ?? 0) + 1)
  const parts = [...counts].map(([outcome, n]) => `${n} ${outcome}`)
  return `${unhide ? 'unhide' : 'hide'} ${parts.join(', ')}`
}
