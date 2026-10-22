/**
 * T569 (browser pane U2, AC-1, AC-2, AC-3) — the `harnu-page://` codec, the path jail and the response policy,
 * against a REAL temporary tree (symlinks included) and hostile paths (spec §4.1–§4.3, §12).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  MAX_PAGE_HTML_BYTES,
  PAGE_CSP_NETWORK,
  PAGE_CSP_OFFLINE,
  PAGE_SCHEME,
  PAGE_SCHEME_PRIVILEGES,
  buildPageUrl,
  folderIdOf,
  isDeniedPagePath,
  jailResolve,
  jailVerbPath,
  mimeFor,
  pageCsp,
  pageResponseHeaders,
  parsePageUrl,
  type JailFs,
  type PageFolder
} from '../src/main/browser/page-url'

let root: string
let outside: string
let folder: PageFolder
let id: string
const fs: JailFs = { realpath: (p) => fsp.realpath(p), stat: (p) => fsp.stat(p) }

beforeAll(() => {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'harnu-page-url-')))
  root = path.join(base, 'proj')
  outside = path.join(base, 'secret')
  mkdirSync(path.join(root, 'docs'), { recursive: true })
  mkdirSync(path.join(root, '.git'), { recursive: true })
  mkdirSync(path.join(root, 'sub', '.git'), { recursive: true })
  mkdirSync(path.join(root, '.harnu', 'memory'), { recursive: true })
  mkdirSync(path.join(root, '.harnu', 'out'), { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(path.join(root, 'index.html'), '<h1>hi</h1>')
  writeFileSync(path.join(root, 'docs', 'a b.html'), 'x')
  writeFileSync(path.join(root, '.git', 'config'), 'secret')
  writeFileSync(path.join(root, 'sub', '.git', 'HEAD'), 'ref')
  writeFileSync(path.join(root, '.harnu', 'memory', 'hot.md'), 'memory')
  writeFileSync(path.join(root, '.harnu', 'out', 'ok.json'), '{}')
  writeFileSync(path.join(outside, 'passwd'), 'root:x')
  symlinkSync(outside, path.join(root, 'escape'))
  symlinkSync(path.join(outside, 'passwd'), path.join(root, 'passwd-link'))
  symlinkSync(path.join(root, '.git'), path.join(root, 'into-git'))
  symlinkSync(path.join(root, 'index.html'), path.join(root, 'inside-link.html'))
  folder = { folder: root, realFolder: root }
  id = folderIdOf(root)
})

afterAll(() => rmSync(path.dirname(root), { recursive: true, force: true }))

const folders = (): Map<string, PageFolder> => new Map([[id, folder]])
const resolve = (rel: string, extra: Partial<Parameters<typeof jailResolve>[0]> = {}) =>
  jailResolve({
    url: `${PAGE_SCHEME}://f${id}/${rel}`,
    folders: folders(),
    isBlocked: () => false,
    fs,
    ...extra
  })

describe('page URL codec', () => {
  it('derives the folder id from the first 12 hex chars of sha256(realpath)', () => {
    expect(id).toMatch(/^[0-9a-f]{12}$/)
    expect(folderIdOf('/a')).not.toBe(folderIdOf('/b'))
  })

  it('round-trips a path with spaces and unicode', () => {
    const url = buildPageUrl(id, 'docs/a b/ü.html')
    expect(url).toBe(`harnu-page://f${id}/docs/a%20b/%C3%BC.html`)
    expect(parsePageUrl(url)).toMatchObject({ folderId: id, relPath: 'docs/a b/ü.html' })
  })

  it.each([
    ['a foreign scheme', `https://f${'0'.repeat(12)}/a.html`],
    ['a host that is not a folder host', 'harnu-page://example.com/a.html'],
    ['a short folder id', 'harnu-page://f123/a.html'],
    ['an uppercase folder id', `harnu-page://fABCDEF012345/a.html`],
    ['an encoded NUL', `harnu-page://f${'0'.repeat(12)}/a%00.html`],
    ['an encoded slash in a segment', `harnu-page://f${'0'.repeat(12)}/a%2fb`],
    ['an encoded backslash', `harnu-page://f${'0'.repeat(12)}/a%5cb`],
    ['a malformed escape', `harnu-page://f${'0'.repeat(12)}/%E0%A4%A`],
    ['not a URL', 'harnu-page:']
  ])('rejects %s', (_label, url) => {
    expect(parsePageUrl(url)).toBeNull()
  })

  it('never lets a dot segment through: the URL parser collapses literal AND encoded ones at the root', () => {
    const base = `harnu-page://f${'0'.repeat(12)}`
    expect(parsePageUrl(`${base}/a/../b.html`)?.relPath).toBe('b.html')
    for (const hostile of [
      '/%2e%2e/%2e%2e/etc/passwd',
      '/%2E%2E/etc/passwd',
      '/a/%2e%2e/%2e%2e/etc/passwd',
      '/./../etc/passwd',
      '/..%2f..%2fetc/passwd',
      '/%252e%252e/etc/passwd'
    ]) {
      const parsed = parsePageUrl(`${base}${hostile}`)
      // Either refused, or a path made only of ordinary segments: it can never climb out.
      if (parsed) {
        expect(parsed.segments).not.toContain('..')
        expect(parsed.segments).not.toContain('.')
        expect(parsed.relPath.split('/').every((seg) => seg !== '..')).toBe(true)
      }
    }
    // A double-encoded dot is an ordinary (odd) file name, not a traversal.
    expect(parsePageUrl(`${base}/%252e%252e/x`)?.segments).toEqual(['%2e%2e', 'x'])
  })

  it('denies .git anywhere and .harnu/memory at the root', () => {
    expect(isDeniedPagePath(['.git', 'config'])).toBe(true)
    expect(isDeniedPagePath(['sub', '.GIT', 'HEAD'])).toBe(true)
    expect(isDeniedPagePath(['.harnu', 'memory', 'hot.md'])).toBe(true)
    expect(isDeniedPagePath(['.harnu', 'out', 'ok.json'])).toBe(false)
    expect(isDeniedPagePath(['docs', 'memory'])).toBe(false)
  })
})

describe('the path jail (AC-2)', () => {
  it('serves a file inside the folder, including through a symlink that stays inside', async () => {
    expect(await resolve('index.html')).toMatchObject({ ok: true, relPath: 'index.html' })
    expect(await resolve('docs/a%20b.html'.replace('a%20b', 'a b'))).toMatchObject({ ok: true })
    expect(await resolve('inside-link.html')).toMatchObject({ ok: true })
    expect(await resolve('.harnu/out/ok.json')).toMatchObject({ ok: true })
  })

  it.each([
    ['a symlinked directory that escapes', 'escape/passwd', 'escape', 403],
    ['a symlinked file that escapes', 'passwd-link', 'escape', 403],
    ['.git', '.git/config', 'denied-path', 403],
    ['a nested .git', 'sub/.git/HEAD', 'denied-path', 403],
    ['a symlink INTO .git (denied on the real path)', 'into-git/config', 'denied-path', 403],
    ['.harnu/memory', '.harnu/memory/hot.md', 'denied-path', 403],
    ['a missing file', 'nope.html', 'not-found', 404],
    ['a directory', 'docs', 'directory', 404],
    ['the folder root', '', 'directory', 404]
  ])('refuses %s', async (_label, rel, reason, status) => {
    expect(await resolve(rel)).toMatchObject({ ok: false, reason, status })
  })

  it('refuses a NUL, an encoded .. and an unknown folder id', async () => {
    expect(await resolve('a%00.html')).toMatchObject({ ok: false, reason: 'bad-path', status: 400 })
    // An encoded .. collapses at the root and so cannot reach the sibling folder: it is a plain miss.
    expect(await resolve('%2e%2e/secret/passwd')).toMatchObject({ ok: false, reason: 'not-found' })
    expect(await resolve('..%2f..%2fsecret/passwd')).toMatchObject({
      ok: false,
      reason: 'bad-path'
    })
    const other = await jailResolve({
      url: `harnu-page://f${'a'.repeat(12)}/index.html`,
      folders: folders(),
      isBlocked: () => false,
      fs
    })
    expect(other).toMatchObject({ ok: false, reason: 'unknown-folder', status: 404 })
  })

  it('re-checks the folder block on EVERY request', async () => {
    let blocked = false
    const isBlocked = (): boolean => blocked
    expect(await resolve('index.html', { isBlocked })).toMatchObject({ ok: true })
    blocked = true
    expect(await resolve('index.html', { isBlocked })).toMatchObject({
      ok: false,
      reason: 'blocked',
      status: 403
    })
    blocked = false
    expect(await resolve('index.html', { isBlocked })).toMatchObject({ ok: true })
  })

  it('caps html at 8 MiB but not other assets', async () => {
    const big = (name: string, size: number) =>
      resolve(name, {
        maxHtmlBytes: 10,
        fs: {
          realpath: fs.realpath,
          stat: async () => ({ isFile: () => true, isDirectory: () => false, size })
        }
      })
    expect(MAX_PAGE_HTML_BYTES).toBe(8 * 1024 * 1024)
    expect(await big('index.html', 11)).toMatchObject({
      ok: false,
      reason: 'too-large',
      status: 413
    })
    expect(await big('.harnu/out/ok.json', 5_000_000)).toMatchObject({ ok: true })
  })

  it('treats a stat/realpath failure as not-found, never a throw', async () => {
    const broken: JailFs = {
      realpath: async () => {
        throw new Error('EIO')
      },
      stat: async () => {
        throw new Error('EIO')
      }
    }
    expect(await resolve('index.html', { fs: broken })).toMatchObject({
      ok: false,
      reason: 'not-found'
    })
  })
})

describe('the verb-side jail (browser_open({ path }))', () => {
  const verb = (rawPath: string) => jailVerbPath({ folder, rawPath, fs })
  it('accepts repo-relative and absolute paths inside the folder', async () => {
    expect(await verb('index.html')).toMatchObject({ ok: true, relPath: 'index.html' })
    expect(await verb(path.join(root, 'docs', 'a b.html'))).toMatchObject({ ok: true })
  })
  it('refuses the same hostile paths as the protocol', async () => {
    expect(await verb('../secret/passwd')).toMatchObject({ ok: false, reason: 'escape' })
    expect(await verb(path.join(outside, 'passwd'))).toMatchObject({ ok: false, reason: 'escape' })
    expect(await verb('passwd-link')).toMatchObject({ ok: false, reason: 'escape' })
    expect(await verb('.git/config')).toMatchObject({ ok: false, reason: 'denied-path' })
    expect(await verb('.harnu/memory/hot.md')).toMatchObject({ ok: false, reason: 'denied-path' })
    expect(await verb('a\0b.html')).toMatchObject({ ok: false, reason: 'bad-path' })
    expect(await verb('missing.html')).toMatchObject({ ok: false, reason: 'not-found' })
  })
})

describe('registration and response policy (AC-1, AC-3)', () => {
  it('registers standard, secure, fetch and stream, and NOT bypassCSP, service workers or CORS', () => {
    expect(PAGE_SCHEME_PRIVILEGES).toEqual({
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true
    })
    for (const forbidden of ['bypassCSP', 'allowServiceWorkers', 'corsEnabled']) {
      expect(PAGE_SCHEME_PRIVILEGES).not.toHaveProperty(forbidden)
    }
  })

  it('serves the offline policy by default and the relaxed one only when the switch is on', () => {
    expect(pageCsp(false)).toBe(PAGE_CSP_OFFLINE)
    expect(PAGE_CSP_OFFLINE).toContain("connect-src 'self'")
    expect(PAGE_CSP_OFFLINE).toContain("form-action 'none'")
    expect(PAGE_CSP_OFFLINE).toContain("frame-src 'none'")
    expect(PAGE_CSP_OFFLINE).not.toMatch(/https?:|\*/)
    expect(pageCsp(true)).toBe(PAGE_CSP_NETWORK)
  })

  it('puts the CSP, nosniff and no-store on every response', () => {
    const h = pageResponseHeaders(mimeFor('a.html'), false)
    expect(h['Content-Security-Policy']).toBe(PAGE_CSP_OFFLINE)
    expect(h['X-Content-Type-Options']).toBe('nosniff')
    expect(h['Cache-Control']).toBe('no-store')
    expect(h['Content-Type']).toBe('text/html; charset=utf-8')
  })

  it('maps extensions and defaults the rest to octet-stream', () => {
    expect(mimeFor('x.JS')).toContain('javascript')
    expect(mimeFor('x.svg')).toBe('image/svg+xml')
    expect(mimeFor('x.unknown')).toBe('application/octet-stream')
  })
})
