#!/usr/bin/env node
// CLI for the i18n parity gate (T65 AC2). Loads en.json + pt-BR.json, diffs the
// deep-flattened key sets and, on mismatch, lists the missing keys BY NAME and
// BY FILE, then exits non-zero. Runs in seconds — replaces the cryptic vue-tsc
// `MessageSchema = typeof en` build error with an actionable one.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'
import { parityVerdict } from './i18n-parity-core.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const EN = join(REPO, 'src/renderer/src/i18n/en.json')
const PT = join(REPO, 'src/renderer/src/i18n/pt-BR.json')

function load(p) {
  return JSON.parse(readFileSync(p, 'utf8'))
}

function printMissing(file, note, keys) {
  console.error(`\n  Missing in ${file} — ${note}: ${keys.length}`)
  for (const k of keys) console.error(`    - ${k}`)
}

function main() {
  const enRel = relative(REPO, EN)
  const ptRel = relative(REPO, PT)
  const { ok, missingInPt, missingInEn } = parityVerdict(load(EN), load(PT))

  if (ok) {
    console.log(`✓ i18n parity: ${enRel} and ${ptRel} share the same keys`)
    return
  }
  console.error('✗ i18n parity failed — locale key sets differ')
  if (missingInPt.length) printMissing(ptRel, 'present in en.json', missingInPt)
  if (missingInEn.length) printMissing(enRel, 'present in pt-BR.json', missingInEn)
  console.error(
    `\nEvery key must exist in BOTH files (the MessageSchema = typeof en parity the vue-tsc build enforces).`
  )
  process.exitCode = 1
}

main()
