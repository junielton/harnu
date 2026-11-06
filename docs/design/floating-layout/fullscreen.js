// Mock: "expand to window" button on every helper pane header + variant chip (F7) + Esc to exit.
;(function () {
  if (window.__fullMock) return
  window.__fullMock = true
  const H = document.documentElement
  const ICON_EXPAND =
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m15 15 6 6"/><path d="m15 9 6-6"/><path d="M21 16v5h-5"/><path d="M21 8V3h-5"/><path d="M3 16v5h5"/><path d="m3 21 6-6"/><path d="M3 8V3h5"/><path d="M9 9 3 3"/></svg>'
  const exit = () => {
    H.classList.remove('pane-full')
    document.querySelectorAll('[data-full]').forEach((p) => p.removeAttribute('data-full'))
    document
      .querySelectorAll('.mock-expand-btn[data-on]')
      .forEach((b) => b.removeAttribute('data-on'))
  }
  const enter = (pane, btn) => {
    exit()
    pane.setAttribute('data-full', '')
    btn.setAttribute('data-on', '')
    H.classList.add('pane-full')
  }
  function decorate() {
    document.querySelectorAll('main aside > div').forEach((pane) => {
      const header = pane.querySelector('header')
      if (!header || header.querySelector('.mock-expand-btn')) return
      const max = [...header.querySelectorAll('button')].find((b) =>
        /maximi|restore/i.test((b.getAttribute('aria-label') || '') + (b.title || ''))
      )
      const btn = document.createElement('button')
      btn.className = 'mock-expand-btn'
      btn.title = 'Expand to window (Esc to exit)'
      btn.innerHTML = ICON_EXPAND
      btn.onclick = (e) => {
        e.stopPropagation()
        pane.hasAttribute('data-full') ? exit() : enter(pane, btn)
      }
      if (max) max.before(btn)
      else header.appendChild(btn)
    })
  }
  new MutationObserver(decorate).observe(document.body, { childList: true, subtree: true })
  decorate()
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && H.classList.contains('pane-full')) exit()
  })
  // variant chip
  H.classList.add('full-zen')
  const c = document.createElement('button')
  c.id = 'float-toggle'
  c.style.left = 'calc(50% + 330px)'
  const cl = () =>
    (c.textContent =
      'Expand hides: ' +
      (H.classList.contains('full-zen') ? 'everything' : 'session only') +
      '  ·  F7')
  const cf = () => {
    H.classList.toggle('full-zen')
    cl()
  }
  c.onclick = cf
  window.addEventListener('keydown', (e) => {
    if (e.key === 'F7') cf()
  })
  cl()
  document.body.appendChild(c)
})()
;(function () {
  if (window.__animMock) return
  window.__animMock = true
  const H = document.documentElement
  H.classList.add('anim')
  const a = document.createElement('button')
  a.id = 'float-toggle'
  a.style.left = 'calc(50% - 340px)'
  const al = () =>
    (a.textContent = 'Motion: ' + (H.classList.contains('anim') ? 'on' : 'off') + '  ·  F4')
  const af = () => {
    H.classList.toggle('anim')
    al()
  }
  a.onclick = af
  window.addEventListener('keydown', (e) => {
    if (e.key === 'F4') af()
  })
  al()
  document.body.appendChild(a)
})()

// Keep the pinned drill Back row exactly under the sidebar toolbar (its height can vary).
;(function () {
  if (window.__drillTopMock) return
  window.__drillTopMock = true
  const sync = () => {
    const a = document.querySelector('#app > div > div.flex.min-h-0.flex-1 > aside')
    const sc = a && a.querySelector(':scope > div.scrollable')
    const back = a && a.querySelector('[data-drill-back]')
    if (sc && back)
      a.style.setProperty(
        '--drill-back-top',
        sc.getBoundingClientRect().top - back.offsetHeight - a.getBoundingClientRect().top + 'px'
      )
  }
  new MutationObserver(sync).observe(document.body, { childList: true, subtree: true })
  window.addEventListener('resize', sync)
  // re-anchor when anything above the list changes height (zone appears, styles reload)
  const ro = new ResizeObserver(sync)
  const watch = () =>
    document
      .querySelectorAll('#app > div > div.flex.min-h-0.flex-1 > aside > *')
      .forEach((e) => ro.observe(e))
  new MutationObserver(watch).observe(document.body, { childList: true, subtree: true })
  watch()
  sync()
})()
