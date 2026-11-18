/**
 * Mission dropdown · S-1 · AC-30 — the dev route that mounts `MissionDropdown` over the sample mission in
 * every state of the approved mockup (`docs/design/mission-dropdown/`, screen `mission-dropdown`), so the
 * captures of S-2 to S-6 can be taken BEFORE the Topbar pill is switched over (S-7).
 *
 * Why not a route of the real app, like `board-missions.mjs`? Until S-7 nothing in the app imports the
 * dropdown: it is tree-shaken out of the built renderer, and no pill, store or menu opens it. So this route
 * brings its own page. It serves a tiny harness through Vite (the renderer's own plugins, aliases and
 * `main.css`, so every token and utility is the product's), mounts the real `MissionDropdown` with the real
 * Pinia stores and the real i18n, and puts a stand-in for the Topbar band and its pill above it so the layer
 * anchors the way it will in the app. `window.api` is a no-op proxy: the dropdown reads the sample mission
 * through `stores/missions.ts` (`showSample`), which calls nothing.
 *
 *   id                              file                  how it is reached
 *   MissionDropdown#<state>         MissionDropdown.vue   harness page → `window.__missionDropdown.show('<state>')`
 *
 * The route has the shape of `board-missions.mjs` — `{ id, file, reach, note?, open, close? }` — but it is NOT
 * part of `ROUTES`: that list is the geometry net's (a seeded, built app), and this one needs a dev server and a
 * page, not an Electron window. `reach` is `'dev-harness'`. `open({ page })` resolves once the dropdown (or,
 * for `closed`, the bare pill) is on screen and its scale-in has finished.
 *
 * Capture the 14 states, dark, EN, at the mockup's two widths:
 *
 *   node scripts/dev/dialog-routes/mission-dropdown.mjs capture [--out <dir>] [--widths 1280,360] [--only mid,owed]
 *
 * S-6 adds the four states of the mockup screen `entry` (the "Test it" controls: `entry-step-open`,
 * `entry-milestone`, `entry-mission`, `entry-closed`), captured as `entry-<state>-<width>-dark-en.png`. The
 * shipped walk provider answers no, so the harness installs a test one (`walk` on the state: the kinds of
 * source it answers yes for, the way each mockup state draws exactly one control) and records every
 * `startWalk` in `window.__walkStarts`.
 *
 * Set `MISSION_DROPDOWN_CHROMIUM` to a Chromium binary when Playwright's own download is not installed.
 *
 * Default output is `.harnu/out/mission-dropdown/<slice>/` (gitignored), one PNG per state and width, named
 * like the mockup's own captures: `mission-dropdown-<state>-<width>-dark-en.png`.
 */
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..', '..')

/** The two widths of the mockup's captures; the height is the mockup's. */
export const CAPTURE_WIDTHS = [1280, 360]
export const CAPTURE_HEIGHT = 800
/** The scale-in is 140ms (`--dur`): wait past it before measuring or capturing. */
const FADE_MS = 400

/**
 * The 14 states of the mockup screen `mission-dropdown`, in its order. `sample` is the pane's sample state
 * (`lib/mission-sample.ts`) the harness shows behind the dropdown; `open: false` draws the bare pill. A state
 * the sample cannot reach says so in `note`: the slice that draws it adds the data it needs to the sample.
 *
 * `mod` is a change the harness makes to the sample's reply, for the states a sample cannot be (a staged Done when,
 * a request to join, several led missions): the reply then comes through the store's real path (`missionV4View`)
 * instead of `showSample`, so the dropdown draws it exactly the way it draws a live mission.
 *
 * `hover` is a selector the harness points the mouse at once the dropdown is up, for the one state that is a
 * tooltip (`dots`: a state glyph's label, S-3).
 *
 * `row` is a step row the harness clicks open once the dropdown is up (S-4: an open step, which a sample's own
 * `ui.openStep` cannot do for a reply the harness edited).
 *
 * `none` is the store's real answer for a session in no mission, `refused` a read the view refused and `loading` a
 * session the view has not answered yet (S-5: the empty state, which draws no sample until its link is used).
 * `click` is a selector the harness presses once the dropdown is up (S-5: the close dialog, which opens from the
 * next card's button).
 *
 * @type {ReadonlyArray<{ id: string, sample: string, open: boolean, mod?: 'staged'|'request'|'multi'|'chooser'|'more'|'none'|'refused'|'loading', row?: string, hover?: string, click?: string, note?: string }>}
 */
export const MISSION_DROPDOWN_STATES = [
  { id: 'mid', sample: 'default', open: true },
  { id: 'closed', sample: 'default', open: false, note: 'the pill alone, the dropdown closed' },
  {
    id: 'multi',
    sample: 'default',
    open: true,
    mod: 'multi',
    note: 'a session that leads three missions: the head carries the switch (S-2)'
  },
  {
    id: 'chooser',
    sample: 'default',
    open: true,
    mod: 'chooser',
    note: 'the switch opened on the radiogroup of missions (S-2)'
  },
  {
    id: 'owed',
    sample: 'waiting',
    open: true,
    mod: 'more',
    note: 'the next card with "more waiting on you" opened in place (S-2)'
  },
  {
    id: 'step-open',
    sample: 'step-open',
    open: true,
    note: 'an open step with three verified criteria, two open ones and every kind of link (S-4)'
  },
  {
    id: 'blocked',
    sample: 'step-blocked',
    open: true,
    note: 'the blocked step open: its blocker, one criterion and two links (S-4)'
  },
  { id: 'ask', sample: 'ask', open: true },
  {
    id: 'done-when',
    sample: 'default',
    open: true,
    mod: 'staged',
    note: 'a staged Done when proposed over the sample mission (S-2): the one card, Approve and Decline'
  },
  {
    id: 'attach-request',
    sample: 'default',
    open: true,
    mod: 'request',
    note: 'a request to join the sample mission (S-2): the one card, Allow and Deny'
  },
  { id: 'ready', sample: 'done', open: true },
  {
    id: 'close-confirm',
    sample: 'done',
    open: true,
    click: '[data-test="next-button"]',
    note: 'the close dialog over the dropdown, which is inert and dimmed (S-5)'
  },
  {
    id: 'empty',
    sample: 'default',
    open: true,
    mod: 'none',
    note: 'a session in no mission: the picker, Start a new mission and the sample link (S-5)'
  },
  {
    id: 'dots',
    sample: 'default',
    open: true,
    hover: '[data-glyph="blocked"]',
    note: "the blocked step's glyph with its label shown (S-3)"
  },
  {
    id: 'empty-sample',
    sample: 'default',
    open: true,
    note: 'the sample opened from the empty state: its made-up strip, state chooser and the way out (S-5)'
  },
  {
    id: 'loading',
    sample: 'default',
    open: true,
    mod: 'loading',
    note: 'the first answer has not come yet: one line inside the dropdown (S-5)'
  },
  {
    id: 'refused',
    sample: 'default',
    open: true,
    mod: 'refused',
    note: 'the view refused the read: the words, the reason and Retry (S-5)'
  }
]

/**
 * The 4 states of the mockup screen `entry`, in its order. `walk` is the kinds of source the test provider
 * answers yes for in that state: the mockup draws one control per state (a step's in `step-open`, the milestone's
 * in `milestone`, the footer's in `mission`), and a real provider decides per source the same way.
 *
 * @type {ReadonlyArray<{ id: string, sample: string, open: boolean, walk: ReadonlyArray<'step'|'milestone'|'mission'>, row?: string, note?: string }>}
 */
export const MISSION_DROPDOWN_ENTRY_STATES = [
  {
    id: 'entry-step-open',
    sample: 'step-open',
    open: true,
    walk: ['step'],
    note: 'an open step with "Test it" on its Criteria row (S-6)'
  },
  {
    id: 'entry-milestone',
    sample: 'default',
    open: true,
    walk: ['milestone'],
    note: '"Test it" on the open milestone\'s summary line, next to Ask (S-6)'
  },
  {
    id: 'entry-mission',
    sample: 'done',
    open: true,
    walk: ['mission'],
    note: '"Test the whole mission" alone in the footer of a mission ready to close (S-6)'
  },
  {
    id: 'entry-closed',
    sample: 'default',
    open: false,
    walk: [],
    note: 'the pill alone, the dropdown closed (S-6)'
  }
]

/** Every state the harness can show: the screen `mission-dropdown`'s, then the screen `entry`'s. */
const ALL_STATES = [...MISSION_DROPDOWN_STATES, ...MISSION_DROPDOWN_ENTRY_STATES]

/**
 * The page the harness serves. The Topbar band is a stand-in (42px, the pill at the left of its centre) so the
 * dropdown has the same anchor it will have in the app: it carries the `data-dsqa="topbar-pill--<tone>"` the
 * dropdown reads. Only the stand-in uses inline styles; the dropdown itself is the product's component.
 */
function harnessModule() {
  return `
import '/src/styles/main.css'
import { createApp, h } from 'vue'
import { createPinia } from 'pinia'
import { i18n } from '/src/i18n/index.ts'
import MissionDropdown from '/src/components/MissionDropdown.vue'
import { useUiStore } from '/src/stores/ui.ts'
import { useMissionsStore } from '/src/stores/missions.ts'
import { useSessionsStore } from '/src/stores/sessions.ts'
import { sampleOf } from '/src/lib/mission-sample.ts'
import { setWalkEntryProvider } from '/src/lib/walk-entry.ts'

// \`window.api\` is the preload's bridge; the sample mission needs none of it. A state with a \`mod\` goes through
// the store's real path, so \`missionV4View\` answers the edited reply.
const noop = () => undefined
let current = null
window.api = new Proxy({}, {
  get: (_, key) =>
    key === 'missionV4View'
      ? async () => current
      : key === 'missionPathKinds'
        // The paths of the sample's links exist: a folder, and a README inside the evidence folder.
        ? async (paths) => Object.fromEntries(paths.map((p) => [p, p.endsWith('/README.md') ? 'file' : 'dir']))
      : String(key).startsWith('on')
        ? () => noop
        : async () => undefined
})

const pinia = createPinia()
const app = createApp({
  render: () =>
    h('div', { style: 'min-height:100vh;background:var(--color-bg);color:var(--color-text)' }, [
      h('div', {
        style: 'height:42px;border-bottom:1px solid var(--color-border);background:var(--color-sidebar);display:flex;align-items:center;padding:0 12px 0 260px'
      }, [
        h('button', {
          type: 'button',
          'data-dsqa': 'topbar-pill--accent',
          'data-test': 'harness-pill',
          style: 'height:18px;padding:1px 7px;font-size:10.5px;border:1px solid var(--color-accent-line);border-radius:var(--radius-sm);background:var(--color-accent-soft);color:var(--color-accent);cursor:pointer',
          onClick: () => useUiStore().togglePopover('missionProgress')
        }, '4/21 · 3 for you')
      ]),
      h(MissionDropdown)
    ])
})
app.use(pinia)
app.use(i18n)
app.mount('#app')

const ui = useUiStore()
const missions = useMissionsStore()
ui.setPopoverAnchor('missionProgress', true)

const SESSION = sampleOf('default').sessionId
const sessions = useSessionsStore()

/** The sample reply with the harness's change (a staged Done when, a request to join, several led missions). */
function edited(sample, mod) {
  const r = structuredClone(sampleOf(sample).reply)
  const w = r.detail.waiting
  if (mod === 'staged') {
    r.pendingDoneWhen = { text: 'The spec skill is scored, and both fixes are proven by a fresh run on the test set.' }
    const rescope = { kind: 'rescope', id: 'rescope', ask: 'x', why: 'y' }
    w.items = [rescope, ...w.items]
    w.next = rescope
    w.more = w.items.slice(1)
  } else if (mod === 'request') {
    const attach = { kind: 'attach', id: 'attach:atr-1', requestId: 'atr-1', sessionId: 'worker-3', ask: 'x', why: 'y' }
    w.items = [attach, ...w.items]
    w.next = attach
    w.more = w.items.slice(1)
  }
  return r
}

/** Three missions this session leads, as the readers of the store know them (the first is the one shown). */
function ledReaders(base) {
  const one = (id, title, done, total, forYou) => ({
    title,
    lookupId: id,
    mission: { id },
    you: [],
    detail: {
      ...base.detail,
      leads: SESSION,
      progress: { ...base.detail.progress, done, total, unit: 'milestones' },
      waiting: { ...base.detail.waiting, items: Array.from({ length: forYou }, (_, i) => ({ id: 'w' + i })) }
    }
  })
  return [
    one(base.missionId, base.detail.title, 1, 3, 3),
    one('mnt-sample02', 'Collect partner listings every day, live in production', 0, 2, 1),
    one('mnt-sample03', 'Tidy the release notes', 4, 10, 0)
  ]
}

window.__missionDropdown = {
  async show(sample, open, mod, hover, row, click, walk) {
    // The shipped walk provider answers no; a state that draws "Test it" installs one that answers yes for the
    // kinds it lists, and records what a click starts.
    window.__walkStarts = []
    setWalkEntryProvider(
      walk && walk.length
        ? { available: (src) => walk.includes(src.kind), start: (src) => window.__walkStarts.push(src) }
        : null
    )
    // The worktrees the sample's links name are pinned folders, each on its branch.
    sessions.folders = [
      { path: '/sample', pinned: true, sessions: [{ sessionId: SESSION, projectPath: '/sample', summary: 'Leader' }, { sessionId: 'sample-idle', projectPath: '/sample', summary: 'Idle' }] },
      { path: '/sample/.claude/worktrees/card-score-proofs', pinned: true, gitBranch: 'card/score-proofs', sessions: [] },
      { path: '/sample/.claude/worktrees/card-score-slices', pinned: true, gitBranch: 'card/score-slices', sessions: [] }
    ]
    if (mod === 'none' || mod === 'refused' || mod === 'loading') {
      // A session in no mission: the store's own answer, with no sample behind it. the loading state follows a session the
      // view has not answered for yet.
      sessions.select(mod === 'loading' ? 'sample-idle' : SESSION)
      missions.showSample(null)
      current =
        mod === 'refused'
          ? { state: 'refused', error: 'READ_FAILED: the record is locked by another process' }
          : {
              state: 'none',
              missions: [
                { id: 'mnt-sample01', title: sampleOf('default').title, headline: '4 of 21 steps done', leads: null },
                { id: 'mnt-sample03', title: 'Collect partner listings every day, live in production', headline: '1 of 10 milestones done', leads: null }
              ]
            }
      if (mod !== 'loading') await missions.refreshV4()
      missions.readers = null
    } else if (mod) {
      sessions.select(SESSION)
      missions.showSample(null)
      current = edited(sample, mod)
      await missions.refreshV4()
      missions.readers = mod === 'multi' || mod === 'chooser' ? ledReaders(current) : null
    } else {
      current = null
      missions.readers = null
      missions.showSample(sample)
    }
    if (open) ui.openPopover('missionProgress')
    else ui.closePopover('missionProgress')
    if (open && (mod === 'chooser' || mod === 'more')) {
      await new Promise((r) => setTimeout(r, 60))
      const sel = mod === 'chooser' ? '[data-test="mission-switch"]' : '[data-test="next-more"]'
      document.querySelector(sel)?.click()
    }
    // An open step: click its row the way the operator does.
    if (open && row) {
      await new Promise((r) => setTimeout(r, 60))
      document.querySelector('[data-row="' + row + '"]')?.click()
      await new Promise((r) => setTimeout(r, 60))
    }
    // A dialog state: press the button that opens it, the way the operator does.
    if (open && click) {
      await new Promise((r) => setTimeout(r, 60))
      document.querySelector(click)?.click()
      await new Promise((r) => setTimeout(r, 200))
    }
    // A tooltip state: point at the glyph the way a mouse does (its label is shown on mouseenter).
    if (open && hover) {
      await new Promise((r) => setTimeout(r, 60))
      document.querySelector(hover)?.dispatchEvent(new MouseEvent('mouseenter'))
    }
  }
}
window.__missionDropdownReady = true
`
}

/**
 * Starts the harness server. `root` is the renderer's own root (`src/renderer`), so Tailwind scans the product's
 * sources and `/src/...` resolves like it does in the app.
 *
 * @param {{ repo?: string, port?: number }} [o]
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
export async function startMissionDropdownHarness({ repo = REPO, port = 0 } = {}) {
  const { createServer } = await import('vite')
  const vue = (await import('@vitejs/plugin-vue')).default
  const tailwindcss = (await import('@tailwindcss/vite')).default
  const VIRTUAL = 'virtual:mission-dropdown-harness'
  const server = await createServer({
    root: join(repo, 'src', 'renderer'),
    configFile: false,
    logLevel: 'error',
    resolve: { alias: { '@renderer': join(repo, 'src', 'renderer', 'src') } },
    server: { port, host: '127.0.0.1', strictPort: false, fs: { allow: [repo] } },
    optimizeDeps: { noDiscovery: false },
    plugins: [
      vue(),
      tailwindcss(),
      {
        name: 'mission-dropdown-harness',
        resolveId: (id) => (id === VIRTUAL ? `\0${VIRTUAL}` : null),
        load: (id) => (id === `\0${VIRTUAL}` ? harnessModule() : null),
        configureServer(s) {
          s.middlewares.use(async (req, res, next) => {
            if (!req.url?.startsWith('/__mission-dropdown.html')) return next()
            const html = await s.transformIndexHtml(
              req.url,
              `<!doctype html><html data-theme="dark"><head><meta charset="UTF-8" /><title>Mission dropdown</title></head><body><div id="app"></div><script type="module" src="/@id/__x00__${VIRTUAL}"></script></body></html>`
            )
            res.setHeader('Content-Type', 'text/html')
            res.end(html)
          })
        }
      }
    ]
  })
  await server.listen()
  const address = server.httpServer?.address()
  const actual = typeof address === 'object' && address ? address.port : port
  return {
    url: `http://127.0.0.1:${actual}/__mission-dropdown.html`,
    close: () => server.close()
  }
}

/** Opens the harness page and waits until it is ready. */
export async function openHarnessPage(page, url) {
  await page.goto(url)
  await page.waitForFunction(() => window.__missionDropdownReady === true, null, {
    timeout: 60000
  })
}

/** Shows one state: the dropdown over its sample mission, or the bare pill for `closed`. */
export async function showMissionDropdownState(page, state) {
  const def = ALL_STATES.find((s) => s.id === state)
  if (!def) throw new Error(`unknown mission dropdown state "${state}"`)
  await page.evaluate(
    ({ sample, open, mod, hover, row, click, walk }) =>
      window.__missionDropdown.show(sample, open, mod, hover, row, click, walk),
    def
  )
  if (def.open) {
    await page
      .locator('[data-dsqa="mission-dropdown"]')
      .waitFor({ state: 'visible', timeout: 8000 })
    await page.waitForTimeout(FADE_MS)
  } else {
    await page
      .locator('[data-dsqa="mission-dropdown"]')
      .waitFor({ state: 'detached', timeout: 8000 })
    await page.waitForTimeout(150)
  }
}

/**
 * One route per state, the shape of `board-missions.mjs`. `open` takes `{ page, harness }`: `harness.url` is
 * the page's address (see {@link startMissionDropdownHarness}); the page is opened once and reused.
 *
 * @type {Array<{ id: string, file: string, reach: 'dev-harness', note?: string, open: (ctx: { page: import('@playwright/test').Page, harness: { url: string } }) => Promise<void>, close?: (ctx: { page: import('@playwright/test').Page }) => Promise<void> }>}
 */
export const ROUTES_MISSION_DROPDOWN = ALL_STATES.map((s) => ({
  id: `MissionDropdown#${s.id}`,
  file: 'MissionDropdown.vue',
  reach: 'dev-harness',
  note:
    `Mounted by the dev harness over the sample "${s.sample}"` +
    (s.note ? `: ${s.note}.` : '.') +
    ' Not part of ROUTES: the geometry net drives the built app, and nothing in it opens the dropdown until S-7.',
  open: async ({ page, harness }) => {
    const ready = await page
      .evaluate(() => window.__missionDropdownReady === true)
      .catch(() => false)
    if (!ready) await openHarnessPage(page, harness.url)
    await showMissionDropdownState(page, s.id)
  },
  close: async ({ page }) => {
    await page.evaluate(() => window.__missionDropdown.show('default', false, undefined))
  }
}))

// ---- the capture driver --------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { out: null, widths: CAPTURE_WIDTHS, only: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--out') out.out = argv[++i]
    else if (a === '--widths') out.widths = argv[++i].split(',').map(Number).filter(Boolean)
    else if (a === '--only') out.only = argv[++i].split(',').filter(Boolean)
    else throw new Error(`unknown argument ${a}`)
  }
  return out
}

async function capture(argv) {
  const opts = parseArgs(argv)
  const outDir = resolve(opts.out ?? join(REPO, '.harnu', 'out', 'mission-dropdown', 's1'))
  mkdirSync(outDir, { recursive: true })
  const { chromium } = await import('@playwright/test')
  const harness = await startMissionDropdownHarness()
  // `MISSION_DROPDOWN_CHROMIUM` points at a Chromium binary when Playwright's own download is not the one installed.
  const browser = await chromium.launch({
    executablePath: process.env.MISSION_DROPDOWN_CHROMIUM || undefined
  })
  try {
    for (const width of opts.widths) {
      const context = await browser.newContext({
        viewport: { width, height: CAPTURE_HEIGHT },
        colorScheme: 'dark',
        reducedMotion: 'no-preference'
      })
      const page = await context.newPage()
      await openHarnessPage(page, harness.url)
      for (const route of ROUTES_MISSION_DROPDOWN) {
        const state = route.id.split('#')[1]
        if (opts.only && !opts.only.includes(state)) continue
        await route.open({ page, harness })
        // The screen `entry`'s captures are named like the mockup's own: `entry-<state>-<width>-dark-en.png`.
        const name = state.startsWith('entry-') ? state : `mission-dropdown-${state}`
        const file = join(outDir, `${name}-${width}-dark-en.png`)
        await page.screenshot({ path: file })
        console.log(`  ✓ ${state} @${width} → ${file}`)
        await route.close?.({ page })
      }
      await context.close()
    }
  } finally {
    await browser.close()
    await harness.close()
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2)
  if (cmd !== 'capture') {
    console.error(
      'usage: node scripts/dev/dialog-routes/mission-dropdown.mjs capture [--out dir] [--widths 1280,360] [--only a,b]'
    )
    process.exit(2)
  }
  capture(rest).catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
