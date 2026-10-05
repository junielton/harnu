#!/usr/bin/env node
// CLI for the CHANGELOG contract gate (T65 AC1). Resolves the PR's changed files
// (from git against the merge base, or a GATE_CHANGED_FILES override for local
// runs / tests) and its labels, runs the pure predicate, and exits non-zero with
// an actionable message when the gate fails. Plain node — no third-party action.
//
// Env:
//   CHANGELOG_GATE_BASE   git ref to diff against (default: origin/main). CI sets
//                         it to the PR base sha.
//   GATE_CHANGED_FILES    newline/comma-separated file list; bypasses git (local).
//   GATE_PR_LABELS        PR labels — a JSON array (from toJSON(...)) or a
//                         comma/newline list.

import { execFileSync } from 'node:child_process'
import { changelogGateVerdict } from './changelog-gate-core.mjs'

function splitList(raw) {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function changedFilesFromGit(base) {
  const out = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], { encoding: 'utf8' })
  return splitList(out)
}

function parseLabels(raw) {
  if (!raw) return []
  const trimmed = raw.trim()
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed)
      return Array.isArray(arr) ? arr.map(String) : []
    } catch {
      return []
    }
  }
  return splitList(trimmed)
}

function main() {
  const override = process.env.GATE_CHANGED_FILES
  const base = process.env.CHANGELOG_GATE_BASE || 'origin/main'
  const changedFiles = override != null ? splitList(override) : changedFilesFromGit(base)
  const labels = parseLabels(process.env.GATE_PR_LABELS)

  const verdict = changelogGateVerdict({ changedFiles, labels })
  if (verdict.ok) {
    console.log(`✓ CHANGELOG gate: ${verdict.reason}`)
    return
  }
  console.error(`✗ CHANGELOG gate failed\n${verdict.reason}`)
  process.exitCode = 1
}

main()
