/* Flat checkout tree and the fixtures shared by its screen and gallery variants. */
const folders = [
  {
    name: 'harnu',
    checkouts: [
      {
        branch: 'main',
        home: true,
        sessions: [
          { id: 's1', title: 'Sidebar fleet merge mockup', status: 'working', orchestrator: true },
          { id: 's2', title: 'Browser tabs docs delta', status: 'idle' },
          { id: 's3', title: 'OSC 8 hyperlink fix', status: 'done' }
        ]
      },
      { branch: 'feat/browser-tabs', sessions: [] },
      {
        branch: 'browser-tabs/s6-agent-tabs',
        sessions: [
          { id: 's4', title: 'Agent tabs S6', status: 'working', mission: '0/2 · 1 for you' }
        ]
      },
      {
        branch: 'browser-tabs/docs-delta-2',
        sessions: [{ id: 's5', title: 'Docs delta 2', status: 'idle' }]
      },
      { branch: 'fix/osc8-links', sessions: [] },
      {
        branch: 'card/T790-session-tuck',
        sessions: [
          {
            id: 's6',
            title: 'Session tuck strip',
            status: 'needs',
            reason: 'Asked: keep the strip visible on hover?'
          }
        ]
      },
      { branch: 'card/walk-pane', sessions: [] }
    ]
  },
  {
    name: 'api-gateway',
    checkouts: [
      {
        branch: 'main',
        home: true,
        sessions: [
          {
            id: 'a1',
            title: 'Migrate rate limiter to Redis',
            status: 'needs',
            orchestrator: true,
            mission: '2/5 · 1 for you',
            reason: 'Allow Bash? npm run migrate -- --step 3'
          }
        ]
      },
      {
        branch: 'PROJ-231-rate-limit',
        sessions: [
          { id: 'a2', title: 'Rate limit middleware', status: 'working' },
          { id: 'a3', title: 'Load test the limiter', status: 'working' }
        ]
      },
      {
        branch: 'PROJ-232-redis-pool',
        sessions: [{ id: 'a4', title: 'Redis connection pool', status: 'idle' }]
      },
      {
        branch: 'PROJ-198-health-checks',
        sessions: [{ id: 'a5', title: 'Health check endpoint', status: 'done' }]
      }
    ]
  },
  {
    name: 'portal',
    checkouts: [
      {
        branch: 'main',
        home: true,
        sessions: [{ id: 'p1', title: 'Fix login redirect loop', status: 'working' }]
      },
      {
        branch: 'ACME-10996-billing-page',
        sessions: [
          { id: 'p2', title: 'Billing page table', status: 'working' },
          { id: 'p3', title: 'Review billing PR', status: 'idle' }
        ]
      },
      {
        branch: 'ACME-10996-billing-page-2',
        sessions: [{ id: 'p4', title: 'Billing page export', status: 'idle' }]
      }
    ]
  },
  {
    name: 'example-web',
    checkouts: [
      {
        branch: 'main',
        home: true,
        sessions: [
          {
            id: 'e1',
            title: 'Bump Vite to v7',
            status: 'errored',
            reason: 'exit 1 · vite build failed'
          },
          { id: 'e2', title: 'Hero section copy', status: 'done' }
        ]
      }
    ]
  },
  {
    name: 'web-api',
    checkouts: [
      {
        branch: 'main',
        home: true,
        sessions: [{ id: 'w1', title: 'Pagination cursor bug', status: 'working' }]
      },
      {
        branch: 'fix/cursor-pagination',
        sessions: [{ id: 'w2', title: 'Cursor pagination tests', status: 'working' }]
      }
    ]
  },
  { name: 'org', checkouts: [{ branch: 'main', home: true, sessions: [] }] },
  {
    name: 'proj',
    checkouts: [
      {
        branch: 'main',
        home: true,
        sessions: [{ id: 'j1', title: 'Monorepo CI matrix', status: 'idle' }]
      }
    ]
  },
  { name: 'www', checkouts: [{ branch: 'main', home: true, sessions: [] }] }
]

const [harnu, gateway, portal, exampleWeb, webApi] = folders
const statusPriority = ['needs', 'errored', 'working']
const hottest = (sessions) =>
  statusPriority.find((status) => sessions.some((s) => s.status === status)) || 'idle'
const allSessions = folders.flatMap((folder) =>
  folder.checkouts.flatMap((checkout) =>
    checkout.sessions.map((session) => ({
      ...session,
      folder: folder.name,
      branch: checkout.branch
    }))
  )
)

function valueSlot(count, chevron) {
  return `<span class="ln-slot" data-dsqa-part="value-slot"><span class="ln-val">${count}</span>${chevron}</span>`
}

function sessionRow(session, { selected = false, forced = '', view = '' } = {}) {
  const { id, status, title, mission, orchestrator } = session
  const destination = id === 's1' ? 'data-goto="sidebar"' : `data-goto='sidebar?session=${id}'`
  return `<button type="button" class="s-row${selected ? ' sel' : ''}" data-dsqa-part="session-row"
      data-session="${id}" aria-pressed="${selected}" ${forced ? `data-forced="${forced}"` : ''}
      ${view === 'folder-view' ? destination : ''}>
    <span class="session-mark">${status === 'done' ? icon('done', 11, 'Done') : `<span class="dot ${status}" role="img" aria-label="${statusLabel[status]}"></span>`}</span>
    <span class="truncate session-title">${title}</span>
    ${
      mission
        ? `<span class="mchip" aria-label="Mission: ${mission}">
      ${icon('warning', 11)}${mission.match(/(\d+) for you/)[1]}
      <span class="mfull" aria-hidden="true">${icon('warning', 11)}${mission}</span>
    </span>`
        : ''
    }
    <span class="ln-icon" data-dsqa-part="session-trailing-icon">${orchestrator ? icon('crown', 12, 'Orchestrator') : ''}</span>
  </button>`
}

function checkoutGroup(
  checkout,
  { folded = false, view = '', goto = '', forced = '', selected = false } = {}
) {
  const { branch, home, sessions } = checkout
  const status = hottest(sessions)
  const canFold = sessions.length > 0
  return `<div class="grp${status === 'idle' ? '' : ` rail-${status}`}" data-dsqa-part="checkout-group">
    <button type="button" class="co-row${selected ? ' sel' : ''}" data-dsqa-part="checkout-row"
      ${forced ? `data-forced="${forced}"` : ''}
      ${goto} ${canFold ? `data-toggle="checkout" aria-expanded="${!folded}"` : ''}
      aria-label="${branch}${status === 'idle' ? '' : `, ${statusLabel[status].toLowerCase()}`}">
      <span class="co-ico">${icon(home ? 'home' : 'branch', 13, home ? 'Main checkout' : 'Worktree')}</span>
      <span class="truncate mono checkout-label">${branch}</span>
      ${valueSlot(
        folded && canFold ? sessions.length : '',
        canFold ? `<span class="chev">${icon('up', 13)}${icon('down', 13)}</span>` : ''
      )}
    </button>
    ${
      canFold
        ? `<div class="session-list" ${folded ? 'hidden' : ''}>${sessions
            .map((s) => sessionRow(s, { selected: view !== 'folder-view' && s.id === 's1', view }))
            .join('')}</div>`
        : ''
    }
  </div>`
}

function folderHeader(
  folder,
  { open = false, current = false, forced = '', live = false, goto = '', focus = false } = {}
) {
  const status = hottest(folder.checkouts.flatMap((c) => c.sessions))
  const label = `${ring(status)}<span class="truncate folder-name">${folder.name}</span>`
  const focusDestination =
    folder === harnu
      ? 'data-goto="sidebar?state=focus"'
      : `data-goto='sidebar?state=focus&folder=${folder.name}'`
  return `<div class="fhead${current ? ' cur' : ''}" data-dsqa-part="folder-header" ${forced ? `data-forced="${forced}"` : ''}>
    <button type="button" class="folder-select" ${goto} ${current ? 'aria-current="page"' : ''}
      ${live && !goto ? 'data-pick-folder' : ''}>${label}</button>
    ${focus ? `<button type="button" class="focus-btn" title="Focus this folder" aria-label="Focus ${folder.name}" ${focusDestination}>${icon('focus', 13)}</button>` : ''}
    ${valueSlot(
      folder.checkouts.length,
      `<button type="button" class="fchev" ${live ? 'data-toggle="folder"' : ''}
      aria-expanded="${open}" aria-label="Expand or collapse ${folder.name}">${icon('up', 14)}${icon('down', 14)}</button>`
    )}
  </div>`
}

function backRow(meta, destination) {
  return `<button type="button" class="back-row" data-dsqa-part="back-row" ${destination}>
    ${icon('back')} All folders <span class="back-meta">${meta}</span>
  </button>`
}

function otherFolderSummary(focusedFolder) {
  const others = folders.filter((folder) => folder !== focusedFolder)
  const statuses = others.map((folder) => hottest(folder.checkouts.flatMap((c) => c.sessions)))
  const needs = statuses.filter((status) => status === 'needs').length
  const failed = statuses.filter((status) => status === 'errored').length
  return [others.length + ' others', needs && needs + ' needs you', failed && failed + ' failed']
    .filter(Boolean)
    .join(' · ')
}

function idleRows(checkouts, open, goto) {
  return `<button type="button" class="co-row idle-row" data-dsqa-part="idle-row" data-toggle="idle" aria-expanded="${open}" ${goto}>
    <span class="co-ico">${icon('branch', 13)}</span>
    <span class="truncate checkout-label">${checkouts.length} idle worktree${checkouts.length === 1 ? '' : 's'}</span>
    ${valueSlot('', `<span class="chev">${icon('up', 13)}${icon('down', 13)}</span>`)}
  </button>
  <div ${open ? '' : 'hidden'}>${checkouts
    .map(
      (c) => `<div class="co-row idle-wt"><span class="co-ico"></span>
    <span class="truncate mono checkout-label">${c.branch}</span>${valueSlot('', '')}</div>`
    )
    .join('')}</div>`
}

function folderGroup(
  folder,
  {
    open = true,
    foldAll = false,
    foldMain = false,
    foldLast = false,
    idleOpen = false,
    current = false,
    live = false,
    view = '',
    state = '',
    focus = false
  } = {}
) {
  const idle = folder.checkouts.filter((c) => !c.home && !c.sessions.length)
  const checkouts = folder.checkouts.filter((c) => !idle.includes(c))
  const isSidebarHarnu = view === 'sidebar' && folder === harnu
  const defaultLink = isSidebarHarnu && state === 'default'
  const folderDestinations = {
    harnu: 'data-goto="folder-view"',
    portal: 'data-goto="folder-view?state=clean"',
    'example-web': 'data-goto="folder-view?state=no-roadmap"'
  }
  const goto = view === 'sidebar' ? folderDestinations[folder.name] : ''
  return `<div class="fgrp" data-folder="${folder.name}">
    ${folderHeader(folder, { open, current, live, goto, focus })}
    <div class="folder-content" ${open ? '' : 'hidden'}>
      ${checkouts
        .map((c, i) =>
          checkoutGroup(c, {
            view,
            folded: foldAll || (foldMain && c.home) || (foldLast && i === checkouts.length - 1),
            goto:
              !isSidebarHarnu || !c.home
                ? ''
                : defaultLink
                  ? 'data-goto="sidebar?state=checkout-folded"'
                  : state === 'checkout-folded'
                    ? 'data-goto="sidebar"'
                    : ''
          })
        )
        .join('')}
      ${
        idle.length
          ? idleRows(
              idle,
              idleOpen,
              !isSidebarHarnu
                ? ''
                : defaultLink
                  ? 'data-goto="sidebar?state=idle-open"'
                  : state === 'idle-open'
                    ? 'data-goto="sidebar"'
                    : ''
            )
          : ''
      }
    </div>
  </div>`
}

const portalWithFoldedWork = {
  ...portal,
  checkouts: portal.checkouts.map((c, i) =>
    i === 2 ? { ...c, sessions: c.sessions.map((s) => ({ ...s, status: 'working' })) } : c
  )
}

function railMoment(state) {
  const [main, limiter, pool, checks] = gateway.checkouts
  const idlePortal = {
    ...portal,
    checkouts: portal.checkouts.map((c) => ({
      ...c,
      sessions: c.sessions.map((s) => ({ ...s, status: 'idle' }))
    }))
  }
  switch (state) {
    case 'selected-in-active':
      return folderGroup({ ...harnu, checkouts: [harnu.checkouts[0], harnu.checkouts[3]] })
    case 'priority':
      return folderGroup({
        ...gateway,
        checkouts: [
          { ...main, sessions: [...main.sessions, { ...pool.sessions[0], status: 'working' }] },
          {
            ...limiter,
            sessions: [
              { ...limiter.sessions[0], status: 'errored' },
              { ...limiter.sessions[1], status: 'idle' }
            ]
          },
          checks
        ]
      })
    case 'folded-folder': {
      const partlyOpen = {
        ...portal,
        checkouts: [
          portal.checkouts[0],
          {
            ...portal.checkouts[1],
            sessions: [portal.checkouts[1].sessions[1]]
          }
        ]
      }
      return (
        [harnu, gateway, webApi].map((f) => folderGroup(f, { open: false, live: true })).join('') +
        folderGroup(partlyOpen, { foldLast: true, live: true })
      )
    }
    case 'folded-checkout':
      return folderGroup(portalWithFoldedWork, { foldMain: true, foldLast: true })
    case 'focus':
      return (
        backRow('7 others · 1 needs you', 'data-goto="group-rail?state=separate-rails"') +
        folderGroup(portalWithFoldedWork, { foldLast: true })
      )
    case 'motion':
      return folderGroup(
        { ...portal, checkouts: [portal.checkouts[0], portal.checkouts[2]] },
        { foldLast: true }
      )
    case 'all-idle':
      return folderGroup(idlePortal, { foldLast: true })
    case 'sticky-scrolled':
      return folderGroup(harnu) + folderGroup(gateway, { open: false })
    default:
      return folderGroup(portalWithFoldedWork, { foldLast: true })
  }
}

function rowStrips() {
  const cases = [
    ['Rest', '', false],
    ['Hover', 'hover', false],
    ['Selected', '', true],
    ['Selected + hover', 'hover', true],
    ['Keyboard focus', 'focus', false],
    ['Focus + selected', 'focus', true]
  ]
  const sample = gateway.checkouts[0].sessions[0]
  const strips = [
    [
      'Session',
      (forced, selected) =>
        `<div class="grp strip-session"><div class="session-list">${sessionRow(sample, { forced, selected })}</div></div>`
    ],
    [
      'Checkout · idle group',
      (forced, selected) => checkoutGroup(gateway.checkouts[2], { folded: true, forced, selected })
    ],
    [
      'Checkout · active group',
      (forced, selected) => checkoutGroup(gateway.checkouts[0], { folded: true, forced, selected })
    ],
    ['Folder header', (forced, current) => folderHeader(harnu, { forced, current })]
  ]
  return strips
    .map(
      ([title, row]) => `<section class="strip">
    <h2>${title}</h2>
    ${cases
      .map(
        ([label, forced, selected]) => `<div class="strip-case">
      <span class="strip-label">${label}</span><div class="strip-row" inert>${row(forced, selected)}</div>
    </div>`
      )
      .join('')}
  </section>`
    )
    .join('')
}

customElements.define(
  'mk-tree',
  class extends HTMLElement {
    connectedCallback() {
      const variant = this.getAttribute('variant') || 'app'
      const state = this.getAttribute('state') || 'default'
      const view = this.getAttribute('view') || ''
      const current = this.getAttribute('current')
      this.dataset.dsqaPart = 'tree'
      if (variant === 'strips') {
        this.classList.add('strip-board')
        this.innerHTML = rowStrips()
        return
      }

      const focus = state === 'focus'
      const requestedFolder = new URLSearchParams(location.search).get('folder')
      const focusedFolder = folders.find((folder) => folder.name === requestedFolder) || harnu
      const entries = focus ? [focusedFolder] : folders
      const backDestination = requestedFolder
        ? 'data-goto="sidebar?folder="'
        : 'data-goto="sidebar"'
      const content =
        variant === 'rail'
          ? railMoment(state)
          : (focus ? backRow(otherFolderSummary(focusedFolder), backDestination) : '') +
            entries
              .map((folder) =>
                folderGroup(folder, {
                  open:
                    state !== 'folders-folded' &&
                    (focus || current === folder.name || [harnu, gateway, portal].includes(folder)),
                  foldAll: state === 'sessions-folded',
                  foldMain: state === 'checkout-folded' && folder === harnu,
                  idleOpen: state === 'idle-open' && folder === harnu,
                  current: current === folder.name,
                  live: true,
                  view,
                  state,
                  focus: !focus && view === 'sidebar'
                })
              )
              .join('')
      this.classList.toggle('is-focused', focus)
      this.innerHTML = `<nav class="tree-list" aria-label="Folders">${content}</nav>
      ${variant === 'rail' && state === 'motion' ? '<button type="button" class="demo-btn" aria-pressed="true" data-motion>Stop session</button>' : ''}`
      if (state === 'sticky-scrolled') this.querySelector('nav').scrollTop = 118

      this.addEventListener('click', (event) => {
        if (event.target.closest('[data-goto]')) return
        const button = event.target.closest('button')
        if (!button) return

        if (button.dataset.motion !== undefined) {
          const working = button.getAttribute('aria-pressed') === 'false'
          button.setAttribute('aria-pressed', working)
          button.textContent = working ? 'Stop session' : 'Start session'
          this.querySelector('.grp').classList.toggle('rail-working', working)
          this.querySelector('.dot').classList.toggle('working', working)
          this.querySelector('.dot').setAttribute('aria-label', working ? 'Working' : 'Idle')
          this.querySelector('.ring').classList.toggle('working', working)
          this.querySelector('.ring').classList.toggle('idle', !working)
          this.querySelector('.ring').setAttribute('aria-label', working ? 'Working' : 'Idle')
          this.querySelector('.co-row').setAttribute(
            'aria-label',
            working ? 'main, working' : 'main'
          )
        }

        if (button.dataset.toggle) {
          const { toggle } = button.dataset
          const row = toggle === 'folder' ? button.closest('.fhead') : button
          const next = row.nextElementSibling
          const open = button.getAttribute('aria-expanded') === 'false'
          button.setAttribute('aria-expanded', open)
          next.hidden = !open
          if (toggle === 'checkout')
            row.querySelector('.ln-val').textContent = open ? '' : next.children.length
        }

        if (button.matches('[data-pick-folder], .s-row') && variant === 'app') {
          this.selectRow(button)
        }
      })
    }

    selectRow(button) {
      this.querySelector('.cur')?.classList.remove('cur')
      this.querySelector('[aria-current]')?.removeAttribute('aria-current')
      this.querySelectorAll('.s-row.sel').forEach((row) => {
        row.classList.remove('sel')
        row.setAttribute('aria-pressed', 'false')
      })
      if (button.matches('.s-row')) {
        button.classList.add('sel')
        button.setAttribute('aria-pressed', 'true')
      } else {
        button.closest('.fhead').classList.add('cur')
        button.setAttribute('aria-current', 'page')
      }
    }
  }
)
