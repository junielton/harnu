// @vitest-environment jsdom
/**
 * The start page of a tab with no address (browser-tabs spec S-5, AC-24, AC-26): "Running in this folder" and
 * "Recent", each left out when empty; at most 8 recent tiles of the folder, newest first, each with title and host;
 * a tile (or a server row) opens its address in the same tab; the page refreshes when it shows and at most every 5 s
 * while it stays shown.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import BrowserStartPage from '../src/renderer/src/components/BrowserStartPage.vue'
import { START_REFRESH_MS } from '../src/renderer/src/stores/browser'
import { i18n } from '@renderer/i18n'

const FOLDER = '/home/user/org/proj/www'

interface Server {
  name: string
  url: string
  source: string
}
interface Recent {
  title: string
  url: string
  host: string
}

let servers: Server[]
let recent: Recent[]
let browserStartServers: ReturnType<typeof vi.fn>
let browserStartRecent: ReturnType<typeof vi.fn>
let wrapper: VueWrapper | null = null

const recentSample = (n: number): Recent[] =>
  Array.from({ length: n }, (_, i) => ({
    title: `Page ${i + 1}`,
    url: `https://site${i + 1}.example.com/p`,
    host: `site${i + 1}.example.com`
  }))

function mountPage(): VueWrapper {
  wrapper = mount(BrowserStartPage, { props: { folder: FOLDER }, global: { plugins: [i18n] } })
  return wrapper
}

beforeEach(() => {
  setActivePinia(createPinia())
  servers = []
  recent = []
  browserStartServers = vi.fn(async () => servers)
  browserStartRecent = vi.fn(async () => recent)
  ;(window as unknown as { api: unknown }).api = { browserStartServers, browserStartRecent }
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.useRealTimers()
})

describe('recent tiles', () => {
  it('shows the folder’s recent sites newest first, each with its title and host', async () => {
    recent = recentSample(8)
    const w = mountPage()
    await flushPromises()
    expect(browserStartRecent).toHaveBeenCalledWith(FOLDER)
    const tiles = w.findAll('[data-testid="browser-start-tile"]')
    expect(tiles).toHaveLength(8)
    expect(tiles.map((t) => t.find('[data-testid="browser-start-tile-title"]').text())).toEqual(
      recent.map((r) => r.title)
    )
    expect(tiles.map((t) => t.find('[data-testid="browser-start-tile-host"]').text())).toEqual(
      recent.map((r) => r.host)
    )
  })

  it('never draws more than 8 tiles, even if main sent more', async () => {
    recent = recentSample(12)
    const w = mountPage()
    await flushPromises()
    expect(w.findAll('[data-testid="browser-start-tile"]')).toHaveLength(8)
  })

  it('a tile opens its address in the same tab (the address bar’s navigation call)', async () => {
    recent = recentSample(3)
    const w = mountPage()
    await flushPromises()
    await w.findAll('[data-testid="browser-start-tile"]')[1]!.trigger('click')
    expect(w.emitted('open')).toEqual([['https://site2.example.com/p']])
  })
})

describe('sections', () => {
  it('a section with nothing to show is left out', async () => {
    const w = mountPage()
    await flushPromises()
    expect(w.find('[data-testid="browser-start-running"]').exists()).toBe(false)
    expect(w.find('[data-testid="browser-start-recent"]').exists()).toBe(false)

    w.unmount()
    recent = recentSample(1)
    const only = mountPage()
    await flushPromises()
    expect(only.find('[data-testid="browser-start-running"]').exists()).toBe(false)
    expect(only.find('[data-testid="browser-start-recent"]').exists()).toBe(true)
  })

  it('lists running servers with their name, address and source, and a row opens in the same tab', async () => {
    servers = [
      { name: 'www', url: 'http://localhost:5173', source: 'vite' },
      { name: 'api-gateway', url: 'http://localhost:8080', source: 'docker' },
      { name: 'www', url: 'http://192.168.1.20:3000', source: 'ruby' }
    ]
    const w = mountPage()
    await flushPromises()
    expect(browserStartServers).toHaveBeenCalledWith(FOLDER)
    expect(w.find('[data-testid="browser-start-recent"]').exists()).toBe(false)
    const rows = w.findAll('[data-testid="browser-start-server"]')
    expect(rows.map((r) => r.text().replace(/\s+/g, ' '))).toEqual([
      'www localhost:5173 vite',
      'api-gateway localhost:8080 docker',
      'www 192.168.1.20:3000 ruby'
    ])
    await rows[1]!.trigger('click')
    expect(w.emitted('open')).toEqual([['http://localhost:8080']])
  })
})

describe('refresh', () => {
  it('reads once when it shows, then at most every 5 s while it stays shown, and stops when it goes', async () => {
    vi.useFakeTimers()
    const w = mountPage()
    await flushPromises()
    expect(START_REFRESH_MS).toBe(5000)
    expect(browserStartServers).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(4999)
    expect(browserStartServers).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(browserStartServers).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(browserStartServers).toHaveBeenCalledTimes(4)
    w.unmount()
    wrapper = null
    await vi.advanceTimersByTimeAsync(20_000)
    expect(browserStartServers).toHaveBeenCalledTimes(4)
  })

  it('a failed read leaves the page empty instead of breaking it', async () => {
    browserStartServers.mockRejectedValue(new Error('main is busy'))
    browserStartRecent.mockRejectedValue(new Error('main is busy'))
    const w = mountPage()
    await flushPromises()
    expect(w.find('[data-testid="browser-start-page"]').exists()).toBe(true)
    expect(w.findAll('[data-testid="browser-start-tile"]')).toHaveLength(0)
  })
})
