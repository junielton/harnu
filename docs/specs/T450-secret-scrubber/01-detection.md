# T450 — Detection: rules, false positives, allowlist, measurements (U-1)

Part of [`00-spec.md`](00-spec.md). The rule source is `hooks/detect.ts` in
[`02-prototype.md`](02-prototype.md) §2.3. The test matrix and its real output are in
[`03-tests.md`](03-tests.md).

## 1. How a text is scanned

`detect(text, options)` returns `{ start, end, rule }` spans. It is a pure function: no `$`, no
engine, so the same file runs under `claude plugin test` and under Node for the measurements.

0. **The vault's literals first** (in the hooks module, `scrubText`). Every value this session already
   redacted is replaced by its placeholder wherever it appears again, before any rule runs. A
   contextual rule only sees a value in its context (`postgres://app:<pw>@`). Echoed bare (`the
password is <pw>`) it would pass; the literal match catches it.
1. **Rules in order, most specific first.** Each rule is a global regex with match indices (the `d`
   flag). A span that overlaps one an earlier rule already took is skipped. So a GitHub token inside
   `GITHUB_TOKEN=…` is reported as `github-token`, not `secret-assignment`.
2. **Capture groups narrow the span.** For `url-credentials`, `auth-header` and `secret-assignment`,
   only the value is redacted. The name, the scheme, the user and the host stay readable.
3. **High-entropy last.** Only text no rule took is a candidate. It must pass the shape filters (§3)
   before its entropy is measured.
4. The hooks module then turns each span into `[REDACTED:<rule>#<tag>]`
   ([`00-spec.md`](00-spec.md) §6.1). It drops a span whose rule the repo turned off, or whose value's
   SHA256 the repo allowlisted (§4).

## 2. The rules

Formats are written broken up (`gh`·`p_`), never as a literal a scanner would flag.

| Rule id             | What it matches                                                                                                                                                                                                                                   | Kind        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `private-key`       | a PEM `BEGIN … PRIVATE KEY` block to its `END` line, or to the end of the text when cut (also the `PRIVATE KEY BLOCK` PGP form)                                                                                                                   | structural  |
| `aws-access-key-id` | `AK`·`IA`, `AS`·`IA`, `AB`·`IA` or `AC`·`CA` + 16 of `[0-9A-Z]`                                                                                                                                                                                   | provider    |
| `github-token`      | `gh` + one of `p o u s r` + `_` + 36 to 255 alphanumerics                                                                                                                                                                                         | provider    |
| `github-pat`        | `github`·`_pat_` + 22 or more of `[A-Za-z0-9_]`                                                                                                                                                                                                   | provider    |
| `gitlab-token`      | `gl`·`pat-` + 20 or more of `[A-Za-z0-9_-]`                                                                                                                                                                                                       | provider    |
| `slack-token`       | `xo`·`x` + one of `a b p o s r` + `-` + 10 or more of `[A-Za-z0-9-]`                                                                                                                                                                              | provider    |
| `slack-webhook`     | `https://hooks.slack.com/services/` + 20 or more path characters                                                                                                                                                                                  | provider    |
| `stripe-secret-key` | `sk` or `rk` + `_live_` or `_test_` + 16 or more alphanumerics (publishable `pk_` keys are not secrets and are not matched)                                                                                                                       | provider    |
| `anthropic-key`     | `sk`·`-ant-` + 20 or more of `[A-Za-z0-9_-]`                                                                                                                                                                                                      | provider    |
| `openai-key`        | `sk`·`-` + an optional `proj-`, `svcacct-` or `admin-` + 20 or more of `[A-Za-z0-9_-]`                                                                                                                                                            | provider    |
| `google-api-key`    | `AI`·`za` + 35 of `[0-9A-Za-z_-]`                                                                                                                                                                                                                 | provider    |
| `npm-token`         | `np`·`m_` + 36 alphanumerics                                                                                                                                                                                                                      | provider    |
| `sendgrid-key`      | `SG.` + 22 + `.` + 43 of `[A-Za-z0-9_-]`                                                                                                                                                                                                          | provider    |
| `jwt`               | `ey`·`J` + 8 or more, `.ey`·`J` + 8 or more, `.` + 8 or more (base64url)                                                                                                                                                                          | structural  |
| `url-credentials`   | `scheme://user:PASSWORD@host`: the password only                                                                                                                                                                                                  | structural  |
| `auth-header`       | `Authorization: Bearer\|Basic\|token <value>`: the value only                                                                                                                                                                                     | contextual  |
| `secret-assignment` | `NAME=value`, `NAME: value`, `"name": "value"`, where NAME ends in SECRET, TOKEN, PASSWORD, PASSWD, PWD, API_KEY, ACCESS_KEY or PRIVATE_KEY (any case, `_` optional), and the value is a literal of 8 to 512 characters with a digit and a letter | contextual  |
| `high-entropy`      | a 32 to 512 character run of `[A-Za-z0-9+/_=-]` that passes the shape filters (§3) and holds 4.0 bits of Shannon entropy per character or more. **Off by default** until W0 measures it on real tool output (§5.3)                                | statistical |

Choices the measurements drove (§5):

- **`secret-assignment` was the noisiest rule, and is now the strictest.** The first version took any
  name _containing_ `token` or `auth`, and it hit 294 times in this repo: `inputTokens:`,
  `"author":`, `token = randomUUID()`. The rule now requires all four of these:
  - the name _ends_ in the secret word;
  - the value is followed by no `(`, `.`, `?` or `[` (so not a call or a member access);
  - the value holds a digit and a letter;
  - the value is not a placeholder (`${VAR}`, `<your-token>`, `changeme`, `****`).

  That cut 294 hits to 9, all of them deliberately secret-shaped test fixtures. The cost: a password
  with no digit (`correcthorsebatterystaple`) assigned to `PASSWORD=` is missed, unless it is long and
  random enough for the high-entropy rule.

- **`AUTH` and `CREDENTIALS` are not secret words.** They name too many non-secret things
  (`authorId`, `credentials: 'include'`).

## 3. The false-positive strategy

The high-entropy rule is the only one that guesses. A candidate is dropped, before any entropy is
measured, when its shape says it is not a secret. Each filter below, and how many of this repo's 9,666
candidates it dropped (§5):

| Filter            | Drops                                                                                                                                                                                                                                                 | Dropped   |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `hex`             | all-hex runs: git SHAs, SHA1/256/512 digests, content hashes                                                                                                                                                                                          | 18        |
| `uuid`            | the 8-4-4-4-12 UUID form (session ids, request ids)                                                                                                                                                                                                   | 302       |
| `integrity`       | `sha1-`/`sha256-`/`sha384-`/`sha512-` integrity values (`package-lock.json`, SRI attributes)                                                                                                                                                          | 941       |
| `publishable-key` | `pk_live_`/`pk_test_` keys, which are public by design                                                                                                                                                                                                | (test)    |
| `data-uri`        | the payload after `;base64,` (inline images and fonts)                                                                                                                                                                                                | (test)    |
| `identifier`      | all-lowercase or all-uppercase runs with `_ . / -` and digits: file paths, constants, env names                                                                                                                                                       | 7,060     |
| `word`            | letters only (`ThisIsAVeryLongCamelCaseIdentifier`)                                                                                                                                                                                                   | 70        |
| `path`            | three or more `/`, or a longest `/`-separated part under 24 characters                                                                                                                                                                                | 1,089     |
| `slug`            | three or more parts split on `- _ . /`, each a word, a capitalized word, a short upper-and-digits id (`T195`, `PROJ`) or digits with a suffix (`500s`): branch and card slugs                                                                         | 126       |
| `classes`         | fewer than three of lowercase, uppercase and digits in the longest `/`-separated part (ULIDs, Crockford ids)                                                                                                                                          | 50        |
| `ssh-public-key`  | the key after `ssh-rsa`, `ssh-dss`, `ssh-ed25519`, `ecdsa-sha2-nistp…` or `sk-ssh-ed25519@openssh.com` (an `authorized_keys` line, `ssh-keygen -y` output)                                                                                            | (round 2) |
| `go-sum`          | the hash after `h1:` (`go.sum`, `go mod download -json`)                                                                                                                                                                                              | (round 2) |
| `nonce`           | a CSP `nonce-…` value                                                                                                                                                                                                                                 | (round 2) |
| `public-pem`      | a line inside a `CERTIFICATE`, `TRUSTED CERTIFICATE`, `X509 CRL`, `CERTIFICATE REQUEST`, `PUBLIC KEY`, `RSA PUBLIC KEY`, `SSH2 PUBLIC KEY` or `PGP PUBLIC KEY BLOCK` PEM block, between its `BEGIN` and `END` lines (`cat cert.pem` keeps every line) | (round 2) |

The four round-2 filters answer a verifier's probes of real tool-output shapes. The verifier's probe
script (in the orchestrator's scratch, not in this repo) was run, unmodified, against the round-2
`detect.ts`:

```text
-                      go.sum
-                      yarn.lock integrity
-                      docker digest
-                      npm audit ref
-                      git lfs oid
-                      k8s pod name
high-entropy           S3 presigned-ish X-Amz-Signature (hex)
high-entropy           base64 cert body (public)
-                      nonce in CSP
-                      webpack chunk hash
high-entropy           session id (claude)
high-entropy           random 32 b62 token (should hit)
-                      aws secret no label, b64 40
-                      ssh pubkey
```

Three probe shapes still hit, and none is fixed here:

- **An opaque `session_…` id.** It is indistinguishable from a token by shape.
- **A certificate body line on its own,** without its `BEGIN` line around it. A private key's body
  starts with the same `MII…` prefix, so the prefix cannot be the filter.
- **An S3 `X-Amz-Signature` value.** That one is arguably a credential, being time-limited.

Two rows are **random draws**, regenerated on every run, so they can flip between runs:

- **`random 32 b62 token (should hit)`** is the positive control. It hits about 99.5% of the time
  (§5.2, base62 len 32).
- **`aws secret no label, b64 40`** is the known recall gap: standard base64 with `/` (§5.3). It is
  missed here, and caught about 85% of the time overall (§5.2, base64 len 40).

These are why the rule stays off by default (SCR-Q2). A person who opts in is told so in the option's
own description: "when on it also redacts opaque ids such as session\_… and a bare base64 certificate
line" (`02-prototype.md` §2.1).

Media bytes are never text to scan. The prototype's `scrubDeep` skips any field named `base64` (a
`Read` of an image or PDF, `d.ts:20963-21021`) and a Bash `stdout` whose result says `isImage`. Both
cases are tested ("media bytes in a tool's record are left alone"). That test also asserts that the
same bytes, as plain text, _would_ be redacted, so it shows the skip is what saves them.

The placeholder never matches a rule, so scrubbing twice changes nothing (test
`clean: already redacted`). It also passes Harnu's own `lintSecrets` ([`00-spec.md`](00-spec.md) §11).

## 4. The allowlist

A repo commits `.claude/secret-scrubber.json`:

```json
{
  "allow": ["sha256:<64 hex digits of the value>"],
  "disable": ["jwt"],
  "resolveInto": ["config/local.env"]
}
```

- **`allow`** takes SHA256 digests, never values. The file can be committed and shown in review
  without itself becoming a leak. A fixture key the repo's tests use is allowlisted by its digest:
  `printf %s "$VALUE" | sha256sum`. The digest is unsalted on purpose, so the same entry works on
  every machine. That is safe for this purpose: an allowlisted value is one the repo has already
  declared harmless.
- **`disable`** takes rule ids from §2.
- **`resolveInto`** takes repo-relative paths that a resolved placeholder may be written into without a
  question, for a secrets file the repo does not gitignore (`00-spec.md` §6.2). Test `resolution > a
path the repo lists under resolveInto resolves with no question`.
- The mod reads the file at `session.start` from the session's `cwd` (`$.fs.read`, `d.ts:3223-3241`).
  No file means defaults. A file that is not JSON logs one line ("every rule stays on") and changes
  nothing. A broken allowlist never turns redaction off.
- The test `repo config > a value the repo allowlists by digest, and a rule it turns off, pass
through` covers all three outcomes in one row: an allowlisted value stays, a disabled rule's match
  stays, and a value matched by neither is redacted.

There is deliberately no regex allowlist. A pattern an attacker-controlled file could widen, or one
that backtracks badly, is worse than a digest list.

Harnu's per-folder off switch ([`00-spec.md`](00-spec.md) §9.1) and the `userConfig` fields
(`highEntropy`, `entropyThreshold`) sit above this file.

## 5. Measurements

### 5.1 Method

- **Negative corpus:** every text file `git ls-files` lists in this worktree, except this spec's own
  files, skipping files over 4 MiB and binaries. That is 1,901 files and 26.4 MB, the same set as at
  `cb7fb58`. The tree holds no real secret, so
  every hit is a false positive or a deliberately secret-shaped test fixture.
- **Positive corpus:** 10,000 random tokens per alphabet (base62, base64url, standard base64) and
  length (32, 40, 64), from `crypto.randomBytes`. Each is judged by the high-entropy rule alone (shape
  filters, then entropy).
- **Throughput:** `detect()` over the first 1 MB of `package-lock.json`, all rules on.
- Run with Node v22.22.2 (`node --experimental-strip-types`) on `hooks/detect.ts` itself, the file the
  mod loads. The script:

```js
// Usage: node --experimental-strip-types measure.mjs <repo> <detect.ts>
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
const [repo, detectPath] = process.argv.slice(2)
const { detect, benign, shannon } = await import(detectPath)
const files = execFileSync('git', ['-C', repo, 'ls-files'], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)
  .filter((f) => !f.startsWith('docs/specs/T450-secret-scrubber/'))
const CAND = /[A-Za-z0-9+/_=-]{32,512}/g
const thresholds = [3.5, 3.75, 4.0, 4.25, 4.5]
let bytes = 0,
  scanned = 0,
  candidates = 0
const fp = Object.fromEntries(thresholds.map((t) => [t, 0]))
const fpFiles = Object.fromEntries(thresholds.map((t) => [t, new Map()]))
const benignWhy = {},
  ruleHits = {},
  ruleFiles = {}
let ms = 0
for (const f of files) {
  const p = `${repo}/${f}`
  let text
  try {
    if (statSync(p).size > 4 * 1024 * 1024) continue
    text = readFileSync(p, 'utf8')
  } catch {
    continue
  }
  if (text.includes('\u0000')) continue
  scanned++
  bytes += text.length
  const t0 = performance.now()
  const hits = detect(text, { highEntropy: false, entropyThreshold: 99 })
  ms += performance.now() - t0
  for (const h of hits) {
    ruleHits[h.rule] = (ruleHits[h.rule] ?? 0) + 1
    ;(ruleFiles[h.rule] ??= new Set()).add(f)
  }
  for (const m of text.matchAll(CAND)) {
    candidates++
    const why = benign(text, m.index, m[0])
    if (why) benignWhy[why] = (benignWhy[why] ?? 0) + 1
  }
  // What the scrubber would actually report as high-entropy: detect() itself,
  // so a token a provider rule already claimed is not counted twice.
  for (const t of thresholds) {
    for (const h of detect(text, { highEntropy: true, entropyThreshold: t })) {
      if (h.rule !== 'high-entropy') continue
      fp[t]++
      fpFiles[t].set(f, (fpFiles[t].get(f) ?? 0) + 1)
    }
  }
}
// … prints the corpus, the rule hits and their files, the filter counts, and per
// threshold the hits and their files (output in §5.2) …
const alphabets = {
  base62: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
  base64url: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_',
  base64: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
}
const N = 10000
for (const [name, abc] of Object.entries(alphabets))
  for (const len of [32, 40, 64]) {
    const caught = Object.fromEntries(thresholds.map((t) => [t, 0]))
    for (let i = 0; i < N; i++) {
      const tok = [...randomBytes(len)].map((x) => abc[x % abc.length]).join('')
      if (benign(`x ${tok}`, 2, tok)) continue
      const h = shannon(tok)
      for (const t of thresholds) if (h >= t) caught[t]++
    }
    // prints the percentage caught per threshold
  }
const big = readFileSync(`${repo}/package-lock.json`, 'utf8').slice(0, 1_000_000)
const t1 = performance.now()
detect(big, { highEntropy: true, entropyThreshold: 4.0 })
// prints the time
```

### 5.2 Output (real, 2026-10-09, round-2 `detect.ts`)

```text
negative corpus: 1901 tracked text files, 26.4 MB
structural rules over the corpus: {"secret-assignment":9,"url-credentials":3,"openai-key":1,"github-token":2,"private-key":3,"aws-access-key-id":4,"auth-header":2} in 414 ms
  secret-assignment: resources/companion/tests/fixtures/hello.ts, tests/cli/channel.cli.test.ts, tests/cli/handshake.cli.test.ts, tests/companion/audit-core.test.ts, tests/companion/parity-core.test.ts, tests/mcp-config-file.test.ts, tests/mcp-http-guard.test.ts, tests/mcp-transcript-redact.test.ts
  url-credentials: src/main/github-remote.ts, tests/github-remote.test.ts
  openai-key: tests/cli/fleet-state.cli.test.ts
  github-token: tests/mcp-memory-core.test.ts
  private-key: tests/mcp-memory-core.test.ts, tests/mcp-transcript-redact.test.ts
  aws-access-key-id: tests/mcp-transcript-redact.test.ts
  auth-header: tests/mcp-transcript-redact.test.ts
high-entropy candidates (32+ chars): 9666; dropped by the shape filters: {"path":1089,"identifier":7060,"classes":50,"slug":126,"word":70,"uuid":302,"hex":18,"integrity":941}
  threshold 3.5: 6 high-entropy hits in 5 files: tests/folder-slug.test.ts (2), docs/specs/T205-claude-agents-json-fleet-reconciliation.md (1), tests/canvas-assets.test.ts (1), tests/canvas-origin-chain.test.ts (1), tests/voice-licence-gate.test.ts (1)
  threshold 3.75: 6 high-entropy hits in 5 files: tests/folder-slug.test.ts (2), docs/specs/T205-claude-agents-json-fleet-reconciliation.md (1), tests/canvas-assets.test.ts (1), tests/canvas-origin-chain.test.ts (1), tests/voice-licence-gate.test.ts (1)
  threshold 4: 4 high-entropy hits in 4 files: docs/specs/T205-claude-agents-json-fleet-reconciliation.md (1), tests/canvas-assets.test.ts (1), tests/canvas-origin-chain.test.ts (1), tests/voice-licence-gate.test.ts (1)
  threshold 4.25: 3 high-entropy hits in 3 files: docs/specs/T205-claude-agents-json-fleet-reconciliation.md (1), tests/canvas-assets.test.ts (1), tests/canvas-origin-chain.test.ts (1)
  threshold 4.5: 1 high-entropy hits in 1 files: docs/specs/T205-claude-agents-json-fleet-reconciliation.md (1)
positives base62 len 32: 3.5→99.5%  3.75→99.5%  4→99.5%  4.25→97.4%  4.5→65.2%
positives base62 len 40: 3.5→99.9%  3.75→99.9%  4→99.9%  4.25→99.8%  4.5→97.2%
positives base62 len 64: 3.5→100.0%  3.75→100.0%  4→100.0%  4.25→100.0%  4.5→100.0%
positives base64url len 32: 3.5→99.6%  3.75→99.6%  4→99.6%  4.25→97.9%  4.5→69.9%
positives base64url len 40: 3.5→99.9%  3.75→99.9%  4→99.9%  4.25→99.9%  4.5→98.1%
positives base64url len 64: 3.5→100.0%  3.75→100.0%  4→100.0%  4.25→100.0%  4.5→100.0%
positives base64 len 32: 3.5→76.4%  3.75→76.4%  4→76.3%  4.25→75.2%  4.5→53.5%
positives base64 len 40: 3.5→85.5%  3.75→85.5%  4→85.5%  4.25→85.5%  4.5→84.0%
positives base64 len 64: 3.5→92.0%  3.75→92.0%  4→92.0%  4.25→92.0%  4.5→92.0%
1 MB of package-lock.json, all rules: 57 ms
```

### 5.3 What the numbers say

- **The 24 rule hits.** 23 of them are deliberately secret-shaped test fixtures: the repo's own
  redaction and lint tests, spawn-token fixtures and a fake key in a CLI test. A scrubber _should_
  redact these when a session reads them; that is the point of their shape. The one false positive is
  a doc comment in `src/main/github-remote.ts`, `https://user:token@github.com/…`, where `token` is a
  word. **Fix for W1:** add `token`, `pass` and `password` to the placeholder words.
- **The high-entropy hits at 4.0: 4, all false positives.**
  - an opaque `session_…` id in a spec;
  - the same 1×1 PNG as a base64 literal in two canvas tests (a literal, so not behind `;base64,`);
  - a long JavaScript symbol in the voice licence test.

  That is one false positive per 6.6 MB of this repo's text. Lowering the threshold to 3.5 adds 2
  (in `folder-slug.test.ts`) and recalls almost nothing more. Raising it to 4.25 drops 1 hit but
  loses about 2 points of recall on 32-character tokens. **Decision: 4.0 when the rule is on, and
  the rule is off by default.** One false positive per 6.6 MB of source code says little about a
  transcript, which is mostly tool output: logs, `curl` responses, cloud CLI JSON full of opaque ids.
  The round-1 probes (§3) found false positives there that this repo does not contain. W0 counts the
  rule's hits on real transcripts (§5.4), and SCR-Q2 sets the bar for turning it on.

- **Recall on base62 and base64url tokens of 32 characters or more: 99.6% or better** at 4.0. Those
  are most API keys and session tokens. The rest are random draws that happen to fail the
  three-classes filter, such as no digit in 32 characters.
- **Recall on standard base64: 76% at 32 characters, 92% at 64.** The `path` filter judges a token
  with `/` by its longest `/`-separated part, and random base64 holds a `/` once every 64 characters.
  This is a known trade: without that filter, file paths dominate the false positives (1,089
  candidates dropped by `path`). Base64 secrets with a known prefix (SendGrid, AWS secret keys in an
  assignment) are caught by their rules instead.
- **Speed: 57 ms per MB** with every rule on, against a 10 s hook budget (`d.ts:5109`). Round 1
  measured 9 ms. The round-2 `public-pem` filter searches back for a `BEGIN` line from every
  candidate, and that search is the difference; W1 can index the `BEGIN`/`END` lines once per text.
  The whole 26.4 MB corpus took 414 ms for the rules alone. A large tool result never comes near the
  budget.

### 5.4 Not measured

- Real transcripts. The operator's `~/.claude/projects/` holds real secrets by definition. Scanning
  it for a count is safe (print counts only), but it was not done in this unit, because the brief
  forbids pasting anything from this machine that could be a credential. The W0 spike may run the
  same script over transcripts with output limited to counts per rule.
- Non-English text, minified bundles, and the lockfiles of other ecosystems (`yarn.lock`,
  `Cargo.lock`). `go.sum` is covered by the `go-sum` filter and a test. The spike adds a fixture for
  each.
