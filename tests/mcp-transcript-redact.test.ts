import { describe, it, expect } from 'vitest'
import { redactTranscript } from '../src/main/mcp/transcript-redact'

/**
 * T8 — pure best-effort scrubber for the Harnu MCP `get_session` tool. It rewrites
 * absolute home paths to a `~` alias and redacts common secret shapes (AWS AKIA
 * access keys, Bearer/Authorization tokens, sensitive KEY=VALUE env dumps, PEM
 * PRIVATE KEY blocks) to a literal `<redacted>` marker. Two load-bearing
 * invariants: it is BEST-EFFORT (heuristic, never claims completeness) and it is
 * IDEMPOTENT — a second pass over already-scrubbed text changes nothing and
 * reports zero further redactions, so re-scrubbing is always safe.
 */

const HOME = '/home/u'

describe('redactTranscript — home path aliasing', () => {
  it('rewrites an absolute home path to the ~ alias', () => {
    const r = redactTranscript('cwd: /home/u/Workspace/harnu/src', { home: HOME })
    expect(r.text).toBe('cwd: ~/Workspace/harnu/src')
    expect(r.redactionCount).toBe(1)
  })

  it('aliases every occurrence and counts each one', () => {
    const r = redactTranscript('/home/u/a then /home/u/b', { home: HOME })
    expect(r.text).toBe('~/a then ~/b')
    expect(r.redactionCount).toBe(2)
  })

  it('leaves other users home paths untouched', () => {
    const r = redactTranscript('/home/someoneelse/secret-dir', { home: HOME })
    expect(r.text).toBe('/home/someoneelse/secret-dir')
    expect(r.redactionCount).toBe(0)
  })

  it('never nukes every absolute path when home is "/" or empty', () => {
    expect(redactTranscript('/usr/bin/node', { home: '/' }).text).toBe('/usr/bin/node')
    expect(redactTranscript('/usr/bin/node', { home: '' }).text).toBe('/usr/bin/node')
    expect(redactTranscript('/usr/bin/node', { home: '/' }).redactionCount).toBe(0)
  })
})

describe('redactTranscript — AWS access keys', () => {
  it('redacts an AKIA access key id to <redacted>', () => {
    const r = redactTranscript('aws_access_key_id = AKIAIOSFODNN7EXAMPLE here', { home: HOME })
    // matched both as an AWS key shape AND as a sensitive KEY=VALUE -> one marker
    expect(r.text).toBe('aws_access_key_id = <redacted> here')
    expect(r.text).not.toContain('AKIAIOSFODNN7EXAMPLE')
  })

  it('redacts a bare AKIA key embedded in prose', () => {
    const r = redactTranscript('the key is AKIAIOSFODNN7EXAMPLE today', { home: HOME })
    expect(r.text).toBe('the key is <redacted> today')
    expect(r.redactionCount).toBe(1)
  })
})

describe('redactTranscript — bearer / authorization tokens', () => {
  it('redacts a bare Bearer token but keeps the scheme keyword', () => {
    const r = redactTranscript('header => Bearer ey.J0.eXAMPLE-tok_en~123/abc==', { home: HOME })
    expect(r.text).toBe('header => Bearer <redacted>')
    expect(r.redactionCount).toBe(1)
  })

  it('redacts the whole value of an Authorization header', () => {
    const r = redactTranscript('Authorization: Bearer ey.J0.eXAMPLEtoken', { home: HOME })
    expect(r.text).toBe('Authorization: <redacted>')
    expect(r.redactionCount).toBe(1)
  })

  it('redacts a non-Bearer Authorization scheme (Basic) too', () => {
    const r = redactTranscript('Authorization: Basic dXNlcjpwYXNz', { home: HOME })
    expect(r.text).toBe('Authorization: <redacted>')
  })
})

describe('redactTranscript — sensitive KEY=VALUE env dumps', () => {
  it('redacts the value of well-known secret keys, keeping the key name', () => {
    const input = [
      'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      'GITHUB_TOKEN=ghp_AbCdEf0123456789',
      'DB_PASSWORD=hunter2',
      'OPENAI_API_KEY=sk-proj-abcdef'
    ].join('\n')
    const r = redactTranscript(input, { home: HOME })
    expect(r.text).toBe(
      [
        'AWS_SECRET_ACCESS_KEY=<redacted>',
        'GITHUB_TOKEN=<redacted>',
        'DB_PASSWORD=<redacted>',
        'OPENAI_API_KEY=<redacted>'
      ].join('\n')
    )
    expect(r.redactionCount).toBe(4)
  })

  it('leaves non-sensitive env vars alone', () => {
    const input = 'NODE_ENV=production\nPATH=/usr/bin:/bin\nPWD=/var/log'
    const r = redactTranscript(input, { home: HOME })
    expect(r.text).toBe(input)
    expect(r.redactionCount).toBe(0)
  })
})

describe('redactTranscript — PEM private key blocks', () => {
  it('redacts a whole BEGIN/END PRIVATE KEY block to a single marker', () => {
    const input =
      'before\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0Zg\nq3vH+abc/def==\n-----END RSA PRIVATE KEY-----\nafter'
    const r = redactTranscript(input, { home: HOME })
    expect(r.text).toBe('before\n<redacted>\nafter')
    expect(r.text).not.toContain('PRIVATE KEY')
    expect(r.redactionCount).toBe(1)
  })
})

describe('redactTranscript — idempotency (re-scrubbing is safe)', () => {
  it('running twice produces the same text and zero further redactions', () => {
    const input = [
      'cwd /home/u/repo',
      'AKIAIOSFODNN7EXAMPLE',
      'Bearer abc.def.ghi',
      'Authorization: Bearer xxx.yyy',
      'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/bPxRfiCYEXAMPLEKEY',
      '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaA\n-----END OPENSSH PRIVATE KEY-----'
    ].join('\n')

    const first = redactTranscript(input, { home: HOME })
    expect(first.redactionCount).toBeGreaterThan(0)

    const second = redactTranscript(first.text, { home: HOME })
    expect(second.text).toBe(first.text)
    expect(second.redactionCount).toBe(0)
  })
})

describe('redactTranscript — shape + best-effort contract', () => {
  it('returns the {text, redactionCount} shape', () => {
    const r = redactTranscript('nothing here', { home: HOME })
    expect(r).toEqual({ text: 'nothing here', redactionCount: 0 })
  })

  it('handles empty input', () => {
    expect(redactTranscript('', { home: HOME })).toEqual({ text: '', redactionCount: 0 })
  })

  it('is best-effort: an unrecognized high-entropy string is left as-is', () => {
    // No recognizable key name, scheme, or shape -> heuristics do not fire.
    const r = redactTranscript('just some normal prose 9f8a7b6c5d', { home: HOME })
    expect(r.text).toBe('just some normal prose 9f8a7b6c5d')
    expect(r.redactionCount).toBe(0)
  })
})

describe('the T215 peer-socket path (§3.7 — inside the redaction contract)', () => {
  it('leaves the common Linux runtime socket alone', () => {
    const r = redactTranscript('/run/user/1000/cc-socks/758734.sock', { home: '/home/u' })
    expect(r.text).toBe('/run/user/1000/cc-socks/758734.sock')
    expect(r.redactionCount).toBe(0)
  })

  it('aliases a home-rooted socket (the macOS / CLAUDE_CODE_TMPDIR shape)', () => {
    const r = redactTranscript('/home/u/.cache/t/cc-socks/42.sock', {
      home: '/home/u'
    })
    expect(r.text).toBe('~/.cache/t/cc-socks/42.sock')
    expect(r.text).not.toContain('junielton')
  })

  it('is idempotent over a socket path, so re-scrubbing a cached address is safe', () => {
    const once = redactTranscript('/home/u/t/cc-socks/1.sock', { home: '/home/u' })
    const twice = redactTranscript(once.text, { home: '/home/u' })
    expect(twice.text).toBe(once.text)
    expect(twice.redactionCount).toBe(0)
  })
})
