/**
 * Runtime-built secret samples for the T455 wire redaction tests, one per deterministic rule of
 * T450's table. Every token is BUILT AT RUNTIME from broken-up pieces, so no committed line looks
 * like a credential to a scanner (T450 01-detection.md §2 writes its formats the same way). None
 * is real.
 */

export const j = (...parts: string[]): string => parts.join('')
export const rep = (s: string, n: number): string => s.repeat(n)

export interface SecretSample {
  rule: string
  /** A short sentence carrying the secret. */
  text: string
  /** The part that must never reach the wire. */
  secret: string
  /** Where the rule's own match starts in `text` (a context rule starts at its name or scheme). */
  start: number
  /** Where the rule's match ends in `text`. */
  end: number
}

/** One sample per rule, in the rules' order. */
export const SECRET_SAMPLES: SecretSample[] = (() => {
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
  const s = (rule: string, text: string, secret: string, match = secret): SecretSample => {
    const start = text.indexOf(match)
    return { rule, text, secret, start, end: start + match.length }
  }
  return [
    s('private-key', `here is the key ${pem} keep it`, rep('QUJD', 16), pem),
    s('aws-access-key-id', `the id is ${aws} for staging`, aws),
    s('github-token', `push with ${gh} now`, gh),
    s('github-pat', `token ${ghPat} expired`, ghPat),
    s('gitlab-token', `use ${gl} for the mirror`, gl),
    s('slack-token', `bot ${slack} posts`, slack),
    s('slack-webhook', `post to ${hook} today`, hook),
    s('stripe-secret-key', `charge with ${stripe}`, stripe),
    s('anthropic-key', `the key ${ant} works`, ant),
    s('openai-key', `the key ${oai} works`, oai),
    s('google-api-key', `maps key ${goog} here`, goog),
    s('npm-token', `publish with ${npm}`, npm),
    s('sendgrid-key', `mail key ${sg} set`, sg),
    s('jwt', `the session ${jwt} expired`, jwt),
    s(
      'url-credentials',
      `connect to postgres://app:${pw}@db.example.test/main`,
      pw,
      `postgres://app:${pw}@db.example.test/main`
    ),
    s(
      'auth-header',
      `curl -H "Authorization: Bearer ${bearer}" the api`,
      bearer,
      `Authorization: Bearer ${bearer}`
    ),
    s(
      'secret-assignment',
      `set API_TOKEN=${assigned} in the env`,
      assigned,
      `API_TOKEN=${assigned}`
    )
  ]
})()
