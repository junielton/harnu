/* parts/walk.js — the Guided test walk pane (a helper-stack pane), rendered into light DOM (<mk-walk>) from the
 * screen's ?state= (and ?n=1..3 for the step states). It also reads ?lang=en|pt-BR, ?theme=dark|light, ?h=<px> (frame
 * height, mockup only) and ?copied=1 (draws the first copy button already acknowledged, for captures).
 * Every piece of anatomy carries a data-dsqa-part; styles live in ../mockup.css.
 * Sample data is made up (example-web, orch-1, the Mission dropdown walk): no real session, folder or client names. */
;(() => {
  const q = new URLSearchParams(location.search)
  const lang = q.get('lang') === 'pt-BR' ? 'pt' : 'en'
  const theme = q.get('theme') === 'light' ? 'light' : 'dark'
  document.documentElement.dataset.theme = theme
  document.documentElement.lang = lang === 'pt' ? 'pt-BR' : 'en'
  if (q.get('h'))
    document.documentElement.style.setProperty('--stage-h', parseInt(q.get('h'), 10) + 'px')

  /* ── copy: en + pt-BR (NEW keys for the walk pane; the dropdown keeps its own) ── */
  const D = {
    en: {
      'hdr.title': 'Test walk',
      'hdr.sub': 'Mission dropdown',
      'hdr.expand': 'Expand to window',
      'hdr.max': 'Maximize',
      'hdr.close': 'Close',
      'check.of': (n, t) => `Check ${n} of ${t}`,
      'roadmap.open': 'See all checks',
      'rm.title': 'Test the Mission dropdown',
      'rm.sub': (t, d) => `${t} checks · ${d} already verified`,
      'rm.eyes': 'Your eyes only',
      'rm.icheck': 'I check',
      'rm.earlier': 'Verified earlier',
      'rm.start': (n) => `Start with ${n}`,
      'rm.change': 'Change the list',
      'rm.left': '1 left out · ours',
      'rm.leftBody':
        'Tidy the dropdown test names. It is our work, not a check. I can card it after the walk.',
      s1: 'Start the app on the branch',
      s2: 'The pill opens the dropdown',
      s3: 'The next-step button sits at the right',
      s4: 'A hover label names every state dot',
      s5: 'Sessions stay folded behind one line',
      s6: 'Ask has room beside the count',
      s7: 'The close dialog opens and cancels',
      s8: 'Types and build pass',
      s9: 'Light and dark both read well',
      'sec.do': 'Do',
      'sec.where': 'Where',
      'sec.see': 'You should see',
      'sec.check': 'I’ll check',
      not: 'Not',
      nothing: (why) => `Nothing from here: ${why}`,
      blocks: 'Check 2 to 6 need the running app.',
      's1.d1': 'Open a terminal in example-web.',
      's1.d2': 'Switch to the branch and start the app:',
      's1.d3': 'Wait until the Harnu window opens.',
      's1.see': 'The window opens and the Topbar shows a Mission pill next to the session name.',
      's1.not': 'the pill is missing, or the old Mission pane opens.',
      's2.d1': 'Click the Mission pill in the Topbar.',
      's2.d2': 'Press Esc.',
      's2.see':
        'A dropdown opens under the pill and no pane opens in the helper stack. Esc closes it.',
      's2.not': 'a Mission pane opens beside the terminal.',
      's3.d1': 'Open the dropdown from the pill.',
      's3.d2': 'Look at the card “Your next step”.',
      's3.d3': 'Shrink the window as narrow as it goes and look again.',
      's3.see':
        'Wide: the “Open step” button is on the title line, at the right. Narrow: it sits under the text.',
      's3.not': 'the button under the text on a wide window.',
      's3.why': 'only your eyes can judge a layout',
      ev7: 'vitest MissionCloseDialog · 4 passed',
      ev8: 'npm run typecheck · 0 errors',
      'w.design': 'design.md · Mission dropdown',
      'w.mockup': 'mockup/index.html',
      'w.pr': 'PR #21',
      'w.branch': 'card/mission-dropdown',
      'cp.copy': 'Copy',
      'cp.copied': 'Copied',
      'cp.value': (what) => `Copy ${what}`,
      'img.cap': 'Expected · wide window',
      'img.zoom': 'Enlarge',
      'img.esc': 'Esc to close',
      'img.alt':
        'The Mission dropdown on a wide window: the Open step button sits on the title line of the next-step card, at the right',
      'a.done': 'Done',
      'a.failed': 'Failed',
      'a.back': 'Back',
      'a.skip': 'Skip',
      'a.explain': 'Explain more',
      'a.lost': 'I didn’t get this step',
      'kbd.enter': 'Enter',
      'f.title': 'What did you see?',
      'f.ph': 'One line is enough',
      'f.line': 'The button is under the text, even at 1280 px.',
      'f.paste': 'Paste a screenshot',
      'f.pasteKey': 'Ctrl+V',
      'f.attached': 'Pasted image 1',
      'f.remove': 'Remove',
      'f.send': 'Send',
      'f.cancel': 'Back to the step',
      'fr.reported': 'You reported',
      'fr.eyebrow': 'My one correction',
      'fr.cause':
        'Most likely cause: the card changes layout at 380 px, and the dropdown body is narrower on a small window. Widen the window to 1280 px, reopen the dropdown, and look again.',
      'fr.again': 'Same step, again',
      'fr.try': 'Try again',
      'fr.still': 'Still wrong? Send it to the step’s builder',
      'cf.title': 'You said Done. My check disagrees.',
      'cf.ran': 'I ran',
      'cf.expected': 'Expected',
      'cf.found': 'Found',
      'cf.none': 'no files',
      'cf.note':
        'Nothing later depends on this check, so you can follow anyway. It is recorded as unverified.',
      'cf.follow': 'Follow anyway (unverified)',
      'cf.retry': 'Try again',
      'ex.why': 'Why this matters',
      'ex.whyBody':
        'The button used to sit under the text, so the card was a line taller than it needed to be. This part was fixed twice, and the narrow fallback is the one that broke.',
      'ex.extra': (n) => `Extra checks · ${n}`,
      'ex.hint': 'Done closes the step with these. Unticked ones are listed at the end.',
      'e1.t': 'Narrow window: the button drops under the text',
      'e1.d': 'Shrink the window until the dropdown is narrower than 380 px.',
      'e2.t': 'Dark theme: the button text stays readable',
      'e2.d': 'Settings → Appearance → Theme',
      approx: 'path approximate',
      'e3.t': 'Empty state: no open step, no button',
      'e3.d': 'Open a mission with nothing left for you.',
      'du.eyebrow': 'Said more simply',
      'du.body':
        'The card has a line of text and a button. On a wide window the button goes at the right, on the same line as “Your next step”. On a narrow window it goes under the text.',
      'du.d1': 'Open the dropdown.',
      'du.d2': 'Drag the window edge to make it narrower.',
      'du.d3': 'Watch where the button moves.',
      'w.check': (n) => `Running my check on check ${n}`,
      'w.prep': (n) => `Getting check ${n} ready`,
      'w.quiet': 'This takes a moment. You do not need to do anything.',
      'w.next': 'Next',
      'w.mock': 'Mockup: jump to the end of the walk',
      'w.done': (n) => `Check ${n} closed`,
      'sk.title': (n) => `${n} checks were skipped`,
      'sk.sub': 'Look at them now, or close the walk and leave them open.',
      'sk.now': 'Check them now',
      'sk.close': (n) => `Close out with ${n} skipped`,
      'sk.retry': 'Check now',
      'co.title': 'Walk finished',
      'co.sub': (v, u, s) => `${v} verified · ${u} unverified · ${s} skipped`,
      'co.agreed': 'you confirmed · my check agreed',
      'co.eyes': 'you confirmed · nothing to check from here',
      'co.earlier': (x) => `verified earlier · ${x}`,
      'co.unver': 'followed anyway · my check found MissionPane.vue',
      'co.skip': 'skipped',
      'co.owed': 'Still yours',
      'co.crit':
        'Tick the criterion “Check the scores of the first twelve specs by hand”. I never tick it for you.',
      'co.critGo': 'Open in the Mission',
      'co.owedMore': '2 skipped checks and 1 unverified check are listed above.',
      'co.copy': 'Copy summary',
      'co.sum1': 'Test walk · Mission dropdown · 9 checks',
      'co.sum2': '! 2 The pill opens the dropdown: followed anyway, my check found MissionPane.vue',
      'co.sum3': '- 5 Sessions stay folded behind one line: skipped',
      'co.sum4': '- 9 Light and dark both read well: skipped',
      'em.title': 'No walk loaded',
      'em.body':
        'A walk starts from a step in the Mission dropdown. Open a step and choose Test it.',
      'em.btn': 'Open the Mission',
      'er.title': 'The session is gone',
      'er.body':
        'orch-1 ended, so I cannot serve the next check. Your progress is saved: 4 of 9 checked.',
      'er.resume': 'Resume the session',
      'er.copy': 'Copy progress',
      'er.err': 'Error: session orch-1 not found'
    }
  }
  D.pt = D.en /* the committed mockup is English only */
  const t = (k, ...a) => {
    const v = D[lang][k]
    return typeof v === 'function' ? v(...a) : v
  }
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
  /* ── scope addendum: the walk is its own object (a source, a list of checks, a run history), a Mission is one source.
   * Strings below override or extend the ones above. ── */
  Object.assign(D.en, {
    'hdr.title': 'Walk',
    'hdr.walks': 'Walks',
    'a.lost': 'I didn’t get this check',
    'wt.mission': 'Mission dropdown',
    'wt.export': 'Add CSV export',
    'src.mission': 'Mission · Redesign the Mission view · step “Build the dropdown”',
    'src.milestone': 'Mission · Redesign the Mission view · milestone “Dropdown and library”',
    'src.all': 'Mission · Redesign the Mission view · the whole mission',
    'src.pr': 'PR #48 · Add CSV export · alex',
    'src.feature': 'Feature · built in this session (orch-1)',
    'rt.mission': 'Test the Mission dropdown',
    'rt.pr': 'Test PR #48: Add CSV export',
    'rt.feature': 'Walk through the CSV export',
    'rm.sub0': (t) => `${t} checks`,
    'rm.sub.rerun': (t, n) => `Same ${t} checks · run ${n}`,
    'rr.chip': (n) => `Re-run · run ${n}`,
    x1: 'Export is in the toolbar',
    x2: 'Export downloads the rows you see',
    x3: 'An empty table exports a header row',
    x4: 'Commas and quotes in cells are escaped',
    x5: 'A 10,000-row table exports without freezing the page',
    x6: 'The file name carries the date',
    'x1.d1': 'Open the Orders page.',
    'x1.d2': 'Look at the toolbar above the table.',
    'x1.see': 'An Export button sits at the right end of the toolbar, next to Filter.',
    'x1.not': 'no button, or a button that stays disabled while rows are showing.',
    'x1.why': 'only your eyes can see a toolbar',
    'x2.d1': 'Type “acme” in the filter.',
    'x2.d2': 'Click Export.',
    'x2.d3': 'Open the downloaded file.',
    'x2.see':
      'A file named orders-export.csv with a header row and only the rows that match “acme”.',
    'x2.not': 'every row of the table.',
    'x3.d1': 'Type “zzzz” in the filter so that no row matches.',
    'x3.d2': 'Click Export.',
    'x3.see': 'A file with only the header line: id,customer,total.',
    'x3.not': 'an empty file, or a file with no header.',
    'x3.why': 'only your eyes can open the file',
    'w.orders': 'localhost:5173/orders',
    'w.pr123': 'PR #48',
    'w.btn': 'ExportButton.vue',
    'w.csv': 'build-csv.ts',
    'note.empty': 'Header row missing when the table is empty.',
    'lt.passed': 'last time: passed',
    'lt.failed': 'last time: failed',
    'lt.skipped': 'last time: skipped',
    'lt.hint.passed': 'Last time: passed',
    'lt.hint.failed': (n) => `Last time: failed · “${n}”`,
    'lt.hint.skipped': 'Last time: skipped',
    'tc.eyebrow': 'Behind this check',
    'tc.does': 'What it does',
    'tc.doesB':
      'Export takes the rows the table shows right now, after the filter, and turns each one into a line of text with commas between the values.',
    'tc.where': 'Where it lives',
    'tc.idea': 'The idea behind it',
    'tc.ideaB':
      'CSV escaping: a cell that holds a comma or a quote is wrapped in quotes, and any quote inside it is doubled.',
    'tc.ideaL': 'RFC 4180 · CSV',
    'tc.why': 'Why it behaves this way',
    'tc.whyB':
      'It exports the filtered rows because the toolbar acts on what you see. A hidden row showing up in the file would surprise you.',
    'tc.extra': (n) => `Extra checks · ${n}`,
    'lib.title': 'Walks',
    'lib.sub': (n) => `${n} walks · saved on this machine`,
    'lib.rerun': 'Re-run',
    'lib.open': 'Open',
    'lib.passed': (a, b) => `${a} of ${b} passed`,
    lw1: 'Mission dropdown',
    'lw1.s': 'Mission',
    lw2: 'Add CSV export',
    'lw2.s': 'PR #48 · alex',
    lw3: 'CSV export, end to end',
    'lw3.s': 'Feature',
    lw4: 'Dark theme pass',
    'lw4.s': 'Branch card/dark-theme',
    lw5: 'Release smoke checks',
    'lw5.s': 'Card · Release 0.14',
    'd.nov17': 'Nov 17',
    'd.nov16': 'Nov 16',
    'd.nov15': 'Nov 15',
    'd.nov9': 'Nov 9',
    'd.nov2': 'Nov 2',
    'lib.empty.title': 'No walks yet',
    'lib.empty.body':
      'A walk is saved here after you run one. Ask a session to start one, or use Test it in the Mission.',
    'lib.empty.hint': 'Or just say: “walk me through what we just built”.',
    'pp.back': 'Walks',
    'pp.ro': 'Read-only',
    'pp.run': (n, d) => `Run ${n} · ${d}`,
    'pp.sum': (p, f, s) => `${p} passed · ${f} failed · ${s} skipped`,
    'pp.rerun': 'Re-run',
    'pp.export': 'Export markdown',
    'pp.wrote': 'You wrote',
    'pp.failedNote': 'failed',
    'co.failed': (n) => `failed · “${n}”`,
    'co.saved': 'Saved in Walks',
    'co.savedBody': 'Reopen this run or re-run the same checks later.',
    'co.export': 'Export markdown',
    'co.open': 'Open Walks',
    'fr.still.mission': 'Still wrong? Send it to the step’s builder',
    'fr.still.pr': 'Still wrong? Draft a comment for the PR',
    'fr.still.feature': 'Still wrong? Make a bug card',
    'em.title': 'No walk open',
    'em.body':
      'Ask a session to start one (“walk me through what we just built”, or /step-by-step PR #48), use Test it in the Mission, or reopen one from Walks.',
    'em.btn': 'Open Walks',
    'em.btn2': 'Open the Mission',
    'of.eyebrow': 'Walk',
    'of.l1': 'Done. The Export button, build-csv.ts and 14 tests are in.',
    'of.l2': 'Run the app and the export works on the Orders page.',
    'of.ask': 'Want me to walk you through what I built?',
    'of.why':
      'I write the list of checks and take you through them one by one. Nothing here changes code.',
    'of.learn': 'Walk me through it',
    'of.qa': 'Test it end to end',
    'of.later': 'Not now',
    'of.sess': 'orch-1',
    'of.prompt': 'Ask orch-1 anything…'
  })

  /* ── icons (lucide paths) ── */
  const P = {
    checks:
      '<path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>',
    expand:
      '<path d="m15 15 6 6"/><path d="m15 9 6-6"/><path d="M21 16v5h-5"/><path d="M21 8V3h-5"/><path d="M3 16v5h5"/><path d="m3 21 6-6"/><path d="M3 8V3h5"/><path d="M9 9 3 3"/>',
    max: '<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" x2="14" y1="3" y2="10"/><line x1="3" x2="10" y1="21" y2="14"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    ext: '<path d="M7 7h10v10"/><path d="M7 17 17 7"/>',
    file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
    branch:
      '<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
    pr: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><line x1="6" x2="6" y1="9" y2="21"/>',
    cog: '<path d="M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z"/><path d="M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z"/>',
    eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
    term: '<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>',
    zoom: '<circle cx="11" cy="11" r="8"/><line x1="21" x2="16.65" y1="21" y2="16.65"/><line x1="11" x2="11" y1="8" y2="14"/><line x1="8" x2="14" y1="11" y2="11"/>',
    list: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>',
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    right: '<path d="m9 18 6-6-6-6"/>',
    down: '<path d="m6 9 6 6 6-6"/>',
    refresh:
      '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
    img: '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21"/>',
    send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
    plug: '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>',
    lib: '<path d="m16 6 4 14"/><path d="M12 6v14"/><path d="M8 8v12"/><path d="M4 4v16"/>',
    back: '<path d="m15 18-6-6 6-6"/>',
    spark:
      '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    target:
      '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
    play: '<polygon points="6 3 20 12 6 21 6 3"/>'
  }
  const ic = (n, c = '') =>
    `<svg class="i ${c}" viewBox="0 0 24 24" aria-hidden="true">${P[n]}</svg>`
  /* the skill's six glyphs, never emoji: ✓ closed and verified · ✗ failed, open · ! closed with a caveat · - not reached or skipped · ⚑ owed to the operator · ? open question */
  const gl = (g) =>
    `<span class="gl gl-${{ '✓': 'ok', '✗': 'bad', '!': 'warn', '-': 'off', '⚑': 'you', '?': 'ask' }[g]}" aria-hidden="true">${g}</span>`
  const go = (s, extra = '') => `data-goto=${JSON.stringify('walk?state=' + s + extra)}`

  /* Navigation map. Each element below carries data-goto (built by go() or written out); the literals are listed so the checker and a reader can see every edge:
   * data-goto="entry?state=step-open"
   * data-goto="entry?state=milestone"
   * data-goto="entry?state=mission"
   * data-goto="library?state=list"
   * data-goto="library?state=empty"
   * data-goto="walk?state=roadmap"
   * data-goto="walk?state=pr"
   * data-goto="walk?state=step&n=1"
   * data-goto="walk?state=step&n=2"
   * data-goto="walk?state=step&n=3"
   * data-goto="walk?state=step"
   * data-goto="walk?state=step-image"
   * data-goto="walk?state=lightbox"
   * data-goto="walk?state=failed"
   * data-goto="walk?state=failed-retry"
   * data-goto="walk?state=check-failed"
   * data-goto="walk?state=explain-more"
   * data-goto="walk?state=explain-teach"
   * data-goto="walk?state=did-not-understand"
   * data-goto="walk?state=working&kind=next"
   * data-goto="walk?state=skipped-at-end"
   * data-goto="walk?state=close-out"
   * data-goto="walk?state=run-past"
   * data-goto="walk?state=rerun-roadmap"
   * data-goto="walk?state=rerun"
   */

  /* ── two sample walks: the Mission dropdown walk (9 checks, a mission is its source) and the CSV export walk (6 checks,
   * its source is a PR or the feature just built). Which one, and from where, comes from ?walk= and ?src=. ── */
  const state0 = q.get('state') || 'roadmap'
  const DEFW = {
    pr: ['export', 'pr'],
    'explain-teach': ['export', 'feature'],
    'run-past': ['export', 'pr'],
    'rerun-roadmap': ['export', 'pr'],
    rerun: ['export', 'pr']
  }
  const WK = q.get('walk') || (DEFW[state0] ? DEFW[state0][0] : 'mission')
  const SRC = q.get('src') || (DEFW[state0] ? DEFW[state0][1] : WK === 'export' ? 'pr' : 'mission')
  const isMission = SRC === 'mission' || SRC === 'milestone' || SRC === 'all'
  const TOT = WK === 'export' ? 6 : 9
  const tk = (k) => t((WK === 'export' ? 'x' : 's') + k)
  const wtitle = () => t('wt.' + WK)
  const PRURL = 'https://github.com/example-org/example-web/pull/48'
  const FULL = {
    branch: 'card/mission-dropdown',
    design: '/home/user/example-web/design.md',
    mockup: '/home/user/example-web/.harnu/out/mission-dropdown/mockup/index.html',
    pane: '/home/user/example-web/src/renderer/src/components/MissionPane.vue',
    btn: '/home/user/example-web/src/export/ExportButton.vue',
    csv: '/home/user/example-web/src/export/build-csv.ts',
    pr21: 'https://github.com/example-org/example-web/pull/21'
  }
  const HOWS = {
    mission: {
      1: ['check', 'git branch --show-current'],
      2: ['check', 'rg -l MissionPane src/renderer/src'],
      3: ['eyes'],
      4: ['eyes'],
      5: ['eyes'],
      6: ['eyes'],
      7: ['earlier'],
      8: ['earlier'],
      9: ['eyes']
    },
    export: {
      1: ['eyes'],
      2: ['check', 'head -1 ~/Downloads/orders-export.csv'],
      3: ['eyes'],
      4: ['eyes'],
      5: ['eyes'],
      6: ['check', 'ls ~/Downloads | grep orders-']
    }
  }
  const HOW = HOWS[WK]
  const EARLIER = WK === 'mission' ? { 7: 'ev7', 8: 'ev8' } : {}
  /* a finished run: [glyph, how it was verified] per check */
  const PASTS = {
    mission: {
      1: ['✓', 'agreed'],
      2: ['!', 'unver'],
      3: ['✓', 'eyes'],
      4: ['✓', 'eyes'],
      5: ['-', 'skip'],
      6: ['✓', 'eyes'],
      7: ['✓', 'earlier'],
      8: ['✓', 'earlier'],
      9: ['-', 'skip']
    },
    export: {
      1: ['✓', 'eyes'],
      2: ['✓', 'agreed'],
      3: ['✗', 'failed'],
      4: ['✓', 'eyes'],
      5: ['-', 'skip'],
      6: ['✓', 'agreed']
    }
  }
  const PAST = PASTS[WK]
  const NOTES = { mission: {}, export: { 3: t('note.empty') } }[WK]
  const cnt = (g) => Object.values(PAST).filter((x) => x[0] === g).length

  /* a value with a one-click copy. `what` names it for the accessible label. */
  const cp = (value, what, o = {}) =>
    `<button class="cp${o.label ? ' cp-l' : ''}" type="button" data-copy="${esc(value)}" aria-label="${esc(t('cp.value', what))}" title="${esc(t('cp.value', what))}">${ic('copy', 'i10')}${o.label ? `<span class="cp-t">${t('cp.copy')}</span>` : ''}<span class="cp-ack" aria-live="polite"></span></button>`
  const code = (text, what) =>
    `<div class="code" data-dsqa-part="command"><pre>${esc(text)}</pre>${cp(text, what, { label: true })}</div>`
  const val = (text, what, full) =>
    `<span class="val"><code>${esc(text)}</code>${cp(full || text, what)}</span>`
  const link = (icon, label, o = {}) =>
    `<span class="lk split wl" data-dsqa-part="link"><button type="button" class="open" title="${esc(o.title || label)}">${ic(icon, 'i10')}<span class="x ${o.mono ? 'mono' : ''}">${esc(label)}</span>${ic('ext', 'i10 ext')}</button>${o.copy ? cp(o.copy, o.what || label) : ''}</span>`
  const prLink = () =>
    link('pr', t('w.pr123'), { mono: true, title: PRURL, copy: PRURL, what: 'the PR link' })

  /* the source line: where this walk comes from (a mission step, milestone or whole mission, a PR, or a feature just built) */
  const srcLine = () => {
    const text = t(
      {
        mission: 'src.mission',
        milestone: 'src.milestone',
        all: 'src.all',
        pr: 'src.pr',
        feature: 'src.feature'
      }[SRC] || 'src.mission'
    )
    const icon = isMission ? 'target' : SRC === 'pr' ? 'pr' : 'spark'
    const body =
      SRC === 'feature'
        ? `<span class="x trunc">${esc(text)}</span>`
        : `<button type="button" class="open trunc" title="${esc(text)}" ${isMission ? 'data-goto="entry?state=step-open"' : ''}><span class="x trunc">${esc(text)}</span>${ic('ext', 'i10 ext')}</button>${SRC === 'pr' ? cp(PRURL, 'the PR link') : ''}`
    const chip = state0.startsWith('rerun') ? `<span class="runchip">${t('rr.chip', 4)}</span>` : ''
    return `<div class="src" data-dsqa-part="source">${ic(icon, 'i10')}${body}${chip}</div>`
  }

  const closedSet = (n, state) => {
    if (['close-out', 'skipped-at-end', 'run-past'].includes(state))
      return new Set(
        Object.keys(PAST)
          .filter((k) => PAST[k][0] !== '-' && PAST[k][0] !== '✗')
          .map(Number)
      )
    const c = new Set(Object.keys(EARLIER).map(Number))
    if (!state0.startsWith('rerun')) for (let i = 1; i < n; i++) c.add(i)
    else for (let i = 1; i < n; i++) c.add(i)
    return c
  }
  const bar = (n, state) => {
    const closed = closedSet(n, state)
    const cells = Array.from({ length: TOT }, (_, i) => {
      const k = i + 1
      return `<span class="cell ${closed.has(k) ? 'done' : k === n && !['roadmap', 'close-out', 'skipped-at-end', 'empty', 'error', 'pr', 'rerun-roadmap', 'run-past'].includes(state) ? 'cur' : ''}"></span>`
    }).join('')
    return `<div class="rail" role="progressbar" aria-valuemin="0" aria-valuemax="${TOT}" aria-valuenow="${closed.size}" aria-label="${esc(t('check.of', n, TOT))}">${cells}</div>`
  }
  const top = (n, state) =>
    `${srcLine()}<div class="wk-top" data-dsqa-part="progress"><div class="wk-top-r"><span class="wk-count num">${t('check.of', n, TOT)}</span><button type="button" class="ib" ${go('roadmap')} title="${esc(t('roadmap.open'))}" aria-label="${esc(t('roadmap.open'))}">${ic('list', 'i12')}</button></div>${bar(n, state)}</div>`

  const header = (
    title
  ) => `<div class="ph" data-dsqa-part="pane-header"><span class="ph-ic">${ic('checks', 'i12')}</span><span class="ttl trunc"><b>${t('hdr.title')}</b> · ${title || wtitle()}</span>
    <button type="button" class="ib" data-goto="library?state=list" aria-label="${esc(t('hdr.walks'))}" title="${esc(t('hdr.walks'))}" data-dsqa-part="walks-door">${ic('lib', 'i12')}</button><button type="button" class="ib" aria-label="${esc(t('hdr.expand'))}" title="${esc(t('hdr.expand'))}">${ic('expand', 'i12')}</button><button type="button" class="ib" aria-label="${esc(t('hdr.max'))}" title="${esc(t('hdr.max'))}">${ic('max', 'i12')}</button><button type="button" class="ib" aria-label="${esc(t('hdr.close'))}" title="${esc(t('hdr.close'))}">${ic('x', 'i12')}</button></div>`

  /* ── step content (checks 1–3 of each walk are served in this mockup) ── */
  const STEPS = {
    mission: {
      1: () => ({
        do: [
          t('s1.d1'),
          [t('s1.d2'), 'git switch card/mission-dropdown\nnpm run dev', 'the commands'],
          t('s1.d3')
        ],
        where: [
          prLink21(),
          link('branch', t('w.branch'), {
            mono: true,
            title: t('w.branch'),
            copy: FULL.branch,
            what: 'the branch name'
          })
        ],
        see: t('s1.see'),
        not: t('s1.not'),
        check: { cmd: 'git branch --show-current', expect: FULL.branch },
        blocks: true
      }),
      2: () => ({
        do: [t('s2.d1'), t('s2.d2')],
        where: [
          link('file', t('w.design'), {
            title: 'design.md',
            copy: FULL.design,
            what: 'the file path'
          })
        ],
        see: t('s2.see'),
        not: t('s2.not'),
        check: { cmd: 'rg -l MissionPane src/renderer/src', expect: t('cf.none') }
      }),
      3: () => ({
        do: [t('s3.d1'), t('s3.d2'), t('s3.d3')],
        where: [
          link('file', t('w.mockup'), {
            title: 'mission-dropdown/mockup/index.html',
            copy: FULL.mockup,
            what: 'the file path'
          }),
          prLink21()
        ],
        see: t('s3.see'),
        not: t('s3.not'),
        eyes: t('s3.why'),
        image: true
      })
    },
    export: {
      1: () => ({
        do: [t('x1.d1'), t('x1.d2')],
        where: [
          link('link', t('w.orders'), {
            mono: true,
            title: 'http://localhost:5173/orders',
            copy: 'http://localhost:5173/orders',
            what: 'the URL'
          }),
          link('file', t('w.btn'), {
            title: 'src/export/ExportButton.vue',
            copy: FULL.btn,
            what: 'the file path'
          }),
          ...(SRC === 'pr' ? [prLink()] : [])
        ],
        see: t('x1.see'),
        not: t('x1.not'),
        eyes: t('x1.why')
      }),
      2: () => ({
        do: [t('x2.d1'), t('x2.d2'), t('x2.d3')],
        where: [
          link('file', t('w.csv'), {
            title: 'src/export/build-csv.ts',
            copy: FULL.csv,
            what: 'the file path'
          }),
          ...(SRC === 'pr' ? [prLink()] : [])
        ],
        see: t('x2.see'),
        not: t('x2.not'),
        check: { cmd: 'head -1 ~/Downloads/orders-export.csv', expect: 'id,customer,total' }
      }),
      3: () => ({
        do: [t('x3.d1'), t('x3.d2')],
        where: [
          link('link', t('w.orders'), {
            mono: true,
            title: 'http://localhost:5173/orders',
            copy: 'http://localhost:5173/orders',
            what: 'the URL'
          }),
          ...(SRC === 'pr' ? [prLink()] : [])
        ],
        see: t('x3.see'),
        not: t('x3.not'),
        eyes: t('x3.why')
      })
    }
  }
  function prLink21() {
    return link('pr', t('w.pr'), {
      mono: true,
      title: FULL.pr21,
      copy: FULL.pr21,
      what: 'the PR link'
    })
  }
  const stepOf = (n) => STEPS[WK][n]()

  const sec = (label, body, part) =>
    `<section class="sec" data-dsqa-part="${part}"><div class="eyebrow">${label}</div>${body}</section>`
  const doList = (items) =>
    `<ol class="do">${items.map((it, i) => (Array.isArray(it) ? `<li><span class="n num">${i + 1}.</span><div class="li">${it[0]}${code(it[1], it[2])}</div></li>` : `<li><span class="n num">${i + 1}.</span><div class="li">${it}</div></li>`)).join('')}</ol>`
  const shot = (big) =>
    `<figure class="shot ${big ? 'big' : 'thumb'}" data-dsqa-part="${big ? 'image-large' : 'image-thumb'}"><button type="button" class="zoom-hit" ${go(big ? 'lightbox' : 'step-image')} aria-label="${esc(t('img.zoom'))}"><img src="../assets/expected-dropdown-wide.png" alt="${esc(t('img.alt'))}"></button><figcaption><span>${t('img.cap')}</span><span class="zoom">${ic('zoom', 'i10')}${t('img.zoom')}</span></figcaption></figure>`
  const checkLine = (s) =>
    s.check
      ? `<div class="chk" data-dsqa-part="my-check">${ic('term', 'i10')}<span class="k">${t('sec.check')}</span>${val(s.check.cmd, 'the check command')}<span class="arrow">→</span>${val(s.check.expect, 'the expected value')}</div>`
      : `<div class="chk quiet" data-dsqa-part="my-check">${ic('eye', 'i10')}<span>${t('nothing', s.eyes)}</span></div>`

  /* "last time" of a check in the run this one repeats */
  const lastOf = (k) => {
    const g = PAST[k][0]
    return g === '✓' ? 'passed' : g === '-' ? 'skipped' : 'failed'
  }
  const lastNote = (k) =>
    NOTES[k] || (WK === 'mission' && PAST[k][1] === 'unver' ? 'MissionPane.vue' : '')
  const lastHint = (k) => {
    if (!state0.startsWith('rerun')) return ''
    const l = lastOf(k)
    return `<div class="lt-hint ${l}" data-dsqa-part="last-time">${l === 'failed' ? t('lt.hint.failed', lastNote(k) || '…') : t('lt.hint.' + l)}</div>`
  }

  /* the step body: Do · Where · You should see · I'll check (one check on screen) */
  const stepBody = (n, o = {}) => {
    const s = stepOf(n)
    return `<h2 class="wk-title" data-dsqa-part="step-title">${tk(n)}</h2>${lastHint(n)}
      ${s.blocks ? `<div class="blocks">${t('blocks')}</div>` : ''}
      ${sec(t('sec.do'), doList(s.do), 'do')}
      ${sec(t('sec.where'), `<div class="links">${s.where.join('')}</div>`, 'where')}
      ${sec(t('sec.see'), `<div class="see"><p>${s.see}</p><p class="not">${gl('✗')}<span>${t('not')}: ${s.not}</span></p></div>${s.image ? shot(o.bigImage) : ''}`, 'see')}
      ${sec(t('sec.check'), checkLine(s), 'check')}`
  }

  /* which side doors exist depends on the sample: the mockup draws the deep states for check 3 of the Mission walk and check 2 of the export walk */
  const deep = (n) =>
    (WK === 'mission' && n === 3) || (WK === 'export' && n === 2 && SRC === 'feature')
  const explainTo = (n) =>
    WK === 'mission' && n === 3
      ? go('explain-more')
      : WK === 'export' && n === 2 && SRC === 'feature'
        ? go('explain-teach')
        : ''
  const actions = (n, o = {}) => {
    const dn =
      o.doneGoto ||
      (n >= 3
        ? go('working', '&kind=next')
        : WK === 'mission' && n === 2
          ? go('check-failed')
          : go('step', '&n=' + (n + 1)))
    return `<div class="wk-foot" data-dsqa-part="actions">
      <button type="button" class="btn md primary" ${dn} data-autofocus aria-keyshortcuts="Enter" title="${esc(t('a.done'))} (Enter)">${gl('✓')}<span>${t('a.done')}</span><kbd>${t('kbd.enter')}</kbd></button>
      <button type="button" class="btn md" ${o.failGoto || (WK === 'mission' && n === 3 ? go('failed') : '')}>${gl('✗')}<span>${t('a.failed')}</span></button>
      <span class="sp2"></span>
      <button type="button" class="btn ghost" ${o.backGoto || (n > 1 ? go('step', '&n=' + (n - 1)) : go('roadmap'))}>${t('a.back')}</button>
      <button type="button" class="btn ghost" ${o.skipGoto || go('working', '&kind=next')}>${gl('-')}<span>${t('a.skip')}</span></button>
      <button type="button" class="btn ghost" ${o.explainGoto !== undefined ? o.explainGoto : explainTo(n)}${o.explainOn ? ' aria-pressed="true"' : ''}>${ic('plus', 'i10')}${t('a.explain')}</button></div>`
  }
  const lost = (n) =>
    `<button type="button" class="lost" ${WK === 'mission' && n === 3 ? go('did-not-understand') : ''}>${t('a.lost')}</button>`

  /* ── states ── */
  const evidence = (k) => {
    const how = HOW[k]
    return how[0] === 'check'
      ? `<span class="m-k">${t('rm.icheck')}</span>${val(how[1], 'the check command')}`
      : how[0] === 'eyes'
        ? `<span class="m-k">${t('rm.eyes')}</span>`
        : `<span class="m-k">${t('rm.earlier')}</span>${val(t(EARLIER[k]), 'the evidence')}`
  }
  const rmRow = (k, o = {}) => {
    const done = HOW[k][0] === 'earlier'
    const lt = o.last
      ? `<span class="lt ${lastOf(k)}" data-dsqa-part="last-time">${t('lt.' + lastOf(k))}</span>`
      : ''
    return `<li class="rm-row" data-dsqa-part="roadmap-row"><span class="g1">${gl(done ? '✓' : '-')}</span><span class="n num">${k}</span><span class="t">${tk(k)}</span><span class="m">${evidence(k)}${lt}</span></li>`
  }
  const roadmap = (o = {}) => {
    const title =
      WK === 'mission' ? t('rt.mission') : t('rt.' + (SRC === 'feature' ? 'feature' : 'pr'))
    const earlier = Object.keys(EARLIER).length
    const sub = o.rerun
      ? t('rm.sub.rerun', TOT, 4)
      : earlier
        ? t('rm.sub', TOT, earlier)
        : t('rm.sub0', TOT)
    return {
      top: srcLine(),
      body: `<div class="wk-head"><h2 class="wk-title">${title}</h2><div class="sub">${sub}</div></div>
        <ol class="rm" data-dsqa-part="roadmap">${Array.from({ length: TOT }, (_, i) => rmRow(i + 1, { last: o.rerun })).join('')}</ol>
        ${WK === 'mission' ? `<details class="left" data-dsqa-part="left-out"><summary>${ic('right', 'i10 chev')}${t('rm.left')}</summary><p>${t('rm.leftBody')}</p></details>` : ''}`,
      foot: `<div class="wk-foot" data-dsqa-part="actions"><button type="button" class="btn md primary" ${go('step', '&n=1')} data-autofocus aria-keyshortcuts="Enter">${t('rm.start', 1)}<kbd>${t('kbd.enter')}</kbd></button><button type="button" class="btn ghost">${t('rm.change')}</button></div>`
    }
  }

  const stepState = (n, o = {}) => ({
    top: top(n, 'step'),
    body: `${stepBody(n, o)}${lost(n)}`,
    foot: actions(n)
  })

  const failed = (n) => ({
    top: top(n, 'step'),
    body: `<h2 class="wk-title">${tk(n)}</h2>
      <section class="sec" data-dsqa-part="failure-input"><label class="eyebrow" for="fl">${t('f.title')}</label>
        <input id="fl" class="line" type="text" value="${esc(t('f.line'))}" placeholder="${esc(t('f.ph'))}" data-autofocus>
        <div class="paste" data-dsqa-part="paste-area"><span class="ph-i">${ic('img', 'i14')}</span><div class="pt"><b>${t('f.paste')}</b><span class="kbd2">${t('f.pasteKey')}</span></div>
          <div class="att" data-dsqa-part="attachment"><img src="../assets/pasted-1.png" alt=""><span class="trunc">${t('f.attached')}.png</span><button type="button" class="ib" aria-label="${esc(t('f.remove'))}" title="${esc(t('f.remove'))}">${ic('x', 'i10')}</button></div></div></section>`,
    foot: `<div class="wk-foot" data-dsqa-part="actions"><button type="button" class="btn md primary" ${go('failed-retry')}>${ic('send', 'i10')}${t('f.send')}<kbd>${t('kbd.enter')}</kbd></button><button type="button" class="btn ghost" ${go('step', '&n=' + n)}>${t('f.cancel')}</button></div>`
  })

  const failedRetry = (n) => {
    const s = stepOf(n)
    return {
      top: top(n, 'step'),
      body: `<h2 class="wk-title">${tk(n)}</h2>
      <div class="reported" data-dsqa-part="reported"><span class="eyebrow">${t('fr.reported')}</span><p>${esc(t('f.line'))}</p><span class="att small"><img src="../assets/pasted-1.png" alt=""><span class="trunc">${t('f.attached')}.png</span></span></div>
      <section class="card acc fix" data-dsqa-part="correction"><div class="eb">${t('fr.eyebrow')}</div><p class="ask">${t('fr.cause')}</p><div class="fixv">${val('1280 px', 'the width')}</div></section>
      ${sec(t('fr.again'), `${doList(s.do)}<div class="see tight"><p>${s.see}</p></div>`, 'reserved-step')}
      <button type="button" class="lost" data-dsqa-part="builder-door">${t('fr.still.' + (isMission ? 'mission' : SRC))}</button>`,
      foot: `<div class="wk-foot" data-dsqa-part="actions"><button type="button" class="btn md primary" ${go('step', '&n=' + n)} data-autofocus>${ic('refresh', 'i10')}${t('fr.try')}<kbd>${t('kbd.enter')}</kbd></button><button type="button" class="btn md" ${go('failed')}>${gl('✗')}<span>${t('a.failed')}</span></button><span class="sp2"></span><button type="button" class="btn ghost" ${go('step', '&n=' + (n - 1))}>${t('a.back')}</button><button type="button" class="btn ghost" ${go('working', '&kind=next')}>${gl('-')}<span>${t('a.skip')}</span></button></div>`
    }
  }

  const checkFailed = (n) => {
    const s = stepOf(n)
    return {
      top: top(n, 'step'),
      body: `<h2 class="wk-title">${tk(n)}</h2>
      <section class="card warn evid" data-dsqa-part="check-evidence"><div class="eb">${gl('!')}<span>${t('cf.title')}</span></div>
        <dl><dt>${t('cf.ran')}</dt><dd>${val(s.check.cmd, 'the check command')}</dd><dt>${t('cf.expected')}</dt><dd>${val(s.check.expect, 'the expected value')}</dd><dt>${t('cf.found')}</dt><dd>${val('MissionPane.vue', 'the file path', FULL.pane)}</dd></dl>
        <p class="why">${t('cf.note')}</p></section>`,
      foot: `<div class="wk-foot" data-dsqa-part="actions"><button type="button" class="btn md primary" ${go('step', '&n=2')} data-autofocus>${ic('refresh', 'i10')}${t('cf.retry')}<kbd>${t('kbd.enter')}</kbd></button><button type="button" class="btn md" ${go('step', '&n=3')}>${gl('!')}<span>${t('cf.follow')}</span></button><span class="sp2"></span><button type="button" class="btn ghost" ${go('step', '&n=1')}>${t('a.back')}</button></div>`
    }
  }

  const explain = (n) => {
    const ex = (tt, d, approx, on) =>
      `<li class="ex" data-dsqa-part="extra-check"><span class="bx${on ? ' on' : ''}" role="checkbox" aria-checked="${!!on}" tabindex="0">${on ? ic('check', 'i10') : ''}</span><div><div class="et">${t(tt)}</div><div class="ed">${t(d)}${approx ? `<span class="approx" title="${esc(t('approx'))}">${gl('?')}${t('approx')}</span>` : ''}</div></div></li>`
    return {
      top: top(n, 'step'),
      body: `${stepBody(n)}
        <section class="why-box" data-dsqa-part="why"><div class="eyebrow">${t('ex.why')}</div><p>${t('ex.whyBody')}</p></section>
        <section class="extra" data-dsqa-part="extra-checks"><div class="eyebrow">${t('ex.extra', 3)}</div><ul>${ex('e1.t', 'e1.d', false, true)}${ex('e2.t', 'e2.d', true, false)}${ex('e3.t', 'e3.d', false, false)}</ul><div class="hint">${t('ex.hint')}</div></section>`,
      foot: actions(n, {
        doneGoto: go('working', '&kind=next'),
        explainGoto: go('step'),
        explainOn: true
      })
    }
  }

  /* the teaching lens: for a walk-through of a feature just built, Explain more teaches (what it does, where it lives, the idea, why),
   * and the edge-case checks fold under it. The position does not move. */
  const teach = (n) => ({
    top: top(n, 'step'),
    body: `${stepBody(n)}
      <section class="teach" data-dsqa-part="teach"><div class="eb">${ic('spark', 'i10')}${t('tc.eyebrow')}</div>
        <div class="tc"><div class="eyebrow">${t('tc.does')}</div><p>${t('tc.doesB')}</p></div>
        <div class="tc"><div class="eyebrow">${t('tc.where')}</div><div class="links">${link('file', 'ExportButton.vue:18', { mono: true, title: 'src/export/ExportButton.vue:18', copy: FULL.btn + ':18', what: 'the file path' })}${link('file', 'build-csv.ts:42', { mono: true, title: 'src/export/build-csv.ts:42', copy: FULL.csv + ':42', what: 'the file path' })}</div></div>
        <div class="tc"><div class="eyebrow">${t('tc.idea')}</div><p>${t('tc.ideaB')}</p><div class="links">${link('link', t('tc.ideaL'), { title: 'https://www.rfc-editor.org/rfc/rfc4180', copy: 'https://www.rfc-editor.org/rfc/rfc4180', what: 'the link' })}</div></div>
        <div class="tc"><div class="eyebrow">${t('tc.why')}</div><p>${t('tc.whyB')}</p></div></section>
      <details class="left extra-fold" data-dsqa-part="extra-checks"><summary>${ic('right', 'i10 chev')}${t('tc.extra', 2)}</summary><ul class="xl"><li>${t('x4')}</li><li>${t('x5')}</li></ul></details>`,
    foot: actions(n, { doneGoto: go('step', '&n=3'), explainGoto: go('step'), explainOn: true })
  })

  const didNot = (n) => ({
    top: top(n, 'step'),
    body: `<h2 class="wk-title">${tk(n)}</h2>
      <section class="card acc simple" data-dsqa-part="simpler"><div class="eb">${t('du.eyebrow')}</div><p class="ask">${t('du.body')}</p></section>
      ${sec(t('sec.do'), doList([t('du.d1'), t('du.d2'), t('du.d3')]), 'do')}
      ${sec(t('sec.see'), `<div class="see"><p>${stepOf(n).see}</p></div>`, 'see')}
      ${sec(t('sec.check'), checkLine(stepOf(n)), 'check')}`,
    foot: actions(n, { doneGoto: go('working', '&kind=next') })
  })

  const working = (kind) => {
    const isCheck = kind === 'check'
    return {
      top: top(isCheck ? 2 : 4, 'working'),
      body: `<div class="quietbox" data-dsqa-part="working"><div class="trace">${gl('✓')}<span>${t('w.done', isCheck ? 1 : 3)}</span></div>
        <div class="busy" role="status"><span class="pdot" aria-hidden="true"></span><div><b>${isCheck ? t('w.check', 2) : t('w.prep', 4)}</b>${isCheck ? `<div class="vrow">${val('rg -l MissionPane src/renderer/src', 'the check command')}</div>` : ''}<div class="why">${t('w.quiet')}</div></div></div></div>`,
      foot: `<div class="wk-foot idle" data-dsqa-part="actions-idle"><span class="why">${t('w.quiet')}</span></div>`,
      mock: true
    }
  }

  const skippedKeys = () =>
    Object.keys(PAST)
      .filter((k) => PAST[k][0] === '-')
      .map(Number)
  const skipped = () => ({
    top: srcLine(),
    body: `<div class="wk-head"><h2 class="wk-title">${t('sk.title', skippedKeys().length)}</h2><div class="sub">${t('sk.sub')}</div></div>
      <ol class="rm" data-dsqa-part="skipped-list">${skippedKeys()
        .map(
          (k) =>
            `<li class="rm-row sk" data-dsqa-part="skipped-row"><span class="g1">${gl('-')}</span><span class="n num">${k}</span><span class="t">${tk(k)}</span><span class="m"><span class="m-k">${t('rm.eyes')}</span><button type="button" class="btn" ${go('step', '&n=3')}>${t('sk.retry')}</button></span></li>`
        )
        .join('')}</ol>`,
    foot: `<div class="wk-foot" data-dsqa-part="actions"><button type="button" class="btn md primary" ${go('step', '&n=3')} data-autofocus>${t('sk.now')}<kbd>${t('kbd.enter')}</kbd></button><button type="button" class="btn ghost" ${go('close-out')}>${t('sk.close', skippedKeys().length)}</button></div>`
  })

  const howText = (k) => {
    const h = PAST[k][1]
    return h === 'agreed'
      ? t('co.agreed')
      : h === 'eyes'
        ? t('co.eyes')
        : h === 'earlier'
          ? t('co.earlier', t(EARLIER[k]))
          : h === 'unver'
            ? `<span class="warnt">${t('co.unver')}</span>`
            : h === 'failed'
              ? `<span class="redt">${t('co.failed', NOTES[k])}</span>`
              : t('co.skip')
  }
  const doneRow = (k, o = {}) =>
    `<li class="rm-row" data-dsqa-part="closeout-row"><span class="g1">${gl(PAST[k][0])}</span><span class="n num">${k}</span><span class="t">${tk(k)}</span><span class="m">${howText(k)}</span>${o.note && NOTES[k] ? `<div class="note-q" data-dsqa-part="run-note"><span class="eyebrow">${t('pp.wrote')}</span><p>“${esc(NOTES[k])}”</p><span class="att small"><img src="../assets/pasted-1.png" alt=""><span class="trunc">${t('f.attached')}.png</span></span></div>` : ''}</li>`
  const summary = () =>
    [
      `${wtitle()} · ${TOT}`,
      ...Object.keys(PAST)
        .filter((k) => PAST[k][0] !== '✓')
        .map(
          (k) =>
            `${PAST[k][0]} ${k} ${tk(k)}: ${PAST[k][1] === 'unver' ? t('co.unver') : PAST[k][1] === 'failed' ? t('co.failed', NOTES[k]) : t('co.skip')}`
        )
    ].join('\n')
  const closeOut = () => {
    const sum = summary()
    return {
      top: srcLine(),
      body: `<div class="wk-head"><h2 class="wk-title">${t('co.title')}</h2><div class="sub">${t('co.sub', cnt('✓'), cnt('!') + cnt('✗'), cnt('-'))}</div></div>
      <ol class="rm" data-dsqa-part="closeout-list">${Object.keys(PAST)
        .map((k) => doneRow(Number(k)))
        .join('')}</ol>
      ${isMission ? `<section class="card you owed" data-dsqa-part="still-yours"><div class="eb">${gl('⚑')}<span>${t('co.owed')}</span></div><p class="ask sm">${t('co.crit')}</p><div class="acts"><span class="lk split wl" data-dsqa-part="link"><button type="button" class="open" data-goto="entry?state=step-open">${ic('target', 'i10')}<span class="x">${t('co.critGo')}</span>${ic('ext', 'i10 ext')}</button></span></div><p class="why">${t('co.owedMore')}</p></section>` : ''}
      <section class="card saved" data-dsqa-part="saved"><div class="eb">${ic('lib', 'i10')}<span>${t('co.saved')}</span></div><p class="ask sm">${t('co.savedBody')}</p><div class="acts"><button type="button" class="btn" data-goto="library?state=list">${ic('lib', 'i10')}${t('co.open')}</button><button type="button" class="btn" data-copy="${esc(sum)}">${ic('copy', 'i10')}<span class="cp-t">${t('co.export')}</span><span class="cp-ack"></span></button></div></section>
      <section class="sec" data-dsqa-part="summary">${code(sum, 'the summary')}</section>`,
      foot: ''
    }
  }

  /* a finished run, opened read-only: notes and screenshots, a Re-run button */
  const pastRun = () => {
    const n = WK === 'mission' ? 2 : 3
    const d = WK === 'mission' ? 'd.nov17' : 'd.nov16'
    return {
      top: srcLine(),
      body: `<button type="button" class="lost back" data-goto="library?state=list">${ic('back', 'i10')}${t('pp.back')}</button>
      <div class="wk-head"><h2 class="wk-title">${wtitle()}</h2><div class="sub">${t('pp.sum', cnt('✓'), cnt('✗') + cnt('!'), cnt('-'))}</div></div>
      <div class="runbar" data-dsqa-part="run-select"><button type="button" class="sel" aria-haspopup="listbox">${t('pp.run', n, t(d))}${ic('down', 'i10')}</button><span class="chipro">${t('pp.ro')}</span></div>
      <ol class="rm" data-dsqa-part="past-run">${Object.keys(PAST)
        .map((k) => doneRow(Number(k), { note: true }))
        .join('')}</ol>`,
      foot: `<div class="wk-foot" data-dsqa-part="actions"><button type="button" class="btn md primary" data-goto="walk?state=rerun-roadmap" data-autofocus>${ic('refresh', 'i10')}${t('pp.rerun')}<kbd>${t('kbd.enter')}</kbd></button><button type="button" class="btn md" data-copy="${esc(summary())}">${ic('copy', 'i10')}<span class="cp-t">${t('pp.export')}</span><span class="cp-ack"></span></button></div>`
    }
  }

  const empty = () => ({
    top: '',
    body: `<div class="center" data-dsqa-part="empty">${ic('checks', 'i14')}<b>${t('em.title')}</b><p>${t('em.body')}</p><div class="acts2"><button type="button" class="btn md primary" data-goto="library?state=list" data-autofocus>${ic('lib', 'i10')}${t('em.btn')}</button><button type="button" class="btn md" data-goto="entry?state=step-open">${ic('target', 'i10')}${t('em.btn2')}</button></div></div>`,
    foot: ''
  })
  const error = () => ({
    top: '',
    body: `<div class="center err" data-dsqa-part="error">${ic('plug', 'i14')}<b>${t('er.title')}</b><p>${t('er.body')}</p>
      <div class="errv">${val(t('er.err'), 'the error text')}</div>
      <div class="acts2"><button type="button" class="btn md primary" ${go('step', '&n=3')} data-autofocus>${ic('play', 'i10')}${t('er.resume')}</button><button type="button" class="btn md" data-copy="${esc('4/9 · 1 2 7 8 · ' + t('er.err'))}">${ic('copy', 'i10')}<span class="cp-t">${t('er.copy')}</span><span class="cp-ack"></span></button></div></div>`,
    foot: ''
  })

  const lightbox = () =>
    `<div class="lightbox" role="dialog" aria-modal="true" aria-label="${esc(t('img.cap'))}" data-dsqa-part="lightbox"><button type="button" class="lb-x ib" ${go('step-image')} aria-label="${esc(t('hdr.close'))}" data-autofocus>${ic('x', 'i14')}</button><img src="../assets/expected-dropdown-wide.png" alt="${esc(t('img.alt'))}"><div class="lb-cap"><span>${t('img.cap')}</span><kbd>Esc</kbd><span>${t('img.esc')}</span></div></div>`

  const DEFAULT_N = {
    step: WK === 'export' ? 1 : 3,
    'step-image': 3,
    lightbox: 3,
    failed: 3,
    'failed-retry': 3,
    'explain-more': 3,
    'explain-teach': 2,
    'did-not-understand': 3,
    'check-failed': 2,
    rerun: 3
  }
  const view = (state) => {
    const n = Math.min(3, Math.max(1, parseInt(q.get('n'), 10) || DEFAULT_N[state] || 3))
    switch (state) {
      case 'roadmap':
      case 'pr':
        return roadmap()
      case 'rerun-roadmap':
        return roadmap({ rerun: true })
      case 'step':
      case 'rerun':
        return stepState(n)
      case 'step-image':
        return { ...stepState(n), body: `${stepBody(n, { bigImage: true })}${lost(n)}` }
      case 'lightbox':
        return { ...stepState(n), body: `${stepBody(n, { bigImage: true })}`, overlay: lightbox() }
      case 'failed':
        return failed(n)
      case 'failed-retry':
        return failedRetry(n)
      case 'check-failed':
        return checkFailed(n)
      case 'explain-more':
        return explain(n)
      case 'explain-teach':
        return teach(n)
      case 'did-not-understand':
        return didNot(n)
      case 'working':
        return working(q.get('kind') === 'next' ? 'next' : 'check')
      case 'skipped-at-end':
        return skipped()
      case 'close-out':
        return closeOut()
      case 'run-past':
        return pastRun()
      case 'empty':
        return empty()
      case 'error':
        return error()
      default:
        return roadmap()
    }
  }

  /* ── the Walks library: a list of saved walks (title, source, last run, outcome) with Re-run and Open. Not a dashboard. ── */
  const LIB = [
    ['lw1', 'lw1.s', 'target', 'd.nov17', [6, 9], 'walk=mission&src=mission'],
    ['lw2', 'lw2.s', 'pr', 'd.nov16', [4, 6], 'walk=export&src=pr'],
    ['lw3', 'lw3.s', 'spark', 'd.nov15', [6, 6], 'walk=export&src=feature'],
    ['lw4', 'lw4.s', 'branch', 'd.nov9', [11, 12], 'walk=export&src=pr'],
    ['lw5', 'lw5.s', 'file', 'd.nov2', [14, 14], 'walk=export&src=pr']
  ]
  const libRow = ([tt, ss, icon, d, [a, b], qs]) => {
    const ok = a === b
    return `<li class="lib-row" data-dsqa-part="walk-row"><span class="lic">${ic(icon, 'i12')}</span>
    <div class="lib-main"><div class="lib-t">${t(tt)}</div><div class="lib-m"><span>${t(ss)}</span><span class="dot">·</span><span>${t(d)}</span><span class="dot">·</span>${gl(ok ? '✓' : '!')}<span class="${ok ? '' : 'warnt'}">${t('lib.passed', a, b)}</span></div></div>
    <div class="lib-a"><button type="button" class="btn" data-goto=${JSON.stringify('walk?state=rerun-roadmap&' + qs)}>${ic('refresh', 'i10')}${t('lib.rerun')}</button><button type="button" class="btn ghost" data-goto=${JSON.stringify('walk?state=run-past&' + qs)}>${t('lib.open')}</button></div></li>`
  }
  const libraryView = (state) => ({
    top: '',
    foot: '',
    body:
      state === 'empty'
        ? `<div class="center" data-dsqa-part="library-empty">${ic('lib', 'i14')}<b>${t('lib.empty.title')}</b><p>${t('lib.empty.body')}</p><div class="cmd">${code('/step-by-step PR #48', 'the command')}</div><p class="hint">${t('lib.empty.hint')}</p></div>`
        : `<div class="wk-head"><h2 class="wk-title">${t('lib.title')}</h2><div class="sub">${t('lib.sub', LIB.length)}</div></div><ol class="lib" data-dsqa-part="library-list">${LIB.map(libRow).join('')}</ol>`
  })

  /* ── the end-of-feature offer: the session asks once, never starts on its own ── */
  const offerView =
    () => `<div class="pane sess" data-dsqa-part="session"><div class="ph"><span class="ph-ic">${ic('term', 'i12')}</span><span class="ttl trunc"><b>${t('of.sess')}</b> · example-web</span></div>
    <div class="term" data-dsqa-part="transcript"><p><span class="pr2">●</span> ${t('of.l1')}</p><p class="dim">${t('of.l2')}</p></div>
    <section class="card acc offer" data-dsqa-part="walk-offer"><div class="eb">${ic('checks', 'i10')}<span>${t('of.eyebrow')}</span></div><p class="ask">${t('of.ask')}</p><p class="why">${t('of.why')}</p>
      <div class="acts"><button type="button" class="btn md primary" data-goto="walk?state=roadmap&walk=export&src=feature" data-autofocus>${ic('spark', 'i10')}${t('of.learn')}</button><button type="button" class="btn md" data-goto="walk?state=roadmap&walk=export&src=feature">${ic('checks', 'i10')}${t('of.qa')}</button><button type="button" class="btn ghost">${t('of.later')}</button></div></section>
    <div class="prompt" aria-hidden="true">${t('of.prompt')}</div></div>`

  /* mockup chrome, outside the data-dsqa root: language and theme switch (not part of the product) */
  addEventListener('DOMContentLoaded', () => {
    const bar2 = document.createElement('div')
    bar2.className = 'mk-bar'
    const set = (k, v) => {
      const nq = new URLSearchParams(location.search)
      nq.set(k, v)
      location.search = nq.toString()
    }
    ;[
      ['lang', 'en', 'EN', lang === 'en'],
      ['lang', 'pt-BR', 'PT-BR', lang === 'pt'],
      ['theme', 'dark', 'Dark', theme === 'dark'],
      ['theme', 'light', 'Light', theme === 'light']
    ].forEach(([k, v, l, on]) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.textContent = l
      b.setAttribute('aria-pressed', String(on))
      b.onclick = () => set(k, v)
      bar2.append(b)
    })
    document.body.append(bar2)
  })

  class Base extends HTMLElement {
    wire(state) {
      const f = this.querySelector('[data-autofocus]')
      if (f) setTimeout(() => f.focus({ preventScroll: true }), 0)
      /* copy: one click copies the full value; the button says Copied for a moment */
      const ack = (btn) => {
        const a = btn.querySelector('.cp-ack')
        btn.dataset.copied = '1'
        if (a) a.textContent = t('cp.copied')
        clearTimeout(btn._t)
        btn._t = setTimeout(() => {
          delete btn.dataset.copied
          if (a) a.textContent = ''
        }, 1400)
      }
      document.addEventListener('click', (e) => {
        const b = e.target.closest('[data-copy]')
        if (!b) return
        try {
          navigator.clipboard && navigator.clipboard.writeText(b.dataset.copy)
        } catch (_) {
          /* clipboard may be blocked in a preview */
        }
        ack(b)
      })
      if (q.get('copied') === '1') {
        const b = this.querySelector('[data-copy]')
        if (b) (ack(b), clearTimeout(b._t))
      }
      /* keyboard: Enter = the primary action unless focus is in a field or on another control; Esc closes the lightbox */
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && state === 'lightbox') {
          e.preventDefault()
          const nq = new URLSearchParams(location.search)
          nq.set('state', 'step-image')
          location.search = nq.toString()
          return
        }
        if (e.key === 'Enter' && !e.target.closest('input,textarea,button,a,[role="checkbox"]')) {
          const p = this.querySelector('.wk-foot .btn.primary')
          if (p) {
            e.preventDefault()
            p.click()
          }
        }
      })
    }
  }
  customElements.define(
    'mk-walk',
    class extends Base {
      connectedCallback() {
        const state = q.get('state') || 'roadmap'
        const v = view(state)
        this.innerHTML = `<div class="pane" data-dsqa-part="pane">${header()}${v.top || ''}<div class="wk-body" tabindex="-1" data-dsqa-part="body">${v.body}</div>${v.foot || ''}${v.overlay || ''}</div>`
        if (v.mock) {
          const m = document.createElement('div')
          m.className = 'mk-jump'
          m.innerHTML = `<button type="button" class="btn" ${go('skipped-at-end')}>${t('w.mock')} ${ic('right', 'i10')}</button>`
          document.body.append(m)
        }
        this.wire(state)
      }
    }
  )
  customElements.define(
    'mk-library',
    class extends Base {
      connectedCallback() {
        const state = q.get('state') || 'list'
        const v = libraryView(state)
        this.innerHTML = `<div class="pane" data-dsqa-part="pane"><div class="ph" data-dsqa-part="pane-header"><span class="ph-ic">${ic('lib', 'i12')}</span><span class="ttl trunc"><b>${t('lib.title')}</b></span><button type="button" class="ib" aria-label="${esc(t('hdr.expand'))}" title="${esc(t('hdr.expand'))}">${ic('expand', 'i12')}</button><button type="button" class="ib" aria-label="${esc(t('hdr.max'))}" title="${esc(t('hdr.max'))}">${ic('max', 'i12')}</button><button type="button" class="ib" aria-label="${esc(t('hdr.close'))}" title="${esc(t('hdr.close'))}">${ic('x', 'i12')}</button></div><div class="wk-body" tabindex="-1" data-dsqa-part="body">${v.body}</div></div>`
        this.wire(state)
      }
    }
  )
  customElements.define(
    'mk-offer',
    class extends Base {
      connectedCallback() {
        this.innerHTML = offerView()
        this.wire('feature-done')
      }
    }
  )
})()
