# 003-invalid-semver-crashes-electron-updater-at-boot: keep `package.json` version strict-semver and guard updater init

**Category:** framework (Electron / electron-updater)
**Discovered in:** AppImage startup investigation, `ad93c6c` (Jun 2026)
**Status:** active

## The bug

A packaged build (AppImage) logged at boot:

```
UnhandledPromiseRejectionWarning: Error: App version is not a valid semver version: "0.2.01"
  at new AppUpdater (electron-updater/.../AppUpdater.js)
  at registerUpdater (out/main/index.js)
```

`package.json` had `"version": "0.2.01"` — invalid semver (leading zero in the
patch). electron-updater builds its `AppUpdater` **lazily on the first
`autoUpdater` access** and validates `app.version` as strict semver in the
constructor, so the first `autoUpdater.autoDownload = true` threw. Because
`registerUpdater` runs inside `app.whenReady()`'s async chain, the throw became
an unhandled rejection during boot — only in **packaged** builds (dev
early-returns on `!app.isPackaged`).

## Root cause

Two compounding issues: (1) a version string that passes `npm`/build tooling
(electron-builder happily named the artifact `0.2.1`) but fails the stricter
`semver` parse electron-updater uses; and (2) updater init with no error
boundary, so a single bad field aborts a startup-critical code path.

## The fix (and why)

Correct the version to valid semver, and wrap updater init so any future
misconfig degrades to "no auto-update" instead of destabilising boot:

```ts
// src/main/updater.ts
if (!require('electron').app.isPackaged) return
try {
  autoUpdater.autoDownload = true // first `autoUpdater` access — may throw on bad version
  autoUpdater.autoInstallOnAppQuit = true
} catch (err) {
  console.warn('[updater] disabled — init failed:', String(err))
  return
}
```

## How to detect in reviews

1. Any change to `package.json` `version` must be strict semver
   (`MAJOR.MINOR.PATCH`, no leading zeros) — `npx semver "$(node -p "require('./package.json').version")"`
   should echo it back unchanged.
2. Startup-critical third-party init (updater, watcher, tray) that runs inside
   `whenReady()` must not be able to throw an unhandled rejection — wrap it, or
   the whole app boot is hostage to one library's constructor.
3. Test the **packaged** build, not just `dev` — this class only fires when
   `app.isPackaged` is true. Run `dist/linux-unpacked/<bin>` from a terminal and
   grep stderr for `UnhandledPromiseRejection`.

## Related

- `src/main/updater.ts` (`registerUpdater`)
- `package.json` (`version`)
- `performance/001-bound-filesystem-fanout-at-startup` — found in the same boot investigation
