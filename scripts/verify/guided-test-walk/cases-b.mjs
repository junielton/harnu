/**
 * W-7 to W-14: a run that survives restarts, copy and links, the look of the pane, the mission close-out,
 * the keyboard and the wait for the agent.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import { sleep } from './instance.mjs'
import { hashTree } from './instance.mjs'

const val = (code) =>
  `[...document.querySelectorAll('[data-dsqa="walk"] .val')].find((e) => e.querySelector('code')?.textContent === ${JSON.stringify(code)})?.querySelector('.cp')`
const linkCopy = (label) =>
  `[...document.querySelectorAll('[data-dsqa="walk"] [data-walk-link]')].find((e) => e.textContent.includes(${JSON.stringify(label)}))?.querySelector('.cp')`

const flat = (o, p = '') =>
  Object.entries(o).flatMap(([k, v]) =>
    v && typeof v === 'object' ? flat(v, `${p}${k}.`) : [`${p}${k}`]
  )

export const casesB = [
  {
    id: 'W-7',
    title: 'a reload, a restart and a new session keep the run',
    faults: {
      'expect-check-4-after-reload': 'expect Check 4 of 9 after the reload (the run is on Check 3)'
    },
    async run(ctx, a) {
      const w = await ctx.open(ctx.sample())
      await ctx.press('start')
      await ctx.waitProgress('Check 1 of 9')
      await ctx.press('done')
      await ctx.waitProgress('Check 2 of 9')
      await ctx.press('skip')
      await ctx.waitProgress('Check 3 of 9')
      const states = ctx.states(w)
      const want = ctx.fault('expect-check-4-after-reload') ? 'Check 4 of 9' : 'Check 3 of 9'

      // 1. a reload of the page
      await ctx.cdp.send('Page.reload')
      await ctx.afterRestart()
      await ctx.waitProgress(want, 20_000).catch(() => {})
      a.eq((await ctx.pane())?.progress, want, 'after Page.reload the same check is current')
      a.eq(ctx.states(w), states, 'after Page.reload every outcome is the same')

      // 2. closing the pane and opening it again from the library
      await ctx.reset()
      a.eq(
        await ctx.cdp.eval(`!!document.querySelector('[data-dsqa="walk"]')`),
        false,
        'the pane is closed'
      )
      await ctx.cdp.eval(`${ctx.S('helpers')}.addWalksHelper(${JSON.stringify(ctx.repo)})`)
      await ctx.cdp.waitFor(
        `!!document.querySelector('[data-dsqa="library"] [data-walk-id="${w.walkId}"]')`,
        15_000,
        'the walk in the library'
      )
      await ctx.clickIn(
        `[data-dsqa="library"] [data-walk-id="${w.walkId}"] [data-test="walk-row-open"]`
      )
      await ctx.waitProgress(want).catch(() => {})
      a.eq((await ctx.pane())?.progress, want, 'a reopened pane shows the same check')
      a.eq(ctx.states(w), states, 'and the same outcomes')

      // 3. a relaunch of the same user-data-dir
      await ctx.inst.halt()
      await ctx.inst.boot()
      await ctx.afterRestart()
      await ctx.cdp
        .waitFor(`!!document.querySelector('[data-dsqa="walk"]')`, 30_000, 'the restored pane')
        .catch(() => {})
      const restored = await ctx.pane()
      a.eq(restored?.progress, want, 'after a relaunch the same check is current')
      a.eq(ctx.states(w), states, 'after a relaunch every outcome is the same')
      await ctx.ensureOwnerLive()

      // 4. a stopped and restarted session: the session's process dies, the next Done owes it a turn, the session
      // is brought back and the turn is delivered once
      await ctx.press('skip')
      await ctx.waitProgress('Check 4 of 9')
      const alive = ctx.liveStubPids().filter((p) => p.args.includes(ctx.sessions.owner))
      a.ok(alive.length > 0, 'the owner session has a live stub claude')
      // the product's own way of stopping a session: park it (the process ends, the terminal is disposed)
      await ctx.cdp.eval(`window.api.ptyPark(${JSON.stringify(ctx.sessions.owner)})`)
      await sleep(2500)
      a.eq(
        ctx.liveStubPids().filter((p) => p.args.includes(ctx.sessions.owner)).length,
        0,
        'the stub claude is stopped'
      )
      const m = ctx.stubMark()
      await ctx.press('done') // check 4 has an agent check: a turn is owed and no session is live
      await ctx.waitAwaiting()
      const turn = await ctx.waitStub(m, /\[harnu-walk\][^\n]*done/, 90_000)
      a.ok(/check 4 of 9 · done/.test(turn), 'the owed turn is delivered when the session is back')
      a.ok(
        new RegExp(`START pid=\\d+ .*--resume ${ctx.sessions.owner}`).test(turn),
        'after the session was started again'
      )
      await sleep(3500)
      a.eq(ctx.turnsSince(m), 1, 'and exactly once')
      const owed = ctx.readRun(w.walkId, w.runId).outbox.filter((o) => !o.delivered)
      a.eq(owed.length, 0, 'nothing is left in the outbox')
      ctx.save('turn-after-restart.txt', turn)
    }
  },

  {
    id: 'W-8',
    title: 'copy puts the exact text on the clipboard',
    faults: {
      'click-wrong-chip':
        'click the chip next to the one named (the clipboard then holds another value)'
    },
    async run(ctx, a) {
      const w = await ctx.open(ctx.sample())
      await ctx.press('start')
      await ctx.waitProgress('Check 1 of 9')
      const wrong = (code) =>
        ctx.fault('click-wrong-chip')
          ? `(() => { const all = [...document.querySelectorAll('[data-dsqa="walk"] .cp')]; const i = all.indexOf(${val(code)}); return all[i + 1] })()`
          : val(code)
      const check = async (what, finder, expected) => {
        const r = await ctx.copyOf(finder)
        a.eq(r.clip, expected, `${what}: the clipboard holds the exact text`)
        a.ok(r.copied, `${what}: the copied state shows`)
        a.ok(r.cleared, `${what}: the copied state ends (about 1.5 s)`)
      }
      // check 1: a block and a URL
      await check(
        'a block',
        `document.querySelector('[data-dsqa="walk"] .code .cp-l')`,
        'npm run dev -- --port 4173'
      )
      await check('a URL', linkCopy('Preview page'), ctx.inst.preview)
      await ctx.press('done')
      await ctx.waitProgress('Check 2 of 9')
      // check 2: an inline chip, an id, a branch, a click path and a file path
      await check('an inline chip', wrong('milk'), 'milk')
      await check('an id', val('note_4821'), 'note_4821')
      await check('a branch', val('feature/notes-search'), 'feature/notes-search')
      await check('a click path', val('Notes > Search'), 'Notes > Search')
      await check('a path', linkCopy('search.js'), `${ctx.repo}/src/notes/search.js:4`)
      await ctx.press('done')
      await ctx.waitProgress('Check 3 of 9')
      // an error text: the agent's check disagrees and says what it found
      await ctx.agentDone(w, 'c3', 'fail')
      await ctx.waitOutcome('follow-anyway')
      const found = await ctx.cdp.eval(
        `document.querySelector('[data-test="walk-evidence"] dl dd:nth-of-type(3) code')?.textContent`
      )
      a.ok(!!found && /no matching line/.test(found), 'the evidence card shows what was found')
      await check(
        'an error text',
        `document.querySelector('[data-test="walk-evidence"] dl dd:nth-of-type(3) .cp')`,
        found
      )
    }
  },

  {
    id: 'W-9',
    title: 'every link opens its real target',
    faults: {
      'click-wrong-link':
        'click the folder link where the url link is named (no browser pane opens at the page)'
    },
    async run(ctx, a) {
      const w = await ctx.open(ctx.sample())
      await ctx.press('start')
      await ctx.waitProgress('Check 1 of 9')
      void w
      const panes = async () => (await ctx.panesOf()).filter((p) => p.type !== 'walk')
      const linkBtn = (label) =>
        `[...document.querySelectorAll('[data-dsqa="walk"] [data-walk-link] button.open')].find((b) => b.textContent.includes(${JSON.stringify(label)}))`
      const clickLink = async (label) => {
        await ctx.cdp.eval(
          `(() => { document.querySelectorAll('[data-hv-target]').forEach((e) => e.removeAttribute('data-hv-target')); ${linkBtn(label)}.setAttribute('data-hv-target', ''); return true })()`
        )
        await ctx.clickIn('[data-hv-target]')
      }
      // the url link: a browser pane at the local page, which really loads
      const hits0 = ctx.previewHits()
      await clickLink(ctx.fault('click-wrong-link') ? 'Other worktree' : 'Preview page')
      await ctx.cdp.waitFor(`true`, 10)
      let url = null
      for (let i = 0; i < 40 && !url; i++) {
        url =
          (await panes()).find(
            (p) => p.type === 'browser' && String(p.url).startsWith(ctx.inst.preview)
          )?.url ?? null
        if (!url) await sleep(250)
      }
      a.ok(!!url, 'a url link opens a browser pane at the local page')
      for (let i = 0; i < 30 && ctx.previewHits() === hits0; i++) await sleep(250)
      a.ok(ctx.previewHits() > hits0, 'and the page is really loaded from the local server')
      // the target of one link is deleted; the pane is opened again (a fresh read) on the next check
      const gone = path.join(ctx.repo, 'docs', 'to-delete.md')
      const goneText = readFileSync(gone, 'utf8')
      try {
        await ctx.press('done')
        await ctx.waitProgress('Check 2 of 9')
        rmSync(gone)
        await ctx.reset()
        await ctx.cdp.eval(
          `${ctx.S('helpers')}.addWalkHelper(${JSON.stringify(ctx.repo)}, ${JSON.stringify(w.walkId)}, ${JSON.stringify(w.runId)})`
        )
        await ctx.waitProgress('Check 2 of 9')
        const drawn = await ctx.cdp.eval(
          `[...document.querySelectorAll('[data-dsqa="walk"] [data-walk-link]')].map((e) => e.textContent.trim())`
        )
        a.eq(
          drawn.some((t) => t.includes('Gone page')),
          false,
          'a link whose target is gone is not drawn'
        )
        a.ok(
          drawn.some((t) => t.includes('Search doc')) && drawn.some((t) => t.includes('search.js')),
          'the other file links are'
        )
      } finally {
        writeFileSync(gone, goneText)
      }
      // pr link: the PR address in a browser pane of the folder
      await clickLink('PR #101')
      let pr = null
      for (let i = 0; i < 40 && !pr; i++) {
        pr =
          (await panes()).find(
            (p) => p.type === 'browser' && /example-org\/example-web\/pull\/101/.test(String(p.url))
          )?.url ?? null
        if (!pr) await sleep(250)
      }
      a.eq(
        pr,
        'https://prs.example.invalid/example-org/example-web/pull/101',
        'a pr link opens a browser pane at the PR address'
      )
      // file link: the viewer on that path
      await clickLink('search.js')
      let md = null
      for (let i = 0; i < 40 && !md; i++) {
        md =
          (await panes()).find(
            (p) => p.type === 'markdown' && String(p.path).endsWith('src/notes/search.js')
          )?.path ?? null
        if (!md) await sleep(250)
      }
      a.eq(
        md,
        path.join(ctx.repo, 'src', 'notes', 'search.js'),
        'a file link opens the viewer on that path'
      )
      // folder link: the folder is selected in the sidebar
      await clickLink('Other worktree')
      let sel = null
      for (let i = 0; i < 20 && sel !== ctx.repoB; i++) {
        sel = await ctx.selectedFolder()
        if (sel !== ctx.repoB) await sleep(250)
      }
      a.eq(sel, ctx.repoB, 'a folder link selects the folder in the sidebar')
      await ctx.shot('links')
    }
  },

  {
    id: 'W-10',
    title: 'tokens only, light and dark, wide and narrow, en and pt-BR',
    faults: {
      'expect-no-scroll-at-3px': 'expect the pane to be 3 px narrower than its content allows'
    },
    async run(ctx, a) {
      // the two languages have the same keys
      const en = JSON.parse(
        readFileSync(path.join(ctx.repoRoot, 'src/renderer/src/i18n/en.json'), 'utf8')
      )
      const pt = JSON.parse(
        readFileSync(path.join(ctx.repoRoot, 'src/renderer/src/i18n/pt-BR.json'), 'utf8')
      )
      const ek = new Set(flat(en.testWalk).concat(flat(en.walksLibrary)))
      const pk = new Set(flat(pt.testWalk).concat(flat(pt.walksLibrary)))
      a.eq(
        [...ek].filter((k) => !pk.has(k)),
        [],
        'every walk key of en exists in pt-BR'
      )
      a.eq(
        [...pk].filter((k) => !ek.has(k)),
        [],
        'every walk key of pt-BR exists in en'
      )

      const w = await ctx.open(ctx.sample())
      await ctx.press('start')
      await ctx.waitProgress('Check 1 of 9')
      await ctx.press('done')
      await ctx.waitProgress('Check 2 of 9')
      await ctx.cdp.eval(`${ctx.S('helpers')}.addWalksHelper(${JSON.stringify(ctx.repo)})`)
      await ctx.cdp.waitFor(
        `!!document.querySelector('[data-dsqa="library"] [data-walk-id]')`,
        15_000,
        'the library list'
      )

      /** What the page says about its own layout and colours, for one pane. */
      const measure = (root) =>
        ctx.cdp.eval(`(() => {
        const r = document.querySelector('${root}')
        if (!r) return null
        const probe = document.createElement('i')
        document.body.appendChild(probe)
        const tokens = new Set()
        for (const n of ['text', 'text-2', 'text-3', 'text-4', 'text-disabled', 'accent', 'accent-ink', 'green', 'red', 'warning', 'bg', 'surface', 'surface-2', 'border']) {
          probe.style.color = 'var(--color-' + n + ')'
          tokens.add(getComputedStyle(probe).color)
        }
        probe.remove()
        const bad = new Set()
        const walker = document.createTreeWalker(r, NodeFilter.SHOW_TEXT)
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          if (!n.textContent.trim() || !n.parentElement) continue
          const el = n.parentElement
          const cs = getComputedStyle(el)
          if (cs.display === 'none' || cs.visibility === 'hidden') continue
          const c = cs.color
          if (!tokens.has(c) && !/rgba\\(.*, 0\\)$/.test(c)) bad.add(c + ' on <' + el.tagName.toLowerCase() + ' class=' + el.className + '>')
        }
        const rect = r.getBoundingClientRect()
        const body = r.querySelector('[data-test="walk-body"], [data-test="walks-body"]')
        const outs = [...r.querySelectorAll('[data-outcome]')].map((b) => {
          const q = b.getBoundingClientRect()
          return { id: b.dataset.outcome, inside: q.left >= rect.left - 1 && q.right <= rect.right + 1 && q.top >= 0 && q.bottom <= innerHeight + 1 && q.width > 0 }
        })
        return {
          scrollX: r.scrollWidth - r.clientWidth, bodyScrollX: body ? body.scrollWidth - body.clientWidth : 0,
          pageScrollX: document.documentElement.scrollWidth - innerWidth,
          width: Math.round(rect.width), outs, bad: [...bad].slice(0, 6), theme: document.documentElement.dataset.theme ?? null
        }
      })()`)

      // The window is 1280 px wide. "Wide" is the pane expanded to the window; "narrow" is the
      // pane held at 360 px by the helper split (a 360 px window has no room for the pane at all: the sidebar and
      // the Fleet rail alone take it). The measured width of each pane goes in the detail of the assertion.
      await ctx.cdp.viewport(1280, 800)
      const paneId = async (type) => (await ctx.panesOf()).find((p) => p.type === type)?.id
      const setWidth = async (name, wide) => {
        const type = name === 'pane' ? 'walk' : 'walks'
        const root = name === 'pane' ? '[data-dsqa="walk"]' : '[data-dsqa="library"]'
        const pid = await paneId(type)
        await ctx.cdp.eval(`${ctx.S('helpers')}.exitExpand(${JSON.stringify(ctx.repo)})`)
        await sleep(200)
        if (wide)
          await ctx.cdp.eval(
            `${ctx.S('helpers')}.toggleExpandPane(${JSON.stringify(ctx.repo)}, ${JSON.stringify(pid)})`
          )
        if (!wide) {
          let lo = 0.1
          let hi = 0.9
          for (let k = 0; k < 9; k++) {
            const mid = (lo + hi) / 2
            await ctx.cdp.eval(
              `${ctx.S('helpers')}.setSplitRatio(${JSON.stringify(ctx.repo)}, ${mid})`
            )
            await sleep(250)
            const w = await ctx.cdp.eval(
              `document.querySelector('${root}')?.getBoundingClientRect().width ?? 0`
            )
            if (Math.abs(w - 360) < 6) break
            // the ratio is the terminal's share: a larger ratio leaves the stack narrower
            if (w > 360) lo = mid
            else hi = mid
          }
        }
        await sleep(500)
      }
      const combos = []
      for (const theme of ['default-dark', 'light'])
        for (const wide of [true, false]) combos.push({ theme, wide, locale: 'en' })
      combos.push({ theme: 'default-dark', wide: true, locale: 'pt-BR' })
      for (const c of combos) {
        await ctx.cdp.eval(
          `${ctx.S('theme')}.set(${JSON.stringify(c.theme)}); document.querySelector('#app').__vue_app__.config.globalProperties.$i18n.locale = ${JSON.stringify(c.locale)}; true`
        )
        for (const [name, root] of [
          ['pane', '[data-dsqa="walk"]'],
          ['library', '[data-dsqa="library"]']
        ]) {
          await setWidth(name, c.wide)
          const m = await measure(root)
          const tag = `${name} ${c.theme} ${c.wide ? 'wide' : 'narrow'} ${c.locale}`
          if (!a.ok(m !== null, `${tag}: the ${name} is on screen`)) continue
          a.ok(
            c.wide ? m.width > 700 : Math.abs(m.width - 360) < 20,
            `${tag}: the ${name} is ${m.width} px wide`
          )
          a.ok(
            m.scrollX <= (ctx.fault('expect-no-scroll-at-3px') ? -3 : 0) &&
              m.bodyScrollX <= 0 &&
              m.pageScrollX <= 0,
            `${tag}: no horizontal scroll (pane ${m.scrollX}, body ${m.bodyScrollX}, page ${m.pageScrollX})`
          )
          a.eq(m.bad, [], `${tag}: every text colour is a token`)
          if (name === 'pane') {
            a.eq(
              m.outs.map((o) => o.id),
              ['done', 'failed', 'back', 'skip', 'explain'],
              `${tag}: the five outcomes are on offer`
            )
            a.ok(
              m.outs.every((o) => o.inside),
              `${tag}: every outcome is inside the viewport`
            )
          }
          await ctx.shot(`${name}-${c.theme}-${c.wide ? 'wide' : 'narrow'}-${c.locale}`)
        }
      }
      await ctx.cdp.eval(
        `document.querySelector('#app').__vue_app__.config.globalProperties.$i18n.locale = 'en'; ${ctx.S('theme')}.set('default-dark'); true`
      )
      await ctx.cdp.viewport(null)
      void w
    }
  },

  {
    id: 'W-11',
    title: 'Done never settles a criterion; the close-out links to Mark done',
    faults: {
      'expect-criterion-settled': 'expect the operator criterion to be settled after the walk'
    },
    async run(ctx, a) {
      const m = await ctx.makeMission()
      const before = ctx.missionFiles()
      const script = ctx.mission(m)
      const w = await ctx.open(script)
      await ctx.press('start')
      await ctx.waitProgress('Check 1 of 3')
      // Done on the criterion's check, with a click and then with Enter
      await ctx.press('done')
      await ctx.waitProgress('Check 2 of 3')
      await ctx.agentDone(w, 'm2', 'pass')
      await ctx.waitProgress('Check 3 of 3')
      await ctx.focusPane()
      await sleep(450)
      await ctx.key('Enter')
      await ctx.waitState('closeout')
      a.eq(ctx.missionFiles(), before, 'the mission file is byte-identical after the walk')
      const text = (await ctx.pane()).text
      const rows = await ctx.cdp.eval(
        `document.querySelectorAll('[data-dsqa="walk"] [data-dsqa-part="closeout-row"]').length`
      )
      a.eq(rows, 3, 'the close-out prints one row per check')
      a.ok(
        text.includes('criterion open'),
        'the operator criterion reads "criterion open", not settled'
      )
      a.ok(text.includes('I never tick it for you'), 'the close-out says it never ticks')
      a.ok(!(await ctx.pane()).outcomes.length, 'no outcome button is left on the close-out')
      const controls = await ctx.cdp.eval(
        `[...document.querySelectorAll('[data-dsqa="walk"] button')].map((b) => b.textContent.trim().toLowerCase())`
      )
      a.ok(
        !controls.some((t) => /^(settle|tick|mark|approve)/.test(t)),
        `no control of the pane settles (buttons: ${controls.join(' | ')})`
      )
      a.eq(
        await ctx.cdp.eval(`!!document.querySelector('[data-test="walk-open-mission"]')`),
        !ctx.fault('expect-criterion-settled') ? true : false,
        'the link to the Mission (where Mark done is) is there'
      )
      await ctx.shot('closeout')
      await ctx.clickIn('[data-test="walk-open-mission"]')
      let opened = false
      for (let i = 0; i < 20 && !opened; i++) {
        // the Mission pane is gone: the link opens the Mission dropdown under the Topbar pill
        opened = await ctx.cdp.eval(`${ctx.S('ui')}.popovers.missionProgress === true`)
        if (!opened) await sleep(250)
      }
      a.ok(opened, 'the link opens the Mission dropdown')
      await sleep(800)
      a.eq(ctx.missionFiles(), before, 'and opening it writes nothing')
    }
  },

  {
    id: 'W-13',
    title: 'Enter, shortcuts and the debounce',
    faults: { 'debounce-expects-two': 'expect two checks of progress after a double Enter' },
    async run(ctx, a) {
      const w = await ctx.open(ctx.sample())
      await ctx.ensureOwnerLive()
      // Enter on the roadmap starts the walk (the terminal may still hold focus for a moment: try again)
      for (let i = 0; i < 6; i++) {
        await ctx.focusPane()
        await sleep(300)
        await ctx.key('Enter')
        if (
          await ctx.waitProgress('Check 1 of 9', 2500).then(
            () => true,
            () => false
          )
        )
          break
      }
      await ctx.waitProgress('Check 1 of 9')
      await sleep(500)
      // Enter is Done on the pane; a second Done right after the new check is served is ignored (400 ms). The pane's
      // own "an outcome is in flight" guard would also drop an Enter that comes too soon, so the second one is sent
      // from inside the page 80 ms after Check 2 is drawn: that guard is clear by then and only the debounce can
      // still stop it (Check 2 has no agent check, so a Done that got through would move on to Check 3).
      await ctx.cdp.eval(`(() => {
        const root = document.querySelector('[data-dsqa="walk"]')
        const label = () => root.querySelector('[data-test="walk-progress"] .wk-count')?.textContent.trim()
        const obs = new MutationObserver(() => {
          if (label() !== 'Check 2 of 9') return
          obs.disconnect()
          setTimeout(() => root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })), 80)
        })
        obs.observe(root, { subtree: true, childList: true, characterData: true })
        return true
      })()`)
      await ctx.key('Enter')
      await ctx.waitProgress('Check 2 of 9')
      await sleep(1500)
      a.eq(
        (await ctx.pane()).progress,
        ctx.fault('debounce-expects-two') ? 'Check 3 of 9' : 'Check 2 of 9',
        'Enter is Done, and a second Done right after the new check is ignored'
      )
      await sleep(500)
      await ctx.key('Enter')
      await ctx.waitProgress('Check 3 of 9')
      // on a chip, Enter copies and does not advance
      await ctx.cdp.eval(
        `(() => { const b = [...document.querySelectorAll('[data-dsqa="walk"] .cp')][0]; b.focus(); return document.activeElement === b })()`
      )
      await ctx.cdp.eval(`navigator.clipboard.writeText('__empty__')`)
      await sleep(450)
      await ctx.key('Enter')
      await sleep(500)
      a.ok(
        (await ctx.cdp.eval(`navigator.clipboard.readText()`)) !== '__empty__',
        'Enter on a chip copies it'
      )
      a.eq((await ctx.pane()).progress, 'Check 3 of 9', 'and does not press Done')
      // the shortcuts act
      await ctx.focusPane()
      const em = ctx.stubMark()
      await ctx.key('e')
      await ctx.waitStub(em, /\[harnu-walk\][^\n]*explain/)
      a.ok(true, 'E acts: Explain more asks the session')
      await ctx.key('e')
      await ctx.key('l')
      await ctx.waitState('roadmap')
      a.ok(true, 'L opens the roadmap')
      await ctx.key('Escape')
      await ctx.waitState('check')
      await ctx.key('b')
      await ctx.waitProgress('Check 2 of 9')
      a.ok(true, 'B goes back')
      await ctx.key('s')
      await ctx.waitProgress('Check 3 of 9')
      a.ok(true, 'S skips')
      await ctx.key('f')
      await ctx.waitState('failed-form')
      a.ok(true, 'F opens the failure form')
      // in a field the keys are the field's: nothing acts, the letters are typed
      await ctx.clickIn('[data-test="walk-failure-line"]')
      await ctx.cdp.type('fbsel')
      await ctx.key('f')
      await ctx.key('s')
      a.eq(
        await ctx.cdp.eval(`document.querySelector('[data-test="walk-failure-line"]').value`),
        'fbselfs',
        'shortcut keys are ignored while a field has focus'
      )
      a.eq((await ctx.pane()).state, 'failed-form', 'and nothing acted')
      // Enter in the field sends
      const mark = ctx.stubMark()
      await ctx.key('Enter')
      await ctx.waitStub(mark, /\[harnu-walk\][^\n]*failed/)
      a.ok(true, 'Enter in the failure field sends it')
      void w
    }
  },

  {
    id: 'W-14',
    title: 'Continue without the check, as a caveat',
    faults: { 'expect-verified-on-continue': 'expect the continued check to count as verified' },
    async run(ctx, a) {
      const w = await ctx.open(ctx.sample())
      await ctx.press('start')
      await ctx.waitProgress('Check 1 of 9')
      await ctx.press('done')
      await ctx.waitProgress('Check 2 of 9')
      await ctx.press('done')
      await ctx.waitProgress('Check 3 of 9')
      await ctx.press('done') // c3 has an agent check that nobody answers
      await ctx.waitAwaiting()
      a.ok(
        !(await ctx.pane()).outcomes.includes('continue-without'),
        'no way out the moment the check is asked'
      )
      await ctx.waitOutcome('continue-without', 20_000)
      a.ok(true, '"Continue without the check" appears after the wait')
      await ctx.press('continue-without')
      await ctx.waitProgress('Check 4 of 9')
      const st = ctx.states(w).c3
      a.ok(
        /^caveat/.test(st) && /continued/.test(st),
        `it closes as a caveat, you continued (${st})`
      )
      a.ok(
        ctx.fault('expect-verified-on-continue') ? /^verified/.test(st) : !/^verified/.test(st),
        'never as verified'
      )
      // a late passing report upgrades it
      const r = await ctx.report(
        w,
        'c3',
        'pass',
        'Ran the grep, expected one match, found one match'
      )
      a.ok(!r.isError && r.payload.ok !== false, 'a late report is accepted')
      await sleep(600)
      a.ok(/^verified/.test(ctx.states(w).c3), `and upgrades it to verified (${ctx.states(w).c3})`)
    }
  }
]
void hashTree
