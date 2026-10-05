/**
 * T243 — Review pane: "I have read this file", and GitHub's own viewed state.
 *
 * Working down a nine-file diff, nothing recorded which files had been read.
 * The operator lost their place on every interruption, and a review that spanned
 * Harnu and the browser lost it twice. This module owns the RULES for the mark;
 * the fs + `gh` shell that actually stores and pushes it is
 * `review-viewed-store.ts`, exactly like `review-core.ts` ↔ `review-ipc.ts`.
 *
 * Three rules shape everything below, and each of them is a decision the spec
 * settled rather than a convenience:
 *
 *  1. **It is a sync direction, not a conflict.** A local mark is a *write
 *     waiting to be pushed*; GitHub's `viewerViewedState` is the *truth to
 *     read*. Local `VIEWED` + remote `UNVIEWED` is therefore not a disagreement
 *     at all — it is an unsynced write, and it pushes up. The one real conflict
 *     is local `VIEWED` + remote `DISMISSED`, and there GitHub carries
 *     information the local side cannot have: the file moved after it was read.
 *     So **GitHub wins whenever a PR is known**, and the local mark is
 *     authoritative only where GitHub has no opinion — a branch with no PR.
 *  2. **The local mark is keyed on the file's BLOB SHA.** Not the head SHA,
 *     which is far too coarse: any commit anywhere would invalidate every mark,
 *     so one commit would cost the operator the whole review. The blob SHA
 *     invalidates exactly the files that changed — `DISMISSED`'s semantics,
 *     reproduced locally — and it is free, because `git diff` already prints it
 *     (`DiffFile.blobSha`).
 *  3. **Reading GitHub's state is a NETWORK call, so it rides the refresh
 *     gesture.** T246 makes "opening performs no network call" a hard rule for
 *     this same pane. An open therefore renders the last copy this session
 *     read, or nothing; only the explicit refresh goes and asks.
 *
 * Pure of Electron, fs and `child_process` — which is what makes every rule
 * above a unit test in `tests/review-viewed.test.ts` rather than a promise.
 */

/** Pushes attempted per refresh, so a long backlog cannot stall the gesture. */
export const MAX_PENDING_PUSHES = 20
/** Marks older than this are dropped on the next write. */
const MARK_TTL_MS = 90 * 24 * 60 * 60 * 1000
/** Marks kept per folder, newest first, so the file cannot grow without bound. */
const MAX_MARKS_PER_FOLDER = 2000

// ═══════════════════════════════════════════════════════════════════════════
// 1. The pure core
// ═══════════════════════════════════════════════════════════════════════════

/** GitHub's own three-valued state, verbatim off `viewerViewedState`. */
export type RemoteViewedState = 'VIEWED' | 'UNVIEWED' | 'DISMISSED'

/**
 * What the pane renders for one file.
 *
 * `dismissed` is deliberately its own value rather than a flavour of
 * `unviewed`: "you read this, and then it moved" is a different sentence from
 * "you have not read this", and collapsing them would be a small version of the
 * all-clear mistake the whole pane is built to avoid (R2).
 *
 * `pending` is the unsynced write — read here, not yet reflected on GitHub. It
 * exists so a mutation that FAILED can never render as synced (AC-6).
 */
export type ViewedState = 'unviewed' | 'viewed' | 'pending' | 'dismissed'

/** One local mark: what was read, which bytes it was, and whether it pushed. */
export interface LocalMark {
  /** The POST-image blob SHA the file had when it was marked. */
  blob: string
  /** ms epoch, for pruning. */
  at: number
  /** A PR is known and the push did not go through. `false` where none is owed. */
  pending: boolean
}

/** Every mark for one folder, keyed by the file's path in the new tree. */
export type FolderMarks = Record<string, LocalMark>

/**
 * Resolve what one file's mark actually IS, from the two sides plus the bytes
 * currently on screen. The whole precedence rule lives here and nowhere else.
 */
export function resolveViewed(input: {
  local: LocalMark | undefined
  /** The blob SHA of the file as it is being rendered right now. */
  currentBlob: string | null
  /** GitHub's answer, or `null` when it has none / was never read. */
  remote: RemoteViewedState | null
}): ViewedState {
  const { local, currentBlob, remote } = input

  // GitHub wins whenever it has an opinion. `DISMISSED` wins hardest: it is the
  // one fact the local side is structurally incapable of knowing.
  if (remote === 'DISMISSED') return 'dismissed'
  if (remote === 'VIEWED') return 'viewed'

  const stillValid = local !== undefined && local.blob === (currentBlob ?? '')

  if (remote === 'UNVIEWED') {
    // Not a disagreement — an unsynced write. It renders as read, and as owed.
    return stillValid ? 'pending' : 'unviewed'
  }

  // No PR, no `gh`, or GitHub simply has not been asked yet this session.
  if (local === undefined) return 'unviewed'
  // The mark outlived the bytes it was made against: read, then moved. That is
  // `DISMISSED` arrived at locally, and it renders as the same state on purpose.
  if (!stillValid) return 'dismissed'
  return local.pending ? 'pending' : 'viewed'
}

/** Resolve a whole snapshot's worth of files in one pass. */
export function resolveViewedFiles(
  files: readonly { path: string; blobSha: string | null }[],
  marks: FolderMarks,
  remote: Record<string, RemoteViewedState> | null
): Record<string, ViewedState> {
  const out: Record<string, ViewedState> = {}
  for (const f of files) {
    out[f.path] = resolveViewed({
      local: marks[f.path],
      currentBlob: f.blobSha,
      remote: remote?.[f.path] ?? null
    })
  }
  return out
}

/**
 * Which pending local marks the refresh gesture should try to push.
 *
 * Only files GitHub still calls `UNVIEWED` and whose bytes have not moved: a
 * mark whose blob changed is `dismissed` now and pushing it would assert the
 * operator read something they did not. Capped so one refresh cannot turn into
 * a hundred round-trips.
 */
export function planPendingPushes(
  files: readonly { path: string; blobSha: string | null }[],
  marks: FolderMarks,
  remote: Record<string, RemoteViewedState> | null,
  limit = MAX_PENDING_PUSHES
): string[] {
  if (remote === null) return []
  const out: string[] = []
  for (const f of files) {
    if (out.length >= limit) break
    const mark = marks[f.path]
    if (!mark || !mark.pending) continue
    if (mark.blob !== (f.blobSha ?? '')) continue
    if (remote[f.path] !== 'UNVIEWED') continue
    out.push(f.path)
  }
  return out
}

/** Drop expired marks, then keep only the newest {@link MAX_MARKS_PER_FOLDER}. */
export function pruneMarks(marks: FolderMarks, now: number): FolderMarks {
  const live = Object.entries(marks).filter(
    ([, m]) => Number.isFinite(m.at) && now - m.at < MARK_TTL_MS
  )
  live.sort((a, b) => b[1].at - a[1].at)
  return Object.fromEntries(live.slice(0, MAX_MARKS_PER_FOLDER))
}

/** Coerce one raw JSON entry into a mark, or `null` when it is not one. */
function sanitizeMark(raw: unknown): LocalMark | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (typeof r.blob !== 'string') return null
  const at = typeof r.at === 'number' && Number.isFinite(r.at) ? r.at : 0
  return { blob: r.blob, at, pending: r.pending === true }
}

/** Coerce a raw folder blob into marks — never throws, unknown shapes drop. */
export function sanitizeFolderMarks(raw: unknown): FolderMarks {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out: FolderMarks = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key) continue
    const mark = sanitizeMark(value)
    if (mark) out[key] = mark
  }
  return out
}

/**
 * `path` → `viewerViewedState` out of the GraphQL payload.
 *
 * Tolerant in the same way `parsePrList` is: a shape we do not recognise yields
 * `null` (= "GitHub has no opinion we can trust") rather than throwing, because
 * a pane that renders local marks only is recoverable and a main process that
 * throws on someone else's JSON is not.
 */
export function parseViewedStates(stdout: string): {
  states: Record<string, RemoteViewedState>
  endCursor: string | null
} | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return null
  }
  const dig = (o: unknown, key: string): unknown =>
    typeof o === 'object' && o !== null ? (o as Record<string, unknown>)[key] : undefined
  const files = dig(dig(dig(parsed, 'data'), 'node'), 'files')
  if (typeof files !== 'object' || files === null) return null
  const nodes = Array.isArray((files as Record<string, unknown>).nodes)
    ? ((files as Record<string, unknown>).nodes as unknown[])
    : []
  const states: Record<string, RemoteViewedState> = {}
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue
    const n = node as Record<string, unknown>
    if (typeof n.path !== 'string' || !n.path) continue
    const state = n.viewerViewedState
    if (state === 'VIEWED' || state === 'UNVIEWED' || state === 'DISMISSED') states[n.path] = state
  }
  const info = dig(files, 'pageInfo')
  const hasNext = dig(info, 'hasNextPage') === true
  const endCursor = dig(info, 'endCursor')
  return {
    states,
    endCursor: hasNext && typeof endCursor === 'string' ? endCursor : null
  }
}
