const folderViews = {
  default: {
    name: 'harnu',
    path: '~/Workspace/harnu',
    git: '2 changes · ↓2',
    roadmap: [10, 9, 488],
    widths: [2, 2]
  },
  clean: {
    name: 'portal',
    path: '~/Workspace/org/portal',
    git: 'clean',
    roadmap: [1, 3, 0],
    widths: [25, 75]
  },
  'no-roadmap': { name: 'example-web', path: '~/Workspace/org/example-web', git: 'clean' }
}

function folderPane({ name, path, git, roadmap, widths }) {
  return `<div class="island fv" data-dsqa-part="folder-view">
    <div class="fv-head">
      <span class="fv-name">${name}</span>
      <span class="fv-chip mono">${icon('branch', 12)}main</span>
      <span class="fv-git ${git === 'clean' ? 'clean' : ''}">${git}</span>
    </div>
    <div class="fv-path mono">${path}</div>
    <div class="fv-actions">
      <button type="button" class="fv-btn primary">${icon('plus')}New session</button>
      <button type="button" class="fv-btn">${icon('terminal')}Terminal here</button>
      <button type="button" class="fv-btn">${icon('folder')}Browse files</button>
      ${roadmap ? `<button type="button" class="fv-btn">${icon('board')}Roadmap board</button>` : ''}
      <button type="button" class="fv-btn more" title="More: PR Stack, Open in VS Code, Open folder" aria-label="More folder actions">${icon('more')}</button>
    </div>
    ${
      roadmap
        ? `<div class="fv-road">
      <span class="fv-road-label">Roadmap</span>
      <span class="fv-road-n"><b>${roadmap[0]}</b> in progress · <b>${roadmap[1]}</b> ready · ${roadmap[2]} in review</span>
      <span class="fv-bar" aria-hidden="true"><i style="width: ${widths[0]}%"></i><i style="width: ${widths[1]}%"></i></span>
    </div>`
        : ''
    }
  </div>`
}

const previewSamples = {
  s1: [
    'now',
    '0.42',
    18,
    '+120/-14',
    'Comparing the flat-checkout sidebar against the approved lanes and writing the next variation.',
    34,
    2
  ],
  s2: [
    '2h',
    '1.10',
    41,
    '+64/-12',
    'Writing the browser tabs docs delta for the user guide.',
    22,
    0
  ],
  s3: [
    '1d',
    '0.35',
    12,
    '+9/-3',
    'Fixed OSC 8 hyperlinks so ctrl-click opens them in the default browser.',
    15,
    0
  ],
  s4: [
    'now',
    '2.60',
    83,
    '+410/-52',
    'Wiring agent tabs S6: the pane header now carries the connection chip.',
    61,
    1
  ],
  s5: ['3h', '0.20', 9, '+22/-0', 'Second pass on the docs delta: screenshots and copy.', 8, 0],
  a1: [
    'now',
    '4.85',
    96,
    '+230/-88',
    'Asked to run the step 3 migration of the rate limiter before switching reads to Redis.',
    97,
    3
  ]
}
const previewAges = { a4: '40m', a5: '2d', p3: '1h', p4: '5h', e1: '12m', e2: '3d', j1: '1d' }

function fillPreview(preview, row) {
  const { session: id } = row.dataset
  const session = allSessions.find((item) => item.id === id)
  const [when, cost, context, lines, body, messages, agents] = previewSamples[id] || [
    previewAges[id] || 'now',
    '0.30',
    15,
    '+40/-6',
    session.title + '.',
    12,
    0
  ]
  preview.innerHTML = `<div class="pv-head mono"><span>Opus 5.5</span><span>${when}</span></div>
    <div class="pv-tele mono">$${cost} · <span class="${context >= 95 ? 'ctx-red' : context >= 80 ? 'ctx-accent' : 'ctx-muted'}">${context}% context</span> · ${lines}</div>
    ${context >= 90 ? '<div class="pv-flags">near /compact</div>' : ''}
    <p class="pv-body">${body}</p>
    <div class="pv-foot mono">${messages} messages${agents ? ` · ${agents} agent${agents === 1 ? '' : 's'}` : ''}</div>`
  const { top } = row.getBoundingClientRect()
  const { right } = row.closest('aside').getBoundingClientRect()
  preview.style.left = right + 8 + 'px'
  preview.style.top = Math.max(8, Math.min(top, window.innerHeight - 190)) + 'px'
  preview.hidden = false
}

customElements.define(
  'mk-app-window',
  class extends HTMLElement {
    connectedCallback() {
      const screen = this.closest('[data-dsqa]')
      const view = this.getAttribute('view')
      const state = screen.dataset.state || 'default'
      const dockOpen = state === 'dock-open'
      const floating = state === 'floating'
      const folder = view === 'folder-view' ? folderViews[state] : null
      this.classList.toggle('floating', floating)
      this.innerHTML = `<div class="frame">
      <aside class="sidebar" data-dsqa-part="sidebar">
        <div class="island sidebar-list">
          <mk-toolbar state="${state}"></mk-toolbar>
          <mk-attention></mk-attention>
          <mk-tree state="${state}" view="${view}" ${folder ? `current="${folder.name}"` : ''}></mk-tree>
        </div>
        <mk-dock variant="${dockOpen ? 'open' : 'folded'}"></mk-dock>
      </aside>
      <main class="main-pane" data-dsqa-part="main-pane">
        <div class="island pane-top">
          <div class="breadcrumbs">${
            folder
              ? `<b>${folder.name}</b><span>›</span><span class="crumb-branch mono">main</span>`
              : '<span>harnu</span><span>›</span><span class="crumb-branch mono">main</span><span>›</span><b>Sidebar fleet merge mockup</b>'
          }</div>
          <button type="button" class="floating-switch" aria-pressed="${floating}" title="Settings → Appearance → Floating panels"
            ${floating ? 'data-goto="sidebar"' : 'data-goto="sidebar?state=floating"'}>Floating panels<span class="switch-track"><span></span></span></button>
        </div>
        ${
          folder
            ? folderPane(folder)
            : `<div class="island terminal mono">
          <div><b>❯</b> help me with a sidebar mockup</div>
          <div>● Reading the sketch in the browser pane…</div>
          <div>● Building screens/sidebar.html</div>
        </div>`
        }
      </main>
    </div>
    <footer class="status-footer" data-dsqa-part="status-footer">
      <span>Opus 5.5</span><span>23% ctx</span><span class="mono footer-branch">⑂ main</span><span>$5.81</span>
      <span class="footer-warning">&gt;200k tokens</span><span>▣ 4</span>
      <span class="footer-spacer"></span>
      <span>5%</span><span>3,202 left</span><span>21.34 GB</span><span>Scheduler</span><span>7d·6d 2%</span><span>$1048.39</span><span>12 tabs</span>
    </footer>
    ${folder ? '' : '<div class="pv" role="tooltip" aria-label="Session preview" data-dsqa-part="session-preview" hidden></div>'}`

      if (folder) {
        this.querySelector('.fhead.cur')
          .closest('.fgrp')
          .scrollIntoView({ block: 'nearest', container: 'nearest' })
        return
      }
      this.bindSessionPreview(state)
      const requestedSession = new URLSearchParams(location.search).get('session')
      if (state === 'default' && allSessions.some((session) => session.id === requestedSession)) {
        this.openAttentionSession(requestedSession)
      }
      this.addEventListener('click', (event) => {
        const row = event.target.closest('.s-row')
        const attention = event.target.closest('[data-attention-session]')
        if (row) this.updateBreadcrumb(row.dataset.session)
        if (attention) this.openAttentionSession(attention.dataset.attentionSession)
      })
    }

    bindSessionPreview(state) {
      const preview = this.querySelector('.pv')
      const tree = this.querySelector('mk-tree')
      // The approved hover dwell and grace are input delays, independent of the fade.
      const openDelay = 400
      const closeDelay = 200
      let openTimer
      let closeTimer
      const cancelPending = () => {
        clearTimeout(openTimer)
        clearTimeout(closeTimer)
      }
      const closeSoon = () => {
        cancelPending()
        closeTimer = setTimeout(() => {
          preview.hidden = true
        }, closeDelay)
      }

      if (state === 'preview') fillPreview(preview, tree.querySelector('[data-session="s1"]'))
      tree.querySelectorAll('.s-row').forEach((row) => {
        row.addEventListener('pointerenter', () => {
          cancelPending()
          if (!preview.hidden) {
            fillPreview(preview, row)
          } else {
            openTimer = setTimeout(() => fillPreview(preview, row), openDelay)
          }
        })
        row.addEventListener('pointerleave', closeSoon)
      })
      preview.addEventListener('pointerenter', cancelPending)
      preview.addEventListener('pointerleave', closeSoon)
    }

    openAttentionSession(id) {
      const tree = this.querySelector('mk-tree')
      const row = tree.querySelector(`[data-session="${id}"]`)
      if (!row) {
        const focusBack = this.querySelector('.back-row[data-goto]')
        if (focusBack) {
          focusBack.dataset.goto = `sidebar?folder=&session=${id}`
          focusBack.click()
        }
        return
      }
      const group = row.closest('.grp')
      const folder = row.closest('.fgrp')
      const checkout = group.querySelector('.co-row')
      folder.querySelector('.folder-content').hidden = false
      folder.querySelector('.fchev').setAttribute('aria-expanded', 'true')
      group.querySelector('.session-list').hidden = false
      checkout.setAttribute('aria-expanded', 'true')
      checkout.querySelector('.ln-val').textContent = ''
      tree.selectRow(row)
      this.updateBreadcrumb(id)
      row.scrollIntoView({ block: 'nearest' })
    }

    updateBreadcrumb(id) {
      const session = allSessions.find((item) => item.id === id)
      const crumb = this.querySelector('.breadcrumbs')
      crumb.firstElementChild.textContent = session.folder
      crumb.querySelector('.crumb-branch').textContent = session.branch
      crumb.lastElementChild.textContent = session.title
      this.querySelector('.footer-branch').textContent = '⑂ ' + session.branch
    }
  }
)
