/**
 * Loads a bake-off corpus root and validates every problem directory in it.
 *
 * Only the harness process reads a problem directory: the hidden files in here
 * never reach a contestant. Every defect is reported, one `{ code, message, file,
 * field }` each (`file` relative to the corpus root), so an author fixes them in
 * one pass. See "A corpus problem" and "Loader error codes" in
 * `docs/specs/2026-11-07-bakeoff-harness/spec.md`.
 */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, readlinkSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

const ID_RE = /^[a-z0-9-]+$/
const ATOM_ID_RE = /^[A-Z]+-\d+$/
const SEPARATOR_RE = /^:?-+:?$/
const COMMIT_RE = /^[0-9a-f]{40}$/i
const KINDS = new Set(['bug', 'feature', 'refactor', 'ui', 'greenfield'])

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const isText = (v) => typeof v === 'string' && v.trim() !== ''

function statOf(path) {
  try {
    return statSync(path)
  } catch {
    return null
  }
}

const isFile = (path) => statOf(path)?.isFile() ?? false
const isDirectory = (path) => statOf(path)?.isDirectory() ?? false

const cellsOf = (line) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim())

/** The first-column cells of every markdown table whose first column is `id`. */
function atomCells(markdown) {
  const cells = []
  let inIdTable = false
  for (const line of markdown.split('\n')) {
    if (!line.trim().startsWith('|')) {
      inIdTable = false
      continue
    }
    const first = cellsOf(line)[0]
    if (first === 'id') inIdTable = true
    else if (inIdTable && !SEPARATOR_RE.test(first)) cells.push(first)
  }
  return cells
}

function compiles(pattern) {
  try {
    new RegExp(pattern)
    return true
  } catch {
    return false
  }
}

/** The defects of `problem.json`'s fields, as `[code, field, message]` tuples. */
function fieldDefects(p, dirName, { split, forRun }) {
  const out = []
  if (p.id !== dirName || !ID_RE.test(dirName)) {
    out.push(['ID_MISMATCH', 'id', 'id must equal its directory name and match [a-z0-9-]+'])
  }
  if (p.split !== split)
    out.push(['SPLIT_MISMATCH', 'split', `split must be ${split}, its root's split`])
  if (!KINDS.has(p.kind))
    out.push(['KIND_INVALID', 'kind', `kind must be one of ${[...KINDS].join(', ')}`])

  const missing = (field) => out.push(['FIELD_MISSING', field, `${field} is required`])
  if (!isText(p.language)) missing('language')
  if (!Array.isArray(p.setup)) missing('setup')
  if (!isText(p.versions)) missing('versions')
  if (!isText(p.test)) missing('test')

  if (!isObject(p.target)) {
    missing('target')
  } else if (!('inline' in p.target)) {
    if (!isText(p.target.repo)) missing('target.repo')
    if (!COMMIT_RE.test(p.target.commit ?? '')) {
      out.push(['COMMIT_INVALID', 'target.commit', 'target.commit must be 40 hex characters'])
    }
  }

  const hidden = isObject(p.hidden) ? p.hidden : {}
  if (!Array.isArray(hidden.files) || hidden.files.length === 0) missing('hidden.files')
  if (!isText(hidden.dest)) missing('hidden.dest')
  if (!isText(hidden.cmd)) missing('hidden.cmd')
  if (!isText(hidden.compileErrorPattern) || !compiles(hidden.compileErrorPattern)) {
    missing('hidden.compileErrorPattern')
  }

  const provenance = isObject(p.provenance) ? p.provenance : {}
  if (split === 'holdout' && provenance.sandbox !== true) {
    out.push([
      'NOT_SANDBOXED',
      'provenance.sandbox',
      'a holdout problem must be authored in the sandbox'
    ])
  }
  if (forRun && provenance.reviewedAt == null) {
    out.push(['NOT_REVIEWED', 'provenance.reviewedAt', 'a problem must be reviewed before a run'])
  }
  return out
}

/** The file-level defects of one problem directory, as `[code, relative file, field, message]`. */
function fileDefects(dir, parsed) {
  const out = []
  const requireFile = (rel, field = null) => {
    if (!isFile(join(dir, rel))) out.push(['FILE_MISSING', rel, field, `${rel} is missing`])
  }
  requireFile('pick.md')
  requireFile('request.md')
  requireFile('answer-sheet.md')
  requireFile('hidden/reference.patch')

  const atomsPath = join(dir, 'hidden/atoms.md')
  if (!isFile(atomsPath)) {
    out.push(['FILE_MISSING', 'hidden/atoms.md', null, 'hidden/atoms.md is missing'])
  } else {
    const cells = atomCells(readFileSync(atomsPath, 'utf8'))
    const malformed = cells.filter((cell) => !ATOM_ID_RE.test(cell))
    if (cells.length === 0) {
      out.push(['ATOMS_EMPTY', 'hidden/atoms.md', null, 'hidden/atoms.md has no atom id'])
    } else if (malformed.length > 0) {
      const message = `hidden/atoms.md has ids that do not match ${ATOM_ID_RE.source}: ${malformed.join(', ')}`
      out.push(['ATOMS_EMPTY', 'hidden/atoms.md', null, message])
    }
  }

  if (parsed) {
    const hiddenDir = join(dir, 'hidden')
    for (const f of Array.isArray(parsed.hidden?.files) ? parsed.hidden.files : []) {
      const rel = `hidden/${f}`
      const contained = typeof f === 'string' && resolve(hiddenDir, f).startsWith(hiddenDir + sep)
      if (!contained || !isFile(join(hiddenDir, f))) {
        out.push(['FILE_MISSING', rel, 'hidden.files', `${rel} is missing or outside hidden/`])
      }
    }
    const inline = parsed.target?.inline
    if (inline !== undefined) {
      const contained = typeof inline === 'string' && resolve(dir, inline).startsWith(dir + sep)
      if (!contained || !isDirectory(join(dir, inline))) {
        out.push([
          'FILE_MISSING',
          String(inline),
          'target.inline',
          `${inline} is not a source directory`
        ])
      }
    }
  }
  return out
}

function loadProblem(root, dirName, options) {
  const dir = resolve(root, dirName)
  const jsonRel = join(dirName, 'problem.json')
  const jsonPath = join(dir, 'problem.json')
  const errors = []
  const add = (code, file, field, message) =>
    errors.push({ code, message: `${dirName}: ${message}`, file, field })

  let parsed = null
  if (!isFile(jsonPath)) {
    add('FILE_MISSING', jsonRel, null, 'problem.json is missing')
  } else {
    try {
      const value = JSON.parse(readFileSync(jsonPath, 'utf8'))
      if (!isObject(value)) throw new Error('not an object')
      parsed = value
    } catch {
      add('JSON_INVALID', jsonRel, null, 'problem.json is not a JSON object')
    }
  }

  if (parsed) {
    for (const [code, field, message] of fieldDefects(parsed, dirName, options)) {
      add(code, jsonRel, field, message)
    }
  }
  for (const [code, rel, field, message] of fileDefects(dir, parsed)) {
    add(code, join(dirName, rel), field, message)
  }

  return { problem: errors.length === 0 ? { ...parsed, dir } : null, errors }
}

/**
 * Read every problem directory of a corpus root. Dot-directories (`.git`, the
 * holdout clone's `.rounds`) and plain files are not problems.
 *
 * @param {string} root
 * @param {{ split: 'dev' | 'holdout', forRun?: boolean }} options `forRun` also refuses an unreviewed problem
 * @returns {{ problems: object[], errors: { code: string, message: string, file: string, field: string | null }[] }}
 */
export function loadCorpus(root, { split, forRun = false }) {
  let names
  try {
    names = readdirSync(root)
  } catch {
    return {
      problems: [],
      errors: [
        {
          code: 'FILE_MISSING',
          message: 'The corpus root does not exist.',
          file: root,
          field: null
        }
      ]
    }
  }

  const problems = []
  const errors = []
  for (const name of names.sort()) {
    if (name.startsWith('.') || !isDirectory(join(root, name))) continue
    const loaded = loadProblem(root, name, { split, forRun })
    if (loaded.problem) problems.push(loaded.problem)
    errors.push(...loaded.errors)
  }
  return { problems, errors }
}

/** Every file under `dir`, as sorted POSIX-style relative paths. */
function listFiles(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = join(dir, entry.name)
      return entry.isDirectory()
        ? listFiles(full, base)
        : [relative(base, full).split(sep).join('/')]
    })
    .sort()
}

/** The bytes a file contributes to the hash; `problem.json` leaves its provenance out. */
function hashedBytes(problemDir, rel) {
  const full = join(problemDir, rel)
  const stat = statOf(full)
  if (stat === null || stat.isDirectory()) return readlinkSync(full)
  const bytes = readFileSync(full)
  if (rel !== 'problem.json') return bytes
  try {
    const parsed = JSON.parse(bytes.toString('utf8'))
    delete parsed.provenance
    return JSON.stringify(parsed)
  } catch {
    return bytes
  }
}

/**
 * A problem's content hash, as Validation defines it: `review` writes only
 * `provenance`, so it invalidates neither the validation key nor `compare`.
 *
 * @param {string} problemDir
 * @returns {string} hex sha256
 */
export function contentHash(problemDir) {
  const hash = createHash('sha256')
  for (const rel of listFiles(problemDir)) {
    // NUL-separated, so a name's end and its bytes' start cannot be confused.
    hash.update(rel).update('\0').update(hashedBytes(problemDir, rel)).update('\0')
  }
  return hash.digest('hex')
}
