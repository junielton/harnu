import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import path from 'node:path'

export default defineConfig({
  // Vue SFC compilation for component tests. Node-environment logic tests
  // never import `.vue`, so the plugin is inert for them; component tests opt
  // into jsdom via a `// @vitest-environment jsdom` docblock. This config is
  // `.mts` (ESM) because `@vitejs/plugin-vue` v6 is ESM-only.
  plugins: [vue()],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: false,
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      reportsDirectory: 'coverage',
      // Pure-core / thin-shell convention (ADR-0001): only the testable logic
      // surface enters the metric. Env-bound Electron/IPC glue (lifecycle,
      // pty spawn, menus, watchers, updater, IPC registrars) is excluded with
      // justification: the logic lives in unit-tested pure cores (see the T05
      // table) + local smoke e2e; the `thresholds` below is the gate that trips
      // if coverage melts (lesson 004). Every exclusion carries its reason.
      include: ['src/main/**/*.ts', 'src/renderer/src/**/*.ts'],
      exclude: [
        '**/*.d.ts',
        'src/main/index.ts', // app/window lifecycle (e2e)
        'src/renderer/src/main.ts', // renderer bootstrap
        'src/renderer/src/i18n/**', // JSON + setup only
        // MCP control server — env-bound shells (HTTP transport / electron IPC /
        // execFile / userData fs). The ORDER of the security composition lives in
        // the pure cores (mcp/{permission-core,plan-tool-call,confirm-core,
        // agent-boot,…}, command-bridge, worktree-core — in coverage.include +
        // unit-tested); these shells only marshal the effect. Verified
        // by: unit-tested pure core + local smoke e2e (tests/e2e/*.spec.ts) +
        // headless e2e in CI where signature-free (server/prefs, T05 track 2).
        'src/main/mcp/server.ts', // MCP Streamable-HTTP loopback server + SDK transport
        'src/main/mcp/tool-handlers.ts', // T120: per-op handler shell (Electron/fs/bridge) — same reason as server.ts; the dispatch (`op` → handler) is pure in tool-catalog.ts (tested)
        'src/main/mcp/memory-store.ts', // .harnu/memory/ I/O + git-probe (T79; pure logic in memory-core, tested)
        'src/main/roadmap-watcher.ts', // board chokidar + fs (T80; parse/column pure in roadmap-core, tested)
        'src/main/roadmap-ipc.ts', // board ipcMain + fs + git-probe (T80; write/enum/boot-prompt pure in roadmap-core, tested)
        'src/main/mcp/confirm-resolver.ts', // confirm-core ↔ ipc (distinct mcp:confirm channels)
        'src/main/mcp/prefs.ts', // <userData>/mcp-prefs.json I/O
        'src/main/harnu-features.ts', // <userData>/harnu-features.json I/O + doc ?raw (pure logic in composeAppendSystemPrompt, tested)
        'src/main/bundled-skills.ts', // T217: resources/skills → <userData> staging + ~/.claude install + catalog ?raw (every decision is pure in bundled-skills-core, tested)
        'src/main/mcp/worktree-inherit-prefs.ts', // <userData>/worktree-inherit.json I/O (pure decision in worktree-core/policy-assemble, tested)
        'src/main/command-bridge-ipc.ts', // CommandBridge ↔ webContents/ipcMain
        'src/main/manifest-drain-shell.ts', // T113: real drain deps (webContents + fs + git); the pure driver in manifest-drain.ts is tested
        'src/main/worktree-ipc.ts', // execFile git worktree add + adopt + IPC
        'src/main/pr-stack.ts', // T198: execFile gh/git + IPC shell (graph, roles, layout and zoom are pure in pr-stack-core, tested)
        'src/main/review-viewed-store.ts', // T243: `gh api graphql` mark/unmark/read + <userData>/review-viewed.json fs (every rule — precedence, blob-SHA invalidation, the pending-push plan, the GraphQL response shape — is pure in review-viewed.ts, tested)
        'src/main/review-ipc.ts', // T164 U2: execFile git/gh + <userData> blast-radius fs + IPC shell (every parse/flag/discrepancy decision is pure in review-core, tested)
        'src/main/worktree-md-ipc.ts', // git-probe + fs read/atomic-write of WORKTREE.md (T87; generator pure in worktree-md-generate, tested)
        'src/main/detect/screen-detect.ts', // ipcMain/chokidar/fs shell (cores: screen-detect-core, detect-orchestrate-core, shell-session-core, manifest-*)
        'src/main/extensions/extensions-loader.ts', // ipcMain/chokidar/fs shell (T137; cores: extension-manifest-core, extension-registry, both tested)
        'src/main/detect/foreground-process.ts', // Linux /proc fs read (the parse is parseTpgid, tested)
        'src/main/speech.ts', // T237: spawn of the operator's TTS command + ipcMain shell (every decision — tokenizing the command into argv, the PATH to look it up on — is pure in speech-command.ts, tested)
        'src/main/speech-kokoro.ts', // T241: HTTP download + <userData> fs + protocol.handle + ipcMain shell for the offline voice. Every decision — the asset manifest and its byte counts, the crawl bounds, the URL→file resolution and its traversal guard, the resume arithmetic, what a cancel deletes, the rewrite assertion, the install manifest — is pure in speech-kokoro-plan.ts (tested); the licence guarantee itself is asserted against the BUILT artifact by scripts/ci/voice-licence-gate.mjs (tests/voice-licence-gate.test.ts)
        'src/main/messaging.ts', // T215: AF_UNIX connect/write + fs stat against a peer's cc-socks socket (every decision — candidates, predicate, rung classifier, envelope, audit summary — is pure in messaging-socket.ts, tested)
        'src/main/scheduler-store.ts', // T294 (T291 U4): <userData>/schedulers.json + scheduler-runs/<id>.jsonl fs shell (every parse/serialize/trim decision is pure and tested directly)
        'src/main/scheduler-shell.ts', // T294 (T291 U4): the tick runner — spawn/timers/fs/ipc/notify shell (dueWorkers/tickArgv/nextFailureState are pure in scheduler-core.ts, tested; runFromResult is pure and tested in this file's own test)
        'src/renderer/src/stores/command-dispatch.ts', // onRendererCommand ↔ router/store
        'src/renderer/src/lib/speech-kokoro-worker.ts' // BUG-117: `self`/`postMessage` Worker entry — no jsdom Worker in this project's `node`-environment tests; the request/response logic it wires up is pure in speech-kokoro-worker-core.ts (tested)
      ],
      // Ratchet floor (T05) — pinned ~3pts below what was measured on 2026-07-02
      // (lines/statements 66.4%, functions 76.8%, branches 90.5%) with anti-flake
      // slack. Vitest FAILS `--coverage` below these; CI runs
      // `test:coverage`, so a shell that melts to 0% trips the gate.
      // Raise it via manual ratchet (autoUpdate:false) in a PR, never lower it silently.
      thresholds: {
        lines: 63,
        statements: 63,
        functions: 73,
        branches: 87,
        autoUpdate: false
      }
    }
  },
  resolve: {
    alias: {
      '@renderer': path.resolve(import.meta.dirname, 'src/renderer/src')
    }
  }
})
