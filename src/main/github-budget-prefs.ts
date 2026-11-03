/**
 * T611 U1 — the GitHub budget prefs on disk (`<userData>/github-budget-prefs.json`).
 *
 * Same split as `pr-stack-prefs.ts`: the pure `defaultBudgetPrefs`/`normalizeBudgetPrefs` live in
 * `github-budget-core.ts` and are unit-tested; this is the thin disk shell. A corrupt file reads as
 * the defaults and can never stop the poller.
 */

import { app } from 'electron'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { defaultBudgetPrefs, normalizeBudgetPrefs, type BudgetPrefs } from './github-budget-core'

export type { BudgetPrefs }

function prefsPath(): string {
  return path.join(app.getPath('userData'), 'github-budget-prefs.json')
}

export async function readBudgetPrefs(): Promise<BudgetPrefs> {
  try {
    return normalizeBudgetPrefs(JSON.parse(await fs.readFile(prefsPath(), 'utf8')))
  } catch {
    return defaultBudgetPrefs()
  }
}

export async function writeBudgetPrefs(raw: unknown): Promise<BudgetPrefs> {
  const next = normalizeBudgetPrefs(raw)
  try {
    await fs.writeFile(prefsPath(), JSON.stringify(next, null, 2), 'utf8')
  } catch {
    /* disk full / read-only userData — the in-memory value still applies */
  }
  return next
}
