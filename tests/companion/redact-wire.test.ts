import { describe, expect, it } from 'vitest'
import { redactField, redactForWire } from '../../resources/companion/hooks/lib/redact-wire'
import { SECRET_RULES } from '../../resources/companion/hooks/lib/secret-rules.gen'

/**
 * T455 W1 AC-2: `redactForWire`, the deterministic rules of T450's table (spec §5.5 rule 2).
 *
 * Every token below is BUILT AT RUNTIME from broken-up pieces, so no committed line looks like a
 * credential to a scanner (T450 01-detection.md §2 writes its formats the same way). None is real.
 */

const j = (...parts: string[]): string => parts.join('')
const rep = (s: string, n: number): string => s.repeat(n)

/** One positive per rule: the text, and the part of it that must be gone. */
const POSITIVES: { rule: string; text: string; secret: string }[] = (() => {
  const pem = j(
    '-----BEGIN ',
    'RSA PRIVATE',
    ' KEY-----\n',
    rep('QUJD', 16),
    '\n-----END ',
    'RSA PRIVATE',
    ' KEY-----'
  )
  const aws = j('AK', 'IA', rep('Q7', 8))
  const gh = j('gh', 'p_', rep('a1B2', 9))
  const ghPat = j('github', '_pat_', rep('X9_y', 6))
  const gl = j('gl', 'pat-', rep('k3-L', 6))
  const slack = j('xo', 'xb-', rep('1234-abcd', 2))
  const hook = j('https://hooks.', 'slack.com/services/', 'T0000/B0000/', rep('zZ9', 8))
  const stripe = j('sk', '_live_', rep('4eC3', 6))
  const ant = j('sk', '-ant-', 'api03-', rep('Ab_9', 6))
  const oai = j('sk', '-proj-', rep('Qw3r', 6))
  const goog = j('AI', 'za', rep('Sy0_', 8), 'abc')
  const npm = j('np', 'm_', rep('n0Pq', 9))
  const sg = j('SG', '.', rep('a', 22), '.', rep('b', 43))
  const jwt = j(
    'ey',
    'J',
    rep('hbGci', 2),
    '.',
    'ey',
    'J',
    rep('zdWIi', 2),
    '.',
    rep('c2lnbmF0', 2)
  )
  const pw = j('s3cr', 'etPw9')
  const bearer = j('tok', rep('9Zx', 4))
  const assigned = j('v4lu', 'e9xyz12')
  return [
    { rule: 'private-key', text: `here is the key ${pem} keep it`, secret: rep('QUJD', 16) },
    { rule: 'aws-access-key-id', text: `the id is ${aws} for staging`, secret: aws },
    { rule: 'github-token', text: `push with ${gh} now`, secret: gh },
    { rule: 'github-pat', text: `token ${ghPat} expired`, secret: ghPat },
    { rule: 'gitlab-token', text: `use ${gl} for the mirror`, secret: gl },
    { rule: 'slack-token', text: `bot ${slack} posts`, secret: slack },
    { rule: 'slack-webhook', text: `post to ${hook} today`, secret: hook },
    { rule: 'stripe-secret-key', text: `charge with ${stripe}`, secret: stripe },
    { rule: 'anthropic-key', text: `the key ${ant} works`, secret: ant },
    { rule: 'openai-key', text: `the key ${oai} works`, secret: oai },
    { rule: 'google-api-key', text: `maps key ${goog} here`, secret: goog },
    { rule: 'npm-token', text: `publish with ${npm}`, secret: npm },
    { rule: 'sendgrid-key', text: `mail key ${sg} set`, secret: sg },
    { rule: 'jwt', text: `the session ${jwt} expired`, secret: jwt },
    {
      rule: 'url-credentials',
      text: `connect to postgres://app:${pw}@db.example.test/main`,
      secret: pw
    },
    {
      rule: 'auth-header',
      text: `curl -H "Authorization: Bearer ${bearer}" the api`,
      secret: bearer
    },
    { rule: 'secret-assignment', text: `set API_TOKEN=${assigned} in the env`, secret: assigned }
  ]
})()

describe('redactForWire: the rules', () => {
  it('ships exactly the 17 deterministic rules of T450 §2, no entropy rule', () => {
    expect(SECRET_RULES.map((r) => r.id)).toEqual(POSITIVES.map((p) => p.rule))
    expect(SECRET_RULES.some((r) => r.id === 'high-entropy')).toBe(false)
  })

  for (const p of POSITIVES) {
    it(`redacts ${p.rule} with [REDACTED:${p.rule}]`, () => {
      const out = redactForWire(p.text)
      expect(out).not.toContain(p.secret)
      expect(out).toContain(`[REDACTED:${p.rule}]`)
    })
  }

  it('contextual rules keep the name, the scheme, the user and the host readable', () => {
    const pw = j('s3cr', 'etPw9')
    expect(redactForWire(`postgres://app:${pw}@db.example.test/main`)).toBe(
      'postgres://app:[REDACTED:url-credentials]@db.example.test/main'
    )
    expect(redactForWire(j('API_TOKEN=', 'v4lu', 'e9xyz12'))).toBe(
      'API_TOKEN=[REDACTED:secret-assignment]'
    )
  })

  it('the most specific rule wins an overlap', () => {
    const gh = j('gh', 'p_', rep('a1B2', 9))
    expect(redactForWire(`GITHUB_TOKEN=${gh}`)).toBe('GITHUB_TOKEN=[REDACTED:github-token]')
  })

  it('a placeholder value is not a secret', () => {
    for (const v of ['${API_TOKEN}', '<your-token>', 'changeme', '********'])
      expect(redactForWire(`API_TOKEN=${v}`)).toBe(`API_TOKEN=${v}`)
  })

  it('redacting twice changes nothing more', () => {
    for (const p of POSITIVES) {
      const once = redactForWire(p.text)
      expect(redactForWire(once)).toBe(once)
    }
  })
})

describe('redactForWire: ordinary prompts pass unchanged (no entropy guessing)', () => {
  const NEGATIVES = [
    'fix the flaky test in the session table',
    'rename inputTokens to promptTokens in the usage sensor',
    'the author field is empty for "author": "someone"',
    'run npm test and tell me what failed',
    'commit 4f9c2a1b3d5e6f708192a3b4c5d6e7f8091a2b3c on the branch feat/t455-w1-mod-half',
    'session 11111111-1111-4111-8111-111111111111 is stuck',
    'a long camel identifier ThisIsAVeryLongCamelCaseIdentifierName',
    'the password field must reject short inputs',
    'set the token = randomUUID() call aside',
    'TOKEN_TTL_MS: 30000 is enough',
    'look at sk-learn docs and the pk_test_ publishable key notes',
    'write the integrity sha512-ZmFrZWZha2VmYWtlZmFrZWZha2VmYWtlZmFrZWZha2Vm hash',
    'compare https://example.test/a/b/c and https://user@example.test/path',
    'Authorization: Bearer ${TOKEN}',
    '/hello world',
    ''
  ]
  for (const text of NEGATIVES) {
    it(`leaves "${text.slice(0, 40)}" alone`, () => {
      expect(redactForWire(text)).toBe(text)
    })
  }
})

describe('redactField: fail closed only when the pass throws', () => {
  it('returns the redacted text', () => {
    expect(redactField('nothing secret here')).toBe('nothing secret here')
  })

  it('returns null when the pass itself throws, never the raw text', () => {
    expect(
      redactField('raw text', () => {
        throw new Error('broken rule')
      })
    ).toBeNull()
  })
})
