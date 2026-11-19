/**
 * W-1 to W-6: the walk's life on a real pane (load, one check, Done, Failed, Back and Skip, Explain more).
 * Every case opens its own walk (its own source), so no case depends on another one's state.
 */

const TITLES = {
  c1: 'Open the Notes page',
  c2: 'Type a word in the search box',
  c3: 'The filter keeps the list order',
  c4: 'An empty result says so',
  c5: 'Escape clears the box',
  c6: 'The count line follows the filter',
  c7: 'Search ignores letter case',
  c8: 'Box stays visible on a narrow window',
  c9: 'Reload keeps no stale rows'
}
export { TITLES }

export const casesA = [
  {
    id: 'W-1',
    title: 'loads a sample walk',
    faults: { 'expect-ten-checks': 'expect ten checks to walk (the sample has nine)' },
    async run(ctx, a) {
      const script = ctx.sample()
      const w = await ctx.open(script)
      // walk_open took the whole script
      a.eq(w.ack.checks, 11, 'walk_open: checks in the script')
      a.eq(w.ack.toWalk, ctx.fault('expect-ten-checks') ? 10 : 9, 'walk_open: checks to walk')
      a.eq(w.ack.opened, true, 'walk_open: the pane was put in the helper stack')
      const panes = await ctx.panesOf()
      a.ok(
        panes.some((p) => p.type === 'walk'),
        "a walk pane is in the folder's helper stack"
      )
      // the roadmap, with the PR source line
      await ctx.waitState('roadmap')
      const p = await ctx.pane()
      const src = script.source
      a.eq(
        p.source.replace(/\s+/g, ' ').replace(/\s*Re-run.*$/, ''),
        `PR #${src.number} · ${src.title} · ${src.author}`,
        'the PR source line'
      )
      a.ok(p.outcomes.includes('start'), 'the roadmap offers Start with 1')
      a.ok(p.text.includes('9 checks'), 'the roadmap says how many checks there are')
      for (const t of Object.values(TITLES)) a.ok(p.text.includes(t), `the roadmap lists "${t}"`)
      await ctx.shot('roadmap')
      // Start with 1 opens Check 1 of 9
      await ctx.press('start')
      await ctx.waitState('check')
      a.eq((await ctx.pane()).progress, 'Check 1 of 9', 'Start opens Check 1 of 9')
      // and Enter does the same on another walk
      await ctx.reset()
      const w2 = await ctx.open(ctx.sample())
      await ctx.waitState('roadmap')
      await ctx.focusPane()
      await ctx.key('Enter')
      await ctx.waitState('check')
      a.eq((await ctx.pane()).progress, 'Check 1 of 9', 'Enter on the roadmap starts the walk')
      void w2
      // a broken script is refused whole: nothing saved, no pane
      const dirsBefore = ctx.listWalkDirs()
      const broken = ctx.sample()
      delete broken.checks[3].where // check 3: no where
      broken.checks[4].do[0].block = { text: 'rm -rf <target-folder>' } // check 4: a placeholder in a command
      const bad = await ctx.verb('walk_open', { script: broken, sessionId: ctx.sessions.owner })
      const rejected = bad.payload.rejected ?? bad.payload.error?.rejected ?? []
      a.ok(bad.isError || bad.payload.ok === false, 'a broken script is refused')
      a.ok(rejected.length >= 2, `every violation is listed (got ${rejected.length})`)
      a.ok(
        rejected.some((r) => /where/.test(r.path)) &&
          rejected.some((r) => /PLACEHOLDER/.test(r.rule)),
        'the violations name their paths and rules'
      )
      a.eq(ctx.listWalkDirs(), dirsBefore, 'a refused script saves nothing')
    }
  },

  {
    id: 'W-2',
    title: 'renders check 1 only',
    faults: { 'expect-two-checks': 'expect two checks in the DOM (only one is rendered)' },
    async run(ctx, a) {
      const w = await ctx.open(ctx.sample())
      await ctx.press('start')
      await ctx.waitProgress('Check 1 of 9')
      const p = await ctx.pane()
      a.eq(
        p.checkTitles.length,
        ctx.fault('expect-two-checks') ? 2 : 1,
        'one check title in the DOM'
      )
      a.eq(p.checkTitles[0], TITLES.c1, 'it is check 1')
      a.ok(!p.text.includes(TITLES.c2), 'nothing of check 2 (its title is absent)')
      const part = (name) =>
        ctx.cdp.eval(`!!document.querySelector('[data-dsqa="walk"] [data-dsqa-part="${name}"]')`)
      for (const name of ['do', 'where', 'see', 'check'])
        a.ok(await part(name), `the "${name}" section is drawn`)
      a.ok(
        /Start the dev server/.test(p.text) && /npm run dev -- --port 4173/.test(p.text),
        'Do: the step and its command block'
      )
      a.ok(/Preview page/.test(p.text), 'Where: the link chip')
      a.ok(/The page shows four notes and an empty search box/.test(p.text), 'You should see')
      a.ok(
        /✗/.test(p.text) && /The page is blank, or the search box is missing/.test(p.text),
        'the ✗ Not line'
      )
      a.ok(
        /Nothing from here/i.test(p.text),
        "I'll check: nothing from here (no agent check on this one)"
      )
      // a check with an agent check, a table and an image: drawn on its own check
      await ctx.press('done')
      await ctx.waitProgress('Check 2 of 9')
      await ctx.press('done')
      await ctx.waitProgress('Check 3 of 9')
      const p3 = await ctx.pane()
      a.ok(
        p3.text.includes('grep -c data-note src/notes/list.js'),
        "I'll check: the agent's command"
      )
      a.ok(
        p3.text.includes('Already proved: the list helper filters without sorting'),
        "the precheck is the first line of I'll check"
      )
      a.ok(
        await ctx.cdp.eval(`!!document.querySelector('[data-dsqa="walk"] figure.shot img')`),
        'the expected image is drawn'
      )
      a.ok(!p3.text.includes(TITLES.c4), 'still nothing of check 4')
      await ctx.press('done') // c3 has an agent check: it awaits a report
      await ctx.waitAwaiting()
      await ctx.report(w, 'c3', 'pass', 'Ran the grep, expected one match, found one match')
      await ctx.waitProgress('Check 4 of 9')
      const p4 = await ctx.pane()
      a.ok(
        await ctx.cdp.eval(`!!document.querySelector('[data-dsqa="walk"] table.exp-table')`),
        'the table is drawn under You should see'
      )
      a.ok(/No notes match/.test(p4.text) && /search\.js/.test(p4.text), 'the table rows are there')
      await ctx.shot('check-4')
      // why is the script's "what this is" line; the pane's check card does not draw it (see the report)
    }
  },

  {
    id: 'W-3',
    title: 'Done advances and reaches the session',
    faults: {
      'expect-turn-on-plain-done': 'expect a turn for a Done on a check with no agent check'
    },
    async run(ctx, a) {
      const w = await ctx.open(ctx.sample())
      await ctx.ensureOwnerLive()
      await ctx.press('start')
      await ctx.waitProgress('Check 1 of 9')
      // a check without an agent check: Done advances, sends no turn
      const m1 = ctx.stubMark()
      await ctx.press('done')
      await ctx.waitProgress('Check 2 of 9')
      await ctx.sleep(2500) // the paste waits for 1.5 s of quiet; give a wrongly sent turn time to land
      a.eq(
        ctx.turnsSince(m1),
        ctx.fault('expect-turn-on-plain-done') ? 1 : 0,
        'Done with no agent check sends no turn'
      )
      a.ok((await ctx.pane()).outcomes.includes('done'), 'the next check asks for an answer')
      // on to check 3, which has an agent check
      await ctx.press('done')
      await ctx.waitProgress('Check 3 of 9')
      const m3 = ctx.stubMark()
      await ctx.press('done')
      await ctx.waitAwaiting()
      const turn = await ctx.waitStub(m3, /\[harnu-walk\][^\n]*done/)
      a.ok(
        /\[harnu-walk\] Search box on the notes list — check 3 of 9 · done/.test(turn),
        'the turn names the walk, the check number and the kind'
      )
      a.ok(
        turn.includes(w.walkId) && turn.includes(w.runId) && /check: c3/.test(turn),
        'the turn carries the walk, run and check ids'
      )
      a.ok(/grep -c data-note/.test(turn), 'the turn carries how to check')
      // the progress line of that turn counts the plain Dones that sent nothing
      a.ok(
        /progress: ✓ 2 · ! 0 · ✗ 0 · - 7/.test(turn),
        'the turn ends with a progress line that counts the two plain Dones'
      )
      ctx.save('turn-done.txt', turn)
      const r = await ctx.report(
        w,
        'c3',
        'pass',
        'Ran the grep, expected one match, found one match'
      )
      a.ok(!r.isError && r.payload.ok !== false, 'walk_report pass accepted')
      await ctx.waitProgress('Check 4 of 9')
      // a "nothing from here" check closes as confirmed (not verified by the agent)
      const run = ctx.readRun(w.walkId, w.runId)
      const states = Object.fromEntries(
        run.run.checks.map((c) => [c.id, c.state + (c.how ? `:${c.how}` : '')])
      )
      ctx.save('run-states.json', states)
      a.ok(/verified/.test(states.c1), 'c1 (nothing from here) is verified')
      a.ok(
        /done-nothing/.test(JSON.stringify(run.run.checks.find((c) => c.id === 'c1'))),
        'c1 closed as "confirmed, nothing to check from here"'
      )
      a.ok(/verified/.test(states.c3), 'c3 closed on the report')
    }
  },

  {
    id: 'W-4',
    title: 'Failed needs a line, re-serves, escalates',
    faults: { 'expect-no-attempt-2': 'expect the second correction to be accepted' },
    async run(ctx, a) {
      const w = await ctx.open(ctx.sample())
      await ctx.press('start')
      await ctx.waitProgress('Check 1 of 9')
      await ctx.press('failed')
      await ctx.waitState('failed-form')
      a.ok(
        (await ctx.pane()).disabled.includes('send'),
        'Send is disabled with no line and no image'
      )
      await ctx.clickIn('[data-test="walk-failure-line"]')
      await ctx.cdp.type(ctx.history.failLine)
      a.ok(!(await ctx.pane()).disabled.includes('send'), 'a line enables Send')
      a.ok(await ctx.pasteScreenshot(), 'a pasted image is attached')
      const m = ctx.stubMark()
      await ctx.press('send')
      const turn = await ctx.waitStub(m, /\[harnu-walk\][^\n]*failed/)
      a.ok(turn.includes(ctx.history.failLine), "the stub receives the operator's line")
      const shotPath = /screenshot: (\S+)/.exec(turn)?.[1]
      a.ok(
        !!shotPath && shotPath.includes(`/${w.runId}/shots/`),
        'the stub receives the saved screenshot path inside the run folder'
      )
      a.ok(!!shotPath && ctx.fileExists(shotPath), 'the screenshot is a real file')
      // the same check is served again, with its correction pending
      await ctx.waitState('check')
      a.eq((await ctx.pane()).progress, 'Check 1 of 9', 'a failure does not move the cursor')
      await ctx.waitText('You reported')
      const c1 = await ctx.verb('walk_report', {
        walkId: w.walkId,
        runId: w.runId,
        checkId: 'c1',
        kind: 'correction',
        text: ctx.history.correction
      })
      a.ok(!c1.isError && c1.payload.ok !== false, 'one correction is accepted')
      await ctx.waitText(ctx.history.correction)
      a.ok((await ctx.pane()).text.includes('Same step, again'), 'the same check is served again')
      const c2 = await ctx.verb('walk_report', {
        walkId: w.walkId,
        runId: w.runId,
        checkId: 'c1',
        kind: 'correction',
        text: 'A second one'
      })
      a.eq(
        c2.isError || c2.payload.ok === false,
        !ctx.fault('expect-no-attempt-2'),
        'a second correction before the operator answers is refused'
      )
      a.ok(/CORRECTION_PENDING/.test(JSON.stringify(c2.payload)), 'with its own code')
      a.eq(
        ctx.readRun(w.walkId, w.runId).run.checks.find((x) => x.id === 'c1').attempts,
        1,
        'one failure so far'
      )
      a.ok(
        !(await ctx.cdp.eval(`!!document.querySelector('[data-test="walk-door"]')`)),
        'no escalation door after one failure'
      )
      // Try again, fail a second time: the door appears
      await ctx.press('try-again')
      await ctx.waitOutcome('done')
      await ctx.press('failed')
      await ctx.waitState('failed-form')
      await ctx.clickIn('[data-test="walk-failure-line"]')
      await ctx.cdp.type('Still nothing happens after I click in the box')
      const m2 = ctx.stubMark()
      await ctx.press('send')
      await ctx.waitStub(m2, /\[harnu-walk\][^\n]*failed/)
      await ctx.waitState('check')
      a.eq(
        ctx.readRun(w.walkId, w.runId).run.checks.find((x) => x.id === 'c1').attempts,
        2,
        'the second failure is attempt 2'
      )
      await ctx.verb('walk_report', {
        walkId: w.walkId,
        runId: w.runId,
        checkId: 'c1',
        kind: 'correction',
        text: 'Reload the page first'
      })
      await ctx.waitText('Reload the page first')
      a.ok(
        await ctx.cdp.eval(`!!document.querySelector('[data-test="walk-door"]')`),
        'from the second failure the escalation door appears'
      )
      const walksBefore = ctx.listWalkDirs()
      const m3 = ctx.stubMark()
      await ctx.clickIn('[data-test="walk-door"]')
      const esc = await ctx.waitStub(m3, /\[harnu-walk\][^\n]*escalate/)
      a.ok(/source: pr/.test(esc), 'the escalate turn names the source kind')
      await ctx.sleep(2500)
      a.eq(ctx.turnsSince(m3), 1, 'the door sends one escalate turn')
      a.eq(ctx.listWalkDirs(), walksBefore, 'the pane created nothing')
      ctx.save('turn-failed.txt', turn)
      ctx.save('turn-escalate.txt', esc)
    }
  },

  {
    id: 'W-5',
    title: 'Back, Skip, resurfacing, held and followed checks',
    faults: { 'skip-no-resurface-expected': 'expect skipped checks never to come back' },
    async run(ctx, a) {
      const w = await ctx.open(ctx.sample())
      await ctx.press('start')
      await ctx.waitProgress('Check 1 of 9')
      await ctx.press('done')
      await ctx.waitProgress('Check 2 of 9')
      await ctx.press('done')
      await ctx.waitProgress('Check 3 of 9')
      // Back returns to the previous check, leading with its undo
      await ctx.press('back')
      await ctx.waitProgress('Check 2 of 9')
      a.ok(
        await ctx.cdp.eval(`!!document.querySelector('[data-test="walk-undo"]')`),
        "Back leads with the check's undo"
      )
      a.ok(
        (await ctx.pane()).text.includes('Clear the search box so the list is full again'),
        "the undo text is the script's"
      )
      await ctx.press('done')
      await ctx.waitProgress('Check 3 of 9')
      // Skip c3, c4 and c5; c6 depends on c5, so it waits and c7 is served
      await ctx.press('skip')
      await ctx.waitProgress('Check 4 of 9')
      await ctx.press('skip')
      await ctx.waitProgress('Check 5 of 9')
      await ctx.press('skip')
      await ctx.waitProgress('Check 7 of 9')
      a.ok(
        !(await ctx.pane()).text.includes('The count line follows the filter'),
        'a check blocked by a skipped one waits'
      )
      await ctx.agentDone(w, 'c7', 'pass')
      await ctx.waitProgress('Check 8 of 9')
      await ctx.press('done')
      await ctx.waitProgress('Check 9 of 9')
      await ctx.press('done')
      // nothing is left to do: the skipped checks are listed, each with Check now
      await ctx.waitState('skipped')
      const rows = () =>
        ctx.cdp.eval(`document.querySelectorAll('[data-dsqa-part="skipped-row"]').length`)
      a.eq(
        await rows(),
        ctx.fault('skip-no-resurface-expected') ? 0 : 3,
        'the three skipped checks are listed at the end'
      )
      a.eq(
        await ctx.cdp.eval(
          `[...document.querySelectorAll('[data-dsqa-part="skipped-row"] button')].filter((b) => b.textContent.includes('Check now')).length`
        ),
        3,
        'each has Check now'
      )
      // the operator picks c5, the blocker: Done, and the agent's check disagrees; it blocks c6, so it is held
      await ctx.cdp.click('[data-dsqa-part="skipped-row"]:nth-of-type(3) button', 'Check now')
      await ctx.waitProgress('Check 5 of 9')
      await ctx.agentDone(w, 'c5', 'fail')
      await ctx.waitOutcome('try-again')
      const held = await ctx.pane()
      a.ok(
        held.outcomes.includes('treat-as-failed') && !held.outcomes.includes('follow-anyway'),
        'a disagreeing report holds a blocking check (no Follow anyway)'
      )
      a.ok(held.outcomes.includes('back'), 'Back is still there')
      a.ok(
        await ctx.cdp.eval(`!!document.querySelector('[data-test="walk-evidence"]')`),
        'the evidence card shows what ran, was expected and was found'
      )
      // try again: it passes, and only then is c6 served
      await ctx.press('try-again')
      await ctx.waitOutcome('done')
      await ctx.agentDone(w, 'c5', 'pass')
      await ctx.waitProgress('Check 6 of 9')
      await ctx.press('done')
      // back to the list: c3 and c4 are still skipped; c3 has no blocker, so Follow anyway closes it as a caveat
      await ctx.waitState('skipped')
      await ctx.cdp.click('[data-dsqa-part="skipped-row"] button', 'Check now')
      await ctx.waitProgress('Check 3 of 9')
      await ctx.agentDone(w, 'c3', 'fail')
      await ctx.waitOutcome('follow-anyway')
      a.ok(
        !(await ctx.pane()).outcomes.includes('treat-as-failed'),
        'a non-blocking check offers Follow anyway, not Treat as failed'
      )
      await ctx.press('follow-anyway')
      const states = () =>
        Object.fromEntries(
          ctx
            .readRun(w.walkId, w.runId)
            .run.checks.map((c) => [c.id, `${c.state}:${c.closedHow ?? ''}`])
        )
      await ctx.waitState('skipped')
      await ctx.cdp.click('[data-dsqa-part="skipped-row"] button', 'Check now')
      await ctx.waitProgress('Check 4 of 9')
      await ctx.agentDone(w, 'c4', 'pass')
      await ctx.waitState('closeout')
      a.ok(
        /^caveat/.test(states().c3) && /follow/.test(states().c3),
        'Follow anyway closes it as a caveat, followed anyway'
      )
      a.ok(/^verified/.test(states().c5), 'the retried blocker ended verified')
      ctx.save('states.json', states())
    }
  },

  {
    id: 'W-6',
    title: 'Explain more keeps state',
    faults: {
      'explain-expects-progress-change': 'expect the progress label to change after Explain more'
    },
    async run(ctx, a) {
      const w = await ctx.open(ctx.sample())
      await ctx.press('start')
      await ctx.waitProgress('Check 1 of 9')
      await ctx.press('done')
      await ctx.waitProgress('Check 2 of 9')
      const snapshot = () =>
        ctx
          .readRun(w.walkId, w.runId)
          .run.checks.map((c) => `${c.id}:${c.state}:${c.attempts ?? 0}`)
      const before = snapshot()
      const m = ctx.stubMark()
      await ctx.press('explain')
      // nothing is prepared on this check: the pane asks the session, which answers with walk_extend
      await ctx.waitStub(m, /\[harnu-walk\][^\n]*explain/)
      const ex = await ctx.verb('walk_extend', {
        walkId: w.walkId,
        checkId: 'c2',
        more: 'The filter runs on every key press, so a typo shows up at once.',
        extra: [
          { text: 'Type `MILK` in capitals', see: 'The row Milk run stays' },
          { text: 'Type a word that is not in any note', see: 'The list is empty' }
        ]
      })
      a.ok(!ex.isError && ex.payload.ok !== false, 'walk_extend accepted')
      await ctx.waitText('every key press')
      const p = await ctx.pane()
      a.eq(
        p.progress,
        ctx.fault('explain-expects-progress-change') ? 'Check 3 of 9' : 'Check 2 of 9',
        'Check n of N is unchanged'
      )
      a.eq(
        await ctx.cdp.eval(`document.querySelectorAll('[data-dsqa-part="extra-check"]').length`),
        2,
        'two sub-checks were appended under the current check'
      )
      a.ok(p.outcomes.includes('done'), 'Done is still offered (ticks never block it)')
      await ctx.clickIn('[data-dsqa-part="extra-check"] button.bx')
      await ctx.cdp.waitFor(
        `document.querySelector('[data-dsqa-part="extra-check"] button.bx')?.getAttribute('aria-checked') === 'true'`,
        8000,
        'a ticked sub-check'
      )
      a.ok(true, 'a sub-check can be ticked')
      a.eq(snapshot(), before, 'every earlier outcome and attempt is unchanged')
      // a second press folds it back
      await ctx.press('explain')
      await ctx.cdp.waitFor(
        `!document.querySelector('[data-dsqa-part="extra-check"]')`,
        5000,
        'the extra checks folded'
      )
      a.eq((await ctx.pane()).progress, 'Check 2 of 9', 'still Check 2 of 9 after folding')
      // "I didn't get this step": the simpler card in the same place
      const m2 = ctx.stubMark()
      await ctx.clickIn('[data-test="walk-lost"]')
      await ctx.waitStub(m2, /\[harnu-walk\][^\n]*simpler/)
      await ctx.verb('walk_extend', {
        walkId: w.walkId,
        checkId: 'c2',
        simpler: {
          text: 'Click the box and type the word milk.',
          do: [{ text: 'Click the search box', see: 'A cursor blinks in it' }]
        }
      })
      await ctx.waitText('Click the box and type the word milk')
      a.ok(
        await ctx.cdp.eval(`!!document.querySelector('[data-test="walk-simpler"]')`),
        'the simpler card is shown over the same check'
      )
      a.eq((await ctx.pane()).progress, 'Check 2 of 9', 'the simpler card keeps Check 2 of 9')
      a.eq(snapshot(), before, 'and nothing advanced')
      // the scroll position is the pane body's: it does not move when a deepening arrives
      const scrollBefore = await ctx.cdp.eval(
        `(() => { const b = document.querySelector('[data-dsqa="walk"] [data-test="walk-body"]'); b.scrollTop = 40; return b.scrollTop })()`
      )
      await ctx.verb('walk_extend', {
        walkId: w.walkId,
        checkId: 'c2',
        extra: [{ text: 'Type a space and a letter', see: 'The filter still works' }]
      })
      await ctx.sleep(1200)
      a.eq(
        await ctx.cdp.eval(
          `document.querySelector('[data-dsqa="walk"] [data-test="walk-body"]').scrollTop`
        ),
        scrollBefore,
        'the scroll position does not move'
      )
      // the walk-through shows teaching first
      await ctx.reset()
      await ctx.open(ctx.learn())
      await ctx.press('start')
      await ctx.waitProgress('Check 1 of 3')
      await ctx.press('explain')
      await ctx.cdp.waitFor(
        `!!document.querySelector('[data-test="walk-teach"]')`,
        8000,
        'the teaching card'
      )
      const order = await ctx.cdp.eval(`(() => {
        const t = document.querySelector('[data-dsqa="walk"] [data-test="walk-teach"]')
        const x = document.querySelector('[data-dsqa="walk"] [data-test="walk-extras"]')
        return { teach: !!t, extras: !!x, teachFirst: !!(t && x && t.compareDocumentPosition(x) & Node.DOCUMENT_POSITION_FOLLOWING) }
      })()`)
      ctx.save('order.json', order)
      a.ok(order.teach, 'a walk-through shows the teaching')
      a.ok(order.extras, 'the prepared edge checks are there too')
      a.ok(order.teachFirst, 'the teaching comes first')
    }
  }
]
