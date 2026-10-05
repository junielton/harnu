/**
 * Mission behavior-eval harness (T358 S5, design.md §12 layer 3, decision 19).
 *
 *   npm run eval:mission                      # every scenario
 *   npm run eval:mission -- happy-path        # one (or several) by name
 *   npm run eval:mission -- --list            # what exists, what is skipped
 *   npm run eval:mission -- --no-build        # reuse the current out/ build
 *   npm run eval:mission -- --model sonnet    # agent model (default: haiku)
 *
 * Each scenario runs against a fresh throwaway git repo and ONE isolated Harnu
 * instance (harnu.mjs): scripted `claude -p` sessions call the `mission_*` verbs
 * through Harnu's real MCP transport, the harness plays the operator for the
 * UI-only doors, and the result is graded by reading `.harnu/missions/*.md`
 * (grade.mjs) — never by a model's verdict. Every grade is then re-run against
 * the scenario's deliberately broken copies, which must fail.
 *
 * Runs under vite-node (see the `eval:mission` script) so the operator doors can
 * use the product's own `mission-core.ts` transitions instead of a copy of them.
 * Exit code: 0 when every non-skipped scenario passes, 1 otherwise.
 */
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  applyApprovedRescope,
  buildMissionFileContent,
  declaredEndHash,
  mintMissionId,
  parseMissionFile,
  readMissionLog
} from '../../../src/main/mission-core.ts'
import { buildApp, killAllLaunched, startHarnu } from './harnu.mjs'
import { killAgents, replyAsks, runAgent } from './agent.mjs'
import {
  checkBreaks,
  fillTemplate,
  gradeFolder,
  loadMissionState,
  missionsDirOf
} from './grade.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..', '..')
const SCENARIO_DIR = path.join(HERE, 'scenarios')
/** S7's synthetic legacy goal files — shared with the unit suite, never a real one. */
const LEGACY_FIXTURE_DIR = path.join(REPO_ROOT, 'tests', 'fixtures', 'mission-migration')
const AGENT_TIMEOUT_MS = 180_000
const CHILD_TIMEOUT_MS = 240_000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- CLI -----------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { names: [], build: true, list: false, model: 'haiku' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') continue
    else if (a === '--no-build') opts.build = false
    else if (a === '--list') opts.list = true
    else if (a === '--model') opts.model = argv[++i]
    else if (a.startsWith('--')) throw new Error(`unknown flag ${a}`)
    else opts.names.push(a)
  }
  return opts
}

function loadScenarios(names) {
  const all = readdirSync(SCENARIO_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ file: f, ...JSON.parse(readFileSync(path.join(SCENARIO_DIR, f), 'utf8')) }))
    .sort((a, b) => a.order - b.order)
  const unknown = names.filter((n) => !all.some((s) => s.name === n))
  if (unknown.length) throw new Error(`unknown scenario(s): ${unknown.join(', ')}`)
  return names.length ? all.filter((s) => names.includes(s.name)) : all
}

// ---- sandbox + vars ------------------------------------------------------------

/**
 * A stable per-checkout sandbox root. Stable on purpose: Claude Code asks for
 * workspace trust once per path, so a fresh random path would ask every run.
 */
function sandboxRoot() {
  const tag = createHash('sha1').update(REPO_ROOT).digest('hex').slice(0, 8)
  return path.join(os.tmpdir(), `harnu-mission-eval-${tag}`)
}

function freshRepo(folder) {
  rmSync(folder, { recursive: true, force: true })
  mkdirSync(folder, { recursive: true })
  const git = (...args) => execFileSync('git', args, { cwd: folder, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  git(
    '-c',
    'user.name=eval',
    '-c',
    'user.email=eval@localhost',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'init'
  )
}

/**
 * Setup-only view of the mission ids the next phase's prompt needs (`m.<slug>.id`,
 * `.end`, `.custom.<n>`). This is read to ADDRESS the missions, not to grade them.
 * Mission v3 has no fixed start: the end is found by its kind, never by id.
 */
function refreshMissionVars(vars) {
  const m = {}
  for (const { data } of loadMissionState(vars.folder).missions) {
    const steps = data.steps ?? []
    m[data.slug] = {
      id: data.id,
      end: steps.find((s) => s.kind === 'fixed-end')?.id,
      custom: steps.filter((s) => s.kind === 'custom').map((s) => s.id)
    }
  }
  // An owner turn (Mission v2 S4) names its own mission, so the scenario cannot
  // know the slug in advance: `m._only` addresses the repo's single mission.
  const all = Object.values(m)
  if (all.length === 1) m._only = all[0]
  vars.m = m
}

// ---- operator doors (UI-only in the product) -----------------------------------

function missionFileBySlug(folder, slug) {
  const dir = missionsDirOf(folder)
  const file = readdirSync(dir).find(
    (n) => /^mnt-[0-9a-f]{8}-/.test(n) && n.slice(13) === `${slug}.md`
  )
  if (!file) throw new Error(`operator: no mission file for slug "${slug}"`)
  return path.join(dir, file)
}

/**
 * Apply an operator transition through `mission-core`'s own parse/build, the way
 * the UI door does: parse → transition → build (validated) → atomic write. Mission
 * v3 retired the draft → active door (a mission is born active), so the only
 * transition left to simulate is the re-scope approval.
 */
function operatorDoor(folder, slug, action) {
  const file = missionFileBySlug(folder, slug)
  const raw = readFileSync(file, 'utf8')
  const mission = parseMissionFile(raw)
  if ('error' in mission) throw new Error(`operator: ${slug} does not parse: ${mission.error}`)
  const at = new Date().toISOString()
  let next
  if (action === 'approve-rescope') {
    next = applyApprovedRescope(mission, { at })
  } else {
    throw new Error(`operator: unknown action "${action}"`)
  }
  const tmp = `${file}.eval-tmp`
  writeFileSync(tmp, buildMissionFileContent(next, readMissionLog(raw)), 'utf8')
  renameSync(tmp, file)
}

// ---- seeded missions (a state no verb can reach) --------------------------------

/**
 * Write a mission straight to disk through `mission-core`'s own validated
 * builder, for a state no verb reaches: AGE — the stall rule (design §8) turns on
 * `updatedAt` being over an hour old, which a scripted session cannot wait out —
 * and a LEGACY file written before Mission v3 (`legacy: true`: a fixed start
 * "Scope confirmed" before the end, and, with `status: "draft"`, no approval
 * stamp), which a v3 reader must still parse. The seeded `updatedAt` is kept in
 * `vars.seeded.<slug>.updatedAt` so a scenario can assert it survived.
 *
 * `{ slug, title?, status, ageMinutes, legacy?, owner? (agent, default A), links?:
 * [{ step: 'fixed-start' | 'fixed-end', kind, ref }] }`
 */
function seedMission(vars, rawSpec) {
  const spec = fillTemplate(rawSpec, vars)
  const dir = missionsDirOf(vars.folder)
  mkdirSync(dir, { recursive: true })
  const id = mintMissionId(readdirSync(dir).map((n) => n.slice(0, 12)))
  const at = new Date(Date.now() - (spec.ageMinutes ?? 0) * 60_000).toISOString()
  const declaredEnd = { kind: 'code', target: `${spec.slug} target`, evidence: 'seeded' }
  const step = (n, kind, title, verification) => ({
    id: `stp-${n}`,
    ordinal: n,
    kind,
    title,
    verification,
    proof: 'unproven',
    links: (spec.links ?? [])
      .filter((l) => l.step === kind)
      .map((l) => ({ kind: l.kind, ref: l.ref })),
    blockers: []
  })
  const mission = {
    id,
    slug: spec.slug,
    folder: vars.folder,
    owner: { sessionId: vars.session[spec.owner ?? 'A'], folder: vars.folder },
    status: spec.status,
    declaredEnd,
    ...(spec.status === 'draft'
      ? {}
      : {
          declaredEndApproval: {
            at,
            bodyHash: declaredEndHash(declaredEnd),
            ...(spec.legacy ? {} : { via: 'chat' })
          }
        }),
    steps: spec.legacy
      ? [
          step(1, 'fixed-start', 'Scope confirmed', 'existence'),
          step(2, 'fixed-end', 'Delivered and verified', 'verifier')
        ]
      : [step(1, 'fixed-end', 'Delivered and verified', 'verifier')],
    blockers: [],
    openQuestions: [],
    createdAt: at,
    updatedAt: at,
    provenance: { author: 'agent', at }
  }
  const content = buildMissionFileContent(mission, `# ${spec.title ?? spec.slug}\n\n## Log\n`)
  writeFileSync(path.join(dir, `${id}-${spec.slug}.md`), content, 'utf8')
  vars.seeded[spec.slug] = { id, updatedAt: at }
}

// ---- legacy goal files (S7 migration) -------------------------------------------

/**
 * Plant a legacy `.harnu/goals/*.md` goal file in the sandbox, byte-for-byte from
 * one of the unit suite's synthetic fixtures (the real corpus holds client
 * identifiers and is never used). Its path and the sha256 of its bytes are kept
 * as `{{legacy.<name>.path|abs|sha256}}`, so the grade can prove the import kept
 * those bytes in `legacyRaw` and never touched the source.
 *
 * `{ name, fixture, path }` — `fixture` is a file name under the fixture dir,
 * `path` is where it lands, relative to the sandbox repo.
 */
function plantLegacyFile(vars, spec) {
  const bytes = readFileSync(path.join(LEGACY_FIXTURE_DIR, spec.fixture))
  const abs = path.join(vars.folder, spec.path)
  mkdirSync(path.dirname(abs), { recursive: true })
  writeFileSync(abs, bytes)
  vars.legacy[spec.name] = {
    path: spec.path,
    abs,
    sha256: createHash('sha256').update(bytes).digest('hex')
  }
}

// ---- spawned children (Harnu's own spawn paths) ---------------------------------

function claudeProjectsDir() {
  return path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'projects')
}

/** Claude Code's per-cwd transcript directory name. */
function projectSlug(folder) {
  return folder.replace(/[^a-zA-Z0-9]/g, '-')
}

/**
 * Wait until a spawned child's transcript shows its turn ended (an assistant
 * message with `stop_reason: end_turn`). Liveness only — the child's reply is
 * never graded; what it did or did not write to the mission is.
 */
async function waitForTurnEnd(folder, sessionId, timeoutMs) {
  const file = path.join(claudeProjectsDir(), projectSlug(folder), `${sessionId}.jsonl`)
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (existsSync(file)) {
      const lines = readFileSync(file, 'utf8').trim().split('\n')
      for (let i = lines.length - 1; i >= 0; i--) {
        let ev
        try {
          ev = JSON.parse(lines[i])
        } catch {
          continue
        }
        if (ev.type !== 'assistant') continue
        if (ev.message?.stop_reason === 'end_turn') return true
        break
      }
    }
    await sleep(2_000)
  }
  return false
}

/** The real transcript uuid from a `create_session` ACK. */
function sessionIdFromAck(payload) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
  const found = []
  const walk = (v) => {
    if (typeof v === 'string' && uuid.test(v)) found.push(v)
    else if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') Object.values(v).forEach(walk)
  }
  walk(payload.sessionId ?? payload)
  return found[0] ?? null
}

// ---- phases --------------------------------------------------------------------

async function runPhase(phase, ctx) {
  const { vars, harnu, scenarioDir, log, stats } = ctx
  refreshMissionVars(vars)

  if (phase.parallel) {
    await Promise.all(phase.parallel.map((p) => runPhase(p, ctx)))
    return
  }

  if (phase.agent) {
    const sessionId = vars.session[phase.agent]
    const prompt = fillTemplate(phase.prompt, {
      ...vars,
      self: sessionId,
      self8: sessionId.slice(0, 8)
    })
    const n = ++stats.agentRuns
    const logFile = path.join(scenarioDir, `agent-${n}-${phase.agent}.jsonl`)
    const r = await runAgent({
      sessionId,
      folder: vars.folder,
      prompt,
      mcpConfigPath: harnu.configPath,
      model: ctx.model,
      logFile,
      timeoutMs: AGENT_TIMEOUT_MS,
      tools: phase.tools ?? [],
      role: phase.role ?? 'scripted'
    })
    stats.costUsd += r.costUsd
    log(
      `    agent ${phase.agent} (#${n}, ${(r.ms / 1000).toFixed(1)}s): ${r.toolCalls.join(', ') || 'no tool calls'}` +
        (r.isError || r.code !== 0
          ? ` — run error (exit ${r.code}): ${r.result.slice(0, 160)}`
          : '')
    )
    writeFileSync(path.join(scenarioDir, `agent-${n}-${phase.agent}-reply.txt`), r.result)
    if (phase.record) await recordTurn(phase.record, r, ctx)
    return
  }

  if (phase.copyIn) {
    // A repo file the agent must read (an owner turn reads a shipped skill),
    // copied into the sandbox so no read leaves the cwd.
    for (const c of [].concat(phase.copyIn)) {
      const to = path.join(vars.folder, c.to)
      mkdirSync(path.dirname(to), { recursive: true })
      cpSync(path.join(REPO_ROOT, c.from), to)
      log(`    copyIn: ${c.from} → ${c.to}`)
    }
    return
  }

  if (phase.operator) {
    for (const slug of [].concat(phase.mission)) operatorDoor(vars.folder, slug, phase.operator)
    log(`    operator: ${phase.operator} ${[].concat(phase.mission).join(', ')}`)
    return
  }

  if (phase.seed) {
    for (const spec of [].concat(phase.seed)) seedMission(vars, spec)
    log(
      `    seed: ${[]
        .concat(phase.seed)
        .map((x) => `${x.slug} (${x.status}, ${x.ageMinutes ?? 0} min old)`)
        .join(', ')}`
    )
    return
  }

  if (phase.legacyFile) {
    for (const spec of [].concat(phase.legacyFile)) plantLegacyFile(vars, spec)
    log(
      `    legacy: ${[]
        .concat(phase.legacyFile)
        .map((x) => `${x.path} (from ${x.fixture})`)
        .join(', ')}`
    )
    return
  }

  if (phase.probe) {
    // A DERIVED signal (design §3: `stale` is never written to the file) has no
    // file state to grade. The harness reads it itself — `mission_get` through
    // the real transport, no model in the loop — and records it verbatim into a
    // ledger mission's Log with `mission_log`, so the grade still reads only
    // `.harnu/missions/*.md`. The line: `EVAL-PROBE[<tag>] <slug> stale=<b> status=<s>`.
    const { missions, into, tag } = phase.probe
    const ledger = vars.m[into]?.id
    if (!ledger) throw new Error(`probe: no ledger mission "${into}"`)
    const seen = []
    for (const slug of [].concat(missions)) {
      const id = vars.m[slug]?.id
      if (!id) throw new Error(`probe: no mission "${slug}"`)
      const got = await harnu.call('mission_get', { folder: vars.folder, missionId: id })
      if (got.isError) throw new Error(`probe: mission_get ${slug}: ${JSON.stringify(got.payload)}`)
      const line = `EVAL-PROBE[${tag}] ${slug} stale=${got.payload.derived?.stale} status=${got.payload.mission?.status}`
      const logged = await harnu.call('mission_log', {
        folder: vars.folder,
        missionId: ledger,
        note: line
      })
      if (logged.isError) throw new Error(`probe: mission_log: ${JSON.stringify(logged.payload)}`)
      seen.push(`${slug} stale=${got.payload.derived?.stale}`)
    }
    log(`    probe[${tag}]: ${seen.join(', ')}`)
    return
  }

  if (phase.burst) {
    // Concurrent calls straight through the real transport: the only way to
    // GUARANTEE overlapping writes (scripted agents land seconds apart).
    const { tool, count, args } = phase.burst
    const calls = Array.from({ length: count }, (_, i) =>
      harnu.call(tool, fillTemplate(args, { ...vars, i: i + 1 }))
    )
    const res = await Promise.all(calls)
    const refused = res.filter((r) => r.isError).length
    log(`    burst: ${count}× ${tool} concurrently through the transport (${refused} refused)`)
    return
  }

  if (phase.checkpoint) {
    const graded = gradeAndBreak(
      vars,
      phase.assert,
      phase.breaks,
      path.join(scenarioDir, `checkpoint-${phase.checkpoint}`)
    )
    ctx.grades.push({ at: `checkpoint ${phase.checkpoint}`, ...graded })
    log(`    checkpoint ${phase.checkpoint}: ${summarizeGrade(graded)}`)
    return
  }

  if (phase.spawn) {
    harnu.startTrustWatcher()
    const n = ++stats.spawns
    try {
      await runSpawn(phase, ctx)
    } finally {
      // Whatever happened, keep what the spawned sessions' screens showed — then
      // kill them. A spawned child's deadline is its phase's: once the phase is
      // over (done, timed out or failed) nothing it started keeps running.
      writeFileSync(path.join(scenarioDir, `spawn-${n}-ptys.txt`), await harnu.dumpPtys())
      await harnu.killChildren(vars.folder)
    }
    return
  }

  throw new Error(`unknown phase ${JSON.stringify(phase).slice(0, 120)}`)
}

/**
 * Record what an owner turn did (Mission v2 S4) where the grader can read it:
 * the harness — never the model — `mission_log`s one line into the mission,
 * `EVAL-TURN[<tag>] asked=<b> tools=<calls in order>`, the same way `probe`
 * transcribes a derived signal. `asked` is true when the final reply puts a
 * question to the operator (a `?`, or the word "confirm"): `claude -p` has no
 * `AskUserQuestion`, so a headless owner asks in its reply and ends the turn.
 * `mission` is a slug or `*` (the repo's single mission). No mission → nothing
 * is recorded, and the scenario's own `missionCount` fails.
 */
async function recordTurn(spec, r, ctx) {
  const { vars, harnu, log } = ctx
  refreshMissionVars(vars)
  const target = spec.mission === '*' ? vars.m._only : vars.m[spec.mission]
  if (!target) {
    log(`    record[${spec.tag}]: no mission "${spec.mission}" to record into`)
    return
  }
  const line = `EVAL-TURN[${spec.tag}] asked=${replyAsks(r.result)} tools=${r.toolCalls.join(',')}`
  const logged = await harnu.call('mission_log', {
    folder: vars.folder,
    missionId: target.id,
    note: line
  })
  if (logged.isError) throw new Error(`record: mission_log: ${JSON.stringify(logged.payload)}`)
  log(`    record[${spec.tag}]: ${line}`)
}

/** A child session spawned through one of Harnu's own spawn paths. */
async function runSpawn(phase, ctx) {
  const { vars, harnu, log } = ctx
  const prompt = fillTemplate(phase.prompt, vars)
  if (phase.spawn === 'agent-controlled') {
    // An agent's own create_session: Harnu spawns it agentControlled, which is
    // exactly the shape that must be withheld the Harnu MCP server.
    const { isError, payload } = await harnu.call(
      'create_session',
      { folder: vars.folder, prePrompt: prompt, bootOverride: { model: ctx.model } },
      150_000
    )
    const sessionId = sessionIdFromAck(payload)
    if (isError || payload.ok !== true || !sessionId) {
      throw new Error(
        `create_session did not materialize: ${JSON.stringify(payload).slice(0, 300)}`
      )
    }
    ctx.children.push(sessionId)
    const ended = await waitForTurnEnd(vars.folder, sessionId, CHILD_TIMEOUT_MS)
    if (!ended) throw new Error(`agent-controlled child ${sessionId} never finished its turn`)
    log(`    spawn agent-controlled: child ${sessionId} ran its turn`)
    return
  }
  if (phase.spawn === 'manifest') {
    // A board card dispatched through the manifest door: Harnu spawns it with
    // spawnedBy 'agent', which KEEPS the Harnu MCP server by design.
    const card = await harnu.call('create_card', {
      folder: vars.folder,
      title: phase.title,
      kind: 'scout',
      substrate: 'session',
      body: prompt
    })
    const slug = card.payload.slug ?? card.payload.card?.slug
    if (card.isError || !slug)
      throw new Error(`create_card failed: ${JSON.stringify(card.payload).slice(0, 300)}`)
    const moved = await harnu.call('move_card', { folder: vars.folder, slug, to: 'ready' })
    if (moved.isError)
      throw new Error(`move_card failed: ${JSON.stringify(moved.payload).slice(0, 300)}`)
    const sub = await harnu.call('submit_manifest', {
      folder: vars.folder,
      cards: [{ slug, model: ctx.model }]
    })
    if (sub.isError)
      throw new Error(`submit_manifest failed: ${JSON.stringify(sub.payload).slice(0, 300)}`)
    const { mission, logContains } = fillTemplate(phase.waitFor, vars)
    const started = Date.now()
    while (Date.now() - started < CHILD_TIMEOUT_MS) {
      const m = loadMissionState(vars.folder).missions.find((x) => x.data.slug === mission)
      if (m?.log.includes(logContains)) break
      await sleep(2_000)
    }
    log(
      `    spawn manifest: card ${slug} dispatched (${((Date.now() - started) / 1000).toFixed(0)}s)`
    )
    return
  }
  throw new Error(`unknown spawn kind "${phase.spawn}"`)
}

function gradeAndBreak(vars, assertions, breaks, dir) {
  mkdirSync(dir, { recursive: true })
  const graded = gradeFolder(vars.folder, assertions, vars)
  if (existsSync(missionsDirOf(vars.folder))) {
    cpSync(missionsDirOf(vars.folder), path.join(dir, 'missions'), { recursive: true })
  }
  const goals = path.join(vars.folder, '.harnu', 'goals')
  if (existsSync(goals)) cpSync(goals, path.join(dir, 'goals'), { recursive: true })
  const breakResults = checkBreaks(vars.folder, assertions, breaks, vars, path.join(dir, 'breaks'))
  return { ...graded, breaks: breakResults }
}

function summarizeGrade(g) {
  const passed = g.results.filter((r) => r.ok).length
  const caught = g.breaks.filter((b) => b.caught).length
  return `${passed}/${g.results.length} assertions, ${caught}/${g.breaks.length} breaks caught`
}

function gradeOk(g) {
  return g.ok && g.breaks.every((b) => b.caught)
}

// ---- main ----------------------------------------------------------------------

async function runScenario(scenario, harnu, model, runDir, log) {
  const scenarioDir = path.join(runDir, scenario.name)
  mkdirSync(scenarioDir, { recursive: true })
  const folder = path.join(sandboxRoot(), scenario.name)
  freshRepo(folder)
  const session = Object.fromEntries((scenario.agents ?? ['A']).map((a) => [a, randomUUID()]))
  const vars = { folder, repo: REPO_ROOT, session, m: {}, seeded: {}, legacy: {} }
  const ctx = {
    vars,
    harnu,
    scenarioDir,
    log,
    model,
    grades: [],
    children: [],
    stats: { agentRuns: 0, spawns: 0, costUsd: 0 }
  }
  const started = Date.now()
  let error = null
  try {
    for (const phase of scenario.phases) await runPhase(phase, ctx)
  } catch (e) {
    error = e.message
    log(`    phase error: ${error}`)
  }
  try {
    // Nothing the scenario spawned may still be writing while it is graded.
    await harnu.killChildren(folder)
    // The final grade runs even after a phase error: the state on disk is still
    // the evidence, and a phase that failed usually shows up as a failed assertion.
    const final = gradeAndBreak(
      vars,
      scenario.assert,
      scenario.breaks,
      path.join(scenarioDir, 'final')
    )
    ctx.grades.push({ at: 'final', ...final })
  } finally {
    collectChildTranscripts(folder, ctx.children, scenarioDir)
    removeSandboxTranscripts([folder])
    writeFileSync(path.join(scenarioDir, 'vars.json'), JSON.stringify(vars, null, 2))
  }
  const ok = !error && ctx.grades.every(gradeOk)
  return { ok, error, grades: ctx.grades, stats: ctx.stats, ms: Date.now() - started }
}

/** Keep the transcripts Harnu's spawned children wrote, as run evidence. */
function collectChildTranscripts(folder, children, scenarioDir) {
  const dir = path.join(claudeProjectsDir(), projectSlug(folder))
  if (!existsSync(dir)) return
  for (const id of children) {
    const f = path.join(dir, `${id}.jsonl`)
    if (existsSync(f)) cpSync(f, path.join(scenarioDir, `child-${id}.jsonl`))
  }
  for (const f of readdirSync(dir)) {
    if (f.endsWith('.jsonl') && !children.includes(f.slice(0, -6))) {
      cpSync(path.join(dir, f), path.join(scenarioDir, `child-${f}`))
    }
  }
}

/**
 * Remove sandbox folders' transcript directories from ~/.claude/projects, so the
 * operator's own Harnu stops listing a throwaway folder. Called per scenario once
 * its children are dead, again at the end of the batch, and on SIGINT/SIGTERM.
 * Only the exact per-scenario sandbox paths are touched.
 */
function removeSandboxTranscripts(folders) {
  for (const folder of folders) {
    rmSync(path.join(claudeProjectsDir(), projectSlug(folder)), { recursive: true, force: true })
  }
}

function printScenarioResult(s, r, log) {
  const tag = r.ok ? 'PASS' : 'FAIL'
  const final = r.grades.find((g) => g.at === 'final')
  log(
    `  ${tag} ${s.name} — ${summarizeGrade(final)}; ${r.stats.agentRuns} agent run(s), ` +
      `$${r.stats.costUsd.toFixed(3)}, ${(r.ms / 1000).toFixed(0)}s`
  )
  if (r.ok) return
  for (const g of r.grades) {
    for (const res of g.results.filter((x) => !x.ok))
      log(`      ✗ [${g.at}] ${res.label} — ${res.detail}`)
    for (const b of g.breaks.filter((x) => !x.caught))
      log(`      ✗ [${g.at}] break "${b.name}" NOT caught — ${b.detail}`)
  }
  if (r.error) log(`      ✗ phase error: ${r.error}`)
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const scenarios = loadScenarios(opts.names)
  const log = (s) => console.log(s)

  if (opts.list) {
    for (const s of scenarios) {
      const rf = s.reviewFocus ? `Review Focus #${s.reviewFocus}` : (s.label ?? 'happy path')
      log(
        `${s.skip ? 'SKIP' : '    '} ${s.name.padEnd(26)} ${rf.padEnd(16)} ${s.skip ? `— ${s.skipReason}` : s.title}`
      )
    }
    return 0
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const runDir = path.join(REPO_ROOT, '.harnu', 'eval', 'mission-behavior', stamp)
  mkdirSync(runDir, { recursive: true })
  log(`mission behavior eval — ${scenarios.length} scenario(s), model ${opts.model}`)
  log(`  run dir: ${path.relative(REPO_ROOT, runDir)}`)

  const active = scenarios.filter((s) => !s.skip)
  const sandboxes = active.map((s) => path.join(sandboxRoot(), s.name))
  const results = []
  let harnu = null
  // An interrupted run still kills everything it started and cleans the
  // sandbox transcripts: the instance (even mid-boot), its sessions and any
  // scripted agent still in flight.
  let interrupted = false
  const onSignal = (signal) => {
    if (interrupted) return
    interrupted = true
    log(`\n  ${signal}: killing everything this run started…`)
    Promise.allSettled([killAllLaunched(), killAgents()]).finally(() => {
      removeSandboxTranscripts(sandboxes)
      process.exit(130)
    })
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  try {
    if (active.length) {
      if (opts.build) {
        log('  building the app (electron-vite build)…')
        buildApp(REPO_ROOT)
      }
      harnu = await startHarnu({ repoRoot: REPO_ROOT, runDir, log: (s) => log(`  ${s}`) })
    }
    for (const s of scenarios) {
      if (s.skip) {
        log(`  SKIP ${s.name} — ${s.skipReason}`)
        results.push({ name: s.name, skipped: true })
        continue
      }
      log(`  ▸ ${s.name}: ${s.title}`)
      const r = await runScenario(s, harnu, opts.model, runDir, log)
      printScenarioResult(s, r, log)
      results.push({ name: s.name, ...r })
    }
  } finally {
    if (harnu) {
      await harnu.stop()
      // Keep Harnu's own audit of every verb call; drop the Chromium profile.
      const audit = path.join(harnu.userData, 'mcp-audit.json')
      if (existsSync(audit)) cpSync(audit, path.join(runDir, 'mcp-audit.json'))
      rmSync(harnu.userData, { recursive: true, force: true })
    }
    removeSandboxTranscripts(sandboxes)
  }

  const failed = results.filter((r) => !r.skipped && !r.ok)
  const skipped = results.filter((r) => r.skipped)
  writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify(results, null, 2))
  log(
    `\n${failed.length ? 'FAILED' : 'PASSED'}: ${results.length - failed.length - skipped.length} passed, ` +
      `${failed.length} failed, ${skipped.length} skipped`
  )
  return failed.length ? 1 : 0
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`mission behavior eval crashed: ${e.stack ?? e}`)
    process.exit(2)
  }
)
