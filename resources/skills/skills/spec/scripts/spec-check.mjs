#!/usr/bin/env node
// `spec-check.mjs <spec-path>` — the CLI behind `/harnu:spec check` (T601 S-1).
//
// Lints a spec as if it were approved: the gate's rules, then the capability-order check
// (`missing-producer`, `producer-not-before`), then the atom-coverage check (`no-atoms`,
// `uncovered-atom`). Every finding goes to stdout as `path:line [rule] message`; nothing
// short-circuits. Exit 0 clean, 1 on any finding, 2 on a usage error or an unreadable file.
//
// Vendored in the skill directory and dependency-free (Node built-ins only), so it runs in any
// repo the skill is staged into.
//
// Env:
//   GATE_TRACKED_FILES  newline/comma-separated tracked-file list; bypasses `git ls-files`
//                       (tests and local dry runs). Used for the header `prd`/`adr`/`mockup` paths.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { checkSpecFile } from './spec-check-core.mjs'
import { parseHeader, PATH_FIELDS } from './spec-gate-core.mjs'

const USAGE = 'usage: node spec-check.mjs <spec-path>'

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

function main(argv) {
  const args = argv.slice(2)
  const unknown = args.find((a) => a.startsWith('-'))
  const paths = args.filter((a) => !a.startsWith('-'))
  if (unknown || paths.length !== 1) {
    console.error(unknown ? `spec-check: unknown option ${unknown}\n${USAGE}` : USAGE)
    return 2
  }
  const specPath = paths[0]
  let content
  try {
    content = readFileSync(specPath, 'utf8')
  } catch (err) {
    console.error(`spec-check: cannot read ${specPath}: ${err.code ?? err.message}`)
    return 2
  }

  const findings = checkSpecFile(content, specPath, trackedFiles(specPath, content))
  for (const f of findings) console.log(`${specPath}:${f.line} [${f.rule}] ${f.message}`)
  if (findings.length === 0) {
    console.error(`spec-check: ${specPath} is clean`)
    return 0
  }
  console.error(`spec-check: ${findings.length} finding(s) in ${specPath}`)
  return 1
}

process.exitCode = main(process.argv)
