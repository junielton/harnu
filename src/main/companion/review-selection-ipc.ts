/**
 * The renderer-facing half of the review selection (T257 §6.5): `review:selection:send` delivers a
 * selection to the review companion through the Harnu mod channel, and `review:selection:compose`
 * returns the exact text the same send would carry, for **Copy as text**.
 *
 * **Operator gesture only.** The operator cause (the review selection's gesture, named by
 * `REVIEW_SELECTION_GESTURE`) is built inside the `ipcMain.handle` callback below and nowhere else
 * (P2W1 §9.2). The channel is not
 * an MCP verb: `tool-catalog.ts` does not name it and nothing under `src/main/mcp` reaches it.
 *
 * The renderer sends coordinates, never text. `main` re-reads the head and base, runs the same
 * head comparison the submit gate runs, reads the selected lines with a read-only `git show` at the
 * pinned commit, and composes the row (`review-selection-core.ts`). Every way this can fail comes
 * back as a stable reason **code** with the next steps the operator has; `main` writes no sentence.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ipcMain, type BrowserWindow } from 'electron'
import { parseUnifiedDiff, type DiffRow } from '../review-core'
import { enqueue as channelEnqueue } from './command-channel'
import type { CommandCause } from './command-types'
import {
  REVIEW_DIFF_FLAGS,
  REVIEW_SELECTION_GESTURE,
  REVIEW_SELECTION_KEY,
  composeCleared,
  composeSelection,
  failure,
  lineSource,
  locateDiffRows,
  quotesDiffRows,
  rangeDiffSource,
  noBindingReason,
  pinRefusal,
  validateCoordinates,
  validateReviewRef,
  type NoBindingReason,
  type SelectionComposeResult,
  type SelectionCoordinates,
  type SelectionFailure,
  type SelectionReviewRef,
  type SelectionSendResult
} from './review-selection-core'
import {
  createBandDriver,
  createSelectionTracker,
  createSidFollower,
  type SelectionTracker
} from './review-selection-tracker'
import type { BindingView } from './session-table'

const execFileAsync = promisify(execFile)

/** One blob. A file over this is refused as unreadable rather than half-read. */
const BLOB_MAX_BYTES = 8 * 1024 * 1024
/** The pane's own bound on a branch-wide diff (`GIT_MAX_BUFFER` in `review-ipc.ts`). */
const DIFF_MAX_BYTES = 64 << 20
const GIT_TIMEOUT_MS = 15_000

/**
 * What composing a selection needs, and all it needs: git. **Copy as text** must work with no mod,
 * no binding and no companion host (U2b-AC-2), so `review:selection:compose` takes only this.
 */
export interface GitDeps {
  /** `git rev-parse --verify --quiet <ref>^{commit}` in `folder`, or `null`. */
  resolveCommit(folder: string, ref: string): Promise<string | null>
  /** `git show <sha>:<path>` in `folder`, or `null` when it cannot be read. */
  readBlob(folder: string, sha: string, path: string): Promise<string | null>
  /**
   * The Review pane's diff for `range` (`<baseSha>...<headSha>`), or `null` when it cannot be read.
   * Only a mixed-side range reads it: its rows are quoted from the diff, not from one file.
   */
  readDiff(folder: string, range: string): Promise<string | null>
}

/** Everything the send reaches for, injected so the tests run without Electron's app or a repo. */
export interface SelectionDeps extends GitDeps {
  bindingForSid(sid: string): BindingView | null
  /**
   * The id the companion's conversation has NOW for the id it was spawned with: `/clear` and a
   * resume re-key the binding, and the renderer keeps addressing the minted one (U2d). Absent, or
   * an id nothing was reported for, it is the id itself.
   */
  followSid?(sid: string): string
  enqueue: typeof channelEnqueue
  /** Why the companion with this sid has no binding (the inject decision of its PTY). */
  noBindingReason(sid: string): NoBindingReason
  tracker: Pick<SelectionTracker, 'track'>
  log?(message: string): void
}

const COMPANION_SID_RE = /^[0-9a-fA-F-]{8,64}$/

type Rec = Record<string, unknown>
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v)

interface Prepared {
  coords: SelectionCoordinates
  ref: SelectionReviewRef
}

function prepare(raw: unknown, extraKeys: readonly string[]): Prepared | SelectionFailure {
  if (!isRec(raw)) return failure('BAD_ARGS', { detail: 'not-an-object' })
  const allowed = ['folder', 'headRef', 'base', 'selection', ...extraKeys]
  if (Object.keys(raw).some((k) => !allowed.includes(k))) {
    return failure('BAD_ARGS', { detail: 'unknown-field' })
  }
  const ref = validateReviewRef(raw)
  if (!ref.ok) return failure('BAD_ARGS', { detail: ref.detail })
  const coords = validateCoordinates(raw.selection)
  if (!coords.ok) return failure('BAD_ARGS', { detail: coords.detail })
  return { coords: coords.value, ref: ref.value }
}

/** Head guard, blob read and compose: the one path both the send and the compose take. */
async function composeFor(
  p: Prepared,
  deps: GitDeps
): Promise<{ ok: true; text: string } | SelectionFailure> {
  const { coords, ref } = p
  const [headSha, baseSha] = await Promise.all([
    deps.resolveCommit(ref.folder, ref.headRef),
    deps.resolveCommit(ref.folder, ref.base)
  ])
  const pin = pinRefusal(coords, { headSha, baseSha })
  if (pin) return failure(pin.refusal, pin.detail !== undefined ? { detail: pin.detail } : {})
  // A multi-row range is checked against the diff the pane renders: a mixed-side one is quoted as
  // diff rows (its two ends live in different files, so no one blob has the rows between them), and
  // so is a same-side one whose displayed rows include a row of the other side (file lines of one
  // side would silently leave it out). Rows that cannot be located are a refusal, never a guess.
  let rows: DiffRow[] | null = null
  if (rangeDiffSource(coords)) {
    const diff = await deps.readDiff(ref.folder, `${coords.baseSha}...${coords.headSha}`)
    if (diff === null) return failure('BAD_ARGS', { detail: 'diff-unreadable' })
    rows = locateDiffRows(parseUnifiedDiff(diff), coords)
    if (rows === null) return failure('BAD_ARGS', { detail: 'rows-not-found' })
  }
  const src = rows !== null && quotesDiffRows(coords, rows) ? null : lineSource(coords)
  let blob: string | null = null
  if (src) {
    blob = await deps.readBlob(ref.folder, src.sha, src.path)
    if (blob === null) return failure('BAD_ARGS', { detail: 'blob-unreadable' })
  }
  const composed = composeSelection(coords, blob, rows)
  return composed.ok ? composed : failure('BAD_ARGS', { detail: composed.detail })
}

/** `review:selection:compose`: the text a send would carry, with the same guard. Sends nothing. */
export async function composeSelectionText(
  raw: unknown,
  deps: GitDeps
): Promise<SelectionComposeResult> {
  const p = prepare(raw, [])
  if ('ok' in p) return p
  return composeFor(p, deps)
}

/**
 * `review:selection:send`. Never rejects. `cause` is a parameter only so the handler below can
 * construct it from a literal; the gate refuses any gesture its row does not list.
 */
export async function sendSelection(
  raw: unknown,
  cause: CommandCause,
  deps: SelectionDeps
): Promise<SelectionSendResult> {
  const log = deps.log ?? ((m: string): void => console.warn(`[review-selection] ${m}`))
  // `selection: null` is the operator clearing it: the companion's row is replaced by the one that
  // says nothing is selected. Anything else is a selection, and `undefined` is not null.
  const clearing = isRec(raw) && raw.selection === null
  let rowId: string
  let prepared: Prepared | null = null
  if (clearing) {
    if (Object.keys(raw).some((k) => !['companionSid', 'selection', 'id'].includes(k))) {
      return failure('BAD_ARGS', { detail: 'unknown-field' })
    }
    if (typeof raw.id !== 'string' || !/^sel_[A-Za-z0-9_-]{1,64}$/.test(raw.id)) {
      return failure('BAD_ARGS', { detail: 'id' })
    }
    rowId = raw.id
  } else {
    const p = prepare(raw, ['companionSid'])
    if ('ok' in p) return p
    prepared = p
    rowId = p.coords.id
  }
  const sid = (raw as Rec).companionSid
  if (sid === null || sid === undefined || sid === '') return failure('no-companion')
  if (typeof sid !== 'string' || !COMPANION_SID_RE.test(sid)) {
    return failure('BAD_ARGS', { detail: 'companion-sid' })
  }
  // The renderer addresses the companion by the id it was spawned with; after /clear the binding
  // has another. Everything below addresses the binding, the minted id is only for the PTY lookup.
  const live = deps.followSid ? deps.followSid(sid) : sid
  // The gesture can never be aimed at an operator's working session by passing its sid.
  const existing = deps.bindingForSid(live)
  if (existing && existing.trust !== 'read-only') return failure('TARGET_DENIED')

  let text: string
  if (prepared) {
    const composed = await composeFor(prepared, deps)
    if (!composed.ok) return composed
    text = composed.text
  } else {
    text = composeCleared()
  }

  const sent = deps.enqueue({
    sessionKey: null,
    sid: live,
    name: 'context.append',
    args: { key: REVIEW_SELECTION_KEY, text, durable: false },
    cause,
    meta: { selection: prepared ? prepared.coords.subjectType : 'NONE' }
  })
  if (!sent.ok) {
    if (sent.reason === 'ORIGIN_DENIED') log('the review selection gate row is missing or drifted')
    return sent.reason === 'NO_BINDING'
      ? failure('NO_BINDING', { reason: deps.noBindingReason(sid) })
      : failure(sent.reason)
  }
  const bound = deps.bindingForSid(live)
  if (bound) {
    deps.tracker.track({
      selectionId: rowId,
      bindingKey: bound.key,
      sid: bound.sid,
      cmd: sent.cmd,
      settled: sent.settled,
      selection: prepared ? prepared.coords : null
    })
  }
  return { ok: true, selectionId: rowId, cmd: sent.cmd, n: sent.n }
}

// ---- the real dependencies ------------------------------------------------------------------------

async function git(
  folder: string,
  args: readonly string[],
  maxBuffer: number
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', folder, ...args], {
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }
    })
    return stdout
  } catch {
    return null
  }
}

/** The real git reads. Nothing here touches the host, the channel or Electron. */
export const gitDeps: GitDeps = {
  resolveCommit: async (folder, ref) => {
    const out = await git(folder, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], 65_536)
    const sha = out?.trim() ?? ''
    return sha.length > 0 ? sha : null
  },
  // Read-only: `show` of one blob at a pinned commit. Nothing is checked out or written.
  readBlob: (folder, sha, path) => git(folder, ['show', `${sha}:${path}`], BLOB_MAX_BYTES),
  // Read-only: the pane's own `git diff`, same flags, over two pinned full SHAs.
  readDiff: (folder, range) => git(folder, ['diff', ...REVIEW_DIFF_FLAGS, range], DIFF_MAX_BYTES)
}

async function liveDeps(emit: (channel: string, payload: unknown) => void): Promise<SelectionDeps> {
  // Lazy: `host.ts` pulls the whole companion host in, and it imports this module's registrar.
  const { companionHost } = await import('./host')
  const { sessionArbiter } = await import('./session-arbiter')
  const { ptyIdForClaudeSession } = await import('../pty')
  const tracker = createSelectionTracker({
    host: companionHost,
    emit: (ev) => emit('review:selection:state', ev)
  })
  createBandDriver().attach(tracker)
  const follower = createSidFollower({ host: companionHost })
  return {
    ...gitDeps,
    bindingForSid: (sid) => companionHost.bindingForSid(sid),
    followSid: follower.resolve,
    enqueue: channelEnqueue,
    noBindingReason: (sid) => {
      const ptyId = ptyIdForClaudeSession(sid)
      return noBindingReason(
        ptyId === null ? null : sessionArbiter().injectDecisionFor({ kind: 'pty', ptyId })
      )
    },
    tracker
  }
}

/** Called once from `registerReviewHandlers`. The runtime (tracker, band driver) starts lazily. */
export function registerReviewSelectionHandlers(getWindow: () => BrowserWindow | null): void {
  let runtime: Promise<SelectionDeps> | null = null
  const deps = async (): Promise<SelectionDeps | null> => {
    try {
      return await (runtime ??= liveDeps((channel, payload) =>
        getWindow()?.webContents.send(channel, payload)
      ))
    } catch {
      runtime = null // the host was not ready; the next gesture tries again
      return null
    }
  }
  // Start the runtime once the app has loaded, not at the first gesture: the follower can only
  // learn a `/clear` it was listening for, and the operator may clear the companion before ever
  // selecting a line. A failed start leaves `runtime` empty and the first gesture tries again.
  setTimeout(() => void deps(), 0)
  // These handlers never reject: a send whose runtime cannot start is the same refusal as no binding.
  const notReady = failure('NO_BINDING', { reason: 'unknown' })

  ipcMain.handle(
    'review:selection:send',
    async (_e, req: unknown): Promise<SelectionSendResult> => {
      const d = await deps()
      if (!d) return notReady
      // Constructed here, from a literal, and nowhere else (P2W1 §9.2).
      return sendSelection(req, { kind: 'operator', gesture: REVIEW_SELECTION_GESTURE }, d)
    }
  )
  ipcMain.handle(
    'review:selection:compose',
    async (_e, req: unknown): Promise<SelectionComposeResult> => {
      // No host, no binding, no mod: compose reads git and nothing else.
      return composeSelectionText(req, gitDeps)
    }
  )
}
