#!/usr/bin/env node
// `spec-check.mjs <spec-path> [--cards [--cards-dir <dir>]]` — the CLI behind
// `/harnu:spec check` (T601 S-1, S-2).
//
// Lints a spec as if it were approved: the gate's rules, then the capability-order check
// (`missing-producer`, `producer-not-before`), then the atom-coverage check (`no-atoms`,
// `uncovered-atom`). With `--cards` it also reads the board cards whose `spec:` names the spec
// and reports card-versus-spec drift per AC line (`hash-diverged`, `unknown-ac`, `missing-ac`);
// card-only (unhashed) ACs are printed as `path:line info: message` and are not findings. When a
// `critics.md` sits beside the spec it lints the Goldfish review record too (`undisposed-finding`,
// `weak-contest`, `reviewer-not-run`); a free-form critics.md is noted on stderr, not linted. The
// cards are read from `--cards-dir`, default `.harnu/memory/roadmap` of the repo's main checkout
// (resolved with `git rev-parse --path-format=absolute --git-common-dir`). Every finding goes to
// stdout as `path:line [rule] message`; nothing short-circuits. Exit 0 clean, 1 on any finding,
// 2 on a usage error or an unreadable file or cards directory.
//
// Vendored in the skill directory and dependency-free (Node built-ins only), so it runs in any
// repo the skill is staged into.
//
// Env:
//   GATE_TRACKED_FILES  newline/comma-separated tracked-file list; bypasses `git ls-files`
//                       (tests and local dry runs). Used for the header `prd`/`adr`/`mockup` paths.

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import {
  checkCards,
  checkCritics,
  checkSpecFile,
  parseCritics,
  parseSpec
} from './spec-check-core.mjs'
import { parseHeader, PATH_FIELDS } from './spec-gate-core.mjs'

const USAGE = 'usage: node spec-check.mjs <spec-path> [--cards [--cards-dir <dir>]]'

function splitList(raw) {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * The tracked files the header path rules check against: the override, else `git ls-files` from
 * the spec's repo, else (not a git repo) the header paths that exist on disk under the cwd.
 */
function trackedFiles(specPath, content) {
  const override = process.env.GATE_TRACKED_FILES
  if (override != null) return splitList(override)
  try {
    const cwd = dirname(resolve(specPath))
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
    return splitList(
      execFileSync('git', ['ls-files'], {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 64 << 20,
        stdio: ['ignore', 'pipe', 'ignore']
      })
    )
  } catch {
    const { header } = parseHeader(content)
    return PATH_FIELDS.map((f) => header?.[f]).filter(
      (p) => p && existsSync(join(process.cwd(), p))
    )
  }
}

const git = (cwd, args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

/** `argv` → `{ specPath, cards, cardsDir }`, or `{ error }` for a usage error. */
function parseArgs(args) {
  const paths = []
  let cards = false
  let cardsDir = null
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--cards') cards = true
    else if (a === '--cards-dir') {
      const value = args[i + 1]
      if (value == null || value.startsWith('-')) return { error: '--cards-dir needs a directory' }
      cardsDir = value
      i++
    } else if (a.startsWith('-')) return { error: `unknown option ${a}` }
    else paths.push(a)
  }
  if (cardsDir !== null && !cards) return { error: '--cards-dir needs --cards' }
  if (paths.length !== 1) return { error: null }
  return { specPath: paths[0], cards, cardsDir }
}

/** The spec's path relative to its repo root (the cwd outside a repo), as cards write `spec:`. */
function repoRelative(specPath) {
  const abs = resolve(specPath)
  let root = process.cwd()
  try {
    root = git(dirname(abs), ['rev-parse', '--show-toplevel'])
  } catch {
    // Not a git repo: cards are expected to name the spec relative to the cwd.
  }
  let real = abs
  try {
    real = realpathSync(abs)
  } catch {
    // Unreadable paths were refused before this point.
  }
  return relative(root, real).split(sep).join('/')
}

/** `.harnu/memory/roadmap` of the main checkout that owns the spec's repo (or worktree). */
function defaultCardsDir(specPath) {
  const common = git(dirname(resolve(specPath)), [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir'
  ])
  return join(dirname(common), '.harnu', 'memory', 'roadmap')
}

/** Every `*.md` card in `dir`, sorted by file name; throws when the directory is unreadable. */
function readCards(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => e.name)
    .sort()
    .map((name) => {
      const path = join(dir, name)
      return { path, slug: basename(name, '.md'), content: readFileSync(path, 'utf8') }
    })
}

function main(argv) {
  const parsedArgs = parseArgs(argv.slice(2))
  if (!parsedArgs.specPath) {
    console.error(parsedArgs.error ? `spec-check: ${parsedArgs.error}\n${USAGE}` : USAGE)
    return 2
  }
  const { specPath } = parsedArgs
  let content
  try {
    content = readFileSync(specPath, 'utf8')
  } catch (err) {
    console.error(`spec-check: cannot read ${specPath}: ${err.code ?? err.message}`)
    return 2
  }

  let cards = null
  if (parsedArgs.cards) {
    let dir = parsedArgs.cardsDir
    if (dir === null) {
      try {
        dir = defaultCardsDir(specPath)
      } catch {
        console.error(
          `spec-check: cannot find the main checkout of ${specPath} (not a git repo); pass --cards-dir <dir>`
        )
        return 2
      }
    }
    try {
      cards = { dir, list: readCards(dir) }
    } catch (err) {
      console.error(`spec-check: cannot read cards directory ${dir}: ${err.code ?? err.message}`)
      return 2
    }
  }

  const findings = checkSpecFile(content, specPath, trackedFiles(specPath, content))
  for (const f of findings) console.log(`${specPath}:${f.line} [${f.rule}] ${f.message}`)

  let criticFindings = 0
  const criticsPath = join(dirname(specPath), 'critics.md')
  if (existsSync(criticsPath)) {
    let criticsText
    try {
      criticsText = readFileSync(criticsPath, 'utf8')
    } catch (err) {
      console.error(`spec-check: cannot read ${criticsPath}: ${err.code ?? err.message}`)
      return 2
    }
    const critics = parseCritics(criticsText)
    if (!critics.structured) {
      console.error(
        `spec-check: ${criticsPath} has no \`## Reviewers\` or \`## Findings\` table; a free-form record is not linted`
      )
    } else {
      const found = checkCritics(critics, parseSpec(content))
      for (const f of found) console.log(`${criticsPath}:${f.line} [${f.rule}] ${f.message}`)
      criticFindings = found.length
    }
  }

  let cardFindings = 0
  if (cards) {
    const drift = checkCards(parseSpec(content), repoRelative(specPath), cards.list)
    const lines = [
      ...drift.findings.map((f) => ({
        ...f,
        text: `${f.path}:${f.line} [${f.rule}] ${f.message}`
      })),
      ...drift.info.map((f) => ({ ...f, text: `${f.path}:${f.line} info: ${f.message}` }))
    ].sort((a, b) => (a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1))
    for (const l of lines) console.log(l.text)
    cardFindings = drift.findings.length
    console.error(
      `spec-check: ${drift.matched.length} card(s) in ${cards.dir} name ${specPath}; ${drift.info.length} card-only AC line(s) listed for information`
    )
  }

  const total = findings.length + criticFindings + cardFindings
  if (total === 0) {
    console.error(`spec-check: ${specPath} is clean`)
    return 0
  }
  console.error(`spec-check: ${total} finding(s) in ${specPath}`)
  return 1
}

process.exitCode = main(process.argv)
