/**
 * A round's tokens by phase and by contestant: the budget section of the report. "The report" and
 * "Usage" in `docs/specs/2026-11-07-bakeoff-harness/spec.md` are the contract.
 *
 * It reads exactly the locations `budget.mjs` reads, so the two add up to the same `spent`: a
 * session's clone can hold a file named `discarded.json` too, and that must never count.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROUND_DIR = '_round'
const STEP_DIR = /^(contestant|build|judge-\d+)$/
const JUDGE_FILE = /^judge-\d+\.json$/
const UNATTRIBUTED = 'unattributed'

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
      .sort()
  } catch {
    return []
  }
}

const totalOf = (usage) => usage?.total ?? 0

function discardedTotal(path) {
  const entries = readJson(path)
  return Array.isArray(entries) ? entries.reduce((sum, e) => sum + totalOf(e.usage), 0) : 0
}

/**
 * @param {string} unitsRoot
 * @returns {{ byPhase: Record<string, number>, byContestant: Record<string, number> }}
 */
export function rollup(unitsRoot) {
  const byPhase = { contestant: 0, operator: 0, judge: 0, build: 0, discarded: 0 }
  const byContestant = {}
  const add = (phase, contestant, tokens) => {
    byPhase[phase] += tokens
    byContestant[contestant] = (byContestant[contestant] ?? 0) + tokens
  }

  const addRun = (unitDir, contestant) => {
    const run = readJson(join(unitDir, 'contestant.json'))
    add('contestant', contestant, totalOf(run?.usage?.contestant))
    add('operator', contestant, totalOf(run?.usage?.operator))
    add('build', contestant, totalOf(readJson(join(unitDir, 'build.json'))?.usage))
    for (const name of readdirSync(unitDir).sort()) {
      if (JUDGE_FILE.test(name)) {
        add('judge', contestant, totalOf(readJson(join(unitDir, name))?.usage))
      }
    }
    for (const step of directoriesIn(unitDir)) {
      if (STEP_DIR.test(step)) {
        add('discarded', contestant, discardedTotal(join(unitDir, step, 'discarded.json')))
      }
    }
  }

  for (const problem of directoriesIn(unitsRoot)) {
    if (problem === ROUND_DIR) continue
    for (const contestant of directoriesIn(join(unitsRoot, problem))) {
      for (const repeat of directoriesIn(join(unitsRoot, problem, contestant))) {
        addRun(join(unitsRoot, problem, contestant, repeat), contestant)
      }
    }
  }
  // Model probes belong to no unit and no contestant.
  add('discarded', UNATTRIBUTED, discardedTotal(join(unitsRoot, ROUND_DIR, 'discarded.json')))

  const named = Object.keys(byContestant)
    .filter((id) => id !== UNATTRIBUTED)
    .sort()
  return {
    byPhase,
    byContestant: Object.fromEntries([...named, UNATTRIBUTED].map((id) => [id, byContestant[id]]))
  }
}
