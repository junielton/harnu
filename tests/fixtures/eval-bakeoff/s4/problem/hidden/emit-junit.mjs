#!/usr/bin/env node
/**
 * The hidden suite of the S-4 fixture: it follows a plan instead of testing anything.
 *
 * `node tests/emit-junit.mjs <plan.json>`. The plan is `{ pristine: Run[], fixed: Run[] }`, the
 * stage being `fixed` once `fixed.txt` exists (the reference patch adds it). Each invocation takes
 * the next run of its stage and the last one is repeated; `<plan.json>.<stage>.count` counts them.
 *
 * A run is `{ cases: { name: pass|fail|skip|error|collect }, xml: missing|corrupt, exit, stdout }`.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const planPath = process.argv[2]
const plan = JSON.parse(readFileSync(planPath, 'utf8'))
const stage = existsSync('fixed.txt') ? 'fixed' : 'pristine'
const counter = `${planPath}.${stage}.count`
const index = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0
writeFileSync(counter, String(index + 1))
const run = plan[stage][Math.min(index, plan[stage].length - 1)]

const child = {
  pass: '',
  fail: '<failure message="assertion failed">boom</failure>',
  skip: '<skipped message="not today"/>',
  error: '<error message="fixture blew up">boom</error>',
  collect: '<error message="collection failure">boom</error>'
}

if (run.stdout) process.stdout.write(run.stdout)
const cases = Object.entries(run.cases ?? {})
if (run.xml === 'corrupt') {
  writeFileSync(process.env.BAKEOFF_JUNIT, '<testsuites><testsuite name="cut"><testcase name="a')
} else if (run.xml !== 'missing') {
  const body = cases.map(
    ([name, status]) => `<testcase classname="hidden" name="${name}">${child[status]}</testcase>`
  )
  writeFileSync(
    process.env.BAKEOFF_JUNIT,
    `<?xml version="1.0"?>\n<testsuites><testsuite name="s">${body.join('')}</testsuite></testsuites>\n`
  )
}
process.exitCode = run.exit ?? (cases.every(([, status]) => status === 'pass') ? 0 : 1)
