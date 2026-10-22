/**
 * T569 (browser pane U2, AC-6, AC-7) — the `setData` sidecar (spec §4.5) over a real temp dir, and the
 * `browser_patch` script (spec §5.2).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  MAX_DATA_BYTES,
  createPageStateStore,
  mergeData,
  sidecarPath,
  type PageStateFs
} from '../src/main/browser/page-state'
import { buildPatchScript, isPatchMode, patchNeedsHtml } from '../src/main/browser/page-patch'

let dir: string
let clock = 5_000
const diskFs: PageStateFs = {
  readFile: (f) => fsp.readFile(f, 'utf8'),
  readFileSync: (f) => fs.readFileSync(f, 'utf8'),
  writeAtomic: async (f, body) => {
    await fsp.mkdir(path.dirname(f), { recursive: true })
    const tmp = `${f}.tmp`
    await fsp.writeFile(tmp, body)
    await fsp.rename(tmp, f)
  }
}
const store = () => createPageStateStore({ fs: diskFs, now: () => clock })

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harnu-page-state-'))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('the sidecar', () => {
  it('lives under .harnu/out/browser/state/<sha256(relPath)[:16]>.json', () => {
    const file = sidecarPath('/w', 'docs/a.html')
    expect(file).toMatch(/^\/w\/\.harnu\/out\/browser\/state\/[0-9a-f]{16}\.json$/)
    expect(sidecarPath('/w', 'docs/b.html')).not.toBe(file)
  })

  it('reads rev 0 and null data before anything was stored', async () => {
    expect(await store().read(dir, 'a.html')).toEqual({
      v: 1,
      path: 'a.html',
      rev: 0,
      updatedAt: 0,
      data: null
    })
  })

  it('writes { v, path, rev, updatedAt, data } and bumps rev by one per write', async () => {
    const s = store()
    const first = await s.set(dir, 'a.html', { n: 1 })
    expect(first).toMatchObject({
      ok: true,
      state: { v: 1, path: 'a.html', rev: 1, updatedAt: 5000, data: { n: 1 } }
    })
    clock = 6_000
    const second = await s.set(dir, 'a.html', { n: 2 })
    expect(second).toMatchObject({ ok: true, state: { rev: 2, updatedAt: 6000 } })
    const onDisk = JSON.parse(await fsp.readFile(sidecarPath(dir, 'a.html'), 'utf8'))
    expect(onDisk).toEqual({ v: 1, path: 'a.html', rev: 2, updatedAt: 6000, data: { n: 2 } })
    expect(s.readSync(dir, 'a.html').rev).toBe(2)
  })

  it('is shared by two stores (two panes on one file) because it lives on disk', async () => {
    await store().set(dir, 'a.html', { shared: true })
    expect((await store().read(dir, 'a.html')).data).toEqual({ shared: true })
  })

  it('serialises concurrent writes to one path: every rev is used exactly once', async () => {
    const s = store()
    const results = await Promise.all(
      Array.from({ length: 25 }, (_, i) => s.set(dir, 'a.html', { i }, { merge: true }))
    )
    const revs = results.map((r) => (r.ok ? r.state.rev : -1)).sort((a, b) => a - b)
    expect(revs).toEqual(Array.from({ length: 25 }, (_, i) => i + 1))
    expect((await s.read(dir, 'a.html')).rev).toBe(25)
  })

  it('keeps different paths independent', async () => {
    const s = store()
    await s.set(dir, 'a.html', 1)
    const b = await s.set(dir, 'b.html', 2)
    expect(b).toMatchObject({ ok: true, state: { rev: 1 } })
  })

  it('refuses data over 256 KiB serialised and writes nothing', async () => {
    const s = store()
    const huge = await s.set(dir, 'a.html', 'x'.repeat(MAX_DATA_BYTES))
    expect(huge).toMatchObject({ ok: false, code: 'DATA_TOO_LARGE' })
    expect(fs.existsSync(sidecarPath(dir, 'a.html'))).toBe(false)
    expect(await s.set(dir, 'a.html', 'x'.repeat(MAX_DATA_BYTES - 2))).toMatchObject({ ok: true })
  })

  it('refuses a merge that GROWS past the cap', async () => {
    const s = store()
    await s.set(dir, 'a.html', { a: 'x'.repeat(MAX_DATA_BYTES - 100) })
    expect(await s.set(dir, 'a.html', { b: 'y'.repeat(200) }, { merge: true })).toMatchObject({
      ok: false,
      code: 'DATA_TOO_LARGE'
    })
  })

  it('expectRev: REV_CONFLICT when stale, writes when exact', async () => {
    const s = store()
    await s.set(dir, 'a.html', 1)
    expect(await s.set(dir, 'a.html', 2, { expectRev: 0 })).toEqual({
      ok: false,
      code: 'REV_CONFLICT',
      currentRev: 1
    })
    expect((await s.read(dir, 'a.html')).data).toBe(1)
    expect(await s.set(dir, 'a.html', 2, { expectRev: 1 })).toMatchObject({
      ok: true,
      state: { rev: 2 }
    })
  })

  it('treats a corrupt sidecar as empty and recovers on the next write', async () => {
    const file = sidecarPath(dir, 'a.html')
    await diskFs.writeAtomic(file, '{not json')
    const s = store()
    expect((await s.read(dir, 'a.html')).rev).toBe(0)
    expect(await s.set(dir, 'a.html', { ok: 1 })).toMatchObject({ ok: true, state: { rev: 1 } })
  })

  it('merges deep plain objects, replaces arrays and scalars, ignores __proto__', () => {
    expect(mergeData({ a: { b: 1, c: 2 }, l: [1] }, { a: { c: 3 }, l: [2, 3] })).toEqual({
      a: { b: 1, c: 3 },
      l: [2, 3]
    })
    expect(mergeData(5, { a: 1 })).toEqual({ a: 1 })
    expect(mergeData({ a: 1 }, 'x')).toBe('x')
    const polluted = mergeData({}, JSON.parse('{"__proto__":{"x":1}}')) as Record<string, unknown>
    expect(({} as Record<string, unknown>).x).toBeUndefined()
    expect(polluted.x).toBeUndefined()
  })
})

describe('browser_patch script (AC-7)', () => {
  it('knows the five modes and which need html', () => {
    for (const m of ['inner', 'outer', 'append', 'prepend', 'remove'])
      expect(isPatchMode(m)).toBe(true)
    expect(isPatchMode('replace')).toBe(false)
    expect(patchNeedsHtml('remove')).toBe(false)
    expect(patchNeedsHtml('inner')).toBe(true)
  })

  /** Run the generated script against a minimal fake DOM. */
  function run(script: string, nodes: Array<Record<string, unknown>>, throws = false): unknown {
    const document = {
      querySelectorAll: (sel: string) => {
        if (throws) throw new Error(`bad selector ${sel}`)
        return nodes
      }
    }
    return new Function('document', `return ${script}`)(document)
  }

  it('applies each mode to every match and counts them', () => {
    const mk = () => ({
      innerHTML: '',
      outerHTML: '',
      removed: false,
      inserted: [] as string[],
      insertAdjacentHTML(where: string, html: string) {
        this.inserted.push(`${where}:${html}`)
      },
      remove() {
        this.removed = true
      }
    })
    const a = mk()
    const b = mk()
    expect(
      run(buildPatchScript({ selector: 'li', mode: 'inner', html: '<b>1</b>' }), [a, b])
    ).toEqual({ matched: 2, applied: 2 })
    expect(a.innerHTML).toBe('<b>1</b>')
    run(buildPatchScript({ selector: 'li', mode: 'outer', html: '<p>' }), [a])
    expect(a.outerHTML).toBe('<p>')
    run(buildPatchScript({ selector: 'li', mode: 'append', html: 'z' }), [a])
    run(buildPatchScript({ selector: 'li', mode: 'prepend', html: 'y' }), [a])
    expect(a.inserted).toEqual(['beforeend:z', 'afterbegin:y'])
    run(buildPatchScript({ selector: 'li', mode: 'remove' }), [b])
    expect(b.removed).toBe(true)
  })

  it('reports zero matches and a bad selector without throwing', () => {
    expect(run(buildPatchScript({ selector: '.none', mode: 'remove' }), [])).toEqual({
      matched: 0,
      applied: 0
    })
    expect(run(buildPatchScript({ selector: '[[', mode: 'remove' }), [], true)).toMatchObject({
      matched: 0,
      badSelector: expect.stringContaining('bad selector')
    })
  })

  it('takes every value as JSON: a hostile selector or html cannot break out of the script', () => {
    const script = buildPatchScript({
      selector: `"); alert(1); ("`,
      mode: 'inner',
      html: `'+process.exit()+'</script>`
    })
    let sel = ''
    new Function('document', `return ${script}`)({
      querySelectorAll: (s: string) => ((sel = s), [])
    })
    expect(sel).toBe(`"); alert(1); ("`)
  })
})
