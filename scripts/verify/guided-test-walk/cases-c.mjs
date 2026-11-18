/**
 * W-15 to W-22: the library, a past run, Re-run, Export, the sources that touch no mission, Delete, a plain sentence
 * in a never-briefed session (W-22), and the one case whose slice has not landed (W-21). Setup that is not the thing proven (finishing a run so there is something to
 * list) goes through the preload's own operator channel, the same one the pane's buttons call.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import * as path from 'node:path'
import { hashTree, makePng, sleep } from './instance.mjs'

/** Walk a run to its end with the preload's operator channel; the agent's answers come from `walk_report`. */
async function runToEnd(ctx, w, { history = null } = {}) {
  const load = (runId = w.runId) =>
    ctx.cdp.eval(
      `window.api.walkLoad(${JSON.stringify({ folder: ctx.repo, walkId: w.walkId, runId })})`
    )
  for (let i = 0; i < 60; i++) {
    const l = await load()
    if (!l.ok) throw new Error(`walk:load refused: ${JSON.stringify(l).slice(0, 200)}`)
    const run = l.run
    if (run.state === 'ended') return l
    if (run.state === 'ready') {
      await ctx.operate(w, 'start')
      continue
    }
    const c = run.checks.find((x) => x.id === run.cursor)
    if (!c) throw new Error(`the run has no current check (state ${run.state})`)
    if (history && c.id === 'c1' && c.attempts === 0) {
      const shot = await saveShot(ctx, w)
      await ctx.operate(w, 'fail', { line: history.failLine, shot })
      await ctx.devCall('report', {
        walkId: w.walkId,
        runId: w.runId,
        checkId: 'c1',
        kind: 'correction',
        text: history.correction
      })
      await ctx.operate(w, 'try-again')
    }
    await ctx.operate(w, 'done')
    if (c.hasAgentCheck)
      await ctx.devCall('report', {
        walkId: w.walkId,
        runId: w.runId,
        checkId: c.id,
        kind: 'check',
        result: 'pass',
        evidence: history?.evidence ?? 'Ran the check, expected one match, found one match'
      })
  }
  throw new Error('the run did not end in 60 steps')
}

/** A pasted screenshot saved inside the run's folder, as the pane does it. */
async function saveShot(ctx, w) {
  const b64 = makePng(48, [210, 70, 60]).toString('base64')
  const r = await ctx.cdp.eval(`(async () => {
    const data = Uint8Array.from(atob(${JSON.stringify(b64)}), (c) => c.charCodeAt(0))
    return window.api.walkSaveShot({ folder: ${JSON.stringify(ctx.repo)}, walkId: ${JSON.stringify(w.walkId)}, runId: ${JSON.stringify(w.runId)}, data })
  })()`)
  if (!r.ok) throw new Error(`walk:save-shot refused: ${JSON.stringify(r).slice(0, 200)}`)
  return r.path
}

/** Open the walk's pane on a run (the pane shows a run that ended as its close-out). */
async function showRun(ctx, w, { past = false } = {}) {
  await ctx.reset()
  await ctx.cdp.eval(
    `${ctx.S('helpers')}.addWalkHelper(${JSON.stringify(ctx.repo)}, ${JSON.stringify(w.walkId)}, ${JSON.stringify(w.runId)}${past ? ', { past: true }' : ''})`
  )
  await ctx.cdp.waitFor(`!!document.querySelector('[data-dsqa="walk"]')`, 15_000, 'the walk pane')
}

/** The library of a folder, opened as the operator would from the walk pane's header icon. */
async function openLibraryFor(ctx, folder = ctx.repo) {
  await ctx.reset()
  if (folder !== ctx.repo) {
    await ctx.cdp.eval(
      `${ctx.S('sessions')}.select(${JSON.stringify(folder === ctx.repoB ? ctx.sessions.other : ctx.sessions.owner)})`
    )
    await sleep(500)
  }
  await ctx.cdp.eval(`${ctx.S('helpers')}.addWalksHelper(${JSON.stringify(folder)})`)
  await ctx.cdp.waitFor(
    `!!document.querySelector('[data-dsqa="library"]')`,
    15_000,
    'the library pane'
  )
  await sleep(500)
}

const libRows = (ctx) =>
  ctx.cdp.eval(`[...document.querySelectorAll('[data-dsqa="library"] [data-walk-id]')].map((r) => ({
    id: r.dataset.walkId,
    title: r.querySelector('.lib-t')?.textContent.trim(),
    meta: r.querySelector('.lib-m')?.textContent.replace(/[ \\t\\r\\n]+/g, ' ').trim()
  }))`)

const rowBtn = (id, test) => `[data-dsqa="library"] [data-walk-id="${id}"] [data-test="${test}"]`

export const casesC = [
  {
    id: 'W-15',
    title: 'the library lists a finished walk',
    faults: {
      'expect-library-empty-after-walk': 'expect the library to be empty after a walk was finished'
    },
    async run(ctx, a) {
      // a fresh repo: the empty state and nothing else
      const none = await ctx.cdp.eval(
        `window.api.walkList(${JSON.stringify({ folder: ctx.repoEmpty })})`
      )
      a.ok(none.ok && none.walks.length === 0, 'a repo with no walks lists none')
      await ctx.reset()
      await ctx.cdp.eval(`${ctx.S('sessions')}.selectFolder(${JSON.stringify(ctx.repoEmpty)})`)
      await ctx.cdp.eval(`${ctx.S('helpers')}.addWalksHelper(${JSON.stringify(ctx.repoEmpty)})`)
      await ctx.cdp.waitFor(
        `!!document.querySelector('[data-test="walks-empty"]')`,
        15_000,
        'the empty state'
      )
      a.ok(
        await ctx.cdp.eval(`!document.querySelector('[data-test="walks-list"]')`),
        'the empty state shows nothing else'
      )
      await ctx.shot('empty')
      await ctx.reset() // back to the repo's own session

      // a finished walk
      const done = await ctx.open(ctx.sample())
      await runToEnd(ctx, done, { history: ctx.history })
      const entry = ctx.readWalk(done.walkId)
      a.ok(
        !!entry.lastRun && entry.lastRun.verified === 9 && entry.lastRun.total === 9,
        'the walk ended with 9 of 9 verified'
      )
      // and a live one
      const live = await ctx.open(ctx.sample())
      await ctx.operate(live, 'start')
      await ctx.operate(live, 'done')

      // the entry points: the walk pane's header icon, the folder menu and the Topbar
      await ctx.reset()
      await ctx.cdp.eval(
        `${ctx.S('helpers')}.addWalkHelper(${JSON.stringify(ctx.repo)}, ${JSON.stringify(live.walkId)}, ${JSON.stringify(live.runId)})`
      )
      await ctx.waitProgress('Check 2 of 9')
      await ctx.clickIn('[data-test="walk-library-open"]')
      await ctx.cdp.waitFor(
        `!!document.querySelector('[data-dsqa="library"]')`,
        10_000,
        'the library from the pane header'
      )
      a.ok(true, 'the walk pane header icon opens the library')
      await ctx.reset()
      await ctx.cdp.eval(`${ctx.S('sessions')}.select(${JSON.stringify(ctx.sessions.owner)})`)
      await ctx.cdp.rightClick(`[data-sidebar-row="folder:${ctx.repo}"]`)
      await ctx.clickIn('[role="menuitem"]', 'Walks')
      await ctx.cdp.waitFor(
        `!!document.querySelector('[data-dsqa="library"]')`,
        10_000,
        'the library from the folder menu'
      )
      a.ok(true, 'the folder menu item opens the library')
      await ctx.reset()
      await ctx.clickIn('[data-test="topbar-walks"]')
      await ctx.cdp.waitFor(
        `!!document.querySelector('[data-dsqa="library"]')`,
        10_000,
        'the library from the Topbar'
      )
      a.ok(true, 'the Topbar item opens the library')

      // what the rows say
      await sleep(500)
      const rows = await libRows(ctx)
      const mine = rows.find((r) => r.id === done.walkId)
      const liveRow = rows.find((r) => r.id === live.walkId)
      a.ok(
        !!mine,
        ctx.fault('expect-library-empty-after-walk')
          ? 'the library is empty'
          : 'the finished walk is listed'
      )
      if (ctx.fault('expect-library-empty-after-walk'))
        a.ok(rows.length === 0, 'the library is empty after a finished walk')
      a.ok(mine && mine.title === 'Search box on the notes list', 'the row has the walk title')
      a.ok(mine && /PR #\d+ · casey/.test(mine.meta), `the row has its source (${mine?.meta})`)
      a.ok(mine && /[A-Z][a-z]{2} \d{1,2}/.test(mine.meta), 'the row has the last run date')
      a.ok(mine && /9 of 9 passed/.test(mine.meta), 'the row has the outcome')
      a.ok(
        liveRow && /in progress, check 2 of 9/.test(liveRow.meta),
        'a live walk reads "in progress, check 2 of 9"'
      )
      await ctx.shot('list')
      // Open continues a live run and opens an ended one read-only
      await ctx.clickIn(rowBtn(live.walkId, 'walk-row-open'))
      await ctx.waitProgress('Check 2 of 9')
      a.ok(true, 'Open on a live walk continues the live run')
      await openLibraryFor(ctx)
      await ctx.clickIn(rowBtn(done.walkId, 'walk-row-open'))
      await ctx.waitState('past')
      a.ok(true, 'Open on a finished walk opens its last run read-only')
      // two worktrees of one repo see the same library
      const here = await ctx.cdp.eval(
        `window.api.walkList(${JSON.stringify({ folder: ctx.repo })})`
      )
      const there = await ctx.cdp.eval(
        `window.api.walkList(${JSON.stringify({ folder: ctx.repoB })})`
      )
      a.eq(
        there.walks.map((x) => x.walkId),
        here.walks.map((x) => x.walkId),
        'two worktrees of the repo list the same walks'
      )
      await openLibraryFor(ctx, ctx.repoB)
      const rowsB = await libRows(ctx)
      a.ok(
        rowsB.some((r) => r.id === done.walkId) && rowsB.some((r) => r.id === live.walkId),
        "and the second worktree's pane shows them"
      )
    }
  },

  {
    id: 'W-16',
    title: 'a past run opens read-only with its notes',
    faults: { 'expect-past-editable': 'expect a past run to offer Done' },
    async run(ctx, a) {
      const w = await ctx.open(ctx.sample())
      await runToEnd(ctx, w, { history: ctx.history })
      // a check found later: it is added after run 1 ended
      const ext = await ctx.verb('walk_extend', {
        walkId: w.walkId,
        append: [
          {
            id: 'c10',
            title: 'The box has a label',
            why: 'A screen reader needs a name for the box.',
            where: { text: 'The Notes page' },
            do: [{ text: 'Focus the search box', see: 'A label is read out' }],
            passes: 'The label reads Search notes.',
            fails: 'The box is read out with no name.',
            nothingFromHere: 'Only a screen reader says it.'
          }
        ]
      })
      a.ok(!ext.isError && ext.payload.ok !== false, 'a check is appended after the run ended')
      // run 2
      const rr = await ctx.cdp.eval(
        `window.api.walkRerun(${JSON.stringify({ folder: ctx.repo, walkId: w.walkId })})`
      )
      a.ok(rr.ok && rr.kind === 'rerun' && rr.n === 2, 'Re-run starts run 2')
      const w2 = { walkId: w.walkId, runId: rr.runId }
      await runToEnd(ctx, w2, { history: ctx.history })
      // the library opens the latest run read-only
      await openLibraryFor(ctx)
      await ctx.clickIn(rowBtn(w.walkId, 'walk-row-open'))
      await ctx.waitState('past')
      const p = await ctx.pane()
      a.ok(/Read-only/.test(p.text), 'the past run says it is read-only')
      a.ok(
        !ctx.fault('expect-past-editable')
          ? !p.outcomes.includes('done')
          : p.outcomes.includes('done'),
        'it offers no Done'
      )
      a.ok(p.outcomes.includes('rerun'), 'it offers Re-run')
      // the run selector lists the walk's runs and opens the older one
      await ctx.clickIn('[data-test="walk-run-select"]')
      const options = await ctx.cdp.eval(
        `[...document.querySelectorAll('[data-dsqa="walk"] [role="option"]')].map((o) => o.textContent.trim())`
      )
      a.eq(options.length, 2, 'the header lists both runs')
      await ctx.cdp.click(`[data-dsqa="walk"] [role="option"][data-run="${w.runId}"]`)
      await ctx.cdp.waitFor(
        `/Run 1/.test(document.querySelector('[data-test="walk-run-select"]')?.textContent ?? '')`,
        8000,
        'run 1 selected'
      )
      const rows = await ctx.cdp.eval(
        `[...document.querySelectorAll('[data-dsqa="walk"] [data-dsqa-part="closeout-row"] .t')].map((e) => e.textContent.trim())`
      )
      a.ok(
        rows.includes('Notes list loads') && rows.includes('Reload keeps no stale rows'),
        'run 1 lists its checks'
      )
      a.ok(!rows.includes('The box has a label'), 'and hides the check added after it ended')
      // its notes
      const text = (await ctx.pane()).text
      a.ok(text.includes(ctx.history.failLine), "the operator's recorded failure line")
      a.ok(text.includes(ctx.history.correction), "the agent's recorded correction")
      a.ok(text.includes(ctx.history.evidence), "the agent's recorded evidence")
      a.ok(
        await ctx.cdp.eval(`!!document.querySelector('[data-test="walk-past-shot"] img')`),
        'the screenshot thumbnail is drawn'
      )
      await ctx.shot('past')
      // the thumbnail opens the lightbox
      await ctx.clickIn('[data-test="walk-past-shot"]')
      let lightbox = false
      for (let i = 0; i < 12 && !lightbox; i++) {
        lightbox = await ctx.cdp.eval(
          `!!document.querySelector('[data-dsqa="walk"] [data-dsqa-part="lightbox"]')`
        )
        if (!lightbox) await sleep(250)
      }
      const other = (await ctx.panesOf()).filter((x) => x.type === 'markdown').map((x) => x.path)
      a.ok(
        lightbox,
        `the thumbnail opens the lightbox${other.length ? ` (it opened ${other.join(', ')} in the viewer instead)` : ''}`
      )
      if (lightbox) {
        await ctx.key('Escape')
        a.ok(
          await ctx.cdp.waitFor(
            `!document.querySelector('[data-dsqa="walk"] [data-dsqa-part="lightbox"]')`,
            5000,
            'the lightbox closed'
          ),
          'Esc closes it'
        )
      }
    }
  },

  {
    id: 'W-17',
    title: 'Re-run is a fresh run with last-time hints',
    faults: { 'expect-run1-changes': 'expect run 1 to change when run 2 starts' },
    async run(ctx, a) {
      const w = await ctx.open(ctx.sample())
      await runToEnd(ctx, w, { history: ctx.history })
      const run1 = ctx.runFile(w.walkId, w.runId)
      const run1Folder = path.join(path.dirname(run1), w.runId)
      const before = { file: readFileSync(run1, 'utf8'), folder: hashTree(run1Folder) }
      await openLibraryFor(ctx)
      await ctx.clickIn(rowBtn(w.walkId, 'walk-row-rerun'))
      await ctx.waitState('roadmap')
      const p = await ctx.pane()
      a.ok(
        /Same 11 checks · run 2/.test(p.text) || /run 2/.test(p.text),
        'the roadmap says it is run 2 of the same checks'
      )
      const hints = await ctx.cdp.eval(
        `document.querySelectorAll('[data-dsqa="walk"] [data-dsqa-part="roadmap-row"] [data-dsqa-part="last-time"]').length`
      )
      a.eq(hints, 11, 'every check, the pre-closed rows included, has a "last time" hint')
      const walk = ctx.readWalk(w.walkId)
      const runs = readdirSync(path.join(ctx.walksDir(), w.walkId, 'runs')).filter((f) =>
        f.endsWith('.json')
      )
      a.eq(runs.length, 2, 'the walk now has two runs')
      const run2Id = runs.map((f) => f.replace('.json', '')).find((r) => r !== w.runId)
      const run2 = ctx.readRun(w.walkId, run2Id).run
      a.ok(
        run2.checks.every((c) => c.countable && c.state === 'todo'),
        'run 2 has every check to do, the pre-closed rows included'
      )
      // run 2's outcomes are its own
      await ctx.press('start')
      await ctx.waitProgress('Check 1 of 11')
      await ctx.press('done')
      await ctx.waitProgress('Check 2 of 11')
      const after = { file: readFileSync(run1, 'utf8'), folder: hashTree(run1Folder) }
      a.eq(
        JSON.stringify(after) === JSON.stringify(before),
        !ctx.fault('expect-run1-changes'),
        'run 1 is byte-identical after run 2 has moved'
      )
      // a second Re-run while run 2 is live opens run 2
      await openLibraryFor(ctx)
      await ctx.clickIn(rowBtn(w.walkId, 'walk-row-rerun'))
      await ctx.waitProgress('Check 2 of 11')
      const again = readdirSync(path.join(ctx.walksDir(), w.walkId, 'runs')).filter((f) =>
        f.endsWith('.json')
      ).length
      a.eq(again, 2, 'a second Re-run while run 2 is live makes no third run')
      a.eq(
        ctx.readWalk(w.walkId).live?.runId ?? ctx.readWalk(w.walkId).live,
        walk.live ?? run2Id,
        'run 2 is still the live run'
      )
      await ctx.shot('rerun')
    }
  },

  {
    id: 'W-18',
    title: 'Export writes the Markdown',
    faults: { 'expect-export-overwritten': 'expect the second Export to overwrite the first' },
    async run(ctx, a) {
      const w = await ctx.open(ctx.sample())
      await runToEnd(ctx, w, { history: ctx.history })
      await showRun(ctx, w)
      await ctx.waitState('closeout')
      const exportsDir = path.join(ctx.walksDir(), w.walkId, 'exports')
      const listing = () => (existsSync(exportsDir) ? readdirSync(exportsDir).sort() : [])
      a.eq(listing(), [], 'nothing is exported yet')
      await ctx.clickIn('[data-dsqa="walk"] [data-dsqa-part="saved"] button', 'Export markdown')
      let first = []
      for (let i = 0; i < 30 && !first.length; i++) {
        first = listing()
        if (!first.length) await sleep(250)
      }
      a.eq(first.length, 1, 'Export writes one folder')
      const md1 = path.join(
        exportsDir,
        first[0],
        readdirSync(path.join(exportsDir, first[0])).find((f) => f.endsWith('.md')) ?? 'missing.md'
      )
      a.ok(existsSync(md1), 'with a Markdown file in it')
      const text = existsSync(md1) ? readFileSync(md1, 'utf8') : ''
      a.ok(text.includes('Search box on the notes list'), 'the title')
      a.ok(/PR #\d+/.test(text) && text.includes('casey'), 'the source line')
      for (const t of [
        'Open the Notes page',
        'An empty result says so',
        'Reload keeps no stale rows'
      ])
        a.ok(text.includes(t), `the check "${t}"`)
      a.ok(text.includes(ctx.inst.preview), 'the links')
      a.ok(
        /Last run/i.test(text) && text.includes(ctx.history.failLine),
        "the Last run table with the operator's note"
      )
      ctx.save('export.md', text)
      let md = null
      for (let i = 0; i < 20 && !md; i++) {
        md =
          (await ctx.panesOf()).find((p) => p.type === 'markdown' && String(p.path).endsWith('.md'))
            ?.path ?? null
        if (!md) await sleep(250)
      }
      a.ok(!!md && md.startsWith(path.join(exportsDir, first[0])), 'the file opens in the viewer')
      // a second Export never overwrites the first
      const sha1 = hashTree(path.join(exportsDir, first[0]))
      await ctx.reset()
      await showRun(ctx, w)
      await ctx.waitState('closeout')
      await ctx.clickIn('[data-dsqa="walk"] [data-dsqa-part="saved"] button', 'Export markdown')
      let second = []
      for (let i = 0; i < 30 && second.length < 2; i++) {
        second = listing()
        if (second.length < 2) await sleep(250)
      }
      a.eq(
        second.length,
        ctx.fault('expect-export-overwritten') ? 1 : 2,
        'a second Export makes a second folder'
      )
      a.eq(
        hashTree(path.join(exportsDir, first[0])),
        sha1,
        'and the first export is byte-identical'
      )
    }
  },

  {
    id: 'W-19',
    title: 'PR, feature, branch and card walks touch no mission',
    faults: { 'expect-settle-button': 'expect a Settle button on a PR walk' },
    async run(ctx, a) {
      const m = await ctx.makeMission()
      void m
      const before = ctx.missionFiles()
      a.ok(Object.keys(before).length > 0, 'the throwaway repo has a mission record to protect')
      // a card on the board for the card source
      const card = await ctx.verb('create_card', {
        title: 'Search box polish',
        kind: 'feature',
        body: 'Polish the notes search box.'
      })
      const slug = card.payload.slug ?? card.payload.card?.slug ?? card.payload.id
      a.ok(!card.isError && !!slug, `a card is on the board (${slug})`)
      const branch = ctx.sample()
      branch.source = { kind: 'branch', branch: 'feature/notes-search', base: 'main' }
      const cardWalk = ctx.sample()
      cardWalk.source = { kind: 'card', slug }
      const walks = [
        ['a PR', ctx.sample()],
        ['a feature', ctx.learn()],
        ['a branch', branch],
        ['a card', cardWalk]
      ]
      for (const [what, script] of walks) {
        const w = await ctx.open(script)
        await runToEnd(ctx, w)
        await showRun(ctx, w)
        await ctx.waitState('closeout')
        const controls = await ctx.cdp.eval(
          `[...document.querySelectorAll('[data-dsqa="walk"] button')].map((b) => b.textContent.trim().toLowerCase())`
        )
        const settle = controls.some((t) => /settle|mark done|tick|approve/.test(t))
        a.eq(
          settle,
          ctx.fault('expect-settle-button') && what === 'a PR',
          `${what}: the pane has no Settle button`
        )
        const t = (await ctx.pane()).text
        a.ok(
          !/criterion (open|settled)/.test(t) &&
            !/I never tick/.test(t) &&
            !(await ctx.cdp.eval(`!!document.querySelector('[data-test="walk-open-mission"]')`)),
          `${what}: the close-out shows no criterion and no link to Mark done`
        )
      }
      a.eq(ctx.missionFiles(), before, 'every mission file is byte-identical after all four walks')
    }
  },

  {
    id: 'W-20',
    title: 'Delete removes only the walk and its runs',
    faults: {
      'click-delete-for-cancel':
        'press Delete where Cancel is named (the walk really goes, and Cancel is expected to leave it)'
    },
    async run(ctx, a) {
      const keep = await ctx.open(ctx.sample())
      await runToEnd(ctx, keep)
      const gone = await ctx.open(ctx.sample())
      await runToEnd(ctx, gone, { history: ctx.history })
      const missions = ctx.missionFiles()
      const keepBefore = hashTree(path.join(ctx.walksDir(), keep.walkId))
      const others = readdirSync(ctx.walksDir()).filter((d) => d !== gone.walkId)
      const othersBefore = Object.fromEntries(
        others.map((d) => [d, hashTree(path.join(ctx.walksDir(), d))])
      )
      await openLibraryFor(ctx)
      // Cancel leaves the directory and the row
      await ctx.clickIn(rowBtn(gone.walkId, 'walk-row-menu'))
      await ctx.clickIn(rowBtn(gone.walkId, 'walk-row-delete'))
      await ctx.cdp.waitFor(
        `!!document.querySelector('[data-dsqa="library"] [data-test="walk-delete-confirm"]')`,
        8000,
        'the confirmation'
      )
      a.ok(true, 'Delete asks first')
      const ask = await ctx.cdp.eval(
        `document.querySelector('[data-test="walk-delete-confirm"] .ask')?.textContent ?? ''`
      )
      a.ok(
        /Search box on the notes list/.test(ask) && /run/.test(ask),
        `the question names the walk and its runs (${ask})`
      )
      await ctx.clickIn(
        '[data-test="walk-delete-confirm"] button',
        ctx.fault('click-delete-for-cancel') ? 'Delete' : 'Keep it'
      )
      await sleep(800)
      a.ok(existsSync(path.join(ctx.walksDir(), gone.walkId)), "Cancel leaves the walk's directory")
      a.ok(
        (await libRows(ctx)).some((r) => r.id === gone.walkId),
        'Cancel leaves its row'
      )
      // confirm removes the directory and the row, and nothing else
      if (existsSync(path.join(ctx.walksDir(), gone.walkId))) {
        await ctx.clickIn(rowBtn(gone.walkId, 'walk-row-menu'))
        await ctx.clickIn(rowBtn(gone.walkId, 'walk-row-delete'))
        await ctx.clickIn(
          rowBtn(gone.walkId, 'walk-delete-yes').replace(
            `[data-walk-id="${gone.walkId}"] `,
            '[data-walk-id="' + gone.walkId + '"] '
          )
        )
        for (let i = 0; i < 20 && existsSync(path.join(ctx.walksDir(), gone.walkId)); i++)
          await sleep(250)
      }
      a.ok(
        !existsSync(path.join(ctx.walksDir(), gone.walkId)),
        "Delete removes the walk's directory, runs included"
      )
      await sleep(800)
      a.ok(!(await libRows(ctx)).some((r) => r.id === gone.walkId), 'Delete removes its row')
      a.eq(
        hashTree(path.join(ctx.walksDir(), keep.walkId)),
        keepBefore,
        'another walk is byte-identical'
      )
      a.eq(
        Object.fromEntries(
          readdirSync(ctx.walksDir()).map((d) => [d, hashTree(path.join(ctx.walksDir(), d))])
        ),
        othersBefore,
        'no other walk was touched'
      )
      a.eq(ctx.missionFiles(), missions, 'and no mission file')
    }
  },

  {
    id: 'W-21',
    title: 'Test it in the Mission dropdown names the source',
    pendingUntil: { file: 'src/main/walk/walk-request.ts', slice: 'S-7' },
    async run() {
      throw new Error(
        'slice S-7 has landed: write the case (Test it on a step, a milestone and the mission, then the walk opens in the helper stack)'
      )
    }
  },

  {
    id: 'W-22',
    title: 'a plain sentence opens a walk through the skill',
    faults: {
      'expect-other-skill': 'expect the staged skill to be named "walks" (the skill is "walk")',
      'expect-deferred-verb': 'expect walk_get to be deferred, with no alwaysLoad'
    },
    /**
     * A fresh install and a NEW session of a folder with no mission and no walk, never briefed about walks. Proven
     * here: the `walk` skill is staged by default (no switch was ever touched), the four verbs are listed with
     * `alwaysLoad`, and a plain sentence typed into that session's terminal reaches the stub `claude`, which (scripted:
     * it is the one thing a model does) calls `walk_get` then `walk_open` through the control server it was spawned
     * with; the walk opens in that session's folder. What is NOT proven here, and is checked by hand: that a real
     * model picks the skill from the sentence, and the client's own deferral of tools.
     */
    async run(ctx, a) {
      const inst = ctx.inst
      const SENTENCE = 'walk me through what we just built'
      const CORE = ['walk_open', 'walk_extend', 'walk_report', 'walk_get']

      // the starting point: a fresh install, a folder with no mission and no walk
      a.ok(
        !existsSync(path.join(inst.userData, 'bundled-skills.json')),
        'a fresh install: Settings → Skills was never touched'
      )
      a.ok(
        !existsSync(path.join(ctx.repoEmpty, '.harnu', 'missions-v4')),
        'the folder has no mission'
      )
      a.ok(!existsSync(path.join(ctx.repoEmpty, '.harnu', 'walks')), 'the folder has no walk')

      // the four verbs are listed with alwaysLoad, and an ordinary verb is not (so the flag means something)
      const tools = await ctx.mcp.list()
      const loads = (n) => tools.find((t) => t.name === n)?._meta?.['anthropic/alwaysLoad'] === true
      for (const n of CORE)
        a.eq(
          loads(n),
          ctx.fault('expect-deferred-verb') && n === 'walk_get' ? false : true,
          `${n} is listed with alwaysLoad`
        )
      a.ok(!loads('create_worktree'), 'an ordinary verb (create_worktree) stays deferred')

      // a NEW session of that folder: its `claude` starts with the plugin dir Harnu staged for it
      const mark = ctx.stubMark()
      const id = await ctx.cdp.eval(
        `${ctx.S('sessions')}.createNewSession(${JSON.stringify(ctx.repoEmpty)})`
      )
      a.ok(/^synthetic-/.test(id ?? ''), 'a new session was made in the folder')
      const started = await ctx.waitStub(mark, /START pid=\d+ [^\n]*--plugin-dir /, 40_000)
      const dir = /--plugin-dir (\S+)/.exec(started)?.[1] ?? ''
      a.ok(
        dir.startsWith(path.join(inst.userData, 'skills')),
        'the plugin dir is under the userData'
      )
      const staged = existsSync(path.join(dir, 'skills'))
        ? readdirSync(path.join(dir, 'skills'))
        : []
      a.eq(
        staged.sort(),
        [ctx.fault('expect-other-skill') ? 'walks' : 'walk'],
        'the skills staged into a new session of a fresh install'
      )
      const skillFile = path.join(dir, 'skills', 'walk', 'SKILL.md')
      a.ok(existsSync(skillFile), 'walk/SKILL.md is staged')
      a.ok(
        existsSync(path.join(dir, 'skills', 'walk', 'references', 'panel-contract.md')),
        "the skill's self-contained contract is staged with it"
      )
      a.ok(
        existsSync(skillFile) &&
          /walk me through what we just built/.test(readFileSync(skillFile, 'utf8')),
        'the staged description names the plain-sentence trigger'
      )

      // the operator types the plain sentence into that session's terminal (a trusted keyboard, not a verb)
      await ctx.cdp.waitFor(
        `!!document.querySelector('.xterm-helper-textarea')`,
        30_000,
        "the new session's terminal"
      )
      await ctx.cdp.eval(`document.querySelector('.xterm-helper-textarea').focus()`)
      await ctx.cdp.type(SENTENCE)
      await ctx.key('Enter')
      const got = await ctx.waitStub(mark, /STUB-WALK \{[^\n]*\}/, 60_000)
      a.ok(got.includes(SENTENCE), 'the stub claude received the plain sentence')

      // what the scripted session did with the control server it was spawned with
      const line = got.split('\n').find((l) => l.startsWith('STUB-WALK '))
      const r = JSON.parse(line.slice('STUB-WALK '.length))
      a.ok(r.ok === true, `the scripted session opened a walk (${JSON.stringify(r).slice(0, 200)})`)
      for (const n of CORE)
        a.ok(r.alwaysLoad?.[n] === true, `${n} was visible to that session on turn one`)
      a.eq(r.before?.walks, 0, 'walk_get found no walk for the source before it wrote one')
      a.eq(r.opened?.checks, 2, 'walk_open took the whole script')
      a.eq(r.opened?.opened, true, "walk_open put the pane in that session's folder")

      // the walk is saved in that folder, opened there, and touched no mission
      const walkId = r.opened?.walkId
      a.ok(/^wlk-/.test(walkId ?? ''), 'walk_open returned a walk id')
      const walkFile = path.join(ctx.repoEmpty, '.harnu', 'walks', walkId ?? 'none', 'walk.json')
      a.ok(existsSync(walkFile), "the walk is saved under the session's folder")
      a.ok(
        !existsSync(path.join(ctx.repo, '.harnu', 'walks', walkId ?? 'none')),
        'and not in another repo'
      )
      a.ok(!existsSync(path.join(ctx.repoEmpty, '.harnu', 'missions-v4')), 'no mission was written')
      await ctx.cdp.waitFor(
        `!!document.querySelector('[data-dsqa="walk"]')`,
        20_000,
        'the walk pane'
      )
      const panes = await ctx.panesOf(ctx.repoEmpty)
      a.ok(
        panes.some((p) => p.type === 'walk'),
        "a walk pane is in that folder's helper stack"
      )
      await ctx.waitState('roadmap')
      const p = await ctx.pane()
      a.ok(
        p.text.includes('Check the notes search box'),
        'the pane shows the walk the session wrote'
      )
      a.ok(p.text.includes('2 checks'), 'the roadmap says how many checks there are')
      await ctx.shot('plain-sentence-walk')
    }
  },

  {
    id: 'W-12',
    title: "the operator's files are untouched",
    guard: true,
    faults: {
      'guard-stale-snapshot':
        'compare against a before-snapshot that was altered (an operator file changed)'
    },
    async run() {
      /* the runner decides this one after the instance is gone (see guided-test-walk.mjs) */
    }
  }
]
void existsSync
