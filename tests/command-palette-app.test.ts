// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { i18n } from '@renderer/i18n'
import App from '../src/renderer/src/App.vue'
import { useUiStore } from '../src/renderer/src/stores/ui'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import { resetScopesForTests } from '../src/renderer/src/composables/useShortcuts'
import { DESCRIPTOR_BY_ID, type ShortcutActionId } from '../src/main/keybindings-core'

/**
 * T486 U6 — the palette runs `App.vue`'s own registrations (§9.1), so the
 * drift §1 item 3 describes is gone by construction.
 *
 *  - AC-42: palette "Resume last session" skips folder terminals — it runs
 *    App's `session.resumeLast` handler, not a palette-local copy.
 *  - AC-38 against the real table: guarded actions (`folder.rename`,
 *    `view.closeTakeover`) run from the palette although its input has focus.
 */

vi.mock('../src/renderer/src/lib/notification-sound', () => ({ playNotificationSound: vi.fn() }))

const none = (): (() => void) => () => {}
function stubApi(): void {
  ;(window as unknown as { api: unknown }).api = new Proxy(
    {
      claudeChangelogGet: vi.fn(async () => ({
        releases: [],
        lastReadVersion: '',
        lastFetchedAt: 0
      }))
    } as Record<string, unknown>,
    {
      get: (target, key: string) => {
        if (key in target) return target[key]
        return key.startsWith('on') ? none : vi.fn(async () => null)
      }
    }
  )
}

// Everything but the palette is stubbed: only App's registrations matter here.
const STUBS = Object.fromEntries(
  [
    'Sidebar',
    'Topbar',
    'StatusFooter',
    'EmptyState',
    'FolderView',
    'CloudSessionPanel',
    'Onboarding',
    'TakeoverHost',
    'InboxRail',
    'HelperStack',
    'TerminalPane',
    'SessionPreview',
    'FolderPreview',
    'SessionMenu',
    'FolderMenu',
    'SidebarHiddenPopover',
    'AddFolderDialog',
    'SettingsDialog',
    'ClaudeBootDialog',
    'NewSessionDialog',
    'RemoveWorktreeDialog',
    'NewWorktreeDialog',
    'NewFolderDialog',
    'OpenSubfolderDialog',
    'RenameFolderDialog',
    'RenameRepoDialog',
    'MemoryLocationDialog',
    'McpConfirmOverlay',
    'ToastStack'
  ].map((n) => [n, true])
)

const label = (id: ShortcutActionId): string => i18n.global.t(DESCRIPTOR_BY_ID[id].labelKey)

let wrapper: VueWrapper | null = null

async function mountApp(): Promise<VueWrapper> {
  wrapper = mount(App, { attachTo: document.body, global: { plugins: [i18n], stubs: STUBS } })
  await flushPromises()
  return wrapper
}

async function runFromPalette(id: ShortcutActionId): Promise<void> {
  useUiStore().openPalette()
  await flushPromises()
  const input = document.body.querySelector<HTMLInputElement>('input[type="text"]')
  if (!input) throw new Error('palette input not rendered')
  input.focus()
  input.value = label(id)
  input.dispatchEvent(new Event('input'))
  await flushPromises()
  const first = document.body.querySelector<HTMLElement>('[data-palette-item^="action:"]')
  expect(first?.dataset.paletteItem).toBe(`action:${id}`)
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await flushPromises()
}

beforeEach(() => {
  i18n.global.locale.value = 'en'
  localStorage.clear()
  setActivePinia(createPinia())
  stubApi()
  resetScopesForTests()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('AC-42 — palette "Resume last session"', () => {
  it('skips a newer folder terminal and resumes the latest Claude session', async () => {
    const sessions = useSessionsStore()
    sessions.folders.push({
      path: '/repo/alpha',
      alias: 'alpha',
      expanded: true,
      sessions: [
        {
          sessionId: 'claude-1',
          projectPath: '/repo/alpha',
          summary: 'older claude',
          firstPrompt: '',
          modified: '2026-10-01T00:00:00Z',
          resumable: true
        },
        {
          sessionId: 'shell-1',
          projectPath: '/repo/alpha',
          summary: 'terminal',
          firstPrompt: '',
          modified: '2026-10-05T00:00:00Z',
          resumable: true,
          isShellTerminal: true
        }
      ]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    await mountApp()
    await runFromPalette('session.resumeLast')
    expect(sessions.selectedId).toBe('claude-1')
  })
})

describe('AC-38 — guarded actions run from the palette (real App registrations)', () => {
  it('folder.rename opens Rename folder for the active folder', async () => {
    const sessions = useSessionsStore()
    sessions.folders.push({
      path: '/repo/alpha',
      alias: 'alpha',
      expanded: true,
      sessions: []
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    sessions.selectFolder('/repo/alpha')
    await mountApp()
    await runFromPalette('folder.rename')
    const ui = useUiStore()
    expect(ui.dialog).toBe('renameFolder')
    expect(ui.folderActionPath).toBe('/repo/alpha')
  })

  it('view.closeTakeover closes the open takeover', async () => {
    await mountApp()
    const ui = useUiStore()
    ui.toggleCleanup()
    expect(ui.activeView).not.toBeNull()
    await runFromPalette('view.closeTakeover')
    expect(ui.activeView).toBeNull()
  })
})
