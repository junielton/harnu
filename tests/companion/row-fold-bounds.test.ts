import { describe, expect, it } from 'vitest'
import { redactForWire } from '../../resources/companion/hooks/lib/redact-wire'
import {
  REDACT_WINDOW,
  TEXT_MAX,
  TEXT_MAX_BYTES,
  emptyFold,
  foldAppend,
  foldTitle,
  mergeRestored,
  restoredFold,
  wireOf,
  wireText,
  type AppendedRow
} from '../../resources/companion/hooks/lib/row-fold'
import { SECRET_SAMPLES, j, rep } from './fixtures/secret-samples'

/**
 * T455 W1 round 2 (the verifiers' D1, D2, D3). Every text is synthetic; every token is built at
 * runtime (see `fixtures/secret-samples.ts`).
 *
 * D1: no output may derive from a token the redaction window cut, even when redacted material
 *     before it shrinks the text so the cut lands inside the first 240 characters.
 * D2: the fold's work is bounded: a 1 MB row of unclosed wrappers settles fast (a hook that blocks
 *     5 s is unloaded, MOD-2).
 * D3: overlapping matches are merged and the union is redacted, never the smaller one alone.
 */

const T0 = 1_790_000_000_000

/** A private-key block of exactly `n` characters (n ≥ 64), redacted to 22: the shrink. */
function pemOf(n: number): string {
  const open = j('-----BEGIN ', 'EC PRIVATE', ' KEY----- ')
  const close = j(' -----END ', 'EC PRIVATE', ' KEY-----')
  return open + 'T'.repeat(n - open.length - close.length) + close
}

/** Ten JWTs (each redacted to `[REDACTED:jwt]`) filling exactly `n` characters (n ≥ 1,000). */
function jwtsOf(n: number): string {
  const one = (len: number): string => {
    const head = j('ey', 'J', 'hbGciOiJIUzI1NiJ9', '.', 'ey', 'J')
    const sig = j('.', 'c2lnbmF0dXJl')
    return head + 'a'.repeat(len - head.length - sig.length) + sig
  }
  const each = Math.floor((n - 9) / 10)
  const last = n - 9 - each * 9
  return [...Array.from({ length: 9 }, () => one(each)), one(last)].join(' ')
}

/** About 100 characters of plain words between the shrunk head and the token. */
const FILLER = 100

/** Positions inside a match of length `m` where the window edge is tried. */
function edges(m: number): number[] {
  const out = new Set<number>()
  for (let k = 1; k <= Math.min(6, m - 1); k++) out.add(k)
  for (let k = m - 5; k < m; k++) if (k >= 1) out.add(k)
  const step = Math.max(1, Math.floor(m / 10))
  for (let k = step; k < m; k += step) out.add(k)
  return [...out].sort((a, b) => a - b)
}

/** Every 3-character run of the secret: none may reach the wire. */
const grams = (secret: string): string[] =>
  Array.from({ length: Math.max(0, secret.length - 2) }, (_, i) => secret.slice(i, i + 3))

/**
 * A shrinking head, ~FILLER plain characters, then the sample's text, so that its match starts
 * `k` characters before the window edge.
 */
function straddle(
  headOf: (n: number) => string,
  sample: (typeof SECRET_SAMPLES)[number],
  k: number
): string {
  const head = headOf(REDACT_WINDOW - k - sample.start - FILLER - 1)
  const text = `${head} ${'q'.repeat(FILLER - 1)} ${sample.text} and a few more words after it`
  // the match really starts k characters before the edge
  expect(text.indexOf(sample.text) + sample.start).toBe(REDACT_WINDOW - k)
  return text
}

function assertNoLeak(out: string | null, secret: string, where: string): void {
  if (out === null) return // withheld: nothing shipped
  for (const g of grams(secret)) expect(out.includes(g), `${where}: "${g}" leaked`).toBe(false)
}

describe('D1: a token cut by the redaction window never ships, not even a prefix', () => {
  for (const sample of SECRET_SAMPLES) {
    it(`${sample.rule}: window edge swept across the match, after an ~8 KB shrink`, () => {
      let tried = 0
      for (const k of edges(sample.end - sample.start)) {
        const text = straddle(pemOf, sample, k)
        tried++
        const out = wireText(text)
        assertNoLeak(out, sample.secret, `${sample.rule} k=${k}`)
        if (out !== null) expect(out.startsWith('[REDACTED:private-key]')).toBe(true)
      }
      expect(tried).toBeGreaterThan(3)
    })
  }

  it('many JWTs before the edge shrink the text the same way', () => {
    for (const rule of [
      'github-token',
      'url-credentials',
      'jwt',
      'auth-header',
      'aws-access-key-id'
    ]) {
      const sample = SECRET_SAMPLES.find((s) => s.rule === rule)!
      for (const k of edges(sample.end - sample.start)) {
        const text = straddle(jwtsOf, sample, k)
        assertNoLeak(wireText(text), sample.secret, `${rule} after JWTs k=${k}`)
      }
    }
  })

  it('the whole fold: a typed prompt with the shrink and a cut token', () => {
    const sample = SECRET_SAMPLES.find((s) => s.rule === 'github-token')!
    for (const k of edges(sample.end - sample.start)) {
      const text = straddle(pemOf, sample, k)
      const f = emptyFold()
      foldAppend(
        f,
        {
          door: 'prompt',
          origin: { kind: 'composer' },
          uuid: 'u-a',
          message: { type: 'user', role: 'user', content: [{ type: 'text', text }] }
        },
        T0
      )
      assertNoLeak(f.row.lastPrompt ?? null, sample.secret, `lastPrompt k=${k}`)
      assertNoLeak(f.row.firstPrompt ?? null, sample.secret, `firstPrompt k=${k}`)
    }
  })

  it('a token wholly inside the window after the shrink is redacted, and the text kept', () => {
    const sample = SECRET_SAMPLES.find((s) => s.rule === 'github-token')!
    const out = wireText(`${pemOf(7_900)} ${sample.text} and more`)
    expect(out).toContain('[REDACTED:github-token]')
    expect(out).toContain('push with')
  })
})

describe('D2: the fold is bounded on adversarial rows', () => {
  const MB = 1 << 20
  const fill = (unit: string): string => unit.repeat(Math.ceil(MB / unit.length))
  const row = (door: string, text: string): AppendedRow => ({
    door,
    origin: { kind: 'composer' },
    uuid: 'u-big',
    message: { type: 'user', role: 'user', content: [{ type: 'text', text }] }
  })
  const cases: [string, AppendedRow][] = [
    ['unclosed <command-name> (command door)', row('command', fill('<command-name>'))],
    ['unclosed <command-name> (prompt door)', row('prompt', fill('<command-name>'))],
    [
      'unclosed <command-args>',
      row('command', `<command-name>/x</command-name>${fill('<command-args>')}`)
    ],
    ['unclosed <pasted_content', row('prompt', fill('<pasted_content'))],
    ['unclosed <system-reminder>', row('note', fill('<system-reminder>'))],
    ['unclosed <local-command-stdout>', row('note', fill('<local-command-stdout>'))],
    ['a 1 MB run the secret-assignment name scans', row('prompt', fill('aB3_'))],
    ['many private-key openings', row('prompt', fill('-----BEGIN A PRIVATE KEY----- '))]
  ]
  for (const [name, r] of cases) {
    it(`${name}: one append settles in well under a second`, { timeout: 120_000 }, () => {
      const t = performance.now()
      foldAppend(emptyFold(), r, T0)
      expect(performance.now() - t).toBeLessThan(500)
    })
  }

  it('the redaction pass itself is bounded on its window', () => {
    for (const unit of [
      'aB3_',
      '-----BEGIN A PRIVATE KEY----- ',
      'postgres://u:',
      'Authorization: Bearer ',
      'eyJabcdefgh.'
    ]) {
      const t = performance.now()
      wireText(unit.repeat(Math.ceil(REDACT_WINDOW / unit.length)))
      expect(performance.now() - t, unit).toBeLessThan(200)
    }
  })
})

describe('D3: overlapping matches are merged, the union redacted', () => {
  it('a provider token inside an assigned value redacts the whole value', () => {
    const oai = j('sk', '-proj-', rep('Qw3r', 6))
    const out = redactForWire(`PASSWORD=Hunter2x-${oai}`)
    expect(out).toBe('PASSWORD=[REDACTED:openai-key]')
  })

  it('a provider token inside a URL password redacts the whole password', () => {
    const gh = j('gh', 'p_', rep('a1B2', 9))
    const out = redactForWire(`postgres://u:ab9.${gh}.cd9@host.example.test/db`)
    expect(out).toBe('postgres://u:[REDACTED:github-token]@host.example.test/db')
  })

  it('a chain of overlaps merges into one span, under the first rule that matched', () => {
    const gh = j('gh', 'p_', rep('a1B2', 9))
    const oai = j('sk', '-proj-', rep('Qw3r', 6))
    expect(redactForWire(`PASSWORD=${gh}.${oai} and nothing else`)).toBe(
      'PASSWORD=[REDACTED:github-token] and nothing else'
    )
  })
})

describe('D6: the payload stays ~1.5 KB whatever the script', () => {
  const jsonBytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v), 'utf8')

  for (const [name, unit] of [
    ['CJK', '漢'],
    ['emoji', '😀'],
    ['quotes', '"'],
    ['backslashes', '\\'],
    ['accents', 'é']
  ] as const) {
    it(`${name} at the cap: at most ${TEXT_MAX_BYTES} bytes and ${TEXT_MAX} units, cut with …`, () => {
      const out = wireText(unit.repeat(500))!
      expect(jsonBytes(out) - 2).toBeLessThanOrEqual(TEXT_MAX_BYTES)
      expect(out.length).toBeLessThanOrEqual(TEXT_MAX)
      expect(out.endsWith('…')).toBe(true)
      expect(out).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/) // no half of a pair
    })
  }

  it('control characters that are not whitespace are stripped, before redaction', () => {
    expect(wireText('a\u0001b\u007fc\u0085d')).toBe('abcd')
    const gh = j('gh', 'p_', rep('a1B2', 9))
    // a control inside a token cannot hide it from the rules
    expect(wireText(`${gh.slice(0, 10)}\u0007${gh.slice(10)}`)).toBe('[REDACTED:github-token]')
  })

  it('a lone surrogate becomes U+FFFD', () => {
    expect(wireText('a\ud800b')).toBe('a\ufffdb')
  })

  it('the worst-case row is at most 1,536 bytes of JSON', () => {
    const f = emptyFold()
    const worst = (c: string): string => wireText(c.repeat(1_000))!
    f.row.firstPrompt = worst('漢')
    f.row.lastPrompt = worst('"')
    f.row.lastAssistant = worst('😀')
    f.row.title = worst('é')
    f.row.toolCalls = Number.MAX_SAFE_INTEGER
    f.row.subagentToolCalls = Number.MAX_SAFE_INTEGER
    f.row.userRows = Number.MAX_SAFE_INTEGER
    f.row.lastRowAt = Number.MAX_SAFE_INTEGER
    f.row.lastUuid = 'u'.repeat(64)
    expect(jsonBytes(wireOf(f.row))).toBeLessThanOrEqual(1_536)
  })

  it('a title is capped the same way', () => {
    const f = emptyFold()
    foldTitle(f, '漢'.repeat(500))
    expect(jsonBytes(f.row.title) - 2).toBeLessThanOrEqual(TEXT_MAX_BYTES)
  })
})

describe('D6: uuids', () => {
  const typed = (uuid: string): AppendedRow => ({
    door: 'prompt',
    origin: { kind: 'composer' },
    uuid,
    message: { type: 'user', role: 'user', content: [{ type: 'text', text: 'hello' }] }
  })

  it('a row whose uuid was folded already is not counted again', () => {
    const f = emptyFold()
    expect(foldAppend(f, typed('u-1'), T0)).toBe(true)
    expect(foldAppend(f, typed('u-1'), T0 + 1)).toBe(false)
    expect(f.row.userRows).toBe(1)
    foldAppend(f, typed('u-2'), T0 + 2)
    expect(f.row.userRows).toBe(2)
  })

  it('a uuid over 64 characters is not taken as lastUuid', () => {
    const f = emptyFold()
    foldAppend(f, typed('u-1'), T0)
    foldAppend(f, typed('x'.repeat(65)), T0 + 1)
    expect(f.row.lastUuid).toBe('u-1')
  })
})

describe('D6: rows folded after a reload and before its session.start', () => {
  it('add to the restored counts; texts seen stay, the first prompt stays unknown', () => {
    const f = emptyFold()
    foldAppend(
      f,
      {
        door: 'prompt',
        origin: { kind: 'composer' },
        uuid: 'u-new',
        message: { type: 'user', role: 'user', content: [{ type: 'text', text: 'after reload' }] }
      },
      T0 + 9
    )
    const m = mergeRestored(
      { toolCalls: 3, subagentToolCalls: 1, userRows: 5, lastRowAt: T0, lastUuid: 'u-old' },
      f
    )
    expect(wireOf(m.row)).toEqual({
      fold: 1,
      lastPrompt: 'after reload',
      toolCalls: 3,
      subagentToolCalls: 1,
      userRows: 6,
      lastRowAt: T0 + 9,
      lastUuid: 'u-new'
    })
    expect(restoredFold(m.row as never).firstTaken).toBe(true)
  })
})
