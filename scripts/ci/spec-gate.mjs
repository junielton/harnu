#!/usr/bin/env node
// CLI for the spec gate (T600). Mirrors the other contract gates in shape, but it checks
// the working tree rather than a diff: every `docs/specs/<dir>/spec.md` whose header says
// `status: approved` is linted by the pure predicate in spec-gate-core.mjs; drafts and the
// specs that predate the header are skipped. Exits non-zero with an actionable message.
//
// Env:
//   GATE_TRACKED_FILES  newline/comma-separated tracked-file list; bypasses `git ls-files`
//                       (tests and local dry runs).

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { specGateVerdict } from './spec-gate-core.mjs'

const SPECS_DIR = 'docs/specs'

function splitList(raw) {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function trackedFiles() {
  const override = process.env.GATE_TRACKED_FILES
  if (override != null) return splitList(override)
  return splitList(execFileSync('git', ['ls-files'], { encoding: 'utf8', maxBuffer: 64 << 20 }))
}

function specFiles() {
  if (!existsSync(SPECS_DIR)) return []
  return readdirSync(SPECS_DIR)
    .map((name) => join(SPECS_DIR, name))
    .filter((dir) => statSync(dir).isDirectory())
    .map((dir) => join(dir, 'spec.md'))
    .filter((file) => existsSync(file))
    .sort()
}

function main() {
  const specs = specFiles().map((path) => ({ path, content: readFileSync(path, 'utf8') }))
  const verdict = specGateVerdict({ specs, trackedFiles: trackedFiles() })
  if (verdict.ok) {
    console.log(`✓ spec gate: ${verdict.reason}`)
    return
  }
  console.error(`✗ spec gate failed\n${verdict.reason}`)
  process.exitCode = 1
}

main()
