import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref } from 'vue'
import { useSessionImages } from '../src/renderer/src/composables/useSessionImages'

// The composable orchestrates list/read per session. Fake timers keep the 80ms
// debounce watcher from firing extra IPC, so each assertion observes exactly
// the calls the test made (lesson testing/001).

const LIST = [
  { name: '2.png', path: '/img/2.png', bytes: 20, mtimeMs: 2 },
  { name: '1.png', path: '/img/1.png', bytes: 10, mtimeMs: 1 }
]

let imageCacheList: ReturnType<typeof vi.fn>
let imageCacheRead: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.useFakeTimers()
  imageCacheList = vi.fn(async () => LIST.map((e) => ({ ...e })))
  imageCacheRead = vi.fn(async (_uuid: string, name: string) => `data:image/png;base64,${name}`)
  ;(globalThis as unknown as { window: unknown }).window = {
    api: { imageCacheList, imageCacheRead }
  }
})

afterEach(() => {
  vi.useRealTimers()
  delete (globalThis as unknown as { window?: unknown }).window
})

describe('useSessionImages', () => {
  it('stays empty and skips IPC when the uuid is null', async () => {
    const uuid = ref<string | null>(null)
    const { count, refresh } = useSessionImages(uuid)
    await refresh()
    expect(count.value).toBe(0)
    expect(imageCacheList).not.toHaveBeenCalled()
  })

  it('refresh populates count and entries in the order the list returns', async () => {
    const uuid = ref<string | null>('11111111-2222-4333-8444-555555555555')
    const { count, entries, refresh } = useSessionImages(uuid)
    await refresh()
    expect(imageCacheList).toHaveBeenCalledWith('11111111-2222-4333-8444-555555555555')
    expect(count.value).toBe(2)
    // Independent signal: the stored order matches what the list returned.
    expect(entries.value.map((e) => e.name)).toEqual(['2.png', '1.png'])
  })

  it('loadThumbs reads a data-URL for each entry once', async () => {
    const uuid = ref<string | null>('11111111-2222-4333-8444-555555555555')
    const { entries, refresh, loadThumbs } = useSessionImages(uuid)
    await refresh()
    await loadThumbs()
    expect(imageCacheRead).toHaveBeenCalledTimes(2)
    expect(entries.value.map((e) => e.dataUrl)).toEqual([
      'data:image/png;base64,2.png',
      'data:image/png;base64,1.png'
    ])
    // A second open does not re-read entries that already have a data-URL.
    await loadThumbs()
    expect(imageCacheRead).toHaveBeenCalledTimes(2)
  })

  it('does NOT carry a data-URL across sessions (session-local filenames collide)', async () => {
    const uuid = ref<string | null>('AAAAAAAA-2222-4333-8444-555555555555')
    const { entries, refresh, loadThumbs } = useSessionImages(uuid)
    await refresh() // session A → [2.png, 1.png]
    await loadThumbs() // both get data-URLs
    // Switch to a different session whose list also has a (different) 1.png.
    uuid.value = 'BBBBBBBB-2222-4333-8444-555555555555'
    imageCacheList.mockResolvedValueOnce([
      { name: '1.png', path: '/B/1.png', bytes: 9, mtimeMs: 9 }
    ])
    await refresh()
    // Independent signal: B's 1.png must NOT inherit A's data-URL — it's a
    // fresh entry (shimmer) until loadThumbs reads B's own file.
    expect(entries.value.find((e) => e.name === '1.png')?.dataUrl).toBeUndefined()
  })

  it('drops a stale list when the session changed during the await', async () => {
    const uuid = ref<string | null>('AAAAAAAA-2222-4333-8444-555555555555')
    const { entries, refresh } = useSessionImages(uuid)
    // Session A's list hangs; we resolve it manually after switching to B.
    let resolveA: (v: unknown) => void = () => {}
    imageCacheList.mockReturnValueOnce(new Promise((r) => (resolveA = r)))
    const pA = refresh() // in-flight for A
    uuid.value = 'BBBBBBBB-2222-4333-8444-555555555555'
    imageCacheList.mockResolvedValueOnce([
      { name: '9.png', path: '/B/9.png', bytes: 1, mtimeMs: 1 }
    ])
    await refresh() // B resolves fast → entries = B's
    resolveA([{ name: '1.png', path: '/A/1.png', bytes: 1, mtimeMs: 1 }]) // A resolves late
    await pA
    // Independent signal: A's late result did not clobber B's entries.
    expect(entries.value.map((e) => e.name)).toEqual(['9.png'])
  })

  it('refresh preserves loaded thumbnails and only shimmers a newly-pasted image', async () => {
    const uuid = ref<string | null>('11111111-2222-4333-8444-555555555555')
    const { entries, refresh, loadThumbs } = useSessionImages(uuid)
    await refresh()
    await loadThumbs() // 2.png + 1.png now have data-URLs
    const readsBefore = imageCacheRead.mock.calls.length

    // A new image (3.png) lands — the list now returns it first.
    imageCacheList.mockResolvedValueOnce([
      { name: '3.png', path: '/img/3.png', bytes: 30, mtimeMs: 3 },
      ...LIST
    ])
    await refresh()

    const byName = Object.fromEntries(entries.value.map((e) => [e.name, e.dataUrl]))
    // Independent signals: existing thumbs carried over (no reload/flicker)…
    expect(byName['2.png']).toBe('data:image/png;base64,2.png')
    expect(byName['1.png']).toBe('data:image/png;base64,1.png')
    // …the new one shimmers until the next loadThumbs…
    expect(byName['3.png']).toBeUndefined()
    // …and a metadata refresh read zero thumbnails.
    expect(imageCacheRead.mock.calls.length).toBe(readsBefore)
  })

  it('clearThumbs frees loaded data-URLs but keeps the metadata/count', async () => {
    const uuid = ref<string | null>('11111111-2222-4333-8444-555555555555')
    const { entries, count, refresh, loadThumbs, clearThumbs } = useSessionImages(uuid)
    await refresh()
    await loadThumbs()
    expect(entries.value.every((e) => e.dataUrl)).toBe(true)
    clearThumbs()
    // Independent signals: base64 gone, but the entries/count survive.
    expect(entries.value.every((e) => e.dataUrl === undefined)).toBe(true)
    expect(entries.value.map((e) => e.name)).toEqual(['2.png', '1.png'])
    expect(count.value).toBe(2)
  })

  it('does not poll while the active gate is false, and resumes when it flips true', async () => {
    const uuid = ref<string | null>('11111111-2222-4333-8444-555555555555')
    const active = ref(false)
    useSessionImages(uuid, active)
    // The immediate watcher schedules one (ungated) refresh — let it run.
    await vi.advanceTimersByTimeAsync(80)
    expect(imageCacheList).toHaveBeenCalledTimes(1)
    // Several poll intervals pass with active=false → no further IPC.
    await vi.advanceTimersByTimeAsync(3 * 2000)
    expect(imageCacheList).toHaveBeenCalledTimes(1)
    // Session goes live → the very next poll tick resumes.
    active.value = true
    await vi.advanceTimersByTimeAsync(2000)
    expect(imageCacheList).toHaveBeenCalledTimes(2)
  })
})
