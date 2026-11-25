/**
 * Where the bake-off harness reads and writes, and the containment rule (D-2):
 * the holdout clone, the cache and the work root must resolve outside both repo
 * roots, so no holdout file and no unit work can land in this public repository.
 *
 * A failure is a coded error, `{ code, message }`, returned and never thrown. A
 * message names the variable but not its path: the holdout path is not handed out.
 */
import { execFileSync } from 'node:child_process'
import { lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const MODULE_DIR = dirname(fileURLToPath(import.meta.url))
const MAX_LINK_DEPTH = 40

function gitOutput(args) {
  const env = { ...process.env }
  // Set inside a git hook; they would point `git` at another repository.
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[k]
  return execFileSync('nice', ['-n', '19', 'git', ...args], {
    cwd: MODULE_DIR,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  }).trim()
}

/**
 * The realpath of a path that may not exist yet: the cache is created on first
 * use. A dangling symlink is followed, so one pointing into the repo cannot pass
 * as an outside path. Returns null when it cannot be resolved (a link loop).
 */
function resolveReal(path, depth = 0) {
  if (depth > MAX_LINK_DEPTH) return null
  try {
    return realpathSync(path)
  } catch {
    /* missing, or a dangling link: resolved by hand below */
  }
  const parent = dirname(path)
  if (parent === path) return path
  const realParent = resolveReal(parent, depth + 1)
  if (realParent === null) return null
  let isLink = false
  try {
    isLink = lstatSync(path).isSymbolicLink()
  } catch {
    /* the path does not exist */
  }
  if (!isLink) return join(realParent, basename(path))
  return resolveReal(resolve(realParent, readlinkSync(path)), depth + 1)
}

/** True when `path` equals `root` or lies under it. An unresolvable path counts as inside. */
function isWithin(path, root) {
  return path === null || path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)
}

const coded = (code, message) => ({ code, message })

/**
 * Resolve the roots of a round.
 *
 * @param {{ split: 'dev' | 'holdout', env?: Record<string, string | undefined> }} options
 * @returns {{ repo: string, mainCheckout: string, cache: string, work: string, holdout: string | null }
 *   | { code: string, message: string }}
 */
export function resolveRoots({ split, env = process.env }) {
  const set = (name) => (env[name] ? env[name] : null)

  let repo
  let mainCheckout
  try {
    repo = realpathSync(gitOutput(['rev-parse', '--show-toplevel']))
    mainCheckout = dirname(
      realpathSync(gitOutput(['rev-parse', '--path-format=absolute', '--git-common-dir']))
    )
  } catch {
    return coded(
      'REPO_UNRESOLVED',
      'The harness is not inside a git repository, so containment cannot be checked.'
    )
  }
  const repoRoots = [repo, mainCheckout]
  const insideRepo = (path) => repoRoots.some((root) => isWithin(path, root))

  if (split === 'holdout' && !set('HARNU_BAKEOFF_HOLDOUT')) {
    return coded('HOLDOUT_UNSET', 'A holdout split needs HARNU_BAKEOFF_HOLDOUT.')
  }

  const cacheHome = set('XDG_CACHE_HOME') ?? join(set('HOME') ?? homedir(), '.cache')
  const holdout = set('HARNU_BAKEOFF_HOLDOUT')
    ? resolveReal(resolve(env.HARNU_BAKEOFF_HOLDOUT))
    : undefined
  const cache = resolveReal(
    resolve(set('HARNU_BAKEOFF_CACHE') ?? join(cacheHome, 'harnu-bakeoff/cache'))
  )
  const work = resolveReal(
    resolve(set('HARNU_BAKEOFF_WORK') ?? join(cacheHome, 'harnu-bakeoff/work'))
  )

  if (holdout !== undefined && insideRepo(holdout)) {
    return coded('HOLDOUT_INSIDE_REPO', 'HARNU_BAKEOFF_HOLDOUT resolves inside the repository.')
  }
  if (insideRepo(cache)) {
    return coded('CACHE_INSIDE_REPO', 'HARNU_BAKEOFF_CACHE resolves inside the repository.')
  }
  if (insideRepo(work) || isWithin(work, cache) || (holdout && isWithin(work, holdout))) {
    return coded(
      'WORK_NOT_CONTAINED',
      'HARNU_BAKEOFF_WORK must resolve outside the repository, the cache root and the holdout clone.'
    )
  }

  return { repo, mainCheckout, cache, work, holdout: holdout ?? null }
}

/** Root of one round's unit work: the cache on dev, the work root on holdout. */
export function unitsRoot(roots, split, roundId) {
  return join(split === 'holdout' ? roots.work : roots.cache, 'rounds', roundId, 'units')
}

/** Root of the cached validation results of a split. */
export function validationRoot(roots, split) {
  return join(split === 'holdout' ? roots.work : roots.cache, 'validation')
}

/** Root of the author sandboxes of a split. */
export function authoringRoot(roots, split) {
  return split === 'holdout'
    ? join(roots.holdout, '.rounds', 'authoring')
    : join(roots.cache, 'authoring')
}

/** A round's directory in the main checkout: `round.json` and the reports (gitignored). */
export function repoRoundDir(roots, roundId) {
  return join(roots.mainCheckout, '.harnu', 'eval', 'bakeoff', roundId)
}

/** A holdout round's private directory, inside the holdout clone. */
export function privateRoundDir(roots, roundId) {
  return join(roots.holdout, '.rounds', roundId)
}
