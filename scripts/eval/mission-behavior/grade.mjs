/**
 * The mission behavior-eval GRADER (T358 S5, design.md §12 layer 3).
 *
 * It grades by reading `.harnu/missions/*.md` — plus, when an assertion names
 * one, a plain file in the sandbox (S7: the legacy goal file an import must
 * leave untouched) — and nothing else: no ACK, no transcript, no model verdict. A scenario passes only when the state a real
 * session left on disk says so. The file is parsed here with `js-yaml` directly,
 * not through `src/main/mission-core.ts`, so a drift in the product's own parser
 * cannot make the grader agree with it.
 *
 * Every grading pass is also run against deliberately BROKEN copies of the same
 * state (`breaks` in a scenario): each break rewrites the mission files the way a
 * real regression would, and the grader must FAIL on it. A grader that passes a
 * broken outcome is a vacuous grader, and the harness reports it as a failure.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import yaml from 'js-yaml'

// ---- reading state -----------------------------------------------------------

/** `<folder>/.harnu/missions` — where a repo's mission files live (design §9). */
export function missionsDirOf(folder) {
  return path.join(folder, '.harnu', 'missions')
}

/**
 * Split one mission file into its YAML frontmatter and its free-text Log body.
 * Returns `null` when the file has no frontmatter block.
 */
function splitFile(raw) {
  if (!raw.startsWith('---\n')) return null
  const end = raw.indexOf('\n---\n', 3)
  if (end === -1) return null
  return { inner: raw.slice(4, end + 1), body: raw.slice(end + 5) }
}

/**
 * Read every mission file under `folder`. Unparseable files are reported, not
 * skipped silently — a grader that ignores a corrupt file would pass on it.
 * `files` (paths relative to `folder`) are read too, byte-exact as `latin1`
 * strings (`null` when absent), for the `{ file }` assertions.
 *
 * @returns {{ missions: Array<{ file: string, data: any, log: string }>, unreadable: string[], files: Record<string, string | null> }}
 */
export function loadMissionState(folder, files = []) {
  const dir = missionsDirOf(folder)
  const missions = []
  const unreadable = []
  const plain = {}
  for (const rel of files) {
    const abs = path.join(folder, rel)
    plain[rel] = existsSync(abs) ? readFileSync(abs, 'latin1') : null
  }
  const state = { missions, unreadable, files: plain }
  if (!existsSync(dir)) return state
  for (const file of readdirSync(dir)
    .filter((n) => n.endsWith('.md'))
    .sort()) {
    const raw = readFileSync(path.join(dir, file), 'utf8')
    const split = splitFile(raw)
    if (!split) {
      unreadable.push(`${file}: no frontmatter block`)
      continue
    }
    try {
      const data = yaml.load(split.inner, { schema: yaml.CORE_SCHEMA })
      if (!data || typeof data !== 'object') throw new Error('frontmatter is not a mapping')
      missions.push({ file, data, log: split.body })
    } catch (e) {
      unreadable.push(`${file}: ${e.message.split('\n')[0]}`)
    }
  }
  return state
}

/** Write a state back out as mission files (used to materialize a break). */
export function writeMissionState(folder, state) {
  const dir = missionsDirOf(folder)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  for (const m of state.missions) {
    const fm = yaml.dump(m.data, { lineWidth: -1, noRefs: true })
    writeFileSync(path.join(dir, m.file), `---\n${fm}---\n${m.log}`, 'utf8')
  }
  for (const [rel, content] of Object.entries(state.files ?? {})) {
    if (content === null) continue
    mkdirSync(path.dirname(path.join(folder, rel)), { recursive: true })
    writeFileSync(path.join(folder, rel), content, 'latin1')
  }
}

/** `sha256` hex of a string's UTF-8 bytes (a mission field) or of a latin1 byte string (a file). */
function sha256Of(value, encoding) {
  return createHash('sha256').update(Buffer.from(value, encoding)).digest('hex')
}

/** The sandbox files a set of assertions names (`{ file }`), templated. */
function filesNamed(assertions, vars) {
  const out = new Set()
  for (const a of assertions ?? []) {
    try {
      const filled = fillTemplate(a, vars)
      if (typeof filled.file === 'string') out.add(filled.file)
    } catch {
      // An unresolved placeholder fails the assertion itself, in gradeState.
    }
  }
  return [...out]
}

// ---- selectors -----------------------------------------------------------------

/**
 * Find a mission by slug. `*` is the repo's ONLY mission (Mission v2 S4: an
 * owner turn names its own mission, so the scenario cannot know the slug) —
 * `undefined` unless exactly one mission exists.
 */
export function findMission(state, slug) {
  if (slug === '*') return state.missions.length === 1 ? state.missions[0] : undefined
  return state.missions.find((m) => m.data.slug === slug)
}

/** Every step of a mission (an empty list when the file carries none). */
function stepsOf(mission) {
  return Array.isArray(mission.data.steps) ? mission.data.steps : []
}

/** Every blocker on a mission: its own, then each step's. */
function allBlockers(mission) {
  const own = Array.isArray(mission.data.blockers) ? mission.data.blockers : []
  return [...own, ...stepsOf(mission).flatMap((s) => (Array.isArray(s.blockers) ? s.blockers : []))]
}

/** Every link on any step of a mission. */
function allLinks(mission) {
  return stepsOf(mission).flatMap((s) => (Array.isArray(s.links) ? s.links : []))
}

/**
 * Resolve a step selector: `fixed-start`, `fixed-end`, `custom:<n>` (the n-th
 * custom step in order, 0-based) or `title:<exact title>`.
 */
export function findStep(mission, selector) {
  const steps = stepsOf(mission)
  if (selector === 'fixed-start' || selector === 'fixed-end') {
    return steps.find((s) => s.kind === selector)
  }
  if (selector.startsWith('custom:')) {
    const n = Number(selector.slice('custom:'.length))
    return steps.filter((s) => s.kind === 'custom')[n]
  }
  if (selector.startsWith('title:')) {
    const title = selector.slice('title:'.length)
    return steps.find((s) => s.title === title)
  }
  throw new Error(`unknown step selector "${selector}"`)
}

/** Read a dotted path (`verifiedBy.sessionId`) out of an object. */
function getPath(obj, dotted) {
  if (!dotted) return obj
  let cur = obj
  for (const key of dotted.split('.')) {
    if (cur === null || cur === undefined) return undefined
    cur = cur[key]
  }
  return cur
}

/** Set a dotted path, creating intermediate objects. */
function setPath(obj, dotted, value) {
  const keys = dotted.split('.')
  let cur = obj
  for (const key of keys.slice(0, -1)) {
    if (cur[key] === null || typeof cur[key] !== 'object') cur[key] = {}
    cur = cur[key]
  }
  cur[keys[keys.length - 1]] = value
}

/** Delete a dotted path (no-op when absent). */
function unsetPath(obj, dotted) {
  const keys = dotted.split('.')
  const parent = getPath(obj, keys.slice(0, -1).join('.'))
  if (parent && typeof parent === 'object') delete parent[keys[keys.length - 1]]
}

/** Whether `want` is a value operator (`{ $exists }`, `{ $truthy }`, `{ $match, $flags? }`). */
function isOperator(want) {
  return (
    want !== null &&
    typeof want === 'object' &&
    !Array.isArray(want) &&
    Object.keys(want).length > 0 &&
    Object.keys(want).every((k) => k.startsWith('$'))
  )
}

/**
 * Deep-partial match: every key in `want` equals the same key in `got`. A `want`
 * value may be an operator instead of a literal: `{ "$exists": bool }` (present,
 * i.e. neither undefined nor null), `{ "$truthy": bool }` (any truthy value —
 * `true`, a stamp object, a date string), `{ "$match": "regex", "$flags"?: "i" }`
 * (a string matching the regex).
 */
function partialMatch(got, want) {
  if (isOperator(want)) {
    if ('$exists' in want) return (got !== undefined && got !== null) === want.$exists
    if ('$truthy' in want) return Boolean(got) === want.$truthy
    if ('$match' in want) {
      return typeof got === 'string' && new RegExp(want.$match, want.$flags ?? '').test(got)
    }
    throw new Error(`unknown operator ${JSON.stringify(want)}`)
  }
  if (want === null || typeof want !== 'object') return got === want
  if (got === null || typeof got !== 'object') return false
  return Object.entries(want).every(([k, v]) => partialMatch(got[k], v))
}

// ---- templating ----------------------------------------------------------------

/**
 * Replace `{{a.b.c}}` placeholders from `vars`, recursively through arrays and
 * objects. An unresolved placeholder throws — a scenario that grades against a
 * literal `{{session.B}}` would silently compare against the wrong value.
 */
export function fillTemplate(value, vars) {
  if (typeof value === 'string') {
    return value.replace(/\{\{([^}]+)\}\}/g, (_, key) => {
      const v = getPath(vars, key.trim())
      if (v === undefined || v === null) throw new Error(`unresolved placeholder {{${key}}}`)
      return String(v)
    })
  }
  if (Array.isArray(value)) return value.map((v) => fillTemplate(v, vars))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillTemplate(v, vars)]))
  }
  return value
}

// ---- assertions ----------------------------------------------------------------

/** One-line label for an assertion, for the report. */
function describe(a) {
  if (a.label) return a.label
  const where = [a.file, a.mission, a.step, a.path].filter(Boolean).join(' › ')
  const what = Object.keys(a)
    .filter((k) => !['file', 'mission', 'step', 'path', 'label'].includes(k))
    .map((k) => `${k} ${JSON.stringify(a[k])}`)
    .join(', ')
  return `${where || 'state'}: ${what}`
}

/**
 * Evaluate one (already templated) assertion against a state. Returns
 * `{ ok, label, detail }`; never throws.
 *
 * Shapes:
 *  - `{ missionCount: n }`
 *  - `{ mission, [step], [path], equals | notEquals | exists | includes | excludes | length | oneOf }`
 *  - `{ mission, anyBlocker: {…}, present? }` / `{ mission, anyLink: {…}, present? }` — some
 *    blocker (the mission's own or any step's) / some step link deep-partially matches;
 *    `present: false` asserts none does. For a behavior the model may place anywhere.
 *  - `mission: "*"` — the repo's single mission, whatever its slug
 *  - `{ mission, logContains: "…" }` / `{ mission, logNotContains: "…" }`
 *  - `{ mission, logLine: "<prefix>", contains?: "…", notContains?: "…" }` — at least one
 *    Log line starts with the prefix, and EVERY such line contains / lacks the text
 *  - `{ mission, stepCount: {…}, equals: n }` — the number of steps deep-partially
 *    matching (operators allowed) is exactly n
 *  - any deep-partial value may be an operator: `{ $exists }`, `{ $truthy }`, `{ $match, $flags? }`
 *  - `{ mission, [step], path, sha256: "<hex>" }` — the field's UTF-8 bytes hash to it
 *  - `{ file, sha256: "<hex>" }` / `{ file, exists: bool }` — a plain sandbox file
 */
export function evaluate(state, a) {
  const label = describe(a)
  const fail = (detail) => ({ ok: false, label, detail })
  const pass = () => ({ ok: true, label, detail: '' })
  try {
    if ('missionCount' in a) {
      const n = state.missions.length
      return n === a.missionCount ? pass() : fail(`found ${n} mission file(s)`)
    }
    if ('file' in a) {
      const content = state.files?.[a.file]
      if (content === undefined) return fail('file was not loaded by the grader')
      if ('exists' in a)
        return (content !== null) === a.exists ? pass() : fail(`exists: ${content !== null}`)
      if (content === null) return fail('the file is gone')
      if ('sha256' in a) {
        const got = sha256Of(content, 'latin1')
        return got === a.sha256 ? pass() : fail(`sha256 ${got}`)
      }
      return fail('file assertion has no matcher')
    }
    const mission = findMission(state, a.mission)
    if (!mission) {
      return fail(
        a.mission === '*'
          ? `expected exactly one mission, found ${state.missions.length}`
          : `no mission with slug "${a.mission}"`
      )
    }
    if ('anyBlocker' in a || 'anyLink' in a) {
      const [list, want] =
        'anyBlocker' in a ? [allBlockers(mission), a.anyBlocker] : [allLinks(mission), a.anyLink]
      const hits = list.filter((x) => partialMatch(x, want))
      const expected = a.present ?? true
      if (hits.length > 0 === expected) return pass()
      return fail(
        expected ? `none matches among ${JSON.stringify(list)}` : `present: ${JSON.stringify(hits)}`
      )
    }
    if ('logContains' in a) {
      return mission.log.includes(a.logContains) ? pass() : fail('the Log does not contain it')
    }
    if ('logNotContains' in a) {
      return mission.log.includes(a.logNotContains) ? fail('the Log contains it') : pass()
    }
    if ('logLine' in a) {
      const lines = mission.log.split('\n').filter((l) => l.startsWith(a.logLine))
      if (lines.length === 0) return fail(`no Log line starts with "${a.logLine}"`)
      const bad = lines.filter(
        (l) =>
          (a.contains !== undefined && !l.includes(a.contains)) ||
          (a.notContains !== undefined && l.includes(a.notContains))
      )
      return bad.length === 0 ? pass() : fail(`line: ${bad[0]}`)
    }
    if ('stepCount' in a) {
      const n = stepsOf(mission).filter((st) => partialMatch(st, a.stepCount)).length
      return n === a.equals ? pass() : fail(`counted ${n}`)
    }
    let target = mission.data
    if (a.step) {
      target = findStep(mission, a.step)
      if (!target) return fail(`no step "${a.step}"`)
    }
    const got = getPath(target, a.path)
    const shown = JSON.stringify(got)
    if ('sha256' in a) {
      if (typeof got !== 'string') return fail(`not a string: ${shown?.slice(0, 80)}`)
      const digest = sha256Of(got, 'utf8')
      return digest === a.sha256 ? pass() : fail(`sha256 ${digest} (${got.length} chars)`)
    }
    if ('equals' in a) return partialMatch(got, a.equals) ? pass() : fail(`got ${shown}`)
    if ('notEquals' in a) return partialMatch(got, a.notEquals) ? fail(`got ${shown}`) : pass()
    if ('oneOf' in a) return a.oneOf.includes(got) ? pass() : fail(`got ${shown}`)
    if ('exists' in a) {
      const present = got !== undefined && got !== null
      return present === a.exists ? pass() : fail(`got ${shown}`)
    }
    if ('length' in a) {
      return Array.isArray(got) && got.length === a.length ? pass() : fail(`got ${shown}`)
    }
    if ('includes' in a) {
      const wanted = Array.isArray(a.includes) ? a.includes : [a.includes]
      if (!Array.isArray(got)) return fail(`not a list: ${shown}`)
      const missing = wanted.filter((w) => !got.some((g) => partialMatch(g, w)))
      return missing.length === 0 ? pass() : fail(`missing ${JSON.stringify(missing)}`)
    }
    if ('excludes' in a) {
      if (!Array.isArray(got)) return fail(`not a list: ${shown}`)
      const present = got.filter((g) => partialMatch(g, a.excludes))
      return present.length === 0 ? pass() : fail(`present: ${JSON.stringify(present)}`)
    }
    return fail('assertion has no matcher')
  } catch (e) {
    return fail(`grader error: ${e.message}`)
  }
}

/**
 * Grade a folder's mission state against a list of assertions. An unreadable
 * mission file fails the grade on its own: a corrupt write IS a regression.
 */
export function gradeFolder(folder, assertions, vars) {
  const state = loadMissionState(folder, filesNamed(assertions, vars))
  return gradeState(state, assertions, vars)
}

/** Grade an in-memory state (see {@link gradeFolder}). */
export function gradeState(state, assertions, vars) {
  const results = state.unreadable.map((u) => ({
    ok: false,
    label: 'every mission file parses',
    detail: u
  }))
  for (const raw of assertions) {
    let a
    try {
      a = fillTemplate(raw, vars)
    } catch (e) {
      results.push({ ok: false, label: describe(raw), detail: e.message })
      continue
    }
    results.push(evaluate(state, a))
  }
  return { ok: results.every((r) => r.ok), results }
}

// ---- deliberately broken outcomes ----------------------------------------------

/**
 * Apply one break's mutations to a deep copy of `state`. A break describes a
 * regression the grader must catch:
 *  - `{ mission, [step], set: { "<path>": value } }`
 *  - `{ mission, [step], unset: "<path>" }`
 *  - `{ mission, logAppend: "…" }` / `{ mission, logRemove: "…" }`
 *  - `{ drop: "<slug>" }` — the mission file is gone
 *  - `{ duplicate: "<slug>" }` — a second copy of that mission file exists
 *  - `{ file, write: "…" }` / `{ file, delete: true }` — a plain sandbox file changed / is gone
 *  - `{ mission, clearBlockers: true }` — every blocker gone (the mission's and each step's)
 *  - `{ mission, eachBlocker: { set: { "<path>": value } } }` — applied to every blocker
 *  - `{ mission, eachLink: { match: {…}, remove: true } }` — every step link matching removed
 *  A `mission`/`drop` of `*` is the single mission, as in the assertions.
 */
export function applyBreak(state, brk, vars) {
  const next = structuredClone(state)
  for (const rawOp of brk.mutate) {
    const op = fillTemplate(rawOp, vars)
    if (op.drop) {
      const gone = findMission(next, op.drop)
      next.missions = next.missions.filter((m) => m !== gone)
      continue
    }
    if (op.duplicate) {
      const m = findMission(next, op.duplicate)
      if (!m) throw new Error(`break "${brk.name}": no mission "${op.duplicate}"`)
      next.missions.push({ ...structuredClone(m), file: `dup-${m.file}` })
      continue
    }
    if (op.file) {
      next.files = { ...next.files, [op.file]: op.delete ? null : op.write }
      continue
    }
    const mission = findMission(next, op.mission)
    if (!mission) throw new Error(`break "${brk.name}": no mission "${op.mission}"`)
    if (op.clearBlockers) {
      mission.data.blockers = []
      for (const st of stepsOf(mission)) st.blockers = []
    }
    if (op.eachBlocker) {
      for (const b of allBlockers(mission)) {
        for (const [p, v] of Object.entries(op.eachBlocker.set ?? {})) setPath(b, p, v)
      }
    }
    if (op.eachLink) {
      for (const st of stepsOf(mission)) {
        st.links = (st.links ?? []).filter((l) => !partialMatch(l, op.eachLink.match))
      }
    }
    if (op.logAppend) mission.log += `\n${op.logAppend}\n`
    if (op.logRemove) mission.log = mission.log.split(op.logRemove).join('')
    let target = mission.data
    if (op.step) {
      target = findStep(mission, op.step)
      if (!target) throw new Error(`break "${brk.name}": no step "${op.step}"`)
    }
    for (const [p, v] of Object.entries(op.set ?? {})) setPath(target, p, v)
    if (op.unset) unsetPath(target, op.unset)
  }
  return next
}

/**
 * Prove the grader is not vacuous: for every break, write the broken state as
 * real mission files under `scratchRoot/<break>` and grade THAT folder. Each
 * break must make the grade fail.
 *
 * @returns {Array<{ name: string, caught: boolean, detail: string }>}
 */
export function checkBreaks(folder, assertions, breaks, vars, scratchRoot) {
  const base = loadMissionState(folder, filesNamed(assertions, vars))
  return (breaks ?? []).map((brk) => {
    const brokenFolder = path.join(scratchRoot, brk.name)
    try {
      writeMissionState(brokenFolder, applyBreak(base, brk, vars))
      const graded = gradeFolder(brokenFolder, assertions, vars)
      const firstFail = graded.results.find((r) => !r.ok)
      return {
        name: brk.name,
        caught: !graded.ok,
        detail: firstFail
          ? `${firstFail.label} — ${firstFail.detail}`
          : 'grader PASSED a broken state'
      }
    } catch (e) {
      return { name: brk.name, caught: false, detail: `break could not be applied: ${e.message}` }
    }
  })
}
