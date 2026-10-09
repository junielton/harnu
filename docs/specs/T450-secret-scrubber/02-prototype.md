# T450 — The prototype mod and its checks (C-5)

Part of [`00-spec.md`](00-spec.md). The tests are in [`03-tests.md`](03-tests.md), and the live runs
and the build log in [`04-live-runs.md`](04-live-runs.md). Everything below ran on this machine on
2026-10-09, on Claude Code **2.1.296**, and was copied from the files and the terminal, not retyped.
Paths under the session scratchpad read `<scratchpad>`.

## 1. Layout, and how it was run

The mod lives in `<scratchpad>/proto/secret-scrubber/`, outside the repo and outside the engine's
mods folder, so no hot-reload question was raised.

```text
.claude-plugin/plugin.json   manifest, userConfig, types contract
hooks/hooks.json             { "modules": ["./register.ts"] }
hooks/register.ts            the hooks module
hooks/detect.ts              the pure detector (also imported by Node for 01 §5)
types/index.d.ts             the $.state contract
tests/scrubber.test.ts       the test matrix and the behaviour tests (03-tests.md)
```

Commands, from the mod's folder:

```text
claude plugin validate .
claude plugin test .
tsc -p <scratchpad>/tsc            # TypeScript 5.9.3, the tsconfig in §3.1
```

The folder was never loaded by an engine, so no `.claude-plugin/types/` was laid in it. The type check
therefore uses the header `tsconfig.json` from `claude-code.d.ts`, kept outside the mod folder with
`include` naming the types file (SKILL.md, "Checking it").

## 2. Source

### 2.1 `.claude-plugin/plugin.json`

<!-- prettier-ignore -->
```json
{
  "name": "secret-scrubber",
  "version": "0.1.0",
  "description": "Redacts secrets in every row the conversation keeps, before the model or the transcript sees them",
  "author": {
    "name": "Harnu"
  },
  "types": "./types/index.d.ts",
  "userConfig": {
    "resolve": {
      "type": "string",
      "title": "Resolve placeholders in Bash",
      "description": "ask: confirm before a Bash command gets the real value behind a placeholder; never: placeholders stay placeholders",
      "default": "ask",
      "options": [
        "ask",
        "never"
      ]
    },
    "highEntropy": {
      "type": "boolean",
      "title": "Redact high-entropy tokens",
      "description": "Also redact unlabelled tokens that look random (off until measured on real tool output)",
      "default": false
    },
    "entropyThreshold": {
      "type": "number",
      "title": "Entropy threshold (bits per character)",
      "description": "Minimum Shannon entropy for the high-entropy rule",
      "default": 4.0
    }
  }
}
```

### 2.2 `types/index.d.ts`

<!-- prettier-ignore -->
```ts
export type ScrubCounts = {
  total: number;
  byRule: Record<string, number>;
  off: boolean;
  tripped: boolean;
};

declare module 'claude-code' {
  interface PluginState {
    'secret-scrubber': { counts: ScrubCounts };
  }
}
```

### 2.3 `hooks/detect.ts`

<!-- prettier-ignore -->
```ts
// Pure detector: no `$`, no engine. Finds secret-shaped spans in a text and
// says which rule matched. The hooks module turns each span into a placeholder.

export type Finding = { start: number; end: number; rule: string };

export type DetectOptions = {
  highEntropy: boolean;
  entropyThreshold: number;
  // Exact values the repo declared harmless (test fixtures, public demo keys).
  allowValues?: ReadonlySet<string>;
};

type Rule = {
  id: string;
  re: RegExp;
  // Which capture group holds the secret; 0 = the whole match.
  group?: number;
  // A last word on the captured value: false drops the match.
  value?: (v: string) => boolean;
};

// Provider formats first: the most specific rule wins an overlap.
const RULES: readonly Rule[] = [
  { id: 'private-key', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----[\s\S]*?(-----END [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----|$)/gd },
  { id: 'aws-access-key-id', re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/gd },
  { id: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/gd },
  { id: 'github-pat', re: /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/gd },
  { id: 'gitlab-token', re: /\bglpat-[A-Za-z0-9_-]{20,}\b/gd },
  { id: 'slack-token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/gd },
  { id: 'slack-webhook', re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{20,}/gd },
  { id: 'stripe-secret-key', re: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/gd },
  { id: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/gd },
  { id: 'openai-key', re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/gd },
  { id: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/gd },
  { id: 'npm-token', re: /\bnpm_[A-Za-z0-9]{36}\b/gd },
  { id: 'sendgrid-key', re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/gd },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gd },
  // scheme://user:PASSWORD@host: only the password is the secret.
  { id: 'url-credentials', re: /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@'"]{1,128}:([^\s@/'"]{3,256})@[^\s'"]/gid, group: 1 },
  { id: 'auth-header', re: /\bAuthorization:\s*(?:Bearer|Basic|token)\s+([A-Za-z0-9._~+/=-]{8,})/gid, group: 1 },
  // NAME=value, NAME: value, "name": "value" where the NAME ends in a secret word
  // (`API_SECRET`, `githubToken`, `db_password`) and the value is a literal.
  {
    id: 'secret-assignment',
    re: /(?<![A-Za-z0-9])([A-Za-z0-9_.-]*?(?:SECRET|TOKEN|PASSWORD|PASSWD|PWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY))(?![A-Za-z0-9])["']?\s*[:=]\s*["']?([A-Za-z0-9+/=_.~!@%^*-]{8,512})(?![A-Za-z0-9(?.\[])/gid,
    group: 2,
    value: (v) => /[0-9]/.test(v) && /[A-Za-z]/.test(v),
  },
];

const PLACEHOLDER_VALUE = /^(?:\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|<[^>]*>|\*+|x{4,}|X{4,}|changeme|change-me|password|secret|example|your[-_].*|placeholder|null|undefined|true|false|\[REDACTED[^\]]*\]?)$/i;

export function shannon(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

const CANDIDATE = /[A-Za-z0-9+/_=-]{32,512}/g;
const HEX = /^[0-9a-fA-F]+$/;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// Why a high-entropy candidate is NOT a secret, or undefined when it may be.
export function benign(text: string, start: number, token: string): string | undefined {
  if (HEX.test(token)) return 'hex';
  if (UUID.test(token)) return 'uuid';
  const before = text.slice(Math.max(0, start - 40), start);
  if (/^sha(?:1|256|384|512)-/.test(token) || /sha(?:1|256|384|512)-$/.test(before)) return 'integrity';
  if (/^pk_(?:live|test)_/.test(token)) return 'publishable-key';
  // Public material that looks random: an SSH public key, a go.sum hash, a CSP
  // nonce, and the body of a certificate or public-key PEM block.
  if (/\b(?:ssh-(?:rsa|dss|ed25519)|ecdsa-sha2-nistp\d+|sk-ssh-ed25519@openssh\.com)\s+$/.test(before)) return 'ssh-public-key';
  if (/\bh1:$/.test(before)) return 'go-sum';
  if (/^nonce-/.test(token) || /\bnonce-$/.test(before)) return 'nonce';
  const lastBegin = text.lastIndexOf('-----BEGIN ', start);
  if (lastBegin !== -1 && text.indexOf('-----END ', lastBegin) > start) {
    const kind = text.slice(lastBegin + 11, text.indexOf('-----', lastBegin + 11));
    if (/^(?:CERTIFICATE|TRUSTED CERTIFICATE|X509 CRL|CERTIFICATE REQUEST|PUBLIC KEY|RSA PUBLIC KEY|SSH2 PUBLIC KEY|PGP PUBLIC KEY BLOCK)$/.test(kind)) return 'public-pem';
  }
  if (/;base64,$/.test(before) || /base64,[A-Za-z0-9+/=]*$/.test(before)) return 'data-uri';
  if (/^[a-z0-9_./-]+$/.test(token)) return 'identifier';
  if (/^[A-Z0-9_./-]+$/.test(token)) return 'identifier';
  if (/^[A-Za-z]+$/.test(token)) return 'word';
  if ((token.match(/\//g) ?? []).length >= 3) return 'path';
  const parts = token.split(/[-_./]+/).filter(Boolean);
  if (parts.length >= 3 && parts.every((p) => /^(?:[a-z]+[0-9]*|[A-Z][a-z]+[0-9]*|[A-Z0-9]{1,8}|[0-9]+[a-z]*)$/.test(p))) return 'slug';
  const longest = token.split('/').reduce((a, b) => (b.length > a.length ? b : a), '');
  if (longest.length < 24) return 'path';
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((re) => re.test(longest)).length;
  if (classes < 3) return 'classes';
  return undefined;
}

export function detect(text: string, opts: DetectOptions): Finding[] {
  const found: Finding[] = [];
  const taken = (s: number, e: number) => found.some((f) => s < f.end && e > f.start);
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    for (const m of text.matchAll(rule.re)) {
      const g = rule.group ?? 0;
      const value = m[g];
      if (value === undefined) continue;
      const span = m.indices?.[g];
      if (span === undefined) continue;
      const [start, end] = span;
      if (g !== 0 && (PLACEHOLDER_VALUE.test(value) || value.includes('${'))) continue;
      if (rule.value !== undefined && !rule.value(value)) continue;
      if (opts.allowValues?.has(value)) continue;
      if (taken(start, end)) continue;
      found.push({ start, end, rule: rule.id });
    }
  }
  if (opts.highEntropy) {
    for (const m of text.matchAll(CANDIDATE)) {
      const token = m[0];
      const start = m.index ?? 0;
      const end = start + token.length;
      if (taken(start, end)) continue;
      if (benign(text, start, token) !== undefined) continue;
      if (shannon(token) < opts.entropyThreshold) continue;
      if (opts.allowValues?.has(token)) continue;
      found.push({ start, end, rule: 'high-entropy' });
    }
  }
  return found.sort((a, b) => a.start - b.start);
}
```

### 2.4 `hooks/register.ts`

<!-- prettier-ignore -->
```ts
import type { EngineInterface, Register, SessionAppendInput } from 'claude-code';
import type { ScrubCounts } from '../types';
import { detect, type DetectOptions } from './detect.ts';

const counts = { plugin: 'secret-scrubber', key: 'counts' } as const;
const NONE: ScrubCounts = { total: 0, byRule: {}, off: false, tripped: false };

// The real values behind this session's placeholders. A module variable on
// purpose: `$.state` is readable by every plugin and `$.store` is written to
// disk, and a secret must reach neither. A reload or a resume empties it.
const vault = new Map<string, string>();
let salt = '';
let keepNextPrompt = false;
// Set when a keep-next prompt went through unredacted: its row passes too.
let passNextPromptRow = false;
let config: DetectOptions = { highEntropy: false, entropyThreshold: 4.0 };
// From the repo's `.claude/secret-scrubber.json`: SHA256 digests of values the
// repo declares harmless, rules it turns off, and repo-relative paths the real
// value may be written into without a question.
let allowed = new Set<string>();
let disabled = new Set<string>();
let resolveInto = new Set<string>();
let repoRoot = '';
// Off for this session: `/scrub off`, or Harnu's flag file. Every hook then
// passes rows through as they came.
let off = false;
let offBy = '';
// Circuit breaker: consecutive safety failures. At TRIP the person is told.
let failures = 0;
const TRIP = 3;

const PLACEHOLDER = /\[REDACTED:[a-z0-9-]+#[0-9a-f]{8}\]/g;

type RepoConfig = { allow?: unknown; disable?: unknown; resolveInto?: unknown };

// WebCrypto's name for SHA256, written in two parts: Harnu's client-identifier
// gate reads the joined name as a tracker key (tests/no-client-identifiers.test.ts).
export const SHA256 = 'SHA' + '-256';

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(SHA256, new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function loadRepoConfig($: EngineInterface, cwd: string): Promise<void> {
  allowed = new Set();
  disabled = new Set();
  resolveInto = new Set();
  let raw: unknown;
  try {
    raw = await $.fs.read(`${cwd}/.claude/secret-scrubber.json`);
  } catch {
    return; // No file: defaults.
  }
  if (typeof raw !== 'string') return;
  let parsed: RepoConfig;
  try {
    parsed = JSON.parse(raw) as RepoConfig;
  } catch {
    // A broken file never turns redaction off: every rule stays on.
    $.ui.log('.claude/secret-scrubber.json is not valid JSON; every rule stays on');
    return;
  }
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  allowed = new Set(strings(parsed.allow).map((d) => d.replace(/^sha256:/, '').toLowerCase()));
  disabled = new Set(strings(parsed.disable));
  resolveInto = new Set(strings(parsed.resolveInto));
}

// A stable stand-in: same value, same placeholder, on this machine.
async function placeholderFor(rule: string, value: string): Promise<string> {
  const tag = (await sha256Hex(salt + value)).slice(0, 8);
  const placeholder = `[REDACTED:${rule}#${tag}]`;
  vault.set(placeholder, value);
  return placeholder;
}

async function scrubText(text: string, hits: string[]): Promise<string> {
  // A value already in the vault is caught by its literal, wherever it shows
  // up again: a contextual rule (a URL's password, an assignment) would not
  // see it in a new context, such as a Bash command echoing it back.
  let known = text;
  for (const [placeholder, value] of vault) {
    if (known.includes(value)) {
      known = known.split(value).join(placeholder);
      hits.push(placeholder.slice(10, placeholder.indexOf('#')));
    }
  }
  const found = detect(known, config);
  if (found.length === 0) return known;
  let out = '';
  let at = 0;
  for (const f of found) {
    const value = known.slice(f.start, f.end);
    if (disabled.has(f.rule) || (allowed.size > 0 && allowed.has(await sha256Hex(value)))) continue;
    out += known.slice(at, f.start) + (await placeholderFor(f.rule, value));
    at = f.end;
    hits.push(f.rule);
  }
  return out + known.slice(at);
}

type Block = { type: string; [field: string]: unknown };

async function scrubBlocks(blocks: readonly Block[], hits: string[]): Promise<Block[]> {
  const out: Block[] = [];
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') {
      out.push({ ...block, text: await scrubText(block.text, hits) });
    } else if (block.type === 'tool_result') {
      const content = block.content;
      if (typeof content === 'string') out.push({ ...block, content: await scrubText(content, hits) });
      else if (Array.isArray(content)) out.push({ ...block, content: await scrubBlocks(content as Block[], hits) });
      else out.push(block);
    } else {
      // Thinking, tool_use, image, document: pinned or unchangeable.
      out.push(block);
    }
  }
  return out;
}

// Every string inside a tool's structured record, scrubbed. Media bytes are
// skipped: a Read of an image or PDF carries `base64`, a Bash image `stdout`.
async function scrubDeep(value: unknown, hits: string[]): Promise<unknown> {
  if (typeof value === 'string') return scrubText(value, hits);
  if (Array.isArray(value)) return Promise.all(value.map((v) => scrubDeep(v, hits)));
  if (value !== null && typeof value === 'object') {
    const isImage = (value as { isImage?: unknown }).isImage === true;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = k === 'base64' || (isImage && k === 'stdout') ? v : await scrubDeep(v, hits);
    }
    return out;
  }
  return value;
}

// Every placeholder in a value's strings, known to this session or not.
function placeholdersIn(value: unknown, into = new Set<string>()): Set<string> {
  if (typeof value === 'string') for (const m of value.matchAll(PLACEHOLDER)) into.add(m[0]);
  else if (Array.isArray(value)) for (const v of value) placeholdersIn(v, into);
  else if (value !== null && typeof value === 'object') for (const v of Object.values(value)) placeholdersIn(v, into);
  return into;
}

// The real value back in place of each placeholder, in every string of a value.
function resolveDeep(value: unknown): unknown {
  if (typeof value === 'string') {
    let out = value;
    for (const [p, real] of vault) if (out.includes(p)) out = out.split(p).join(real);
    return out;
  }
  if (Array.isArray(value)) return value.map(resolveDeep);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveDeep(v)]));
  }
  return value;
}

const WRITERS: ReadonlySet<string> = new Set(['Edit', 'Write', 'NotebookEdit']);

const UNKNOWN = (ps: readonly string[]) =>
  `secret-scrubber: the value behind ${ps.join(', ')} is not known in this session ` +
  '(it was resumed, parked by Harnu, or the scrubber reloaded). Nothing ran. ' +
  'Read the file or rerun the command that held it: the same placeholder comes back with its value.';

// Where a resolved value would land: `tracked` (never), `ignored` or
// `allowed` (silently), `other` (ask).
async function landing($: EngineInterface, path: string): Promise<'tracked' | 'ignored' | 'allowed' | 'other'> {
  if (repoRoot !== '' && path.startsWith(`${repoRoot}/`) && resolveInto.has(path.slice(repoRoot.length + 1))) return 'allowed';
  const tracked = await $.process.run(['git', 'ls-files', '--error-unmatch', '--', path]);
  if (tracked.exitCode === 0) return 'tracked';
  const ignored = await $.process.run(['git', 'check-ignore', '-q', '--', path]);
  return ignored.exitCode === 0 ? 'ignored' : 'other';
}

// Counts are bookkeeping: a failure here never withholds a row (fail-open).
async function record($: EngineInterface, hits: readonly string[]): Promise<void> {
  if (hits.length === 0) return;
  try {
    const { value = NONE } = await $.state.get(counts);
    const byRule = { ...value.byRule };
    for (const rule of hits) byRule[rule] = (byRule[rule] ?? 0) + 1;
    const total = value.total + hits.length;
    // Counts and rule names only: never a value, never a placeholder's tag.
    await $.state.set(counts, { ...value, total, byRule });
    $.ui.status(`${total} redacted`);
  } catch {
    // The row is already scrubbed; only the count is lost.
  }
}

async function setOff($: EngineInterface, by: string): Promise<void> {
  if (off) return;
  off = true;
  offBy = by;
  $.ui.status(`off (${by})`);
  try {
    await $.session.append({ message: { type: 'system', content: [{ type: 'text', text: `Secret scrubbing is off for this session (${by}).` }] } });
    const { value = NONE } = await $.state.get(counts);
    await $.state.set(counts, { ...value, off: true });
  } catch {
    // Bookkeeping.
  }
}

// A safety-critical failure: counted, and loud once the breaker trips.
function failed($: EngineInterface): void {
  failures += 1;
  if (failures === TRIP) {
    $.ui.toast(`secret-scrubber failed ${TRIP} times in a row and is withholding what it cannot check. /scrub off turns it off for this session.`, { timeoutMs: 15000 });
    $.ui.status('failing: /scrub off');
    void $.state.get(counts).then(({ value = NONE }) => $.state.set(counts, { ...value, tripped: true })).catch(() => undefined);
  }
}

function withheld(e: SessionAppendInput): SessionAppendInput {
  const content = e.message.content.map((b) =>
    b.type === 'text'
      ? { ...b, text: '[secret-scrubber failed: text withheld]' }
      : b.type === 'tool_result'
        ? { ...b, content: '[secret-scrubber failed: result withheld]' }
        : b,
  );
  return { ...e, message: { ...e.message, content } };
}

export const register: Register = (on, options) => {
  const mode = options.resolve === 'never' ? 'never' : 'ask';
  config = {
    highEntropy: options.highEntropy === true,
    entropyThreshold: typeof options.entropyThreshold === 'number' ? options.entropyThreshold : 4.0,
  };

  on('session.start', async ($, e, next) => {
    const stored = await $.store.get('salt');
    if (typeof stored === 'string') salt = stored;
    else {
      salt = crypto.randomUUID();
      await $.store.set('salt', salt);
    }
    repoRoot = e.cwd;
    await loadRepoConfig($, e.cwd);
    await $.command.register({ name: 'scrub', description: 'Secret scrubber: status, keep-next, off or on' });
    // Harnu's live off switch: a flag file beside the staged mod, checked every
    // 5 s, so the operator's Settings toggle reaches running sessions too.
    const flag = `${$.plugin.root}/../../scrubber-off`;
    $.clock.every(5000, () => {
      void $.fs.exists(flag).then((isOff) => (isOff ? setOff($, 'Harnu Settings') : undefined)).catch(() => undefined);
    });
    return next(e);
  });

  on('command.run', { command: 'scrub' }, async ($, e) => {
    const arg = e.args.trim();
    if (arg === 'keep-next') {
      keepNextPrompt = true;
      return { text: 'The next prompt goes to the model unredacted.' };
    }
    if (arg === 'off') {
      await setOff($, '/scrub off');
      return { text: 'Secret scrubbing is off for this session.' };
    }
    if (arg === 'on') {
      off = false;
      failures = 0;
      $.ui.status(undefined);
      return { text: 'Secret scrubbing is on again.' };
    }
    const { value = NONE } = await $.state.get(counts);
    const rules = Object.entries(value.byRule).map(([rule, n]) => `${rule} ${n}`);
    const state = off ? ` (off: ${offBy})` : failures >= TRIP ? ' (failing)' : '';
    return { text: `${value.total} redacted this session${rules.length ? `: ${rules.join(', ')}` : ''}${state}` };
  });

  // The prompt as typed, before it is queued: narrows the queue-operation record.
  on('prompt.submit', async ($, e, next) => {
    if (off) return next(e);
    if (keepNextPrompt) {
      keepNextPrompt = false;
      passNextPromptRow = true;
      return next(e);
    }
    const hits: string[] = [];
    const text = await scrubText(e.text, hits);
    failures = 0;
    await record($, hits);
    return next({ ...e, text });
  }).catch(($, e, next) => {
    if (next.called) return next(e);
    failed($);
    return { drop: 'secret-scrubber could not check this prompt; /scrub off turns it off for this session' };
  });

  // Every row the conversation keeps: what the model reads and the transcript stores.
  on('session.append', async ($, e, next) => {
    if (off) return next(e);
    if (e.origin.kind === 'plugin' && 'name' in e.origin && e.origin.name === 'secret-scrubber') return next(e);
    if (e.door === 'prompt' && passNextPromptRow) {
      passNextPromptRow = false;
      return next(e);
    }
    const hits: string[] = [];
    const content = await scrubBlocks(e.message.content, hits);
    failures = 0;
    await record($, hits);
    return next({ ...e, message: { ...e.message, content } });
  }).catch(($, e, next) => {
    if (next.called) return next(e);
    failed($);
    return next(withheld(e));
  });

  // A tool's structured record (`toolUseResult`) is stored as made at
  // session.append; answering the call with a scrubbed result is the only door.
  // Placeholders in a tool's input resolve only where the value cannot leave
  // unasked, and a placeholder this session cannot resolve stops the call.
  on('tool.call', async ($, e, next) => {
    if (off) return next(e);
    let call = e;
    const used = [...placeholdersIn(e)];
    if (used.length > 0 && (WRITERS.has(e.tool) || e.tool === 'Bash')) {
      const unknown = used.filter((p) => !vault.has(p));
      if (unknown.length > 0) return { deny: UNKNOWN(unknown) };
      if (WRITERS.has(e.tool)) {
        const target = String((e as { file_path?: unknown; notebook_path?: unknown }).file_path ?? (e as { notebook_path?: unknown }).notebook_path ?? '');
        const where = await landing($, target);
        if (where === 'tracked') {
          return { deny: `secret-scrubber: ${target} is tracked by git, and a secret is never written into a tracked file. Use an ignored file (.env) and read it from there.` };
        }
        if (where === 'other') {
          const answer = await $.ui.ask(`Write the real value of ${used.join(', ')} into ${target}?`, ['Allow once', 'Keep redacted']);
          if (answer !== 'Allow once') return { deny: `secret-scrubber: the person kept ${used.join(', ')} out of ${target}. Nothing was written.` };
        }
        call = resolveDeep(e) as typeof e;
      } else if (mode !== 'never') {
        const answer = await $.ui.ask(`Let this Bash command use the real value of ${used.join(', ')}?`, ['Allow once', 'Keep redacted']);
        if (answer === 'Allow once') call = resolveDeep(e) as typeof e;
      }
    }
    const result = await next(call);
    if (result.deny !== undefined) return result;
    // Tell the model the value went in, or it believes it wrote the placeholder.
    const note = call !== e ? [`secret-scrubber put the real value back in place of ${used.join(', ')} for this call.`] : [];
    const hits: string[] = [];
    if (result.isError === true) {
      // Core stores an errored call's text as `toolUseResult`, and refuses a
      // hook's own errored answer: a deny carrying the redacted text is the
      // one way to keep the model's view and keep the value off disk.
      const text = await scrubText(result.text ?? '', hits);
      if (hits.length === 0) return result;
      failures = 0;
      await record($, hits);
      return { deny: `the call ran and failed; its output, redacted:\n${text}` };
    }
    const scrubbed = await scrubDeep(result.result, hits);
    failures = 0;
    if (hits.length === 0 && note.length === 0) return result;
    await record($, hits);
    return { result: scrubbed as typeof result.result, context: [...(result.context ?? []), ...note] };
  }).catch(($, e, next) => {
    // After `next` the tool already ran and a deny undoes nothing: say so, so
    // the model does not run a non-idempotent command again.
    if (next.called) {
      failed($);
      return { deny: 'the call ran, but secret-scrubber could not check its output, so it is withheld. Do not run it again; ask the person.' };
    }
    // Before `next`: a call that would carry a placeholder it could not resolve
    // (nobody to ask, as in `-p`, or the ask failed) never runs with the
    // placeholder's text in place of the value.
    if ((WRITERS.has(e.tool) || e.tool === 'Bash') && placeholdersIn(e).size > 0) {
      return { deny: 'secret-scrubber could not resolve the placeholders in this call (nobody to ask, or the question failed). Nothing ran.' };
    }
    failed($);
    return next(e);
  });
};
```

### 2.5 `claude plugin validate .` (2.1.296)

```text
Validating plugin manifest: <scratchpad>/proto/secret-scrubber/.claude-plugin/plugin.json

  ❯ types ./types/index.d.ts declares on $: nothing (no EngineInterface member)
  ❯ types ./types/index.d.ts declares state: secret-scrubber.counts

Validating hooks: <scratchpad>/proto/secret-scrubber/hooks/hooks.json

  ❯ ./register.ts hooks: session.start, command.run{command=scrub}, prompt.submit, session.append, tool.call
  ❯ ./register.ts answers its own command: command.run{command=scrub}
  ❯ ./register.ts gating hook with .catch: prompt.submit
  ❯ ./register.ts gating hook with .catch: session.append
  ❯ ./register.ts gating hook with .catch: tool.call
  ❯ ./register.ts calls: $.clock.every, $.command.register, $.fs.exists, $.fs.read (via loadRepoConfig), $.process.run (via landing), $.session.append (via setOff), $.state.get, $.state.set (via failed, record, setOff), $.store.get, $.store.set, $.ui.ask, $.ui.log (via loadRepoConfig), $.ui.status, $.ui.toast (via failed)
  ❯ ./register.ts state writes: secret-scrubber.counts
  ❯ ./register.ts state reads: secret-scrubber.counts

✔ Validation passed
```

All three gating hooks carry a `.catch` (`00-spec.md` §9.2). The calls line is the mod's whole reach
into the engine. It has no `$.http` and no `$.mcp`. `$.process.run` runs `git ls-files` and
`git check-ignore` only, to decide where a resolved value may land (`00-spec.md` §6.2).

## 3. Type check, audit chips, and Harnu's lint over placeholders

### 3.1 `tsc -p`

The `tsconfig.json`, outside the mod folder:

<!-- prettier-ignore -->
```json
{
  "compilerOptions": {
    "target": "es2023", "lib": ["es2023"], "types": [],
    "module": "esnext", "moduleResolution": "bundler",
    "strict": true, "noUncheckedIndexedAccess": true,
    "noEmit": true, "skipLibCheck": true, "allowImportingTsExtensions": true,
    "jsx": "react", "jsxFactory": "h", "jsxFragmentFactory": "Fragment"
  },
  "include": ["<scratchpad>/pa/types/claude-code.d.ts", "<scratchpad>/proto/secret-scrubber/hooks", "<scratchpad>/proto/secret-scrubber/types", "<scratchpad>/proto/secret-scrubber/tests"]
}
```

`allowImportingTsExtensions` is the one option added to the header's. `register.ts` imports
`./detect.ts` by its file name, which the engine requires. Output:

```text
exit 0
```

### 3.2 Settings → Mods audit chips

`claude plugin validate --json <mod>` was fed to Harnu's own `parseValidateReport` and `buildAnalysis`
(`src/main/mods-audit-core.ts`), imported by Node from this worktree:

```js
const m = await import('<worktree>/src/main/mods-audit-core.ts')
const parsed = m.parseValidateReport(JSON.parse(readFileSync('<validate.json>', 'utf8')))
const a = m.buildAnalysis(
  parsed,
  { hash: 'h', hashKind: 'tree', now: 0, cliVersion: '2.1.295' },
  null
)
console.log(
  'capabilities',
  JSON.stringify(a.capabilities),
  '\nwarnings',
  JSON.stringify(a.warnings)
)
```

```text
capabilities ["process","files","prompts","tool-calls"]
warnings []
```

### 3.3 `lintSecrets` over placeholders

The 8 `SECRET_PATTERNS` were copied verbatim from `src/main/mcp/memory-core.ts:347-359` and run over
every rule id in 6 shapes:

- `<p>`
- `API_SECRET=<p>`
- `password: <p>`
- `"client_secret": "<p>"`
- `postgres://app:<p>@db:5432/app`
- `Authorization: Bearer <p>`

Here `<p>` is `[REDACTED:<rule>#0a1b2c3d]`. Output:

```text
lintSecrets over 108 placeholder samples: 0 hits
```
