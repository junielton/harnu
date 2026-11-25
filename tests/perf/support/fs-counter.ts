/**
 * Counts filesystem calls made while a job runs (performance contract P4: "counts fs calls and wall
 * time per job"). Unlike a timing, a call count is exact: the same job over the same fixture makes
 * the same number of calls on any machine, so a probe of every slug for every session is caught as
 * the quadratic it is, with no noise.
 *
 * It patches the methods on the `fs` and `fs.promises` objects (what source modules call through at
 * run time) and restores them on `stop()`.
 */

import fs from 'node:fs'

const PROMISE_METHODS = [
  'access',
  'stat',
  'lstat',
  'readdir',
  'readFile',
  'open',
  'opendir',
  'readlink',
  'realpath'
]
const SYNC_METHODS = [
  'accessSync',
  'statSync',
  'lstatSync',
  'readdirSync',
  'readFileSync',
  'openSync',
  'existsSync',
  'readlinkSync',
  'realpathSync'
]

export function startFsCounter(): { stop(): number } {
  let count = 0
  const restore: Array<() => void> = []
  const patch = (target: Record<string, unknown>, names: string[]): void => {
    for (const name of names) {
      const original = target[name]
      if (typeof original !== 'function') continue
      target[name] = function (this: unknown, ...args: unknown[]) {
        count++
        return (original as (...a: unknown[]) => unknown).apply(this, args)
      }
      restore.push(() => {
        target[name] = original
      })
    }
  }
  patch(fs.promises as unknown as Record<string, unknown>, PROMISE_METHODS)
  patch(fs as unknown as Record<string, unknown>, SYNC_METHODS)
  return {
    stop() {
      for (const r of restore.reverse()) r()
      return count
    }
  }
}
