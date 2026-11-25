/* parts/entry.js — the entry point of the guided test walk: the Mission dropdown with a step opened and a
 * compact "Test it" control on it. Copied from .harnu/out/mission-dropdown/mockup/parts/dropdown.js (same look, same
 * anatomy); only the `step-open` and `closed` states are used here, every other dropdown state is out of scope
 * (it is the dropdown mockup's job). NEW in this file: the Test it control (data-dsqa-part="test-it").
 * Rendered into light DOM (<mk-entry>) from the screen's ?state=. It also reads ?lang=en|pt-BR and ?theme=dark|light.
 * Every piece of anatomy carries a data-dsqa-part; styles live in ../mockup.css.
 * Sample data is made up (lib/mission-sample.ts shapes): no real session, folder or client names. */
;(() => {
  const q = new URLSearchParams(location.search)
  const lang = q.get('lang') === 'pt-BR' ? 'pt' : 'en'
  const theme = q.get('theme') === 'light' ? 'light' : 'dark'
  document.documentElement.dataset.theme = theme
  document.documentElement.lang = lang === 'pt' ? 'pt-BR' : 'en'

  /* ── copy: en + pt-BR (keys follow missionPane.* of the app; new keys marked NEW) ── */
  const D = {
    en: {
      'pill.forYou': (n) => `${n} for you`,
      'pill.ready': 'ready to close',
      'pill.none': 'No mission',
      'dd.label': 'Mission',
      'progress.ms': (d, t) => `${d} of ${t} milestones done`,
      'next.you': 'Your next step',
      'next.openStep': 'Open step',
      'next.more': (n) => `${n} more waiting on you`,
      'next.less': 'Show less',
      'next.unblock.ask': 'Unblock: add the scoring service key',
      'next.unblock.why': 'The step cannot go on until then',
      'next.review.ask': 'Look over the pull request for “Score the proofs each criterion names”',
      'next.review.why': 'The step cannot finish until you do',
      'next.settle.ask': 'Mark done: the scores of the first twelve specs',
      'next.settle.why': 'It is the last thing open on this step',
      'next.close.ask': 'Close the mission: every step is done',
      'next.close.why': 'The mission is finished once you close it',
      'kind.unblock': 'Unblock',
      'kind.review': 'Review',
      'kind.settle': 'Check',
      'close.open': 'Close mission…',
      'test.it': 'Test it',
      'test.tip': '9 checks · walk through this step by hand',
      'test.msTip': 'Walk through this milestone by hand',
      'test.all': 'Test the whole mission',
      'test.allTip': 'Walk through the whole mission by hand',
      'dw.eyebrow': 'New Done when proposed',
      'dw.text':
        'The spec skill is scored, and both fixes are proven by a fresh run on the test set.',
      'dw.hint': 'Approve makes it the end of the mission. Decline keeps the current one.',
      'dw.approve': 'Approve',
      'dw.decline': 'Decline',
      'req.eyebrow': 'Asks to join',
      'req.text':
        'worker-3 asks to join “Measure the spec skill, then fix what the numbers show”. If you allow it, it works on the mission. It does not lead it.',
      'req.allow': 'Allow',
      'req.deny': 'Deny',
      'ms.summary.running': (n) => `${n} running`,
      'ms.summary.review': (n) => `${n} waiting for review`,
      'ms.summary.blocked': (n) => `${n} blocked`,
      'tree.more': (n) => `${n} more steps`,
      'chip.yours': 'Yours',
      'tip.todo': 'To do',
      'tip.running': 'Running',
      'tip.review': 'Waiting for review',
      'tip.done': 'Done',
      'tip.blocked': 'Blocked',
      'tip.ms.not': 'Not started',
      'tip.ms.prog': 'In progress',
      'tip.ms.done': 'Done',
      'tip.s.work': 'Working now',
      'tip.s.need': 'Waiting for you',
      'tip.s.past': 'Past session',
      'tip.crit.open': 'Not settled yet',
      'tip.crit.done': 'Settled',
      'step.criteria': 'Criteria',
      'step.verified': (n) => `${n} criteria verified`,
      'step.links': 'Links',
      'by.you': 'You',
      'by.session': 'Checked by a second session',
      'by.fact': 'Checked automatically',
      'step.mark': 'Mark done',
      'blk.you': 'Blocked · waiting for you',
      'blk.reason': 'The scoring service needs an API key the session does not have.',
      'blk.ask': 'Add the key to the environment the session runs in.',
      'blk.unblocks': 'Unblocks when the key is set.',
      'blk.clear': 'Done, continue',
      'lk.evidence': 'Evidence',
      'lk.page': 'Page · localhost:5173/score-report',
      'lk.copy': 'Copy the path',
      'lk.branchTitle': 'Show this worktree in the sidebar',
      'ask.open': 'Ask',
      'ask.openTitle': 'Ask the session about this milestone',
      'ask.label': 'Question about “A tool that scores a spec”',
      'ask.placeholder': 'What is still missing to finish this milestone?',
      'ask.hint': 'Goes to the prompt of orch-1. The answer shows in that session.',
      'ask.cancel': 'Cancel',
      'ask.send': 'Send',
      'sess.label': 'Sessions',
      'sess.meta': (n) => `${n} active · led by this session`,
      'sess.leads': 'Leads',
      'sess.thisSession': 'this session',
      'sess.on': (s) => `On “${s}”`,
      'sess.working': 'Working',
      'sess.needs': 'Needs you',
      'sess.continue': 'Continue in a new session…',
      'sess.past': (n) => `${n} past sessions`,
      'sess.pastMore': (n) => `Show ${n} more`,
      'sess.stoppedAt': (s) => `Stopped at “${s}”`,
      'sess.stoppedUnknown': 'Stopped. The record does not say where.',
      'offer.text':
        'This session’s context is 82% full. You can continue the mission in a fresh session. It starts from the mission summary, so nothing is lost.',
      'offer.later': 'Not now',
      'sw.count': (n, t) => `Mission ${n} of ${t}`,
      'sw.change': 'Change',
      'sw.label': (n) => `This session leads ${n} missions`,
      'sw.choose': 'Choose the mission to show',
      'empty.title': 'This session has no mission.',
      'pick.title': 'Open missions in this folder',
      'pick.attach': 'Attach',
      'pick.start': 'Start a new mission',
      'pick.led': (n) => `led by ${n}`,
      'ho.title': 'Continue this mission in a new session',
      'ho.one': 'Harnu saves where the session that leads stopped.',
      'ho.two': 'A new session opens with the summary below and leads the mission.',
      'ho.three': 'The old session is released. It stays in the mission’s session history.',
      'ho.brief': 'Mission summary — what the new session starts with',
      'ho.goal': 'Goal',
      'ho.where': 'Where it is',
      'ho.decided': 'Decided',
      'ho.next': 'Next step',
      'ho.cancel': 'Cancel',
      'ho.confirm': 'Start new session',
      'cl.title': 'Close this mission?',
      'cl.body':
        '“Measure the spec skill, then fix what the numbers show” leaves the Topbar and cannot be reopened. The mission file stays on disk as the record.',
      'cl.before': 'Before you close it',
      'cl.m1': '11 steps are not done',
      'cl.m2': '1 blocker is still open',
      'cl.done':
        'Closing as delivered confirms this Done when: “The spec skill is scored, and both fixes are proven by the score.”',
      'cl.how': 'How to close it',
      'cl.delivered': 'Close as delivered',
      'cl.deliveredH': 'The work is done.',
      'cl.discard': 'Discard',
      'cl.discardH': 'Drop it — dead, duplicated or abandoned.',
      'cl.cancel': 'Cancel',
      'cl.confirm': 'Close mission',
      ms1: 'A test set we can trust',
      ms2: 'A tool that scores a spec',
      ms3: 'Two fixes, each proven by the score',
      title: 'Measure the spec skill, then fix what the numbers show',
      title2: 'Build the data table section',
      title3: 'Move the collectors to production',
      'sw.sub': (d, t, n) => `${d} of ${t} milestones${n ? ` · ${n} for you` : ''}`,
      'step.a': 'Score the slices and their order',
      'step.b': 'Score the proofs each criterion names',
      'step.c': 'Write the plan for the scoring tool',
      'step.d': 'Read the spec the way a session reads it',
      'step.e': 'Score the headings of a spec',
      'c.open1': 'Check the scores of the first twelve specs by hand',
      'c.open2': 'The whole test set runs end to end',
      'c.open3': 'The score of one spec is the same twice',
      'date.16': 'Nov 16',
      'date.15': 'Nov 15',
      'date.14': 'Nov 14',
      'date.13': 'Nov 13',
      'p.s1': 'Write the plan for the scoring tool',
      'p.s2': 'Score each by hand',
      'p.s3': 'Pick twelve real specs',
      'p.s4': 'Check the hand scores against each other'
    }
  }
  D.pt = D.en /* the committed mockup is English only */
  const t = (k, ...a) => {
    const v = D[lang][k]
    return typeof v === 'function' ? v(...a) : v
  }
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')

  /* ── icons (lucide paths) ── */
  const P = {
    target:
      '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    right: '<path d="m9 18 6-6-6-6"/>',
    down: '<path d="m6 9 6 6 6-6"/>',
    flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" x2="4" y1="22" y2="15"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    branch:
      '<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
    msg: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    swap: '<path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/>',
    checks:
      '<path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>',
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    arrow: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
    send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'
  }
  const ic = (n, c = '') =>
    `<svg class="i ${c}" viewBox="0 0 24 24" aria-hidden="true">${P[n]}</svg>`
  const ALLOW = {
    closed: 1,
    'step-open': 1,
    milestone: 1,
    mission: 1
  } /* the only dropdown states this screen has */
  const go = (s) => (ALLOW[s] ? `data-goto=${JSON.stringify('entry?state=' + s)}` : '')
  const dot = (cls, tip, extra = '') =>
    `<span class="g ${cls}" role="img" aria-label="${esc(tip)}" data-tip="${esc(tip)}" ${extra}>${cls.startsWith('done') ? ic('check') : cls.startsWith('blocked') ? ic('flag') : ''}</span>`

  /* Navigation map. Each element carries data-goto; the literals are listed so the checker and a reader can see every edge:
   * data-goto="entry?state=closed"
   * data-goto="entry?state=step-open"
   * data-goto="entry?state=milestone"
   * data-goto="entry?state=mission"
   * data-goto="walk?state=roadmap"
   */
  /* ── pieces ── */
  const nextCard = (c) => {
    if (c.ready)
      return `<section class="card ok row" data-dsqa-part="next"><div class="grid"><div class="eb">${t('next.you')}</div><div class="body"><div class="ask">${t('next.close.ask')}</div><div class="why">${t('next.close.why')}</div></div><div class="acts"><button class="btn primary" ${go('close-confirm')} data-autofocus>${ic('flag', 'i10')}${t('close.open')}</button></div></div></section>`
    if (c.doneWhen)
      return `<section class="card acc" data-dsqa-part="staged-done-when"><div class="eb">${t('dw.eyebrow')}</div><div class="grid"><div class="ask">${t('dw.text')}</div><div class="hint">${t('dw.hint')}</div><div class="acts"><button class="btn primary" ${go('mid')} data-autofocus>${ic('check', 'i10')}${t('dw.approve')}</button><button class="btn" ${go('mid')}>${ic('x', 'i10')}${t('dw.decline')}</button></div></div>${more(c, 3)}</section>`
    if (c.attachReq)
      return `<section class="card acc" data-dsqa-part="attach-request"><div class="eb">${t('req.eyebrow')}</div><div class="grid"><div class="ask sm">${t('req.text')}</div><div class="acts"><button class="btn primary" ${go('mid')} data-autofocus>${ic('check', 'i10')}${t('req.allow')}</button><button class="btn" ${go('mid')}>${ic('x', 'i10')}${t('req.deny')}</button></div></div>${more(c, 3)}</section>`
    return `<section class="card you row" data-dsqa-part="next"><div class="grid"><div class="eb">${t('next.you')}</div><div class="body"><div class="ask">${t('next.unblock.ask')}</div><div class="why">${t('next.unblock.why')}</div>${more(c, 2)}</div><div class="acts"><button class="btn primary" ${go('blocked')} ${''}>${ic('arrow', 'i10')}${t('next.openStep')}</button></div></div>${c.restOpen ? rest() : ''}</section>`
  }
  const more = (c, n) =>
    `<button class="linkbtn" aria-expanded="${!!c.restOpen}" ${go(c.restOpen ? 'mid' : 'owed')}>${t(c.restOpen ? 'next.less' : 'next.more', n)}</button>`
  const rest = () => `<div class="rest" data-dsqa-part="waiting-rest">
    <div class="r"><div><span class="k warn">${t('kind.review')}</span><span class="a">${t('next.review.ask')}</span></div><div class="w">${t('next.review.why')}</div><button class="btn" ${go('step-open')}>${ic('arrow', 'i10')}${t('next.openStep')}</button></div>
    <div class="r"><div><span class="k warn">${t('kind.settle')}</span><span class="a">${t('next.settle.ask')}</span></div><div class="w">${t('next.settle.why')}</div><button class="btn" ${go('step-open')}>${ic('check', 'i10')}${t('step.mark')}</button></div></div>`

  const stepRow = (id, titleKey, state, o = {}) => {
    const open = o.open
    const tip = o.blocked ? t('tip.blocked') : t('tip.' + state)
    const g = o.blocked ? dot('blocked', tip, o.tipOpen ? 'data-tip-open' : '') : dot(state, tip)
    return `<button class="st" role="treeitem" aria-expanded="${!!open}" ${o.goto ? go(o.goto) : ''} data-dsqa-part="step">
      <span class="chev">${ic(open ? 'down' : 'right', 'i10')}</span>${g}<span class="t">${t(titleKey)}</span>
      <span class="r">${o.pr ? `<span class="pr" role="link" tabindex="0">#${o.pr}</span>` : ''}${o.yours ? `<span class="chip yours">${t('chip.yours')}</span>` : ''}</span></button>`
  }
  const crit = (c) => {
    const testIt = `<button class="btn" data-goto="walk?state=roadmap&src=mission" title="${esc(t('test.tip'))}" aria-label="${esc(t('test.it') + ' · ' + t('test.tip'))}" data-dsqa-part="test-it">${ic('checks', 'i10')}${t('test.it')}</button>`
    const lk = (inner) => `<div class="links">${inner}</div>`
    const blocked = c.openStep === 's10'
    const blocker = blocked
      ? `<div class="blocker" data-dsqa-part="blocker"><div class="bh">${ic('flag', 'i10')}${t('blk.you')} · 40m</div><div>${t('blk.reason')}</div><div style="font-weight:500">${t('blk.ask')}</div><div class="u">${t('blk.unblocks')}</div><div><button class="btn primary" ${go('mid')}>${ic('check', 'i10')}${t('blk.clear')}</button></div></div>`
      : ''
    const criteria = blocked
      ? `<div class="crit"><div class="eyebrow">${t('step.criteria')}</div><div class="cr"><span class="bx" role="img" aria-label="${t('tip.crit.open')}" data-tip="${t('tip.crit.open')}"></span><span>${t('c.open3')}</span><span class="who">${t('by.session')}</span></div></div>`
      : `<div class="crit"><div class="crit-h"><div class="eyebrow">${t('step.criteria')}</div>${testIt}</div><div class="verified">${dot('done', t('tip.crit.done'))}<span>${t('step.verified', 3)}</span></div>
          <div class="cr"><span class="bx" role="img" aria-label="${t('tip.crit.open')}" data-tip="${t('tip.crit.open')}"></span><span>${t('c.open1')}</span><span class="who">${t('by.you')}<button class="btn" ${go('step-open')}>${ic('check', 'i10')}${t('step.mark')}</button></span></div>
          <div class="cr"><span class="bx" role="img" aria-label="${t('tip.crit.open')}" data-tip="${t('tip.crit.open')}"></span><span>${t('c.open2')}</span><span class="who">${t('by.session')}</span></div></div>`
    const links = blocked
      ? lk(
          `<span class="lk split"><button title="${esc(t('lk.branchTitle'))}">${ic('branch', 'i10')}<span class="x">card/score-slices</span></button><button class="cp" aria-label="${esc(t('lk.copy'))}" title="${esc(t('lk.copy'))}">${ic('copy', 'i10')}</button></span><button class="lk" role="link">${ic('file', 'i10')}<span class="x">${t('lk.evidence')}</span></button>`
        )
      : lk(
          `<button class="lk mono" role="link">${ic('link', 'i10')}<span class="x">#21</span></button><span class="lk split"><button title="${esc(t('lk.branchTitle'))}">${ic('branch', 'i10')}<span class="x">card/score-proofs</span></button><button class="cp" aria-label="${esc(t('lk.copy'))}" title="${esc(t('lk.copy'))}">${ic('copy', 'i10')}</button></span><button class="lk" role="link">${ic('file', 'i10')}<span class="x">${t('lk.evidence')}</span></button><button class="lk" role="link">${ic('link', 'i10')}<span class="x">${t('lk.page')}</span></button>`
        )
    return `<div class="open-step" data-dsqa-part="open-step">${blocker}${criteria}<div class="crit"><div class="eyebrow">${t('step.links')}</div>${links}</div></div>`
  }

  const tree = (c) => {
    const ready = c.ready
    const m = (id, title, state, cnt, cur) =>
      `<button class="ms ${cur ? 'cur' : ''}" role="treeitem" aria-expanded="${!!cur && !ready}" data-dsqa-part="milestone"><span class="chev">${ic(cur && !ready ? 'down' : 'right', 'i10')}</span>${dot(state + (cur ? ' cur' : ''), t(state === 'done' ? 'tip.ms.done' : state === 'running' ? 'tip.ms.prog' : 'tip.ms.not'), c.dots && cur ? 'data-tip-open' : '')}<span class="t">${t(title)}</span><span class="n">${cnt}</span></button>`
    if (ready)
      return `<div class="tree" role="tree" data-dsqa-part="tree">${m('1', 'ms1', 'done', '4/4')}${m('2', 'ms2', 'done', '14/14')}${m('3', 'ms3', 'done', '3/3')}</div>`
    const sum = `<span class="l">${t('ms.summary.running', 5)} · ${t('ms.summary.review', 9)} · <span class="bad">${t('ms.summary.blocked', 1)}</span></span>`
    const testMs = c.testMs
      ? `<button class="btn" data-goto="walk?state=roadmap&src=milestone" title="${esc(t('test.msTip'))}" aria-label="${esc(t('test.it') + ' · ' + t('test.msTip'))}" data-dsqa-part="test-it-milestone">${ic('checks', 'i10')}${t('test.it')}</button>`
      : ''
    const askBtn = c.ask
      ? ''
      : `<span class="ms-acts"><button class="btn ghost" title="${esc(t('ask.openTitle'))}" ${go('ask')}>${ic('msg', 'i10')}${t('ask.open')}</button>${testMs}</span>`
    const askBox = c.ask
      ? `<div class="askbox" data-dsqa-part="ask"><label for="q">${t('ask.label')}</label><textarea id="q" placeholder="${esc(t('ask.placeholder'))}" data-autofocus></textarea><div class="h">${t('ask.hint')}</div><div class="acts"><button class="btn ghost" ${go('mid')}>${t('ask.cancel')}</button><button class="btn primary" ${go('mid')}>${ic('send', 'i10')}${t('ask.send')}</button></div></div>`
      : ''
    const ob = c.openStep
    return `<div class="tree" role="tree" data-dsqa-part="tree">${m('1', 'ms1', 'done', '4/4')}${m('2', 'ms2', 'running', '0/14', true)}
      <div class="ms-body" role="group">
        <div class="ms-sum">${sum}${askBtn}</div>${askBox}
        ${stepRow('s10', 'step.a', 'review', { blocked: true, yours: true, open: ob === 's10', goto: ob === 's10' ? 'mid' : 'blocked', tipOpen: c.dots })}${ob === 's10' ? crit(c) : ''}
        ${stepRow('s11', 'step.b', 'review', { yours: true, pr: 21, open: ob === 's11', goto: ob === 's11' ? 'mid' : 'step-open' })}${ob === 's11' ? crit(c) : ''}
        ${stepRow('s5', 'step.c', 'running')}${stepRow('s6', 'step.d', 'running')}${stepRow('s7', 'step.e', 'running')}
        <button class="more">${t('tree.more', 9)}</button>
      </div>${m('3', 'ms3', 'todo', '0/3')}</div>`
  }

  const head = (c) => {
    const bar = `<div class="progress" data-dsqa-part="progress"><div class="track" role="progressbar" aria-label="${esc(t('progress.ms', c.ready ? 3 : 1, 3))}" aria-valuemin="0" aria-valuemax="3" aria-valuenow="${c.ready ? 3 : 1}"><span class="fill" style="width:${c.ready ? 100 : 33}%"></span></div><span class="count">${t('progress.ms', c.ready ? 3 : 1, 3)}</span></div>`
    if (c.multi)
      return `<div class="head" data-dsqa-part="head"><button class="switch" aria-haspopup="listbox" ${go('chooser')}><span class="eyebrow">${t('sw.count', 1, 3)}</span><span class="meta">${t('sw.change')}${ic('down', 'i10')}</span></button><h2>${t('title')}</h2>${bar}</div>`
    return `<div class="head" data-dsqa-part="head"><h2>${t('title')}</h2>${bar}</div>`
  }
  const chooser =
    () => `<div class="head" data-dsqa-part="chooser"><div class="eyebrow">${t('sw.label', 3)}</div><ul class="choices" role="radiogroup" aria-label="${esc(t('sw.choose'))}">
    <li><button role="radio" aria-checked="true" ${go('multi')} data-autofocus><span class="t">${t('title')}</span><span class="ck">${ic('check')}</span><span class="s">${t('sw.sub', 1, 3, 3)}</span></button></li>
    <li><button role="radio" aria-checked="false" ${go('multi')}><span class="t">${t('title2')}</span><span class="ck"></span><span class="s">${t('sw.sub', 0, 2, 1)}</span></button></li>
    <li><button role="radio" aria-checked="false" ${go('multi')}><span class="t">${t('title3')}</span><span class="ck"></span><span class="s">${t('sw.sub', 4, 10, 0)}</span></button></li></ul></div>`
  const empty =
    () => `<div class="empty" data-dsqa-part="empty">${ic('target', 'i14')}<b>${t('empty.title')}</b></div>
    <div class="picker" data-dsqa-part="picker"><div class="eyebrow">${t('pick.title')}</div>
      <div class="pc"><span>${t('title')}</span><span class="s">${t('progress.ms', 1, 3)}</span><button class="btn" ${go('mid')} data-autofocus>${ic('link', 'i10')}${t('pick.attach')}</button></div>
      <div class="pc"><span>${t('title2')}</span><span class="s">${t('progress.ms', 0, 2)}</span><button class="btn" ${go('mid')}>${ic('link', 'i10')}${t('pick.attach')}</button></div>
      <button class="btn ghost start">${ic('plus', 'i10')}${t('pick.start')}</button></div>`

  const dialogs = (c) => {
    if (c.dialog === 'close')
      return `<div class="scrim"><div class="dialog sm" role="dialog" aria-modal="true" aria-label="${esc(t('cl.title'))}" data-dsqa-part="close-dialog"><div class="dh">${t('cl.title')}<button class="x" aria-label="×" ${go('ready')}>${ic('x')}</button></div>
      <div class="db"><div>${t('cl.body')}</div><div class="choice"><div class="eyebrow">${t('cl.how')}</div><div class="o on"><span class="rd"></span><span>${t('cl.delivered')}<small>${t('cl.deliveredH')}</small></span></div><div class="o"><span class="rd"></span><span>${t('cl.discard')}<small>${t('cl.discardH')}</small></span></div></div><div class="hint" style="font-size:11.5px;color:var(--color-text-3)">${t('cl.done')}</div></div>
      <div class="df"><button class="btn lg ghost" ${go('ready')} data-autofocus>${t('cl.cancel')}</button><button class="btn lg primary" ${go('empty')}>${ic('flag', 'i10')}${t('cl.confirm')}</button></div></div></div>`
    return ''
  }

  /* state → what the dropdown shows */
  const STATES = {
    closed: { open: false },
    mid: {},
    milestone: { testMs: true },
    mission: { ready: true, testAll: true },
    multi: { multi: true },
    chooser: { chooser: true },
    owed: { restOpen: true },
    'step-open': { openStep: 's11' },
    blocked: { openStep: 's10' },
    ask: { ask: true },
    'done-when': { doneWhen: true },
    'attach-request': { attachReq: true },
    ready: { ready: true },
    'close-confirm': { ready: true, dialog: 'close' },
    empty: { empty: true },
    dots: { dots: true }
  }

  /* mockup chrome, outside the data-dsqa root: language and theme switch (not part of the product) */
  addEventListener('DOMContentLoaded', () => {
    const bar = document.createElement('div')
    bar.className = 'mk-bar'
    const set = (k, v) => {
      const n = new URLSearchParams(location.search)
      n.set(k, v)
      location.search = n.toString()
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
      bar.append(b)
    })
    document.body.append(bar)
  })

  customElements.define(
    'mk-entry',
    class extends HTMLElement {
      connectedCallback() {
        const state = q.get('state') || 'step-open'
        const c = STATES[state] || {}
        const isOpen = c.open !== false
        const pillTone = c.ready ? 'success' : c.empty ? 'none' : 'warning'
        const count = c.doneWhen || c.attachReq ? 4 : 3
        const label = c.empty
          ? ''
          : c.ready
            ? `3/3 · ${t('pill.ready')}`
            : `1/3 · ${t('pill.forYou', count)}`
        const pill = `<button class="pill ${pillTone}" id="pill" aria-haspopup="dialog" aria-expanded="${isOpen}" aria-label="${esc(c.empty ? t('pill.none') : label)}" ${go(isOpen ? 'closed' : 'step-open')} data-dsqa="topbar-pill--${pillTone}">${ic(c.ready ? 'check' : 'target', 'i10')}${label ? `<span class="trunc">${label}</span>` : ''}${ic('down', 'i10 caret')}</button>`
        const body = c.empty
          ? empty()
          : c.chooser
            ? chooser()
            : `${head(c)}${nextCard(c)}${tree(c)}`
        const foot = c.testAll
          ? `<div class="dd-foot" data-dsqa-part="footer"><button class="btn" data-goto="walk?state=roadmap&src=all" title="${esc(t('test.allTip'))}" data-dsqa-part="test-it-mission">${ic('checks', 'i10')}${t('test.all')}</button></div>`
          : c.empty || c.chooser || c.ready
            ? ''
            : `<div class="dd-foot" data-dsqa-part="footer"><button class="btn ghost" ${go('close-confirm')}>${ic('flag', 'i10')}${t('close.open')}</button></div>`
        const dd = isOpen
          ? `<div class="dd ${c.dialog ? 'dim' : ''}" id="dd" role="dialog" aria-label="${esc(t('dd.label'))}" ${c.dialog ? 'inert' : ''} data-dsqa-part="dropdown"><div class="dd-body" tabindex="-1">${body}</div>${foot}</div>`
          : ''
        this.innerHTML = `<div class="topbar" data-dsqa-part="topbar"><span class="ghost-ic"></span><span class="crumb trunc"><b class="trunc">example-web</b><span>/</span><span class="trunc">orch-1</span></span><span class="chip-role">Orchestrator</span>${pill}<span class="sp"></span></div>
        <div class="page" aria-hidden="true"><i style="width:62%"></i><i style="width:48%"></i><i style="width:71%"></i><i style="width:35%"></i><i style="width:55%"></i><i style="width:66%"></i><i style="width:42%"></i></div>${dd}${dialogs(c)}`
        this.layout()
        addEventListener('resize', () => this.layout())
        this.wire(state, c)
      }
      layout() {
        const dd = this.querySelector('#dd'),
          pill = this.querySelector('#pill')
        if (!dd || !pill) return
        const w = Math.min(420, innerWidth - 16),
          left = Math.max(8, Math.min(pill.getBoundingClientRect().left, innerWidth - w - 8))
        dd.style.setProperty('--dd-left', left + 'px')
        this.showForced()
      }
      wire(state, c) {
        const f = this.querySelector('[data-autofocus]')
        if (f) setTimeout(() => f.focus({ preventScroll: true }), 0)
        const tip = document.createElement('div')
        tip.className = 'tip'
        tip.hidden = true
        document.body.append(tip)
        const place = (el, node) => {
          node.textContent = el.dataset.tip
          node.hidden = false
          const r = el.getBoundingClientRect(),
            tr = node.getBoundingClientRect()
          const above = r.top - tr.height - 6 >= 4
          node.style.top = (above ? r.top - tr.height - 6 : r.bottom + 6) + 'px'
          node.style.left = Math.max(4, Math.min(r.left - 4, innerWidth - tr.width - 4)) + 'px'
        }
        document.addEventListener('mouseover', (e) => {
          const el = e.target.closest('[data-tip]')
          if (el) place(el, tip)
        })
        document.addEventListener('mouseout', (e) => {
          if (e.target.closest('[data-tip]')) tip.hidden = true
        })
        document.addEventListener('focusin', (e) => {
          const el = e.target.closest('[data-tip]')
          if (el) place(el, tip)
        })
        this.place = place
        /* keyboard: Esc closes (a dialog first, back to the dropdown); Tab stays inside the dropdown or the dialog */
        const esc2 =
          { 'handoff-confirm': 'sessions', 'close-confirm': 'ready' }[state] ||
          (state === 'closed' ? null : 'closed')
        document.addEventListener('keydown', (e) => {
          if (e.key === 'Escape' && esc2) {
            e.preventDefault()
            const n = new URLSearchParams(location.search)
            n.set('state', esc2)
            location.search = n.toString()
          }
          if (e.key === 'Tab') {
            const root = this.querySelector('.dialog') || this.querySelector('.dd')
            if (!root) return
            const items = [...root.querySelectorAll('button,[tabindex],textarea')].filter(
              (x) => !x.disabled && x.tabIndex >= 0 && x.offsetParent !== null
            )
            if (!items.length) return
            const first = items[0],
              last = items[items.length - 1]
            if (!root.contains(document.activeElement)) {
              e.preventDefault()
              first.focus()
            } else if (e.shiftKey && document.activeElement === first) {
              e.preventDefault()
              last.focus()
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault()
              first.focus()
            }
          }
        })
        this.forced = []
        if (c.dots)
          this.forced = [...this.querySelectorAll('[data-tip-open]')].map((el) => {
            const n = document.createElement('div')
            n.className = 'tip'
            document.body.append(n)
            return [el, n]
          })
        this.showForced()
      }
      showForced() {
        ;(this.forced || []).forEach(([el, n]) => this.place(el, n))
      }
    }
  )
})()
