#!/usr/bin/env node
/**
 * Guided test walk · S-5 — the smoke test (AC-25 to AC-33, AC-39 to AC-41).
 *
 * Twenty-two cases (W-1 to W-22) drive a freshly built second instance of the app: a throwaway HOME, a
 * throwaway `--user-data-dir=/tmp/hv-walk-<id>`, its own CDP port, a stub `claude` that appends every line it
 * receives to a file and otherwise sleeps, a throwaway repo with two worktrees and a mission record, and a local
 * http page. The verbs (`walk_open`, `walk_extend`, `walk_report`, `walk_get`) go through the instance's own
 * control-server transport, as an agent would call them; the pane and the library are driven over CDP with
 * trusted mouse and key events.
 *
 *   nice -n 19 node scripts/verify/guided-test-walk.mjs [options]
 *     --no-build               reuse the current `out/` build
 *     --case W-n[,W-m]         run only these cases (repeatable)
 *     --list-proofs            derive which matrix rows each case proves, both ways, and check the spec; no app
 *     --plant-fault <name>     break THIS SCRIPT's own expectation or driving (see FAULTS); the run must exit 1
 *     --evidence <dir>         where screenshots, the stub's file, the export and results.json go
 *     --keep                   keep the whole run directory
 *
 * Output: one line per case (PASS, FAIL or PEND, with the matrix rows it proves in brackets), a tally, and the
 * evidence folder as the last line. Exit 0 when no case failed (a pending case, whose slice has not landed,
 * is neither), 1 when one failed, 2 on a setup failure (build, launch, CDP).
 *
 * It never reads or writes the operator's `.harnu/`, `~/.claude`, `~/.config/Harnu` or `~/.config/harnu`, never
 * calls Claude, and stops only the PIDs it started (never a `pkill` pattern).
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync, copyFileSync, statSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { buildApp } from '../eval/mission-behavior/harnu.mjs'
import { Asserts, makeCtx } from './guided-test-walk/drive.mjs'
import {
  hashTree,
  killLaunched,
  removeRunDir,
  sha256,
  startInstance
} from './guided-test-walk/instance.mjs'
import {
  caseOrder,
  checkProofs,
  readSpec,
  readSpecTables,
  rowOrder
} from './guided-test-walk/proofs.mjs'
import { casesA } from './guided-test-walk/cases-a.mjs'
import { casesB } from './guided-test-walk/cases-b.mjs'
import { casesC } from './guided-test-walk/cases-c.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const FIXTURES = path.join(REPO, 'tests', 'fixtures', 'guided-test-walk')

/** Every case, in the order of the spec's table. W-12 runs last: it needs the instance to be gone. */
export const CASES = [...casesA, ...casesB, ...casesC].sort((x, y) => caseOrder(x.id, y.id))

/**
 * The faults `--plant-fault` can plant. Each breaks the script's own expectation or its own driving, never the
 * product, and the run must then exit 1 with the named case failing. Derived from the cases, plus the faults of
 * the matrix check (`--list-proofs`).
 */
export const PROOF_FAULTS = {
  'drop-case-row': 'forget the matrix row W-1 proves for M-4 (a case cites no row)',
  'phantom-case': 'a matrix row cites a case W-99 that does not exist',
  'table-drift': "the spec's case table lists a row the matrix does not give W-6"
}
export const FAULTS = Object.fromEntries([
  ...CASES.flatMap((c) =>
    Object.entries(c.faults ?? {}).map(([n, what]) => [n, { case: c.id, what }])
  ),
  ...Object.entries(PROOF_FAULTS).map(([n, what]) => [n, { case: 'proofs', what }])
])

export function parseArgs(argv) {
  const o = {
    build: true,
    cases: null,
    listProofs: false,
    faults: new Set(),
    evidence: null,
    keep: false
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === '--no-build') o.build = false
    else if (a === '--case')
      (o.cases ??= []).push(
        ...next()
          .split(',')
          .map((s) => s.trim())
      )
    else if (a === '--list-proofs') o.listProofs = true
    else if (a === '--plant-fault')
      next()
        .split(',')
        .forEach((f) => o.faults.add(f.trim()))
    else if (a === '--evidence') o.evidence = next()
    else if (a === '--keep') o.keep = true
    else throw new Error(`unknown option ${a}`)
  }
  for (const f of o.faults)
    if (!(f in FAULTS))
      throw new Error(`unknown fault ${f}; one of ${Object.keys(FAULTS).join(', ')}`)
  for (const c of o.cases ?? [])
    if (!CASES.some((x) => x.id === c)) throw new Error(`unknown case ${c}`)
  return o
}

// ---------------------------------------------------------------------------------------------------------
// --list-proofs
// ---------------------------------------------------------------------------------------------------------

/** Derive the tables, plant a proofs fault when asked, check, print. Returns the exit code. */
function listProofs(opts) {
  const tables = readSpecTables(readSpec(REPO))
  if (opts.faults.has('drop-case-row'))
    tables.matrix.set('M-4', tables.matrix.get('M-4').replace(/\bW-1\b/g, ''))
  if (opts.faults.has('phantom-case')) tables.matrix.set('M-6', `${tables.matrix.get('M-6')}; W-99`)
  if (opts.faults.has('table-drift')) tables.table.set('W-6', [...tables.table.get('W-6'), 'M-77'])
  const { derived, problems } = checkProofs(tables, CASES)
  console.log(
    `conformance matrix: ${tables.matrix.size} rows; spec case table: ${tables.table.size} cases; script: ${CASES.length} cases`
  )
  for (const c of CASES) {
    const rows = derived.get(c.id) ?? []
    console.log(
      `${c.id.padEnd(5)} ${c.title.padEnd(44)} [${rows.join(', ') || 'none (isolation guard)'}]`
    )
  }
  const cited = new Set([...derived.values()].flat())
  const byTest = [...tables.matrix.keys()].filter((r) => !cited.has(r)).length
  console.log(`${cited.size} matrix rows are proved by a smoke case; ${byTest} by a unit test only`)
  for (const p of problems) console.log(`FAIL  ${p}`)
  console.log(
    problems.length ? `${problems.length} problem(s)` : 'matrix, case table and script agree'
  )
  return problems.length ? 1 : 0
}

// ---------------------------------------------------------------------------------------------------------
// The operator's files: the guard of W-12
// ---------------------------------------------------------------------------------------------------------

const OPERATOR_FILES = (home) => [
  path.join(home, '.claude', 'settings.json'),
  path.join(home, '.config', 'Harnu', 'harnu.mcp.json'),
  path.join(home, '.config', 'Harnu', 'projects.json'),
  path.join(home, '.config', 'harnu', 'harnu.mcp.json')
]

/** Where the operator's own `.harnu/` is: this checkout's, and the main checkout's it shares. */
function realHarnuDirs() {
  const dirs = new Set([path.join(REPO, '.harnu')])
  try {
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: REPO,
      encoding: 'utf8'
    }).trim()
    dirs.add(path.join(path.dirname(path.resolve(REPO, common)), '.harnu'))
  } catch {
    /* not a git checkout */
  }
  return [...dirs]
}

/** What W-12 compares: the operator's files (sha256) and the walks and missions of the real `.harnu/`. */
function snapshotOperator(home) {
  const files = {}
  for (const f of OPERATOR_FILES(home)) files[f] = existsSync(f) ? sha256(f) : null
  const walks = {}
  for (const d of realHarnuDirs()) {
    for (const sub of ['walks', 'missions-v4'])
      for (const [k, v] of Object.entries(hashTree(path.join(d, sub))))
        walks[path.join(d, sub, k)] = v
  }
  return { files, walks, pids: operatorPids() }
}

/**
 * The pids of every electron/harnu process that is neither ours nor another verification run's, to prove none of
 * them is stopped. A verification instance (this script's, or a sibling session's running its own smoke test at the
 * same time) is started on a throwaway `--user-data-dir=/tmp/hv-…` and ends on its own: counting it as "the
 * operator's" made W-12 fail whenever a sibling run exited during ours. Such an instance, and every process below
 * it, is left out.
 */
function operatorPids() {
  const out = spawnSync('ps', ['-eo', 'pid=,ppid=,comm=,args='], { encoding: 'utf8' }).stdout ?? ''
  const procs = new Map()
  for (const l of out.split('\n')) {
    const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/)
    if (m) procs.set(Number(m[1]), { ppid: Number(m[2]), comm: m[3], args: m[4] })
  }
  const throwaway = (pid, seen = new Set()) => {
    const p = procs.get(pid)
    if (!p || seen.has(pid)) return false
    seen.add(pid)
    return /--user-data-dir=\/tmp\/hv-/.test(p.args) || throwaway(p.ppid, seen)
  }
  return [...procs]
    .filter(([pid, p]) => /^(electron|harnu|chrome-sandbox)/i.test(p.comm) && !throwaway(pid))
    .map(([pid]) => pid)
}

/** The pids a stop reported (`pid 123` strings): is any of them still running? */
const ownPidsAlive = (stopped) =>
  stopped.some((p) => /^pid \d+$/.test(p) && alive(Number(p.slice(4))))

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------------------------------------
// Pending cases: a slice that has not landed
// ---------------------------------------------------------------------------------------------------------

/** `null` when the case can run; else the reason it is pending. Decided from the tree the build is made from. */
function pendingReason(c) {
  if (!c.pendingUntil) return null
  const { file, slice } = c.pendingUntil
  return existsSync(path.join(REPO, file)) ? null : `slice ${slice} has not landed (no ${file})`
}

// ---------------------------------------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------------------------------------

/**
 * A freshly started window under xvfb may not paint for a while (a screenshot hangs, the terminal sits on top of
 * the stack). Bring it to the front and wait until it paints before the first case.
 */
async function warmUp(inst) {
  await inst.cdp.waitPainting()
  await inst.cdp.eval(
    `document.querySelector("#app").__vue_app__.config.globalProperties.$pinia._s.get("sessions").select(${JSON.stringify(inst.sessions.owner)})`
  )
}

const line = (status, id, title, rows, detail = '') =>
  `${status}  ${id.padEnd(5)} ${title.padEnd(48)} [${rows.join(', ')}]${detail ? `  — ${detail}` : ''}`

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.listProofs) return listProofs(opts)
  try {
    os.setPriority(0, 19)
  } catch {
    /* best effort: the caller should run under nice */
  }
  const realHome = process.env.HOME ?? os.homedir()
  const id = randomBytes(2).toString('hex')
  const runDir = `/tmp/hv-walk-${id}`
  const evidence = path.resolve(opts.evidence ?? path.join(runDir, 'evidence'))
  mkdirSync(evidence, { recursive: true })

  const { derived } = checkProofs(readSpecTables(readSpec(REPO)), CASES)
  const rowsOf = (c) => (derived.get(c.id) ?? []).slice().sort(rowOrder)

  process.on('SIGINT', () => void killLaunched().then(() => process.exit(130)))
  process.on('SIGTERM', () => void killLaunched().then(() => process.exit(143)))

  const results = []
  const record = (c, status, detail) => {
    results.push({ id: c.id, title: c.title, status, rows: rowsOf(c), detail })
    console.log(line(status, c.id, c.title, rowsOf(c), detail))
  }

  const selected = (opts.cases ? CASES.filter((c) => opts.cases.includes(c.id)) : CASES).slice()
  const runnable = selected.filter((c) => !c.guard && !pendingReason(c))
  const guard = selected.find((c) => c.guard)
  let inst = null
  let setupError = null
  let ownPids = []
  const before = snapshotOperator(realHome)

  try {
    if (opts.build) {
      console.log('build: electron-vite build')
      buildApp(REPO, null)
    }
    if (!existsSync(path.join(REPO, 'out', 'main', 'index.js')))
      throw new Error('no out/ build: run without --no-build')
    if (runnable.length || guard) {
      inst = await startInstance({
        repoRoot: REPO,
        id,
        fixtures: FIXTURES,
        env: { HARNU_WALK_CHECK_WAIT_MS: '2500' }
      })
      console.log(`guided-test-walk smoke: instance hv-walk-${id} (CDP ${inst.cdpPort}, nice 19)`)
      // the folders are known to Harnu, and the owner session is on screen with its terminal running the stub
      for (const f of [inst.repo, inst.repoB, inst.repoEmpty])
        await inst.mcp.call('adopt_folder', { folder: f })
      await inst.cdp.waitFor(
        `(() => { const s = document.querySelector("#app").__vue_app__.config.globalProperties.$pinia._s.get("sessions"); return s.folders.some((f) => f.path === ${JSON.stringify(inst.repo)}) })()`,
        30_000,
        'the repo in the sidebar'
      )
      for (let k = 0; ; k++) {
        try {
          await warmUp(inst)
          break
        } catch (err) {
          if (k === 2) throw err
          console.log(`the window does not paint (${err.message}): starting the instance again`)
          await inst.halt()
          await inst.boot()
          await inst.cdp.waitFor(
            `document.querySelector("#app").__vue_app__.config.globalProperties.$pinia._s.get("sessions").folders.some((f) => f.path === ${JSON.stringify(inst.repo)})`,
            60_000,
            'the repo in the sidebar'
          )
        }
      }
    }
  } catch (err) {
    setupError = err
  }

  if (setupError) {
    console.error(`setup failed: ${setupError.message}`)
    if (inst) await inst.close().catch(() => {})
    await killLaunched()
    process.exitCode = 2
    return
  }

  try {
    for (const c of selected) {
      if (c.guard) continue
      const why = pendingReason(c)
      if (why) {
        record(c, 'PEND', why)
        continue
      }
      const a = new Asserts()
      const ctx = makeCtx({
        inst,
        fixtures: FIXTURES,
        evidence,
        faults: opts.faults,
        repoRoot: REPO,
        caseId: c.id
      })
      const t0 = Date.now()
      try {
        await ctx.reset()
        await ctx.ensureOwnerLive()
        await Promise.race([
          c.run(ctx, a),
          new Promise((_, rej) =>
            setTimeout(() => rej(new Error('timed out after 180 s')), 180_000)
          )
        ])
        record(c, a.passed ? 'PASS' : 'FAIL', a.passed ? '' : a.failures[0])
        if (!a.passed) for (const f of a.failures.slice(1, 6)) console.log(`        also: ${f}`)
      } catch (err) {
        record(
          c,
          'FAIL',
          `${err.message.split('\n')[0]}${a.failures.length ? ` (after: ${a.failures[0]})` : ''}`
        )
        const diag = await inst.cdp
          .eval(
            `new Promise((res) => { const t = setTimeout(() => res({ raf: false, vis: document.visibilityState, focus: document.hasFocus() }), 3000); requestAnimationFrame(() => { clearTimeout(t); res({ raf: true, vis: document.visibilityState, focus: document.hasFocus() }) }) })`
          )
          .catch((e) => ({ err: e.message }))
        console.log(`        page: ${JSON.stringify(diag)}`)
        await ctx.shot('failure').catch(() => {})
      }
      results[results.length - 1].assertions = a.count
      results[results.length - 1].ms = Date.now() - t0
    }
  } finally {
    if (inst) {
      try {
        copyFileSync(inst.stubLog, path.join(evidence, 'stub-received.log'))
      } catch {
        /* nothing received */
      }
      ownPids = await inst.close()
      console.log(
        `stopped own PIDs: ${
          ownPids
            .map((p) => p.replace(/^\D+/, ''))
            .filter(Boolean)
            .join(', ') || 'none left'
        }`
      )
    }
    await killLaunched()
  }

  // ---- W-12: the guard runs last, after the instance is gone ----------------------------------------------
  if (guard) {
    const a = new Asserts()
    const was = opts.faults.has('guard-stale-snapshot')
      ? { ...before, files: { ...before.files, [OPERATOR_FILES(realHome)[0]]: 'stale' } }
      : before
    const now = snapshotOperator(realHome)
    for (const [f, h] of Object.entries(was.files))
      a.eq(now.files[f], h, `operator file ${f.replace(realHome, '~')} is byte-identical`)
    a.eq(now.walks, was.walks, 'the real .harnu/ walks and missions are byte-identical')
    for (const p of was.pids) a.ok(alive(p), `the operator's process ${p} is still running`)
    if (inst) {
      a.ok(
        inst.env.HOME.startsWith(inst.runDir) && inst.userData.startsWith('/tmp/hv-walk-'),
        'the instance ran under a throwaway HOME and --user-data-dir'
      )
      a.ok(ownPids.length > 0, 'the instance was stopped through its own process ledger')
      a.ok(!ownPidsAlive(ownPids), "none of the instance's processes is left")
    }
    record(guard, a.passed ? 'PASS' : 'FAIL', a.passed ? '' : a.failures[0])
  }

  // ---- tally ----------------------------------------------------------------------------------------------
  const count = (s) => results.filter((r) => r.status === s).length
  const failed = count('FAIL')
  console.log(`\n${count('PASS')} passed, ${failed} failed, ${count('PEND')} pending`)
  const summary = {
    script: 'scripts/verify/guided-test-walk.mjs',
    at: new Date().toISOString(),
    faults: [...opts.faults],
    passed: count('PASS'),
    failed,
    pending: count('PEND'),
    results
  }
  writeFileSync(path.join(evidence, 'results.json'), JSON.stringify(summary, null, 2) + '\n')
  if (inst && !opts.keep) {
    // keep only the evidence: the instance's files are throwaway
    if (path.resolve(evidence).startsWith(path.resolve(inst.runDir) + path.sep)) {
      const keep = path.join(os.tmpdir(), `hv-walk-${id}-evidence`)
      rmSync(keep, { recursive: true, force: true })
      execFileSync('cp', ['-r', evidence, keep])
      removeRunDir(inst)
      mkdirSync(path.dirname(evidence), { recursive: true })
      execFileSync('cp', ['-r', keep, evidence])
      rmSync(keep, { recursive: true, force: true })
    } else removeRunDir(inst)
  }
  console.log(`evidence: ${evidence}`)
  process.exitCode = failed ? 1 : 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => {
      if (typeof code === 'number') process.exitCode = code
    })
    .catch((err) => {
      console.error(
        err?.stack && !/^Error: (unknown|no out)/.test(String(err)) ? err.stack : String(err)
      )
      process.exitCode = 2
    })
}
void statSync
