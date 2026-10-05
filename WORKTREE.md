---
dir: .claude/worktrees/{slug}
from: main
setup:
  - npm ci
boot:
  model: sonnet
---

# Worktree setup — Harnu

`npm ci` is the only setup command, but it does two things, not one:

1. Installs deps from `package-lock.json` (npm is the only package manager here —
   don't use yarn/pnpm/bun, there's no lockfile for them).
2. Triggers the `postinstall` script (`electron-builder install-app-deps`), which
   rebuilds `node-pty` — the only native module in this repo — against Electron's
   V8 ABI. With a warm npm/electron-builder cache this adds only a few seconds;
   on a cold cache (first install ever on a machine, or CI) it compiles from
   source and can take a couple of minutes. Either way it is **not optional** —
   skip it and the PTY backend fails to load at runtime.

Notes for the session working in this worktree:

- No `.env` is required for the normal dev flow — Harnu is an Electron desktop app
  with no server-side secrets to seed. If a future branch introduces one, add
  `seed.copy: [.env]` here.
- Node **>= 22** is required (`.nvmrc` pins `22`). If `npm ci` fails with an
  engine/native-module error, check `node --version` first — a stale Node in PATH
  (nvm/mise shim ordering) is the usual cause, not a real repo problem.
- Canonical smoke check after setup: `npm run typecheck` (runs `typecheck:node`
  then `typecheck:web`) — fast enough to be the go/no-go signal that the worktree
  is usable. `npm run build` also works but is slower (typecheck + electron-vite
  build) and only needed before packaging.
- If you upgrade the `electron` dependency on this branch, rerun `npm install` so
  `electron-builder install-app-deps` rebuilds `node-pty` again for the new ABI.
- Linux/KDE + Wayland: `npm run dev` can be flaky under webkit2gtk. If you hit
  freezes/scroll glitches while live-verifying, retry with
  `GDK_BACKEND=x11 npm run dev`.
