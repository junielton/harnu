# 005-electron-hardening-beyond-context-isolation: a `<meta>` CSP and a window-open handler don't cover navigation

**Category:** security
**Discovered in:** OSS-readiness audit, `feat/capy-mcp-server` (Jun 2026)
**Status:** active

## The bug class

`createWindow` in `src/main/index.ts` sets `contextIsolation: true` (good) but the
renderer hardening has three gaps that matter because `window.api` is powerful
(arbitrary PTY spawn, file write) and `sandbox: false` (required by the node-pty /
preload design) means the boundary rests entirely on context isolation:

1. **CSP is only a `<meta http-equiv>`** in `index.html` → it protects that one
   document. There is no `will-navigate` / `will-redirect` guard, so if the top
   frame ever navigates (a dropped URL/file, an injected `location` assignment, an
   OAuth-style redirect) the new document loads **without CSP** while keeping the
   full `window.api`.
2. **`setWindowOpenHandler` forwards every URL** to `shell.openExternal` with no
   scheme allowlist. xterm's `WebLinksAddon` turns attacker-influenced terminal
   output (a malicious repo's build log, model output) into clickable links, so a
   single click can fire `file://`, `vscode://`, `smb://`, or a custom handler.

## Root cause

Assuming a single trusted local origin forever, and that a meta-tag CSP plus a
new-window handler cover the renderer. They cover neither **in-page top-frame
navigation** nor **dangerous URL schemes**.

## The fix (and why)

```ts
// 1. Deliver CSP as a response header so it survives navigation, not just a <meta>
session.defaultSession.webRequest.onHeadersReceived((details, cb) =>
  cb({
    responseHeaders: {
      ...details.responseHeaders,
      'Content-Security-Policy': ["default-src 'self'; ..."]
    }
  })
)

// 2. Pin the top frame to the expected renderer URL
const guard = (e: Electron.Event, url: string) => {
  if (url !== EXPECTED) e.preventDefault()
}
win.webContents.on('will-navigate', guard)
win.webContents.on('will-redirect', guard)

// 3. Allowlist schemes before opening externally
win.webContents.setWindowOpenHandler(({ url }) => {
  if (/^(https?|mailto):/.test(url)) shell.openExternal(url)
  return { action: 'deny' }
})
```

## How to detect in reviews

1. `git grep -nE "setWindowOpenHandler|will-navigate|will-redirect|onHeadersReceived" src/main`
   — is there a scheme allowlist? a navigation guard? a header CSP (not just meta)?
2. Check `sandbox`/`contextIsolation`/`nodeIntegration` in `webPreferences`; if
   `sandbox: false`, the navigation/CSP gaps above carry more weight.
3. Any renderer that displays attacker-influenced content as links (xterm
   `WebLinksAddon`, markdown) → confirm the open path is scheme-restricted.

## Related

- `src/main/index.ts` — `createWindow`, `setWindowOpenHandler`
- `src/renderer/.../TerminalPane.vue` — `WebLinksAddon`
- `security/002` / `security/003` — the other halves of the renderer-compromise blast radius
