#!/usr/bin/env node
// `spec-derive.mjs <spec-path> --board <file>` — the derive planner `orchestrate-delivery`
// Phase 2 runs (T601 S-6).
//
// `<file>` is JSON, `[{ slug, status, title, body }]`, which the orchestrator writes from
// `list`-style board reads. Prints the plan `{ create, update, skip, refuse }` as JSON to stdout
// and writes nothing: the orchestrator executes it with `create_card` / `update_card`. Exit 0
// when `refuse` is empty, 1 when it is not, 2 on a usage error, an unreadable file or a board
// that is not a JSON array of cards.
//
// The block's `links: spec` path is the spec's path relative to its repo root (the cwd outside a
// repo), the same path cards write in `spec:`.
//
// Vendored in the skill directory and dependency-free (Node built-ins only), so it runs in any
// repo the skill is staged into.

import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { planDerive } from './spec-derive-core.mjs'

const USAGE = 'usage: node spec-derive.mjs <spec-path> --board <file>'

/** `argv` → `{ specPath, boardPath }`, or `{ error }` for a usage error. */
function parseArgs(args) {
  const paths = []
  let boardPath = null
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--board') {
      const value = args[i + 1]
      if (value == null || value.startsWith('-')) return { error: '--board needs a file' }
      boardPath = value
      i++
    } else if (a.startsWith('-')) return { error: `unknown option ${a}` }
    else paths.push(a)
  }
  if (paths.length !== 1) return { error: null }
  if (boardPath === null) return { error: '--board <file> is required' }
  return { specPath: paths[0], boardPath }
}

/** The spec's path relative to its repo root (the cwd outside a repo), as cards write `spec:`. */
function repoRelative(specPath) {
  const abs = resolve(specPath)
  let root = process.cwd()
  try {
    root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: dirname(abs),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    // Not a git repo: the spec is named relative to the cwd.
  }
  let real = abs
  try {
    real = realpathSync(abs)
  } catch {
    // Unreadable paths were refused before this point.
  }
  return relative(root, real).split(sep).join('/')
}

const isCard = (c) =>
  c !== null &&
  typeof c === 'object' &&
  typeof c.slug === 'string' &&
  typeof c.status === 'string' &&
  typeof c.body === 'string'

function main(argv) {
  const args = parseArgs(argv.slice(2))
  if (!args.specPath) {
    console.error(args.error ? `spec-derive: ${args.error}\n${USAGE}` : USAGE)
    return 2
  }
  let content
  try {
    content = readFileSync(args.specPath, 'utf8')
  } catch (err) {
    console.error(`spec-derive: cannot read ${args.specPath}: ${err.code ?? err.message}`)
    return 2
  }
  let board
  try {
    board = JSON.parse(readFileSync(args.boardPath, 'utf8'))
  } catch (err) {
    console.error(`spec-derive: cannot read board ${args.boardPath}: ${err.code ?? err.message}`)
    return 2
  }
  if (!Array.isArray(board) || !board.every(isCard)) {
    console.error(
      `spec-derive: ${args.boardPath} is not a JSON array of { slug, status, title, body } cards`
    )
    return 2
  }

  const plan = planDerive(content, repoRelative(args.specPath), board)
  console.log(JSON.stringify(plan, null, 2))
  console.error(
    `spec-derive: ${plan.create.length} create, ${plan.update.length} update, ${plan.skip.length} skip, ${plan.refuse.length} refusal(s)`
  )
  return plan.refuse.length > 0 ? 1 : 0
}

process.exitCode = main(process.argv)
