// Fake window.api for a non-functional web preview of the Harnu renderer.
;(function () {
  const now = Date.now()
  const iso = (m) => new Date(now - m * 60000).toISOString()
  const sess = (id, path, title, mins, status, branch) => ({
    sessionId: id,
    fullPath: path + '/' + id + '.jsonl',
    fileMtime: now - mins * 60000,
    firstPrompt: title,
    summary: title,
    messageCount: 12 + (mins % 40),
    created: iso(mins + 60),
    modified: iso(mins),
    gitBranch: branch || 'main',
    projectPath: path,
    isSidechain: false,
    status: status || 'idle',
    agents: [],
    resumable: true
  })
  const H = '/home/demo/Workspace/harnu'
  const folders = [
    {
      path: H,
      alias: 'harnu',
      gitBranch: 'main',
      repoId: 'harnu',
      isMainWorktree: true,
      diskExists: true,
      sessions: [
        sess(
          'a1b2c3d4-0000-4000-8000-000000000001',
          H,
          'Orchestrate the memory campaign',
          3,
          'working'
        ),
        sess('a1b2c3d4-0000-4000-8000-000000000002', H, 'Fix sidebar jump palette focus', 45),
        sess('a1b2c3d4-0000-4000-8000-000000000003', H, 'Review PR #197 capture spec', 300)
      ]
    },
    {
      path: H + '-wt/T621-capture',
      alias: 'T621-capture',
      gitBranch: 'card/T621-capture',
      repoId: 'harnu',
      isMainWorktree: false,
      diskExists: true,
      sessions: [
        sess(
          'a1b2c3d4-0000-4000-8000-000000000004',
          H + '-wt/T621-capture',
          'Implement U1 capture',
          12,
          'working',
          'card/T621-capture'
        )
      ]
    },
    {
      path: '/home/demo/Workspace/org/proj/www',
      alias: 'www',
      gitBranch: 'PROJ-231-checkout',
      repoId: 'www',
      isMainWorktree: true,
      diskExists: true,
      sessions: [
        sess(
          'a1b2c3d4-0000-4000-8000-000000000005',
          '/home/demo/Workspace/org/proj/www',
          'Checkout flow refactor',
          90,
          'idle',
          'PROJ-231-checkout'
        )
      ]
    }
  ]
  // extra folders so the sidebar scrolls
  const names = [
    'api-gateway',
    'web-api',
    'portal',
    'example-web',
    'design-system',
    'infra',
    'mobile-app',
    'docs-site',
    'billing',
    'auth-service',
    'search',
    'analytics',
    'notifications',
    'admin-panel',
    'cli-tools',
    'data-pipeline',
    'ml-models',
    'storybook',
    'e2e-tests',
    'monorepo-tools',
    'feature-flags',
    'payments',
    'scheduler',
    'chat-bot'
  ]
  const more = names.flatMap((n) => [n + '-v2', n + '-legacy'])
  names.push(...more)
  names.forEach((n, i) => {
    const path = '/home/demo/Workspace/org/' + n
    const sessions = Array.from({ length: 1 + (i % 4) }, (_, j) =>
      sess(
        'b0000000-0000-4000-8000-' + String(i * 10 + j).padStart(12, '0'),
        path,
        ['Fix flaky test', 'Add pagination', 'Refactor config loader', 'Bump dependencies'][j],
        20 + i * 37 + j * 11,
        j === 0 && i % 5 === 0 ? 'working' : 'idle'
      )
    )
    folders.push({
      path,
      alias: n,
      gitBranch: 'main',
      repoId: n,
      isMainWorktree: true,
      diskExists: true,
      sessions
    })
  })
  // many worktrees of the harnu repo, so the drill-in level scrolls
  const cards = [
    'T600-memory-tiers',
    'T601-capture-hooks',
    'T602-wiki-graph',
    'T603-consolidation',
    'T604-boot-handoff',
    'T605-steward-pause',
    'T606-merge-batch',
    'T607-campaign-map',
    'T608-gate-dots',
    'T609-ledger',
    'T610-recall',
    'T611-github-budget',
    'T612-links-shelf',
    'T613-browser-eval',
    'T614-terminal-lease',
    'T615-cleanup-guided',
    'T616-orphan-volumes',
    'T617-footer-links',
    'T618-jump-palette',
    'T619-voice-mute',
    'BUG-240-scroll-jump',
    'BUG-241-focus-ring',
    'BUG-242-pane-restore',
    'BUG-243-canvas-zindex',
    'BUG-244-ack-shape',
    'T629-theme-editor',
    'T630-session-tags',
    'T631-split-presets',
    'T632-pane-tabs',
    'T633-quick-open',
    'T634-diff-viewer',
    'T635-commit-panel',
    'T636-pr-comments',
    'T637-ci-badges',
    'T638-log-viewer',
    'T639-env-manager',
    'T640-port-map',
    'T641-snippets',
    'T642-session-export',
    'T643-search-index',
    'BUG-245-tooltip-flicker',
    'BUG-246-drag-ghost',
    'BUG-248-i18n-plural',
    'BUG-249-zoom-reset',
    'BUG-250-paste-crlf'
  ]
  const tasks = [
    'Implement the spec',
    'Write the tests',
    'Address review comments',
    'Fix CI on the PR'
  ]
  cards.forEach((c, i) => {
    const path = H + '-wt/' + c
    const sessions = Array.from({ length: 1 + (i % 3) }, (_, j) =>
      sess(
        'c0000000-0000-4000-8000-' + String(i * 10 + j).padStart(12, '0'),
        path,
        tasks[(i + j) % 4],
        5 + i * 23 + j * 7,
        j === 0 && i % 4 === 0 ? 'working' : 'idle',
        'card/' + c
      )
    )
    folders.push({
      path,
      alias: c,
      gitBranch: 'card/' + c,
      repoId: 'harnu',
      isMainWorktree: false,
      diskExists: true,
      sessions
    })
  })
  const forgotten = [
    ['a1b2c3d4-0000-4000-8000-000000000002', 40],
    ['b0000000-0000-4000-8000-000000000020', 125],
    ['c0000000-0000-4000-8000-000000000050', 60 * 26]
  ]
  try {
    const lv = JSON.parse(localStorage.getItem('om2tab.lastViewed') || '{}')
    forgotten.forEach(([id, mins]) => {
      lv[id] = now - mins * 60000
    })
    localStorage.setItem('om2tab.lastViewed', JSON.stringify(lv))
  } catch {}
  const known = {
    foldersLoad: async () => folders,
    ptyCreate: async () => 'fake-pty-' + Math.random().toString(36).slice(2),
    onPtyData: (id, cb) => {
      const lines = [
        '\x1b[38;5;208m✻\x1b[0m Welcome to \x1b[1mClaude Code\x1b[0m  \x1b[2m(web preview — not functional)\x1b[0m\r\n\r\n',
        '\x1b[2m> \x1b[0mOrchestrate the memory campaign\r\n\r\n',
        '\x1b[32m●\x1b[0m Reading .harnu/memory/hot.md …\r\n',
        '\x1b[32m●\x1b[0m mission_get → Step 3 of 6 · 2 verified\r\n\r\n',
        '\x1b[2m╭──────────────────────────────────────────────╮\r\n│ >                                            │\r\n╰──────────────────────────────────────────────╯\x1b[0m\r\n'
      ]
      setTimeout(() => lines.forEach((l, i) => cb(l, i + 1)), 300)
      return () => {}
    },
    // "Return here" zone: needs-input sessions last viewed long ago
    onHook: (cb) => {
      setTimeout(
        () => forgotten.forEach(([id]) => cb({ sessionId: id, taskState: 'needs-input', ts: now })),
        700
      )
      return () => {}
    },
    onApprovalPending: (cb) => {
      const mk = (n, sessionId, toolName, toolInput, summary, agoS) => ({
        requestId: 'req-' + n,
        sessionId,
        kind: 'permission_request',
        toolName,
        toolInput,
        summary,
        createdAtMs: now - agoS * 1000,
        deadlineMs: now + 10 * 60 * 1000
      })
      setTimeout(
        () =>
          [
            mk(
              1,
              'a1b2c3d4-0000-4000-8000-000000000001',
              'Bash',
              { command: 'npm run build' },
              'Bash(npm run build)',
              95
            ),
            mk(
              2,
              'a1b2c3d4-0000-4000-8000-000000000004',
              'Edit',
              { file_path: 'src/renderer/src/App.vue' },
              'Edit(src/renderer/src/App.vue)',
              42
            ),
            mk(
              3,
              'c0000000-0000-4000-8000-000000000010',
              'Bash',
              { command: 'git push --force-with-lease' },
              'Bash(git push --force-with-lease)',
              12
            ),
            mk(
              4,
              'b0000000-0000-4000-8000-000000000000',
              'WebFetch',
              { url: 'https://example.com/docs' },
              'WebFetch(https://example.com/docs)',
              5
            )
          ].forEach((w) => cb(w)),
        600
      )
      return () => {}
    },
    claudeChangelogGet: async () => ({ releases: [], lastReadVersion: '', lastFetchedAt: 0 }),
    telemetryGet: async () => ({ perSession: [], lastKnown: [], fleet: null }),
    userProjectsList: async () => ({
      projects: folders.map((f) => ({ path: f.path, alias: f.alias, addedAt: now })),
      hiddenPaths: []
    })
  }
  const log = new Set()
  window.__harnuStubCalls = log
  window.api = new Proxy(known, {
    get(t, k) {
      if (typeof k !== 'string') return undefined
      if (k in t) return t[k]
      if (/^on[A-Z]/.test(k)) return () => () => {}
      return (...args) => {
        log.add(k)
        if (/(List|s)$/.test(k) && !/Status$|Settings$/.test(k)) return Promise.resolve([])
        return Promise.resolve(undefined)
      }
    }
  })
  window.electron = {
    process: { platform: 'linux', versions: {} },
    ipcRenderer: { on() {}, send() {}, invoke: async () => undefined, removeAllListeners() {} }
  }
})()

// Floating-panels mock: stylesheet + an on/off compare toggle.
;(function () {
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href =
    '/@fs' +
    document.currentScript.src.replace(/^.*?\/@fs/, '').replace(/stub\.js$/, 'floating.css')
  document.head.appendChild(link)
  document.documentElement.classList.add('floating', 'footer-flat')
  window.addEventListener('DOMContentLoaded', () => {
    const b = document.createElement('button')
    b.id = 'float-toggle'
    const label = () =>
      (b.textContent =
        'Floating panels: ' +
        (document.documentElement.classList.contains('floating') ? 'on' : 'off') +
        '  ·  F8')
    const flip = () => {
      document.documentElement.classList.toggle('floating')
      label()
    }
    b.onclick = flip
    window.addEventListener('keydown', (e) => {
      if (e.key === 'F8') flip()
    })
    label()
    document.body.appendChild(b)
    const f = document.createElement('button')
    f.id = 'float-toggle'
    f.style.left = 'calc(50% + 150px)'
    const fl = () =>
      (f.textContent =
        'Footer: ' +
        (document.documentElement.classList.contains('footer-flat') ? 'flat' : 'floating') +
        '  ·  F9')
    const fflip = () => {
      document.documentElement.classList.toggle('footer-flat')
      fl()
    }
    f.onclick = fflip
    window.addEventListener('keydown', (e) => {
      if (e.key === 'F9') fflip()
    })
    fl()
    document.body.appendChild(f)
    const v = document.createElement('button')
    v.id = 'float-toggle'
    v.style.left = 'calc(50% - 170px)'
    const vl = () =>
      (v.textContent =
        'Split: ' +
        (document.documentElement.classList.contains('vertical') ? 'vertical' : 'side by side') +
        '  ·  F10')
    const vflip = () => {
      document.documentElement.classList.toggle('vertical')
      vl()
    }
    v.onclick = vflip
    window.addEventListener('keydown', (e) => {
      if (e.key === 'F10') {
        e.preventDefault()
        vflip()
      }
    })
    vl()
    document.body.appendChild(v)
  })
})()

// Load the expand-to-window + motion mock on every page load
;(function () {
  const src =
    '/@fs' +
    document.currentScript.src.replace(/^.*?\/@fs/, '').replace(/stub\.js$/, 'fullscreen.js')
  window.addEventListener('DOMContentLoaded', () => {
    const sc = document.createElement('script')
    sc.src = src
    document.head.appendChild(sc)
  })
})()
