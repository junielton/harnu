#!/usr/bin/env node
// CLI for the user-docs contract gate (T124). Mirrors changelog-gate.mjs /
// awareness-gate.mjs: resolves the PR's added + changed files (from git against
// the merge base, or GATE_*_FILES overrides for local runs / tests) and its
// labels, runs the pure predicate, and exits non-zero with an actionable
// message when the gate fails. Plain node — no third-party action.
//
// Env:
//   USER_DOCS_GATE_BASE   git ref to diff against (default: origin/main). CI
//                         sets it to the PR base sha.
//   GATE_CHANGED_FILES    newline/comma-separated file list; bypasses git for
//                         the full changed-file set. Shared with the CHANGELOG
//                         and awareness gates so one override drives all three.
//   GATE_ADDED_FILES      newline/comma-separated file list; bypasses git for
//                         the added-only set (this gate's own override — the
//                         other two gates don't need an added-vs-modified
//                         distinction).
//   GATE_PR_LABELS        PR labels — a JSON array (from toJSON(...)) or a
//                         comma/newline list. Shared with the other gates; each
//                         gate reads only its own escape label out of the set.

import { execFileSync } from 'node:child_process'
import { userDocsGateVerdict } from './user-docs-gate-core.mjs'

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

function addedFilesFromGit(base) {
  const out = execFileSync('git', ['diff', '--diff-filter=A', '--name-only', `${base}...HEAD`], {
    encoding: 'utf8'
  })
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
  const changedOverride = process.env.GATE_CHANGED_FILES
  const addedOverride = process.env.GATE_ADDED_FILES
  const base = process.env.USER_DOCS_GATE_BASE || 'origin/main'
  const changedFiles =
    changedOverride != null ? splitList(changedOverride) : changedFilesFromGit(base)
  const addedFiles = addedOverride != null ? splitList(addedOverride) : addedFilesFromGit(base)
  const labels = parseLabels(process.env.GATE_PR_LABELS)

  const verdict = userDocsGateVerdict({ addedFiles, changedFiles, labels })
  if (verdict.ok) {
    console.log(`✓ user-docs gate: ${verdict.reason}`)
    return
  }
  console.error(`✗ user-docs gate failed\n${verdict.reason}`)
  process.exitCode = 1
}

main()
