#!/usr/bin/env node
// CLI for the English-only gate. Reads every tracked text file, flags Portuguese prose
// outside the i18n exception, and exits non-zero with file:line for each hit.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { findViolations, SCANNED_EXT, isAllowedPath } from './english-gate-core.mjs'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8' })
  .split('\0')
  .filter((p) => p && SCANNED_EXT.test(p) && !isAllowedPath(p) && p !== 'package-lock.json')

const files = tracked.map((path) => ({ path, text: readFileSync(join(REPO, path), 'utf8') }))
const hits = findViolations(files)

if (hits.length === 0) {
  console.log(`✓ English gate: ${files.length} files, no Portuguese outside the i18n exception`)
  process.exit(0)
}

console.error(`✗ English gate: ${hits.length} line(s) look Portuguese outside the i18n exception\n`)
for (const h of hits.slice(0, 50)) console.error(`  ${h.path}:${h.line}  ${h.text.slice(0, 120)}`)
if (hits.length > 50) console.error(`  … and ${hits.length - 50} more`)
console.error(
  '\nTranslate the text to English. If the file legitimately needs non-English text (a locale\n' +
    'file or a unicode fixture), add it to ALLOWED_PATHS in scripts/ci/english-gate-core.mjs.'
)
process.exit(1)
