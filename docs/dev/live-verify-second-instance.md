# Live verification: run a second, isolated Harnu instance over CDP

When you need to **prove a change works in the real running app** — not just in
unit tests — you can launch a _second_ Harnu instance **alongside** the user's
already-running one (an installed AppImage, or a `npm run dev` window), drive it
programmatically via the Chrome DevTools Protocol (CDP), inspect what it actually
wrote to disk, and tear it down — all without touching the user's instance.

This is how the "Claude Boot" persistence fix was verified end-to-end (saving a
config actually writes `<userData>/claude-boot.json`).

**Just need a human to click around, no CDP?** Use
`scripts/dev/qa-parallel.sh up` instead — it does the packaged-build path below
(no static-server gotcha) with a worktree-scoped `userData`/pidfile/log, so it
never collides with another worktree's parallel instance (a shared hardcoded
`/tmp/harnu-verify` path across concurrent sessions is a real collision that
happened once — `git worktree`'s toplevel basename is what makes each
worktree's instance unique). `... down` tears it down. Keep reading for the
CDP-driven path when you need to assert on `window.api.*` programmatically.

## Why it doesn't collide with the running instance

Harnu uses Electron's **single-instance lock**, which is keyed on the `userData`
directory (`~/.config/Harnu`). Two things make a second instance safe:

1. **Isolated state + lock:** pass `--user-data-dir=/tmp/harnu-verify`. A different
   `userData` means a _separate_ lock (so the new instance doesn't get
   `app.quit()`'d on launch) and a _throwaway_ config/state dir (you never touch
   the user's real `~/.config/Harnu`).
2. **Separate CDP port:** pass `--remote-debugging-port=9333` (anything but
   `9222`, which the user's dev instance / other tools may already hold — see
   `memories/.../dev-app-cdp-port-9222-conflict.md`).

## The `--remote-debugging-port` ⇒ dev-mode gotcha

`IS_DEV` in `src/main/index.ts` is keyed on **argv containing
`--remote-debugging-port`** — so passing the CDP flag forces dev mode even on a
packaged/unpacked binary (`isPackaged === true` doesn't save you), and the main
loads `http://localhost:5174` instead of the built renderer. Corollary: if you
don't need CDP (the user just wants to click around), launch **without** the
flag and the renderer loads from disk with zero extra setup.

## The `localhost:5174` IPv4/IPv6 shadow gotcha

`python3 -m http.server 5174` binds `0.0.0.0` (IPv4 only), but Chromium resolves
`localhost` to `::1` first — so if anything else (e.g. a Laravel/Vite dev server)
is listening on `[::1]:5174`, the window silently loads THAT app instead of
Harnu. `window.api` still works (the preload loads from disk), so a CDP probe can
"pass" while the visible page is a foreign site — check `document.title`. Fix:
free the port, or serve with an IPv6-capable server, or skip the port entirely
via the no-CDP launch above.

## The `is.dev` renderer-URL gotcha

Running an **unpackaged** `electron out/main/index.js` sets `app.isPackaged ===
false`, so `@electron-toolkit/utils`' `is.dev` is `true` and the main process
loads the renderer from `http://localhost:5174` instead of the built files on
disk. If nothing serves that URL you get `ERR_CONNECTION_REFUSED` and a blank
window with **no `window.api`**.

Two ways around it:

- **Fast:** serve the built renderer on that port yourself. The **preload still
  loads from disk**, so `window.api` is wired regardless of where the HTML comes
  from:
  ```bash
  python3 -m http.server 5174 -d out/renderer &
  ```
- **Production-faithful:** build an unpacked app (`npm run build:unpack`) and run
  the binary from `dist/linux-unpacked/harnu` — there `app.isPackaged === true`,
  `is.dev` is `false`, and the main loads the renderer from disk (no static
  server needed).

## Full recipe (fast path)

```bash
# 0. node may not be on PATH (it's via mise) — prefix node/electron with `mise exec --`.

# 1. Build (produces out/main, out/preload, out/renderer)
mise exec -- npm run build

# 2. Serve the built renderer on the port the unpackaged main loads
python3 -m http.server 5174 -d out/renderer >/tmp/harnu-static.log 2>&1 &

# 3. Launch the SECOND, isolated instance (own userData + alt CDP port)
rm -rf /tmp/harnu-verify
DISPLAY=${DISPLAY:-:0} mise exec -- node_modules/.bin/electron out/main/index.js \
  --user-data-dir=/tmp/harnu-verify \
  --remote-debugging-port=9333 \
  --no-sandbox >/tmp/harnu-verify.log 2>&1 &
sleep 8   # wait for the window + CDP endpoint

# 4. Drive it over CDP and inspect the result (see verify.mjs below)
mise exec -- node verify.mjs

# 5. Inspect what the app actually wrote
cat /tmp/harnu-verify/claude-boot.json

# 6. Teardown — kill THIS instance's electron procs by PID.
#    NEVER use a pkill -f pattern that matches "harnu-verify": it would match this
#    very command line and kill the shell (exit 144). Match comm==electron + the
#    userData dir via awk, and exclude awk itself.
for pid in $(ps -eo pid,comm,args | awk '/harnu-verify/ && $2=="electron" && !/awk/ {print $1}'); do kill "$pid"; done
for pid in $(ps -eo pid,args      | awk '/http\.server 5174/ && !/awk/ {print $1}'); do kill "$pid"; done
rm -rf /tmp/harnu-verify
```

## `verify.mjs` — drive `window.api` over CDP (Node 22, built-in `WebSocket`)

Node 22 exposes a global `WebSocket`, so no `ws`/`chrome-remote-interface`
dependency is needed. Get the page target, then `Runtime.evaluate` any expression
against the preload-exposed `window.api.*`:

```js
import http from 'node:http'
const get = (u) =>
  new Promise((res, rej) =>
    http
      .get(u, (r) => {
        let d = ''
        r.on('data', (c) => (d += c))
        r.on('end', () => res(JSON.parse(d)))
      })
      .on('error', rej)
  )

const page = (await get('http://127.0.0.1:9333/json')).find(
  (t) => t.type === 'page' && t.webSocketDebuggerUrl
)
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = {}
const send = (method, params = {}) =>
  new Promise((res) => {
    const i = ++id
    pending[i] = res
    ws.send(JSON.stringify({ id: i, method, params }))
  })
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending[m.id]) {
    pending[m.id](m)
    delete pending[m.id]
  }
})
await new Promise((res, rej) => {
  ws.addEventListener('open', res)
  ws.addEventListener('error', rej)
})

await send('Runtime.enable')
const r = await send('Runtime.evaluate', {
  // Any preload IPC is reachable; awaitPromise unwraps async ones.
  expression: `(async () => {
    await window.api.claudeConfigSetGlobal({ model: 'haiku', effort: 'high' })
    return JSON.stringify(await window.api.claudeConfigGetGlobal())
  })()`,
  awaitPromise: true,
  returnByValue: true
})
console.log('result:', r.result?.result?.value ?? r.result?.exceptionDetails)
ws.close()
```

## Liveness bench

`scripts/dev/liveness-bench/` is a ready-made harness on top of this recipe: it measures
time-to-row (a `claude`-shaped JSONL or a `git worktree add` appearing in the sidebar),
slug-pass cost, IPC events/s and bytes/event, and per-process CPU labelled by
`app.getAppMetrics()` type (`Browser` main, `Tab` renderer, `GPU`). It is how the
sidebar-liveness work gets its before/after numbers (spec AC-30). The README has the full
run recipe and the AC-30 checklist; the short version:

- Same isolation rules as above: a fake `HOME`, its own `--user-data-dir`, its own
  `--remote-debugging-port` and `--inspect` ports (`PAGE_PORT` / `NODE_PORT` env vars).
  Never point it at your real `~/.claude`.
- Logpoints in `out/main/index.js` are found by pattern (`locate.mjs`), so any build
  works; if a pattern stops matching it throws — fix the pattern, don't guess a line.
- **GPU caveat.** `--remote-debugging-port` ⇒ dev mode ⇒ GPU acceleration is off (the
  gotcha above). Animation/GPU numbers (`gpu.mjs`) need a second launch **without**
  `--remote-debugging-port`, driven only through `--inspect`.

See [`scripts/dev/liveness-bench/README.md`](../../scripts/dev/liveness-bench/README.md).

## Notes

- The window **does** appear on the user's screen (needs `DISPLAY`). It's brief;
  tell the user you're popping a throwaway instance for verification.
- This drives the **preload IPC directly** (`window.api.*`), which proves the
  preload→main→disk path. To also prove the renderer/store layer (e.g. that a
  Pinia action sends a structured-clone-safe payload), keep the unit tests — the
  two together cover the whole chain.
- Don't fight port `9222` or kill the user's electron; always isolate on an alt
  port + fresh `userData` and tear down only the PIDs you spawned.

## The Harnu mod host in the isolated instance (T389)

The Harnu mod host keeps everything under `<userData>/companion/` (`c.sock`, `endpoint.json`,
`audit.ndjson`) and reads its mode from `<userData>/companion-prefs.json`. The isolated instance
has its own `--user-data-dir`, so its socket, rendezvous file and audit log are separate from the
user's: running your recipe never touches theirs. The host stays dark until the prefs file says
otherwise, so write `{ "v": 1, "mode": "shadow" }` to the throwaway `companion-prefs.json` before
launch. Launch from `out/` (an unpackaged run): `window.api.companionDevMintSpawn()` mints a spawn
token for a throwaway owner only when `!app.isPackaged`, so a `build:unpack` build refuses it.
`window.api.companionDiagnostics()` shows the listener, the totals and each binding, never a token.
The socket path must stay under 90 bytes, so keep the `--user-data-dir` short (for example
`/tmp/hv1`); a longer one makes the host announce TCP loopback instead.
