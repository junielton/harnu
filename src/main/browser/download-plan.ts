/**
 * Browser pane downloads, pure core (T572 U5, spec §3.2, §6.1 row 18, §6.2, Q16): which downloads are allowed to
 * happen at all, what a saved file is called, and the one-shot allowance a `browser_download` call arms.
 *
 * The rule (decision 21, 24): no automatic downloads. `will-download` cancels unless an agent call armed the pane or
 * the operator started it with a real click, in which case the header asks first. Nothing a download produces is
 * ever opened or executed. The view host wires Electron's `DownloadItem` to these decisions; they are decided here
 * so they are tested without a browser.
 */
import * as path from 'node:path'

/** Where a pane's saved downloads go, relative to its folder (spec §6.2). */
export const DOWNLOADS_DIR = '.harnu/out/downloads'
export const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 15_000
export const MAX_DOWNLOAD_TIMEOUT_MS = 30_000
/** After a download starts, how long the verb waits for it to finish. */
export const DOWNLOAD_COMPLETE_TIMEOUT_MS = 80_000
/** How long the operator's "Save to …?" prompt waits for an answer before cancelling (design.md). */
export const DOWNLOAD_PROMPT_TIMEOUT_MS = 60_000
/** The longest saved name in UTF-8 BYTES (file systems cap bytes, not characters; most allow 255). */
const MAX_NAME_BYTES = 240

/**
 * Characters that change how a name READS without changing what it IS: bidirectional overrides and isolates (an
 * `invoice‮fdp.exe` that looks like a PDF), the Arabic letter mark, zero-width characters and the byte-order mark.
 * They are removed from every name, so the prompt and the saved file never show one.
 */
// eslint-disable-next-line no-misleading-character-class
const INVISIBLE_RE = /[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g

const byteLength = (text: string): number => Buffer.byteLength(text, 'utf8')

/** `text` cut to at most `max` UTF-8 bytes on a character boundary. */
function cutBytes(text: string, max: number): string {
  let out = ''
  let used = 0
  for (const ch of text) {
    const n = byteLength(ch)
    if (used + n > max) break
    out += ch
    used += n
  }
  return out
}

/**
 * A safe file name from whatever the server or the agent suggested: no directories, no separators or NULs or control
 * characters, no invisible or direction-changing characters, nothing Windows rejects, no leading dots (a hidden file
 * or `..`), no trailing dots or spaces, at most {@link MAX_NAME_BYTES} UTF-8 bytes with the extension kept. Empty
 * after cleaning is `download`.
 */
export function sanitizeDownloadName(raw: string): string {
  // Both separators, whatever the platform: a name from a server is never a path.
  const base = raw.split(/[\\/]/).pop() ?? ''
  const cleaned = base
    .replace(INVISIBLE_RE, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_')
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '')
  if (cleaned === '' || /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(cleaned)) {
    return cleaned === '' ? 'download' : cutBytes(`_${cleaned}`, MAX_NAME_BYTES)
  }
  if (byteLength(cleaned) <= MAX_NAME_BYTES) return cleaned
  const ext = path.extname(cleaned)
  const keep = ext.length > 0 && byteLength(ext) <= 16 ? ext : ''
  return `${cutBytes(cleaned.slice(0, cleaned.length - keep.length), MAX_NAME_BYTES - byteLength(keep))}${keep}`
}

/**
 * `name` if free, else `stem (1).ext`, `stem (2).ext`, … — a saved download never overwrites a file. `exists` is the
 * caller's check (a synchronous `fs.existsSync` at the one place that decides the path).
 */
export function uniqueDownloadName(name: string, exists: (candidate: string) => boolean): string {
  if (!exists(name)) return name
  const ext = path.extname(name)
  const stem = ext ? name.slice(0, -ext.length) : name
  for (let i = 1; i < 10_000; i++) {
    const candidate = `${stem} (${i})${ext}`
    if (!exists(candidate)) return candidate
  }
  // Practically unreachable; a timestamp suffix still never overwrites.
  return `${stem} (${Date.now()})${ext}`
}

export type DownloadDecision =
  | { action: 'save-agent' }
  | { action: 'prompt' }
  | { action: 'cancel'; reason: 'not-requested' | 'too-large' | 'prompt-busy' }

/**
 * What to do with a download that just started in a pane (spec §3.2, Q16):
 *  - a size we already know to be over the limit is refused first, so an armed call hears `DOWNLOAD_TOO_LARGE`;
 *  - an armed agent allowance saves it, with no prompt (the call IS the request);
 *  - a real user gesture asks the operator, one question at a time;
 *  - everything else (a page script, a redirect nobody asked for) is cancelled silently.
 */
export function decideDownload(input: {
  armed: boolean
  gesturePending: boolean
  promptPending: boolean
  /** `0` or negative when the server did not say. */
  totalBytes: number
}): DownloadDecision {
  if (input.totalBytes > MAX_DOWNLOAD_BYTES) return { action: 'cancel', reason: 'too-large' }
  if (input.armed) return { action: 'save-agent' }
  if (input.gesturePending) {
    return input.promptPending ? { action: 'cancel', reason: 'prompt-busy' } : { action: 'prompt' }
  }
  return { action: 'cancel', reason: 'not-requested' }
}

/** Whether `received` bytes already break the limit (a download whose size was not announced). */
export function overLimit(received: number): boolean {
  return received > MAX_DOWNLOAD_BYTES
}

export type DownloadFailureCode =
  'NO_DOWNLOAD_STARTED' | 'DOWNLOAD_TOO_LARGE' | 'DOWNLOAD_FAILED' | 'DOWNLOAD_CANCELLED'

export type DownloadResult =
  | { ok: true; path: string; bytes: number; mime: string; name: string }
  | { ok: false; code: DownloadFailureCode; detail: string }

/** The `DownloadItem` state at `done`, mapped to a result. */
export function downloadResult(input: {
  state: 'completed' | 'cancelled' | 'interrupted'
  savedAs: string
  relPath: string
  bytes: number
  mime: string
  tooLarge: boolean
}): DownloadResult {
  if (input.state === 'completed') {
    return {
      ok: true,
      path: input.relPath,
      bytes: input.bytes,
      mime: input.mime,
      name: path.basename(input.savedAs)
    }
  }
  if (input.tooLarge) {
    return {
      ok: false,
      code: 'DOWNLOAD_TOO_LARGE',
      detail: `Over ${Math.round(MAX_DOWNLOAD_BYTES / 1024 / 1024)} MiB.`
    }
  }
  if (input.state === 'cancelled') {
    return { ok: false, code: 'DOWNLOAD_CANCELLED', detail: 'The download was cancelled.' }
  }
  return { ok: false, code: 'DOWNLOAD_FAILED', detail: 'The download was interrupted.' }
}

/* ------------------------------------------------------------------------------------------------ */
/* The one-shot allowance                                                                             */
/* ------------------------------------------------------------------------------------------------ */

export interface DownloadArmIo {
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  /**
   * A claimed download is being abandoned (it did not finish in time, or the call that armed it is over): the host
   * cancels the item, so nothing keeps downloading into the folder after the agent was told it failed.
   */
  abortClaimed?(paneId: string): void
}

export interface ArmClaim {
  /** The name the agent asked for (sanitised later), or `undefined` to use the server's. */
  name: string | undefined
  /** Settle the call that made this claim; a no-op once that call is over, so a late download never settles a newer one. */
  settle(result: DownloadResult): void
}

export interface DownloadArm {
  /** Settles when the download finished, failed, or none started in time. */
  result: Promise<DownloadResult>
  /** Drop the allowance (the verb is done, for whatever reason). Idempotent; settles with `NO_DOWNLOAD_STARTED`. */
  disarm(): void
}

/**
 * The per-pane one-shot allowance `browser_download` arms before it triggers anything. `claim` is what
 * `will-download` calls: it consumes the allowance, so a SECOND download in the same call (a page that starts two)
 * is cancelled. Time is injected; no electron.
 */
export interface DownloadArms {
  arm(paneId: string, opts: { name?: string; timeoutMs: number }): DownloadArm
  /** `will-download` for `paneId`: the allowance, consumed, or `null` when none is armed. */
  claim(paneId: string): ArmClaim | null
  /** The claimed download ended (or was refused): settle the waiting verb. */
  settle(paneId: string, result: DownloadResult): void
  /** Whether an allowance is armed (not yet claimed) for the pane. */
  isArmed(paneId: string): boolean
}

export function createDownloadArms(io: DownloadArmIo): DownloadArms {
  interface Slot {
    name: string | undefined
    claimed: boolean
    timer: unknown
    resolve(r: DownloadResult): void
    done: boolean
  }
  const slots = new Map<string, Slot>()

  const finish = (paneId: string, slot: Slot, result: DownloadResult): void => {
    if (slot.done) return
    slot.done = true
    io.clearTimer(slot.timer)
    if (slots.get(paneId) === slot) slots.delete(paneId)
    slot.resolve(result)
  }

  return {
    arm(paneId, opts) {
      // A previous allowance that is still open belongs to a call that is over: end it.
      const old = slots.get(paneId)
      if (old) {
        // A download of the call being replaced is still arriving: stop it, it belongs to nobody now.
        if (old.claimed && !old.done) io.abortClaimed?.(paneId)
        finish(paneId, old, noneStarted())
      }
      let resolve!: (r: DownloadResult) => void
      const result = new Promise<DownloadResult>((r) => (resolve = r))
      const slot: Slot = {
        name: opts.name,
        claimed: false,
        timer: null,
        resolve,
        done: false
      }
      slot.timer = io.setTimer(() => {
        if (!slot.claimed) finish(paneId, slot, noneStarted())
      }, opts.timeoutMs)
      slots.set(paneId, slot)
      return {
        result,
        disarm: () => {
          // The call is over while its download is still arriving (a deadline, an abort): stop the download.
          if (slot.claimed && !slot.done) io.abortClaimed?.(paneId)
          finish(paneId, slot, noneStarted())
        }
      }
    },
    claim(paneId) {
      const slot = slots.get(paneId)
      if (!slot || slot.claimed || slot.done) return null
      slot.claimed = true
      // The start timer no longer applies; the completion wait is its own bound.
      io.clearTimer(slot.timer)
      slot.timer = io.setTimer(() => {
        if (!slot.done) io.abortClaimed?.(paneId)
        finish(paneId, slot, {
          ok: false,
          code: 'DOWNLOAD_FAILED',
          detail: 'The download did not finish in time.'
        })
      }, DOWNLOAD_COMPLETE_TIMEOUT_MS)
      return { name: slot.name, settle: (result) => finish(paneId, slot, result) }
    },
    settle(paneId, result) {
      const slot = slots.get(paneId)
      if (slot) finish(paneId, slot, result)
    },
    isArmed(paneId) {
      const slot = slots.get(paneId)
      return slot !== undefined && !slot.claimed && !slot.done
    }
  }
}

function noneStarted(): DownloadResult {
  return {
    ok: false,
    code: 'NO_DOWNLOAD_STARTED',
    detail: 'No download began before the timeout.'
  }
}

/**
 * Whether `target` (already resolved) stays inside `root`: the downloads directory must not be a symlink that
 * leaves the folder. Both arguments are real paths.
 */
export function isInsideReal(root: string, target: string): boolean {
  const rel = path.relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/* ------------------------------------------------------------------------------------------------ */
/* Where a download lands                                                                             */
/* ------------------------------------------------------------------------------------------------ */

/** The filesystem the target resolution touches (the real one in the view host, a fake in tests). */
export interface DownloadFsIo {
  /** Create the directory and its parents. May throw. */
  mkdirp(dir: string): void
  realpath(p: string): string
  exists(p: string): boolean
  /**
   * Claim `p` by creating it exclusively (fails with `EEXIST` if it exists): the name is then ours, so a file that
   * appears between "is it free?" and the first byte can never be overwritten. Absent = no reservation (tests).
   */
  reserve?(p: string): void
}

export type DownloadTarget =
  { ok: true; absPath: string; relPath: string; name: string } | { ok: false; detail: string }

/**
 * The file a download is saved as: `<folder>/.harnu/out/downloads/<clean name>`, numbered if taken. The directory is
 * created, and its REAL path must stay inside the folder's real path (a `.harnu` that is a link out of the folder
 * would otherwise send files anywhere). `rawName` is whatever the server or the agent suggested.
 */
export function resolveDownloadTarget(
  folder: string,
  rawName: string,
  io: DownloadFsIo
): DownloadTarget {
  const dir = path.join(folder, DOWNLOADS_DIR)
  try {
    io.mkdirp(dir)
    const dirReal = io.realpath(dir)
    const rootReal = io.realpath(folder)
    if (!isInsideReal(rootReal, dirReal)) {
      return { ok: false, detail: 'the downloads folder leaves the pane folder through a link' }
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      const name = uniqueDownloadName(sanitizeDownloadName(rawName), (n) =>
        io.exists(path.join(dirReal, n))
      )
      const absPath = path.join(dirReal, name)
      if (io.reserve) {
        try {
          io.reserve(absPath)
        } catch (err) {
          // Somebody took the name between the check and the claim: pick again (it now exists).
          if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue
          throw err
        }
      }
      return { ok: true, absPath, relPath: `${DOWNLOADS_DIR}/${name}`, name }
    }
    return { ok: false, detail: 'could not find a free file name' }
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) }
  }
}

/* ------------------------------------------------------------------------------------------------ */
/* The operator's held download (Q16)                                                                 */
/* ------------------------------------------------------------------------------------------------ */

/**
 * A download the operator started with a click is received into a PRIVATE temporary directory, never into the folder:
 * pausing it is not a hold (a small file finishes before the pause lands, found live), so the only thing that can put
 * a file in `.harnu/out/downloads/` is the operator's **Save** after it arrived. This is the whole state machine of
 * that hold, pure, so the order of "finished" and "answered" can never matter.
 */
export interface HeldDownload {
  /** The bytes have all arrived in the temporary directory. */
  completed: boolean
  answered: 'pending' | 'allow' | 'deny'
  /** The download broke off (interrupted, cancelled, or over the size limit). */
  failed: boolean
}

export const NEW_HELD_DOWNLOAD: HeldDownload = {
  completed: false,
  answered: 'pending',
  failed: false
}

export type HeldAction = 'done-ok' | 'done-fail' | 'allow' | 'deny'

/** What the host does about it: nothing yet, move the file into the folder, or throw the temporary file away. */
export type HeldEffect = 'none' | 'move' | 'discard'

export function stepHeldDownload(
  state: HeldDownload,
  action: HeldAction
): { state: HeldDownload; effect: HeldEffect } {
  switch (action) {
    case 'deny':
      return { state: { ...state, answered: 'deny' }, effect: 'discard' }
    case 'done-fail':
      // The operator already said no: the item's `cancelled` event is our own cancel coming back, not a failure.
      if (state.answered === 'deny') return { state, effect: 'none' }
      return { state: { ...state, failed: true }, effect: 'discard' }
    case 'allow': {
      const next: HeldDownload = { ...state, answered: 'allow' }
      return { state: next, effect: state.completed && !state.failed ? 'move' : 'none' }
    }
    case 'done-ok': {
      const next: HeldDownload = { ...state, completed: true }
      if (state.failed || state.answered === 'deny') return { state: next, effect: 'discard' }
      return { state: next, effect: state.answered === 'allow' ? 'move' : 'none' }
    }
  }
}

/** The file io the move needs: an exclusive copy (never overwrite) and the temporary file's removal. */
export interface MoveIo extends DownloadFsIo {
  /** Copy `from` to `to`, failing with `EEXIST` if `to` exists. */
  copyExclusive(from: string, to: string): void
}

/**
 * Move a held download into `.harnu/out/downloads/`: pick the target name now (so a file that appeared while the
 * question was open is never replaced), copy exclusively, and retry the name once if another file took it in between.
 */
export function moveHeldDownload(
  folder: string,
  tempFile: string,
  rawName: string,
  io: MoveIo
): DownloadTarget {
  for (let attempt = 0; attempt < 5; attempt++) {
    const target = resolveDownloadTarget(folder, rawName, io)
    if (!target.ok) return target
    try {
      io.copyExclusive(tempFile, target.absPath)
      return target
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        return { ok: false, detail: err instanceof Error ? err.message : String(err) }
      }
    }
  }
  return { ok: false, detail: 'could not find a free file name' }
}

/* ------------------------------------------------------------------------------------------------ */
/* Stale held downloads                                                                               */
/* ------------------------------------------------------------------------------------------------ */

/** The prefix of the private temp directories holding an operator download that waits for its answer. */
export const HELD_DIR_PREFIX = 'harnu-dl-'
/** A held directory older than this belongs to a process that died (the question times out after 60 s). */
export const HELD_DIR_MAX_AGE_MS = 60 * 60 * 1000

/** Whether a temp directory is a leftover held download to sweep at startup. Younger ones may be another instance's. */
export function isStaleHeldDir(name: string, mtimeMs: number, now: number): boolean {
  return name.startsWith(HELD_DIR_PREFIX) && now - mtimeMs > HELD_DIR_MAX_AGE_MS
}
