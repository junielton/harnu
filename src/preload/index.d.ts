import { ElectronAPI } from '@electron-toolkit/preload'
import type {
  Api,
  DegradedCode,
  SessionStatus,
  Session,
  SettingsData,
  ClaudeRelease,
  ClaudeChangelogState,
  ExplorerEntry,
  ExplorerListing,
  ExplorerSearchResult,
  ExtensionThemeWire
} from './index'

// Re-export the preload's public types so the renderer can pull everything
// it needs from one barrel (`import type { Api, Session, ... } from '../../../preload'`).
// The renderer's `tsconfig.web.json` only includes `src/preload/*.d.ts`, not
// `index.ts` itself, so this barrel is the single seam between the two
// processes' type worlds.
export type {
  Api,
  DegradedCode,
  SessionStatus,
  Session,
  SettingsData,
  ClaudeRelease,
  ClaudeChangelogState,
  // Explorer tree wire types (Cluster C) — so the renderer can import them by
  // name from the preload barrel (`window.api.explorerListDir` return shape).
  ExplorerEntry,
  ExplorerListing,
  ExplorerSearchResult,
  ExtensionThemeWire
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: Api
  }
}
