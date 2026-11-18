#!/usr/bin/env node
/**
 * Guard test for the smoke test's own exit code (AC-32): a case that saves no file, run alone, must exit 0
 * when clean and 1 under its planted fault, and must leave `results.json` in the evidence folder it prints.
 *
 * It was once not so: `startInstance` wipes the instance's run dir, the default evidence folder lives in it,
 * and a case that saved no file left the folder missing, so the run printed "1 passed" and died on a missing
 * `results.json` with exit 2. W-13, W-14, W-19 and W-20 are those cases. W-9 is checked for the other defect
 * of the same review: its planted fault must end in a failed assertion, never in a thrown `TypeError`.
 *
 *   node scripts/verify/guided-test-walk/exit-guard.mjs [--no-build]
 *
 * Runs the smoke test itself (a real second instance per run), serially, under `nice -n 19`. Exit 0 when every
 * expectation holds, 1 otherwise.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ENTRY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'guided-test-walk.mjs'
)

/** Cases that save no file, with the planted fault that must turn each one red. */
export const NO_FILE_CASES = [
  { id: 'W-13', fault: 'debounce-expects-two' },
  { id: 'W-14', fault: 'expect-verified-on-continue' },
  { id: 'W-19', fault: 'expect-settle-button' },
  { id: 'W-20', fault: 'click-delete-for-cancel' }
]

function run(args) {
  const r = spawnSync('nice', ['-n', '19', 'node', ENTRY, ...args], {
    encoding: 'utf8',
    timeout: 600_000
  })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  const evidence = /^evidence: (.+)$/m.exec(out)?.[1] ?? null
  return { code: r.status, out, evidence }
}

const problems = []
const expect = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`)
  if (!ok) problems.push(what)
}

let build = !process.argv.includes('--no-build')
const args = (...a) => {
  const list = build ? a : ['--no-build', ...a]
  build = false
  return list
}

for (const { id, fault } of NO_FILE_CASES) {
  const clean = run(args('--case', id))
  expect(clean.code === 0, `${id} alone, clean: exit 0 (got ${clean.code})`)
  expect(
    !!clean.evidence && existsSync(path.join(clean.evidence, 'results.json')),
    `${id} alone, clean: results.json is in the evidence folder`
  )
  const red = run(args('--case', id, '--plant-fault', fault))
  expect(red.code === 1, `${id} alone, fault ${fault}: exit 1 (got ${red.code})`)
  expect(
    !!red.evidence && existsSync(path.join(red.evidence, 'results.json')),
    `${id} alone, fault ${fault}: results.json is in the evidence folder`
  )
}

const w9 = run(args('--case', 'W-9', '--plant-fault', 'click-wrong-link'))
const w9fail = w9.out.split('\n').find((l) => l.startsWith('FAIL  W-9')) ?? ''
expect(w9.code === 1, `W-9 with fault click-wrong-link: exit 1 (got ${w9.code})`)
expect(
  /a url link opens a browser pane/.test(w9fail) &&
    !/TypeError|Cannot read|is not a function/.test(w9.out),
  'W-9 with fault click-wrong-link: fails on the url-link assertion, not on a thrown error'
)

console.log(
  problems.length ? `\n${problems.length} expectation(s) failed` : '\nall expectations hold'
)
process.exit(problems.length ? 1 : 0)
