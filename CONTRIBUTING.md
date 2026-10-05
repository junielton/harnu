# Contributing to Harnu

Thanks for your interest in improving Harnu — a desktop app that manages every Claude Code
session in one place. This guide covers how to get a dev environment running, the conventions
the codebase enforces, and what we expect in a pull request.

By participating you agree to abide by our [Code of Conduct](./CODE_OF_CONDUCT.md).

## Prerequisites

- **Node.js 22** (the repo's `engines` field requires `>=22`, and CI runs on 22). An `.nvmrc`
  is provided — run `nvm use` (or `fnm use` / `mise use`) to match.
- **npm** (the repo ships a `package-lock.json`; use `npm`, not yarn/pnpm).
- A Linux, macOS, or Windows machine with a C/C++ toolchain. `node-pty` is a native module, and
  the `postinstall` script rebuilds it for Electron's ABI:
  - **Linux:** `python3`, `make` and `g++` (Debian/Ubuntu: `sudo apt install build-essential python3`).
  - **macOS:** the Xcode Command Line Tools (`xcode-select --install`).
  - **Windows:** Visual Studio Build Tools with the "Desktop development with C++" workload.
- **Claude Code** (`claude` on your `PATH`) to exercise sessions in the running app.

## Setup

```bash
git clone https://github.com/junielton/harnu.git
cd harnu
npm install        # postinstall runs `electron-builder install-app-deps` to rebuild node-pty
npm run dev        # launches the Electron window with HMR (main + preload + renderer)
```

On Linux/KDE under Wayland, webkit2gtk can be flaky — if you see freezes or scroll glitches,
try `GDK_BACKEND=x11 npm run dev`.

## npm scripts

| Script                   | What it does                                                         |
| ------------------------ | -------------------------------------------------------------------- |
| `npm run dev`            | electron-vite dev server (main + preload + renderer with HMR).       |
| `npm run build`          | Full production build: `typecheck` + `electron-vite build`.          |
| `npm run typecheck`      | Both `typecheck:node` (main/preload) and `typecheck:web` (renderer). |
| `npm run typecheck:node` | `tsc` over `tsconfig.node.json` (main + preload).                    |
| `npm run typecheck:web`  | `vue-tsc` over `tsconfig.web.json` (renderer + Vue SFCs).            |
| `npm run lint`           | ESLint across the repo (cached).                                     |
| `npm run format`         | Prettier write across the repo.                                      |
| `npm run format:check`   | Prettier check (no writes) — the same gate CI runs.                  |
| `npm test`               | Vitest (single run). `npm run test:watch` for watch mode.            |
| `npm run test:coverage`  | Vitest with v8 coverage.                                             |
| `npm run build:unpack`   | Build + `electron-builder --dir` (unpacked, for local smoke tests).  |
| `npm run sweep`          | Lists git worktrees safe to remove (merged, clean, idle).            |

**Before opening a PR, `npm run typecheck`, `npm run lint`, and `npm test` must all pass.**

### Sweeping stale worktrees

`npm run sweep` (`scripts/worktree-sweep.sh`) defaults to a **dry-run**: it only prints the
worktrees whose branch is merged into `origin/main`, whose tree is clean, and that have no
live process running in them. Pass `--apply` (optionally with a path to scope it to one
worktree) to actually remove the candidates — it uses `git worktree remove` / `git branch -d`
with no force flags, so git still refuses anything inconsistent.

### Pre-commit hook

`npm install` (via the `prepare` script) wires up a Husky `pre-commit` hook that runs
[lint-staged](https://github.com/okonet/lint-staged) on the files you're about to commit:
every staged file is run through `prettier --write --ignore-unknown`, and staged
`src/renderer/src/i18n/*.json` files additionally get the i18n parity check
(`scripts/ci/i18n-parity.mjs`) — so a commit that breaks en/pt-BR key parity is blocked
locally instead of failing in CI. The hook only touches staged files, so it's fast.

In a genuine emergency you can skip it with `git commit --no-verify`, but that just defers
the same checks to CI — prefer fixing the formatting/parity issue instead.

There is also a `pre-push` hook that runs `npm run lint` and `npm run typecheck`. It takes a
minute or two; `git push --no-verify` skips it when you know CI will run them anyway.

### Running every CI gate locally

`bash scripts/ci/local-pipeline.sh` runs the same gates as CI, in the same order, and reports
all failures in one pass instead of one push per red check. Pass `--with-e2e` to include the
Playwright suite.

## Architecture orientation

Read [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the high-level map, and
[`CLAUDE.md`](./CLAUDE.md) for the detailed, file-by-file contract (it is written for AI coding
agents, but it is the most complete description of the conventions). [`docs/README.md`](./docs/README.md)
maps the rest of the docs. Ids such as `T212` or `BUG-64` in comments and docs refer to the
maintainer's internal board; read them as labels that tie a change together.

`WORKTREE.md` at the root is a Harnu worktree manifest: it tells Harnu how to provision a fresh
git worktree of this repo (where to create it and which setup command to run). See
[`docs/user/folders-and-worktrees.md`](./docs/user/folders-and-worktrees.md). In short: it's a
three-process Electron app — **main** (Node, privileged), **preload** (context bridge), and
**renderer** (Vue 3 + Tailwind v4 + xterm.js) — wired together with electron-vite.

## Conventions

### Design contract (UI work)

[`design.md`](./design.md) is the **single source of truth** for the visual system (tokens,
components, motion, copy). It is written in English.

- **Read the relevant section of `design.md` before you write, refactor, or restyle anything
  under `src/renderer/`.**
- If your change needs a token, size, animation, or component variant that isn't in
  `design.md`, **edit `design.md` first in the same change**, then implement.
- No raw colors or off-system sizes in components — use Tailwind utilities backed by
  `src/renderer/src/styles/themes.css`. Never reach for `bg-[#1a1a1f]` or inline `style`
  colors.

### i18n parity (en + pt-BR)

- All visible strings go through `$t('namespace.key')` — no string literals in templates.
- The vue-i18n schema is `typeof en`, so **every new key must be added to BOTH
  `src/renderer/src/i18n/en.json` and `pt-BR.json` in the same change**, or the `vue-tsc`
  build breaks. Default locale is `en`; `pt-BR` is kept at full parity.

### Language policy — English is the lingua franca

Harnu is open source, so English is the sole working language for the repository:
code, comments, docstrings, commit messages, PR titles/descriptions, `CHANGELOG.md`,
everything under `docs/**`, `design.md`, and test names/descriptions all go in
English. The **only** exception is i18n resources — `src/renderer/src/i18n/*` locale
files (like `pt-BR.json`) and fixtures that exist specifically to test i18n/locale
behavior. A PR that introduces non-English prose outside that exception will be
asked to translate it before merge — see
[`docs/lessons/conventions/001-english-lingua-franca.md`](./docs/lessons/conventions/001-english-lingua-franca.md)
for examples.

### Changelog (mandatory)

**Every feature or fix must add a dated entry to [`CHANGELOG.md`](./CHANGELOG.md) in the same
change.** The file follows [Keep a Changelog](https://keepachangelog.com/): newest first,
grouped under a `## YYYY-MM-DD` heading with `### Added` / `### Changed` / `### Fixed`
sections, one user-facing bullet per change. A PR that changes behavior without a changelog
entry is considered incomplete. Pure internal refactors, docs, and test-only changes don't
require an entry.

### User docs and the agent-facing doc

- A change that adds something a user can see or do (a new screen or dialog, a new
  main-process capability, a new MCP verb) updates the matching page under
  [`docs/user/`](./docs/user/) in the same PR.
- A change to what an agent session can do from inside Harnu (an MCP verb in
  `src/main/mcp/tool-catalog.ts`, the shape of what a verb returns, confirm semantics)
  updates [`docs/harnu-features.md`](./docs/harnu-features.md) and bumps its
  `<!-- harnu-features vN -->` marker. Harnu injects that file into every session, so it
  must stay true.

### Third-party notices

The packaged app ships [`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md). When you add,
remove or upgrade a runtime dependency, regenerate it with
`node scripts/gen-third-party-notices.mjs` and commit the result; a test fails when a
dependency is missing from it.

### Automated gates (CI)

Every PR runs [`.github/workflows/ci.yml`](./.github/workflows/ci.yml). Beyond typecheck,
lint, test and build, these gates fail fast so slips don't reach review:

- **Formatting** — `npm run format:check` (`prettier --check .`) must be clean; run
  `npm run format` before pushing.
- **i18n parity** — `en.json` and `pt-BR.json` must share the same keys; the gate lists any
  missing key by name and file (`node scripts/ci/i18n-parity.mjs`).
- **English only** — no Portuguese prose outside the i18n exception
  (`node scripts/ci/english-gate.mjs`).
- **CHANGELOG** — a change under `src/` must also update `CHANGELOG.md`.
- **Agent-facing doc** — a change to `src/main/mcp/tool-catalog.ts` or
  `src/main/harnu-features.ts` must also update `docs/harnu-features.md`.
- **User docs** — a new top-level component, a new top-level file under `src/main/`, or a
  change to the MCP tool catalog must also touch `docs/user/`.
- **Coverage** — `npm run test:coverage` enforces the thresholds in `vitest.config.mts`.
- **Voice licence** — the build must not contain the GPL-licensed speech payload that the
  offline voice downloads at runtime (`node scripts/ci/voice-licence-gate.mjs`, ADR 0012).
- **Client confidentiality** — `tests/no-client-identifiers.test.ts` rejects anything shaped
  like a real tracker key or a private workspace path. Use the neutral vocabulary in
  `CLAUDE.md` (`PROJ-231`, `Acme`, `~/Workspace/org/…`) in examples.

Three of the contract gates have an escape label for a change that legitimately does not need
the update: **`no-changelog`**, **`no-awareness`** and **`no-user-docs`**. A pull request from
a fork cannot set labels, so say in the description which one applies and a maintainer will
add it.

### Adding an IPC capability

The renderer is sandbox-isolated and can only call what the preload exposes. To add a new
capability, follow the four-step recipe:

1. **Main handler** — add the logic in `src/main/<feature>.ts` with a `register*(getWindow)`
   function, and call it from `src/main/index.ts`. Use `ipcMain.handle` for request/response
   and `ipcMain.on` + `webContents.send` for streaming events. Channel naming is
   `feature:verb` (request) and `feature:event:<id>` (per-instance streams).
2. **Preload api** — add the typed function to the `api` object in `src/preload/index.ts`.
3. **Window types** — the `Api` type is inferred from `api` and re-exported;
   `src/preload/index.d.ts` augments `Window`, so the renderer can call
   `window.api.yourFn(...)` with full types.
4. Never `import` from `node:` in a Vue component — all Node-only work lives in `src/main/`.

## Pull request expectations

- Branch off `main`; keep PRs focused on a single concern.
- Confirm the checklist in the [PR template](./.github/PULL_REQUEST_TEMPLATE.md):
  - `npm run typecheck`, `npm run lint`, and `npm test` pass.
  - `CHANGELOG.md` updated for any behavior change.
  - `design.md` consulted (and updated first if needed) for UI changes.
  - i18n keys added to both `en.json` and `pt-BR.json`.
  - Screenshots/recordings attached for visible UI changes.
- Write a clear description of what changed and why. Reference any related issue.
- Match the surrounding code style; run `npm run format` before pushing.

## Reporting bugs and requesting features

Use the GitHub issue forms (Bug report / Feature request). For security issues, do **not**
open a public issue — follow [`SECURITY.md`](./SECURITY.md) instead.
