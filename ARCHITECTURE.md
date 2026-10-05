# Architecture

A concise, human-facing map of how Harnu is put together. For the exhaustive, file-by-file
contract see [`CLAUDE.md`](./CLAUDE.md); for the visual system see [`design.md`](./design.md).

## What Harnu is

Harnu is a cross-platform **Electron + Vue 3** desktop app that turns the sprawl of Claude Code
sessions into a single browsable workspace. It reads `~/.claude/projects/` — where Claude Code
persists every session as JSONL plus a `sessions-index.json` — and renders it as a sidebar.
Clicking a session resumes it (`claude --resume <uuid>`); "new session" spawns `claude` in the
chosen folder. There is no daemon, no cloud, and no account — the app is a faithful UI over
files that already exist on disk.

## The three-process model

```
┌─────────────────────────────┐         ┌────────────────────────┐         ┌──────────────┐
│  Renderer (Vue 3, Tailwind) │ ←IPC→   │  Main (Electron, Node) │ ←pipe→  │  PTY procs   │
│  src/renderer/src/          │         │  src/main/             │         │  bash/claude │
└──────────────┬──────────────┘         └────────────────────────┘         └──────────────┘
               │
               ↑ contextBridge — only the typed window.api
               │
       ┌───────┴────────┐
       │ src/preload/   │
       └────────────────┘
```

- **Main** (`src/main/`) — the privileged Node process. Owns window lifecycle, the filesystem
  watcher (`chokidar`), reading `~/.claude`, and the PTY processes. All Node-only APIs live
  here.
- **Preload** (`src/preload/`) — the context bridge. Exposes exactly one typed surface,
  `window.api`, to the renderer. Nothing else crosses the boundary.
- **Renderer** (`src/renderer/`) — the Vue 3 + Tailwind v4 + xterm.js UI. It is
  **sandbox-isolated** (`contextIsolation: true`) and can only call functions exposed through
  `window.api`. It never imports from `node:`.

## Where things live

| Path                                  | Responsibility                                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `src/main/index.ts`                   | Window lifecycle, app events, registers IPC handlers, kills PTYs on quit.                         |
| `src/main/pty.ts`                     | Owns `Map<uuid, IPty>`; handles `pty:create/write/resize/destroy`; streams `pty:data`/`pty:exit`. |
| `src/main/<feature>.ts`               | Other IPC capabilities (each with a `register*(getWindow)` entry point).                          |
| `src/preload/index.ts` + `index.d.ts` | The typed `Api` object → `window.api`; augments the global `Window`.                              |
| `src/renderer/src/App.vue`            | Layout shell; reads Pinia stores, never touches PTYs directly.                                    |
| `src/renderer/src/components/`        | UI pieces (design-entity → file map is in `CLAUDE.md`).                                           |
| `src/renderer/src/stores/`            | Pinia stores (`sessions.ts`, `theme.ts`, …).                                                      |
| `src/renderer/src/i18n/`              | vue-i18n setup; `en.json` + `pt-BR.json` (kept at parity).                                        |
| `src/renderer/src/styles/`            | `main.css` (Tailwind v4 entry, motion helpers) + `themes.css` (tokens).                           |

## The PTY / terminal model

Each session owns a long-lived terminal. Switching sessions **detaches** the xterm element but
keeps the `Terminal` and its PTY running in the background — so Claude keeps streaming and
scrollback keeps filling for sessions that aren't visible. Full teardown (kill the PTY) happens
only on explicit close (⌘W / X button), window unload, or app quit. PTYs are killed in
`before-quit`, so quitting cleanly terminates every spawned shell. The terminal embedding logic
lives in `src/renderer/src/components/TerminalPane.vue` (see `CLAUDE.md` for the attach/detach
and manual sizing details).

## Build tooling

Builds are driven by [electron-vite](https://electron-vite.org/) with three nested Vite configs
(main / preload / renderer) in `electron.vite.config.ts`. `externalizeDepsPlugin()` keeps
native modules out of the JS bundle — they resolve from `node_modules` at runtime. The only
native module is `node-pty`, rebuilt for Electron's ABI by the `postinstall` script
(`electron-builder install-app-deps`). Packaging is handled by `electron-builder`
(`electron-builder.yml`) into `.deb`/AppImage (Linux), `.dmg` (macOS), and `.exe` (Windows).

## Adding an IPC capability

The four-step recipe (main handler → preload api → window types → renderer call) is documented
in [`CONTRIBUTING.md`](./CONTRIBUTING.md#adding-an-ipc-capability) and `CLAUDE.md`.
