/**
 * Guest preload of the browser pane (T564 U1, spec §3.3). It runs sandboxed with `contextIsolation: true`
 * inside every page a browser pane loads, in an isolated world that shares the DOM but not JS globals.
 *
 * It is deliberately EMPTY in this unit, and it must never import the app preload (`./index`): the guest has
 * no `window.api`. Later units add, in this file only, the point-and-comment overlay (a closed shadow root,
 * every origin class) and, for `harnu-page:` origins only, the `harnu` page API. It talks to main over a
 * private channel set that main accepts only from the guest's own `webContents`.
 */
export {}
