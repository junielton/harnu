/**
 * Recent sites (browser-tabs spec S-5, AC-27): the start page's only kept history. Recording keeps operator-tab
 * main-frame navigations with a 2xx–3xx status, drops query and fragment, masks token-like path segments, skips the
 * auth paths, agent tabs and `pushState`, stores the title and caps at 50.
 */
import { describe, expect, it } from 'vitest'
import {
  RECENT_SHOWN,
  RECENT_STORED,
  createRecentStore,
  recordVisit,
  topRecent,
  withTitle,
  type RecentEntry,
  type Visit
} from '../src/main/browser/recent-sites'

const visit = (over: Partial<Visit> = {}): Visit => ({
  url: 'https://docs.example.com/start',
  title: 'Getting started',
  status: 200,
  openedBy: 'operator',
  ...over
})
const record = (entries: RecentEntry[], v: Partial<Visit>, at = 1000): RecentEntry[] =>
  recordVisit(entries, visit(v), at)
const urls = (entries: RecentEntry[]): string[] => entries.map((e) => e.url)

describe('recording', () => {
  it('keeps an operator tab’s 2xx and 3xx main-frame navigations, with title and host', () => {
    expect(record([], {}, 5)).toEqual([
      {
        url: 'https://docs.example.com/start',
        title: 'Getting started',
        host: 'docs.example.com',
        at: 5
      }
    ])
    expect(record([], { status: 200 })).toHaveLength(1)
    expect(record([], { status: 399 })).toHaveLength(1)
    expect(record([], { status: 302 })).toHaveLength(1)
  })

  it('drops anything that is not 2xx–3xx (errors, no status)', () => {
    for (const status of [0, 199, 400, 404, 500]) {
      expect(record([], { status })).toEqual([])
    }
  })

  it('drops the query and the fragment, keeping the port in the host', () => {
    const got = record([], { url: 'http://localhost:3000/login?next=%2Fadmin&sid=1#top' })
    expect(got[0]).toMatchObject({ url: 'http://localhost:3000/login', host: 'localhost:3000' })
  })

  it('masks a path segment of 20 or more token-like characters with …', () => {
    const t20 = 'a1B2c3D4e5F6g7H8i9J0'
    expect(t20).toHaveLength(20)
    expect(urls(record([], { url: `https://app.example.com/invite/${t20}/accept` }))).toEqual([
      'https://app.example.com/invite/…/accept'
    ])
    expect(urls(record([], { url: `https://app.example.com/s/${'x-y_z'.repeat(5)}` }))).toEqual([
      'https://app.example.com/s/…'
    ])
    // 19 characters, or a segment with a dot, is an ordinary path.
    expect(urls(record([], { url: `https://app.example.com/${t20.slice(1)}` }))).toEqual([
      `https://app.example.com/${t20.slice(1)}`
    ])
    expect(
      urls(record([], { url: 'https://app.example.com/some-long-report-name.final.pdf' }))
    ).toEqual(['https://app.example.com/some-long-report-name.final.pdf'])
  })

  it('skips a path containing reset, token, oauth, callback, verify or magic, in any case', () => {
    for (const path of [
      '/password-reset',
      '/Reset/abc',
      '/api/Token',
      '/OAuth/authorize',
      '/auth/callback',
      '/email/verify',
      '/login/Magic-Link'
    ]) {
      expect(record([], { url: `https://app.example.com${path}` }), path).toEqual([])
    }
    // The query is dropped, not judged: only the path decides.
    expect(record([], { url: 'https://app.example.com/home?token=abc' })).toHaveLength(1)
  })

  it('never records an agent tab, a pushState navigation, or a page that is not http(s)', () => {
    expect(record([], { openedBy: 'agent' })).toEqual([])
    expect(record([], { inPage: true })).toEqual([])
    for (const url of [
      'about:blank',
      'harnu-page://p/a.html',
      'chrome-error://chromewebdata/',
      'file:///tmp/a.html'
    ]) {
      expect(record([], { url }), url).toEqual([])
    }
  })

  it('dedupes by origin + path, newest first, and the revisit takes the new title', () => {
    let e = record([], { url: 'https://a.example.com/x', title: 'A one' }, 1)
    e = record(e, { url: 'https://b.example.com/y', title: 'B' }, 2)
    e = record(e, { url: 'https://a.example.com/x?again=1', title: 'A two' }, 3)
    expect(e.map((r) => [r.url, r.title, r.at])).toEqual([
      ['https://a.example.com/x', 'A two', 3],
      ['https://b.example.com/y', 'B', 2]
    ])
    // The same path on another origin is another entry.
    expect(record(e, { url: 'https://a.example.com:8443/x' }, 4)).toHaveLength(3)
  })

  it('falls back to the host when the page has no title, and a later title replaces it', () => {
    const e = record([], { title: '' })
    expect(e[0]?.title).toBe('docs.example.com')
    expect(withTitle(e, 'https://docs.example.com/start?q=1', 'Docs · Start')[0]?.title).toBe(
      'Docs · Start'
    )
    expect(withTitle(e, 'https://elsewhere.example.com/', 'No')[0]?.title).toBe('docs.example.com')
  })

  it('stores at most 50 and shows at most 8, newest first', () => {
    let e: RecentEntry[] = []
    for (let i = 1; i <= 60; i++) e = record(e, { url: `https://site${i}.example.com/` }, i)
    expect(RECENT_STORED).toBe(50)
    expect(RECENT_SHOWN).toBe(8)
    expect(e).toHaveLength(50)
    expect(e[0]?.host).toBe('site60.example.com')
    expect(e.at(-1)?.host).toBe('site11.example.com')
    expect(topRecent(e).map((r) => r.host)).toEqual(
      [60, 59, 58, 57, 56, 55, 54, 53].map((n) => `site${n}.example.com`)
    )
  })
})

describe('the per-folder store', () => {
  const memoryIo = (): {
    io: Parameters<typeof createRecentStore>[0]['io']
    file: { text: string | null }
  } => {
    const file = { text: null as string | null }
    return {
      file,
      io: {
        read: async () => file.text,
        write: async (t: string) => {
          file.text = t
        }
      }
    }
  }

  it('keeps one list per folder and survives a restart (browser-recent.json)', async () => {
    const m = memoryIo()
    const store = createRecentStore({ io: m.io, now: () => 10 })
    await store.record('/w/a', visit({ url: 'https://one.example.com/' }))
    await store.record('/w/b', visit({ url: 'https://two.example.com/' }))
    await store.setTitle('/w/a', 'https://one.example.com/', 'One')
    expect((await store.list('/w/a')).map((r) => [r.host, r.title])).toEqual([
      ['one.example.com', 'One']
    ])
    expect((await store.list('/w/b')).map((r) => r.host)).toEqual(['two.example.com'])

    const reopened = createRecentStore({ io: m.io, now: () => 11 })
    expect((await reopened.list('/w/a')).map((r) => r.host)).toEqual(['one.example.com'])
    expect(await reopened.list('/w/none')).toEqual([])
  })

  it('a corrupt or unreadable file reads as empty and is replaced on the next record', async () => {
    const m = memoryIo()
    m.file.text = '{not json'
    const store = createRecentStore({ io: m.io, now: () => 1 })
    expect(await store.list('/w/a')).toEqual([])
    await store.record('/w/a', visit())
    expect((await store.list('/w/a')).length).toBe(1)
    expect(() => JSON.parse(m.file.text ?? '')).not.toThrow()
  })
})
