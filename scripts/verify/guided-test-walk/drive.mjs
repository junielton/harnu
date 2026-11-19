/**
 * What a case is given: the running instance plus the verbs a case uses to drive and read it.
 * Nothing here knows a case's expectation; a case builds its own assertions on these.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import * as path from 'node:path'
import { hashTree, makePng, sleep } from './instance.mjs'

const PIN = `document.querySelector('#app').__vue_app__.config.globalProperties.$pinia`
export const S = (name) => `${PIN}._s.get('${name}')`

/** A case's assertions: every failure is recorded, the first one is the case's reason. */
export class Asserts {
  constructor() {
    this.failures = []
    this.count = 0
  }
  ok(cond, what) {
    this.count++
    if (!cond) this.failures.push(what)
    return !!cond
  }
  eq(got, want, what) {
    this.count++
    const same = JSON.stringify(got) === JSON.stringify(want)
    if (!same)
      this.failures.push(`${what}: wanted ${JSON.stringify(want)}, got ${JSON.stringify(got)}`)
    return same
  }
  get passed() {
    return this.failures.length === 0
  }
}

/** The text a turn put in the stub's file, with the paste markers a terminal adds taken out. */
const clean = (s) => s.replace(new RegExp(String.fromCharCode(27) + '\\[20[01]~', 'g'), '')

/** One counter for the whole run: every walk gets a source of its own, so no live run blocks the next case. */
let nextN = Number(process.env.HV_N0 ?? 0)

export function makeCtx({ inst, fixtures, evidence, faults, repoRoot, caseId }) {
  const fx = (name) => JSON.parse(readFileSync(path.join(fixtures, name), 'utf8'))
  const ctx = {
    inst,
    repoRoot,
    evidence,
    caseId,
    /** Is a script-side fault planted (`--plant-fault`)? It breaks this script's own expectation. */
    fault: (name) => faults.has(name),
    get cdp() {
      return inst.cdp
    },
    get mcp() {
      return inst.mcp
    },
    repo: inst.repo,
    repoB: inst.repoB,
    repoEmpty: inst.repoEmpty,
    sessions: inst.sessions,
    history: fx('history.json'),
    sleep,
    S,
    fx,

    /** The sample walk with its two addresses filled in and a source of its own (`n` makes it unique). */
    sample(n = ++nextN) {
      const s = JSON.parse(
        JSON.stringify(fx('sample-walk.json'))
          .replaceAll('__URL__', inst.preview)
          .replaceAll('__FOLDER_B__', inst.repoB)
      )
      s.source.number = 100 + n
      s.source.url = `https://prs.example.invalid/example-org/example-web/pull/${100 + n}`
      return s
    },
    learn(n = ++nextN) {
      const s = fx('learn-walk.json')
      s.source.text = `${s.source.text} (variant ${n})`
      return s
    },

    // ---- reading the app ------------------------------------------------------------------------
    /** What the open walk pane shows, or `null` when none is open. */
    pane() {
      return inst.cdp.eval(`(() => {
        const r = document.querySelector('[data-dsqa="walk"]')
        if (!r) return null
        const q = (s) => r.querySelector(s)
        return {
          state: r.dataset.state,
          text: r.textContent.replace(/[ \\t\\r\\n]+/g, ' '),
          progress: q('[data-test="walk-progress"] .wk-count')?.textContent?.trim() ?? null,
          title: (q('.wk-title')?.textContent ?? '').trim(),
          source: (q('[data-test="walk-source"]')?.innerText ?? '').trim(),
          outcomes: [...r.querySelectorAll('[data-outcome]')].map((b) => b.dataset.outcome),
          disabled: [...r.querySelectorAll('[data-outcome]')].filter((b) => b.disabled).map((b) => b.dataset.outcome),
          primary: r.querySelector('[data-walk-primary]')?.dataset.outcome ?? null,
          checkTitles: [...r.querySelectorAll('[data-dsqa-part="step-title"]')].map((e) => e.textContent.trim()),
          scrollWidth: r.scrollWidth,
          clientWidth: r.clientWidth,
          width: r.getBoundingClientRect().width
        }
      })()`)
    },
    /** Wait for the pane's `data-state` (and optionally a text it contains). */
    async waitState(state, { text = null, ms = 20_000 } = {}) {
      return inst.cdp.waitFor(
        `(() => { const r = document.querySelector('[data-dsqa="walk"]'); return r && r.dataset.state === ${JSON.stringify(state)} && ${text === null ? 'true' : `r.textContent.includes(${JSON.stringify(text)})`} })()`,
        ms,
        `the walk pane in state ${state}${text ? ` showing "${text}"` : ''}`
      )
    },
    /** Wait until the pane's progress label reads `label` (`Check 3 of 9`). */
    waitProgress(label, ms = 20_000) {
      return inst.cdp.waitFor(
        `document.querySelector('[data-dsqa="walk"] [data-test="walk-progress"] .wk-count')?.textContent.trim() === ${JSON.stringify(label)}`,
        ms,
        `progress "${label}"`
      )
    },
    /** An outcome button is on offer. */
    waitOutcome: (name, ms = 20_000) =>
      inst.cdp.waitFor(
        `!!document.querySelector('[data-dsqa="walk"] [data-outcome="${name}"]')`,
        ms,
        `the ${name} button`
      ),
    /** Done on a check with an agent check, then the agent's answer (what the session does after the turn). */
    async agentDone(w, checkId, result) {
      await ctx.press('done')
      await ctx.waitAwaiting()
      const evidence =
        result === 'pass'
          ? 'Ran the read-only check, expected one match, found one match'
          : ctx.history.disagreeEvidence
      const r = await ctx.report(w, checkId, result, evidence)
      if (r.isError || r.payload.ok === false)
        throw new Error(`walk_report refused: ${JSON.stringify(r.payload).slice(0, 300)}`)
    },
    /** How many times the local page has been fetched. */
    previewHits: () =>
      existsSync(path.join(inst.runDir, 'preview-hits.log'))
        ? readFileSync(path.join(inst.runDir, 'preview-hits.log'), 'utf8')
            .split('\n')
            .filter(Boolean).length
        : 0,
    /** A mission with an operator criterion and a session criterion, made through the instance's own `mission_create`. */
    async makeMission() {
      if (inst._mission) return inst._mission
      const r = await inst.mcp.call('mission_create', {
        folder: inst.repo,
        sessionId: inst.sessions.leader,
        title: 'Notes search',
        doneWhen: 'Searching the notes list works end to end',
        milestones: [{ title: 'Search box' }],
        steps: [
          {
            title: 'Build the search box',
            milestone: 'Search box',
            criteria: [
              { text: 'The operator has typed in the box', by: 'operator' },
              'The filter code is in the list module'
            ]
          }
        ]
      })
      const id = r.payload?.missionId ?? r.payload?.id
      if (!/^mnt-/.test(id ?? ''))
        throw new Error(`mission_create refused: ${JSON.stringify(r.payload).slice(0, 300)}`)
      const g = await inst.mcp.call('mission_get', {
        folder: inst.repo,
        sessionId: inst.sessions.leader,
        missionId: id
      })
      const crit = g.payload.steps?.[0]?.criteria ?? []
      const operator = crit.find((c) => c.by === 'operator')?.id
      const session = crit.find((c) => c.by !== 'operator')?.id
      if (!operator || !session)
        throw new Error(
          `no criteria ids in mission_get: ${JSON.stringify(g.payload.steps?.[0]).slice(0, 300)}`
        )
      inst._mission = { id, operator, session }
      return inst._mission
    },
    /**
     * A fresh mission (never cached) with one step carrying these criteria (`{ text, by }`), made through the
     * instance's own `mission_create`; resolves `{ id, criteria: [{ id, text, by }] }`.
     */
    async newMission(title, criteria) {
      const r = await inst.mcp.call('mission_create', {
        folder: inst.repo,
        sessionId: inst.sessions.leader,
        title,
        doneWhen: `${title} works end to end`,
        steps: [{ title: `Build ${title}`, criteria }]
      })
      const id = r.payload?.missionId ?? r.payload?.id
      if (!/^mnt-/.test(id ?? ''))
        throw new Error(`mission_create refused: ${JSON.stringify(r.payload).slice(0, 300)}`)
      return {
        id,
        criteria: (await ctx.missionCriteria(id)).map(({ id: cid, text, by }) => ({
          id: cid,
          text,
          by
        }))
      }
    },
    /** The criteria of a mission's first step as `mission_get` reads them (state, `by`, who and what settled it). */
    async missionCriteria(id) {
      const g = await inst.mcp.call('mission_get', {
        folder: inst.repo,
        sessionId: inst.sessions.leader,
        missionId: id
      })
      return g.payload.steps?.[0]?.criteria ?? []
    },
    /** The mission walk fixture for a mission made by `makeMission`. */
    mission(m) {
      return JSON.parse(
        readFileSync(path.join(fixtures, 'mission-walk.json'), 'utf8')
          .replaceAll('__MISSION_ID__', m.id)
          .replaceAll('__CRITERION_OPERATOR__', m.operator)
          .replaceAll('__CRITERION_SESSION__', m.session)
      )
    },
    /** `{ checkId: 'state:closedHow' }` of a run, as the store wrote it. */
    states: (w) =>
      Object.fromEntries(
        ctx
          .readRun(w.walkId, w.runId)
          .run.checks.map((c) => [c.id, `${c.state}:${c.closedHow ?? ''}`])
      ),
    /** After a reload or a relaunch: the app is back, the folders are loaded, the owner session is on screen. */
    async afterRestart() {
      await inst.cdp.waitFor(`typeof window.api?.walkLoad === 'function'`, 60_000, 'window.api')
      await inst.paintOrRelaunch()
      await inst.cdp.waitFor(
        `(() => { const s = ${S('sessions')}; return s.folders.some((f) => f.path === ${JSON.stringify(inst.repo)}) })()`,
        60_000,
        'the folders'
      )
      await inst.cdp.eval(`${S('sessions')}.select(${JSON.stringify(inst.sessions.owner)})`)
      await sleep(800)
    },
    /** Click the copy button of a value and read the clipboard back through the renderer. */
    async copyOf(finderJs) {
      await inst.cdp
        .eval(
          `(() => { document.querySelectorAll('[data-hv-target]').forEach((e) => e.removeAttribute('data-hv-target')); const b = (${finderJs}); if (!b) return false; b.setAttribute('data-hv-target', ''); return true })()`
        )
        .then((ok) => {
          if (!ok) throw new Error(`no copy button for ${finderJs}`)
        })
      await inst.cdp.eval(`navigator.clipboard.writeText('__empty__')`)
      await inst.cdp.click('[data-hv-target]')
      await sleep(250)
      const copied = await inst.cdp.eval(
        `document.querySelector('[data-hv-target]')?.getAttribute('data-copied') === 'true'`
      )
      const clip = await inst.cdp.eval(`navigator.clipboard.readText()`)
      await sleep(1900)
      const stillCopied = await inst.cdp.eval(
        `document.querySelector('[data-hv-target]')?.getAttribute('data-copied') === 'true'`
      )
      return { clip, copied, cleared: !stillCopied }
    },
    /** The check is waiting for the agent's answer ("Running my check on check n"). */
    waitAwaiting: (ms = 20_000) =>
      inst.cdp.waitFor(
        `!!document.querySelector('[data-dsqa="walk"] [data-test="walk-awaiting"]')`,
        ms,
        'the awaiting state'
      ),
    waitText(text, ms = 20_000, root = '[data-dsqa="walk"]') {
      return inst.cdp.waitFor(
        `document.querySelector(${JSON.stringify(root)})?.textContent.includes(${JSON.stringify(text)})`,
        ms,
        `"${text}" in ${root}`
      )
    },
    /** Click an outcome button of the pane (a real, trusted click). */
    press: async (outcome) => {
      // a Done right after a new check was served is ignored on purpose (400 ms); a case that is not about the
      // debounce waits it out
      if (outcome === 'done') await sleep(450)
      await inst.cdp.click(`[data-dsqa="walk"] [data-outcome="${outcome}"]`)
    },
    /** The click itself, with no wait (the debounce case). */
    pressNow: (outcome) => inst.cdp.click(`[data-dsqa="walk"] [data-outcome="${outcome}"]`),
    clickIn: (sel, text = null) => inst.cdp.click(sel, text),
    key: (name, o) => inst.cdp.key(name, o),
    /** Focus the pane's root so a key goes to it (a click on its header text would also do). */
    focusPane: () =>
      inst.cdp.eval(
        `(() => { const r = document.querySelector('[data-dsqa="walk"]'); r.focus(); return document.activeElement === r })()`
      ),

    // ---- the verbs, as an agent calls them --------------------------------------------------------
    async open(script, { sessionId = inst.sessions.owner, folder = inst.repo } = {}) {
      const r = await inst.mcp.call('walk_open', {
        folder,
        ...(sessionId ? { sessionId } : {}),
        script
      })
      if (r.isError || !r.payload.ok)
        throw new Error(`walk_open refused: ${JSON.stringify(r.payload).slice(0, 600)}`)
      await inst.cdp.waitFor(
        `!!document.querySelector('[data-dsqa="walk"]')`,
        20_000,
        'the walk pane'
      )
      return { walkId: r.payload.walkId, runId: r.payload.runId, ack: r.payload }
    },
    verb: (name, args) => inst.mcp.call(name, { folder: inst.repo, ...args }),
    async report(w, checkId, result, evidence) {
      const r = await inst.mcp.call('walk_report', {
        folder: inst.repo,
        walkId: w.walkId,
        runId: w.runId,
        checkId,
        kind: 'check',
        result,
        evidence
      })
      return r
    },
    /** The walk file and the live run file as the store wrote them. */
    walkFile: (walkId) => path.join(inst.repo, '.harnu', 'walks', walkId, 'walk.json'),
    readWalk: (walkId) =>
      JSON.parse(
        readFileSync(path.join(inst.repo, '.harnu', 'walks', walkId, 'walk.json'), 'utf8')
      ),
    runFile: (walkId, runId) =>
      path.join(inst.repo, '.harnu', 'walks', walkId, 'runs', `${runId}.json`),
    readRun: (walkId, runId) =>
      JSON.parse(
        readFileSync(
          path.join(inst.repo, '.harnu', 'walks', walkId, 'runs', `${runId}.json`),
          'utf8'
        )
      ),
    walksDir: () => path.join(inst.repo, '.harnu', 'walks'),
    missionFiles: () => hashTree(path.join(inst.repo, '.harnu', 'missions-v4')),
    /** `walk:operate` straight over the preload (fast scaffolding for a case's setup, never the thing proven). */
    operate: (w, op, extra = {}) =>
      inst.cdp.eval(
        `window.api.walkOperate(${JSON.stringify({ folder: inst.repo, walkId: w.walkId, runId: w.runId, op, ...extra })})`
      ),
    devCall: (verb, args, folder = inst.repo) =>
      inst.cdp.eval(`window.api.walkDevCall(${JSON.stringify({ folder, verb, args })})`),

    // ---- the stub claude ----------------------------------------------------------------------------
    stubMark: () => readFileSync(inst.stubLog, 'utf8').length,
    stubSince: (mark) => clean(readFileSync(inst.stubLog, 'utf8').slice(mark)),
    async waitStub(mark, re, ms = 25_000) {
      const t0 = Date.now()
      for (;;) {
        const s = clean(readFileSync(inst.stubLog, 'utf8').slice(mark))
        if (re.test(s)) {
          // the turn is pasted line by line: wait until the file has been quiet for a moment so the whole turn is in
          let last = s.length
          for (;;) {
            await sleep(700)
            const now = clean(readFileSync(inst.stubLog, 'utf8').slice(mark))
            if (now.length === last) return now
            last = now.length
          }
        }
        if (Date.now() - t0 > ms)
          throw new Error(`the stub claude never received ${re} (got: ${s.slice(0, 300)})`)
        await sleep(250)
      }
    },
    /** How many turns (`[harnu-walk]` heads) the stub has received since `mark`. */
    turnsSince: (mark) =>
      (clean(readFileSync(inst.stubLog, 'utf8').slice(mark)).match(/\[harnu-walk\]/g) ?? []).length,

    // ---- panes and folders ------------------------------------------------------------------------------
    panesOf: (folder = inst.repo) =>
      inst.cdp
        .eval(
          `JSON.stringify((${S('helpers')}.byWorktree.get(${JSON.stringify(folder)})?.panes ?? []).map((p) => ({ id: p.id, type: p.type, url: p.url ?? p.payload?.url ?? null, path: p.path ?? p.filePath ?? p.payload?.path ?? null, payload: p.payload ?? null })))`
        )
        .then(JSON.parse),
    selectedFolder: () =>
      inst.cdp.eval(
        `${S('sessions')}.selectedFolderPath ?? ${S('sessions')}.activeFolderPath ?? null`
      ),
    /** Close every pane of every folder, put the owner session back on screen, clear any window size override. */
    async reset() {
      await inst.cdp.viewport(null)
      await inst.cdp.eval(`(() => {
        const h = ${S('helpers')}
        for (const [wt, s] of [...h.byWorktree]) for (const p of [...(s.panes ?? [])]) h.removeHelper(wt, p.id)
        const ui = ${S('ui')}
        for (const t of [...ui.toasts]) ui.dismissToast(t.id)
        ${S('sessions')}.select(${JSON.stringify(inst.sessions.owner)})
        return true
      })()`)
      await sleep(400)
    },
    /** Make sure the owner session has a live terminal running the stub (a turn needs one). */
    async ensureOwnerLive() {
      const mark0 = readFileSync(inst.stubLog, 'utf8')
      if (new RegExp(`--resume ${inst.sessions.owner}`).test(mark0) && ctx.liveStubPids().length)
        return
      await inst.cdp.eval(`${S('sessions')}.select(${JSON.stringify(inst.sessions.owner)})`)
      const t0 = Date.now()
      while (Date.now() - t0 < 30_000) {
        if (new RegExp(`--resume ${inst.sessions.owner}`).test(readFileSync(inst.stubLog, 'utf8')))
          return
        await sleep(300)
      }
      throw new Error('the owner session never started its stub claude')
    },
    /** The pids of the stub claude processes still alive (read from the stub's own START lines). */
    liveStubPids() {
      return [...readFileSync(inst.stubLog, 'utf8').matchAll(/^START pid=(\d+) (.*)$/gm)]
        .filter((m) => /--resume/.test(m[2]))
        .map((m) => ({ pid: Number(m[1]), args: m[2] }))
        .filter((p) => {
          try {
            process.kill(p.pid, 0)
            return true
          } catch {
            return false
          }
        })
    },

    // ---- evidence ---------------------------------------------------------------------------------------
    async shot(name) {
      mkdirSync(path.join(evidence, 'shots'), { recursive: true })
      const file = path.join(evidence, 'shots', `${caseId}-${name}.png`)
      // a screenshot is evidence, never an assertion: one that cannot be taken is said and the case goes on
      return inst.cdp.shot(file).then(
        () => file,
        (err) => `(no screenshot: ${err.message})`
      )
    },
    save(name, text) {
      mkdirSync(evidence, { recursive: true })
      const file = path.join(evidence, `${caseId}-${name}`)
      writeFileSync(file, typeof text === 'string' ? text : JSON.stringify(text, null, 2) + '\n')
      return file
    },
    /** The walk directories of the repo's main checkout, sorted. */
    listWalkDirs: () =>
      existsSync(path.join(inst.repo, '.harnu', 'walks'))
        ? readdirSync(path.join(inst.repo, '.harnu', 'walks')).sort()
        : [],
    fileExists: (p) => existsSync(p),
    /** Paste a screenshot into the failure form, as the operator does (a real paste event with an image file). */
    async pasteScreenshot() {
      const b64 = makePng(32, [200, 60, 60]).toString('base64')
      await inst.cdp.eval(`(() => {
        const bytes = Uint8Array.from(atob(${JSON.stringify(b64)}), (c) => c.charCodeAt(0))
        const file = new File([bytes], 'screenshot.png', { type: 'image/png' })
        const dt = new DataTransfer()
        dt.items.add(file)
        const target = document.querySelector('[data-test="walk-failure-form"]')
        target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
        return true
      })()`)
      return inst.cdp.waitFor(
        `!!document.querySelector('[data-test="walk-shot"]')`,
        10_000,
        'the attached screenshot'
      )
    }
  }
  return ctx
}
