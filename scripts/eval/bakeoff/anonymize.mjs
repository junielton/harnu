/**
 * What a judge may see of an artifact, and the label it knows it by: "Judging" in
 * `docs/specs/2026-11-07-bakeoff-harness/spec.md`.
 *
 * Blinding stops at the text. A bundle can still be recognized by its structure, which the
 * report names as a confound.
 */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, readlinkSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const LABELS = ['P', 'Q', 'R']
const REPLACEMENT = '[tool]'

/** Every file of the artifact, sorted by its real path; a symlink is a file, never followed. */
function artifactFiles(dir) {
  let entries
  try {
    entries = readdirSync(dir, { recursive: true, withFileTypes: true })
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }
  return entries
    .filter((e) => e.isFile() || e.isSymbolicLink())
    .map((e) => ({
      path: relative(dir, join(e.parentPath, e.name)).split(sep).join('/'),
      abs: join(e.parentPath, e.name),
      link: e.isSymbolicLink()
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/** Drops a first line `---` through the next `---`; an unclosed block is ordinary text. */
function stripFrontMatter(text) {
  const lines = text.replace(/^\uFEFF/, '').split('\n')
  const isFence = (line) => line.replace(/\r$/, '') === '---'
  if (!isFence(lines[0])) return text
  const close = lines.findIndex((line, i) => i > 0 && isFence(line))
  return close === -1 ? text : lines.slice(close + 1).join('\n')
}

/** Longest first, so `harnu:spec` is one replacement rather than `[tool]:spec`. */
function tellReplacer(tells) {
  if (tells.length === 0) return (text) => text
  const alternatives = [...tells]
    .sort((a, b) => b.length - a.length)
    .map((tell) => tell.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')
  const pattern = new RegExp(`(?<![A-Za-z0-9_])(?:${alternatives})(?![A-Za-z0-9_])`, 'gi')
  return (text) => text.replace(pattern, REPLACEMENT)
}

/**
 * The artifact as one text, with the front matter stripped and the tells replaced.
 *
 * @param {string} artifactDir
 * @param {string[]} tells of the round's selected contestants only
 * @returns {string} the bundle, `''` for an artifact with no file
 */
export function buildBundle(artifactDir, tells) {
  const blind = tellReplacer(tells)
  return artifactFiles(artifactDir)
    .map(({ path, abs, link }) => {
      const body = blind(link ? readlinkSync(abs) : stripFrontMatter(readFileSync(abs, 'utf8')))
      const ended = body === '' || body.endsWith('\n') ? body : `${body}\n`
      return `=== file: ${blind(path)} ===\n${ended}`
    })
    .join('\n')
}

function mulberry32(seed) {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * The labels of one (problem, repeat): a Fisher-Yates shuffle of the sorted ids.
 *
 * @param {string} seed
 * @param {string} problemId
 * @param {number} repeat
 * @param {string[]} contestantIds
 * @returns {Record<string, string>} `{ P: <contestant id>, Q: …, R: … }`
 */
export function assignLabels(seed, problemId, repeat, contestantIds) {
  const digest = createHash('sha256').update(`${seed}/${problemId}/r${repeat}`).digest()
  const rand = mulberry32(digest.readUInt32BE(0))
  const ids = [...contestantIds].sort()
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[ids[i], ids[j]] = [ids[j], ids[i]]
  }
  return Object.fromEntries(ids.map((id, i) => [LABELS[i], id]))
}
