// @vitest-environment jsdom
/**
 * T487 (agent terminals B7) — AC-B7-3: the Settings → Control server toggle "Allow agents to type
 * into terminals" reads and writes the pref through `window.api`, shows its hint, and both
 * locale files carry both keys (the schema is `typeof en`, so a missing pt-BR key breaks the
 * build — this pins the text too).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import en from '../src/renderer/src/i18n/en.json'
import ptBR from '../src/renderer/src/i18n/pt-BR.json'
import McpServerPane from '../src/renderer/src/components/McpServerPane.vue'

type Api = Record<string, (...a: unknown[]) => unknown>

function stubApi(overrides: Api): void {
  const base: Api = {
    mcpStatus: async () => ({ enabled: true, port: 1234, connected: false }),
    mcpGetAudit: async () => [],
    userProjectsList: async () => ({ projects: [], hiddenPaths: [] }),
    mcpAskGet: async () => false,
    mcpAutoRegisterGet: async () => true,
    mcpGrantsList: async () => [],
    onMcpGrantsChanged: () => () => {},
    foldersLoad: async () => [],
    orchestratorListArmed: async () => []
  }
  ;(globalThis as unknown as { window: unknown }).window = {
    api: new Proxy({ ...base, ...overrides }, { get: (t, k: string) => t[k] ?? (async () => null) })
  }
}

function mountPane(): VueWrapper {
  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en, 'pt-BR': ptBR } })
  return mount(McpServerPane, { global: { plugins: [createPinia(), i18n] } })
}

const toggleOf = (w: VueWrapper): ReturnType<VueWrapper['find']> =>
  w.find(`[role="switch"][aria-label="${en.mcpServer.agentTerminalWrites}"]`)

beforeEach(() => {
  setActivePinia(createPinia())
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  delete (globalThis as unknown as { window?: unknown }).window
})

describe('Settings → Control server: Allow agents to type into terminals', () => {
  it('both locale files carry the label and the hint', () => {
    expect(en.mcpServer.agentTerminalWrites).toBe('Allow agents to type into terminals')
    expect(en.mcpServer.agentTerminalWritesHint).toBe(
      'When off, agents can still read terminals you allow, but every attempt to type is refused.'
    )
    expect(ptBR.mcpServer.agentTerminalWrites).toBeTruthy()
    expect(ptBR.mcpServer.agentTerminalWritesHint).toBeTruthy()
  })

  it('reads the pref on mount and shows the label and hint (default ON)', async () => {
    const get = vi.fn(async () => true)
    stubApi({ mcpAgentTerminalWritesGet: get })
    const w = mountPane()
    await flushPromises()
    expect(get).toHaveBeenCalled()
    expect(w.text()).toContain(en.mcpServer.agentTerminalWrites)
    expect(w.text()).toContain(en.mcpServer.agentTerminalWritesHint)
    expect(toggleOf(w).attributes('aria-checked')).toBe('true')
    w.unmount()
  })

  it('shows OFF when main says OFF', async () => {
    stubApi({ mcpAgentTerminalWritesGet: async () => false })
    const w = mountPane()
    await flushPromises()
    expect(toggleOf(w).attributes('aria-checked')).toBe('false')
    w.unmount()
  })

  it('flipping it writes the pref through the preload and reflects main’s answer', async () => {
    const set = vi.fn(async (enabled: unknown) => enabled)
    stubApi({ mcpAgentTerminalWritesGet: async () => true, mcpAgentTerminalWritesSet: set })
    const w = mountPane()
    await flushPromises()
    ;(toggleOf(w).element as HTMLElement).click()
    await flushPromises()
    expect(set).toHaveBeenCalledWith(false)
    expect(toggleOf(w).attributes('aria-checked')).toBe('false')
    ;(toggleOf(w).element as HTMLElement).click()
    await flushPromises()
    expect(set).toHaveBeenLastCalledWith(true)
    expect(toggleOf(w).attributes('aria-checked')).toBe('true')
    w.unmount()
  })

  it('reverts when the write fails', async () => {
    stubApi({
      mcpAgentTerminalWritesGet: async () => true,
      mcpAgentTerminalWritesSet: async () => {
        throw new Error('ipc down')
      }
    })
    const w = mountPane()
    await flushPromises()
    ;(toggleOf(w).element as HTMLElement).click()
    await flushPromises()
    expect(toggleOf(w).attributes('aria-checked')).toBe('true')
    w.unmount()
  })
})
