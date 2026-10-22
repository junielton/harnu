/**
 * The browser pane's own preferences file, `<userData>/browser-prefs.json` (T572 U5, spec §9.1): today the zoom the
 * operator (or an agent's `browser_emulate({ zoom })`) chose for each origin. The file is read once, on first use,
 * and written whole after every change; a zoom change is rare and the file is tiny, so there is no debounce to lose
 * on a crash. The disk is injected, so the store is tested without one.
 */
import {
  EMPTY_BROWSER_PREFS,
  parseBrowserPrefs,
  serializeBrowserPrefs,
  withZoom,
  zoomFor,
  type BrowserPrefsFile
} from '../../shared/browser-zoom'

export interface BrowserPrefsIo {
  /** The file's text, or `null` when it does not exist (or cannot be read). */
  read(): string | null
  /** Write the whole file. May throw; the store keeps its in-memory value either way. */
  write(text: string): void
}

export interface BrowserPrefsStore {
  /** The zoom factor remembered for `url`'s origin (1 when none). */
  zoomFor(url: string): number
  /** Remember `factor` for `url`'s origin (1 forgets it). Persists at once. */
  setZoom(url: string, factor: number): void
}

export function createBrowserPrefsStore(io: BrowserPrefsIo): BrowserPrefsStore {
  let prefs: BrowserPrefsFile | null = null
  const load = (): BrowserPrefsFile => {
    if (prefs) return prefs
    let text: string | null = null
    try {
      text = io.read()
    } catch {
      text = null
    }
    prefs = text === null ? EMPTY_BROWSER_PREFS : parseBrowserPrefs(text)
    return prefs
  }
  return {
    zoomFor: (url) => zoomFor(load().zoomByOrigin, url),
    setZoom(url, factor) {
      const cur = load()
      const next = withZoom(cur.zoomByOrigin, url, factor)
      if (next === cur.zoomByOrigin) return
      prefs = { ...cur, zoomByOrigin: next }
      try {
        io.write(serializeBrowserPrefs(prefs))
      } catch {
        // A read-only profile keeps the zoom for this run only; the page is not worse off for it.
      }
    }
  }
}
