# 002-remote-debugging-port-flips-is-dev-in-packaged-verify: don't pass `--remote-debugging-port` to a packaged build you're verifying

**Category:** testing (live-verify / packaged builds)
**Discovered in:** AppImage startup investigation (Jun 2026)
**Status:** active

## The bug

To diagnose "the AppImage won't open", a guarded launch ran
`dist/linux-unpacked/harnu --remote-debugging-port=9444` to drive it over CDP. The
window came up blank / had no page target, and the diagnosis nearly concluded
"the renderer is broken in production." It wasn't — passing that flag had flipped
the app into **dev mode**, which loads the renderer from `localhost` (nothing
serving it) instead of from disk.

## Root cause

`src/main/index.ts` detects dev mode from the command line, because
`app.isPackaged`/`is.dev` proved unreliable under electron-vite (Electron 39):

```ts
const IS_DEV = process.argv.some((a) => a.includes('--remote-debugging-port'))
if (IS_DEV) {
  mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'] ?? 'http://localhost:5174')
} else {
  mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
}
```

So the very flag used to _observe_ the packaged app **changes** its behavior —
the renderer-URL gotcha, inverted. The observation tool corrupted the thing
observed.

## The fix (and why)

To verify a **packaged** build faithfully, launch it WITHOUT
`--remote-debugging-port` (so `IS_DEV` stays false → `loadFile` from disk), and
also strip a polluted shell env that leaks dev signals:

```bash
env -u NODE_ENV -u ELECTRON_RENDERER_URL GDK_BACKEND=x11 \
  dist/linux-unpacked/harnu --no-sandbox --user-data-dir=/tmp/verify-ud
```

Confirm the load path via the `[main:boot]` log (`is.dev=false`, no "loading
renderer from" line). If you need CDP introspection, accept that it forces dev
mode and serve the built renderer yourself, or drive the real renderer a
different way — never conclude "production renderer is broken" from a
`--remote-debugging-port` run.

## How to detect in reviews

1. Any verify/diagnostic recipe for a **packaged** Electron build that passes
   `--remote-debugging-port` and then inspects the renderer — it's measuring dev
   mode, not production.
2. More general: when a debug flag is also a behavior switch (here, dev-mode
   detection), instrumenting with it invalidates the result. Check what the flag
   _also_ does in this codebase before trusting the observation.
3. A polluted shell (`NODE_ENV=development`, `ELECTRON_RENDERER_URL=...` left over
   from a dev server) leaks into launched children — strip it for prod-faithful runs.

## Related

- `src/main/index.ts` (`IS_DEV` detection, renderer load branch)
- `docs/dev/live-verify-second-instance.md` (the `is.dev` renderer-URL gotcha)
