/**
 * A round's token budget: "Budget" and "Usage" in
 * `docs/specs/2026-11-07-bakeoff-harness/spec.md`.
 *
 * Only the locations the harness itself writes are read. A session's clone can hold a file
 * named `discarded.json` too, and what a contestant writes must never move the cap.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROUND_DIR = '_round'
const STEP_DIR = /^(contestant|build|judge-\d+)$/
const JUDGE_FILE = /^judge-\d+\.json$/

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function directoriesIn(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

const totalOf = (usage) => usage?.total ?? 0

function discardedTotal(path) {
  const entries = readJson(path)
  return Array.isArray(entries) ? entries.reduce((sum, e) => sum + totalOf(e.usage), 0) : 0
}

/** One `units/<problem>/<contestant>/r<k>/` directory: its finished units and discarded attempts. */
function spentInUnit(unitDir) {
  const contestant = readJson(join(unitDir, 'contestant.json'))
  const build = readJson(join(unitDir, 'build.json'))
  let spent = totalOf(contestant?.usage?.contestant) + totalOf(contestant?.usage?.operator)
  spent += totalOf(build?.usage)
  for (const name of readdirSync(unitDir)) {
    if (JUDGE_FILE.test(name)) spent += totalOf(readJson(join(unitDir, name))?.usage)
  }
  for (const step of directoriesIn(unitDir)) {
    if (STEP_DIR.test(step)) spent += discardedTotal(join(unitDir, step, 'discarded.json'))
  }
  return spent
}

/**
 * Every finished unit's usage plus every entry of every `discarded.json` under the units root.
 *
 * @param {string} unitsRoot
 * @returns {number}
 */
export function spentTokens(unitsRoot) {
  let spent = discardedTotal(join(unitsRoot, ROUND_DIR, 'discarded.json'))
  for (const problem of directoriesIn(unitsRoot)) {
    if (problem === ROUND_DIR) continue
    for (const contestant of directoriesIn(join(unitsRoot, problem))) {
      for (const repeat of directoriesIn(join(unitsRoot, problem, contestant))) {
        spent += spentInUnit(join(unitsRoot, problem, contestant, repeat))
      }
    }
  }
  return spent
}

/**
 * @param {number} spent
 * @param {number} cap
 * @returns {boolean} whether another unit may start
 */
export const canStart = (spent, cap) => spent < cap
