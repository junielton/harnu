/* eslint-disable */
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { createFetch } from '../src/index.ts'

const ENDPOINT = 'https://example.invalid/resource'
const JSON_TYPE = { 'content-type': 'application/json' }

// A fresh Response per call, so a retry can never see a consumed body.
function stub(body: BodyInit | null, init: ResponseInit = {}) {
  const fetchMock = vi.fn(async () => new Response(body, init))
  return createFetch({
    fetch: fetchMock as unknown as typeof globalThis.fetch
  })
}

const json = (body: string) => stub(body, { headers: JSON_TYPE })

describe('destr is gone', () => {
  const rootUrl = new URL('../', import.meta.url)

  it('package.json declares no runtime dependency on destr', () => {
    const pkg = JSON.parse(readFileSync(new URL('package.json', rootUrl), 'utf8'))
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
      expect(pkg[field]?.destr).toBeUndefined()
    }
  })

  it('no module under src imports destr', () => {
    const srcDir = fileURLToPath(new URL('src/', rootUrl))
    const importsDestr = /(?:from\s*|import\s*\(?\s*|require\s*\(\s*)["']destr(?:\/[^"']*)?["']/
    const offenders = (readdirSync(srcDir, { recursive: true }) as string[])
      .filter((file) => file.endsWith('.ts'))
      .filter((file) => importsDestr.test(readFileSync(join(srcDir, file), 'utf8')))
    expect(offenders).toEqual([])
  })
})

describe('valid JSON is parsed', () => {
  it.each([
    ['application/json'],
    ['application/json; charset=utf-8'],
    ['application/problem+json'],
    ['application/vnd.api+json'],
    ['application/ld+json']
  ])('parses an object served as %s', async (contentType) => {
    const $f = stub('{"a":1}', { headers: { 'content-type': contentType } })
    expect(await $f(ENDPOINT)).toEqual({ a: 1 })
  })

  it.each([
    ['an object', '{"a":{"b":[1,2,3]}}'],
    ['an array', '[1,"two",null]'],
    ['a string with escapes', String.raw`"a\"b\nc"`],
    ['an integer', '42'],
    ['a float', '-1.5e3'],
    ['true', 'true'],
    ['false', 'false'],
    ['null', 'null'],
    ['surrounding whitespace', '  {"a":1}\n']
  ])('returns the JSON.parse result for %s', async (_label, body) => {
    expect(await json(body)(ENDPOINT)).toEqual(JSON.parse(body))
  })
})

describe('malformed JSON rejects', () => {
  it.each([
    ['plain words', 'not json'],
    ['a trailing comma', '{"a":1,}'],
    ['unquoted keys', '{a:1}'],
    ['a truncated array', '[1,2'],
    ['single quotes', "'single'"],
    ['an unescaped inner quote', '"a"b"'],
    ['upper-case TRUE', 'TRUE'],
    ['capitalised True', 'True'],
    ['upper-case NULL', 'NULL'],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['-Infinity', '-Infinity'],
    ['undefined', 'undefined']
  ])('rejects %s under application/json', async (_label, body) => {
    await expect(json(body)(ENDPOINT)).rejects.toThrow()
  })

  it.each([
    ['application/json; charset=utf-8'],
    ['application/problem+json'],
    ['application/vnd.api+json'],
    ['application/ld+json']
  ])('rejects a malformed body served as %s', async (contentType) => {
    const $f = stub('{oops', { headers: { 'content-type': contentType } })
    await expect($f(ENDPOINT)).rejects.toThrow()
  })
})

describe('native parser semantics', () => {
  it('keeps a __proto__ key as an own property', async () => {
    const res = await json('{"__proto__":{"polluted":true},"a":1}')(ENDPOINT)
    expect(Object.keys(res)).toEqual(['__proto__', 'a'])
    expect(Object.getOwnPropertyDescriptor(res, '__proto__')?.value).toEqual({
      polluted: true
    })
  })

  it('keeps a constructor.prototype key as an own property', async () => {
    const res = await json('{"constructor":{"prototype":{"x":1}}}')(ENDPOINT)
    expect(Object.keys(res)).toEqual(['constructor'])
    expect(res.constructor).toEqual({ prototype: { x: 1 } })
  })

  it('does not modify Object.prototype', async () => {
    await json('{"__proto__":{"polluted":true}}')(ENDPOINT)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it.each([
    ['an integer longer than 16 digits', '12345678901234567890'],
    ['a fraction longer than 17 digits', '1.123456789012345678901']
  ])('returns a number for %s', async (_label, body) => {
    const res = await json(body)(ENDPOINT)
    expect(typeof res).toBe('number')
    expect(res).toBe(JSON.parse(body))
  })
})

describe('non-JSON content types are unchanged', () => {
  it.each([
    ['text/plain', '{"looks":"like json"}'],
    ['text/plain', '{oops'],
    ['text/html', '<p>TRUE</p>']
  ])('returns %s as text: %s', async (contentType, body) => {
    const $f = stub(body, { headers: { 'content-type': contentType } })
    expect(await $f(ENDPOINT)).toBe(body)
  })

  it('returns a Blob for application/octet-stream', async () => {
    const $f = stub(new Uint8Array([1, 2, 3]), {
      headers: { 'content-type': 'application/octet-stream' }
    })
    expect(await $f(ENDPOINT)).toBeInstanceOf(Blob)
  })

  it('returns a stream for text/event-stream', async () => {
    const $f = stub('data: 1\n\n', {
      headers: { 'content-type': 'text/event-stream' }
    })
    expect(await $f(ENDPOINT)).toBeInstanceOf(ReadableStream)
  })
})

describe('caller overrides', () => {
  it('responseType text returns a malformed JSON-typed body as is', async () => {
    expect(await json('{oops')(ENDPOINT, { responseType: 'text' })).toBe('{oops')
  })

  it('responseType blob does not parse a malformed JSON-typed body', async () => {
    expect(await json('{oops')(ENDPOINT, { responseType: 'blob' })).toBeInstanceOf(Blob)
  })

  it('responseType arrayBuffer does not parse a malformed JSON-typed body', async () => {
    expect(await json('{oops')(ENDPOINT, { responseType: 'arrayBuffer' })).toBeInstanceOf(
      ArrayBuffer
    )
  })

  it('responseType stream does not parse a malformed JSON-typed body', async () => {
    expect(await json('{oops')(ENDPOINT, { responseType: 'stream' })).toBeInstanceOf(ReadableStream)
  })

  it('responseType json parses a valid body served as text/plain', async () => {
    const $f = stub('{"a":1}', { headers: { 'content-type': 'text/plain' } })
    expect(await $f(ENDPOINT, { responseType: 'json' })).toEqual({ a: 1 })
  })

  it('parseResponse is called once with the raw text and wins', async () => {
    const parseResponse = vi.fn((text: string) => `parsed:${text}`)
    const res = await json('{"a":1}')(ENDPOINT, { parseResponse })
    expect(res).toBe('parsed:{"a":1}')
    expect(parseResponse).toHaveBeenCalledOnce()
    expect(parseResponse).toHaveBeenCalledWith('{"a":1}')
  })

  it('parseResponse handles a malformed body without a rejection', async () => {
    const res = await json('{oops')(ENDPOINT, {
      parseResponse: (text: string) => text.length
    })
    expect(res).toBe(5)
  })
})

describe('error responses', () => {
  const badRequest = (body: string) => stub(body, { status: 400, headers: JSON_TYPE })

  it('exposes a parsed JSON body on the error', async () => {
    const error = await badRequest('{"reason":"bad"}')(ENDPOINT, {
      retry: false
    }).catch((error_: any) => error_)
    expect(error.data).toEqual({ reason: 'bad' })
    expect(error.response._data).toEqual({ reason: 'bad' })
  })

  it('returns the parsed body with ignoreResponseError', async () => {
    const res = await badRequest('{"reason":"bad"}')(ENDPOINT, {
      ignoreResponseError: true
    })
    expect(res).toEqual({ reason: 'bad' })
  })

  it('rejects on a malformed JSON-typed error body', async () => {
    await expect(badRequest('{oops')(ENDPOINT, { retry: false })).rejects.toThrow()
  })
})

describe('responses without a body', () => {
  it.each([[204], [205], [304]])('does not parse status %i', async (status) => {
    const $f = stub(null, { status, headers: JSON_TYPE })
    expect(await $f(ENDPOINT)).toBeUndefined()
  })

  it('does not parse a HEAD response', async () => {
    expect(await json('{oops')(ENDPOINT, { method: 'HEAD' })).toBeUndefined()
  })
})

describe('raw response and hooks', () => {
  it('$fetch.raw exposes the parsed value on _data', async () => {
    const res = await json('{"a":1}').raw(ENDPOINT)
    expect(res._data).toEqual({ a: 1 })
  })

  it('onResponse sees the parsed value on response._data', async () => {
    let seen: unknown
    await json('{"a":1}')(ENDPOINT, {
      onResponse({ response }) {
        seen = response._data
      }
    })
    expect(seen).toEqual({ a: 1 })
  })
})
