/**
 * Guided walks: the walk script schema (spec S-1, AC-1 and AC-2).
 *
 * `walk_open` receives one JSON object; the pane renders it and nothing in it is markup. This
 * module validates the WHOLE script and refuses it whole: every rule a script breaks is reported
 * once, with the JSON path it was broken at, so the agent that wrote it can fix them in one pass.
 *
 * Pure and Electron-free (ADR-0001). What lives outside the script (the folder's files, the
 * images jail, the known folders, the board, the mission record, the secret scrubber) is injected
 * as a {@link WalkProbe}; `src/main/walk/walk-links.ts` builds the real one.
 */
import {
  isHttpUrl,
  validateCriterion,
  validateSource,
  type SourceProbe,
  type Violation,
  type WalkSource
} from './walk-source'
import type { MachineCheck } from './walk-machine'

export type { Violation, WalkSource } from './walk-source'

// ---- Limits (spec "Rules the validator enforces") ---------------------------------------------

export const LIMITS = {
  title: 50,
  walkTitle: 120,
  why: 160,
  undo: 160,
  passes: 240,
  fails: 240,
  teach: 240,
  more: 400,
  blocksWhy: 60,
  doItems: 8,
  images: 2,
  tableRows: 12,
  edge: 6,
  leftOut: 10,
  /** A sanity bound, not a spec limit: a walk is a list a person walks, one check at a time. */
  checks: 100,
  imageBytes: 2 * 1024 * 1024
} as const

// ---- Types -----------------------------------------------------------------------------------

export type WalkPurpose = 'check' | 'learn'
export type LinkKind = 'pr' | 'file' | 'url' | 'folder'
export type LinkCheckStatus = 'ok' | 'login' | 'unchecked'

export interface WalkLink {
  label: string
  kind: LinkKind
  target: string
  line?: number
  checked?: { status: LinkCheckStatus; at: string }
}

export interface DoItem {
  text: string
  see: string
  block?: { text: string; lang?: string }
}

export interface WalkImage {
  src: string
  alt: string
  kind: 'expected' | 'capture'
  caption?: string
}

export interface WalkCheck {
  id: string
  title: string
  why: string
  where: { text: string; path?: string; approximate?: boolean; links?: WalkLink[] }
  do: DoItem[]
  passes: string
  fails?: string
  images?: WalkImage[]
  precheck?: string
  check?: { how: string }
  nothingFromHere?: string
  more?: string
  teach?: {
    what: string
    where?: WalkLink[]
    idea?: { text: string; link?: WalkLink }
    why?: string
  }
  /** `id` (`e1`, `e2`, ...) is given by the store when the script is accepted; a script never carries it. */
  edge?: { id?: string; text: string; see: string }[]
  table?: { item: string; shows: string; source: string }[]
  blocks?: string[]
  blocksWhy?: string
  undo?: string
  criterion?: string
  status?: 'verified' | 'caveat'
  evidence?: string
  openPr?: number | string
}

export interface WalkScript {
  title: string
  purpose: WalkPurpose
  source: WalkSource
  leftOut?: { text: string; owner: 'ours' | 'optional' | 'decision' }[]
  checks: WalkCheck[]
}

export type ImageFact =
  { ok: true; bytes: number } | { ok: false; reason: 'outside-jail' | 'missing' | 'not-image' }

/** Everything the validator needs from outside the script. */
export interface WalkProbe extends SourceProbe {
  /** Is `rel` (a path relative to the walk's folder) an existing file inside that folder? */
  fileInFolder(rel: string): boolean
  /** Is `path` a folder Harnu knows? */
  folderKnown(path: string): boolean
  /** The image at `src`: inside the jail and how big, or why it is refused. */
  image(src: string): ImageFact
  /** Does `text` look like a secret (the `get_session` scrubber's patterns)? */
  looksLikeSecret(text: string): boolean
}

export type WalkValidation =
  { ok: true; script: WalkScript } | { ok: false; violations: Violation[] }

// ---- Helpers ---------------------------------------------------------------------------------

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x)
const str = (x: unknown): x is string => typeof x === 'string' && x.trim().length > 0

const EMOJI_RE = /\p{Extended_Pictographic}|\p{Regional_Indicator}|️|⃣/u
/** A `<placeholder>` left in a command: an angle-bracketed word the operator would have to fill in. */
const PLACEHOLDER_RE = /<[A-Za-z][A-Za-z0-9_ .-]{0,40}>/
/** Keys whose values are addresses or ids, never prose: they are not scanned for emoji. */
const NON_PROSE_KEYS = new Set(['target', 'src', 'at', 'id', 'url', 'lang', 'kind', 'status'])

class Collector {
  readonly list: Violation[] = []
  private readonly seen = new Set<string>()
  add(path: string, rule: string, message: string): void {
    const key = `${path} ${rule}`
    if (this.seen.has(key)) return // one violation per rule, per path
    this.seen.add(key)
    this.list.push({ path, rule, message })
  }
}

/** Every backtick span of `text` (the copy chips). */
function chips(text: string): string[] {
  return [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1])
}

// ---- Validation ------------------------------------------------------------------------------

/** Validate a whole script against `probe`. Never throws; a refused script lists every violation. */
export function validateWalkScript(input: unknown, probe: WalkProbe): WalkValidation {
  const c = new Collector()
  if (!isObj(input)) {
    c.add('$', 'NOT_AN_OBJECT', 'A walk script is one JSON object.')
    return { ok: false, violations: c.list }
  }

  // title and purpose
  if (!str(input.title)) c.add('$.title', 'MISSING', 'A walk needs a title.')
  else if (input.title.length > LIMITS.walkTitle)
    c.add('$.title', 'TOO_LONG', `At most ${LIMITS.walkTitle} characters.`)
  const purposeRaw = input.purpose
  if (purposeRaw !== undefined && purposeRaw !== 'check' && purposeRaw !== 'learn')
    c.add('$.purpose', 'BAD_VALUE', 'The purpose is check or learn.')
  const purpose: WalkPurpose = purposeRaw === 'learn' ? 'learn' : 'check'

  // source
  const src = validateSource(input.source, probe, '$.source')
  for (const x of src.violations) c.add(x.path, x.rule, x.message)

  // left out
  if (input.leftOut !== undefined) {
    if (!Array.isArray(input.leftOut)) c.add('$.leftOut', 'BAD_VALUE', 'leftOut is a list.')
    else {
      if (input.leftOut.length > LIMITS.leftOut)
        c.add('$.leftOut', 'TOO_MANY', `At most ${LIMITS.leftOut} rows.`)
      input.leftOut.forEach((row: unknown, i: number) => {
        const p = `$.leftOut[${i}]`
        if (!isObj(row)) return c.add(p, 'NOT_AN_OBJECT', 'A row is an object.')
        if (!str(row.text)) c.add(`${p}.text`, 'MISSING', 'Say what is left out.')
        if (row.owner !== 'ours' && row.owner !== 'optional' && row.owner !== 'decision')
          c.add(`${p}.owner`, 'BAD_VALUE', 'The owner is ours, optional or decision.')
      })
    }
  }

  // checks
  if (!Array.isArray(input.checks) || input.checks.length === 0) {
    c.add('$.checks', 'MISSING', 'A walk needs at least one check.')
  } else {
    if (input.checks.length > LIMITS.checks)
      c.add('$.checks', 'TOO_MANY', `At most ${LIMITS.checks} checks.`)
    const ids = input.checks.map((ch: unknown) => (isObj(ch) && str(ch.id) ? ch.id : null))
    input.checks.forEach((ch: unknown, i: number) =>
      validateCheck(ch, i, ids, purpose, src.source, probe, c)
    )
  }

  // text rules that apply to the whole script: no emoji in any prose field
  scanEmoji(input, '$', c)

  if (c.list.length > 0) return { ok: false, violations: c.list }
  return { ok: true, script: { ...(input as unknown as WalkScript), purpose } }
}

function scanEmoji(node: unknown, path: string, c: Collector): void {
  if (typeof node === 'string') {
    if (EMOJI_RE.test(node)) c.add(path, 'EMOJI', 'Plain text only: no emoji.')
  } else if (Array.isArray(node)) {
    node.forEach((x, i) => scanEmoji(x, `${path}[${i}]`, c))
  } else if (isObj(node)) {
    for (const [k, val] of Object.entries(node)) {
      if (NON_PROSE_KEYS.has(k) && typeof val === 'string') continue
      scanEmoji(val, `${path}.${k}`, c)
    }
  }
}

function capped(c: Collector, path: string, val: unknown, max: number, required: boolean): void {
  if (val === undefined || val === null || (typeof val === 'string' && val.trim() === '')) {
    if (required) c.add(path, 'MISSING', 'This field is required.')
    return
  }
  if (typeof val !== 'string') return c.add(path, 'BAD_VALUE', 'This field is text.')
  if (val.length > max) c.add(path, 'TOO_LONG', `At most ${max} characters.`)
}

function validateCheck(
  raw: unknown,
  i: number,
  ids: (string | null)[],
  purpose: WalkPurpose,
  source: WalkSource | null,
  probe: WalkProbe,
  c: Collector
): void {
  const p = `$.checks[${i}]`
  if (!isObj(raw)) return c.add(p, 'NOT_AN_OBJECT', 'A check is an object.')

  // id
  if (!str(raw.id)) c.add(`${p}.id`, 'MISSING', 'A check needs an id.')
  else if (ids.indexOf(raw.id) !== i) c.add(`${p}.id`, 'DUPLICATE_ID', 'Two checks share this id.')

  capped(c, `${p}.title`, raw.title, LIMITS.title, true)
  capped(c, `${p}.why`, raw.why, LIMITS.why, true)
  capped(c, `${p}.undo`, raw.undo, LIMITS.undo, false)
  capped(c, `${p}.passes`, raw.passes, LIMITS.passes, true)
  capped(c, `${p}.fails`, raw.fails, LIMITS.fails, purpose === 'check')
  capped(c, `${p}.more`, raw.more, LIMITS.more, false)
  capped(c, `${p}.blocksWhy`, raw.blocksWhy, LIMITS.blocksWhy, false)
  capped(c, `${p}.precheck`, raw.precheck, LIMITS.passes, false)

  // where: text, an optional click path (then `approximate`), and links
  if (!isObj(raw.where)) c.add(`${p}.where`, 'MISSING', 'Say where to do this.')
  else {
    if (!str(raw.where.text)) c.add(`${p}.where.text`, 'MISSING', 'Say where to do this.')
    if (raw.where.path !== undefined) {
      if (!str(raw.where.path)) c.add(`${p}.where.path`, 'BAD_VALUE', 'A click path is text.')
      else if (typeof raw.where.approximate !== 'boolean')
        c.add(
          `${p}.where.approximate`,
          'MISSING',
          'A click path says whether it is approximate (true or false).'
        )
    }
    validateLinks(raw.where.links, `${p}.where.links`, probe, c)
  }

  // do: 1..8 items, each with `see`
  if (!Array.isArray(raw.do) || raw.do.length === 0)
    c.add(`${p}.do`, 'MISSING', 'A check needs at least one step.')
  else {
    if (raw.do.length > LIMITS.doItems)
      c.add(`${p}.do`, 'TOO_MANY', `At most ${LIMITS.doItems} steps.`)
    raw.do.forEach((d: unknown, j: number) => validateDo(d, `${p}.do[${j}]`, probe, c))
  }

  // chips: a backtick span that looks like a secret
  for (const f of ['passes', 'fails'] as const) {
    const t = raw[f]
    if (typeof t === 'string' && chips(t).some((s) => probe.looksLikeSecret(s)))
      c.add(`${p}.${f}`, 'SECRET', 'A copy chip looks like a secret.')
  }

  // images
  if (raw.images !== undefined) {
    if (!Array.isArray(raw.images)) c.add(`${p}.images`, 'BAD_VALUE', 'images is a list.')
    else {
      if (raw.images.length > LIMITS.images)
        c.add(`${p}.images`, 'TOO_MANY', `At most ${LIMITS.images} images.`)
      raw.images.forEach((im: unknown, j: number) =>
        validateImage(im, `${p}.images[${j}]`, probe, c)
      )
    }
  }

  // the agent's check: `check` xor `nothingFromHere`
  const hasCheck = raw.check !== undefined
  const hasNothing = raw.nothingFromHere !== undefined
  if (!hasCheck && !hasNothing)
    c.add(
      `${p}.check`,
      'NO_CHECK_OR_NOTHING_FROM_HERE',
      'Give the read-only check, or say why nothing can be checked from here.'
    )
  else if (hasCheck && hasNothing)
    c.add(
      `${p}.check`,
      'BOTH_CHECK_AND_NOTHING_FROM_HERE',
      'A check has either a check or nothingFromHere, not both.'
    )
  if (hasCheck) {
    if (!isObj(raw.check) || !str(raw.check.how))
      c.add(`${p}.check.how`, 'MISSING', 'Say how the agent will check.')
    else if (probe.looksLikeSecret(raw.check.how))
      c.add(`${p}.check.how`, 'SECRET', 'This looks like a secret.')
  }
  if (hasNothing) capped(c, `${p}.nothingFromHere`, raw.nothingFromHere, LIMITS.why, true)

  // teach, edge, table
  if (raw.teach !== undefined) {
    if (!isObj(raw.teach)) c.add(`${p}.teach`, 'BAD_VALUE', 'teach is an object.')
    else {
      capped(c, `${p}.teach.what`, raw.teach.what, LIMITS.teach, true)
      capped(c, `${p}.teach.why`, raw.teach.why, LIMITS.teach, false)
      validateLinks(raw.teach.where, `${p}.teach.where`, probe, c)
      if (raw.teach.idea !== undefined) {
        if (!isObj(raw.teach.idea)) c.add(`${p}.teach.idea`, 'BAD_VALUE', 'idea is an object.')
        else {
          if (!str(raw.teach.idea.text)) c.add(`${p}.teach.idea.text`, 'MISSING', 'Say the idea.')
          if (raw.teach.idea.link !== undefined)
            validateLink(raw.teach.idea.link, `${p}.teach.idea.link`, probe, c)
        }
      }
    }
  }
  if (raw.edge !== undefined) {
    if (!Array.isArray(raw.edge)) c.add(`${p}.edge`, 'BAD_VALUE', 'edge is a list.')
    else {
      if (raw.edge.length > LIMITS.edge)
        c.add(`${p}.edge`, 'TOO_MANY', `At most ${LIMITS.edge} edge checks.`)
      raw.edge.forEach((e: unknown, j: number) => validateDo(e, `${p}.edge[${j}]`, probe, c, false))
    }
  }
  if (raw.table !== undefined) {
    if (!Array.isArray(raw.table)) c.add(`${p}.table`, 'BAD_VALUE', 'table is a list.')
    else {
      if (raw.table.length > LIMITS.tableRows)
        c.add(`${p}.table`, 'TOO_MANY', `At most ${LIMITS.tableRows} rows.`)
      raw.table.forEach((row: unknown, j: number) => {
        const rp = `${p}.table[${j}]`
        if (!isObj(row)) return c.add(rp, 'NOT_AN_OBJECT', 'A row is an object.')
        for (const k of ['item', 'shows', 'source'])
          if (!str(row[k])) c.add(`${rp}.${k}`, 'MISSING', 'Every cell is filled.')
      })
    }
  }

  // blocking is derived from `blocks`: each id is a later check of this script
  if (raw.blocks !== undefined) {
    if (!Array.isArray(raw.blocks) || raw.blocks.some((b: unknown) => typeof b !== 'string'))
      c.add(`${p}.blocks`, 'BAD_VALUE', 'blocks is a list of check ids.')
    else {
      for (const b of raw.blocks as string[]) {
        const at = ids.indexOf(b)
        if (at === -1) c.add(`${p}.blocks`, 'UNKNOWN_CHECK', `No check has the id ${b}.`)
        else if (at <= i) c.add(`${p}.blocks`, 'NOT_LATER', 'A check can only block a later check.')
      }
    }
  }

  // criterion: only with a mission source, only an id that exists on it
  for (const x of validateCriterion(raw.criterion, source, probe, `${p}.criterion`))
    c.add(x.path, x.rule, x.message)

  // a pre-closed row is a complete check that also says how it was closed
  if (raw.status !== undefined) {
    if (raw.status !== 'verified' && raw.status !== 'caveat')
      c.add(`${p}.status`, 'BAD_VALUE', 'A pre-closed row is verified or caveat.')
    else {
      if (!str(raw.evidence))
        c.add(`${p}.evidence`, 'MISSING', 'A pre-closed row carries its evidence.')
      if (raw.status === 'caveat') {
        const pr = raw.openPr
        if (pr === undefined)
          c.add(`${p}.openPr`, 'MISSING', 'A caveat row names the open PR it is right in.')
        else if (
          !(typeof pr === 'number'
            ? Number.isInteger(pr) && pr > 0
            : typeof pr === 'string' && /^[1-9]\d*$/.test(pr))
        )
          c.add(`${p}.openPr`, 'PR_NOT_A_NUMBER', 'A PR is a positive number.')
      }
    }
  }
}

function validateDo(
  d: unknown,
  path: string,
  probe: WalkProbe,
  c: Collector,
  allowBlock = true
): void {
  if (!isObj(d)) return c.add(path, 'NOT_AN_OBJECT', 'A step is an object.')
  if (!str(d.text)) c.add(`${path}.text`, 'MISSING', 'Say what to do.')
  if (!str(d.see)) c.add(`${path}.see`, 'MISSING', 'Say what the operator should see after it.')
  for (const f of ['text', 'see'] as const) {
    const t = d[f]
    if (typeof t === 'string' && chips(t).some((s) => probe.looksLikeSecret(s)))
      c.add(`${path}.${f}`, 'SECRET', 'A copy chip looks like a secret.')
  }
  if (d.block !== undefined && allowBlock) {
    if (!isObj(d.block) || !str(d.block.text))
      c.add(`${path}.block.text`, 'MISSING', 'A block has its command text.')
    else {
      if (probe.looksLikeSecret(d.block.text))
        c.add(`${path}.block.text`, 'SECRET', 'This looks like a secret.')
      if (PLACEHOLDER_RE.test(d.block.text))
        c.add(
          `${path}.block.text`,
          'PLACEHOLDER_IN_COMMAND',
          'Write the real value, not a <placeholder>.'
        )
    }
  }
}

function validateLinks(links: unknown, path: string, probe: WalkProbe, c: Collector): void {
  if (links === undefined) return
  if (!Array.isArray(links)) return c.add(path, 'BAD_VALUE', 'links is a list.')
  links.forEach((l: unknown, i: number) => validateLink(l, `${path}[${i}]`, probe, c))
}

/** A link is data, never an address the page opens: its target must pass its kind's test. */
function validateLink(l: unknown, path: string, probe: WalkProbe, c: Collector): void {
  if (!isObj(l)) return c.add(path, 'NOT_AN_OBJECT', 'A link is an object.')
  if (!str(l.label)) c.add(`${path}.label`, 'MISSING', 'A link has a label.')
  const t = l.target
  switch (l.kind) {
    case 'pr':
      if (
        !(typeof t === 'number'
          ? Number.isInteger(t) && t > 0
          : typeof t === 'string' && /^[1-9]\d*$/.test(t))
      )
        c.add(`${path}.target`, 'PR_NOT_A_NUMBER', 'A pull request link targets a PR number.')
      break
    case 'file':
      if (!str(t) || !probe.fileInFolder(t))
        c.add(
          `${path}.target`,
          'FILE_NOT_FOUND',
          'That file does not exist inside the walk’s folder.'
        )
      if (
        l.line !== undefined &&
        !(typeof l.line === 'number' && Number.isInteger(l.line) && l.line > 0)
      )
        c.add(`${path}.line`, 'BAD_VALUE', 'A line is a positive whole number.')
      break
    case 'url': {
      if (!isHttpUrl(t)) c.add(`${path}.target`, 'URL_NOT_HTTP', 'A URL link is http or https.')
      const ch = l.checked
      if (ch === undefined)
        c.add(`${path}.checked`, 'MISSING', 'A URL link says whether the agent checked it.')
      else if (!isObj(ch)) c.add(`${path}.checked`, 'BAD_VALUE', 'checked is { status, at }.')
      else {
        if (ch.status !== 'ok' && ch.status !== 'login' && ch.status !== 'unchecked')
          c.add(`${path}.checked.status`, 'BAD_VALUE', 'The status is ok, login or unchecked.')
        if (!str(ch.at) || Number.isNaN(Date.parse(ch.at as string)))
          c.add(`${path}.checked.at`, 'BAD_VALUE', 'at is a time.')
      }
      break
    }
    case 'folder':
      if (!str(t) || !probe.folderKnown(t))
        c.add(`${path}.target`, 'FOLDER_UNKNOWN', 'That folder is not one Harnu knows.')
      break
    default:
      c.add(`${path}.kind`, 'BAD_VALUE', 'A link is a pr, file, url or folder.')
  }
}

function validateImage(im: unknown, path: string, probe: WalkProbe, c: Collector): void {
  if (!isObj(im)) return c.add(path, 'NOT_AN_OBJECT', 'An image is an object.')
  if (!str(im.alt)) c.add(`${path}.alt`, 'MISSING', 'An image has an alt text.')
  if (im.kind !== 'expected' && im.kind !== 'capture')
    c.add(`${path}.kind`, 'BAD_VALUE', 'An image is expected or capture.')
  if (!str(im.src)) return c.add(`${path}.src`, 'MISSING', 'An image has a source path.')
  const fact = probe.image(im.src)
  if (!fact.ok) {
    const rule =
      fact.reason === 'outside-jail'
        ? 'IMAGE_OUTSIDE_JAIL'
        : fact.reason === 'not-image'
          ? 'IMAGE_NOT_AN_IMAGE'
          : 'IMAGE_MISSING'
    c.add(
      `${path}.src`,
      rule,
      'The image must be an existing image file inside the folder or the image cache.'
    )
  } else if (fact.bytes > LIMITS.imageBytes) {
    c.add(`${path}.src`, 'IMAGE_TOO_BIG', 'An image is at most 2 MB.')
  }
}

/** The machine's view of a script's checks: what it needs to serve them, and nothing else. */
export function toMachineChecks(script: WalkScript): MachineCheck[] {
  return script.checks.map((c) => ({
    id: c.id,
    hasAgentCheck: c.check !== undefined,
    blocks: c.blocks ?? [],
    ...(c.status ? { preClosed: { status: c.status } } : {})
  }))
}
