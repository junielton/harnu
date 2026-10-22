import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Component } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@renderer/i18n'
import RenameFolderDialog from '../../src/renderer/src/components/RenameFolderDialog.vue'
import AddFolderDialog from '../../src/renderer/src/components/AddFolderDialog.vue'
import ClaudeBootDialog from '../../src/renderer/src/components/ClaudeBootDialog.vue'
import MemoryLocationDialog from '../../src/renderer/src/components/MemoryLocationDialog.vue'
import NewFolderDialog from '../../src/renderer/src/components/NewFolderDialog.vue'
import NewSessionDialog from '../../src/renderer/src/components/NewSessionDialog.vue'
import NewWorktreeDialog from '../../src/renderer/src/components/NewWorktreeDialog.vue'
import OpenSubfolderDialog from '../../src/renderer/src/components/OpenSubfolderDialog.vue'
import RemoveWorktreeDialog from '../../src/renderer/src/components/RemoveWorktreeDialog.vue'
import RenameRepoDialog from '../../src/renderer/src/components/RenameRepoDialog.vue'
import SettingsDialog from '../../src/renderer/src/components/SettingsDialog.vue'
import TrustedHostsDialog from '../../src/renderer/src/components/TrustedHostsDialog.vue'
import { useUiStore } from '../../src/renderer/src/stores/ui'
import type { SurfaceSpec, OpenedSurface } from './harness'

let wrapper: VueWrapper | null = null

const q = (sel: string): HTMLElement | null => document.body.querySelector<HTMLElement>(sel)

export const renameFolder: SurfaceSpec = {
  file: 'RenameFolderDialog.vue',
  async open(): Promise<OpenedSurface> {
    setActivePinia(createPinia())
    const ui = useUiStore()
    ui.folderActionPath = '/home/dev/org/proj/www'
    wrapper = mount(RenameFolderDialog, { attachTo: document.body, global: { plugins: [i18n] } })
    ui.openDialog('renameFolder')
    return {
      card: () => q('[role="dialog"]'),
      scrim: () => q('[role="presentation"]'),
      isClosed: () => ui.dialog === null,
      closeSignal: () => `ui.dialog=${String(ui.dialog)}`,
      teardown: () => {
        wrapper?.unmount()
        wrapper = null
      },
      named: {
        input: () => q('#rename-folder-name'),
        close: () => q('[role="dialog"] header button')
      },
      capEvidence: () => {
        const c = q('[role="dialog"]')
        return `${c?.className ?? ''} ${c?.getAttribute('style') ?? ''}`
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Group A — the rest of the `ui.dialog`-driven (DialogId) surfaces.
//
// Shared shape: every one of these opens by flipping `ui.dialog` and closes via
// `ui.closeDialog()`, so `isClosed` is `ui.dialog === null`. `capEvidence` is the
// card's rendered `class` + inline `style` — all of them put `max-height` in
// the inline style, none rely on scoped CSS.
// ---------------------------------------------------------------------------

type Ui = ReturnType<typeof useUiStore>

/** `window.api` stub: every method resolves `undefined`, `onX` subscribers return a no-op unsubscribe. */
function installApi(overrides: Record<string, unknown> = {}): void {
  const api = new Proxy(overrides, {
    get(target, key: string) {
      if (key in target) return target[key]
      if (/^on[A-Z]/.test(key)) return () => () => {}
      return () => Promise.resolve(undefined)
    }
  })
  ;(window as unknown as { api: unknown }).api = api
}

const cardOf = (): HTMLElement | null => q('[role="dialog"]')
const inCard = (sel: string): HTMLElement | null =>
  cardOf()?.querySelector<HTMLElement>(sel) ?? null
const footerButtons = (): HTMLElement[] => [
  ...(cardOf()?.querySelectorAll<HTMLElement>('footer button') ?? [])
]
const headerButton = (): HTMLElement | null => inCard('header button')

/**
 * jsdom's CSS parser DROPS `min(…)` / `calc(…)` values, so a card whose height
 * is `min(80vh, 720px)` (Settings, Open subfolder) renders with no `height` in
 * `style`. For those two the cap evidence is the source text just before the
 * `role="dialog"` attribute of the SFC (the card's own class/style block).
 */
function capFromSource(file: string): () => string {
  return () => {
    const src = readFileSync(join(__dirname, '../../src/renderer/src/components', file), 'utf8')
    const at = src.indexOf('role="dialog"')
    return src.slice(Math.max(0, at - 900), at)
  }
}

const capFromCard = (): string => {
  const c = cardOf()
  return `${c?.className ?? ''} ${c?.getAttribute('style') ?? ''}`
}

interface StoreDrivenOptions {
  file: string
  component: Component
  open: (ui: Ui) => void
  named: () => Record<string, () => HTMLElement | null>
  /** `window.api` overrides for the component's open path. */
  api?: Record<string, unknown>
  /** Prepare stores/props before the component mounts. */
  before?: (ui: Ui) => void
  /** Override where the cap evidence comes from (default: the rendered card). */
  capEvidence?: () => string
}

function storeDriven(o: StoreDrivenOptions): SurfaceSpec {
  return {
    file: o.file,
    async open(): Promise<OpenedSurface> {
      setActivePinia(createPinia())
      installApi(o.api)
      const ui = useUiStore()
      o.before?.(ui)
      const w = mount(o.component, { attachTo: document.body, global: { plugins: [i18n] } })
      o.open(ui)
      await flushPromises()
      return {
        card: cardOf,
        scrim: () => q('[role="presentation"]'),
        isClosed: () => ui.dialog === null,
        closeSignal: () => `ui.dialog=${String(ui.dialog)}`,
        teardown: () => w.unmount(),
        named: o.named(),
        capEvidence: o.capEvidence ?? capFromCard
      }
    }
  }
}

export const addFolder = storeDriven({
  file: 'AddFolderDialog.vue',
  component: AddFolderDialog,
  open: (ui) => ui.openDialog('addFolder'),
  named: () => ({
    input: () => q('[role="dialog"] input[type="text"]'),
    close: headerButton,
    cancel: () => footerButtons()[0] ?? null,
    confirm: () => footerButtons().at(-1) ?? null
  })
})

export const claudeBoot = storeDriven({
  file: 'ClaudeBootDialog.vue',
  component: ClaudeBootDialog,
  open: (ui) => ui.openClaudeBoot('/home/dev/org/proj/www'),
  api: {
    claudeConfigGetFolder: () => Promise.resolve({}),
    claudeConfigGetResolved: () => Promise.resolve({}),
    claudeConfigGetGlobal: () => Promise.resolve({}),
    claudeConfigListEndpoints: () => Promise.resolve([]),
    routingPolicyGetFolder: () => Promise.resolve({})
  },
  named: () => ({ headerClose: headerButton, close: () => footerButtons().at(-1) ?? null })
})

export const memoryLocation = storeDriven({
  file: 'MemoryLocationDialog.vue',
  component: MemoryLocationDialog,
  open: (ui) => ui.openMemoryLocation('/home/dev/org/proj/www'),
  named: () => ({ close: headerButton, cancel: () => footerButtons()[0] ?? null })
})

export const newFolder = storeDriven({
  file: 'NewFolderDialog.vue',
  component: NewFolderDialog,
  open: (ui) => ui.openNewFolder('/home/dev/org/proj/www'),
  named: () => ({
    input: () => q('[role="dialog"] input[type="text"]'),
    close: headerButton,
    cancel: () => footerButtons()[0] ?? null
  })
})

export const newSession = storeDriven({
  file: 'NewSessionDialog.vue',
  component: NewSessionDialog,
  open: (ui) => ui.openNewSession('/home/dev/org/proj/www'),
  api: {
    claudeConfigGetResolved: () => Promise.resolve({}),
    claudeConfigGetGlobal: () => Promise.resolve({}),
    claudeConfigListEndpoints: () => Promise.resolve([])
  },
  named: () => ({
    close: headerButton,
    cancel: () => footerButtons()[0] ?? null,
    start: () => footerButtons().at(-1) ?? null
  })
})

export const newWorktree = storeDriven({
  file: 'NewWorktreeDialog.vue',
  component: NewWorktreeDialog,
  open: (ui) => ui.openNewWorktree('/home/dev/org/proj/www'),
  api: { worktreeBranches: () => Promise.resolve([]) },
  named: () => ({
    input: () => q('[role="dialog"] input[type="text"]'),
    close: headerButton,
    cancel: () => footerButtons()[0] ?? null
  })
})

export const openSubfolder = storeDriven({
  file: 'OpenSubfolderDialog.vue',
  component: OpenSubfolderDialog,
  open: (ui) => ui.openOpenSubfolder('/home/dev/org/proj/www'),
  api: {
    foldersListChildFolders: () => Promise.resolve({ entries: [], truncated: false }),
    foldersListSubfolders: () => Promise.resolve({ entries: [], truncated: false })
  },
  capEvidence: capFromSource('OpenSubfolderDialog.vue'),
  named: () => ({
    search: () => q('[role="dialog"] input'),
    close: headerButton
  })
})

export const removeWorktree = storeDriven({
  file: 'RemoveWorktreeDialog.vue',
  component: RemoveWorktreeDialog,
  open: (ui) => ui.openRemoveWorktree('/home/dev/org/proj/www-PROJ-231', 'feat/proj-231'),
  named: () => ({
    close: headerButton,
    cancel: () => footerButtons()[0] ?? null,
    confirm: () => footerButtons().at(-1) ?? null
  })
})

export const renameRepo = storeDriven({
  file: 'RenameRepoDialog.vue',
  component: RenameRepoDialog,
  open: (ui) => ui.openRenameRepo('repo:org/proj/www', 'www'),
  named: () => ({
    input: () => q('[role="dialog"] input[type="text"]'),
    close: headerButton,
    cancel: () => footerButtons().at(-2) ?? null
  })
})

export const settings = storeDriven({
  file: 'SettingsDialog.vue',
  component: SettingsDialog,
  open: (ui) => ui.openSettings(),
  capEvidence: capFromSource('SettingsDialog.vue'),
  named: () => ({ headerClose: headerButton, close: () => footerButtons().at(-1) ?? null })
})

export const trustedHosts = storeDriven({
  file: 'TrustedHostsDialog.vue',
  component: TrustedHostsDialog,
  open: (ui) => ui.openTrustedHosts('/home/dev/org/proj/www'),
  named: () => ({
    input: () => q('[role="dialog"] input[type="text"]'),
    close: headerButton
  })
})

export const SURFACES_A: SurfaceSpec[] = [
  addFolder,
  claudeBoot,
  memoryLocation,
  newFolder,
  newSession,
  newWorktree,
  openSubfolder,
  removeWorktree,
  renameFolder,
  renameRepo,
  settings,
  trustedHosts
]
