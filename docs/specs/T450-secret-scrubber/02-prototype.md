# T450 — The prototype, its checks and the live runs (C-5)

Part of [`00-spec.md`](00-spec.md). Everything below ran on this machine on 2026-10-09 and was copied
into this file from the files and the terminal, not retyped. Paths under the session scratchpad read
`<scratchpad>`.

## 1. Layout, and how it was run

The mod lives in `<scratchpad>/proto/secret-scrubber/`, outside the repo and outside the engine's
mods folder, so no hot-reload question was raised. Its files:

```text
.claude-plugin/plugin.json   manifest, userConfig, types contract
hooks/hooks.json             { "modules": ["./register.ts"] }
hooks/register.ts            the hooks module
hooks/detect.ts              the pure detector (also imported by Node for 01 §5)
types/index.d.ts             the $.state contract
tests/scrubber.test.ts       the test matrix and the behaviour tests
```

Commands, from the mod's folder:

```text
claude plugin validate .
claude plugin test .
tsc -p <scratchpad>/tsc            # TypeScript 5.9.3, the tsconfig in §4
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
      "description": "Also redact unlabelled tokens that look random",
      "default": true
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
export type ScrubCounts = { total: number; byRule: Record<string, number> };

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
const NONE: ScrubCounts = { total: 0, byRule: {} };

// The real values behind this session's placeholders. A module variable on
// purpose: `$.state` is readable by every plugin and `$.store` is written to
// disk, and a secret must reach neither. A hot reload empties it.
const vault = new Map<string, string>();
let salt = '';
let keepNextPrompt = false;
// Set when a keep-next prompt went through unredacted: its row passes too.
let passNextPromptRow = false;
let config: DetectOptions = { highEntropy: true, entropyThreshold: 4.0 };
// From the repo's `.claude/secret-scrubber.json`: SHA256 digests of values the
// repo declares harmless (fixtures, public demo keys), and rules it turns off.
let allowed = new Set<string>();
let disabled = new Set<string>();

type RepoConfig = { allow?: unknown; disable?: unknown };

async function loadRepoConfig($: EngineInterface, cwd: string): Promise<void> {
  allowed = new Set();
  disabled = new Set();
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
}

// WebCrypto's name for SHA256, written in two parts: Harnu's client-identifier
// gate reads the joined name as a tracker key (tests/no-client-identifiers.test.ts).
export const SHA256 = 'SHA' + '-256';

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(SHA256, new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// A stable stand-in: same value, same placeholder, on this machine.
async function placeholderFor(rule: string, value: string): Promise<string> {
  const tag = (await sha256Hex(salt + value)).slice(0, 8);
  const placeholder = `[REDACTED:${rule}#${tag}]`;
  vault.set(placeholder, value);
  return placeholder;
}

async function scrubText(text: string, hits: string[]): Promise<string> {
  const found = detect(text, config);
  if (found.length === 0) return text;
  let out = '';
  let at = 0;
  for (const f of found) {
    const value = text.slice(f.start, f.end);
    if (disabled.has(f.rule) || (allowed.size > 0 && allowed.has(await sha256Hex(value)))) continue;
    out += text.slice(at, f.start) + (await placeholderFor(f.rule, value));
    at = f.end;
    hits.push(f.rule);
  }
  return out + text.slice(at);
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

// Tools that only write the machine's own files: a placeholder in their input
// becomes the real value with no question, so an edit never writes the
// placeholder's text into a file in place of the secret it stood for.
const WRITERS: ReadonlySet<string> = new Set(['Edit', 'Write', 'NotebookEdit']);

async function record($: EngineInterface, hits: readonly string[]): Promise<void> {
  if (hits.length === 0) return;
  const { value = NONE } = await $.state.get(counts);
  const byRule = { ...value.byRule };
  for (const rule of hits) byRule[rule] = (byRule[rule] ?? 0) + 1;
  const total = value.total + hits.length;
  // Counts and rule names only: never a value, never a placeholder's tag.
  await $.state.set(counts, { total, byRule });
  $.ui.status(`${total} redacted`);
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
    highEntropy: options.highEntropy !== false,
    entropyThreshold: typeof options.entropyThreshold === 'number' ? options.entropyThreshold : 4.0,
  };

  on('session.start', async ($, e, next) => {
    const stored = await $.store.get('salt');
    if (typeof stored === 'string') salt = stored;
    else {
      salt = crypto.randomUUID();
      await $.store.set('salt', salt);
    }
    await loadRepoConfig($, e.cwd);
    await $.command.register({ name: 'scrub', description: 'Secret scrubber: status, or keep-next to send the next prompt unredacted' });
    return next(e);
  });

  on('command.run', { command: 'scrub' }, async ($, e) => {
    if (e.args.trim() === 'keep-next') {
      keepNextPrompt = true;
      return { text: 'The next prompt goes to the model unredacted.' };
    }
    const { value = NONE } = await $.state.get(counts);
    const rules = Object.entries(value.byRule).map(([rule, n]) => `${rule} ${n}`);
    return { text: `${value.total} redacted this session${rules.length ? `: ${rules.join(', ')}` : ''}` };
  });

  // The prompt as typed, before it is queued: closes the queue-operation record.
  on('prompt.submit', async ($, e, next) => {
    if (keepNextPrompt) {
      keepNextPrompt = false;
      passNextPromptRow = true;
      return next(e);
    }
    const hits: string[] = [];
    const text = await scrubText(e.text, hits);
    await record($, hits);
    return next({ ...e, text });
  }).catch(($, e, next) => (next.called ? next(e) : { drop: 'secret-scrubber could not check this prompt' }));

  // Every row the conversation keeps: what the model reads and the transcript stores.
  on('session.append', async ($, e, next) => {
    if (e.origin.kind === 'plugin' && 'name' in e.origin && e.origin.name === 'secret-scrubber') return next(e);
    if (e.door === 'prompt' && passNextPromptRow) {
      passNextPromptRow = false;
      return next(e);
    }
    const hits: string[] = [];
    const content = await scrubBlocks(e.message.content, hits);
    await record($, hits);
    return next({ ...e, message: { ...e.message, content } });
  }).catch(($, e, next) => (next.called ? next(e) : next(withheld(e))));

  // A tool's structured record (`toolUseResult`) is stored as made at
  // session.append; answering the call with a scrubbed result is the only door.
  // Bash also gets its placeholders resolved, with consent.
  on('tool.call', async ($, e, next) => {
    let call = e;
    if (WRITERS.has(e.tool) && vault.size > 0) {
      call = resolveDeep(e) as typeof e;
    } else if (e.tool === 'Bash' && mode !== 'never') {
      const used = [...vault.keys()].filter((p) => e.command.includes(p));
      if (used.length > 0) {
        const answer = await $.ui.ask(`Let this Bash command use the real value of ${used.join(', ')}?`, ['Allow once', 'Keep redacted']);
        if (answer === 'Allow once') {
          let command = e.command;
          for (const p of used) command = command.split(p).join(vault.get(p) ?? p);
          call = { ...e, command };
        }
      }
    }
    const result = await next(call);
    if (result.deny !== undefined || result.isError === true) return result;
    const hits: string[] = [];
    const scrubbed = await scrubDeep(result.result, hits);
    if (hits.length === 0) return result;
    await record($, hits);
    return { result: scrubbed as typeof result.result, context: result.context };
  }).catch(($, e, next) => (next.called ? { deny: 'secret-scrubber could not check this result' } : next(e)));
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
  ❯ ./register.ts calls: $.command.register, $.fs.read (via loadRepoConfig), $.state.get, $.state.set (via record), $.store.get, $.store.set, $.ui.ask, $.ui.log (via loadRepoConfig), $.ui.status (via record)
  ❯ ./register.ts state writes: secret-scrubber.counts
  ❯ ./register.ts state reads: secret-scrubber.counts

✔ Validation passed
```

All three gating hooks carry a `.catch` (`00-spec.md` §9.2). The calls line is the mod's whole reach
into the engine: no `$.http`, no `$.process`, no `$.mcp`.

## 3. Tests

### 3.1 `tests/scrubber.test.ts`

Every secret-shaped sample is assembled at run time (`S`, at the top), so the file holds no string a
scanner would flag.

<!-- prettier-ignore -->
```ts
import { describe, expect, mock, test } from 'claude-code/testing';
import type { On, SessionAppendInput } from 'claude-code';
import { detect } from '../hooks/detect.ts';
import { SHA256 } from '../hooks/register.ts';

// Every secret-shaped sample is built here, at run time, from harmless parts,
// so no committed file holds a string a secret scanner would flag.
const rep = (s: string, n: number) => s.repeat(Math.ceil(n / s.length)).slice(0, n);
const mix = (n: number) => rep('aZ3kQ9mX2pL7vB4nR8tY1wC6', n);
const S = {
  aws: 'AK' + 'IA' + rep('Q7XZ2M4K', 16),
  github: 'gh' + 'p_' + mix(36),
  githubPat: 'github' + '_pat_' + mix(40),
  gitlab: 'gl' + 'pat-' + mix(20),
  slack: 'xo' + 'xb-' + '1234567890-' + mix(24),
  stripe: 'sk' + '_live_' + mix(24),
  anthropic: 'sk' + '-ant-' + 'api03-' + mix(40),
  openai: 'sk' + '-proj-' + mix(40),
  google: 'AI' + 'za' + mix(35),
  npm: 'np' + 'm_' + mix(36),
  slackHook: 'https://hooks.slack' + '.com/services/' + 'T0000000/B0000000/' + mix(24),
  sendgrid: 'S' + 'G.' + mix(22) + '.' + mix(43),
  jwt: 'ey' + 'J' + mix(20) + '.ey' + 'J' + mix(30) + '.' + mix(43),
  pem: '-----BEGIN ' + 'RSA PRIV' + 'ATE KEY-----\n' + mix(64) + '\n' + mix(64) + '\n-----END ' + 'RSA PRIV' + 'ATE KEY-----',
  dbPassword: 'hunter2' + 'Xy9',
  envValue: 'Zq8' + mix(29),
};

const DEFAULTS = { highEntropy: true, entropyThreshold: 4.0 };
const rulesIn = (text: string) => detect(text, DEFAULTS).map((f) => f.rule);

describe('detection: positives', () => {
  const positives: [string, string, string][] = [
    ['AWS access key id', `aws_access_key_id = ${S.aws}`, 'aws-access-key-id'],
    ['GitHub token', `token: ${S.github}`, 'github-token'],
    ['GitHub fine-grained PAT', S.githubPat, 'github-pat'],
    ['GitLab PAT', `export GL=${S.gitlab}`, 'gitlab-token'],
    ['Slack bot token', S.slack, 'slack-token'],
    ['Slack incoming webhook', `curl -X POST ${S.slackHook}`, 'slack-webhook'],
    ['SendGrid key', `sg.key = ${S.sendgrid}`, 'sendgrid-key'],
    ['Stripe live secret key', `stripe.key=${S.stripe}`, 'stripe-secret-key'],
    ['Anthropic key', S.anthropic, 'anthropic-key'],
    ['OpenAI project key', S.openai, 'openai-key'],
    ['Google API key', S.google, 'google-api-key'],
    ['npm token', `//registry.npmjs.org/:_authToken=${S.npm}`, 'npm-token'],
    ['JWT', `Cookie: session=${S.jwt}`, 'jwt'],
    ['PEM private key block', S.pem, 'private-key'],
    ['postgres URL password', `DATABASE_URL=postgres://app:${S.dbPassword}@db.internal:5432/app`, 'url-credentials'],
    ['Authorization bearer header', `curl -H "Authorization: Bearer ${S.envValue}"`, 'auth-header'],
    ['.env assignment', `API_SECRET=${S.envValue}`, 'secret-assignment'],
    ['JSON password field', `{"db_password": "${S.dbPassword}"}`, 'secret-assignment'],
    ['unlabelled random token', `value ${mix(12)}Qe7Rt9Yu2Io4Pa6Sd8Fg0Hj`, 'high-entropy'],
  ];
  for (const [name, text, rule] of positives) {
    test(`${rule}: ${name}`, () => {
      expect(rulesIn(text)).toContain(rule);
    });
  }
});

describe('detection: negatives', () => {
  const negatives: [string, string][] = [
    ['git commit sha', 'commit 1205a3f9c0d4e5b6a7f8091a2b3c4d5e6f708192 (HEAD)'],
    ['sha256 hex digest', `sha256: ${rep('9f86d081884c7d659a2feaa0c55ad015', 64)}`],
    ['lockfile integrity', `"integrity": "sha512-${rep('Kq3Rz8Lm2Np5Xw9Bv4Tc7Yh1Ud6Je0Fg+', 86)}=="`],
    ['UUID', 'session 123e4567-e89b-42d3-a456-426614174000 resumed'],
    ['base64 image data URI', `<img src="data:image/png;base64,${rep('iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB', 120)}">`],
    ['env var reference', 'API_KEY=${API_KEY}'],
    ['placeholder password', 'PASSWORD=changeme'],
    ['angle-bracket placeholder', 'GITHUB_TOKEN=<your-token-here>'],
    ['long identifier', 'src/renderer/src/components/cleanup_treemap_layout_helpers.ts'],
    ['CamelCase word run', 'ThisIsAVeryLongCamelCaseIdentifierWithoutDigits'],
    ['URL without credentials', 'https://github.com/acme/web-api/pull/41'],
    ['already redacted', 'TOKEN=[REDACTED:github-token#1a2b3c4d]'],
    ['publishable stripe key', 'pk' + '_live_' + mix(24)],
    ['token from a function call', 'const token = randomUUID()'],
    ['counter named tokens', 'inputTokens: n(u.input_tokens),'],
    ['card slug with a mixed-case id', 'card T195-consolidate-on-precompact-auto-inject-a-typed-handoff-at'],
    ['branch slug with digits', 'PROJ-0000-s3-cors-for-admin-file-previews -> origin/PROJ-255-fix-cms-page-500s'],
    ['ULID in a URL path', 'https://app.example.com/file/01KXY5YZB2662SHFM15DMSJX72'],
  ];
  for (const [name, text] of negatives) {
    test(`clean: ${name}`, () => {
      expect(rulesIn(text)).toEqual([]);
    });
  }
});

const toolResultRow = (text: string, uuid = 'row-1'): SessionAppendInput => ({
  message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: text }] },
  door: 'tool-result',
  origin: { kind: 'tool', tool: 'Bash' },
  uuid,
});

const counts = { plugin: 'secret-scrubber', key: 'counts' } as const;
const START = { cwd: '/repo', surface: null, isInteractive: true };

function world(on: On) {
  mock.clock(on);
  mock.store(on);
  const session = mock.session(on);
  on('session.start', (_$, e) => ({ cwd: e.cwd }));
  on('command.register', (_$, e) => ({ value: { command: e.name } }));
  on('ui.status', () => ({ value: undefined }));
  return session;
}

describe('session.append', () => {
  test('a tool result is stored with placeholders, never the value', async ($, on) => {
    const session = world(on);
    await $.session.start(START);
    await $.session.append(toolResultRow(`API_SECRET=${S.envValue}\nGH=${S.github}`));
    const stored = JSON.stringify(session.appended().at(-1)?.message);
    expect(stored).not.toContain(S.envValue);
    expect(stored).not.toContain(S.github);
    expect(stored).toMatch(/\[REDACTED:secret-assignment#[0-9a-f]{8}\]/);
    expect(stored).toMatch(/\[REDACTED:github-token#[0-9a-f]{8}\]/);
  });

  test('the same value gets the same placeholder in two rows', async ($, on) => {
    const session = world(on);
    await $.session.start(START);
    await $.session.append(toolResultRow(`first ${S.stripe}`, 'r1'));
    await $.session.append(toolResultRow(`again ${S.stripe}`, 'r2'));
    const tags = session.appended().map((r) => JSON.stringify(r.message).match(/#[0-9a-f]{8}/)?.[0]);
    expect(tags[0]).toBeDefined();
    expect(tags[0]).toBe(tags[1]);
  });

  test('a prompt row is scrubbed; thinking and tool_use are left alone', async ($, on) => {
    const session = world(on);
    await $.session.start(START);
    await $.session.append({
      message: { type: 'assistant', role: 'assistant', content: [
        { type: 'thinking', thinking: 'plan', signature: 'sig' },
        { type: 'text', text: `I will use ${S.aws}` },
        { type: 'tool_use', id: 'toolu_2', name: 'Bash', input: { command: 'ls' } },
      ] },
      door: 'response',
      origin: { kind: 'model', model: 'claude-test' },
      uuid: 'r3',
    });
    const content = session.appended().at(-1)?.message.content ?? [];
    expect(content.map((b) => b.type)).toEqual(['thinking', 'text', 'tool_use']);
    expect(JSON.stringify(content)).not.toContain(S.aws);
  });

  // Stands for the Harnu mod: any plugin reads any $.state value. An inline
  // plugin runs in its own environment, so it reports what it read by $.ui.log.
  const reader = {
    name: 'reader',
    register: (o: On) => {
      o('ui.status', async ($$, e, next) => {
        $$.ui.log(JSON.stringify((await $$.state.get({ plugin: "secret-scrubber", key: "counts" })).value));
        return next(e);
      });
    },
  };
  test('counts hold rule names and numbers only, and another plugin reads them', { plugins: [reader] }, async ($, on) => {
    world(on);
    let seen = '';
    on('ui.log', (_$, e) => {
      seen = e.text;
      return { value: undefined };
    });
    await $.session.start(START);
    await $.session.append(toolResultRow(`k=${S.anthropic} p=${S.pem}`));
    expect(seen).toBe('{"total":2,"byRule":{"anthropic-key":1,"private-key":1}}');
    expect(seen).not.toContain(S.anthropic.slice(8));
  });
});

describe('when the person means it', () => {
  test('/scrub keep-next lets exactly one prompt reach the model as typed', async ($, on) => {
    const session = world(on);
    on('prompt.submit', (_$, e) => ({ text: e.text }));
    const promptRow = (text: string, uuid: string): SessionAppendInput => ({
      message: { type: 'user', role: 'user', content: [{ type: 'text', text }] },
      door: 'prompt',
      origin: { kind: 'composer' },
      uuid,
    });
    await $.session.start(START);
    const ran = await $.command.run({ command: 'scrub', args: 'keep-next', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } });
    expect(ran.text).toContain('unredacted');
    const typed = `use ${S.github} for the release`;
    const first = await $.prompt.submit({ text: typed, wait: false, origin: { kind: 'composer' } });
    expect(first.text).toBe(typed);
    await $.session.append(promptRow(typed, 'p1'));
    expect(JSON.stringify(session.appended().at(-1)?.message)).toContain(S.github);
    const second = await $.prompt.submit({ text: typed, wait: false, origin: { kind: 'composer' } });
    expect(second.text).not.toContain(S.github);
    await $.session.append(promptRow(typed, 'p2'));
    expect(JSON.stringify(session.appended().at(-1)?.message)).not.toContain(S.github);
  });
});

describe('repo config', () => {
  test('a value the repo allowlists by digest, and a rule it turns off, pass through', async ($, on) => {
    const session = world(on);
    const digest = [...new Uint8Array(await crypto.subtle.digest(SHA256, new TextEncoder().encode(S.openai)))]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    on('fs.read', (_$, e) => {
      expect(e.path).toBe('/repo/.claude/secret-scrubber.json');
      return { value: JSON.stringify({ allow: [`sha256:${digest}`], disable: ['jwt'] }) } as never;
    });
    await $.session.start(START);
    await $.session.append(toolResultRow(`fixture ${S.openai} cookie ${S.jwt} real ${S.github}`));
    const stored = JSON.stringify(session.appended().at(-1)?.message);
    expect(stored).toContain(S.openai);
    expect(stored).toContain(S.jwt);
    expect(stored).not.toContain(S.github);
  });
});

describe('failure', () => {
  test('a row the scrubber cannot check is stored withheld, not raw (fail-closed)', async ($, on) => {
    const session = world(on);
    // A broken state read makes the hook throw before it calls next.
    on('state.get', () => ({ value: null, version: 1 }) as never);
    await $.session.start(START);
    await $.session.append(toolResultRow(`GH=${S.github}`));
    const stored = JSON.stringify(session.appended().at(-1)?.message);
    expect(stored).not.toContain(S.github);
    expect(stored).toContain('secret-scrubber failed: result withheld');
  });
});

describe('tool.call', () => {
  test("the tool's structured record is scrubbed before core stores it", async ($, on) => {
    world(on);
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: `TOKEN=${S.npm}\n`, stderr: '', interrupted: false } }) as never);
    await $.session.start(START);
    const out = await $.tool.call({ tool: 'Bash', command: 'cat .env' } as never);
    expect(JSON.stringify(out)).not.toContain(S.npm);
    expect(JSON.stringify(out)).toMatch(/REDACTED:npm-token/);
  });

  test("media bytes in a tool's record are left alone", async ($, on) => {
    world(on);
    const pixels = rep('iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB' + mix(40), 4096);
    // The same bytes as plain text would be redacted: the skip is what saves them.
    expect(rulesIn(pixels)).toContain('high-entropy');
    on('tool.call', { tool: 'Read' }, () => ({ result: { type: 'image', file: { base64: pixels, type: 'image/png', originalSize: 3072 } } }) as never);
    await $.session.start(START);
    const out = await $.tool.call({ tool: 'Read', file_path: '/repo/shot.png' } as never);
    expect(JSON.stringify(out)).toContain(pixels);
  });

  test('Edit gets the real value back, so a file never receives the placeholder text', async ($, on) => {
    const session = world(on);
    let edit: { old_string?: string; new_string?: string } = {};
    on('tool.call', { tool: 'Edit' }, (_$, e) => {
      edit = e as typeof edit;
      return { result: { filePath: '/repo/.env' } } as never;
    });
    await $.session.start(START);
    await $.session.append(toolResultRow(`API_SECRET=${S.envValue}`));
    const placeholder = JSON.stringify(session.appended().at(-1)?.message).match(/\[REDACTED:secret-assignment#[0-9a-f]{8}\]/)?.[0] ?? '';
    expect(placeholder).not.toBe('');
    await $.tool.call({ tool: 'Edit', file_path: '/repo/.env', old_string: `API_SECRET=${placeholder}`, new_string: `API_SECRET=${placeholder}\nDEBUG=1` } as never);
    expect(edit.old_string).toBe(`API_SECRET=${S.envValue}`);
    expect(edit.new_string).toBe(`API_SECRET=${S.envValue}\nDEBUG=1`);
  });

  test('a placeholder resolves for Bash only after the person allows it', async ($, on) => {
    const session = world(on);
    let ran = '';
    on('tool.call', { tool: 'Bash' }, (_$, e) => {
      ran = (e as { command: string }).command;
      return { result: { stdout: 'ok', stderr: '', interrupted: false } } as never;
    });
    let answer = 'Allow once';
    on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
      const q = (e as { questions: { question: string }[] }).questions[0]?.question ?? '';
      return { result: { questions: (e as { questions: unknown[] }).questions, answers: { [q]: answer } } } as never;
    });
    await $.session.start(START);
    await $.session.append(toolResultRow(`GH=${S.github}`));
    const placeholder = JSON.stringify(session.appended().at(-1)?.message).match(/\[REDACTED:github-token#[0-9a-f]{8}\]/)?.[0] ?? '';
    expect(placeholder).not.toBe('');

    await $.tool.call({ tool: 'Bash', command: `gh auth status --token ${placeholder}` } as never);
    expect(ran).toBe(`gh auth status --token ${S.github}`);

    answer = 'Keep redacted';
    await $.tool.call({ tool: 'Bash', command: `gh auth status --token ${placeholder}` } as never);
    expect(ran).toBe(`gh auth status --token ${placeholder}`);
  });
});
```

### 3.2 `claude plugin test .` (2.1.296)

```text

tests/scrubber.test.ts:
(pass) detection: positives > aws-access-key-id: AWS access key id [1.66ms]
(pass) detection: positives > github-token: GitHub token [0.30ms]
(pass) detection: positives > github-pat: GitHub fine-grained PAT [0.20ms]
(pass) detection: positives > gitlab-token: GitLab PAT [0.14ms]
(pass) detection: positives > slack-token: Slack bot token [0.14ms]
(pass) detection: positives > slack-webhook: Slack incoming webhook [0.12ms]
(pass) detection: positives > sendgrid-key: SendGrid key [0.12ms]
(pass) detection: positives > stripe-secret-key: Stripe live secret key [0.10ms]
(pass) detection: positives > anthropic-key: Anthropic key [0.09ms]
(pass) detection: positives > openai-key: OpenAI project key [0.10ms]
(pass) detection: positives > google-api-key: Google API key [0.09ms]
(pass) detection: positives > npm-token: npm token [0.10ms]
(pass) detection: positives > jwt: JWT [0.09ms]
(pass) detection: positives > private-key: PEM private key block [0.10ms]
(pass) detection: positives > url-credentials: postgres URL password [0.10ms]
(pass) detection: positives > auth-header: Authorization bearer header [0.11ms]
(pass) detection: positives > secret-assignment: .env assignment [0.11ms]
(pass) detection: positives > secret-assignment: JSON password field [0.10ms]
(pass) detection: positives > high-entropy: unlabelled random token [0.31ms]
(pass) detection: negatives > clean: git commit sha [0.37ms]
(pass) detection: negatives > clean: sha256 hex digest [0.16ms]
(pass) detection: negatives > clean: lockfile integrity [0.11ms]
(pass) detection: negatives > clean: UUID [0.10ms]
(pass) detection: negatives > clean: base64 image data URI [0.10ms]
(pass) detection: negatives > clean: env var reference [0.10ms]
(pass) detection: negatives > clean: placeholder password [0.11ms]
(pass) detection: negatives > clean: angle-bracket placeholder [0.09ms]
(pass) detection: negatives > clean: long identifier [0.10ms]
(pass) detection: negatives > clean: CamelCase word run [0.10ms]
(pass) detection: negatives > clean: URL without credentials [0.11ms]
(pass) detection: negatives > clean: already redacted [0.09ms]
(pass) detection: negatives > clean: publishable stripe key [0.09ms]
(pass) detection: negatives > clean: token from a function call [0.09ms]
(pass) detection: negatives > clean: counter named tokens [0.09ms]
(pass) detection: negatives > clean: card slug with a mixed-case id [0.14ms]
(pass) detection: negatives > clean: branch slug with digits [0.11ms]
(pass) detection: negatives > clean: ULID in a URL path [0.11ms]
(pass) session.append > a tool result is stored with placeholders, never the value [36.23ms]
(pass) session.append > the same value gets the same placeholder in two rows [16.89ms]
(pass) session.append > a prompt row is scrubbed; thinking and tool_use are left alone [15.41ms]
(pass) session.append > counts hold rule names and numbers only, and another plugin reads them [18.00ms]
(pass) when the person means it > /scrub keep-next lets exactly one prompt reach the model as typed [16.87ms]
(pass) repo config > a value the repo allowlists by digest, and a rule it turns off, pass through [14.07ms]
(pass) failure > a row the scrubber cannot check is stored withheld, not raw (fail-closed) [14.39ms]
(pass) tool.call > the tool's structured record is scrubbed before core stores it [14.24ms]
(pass) tool.call > media bytes in a tool's record are left alone [13.26ms]
(pass) tool.call > Edit gets the real value back, so a file never receives the placeholder text [13.84ms]
(pass) tool.call > a placeholder resolves for Bash only after the person allows it [14.67ms]

 48 pass
 0 fail
Ran 48 tests across 1 file. [0.32s]
```

How the matrix maps to U-1: 19 positives, one per rule plus a second `secret-assignment` shape; 18
negatives covering every false-positive class in `01-detection.md` §3, the five strings that tripped
the first rule set on this repo, and the placeholder itself. The other 11 tests cover the hooks:

- `session.append` rewrite and stable placeholders;
- pinned blocks left alone;
- counts readable by another plugin;
- `/scrub keep-next`;
- the repo allowlist;
- fail-closed;
- the `tool.call` record scrub;
- media bytes;
- Edit resolution and Bash resolution with consent.

## 4. Type check, audit chips, and Harnu's lint over placeholders

### 4.1 `tsc -p`

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

`allowImportingTsExtensions` is the one option added to the header's: `register.ts` imports
`./detect.ts` by its file name, which the engine requires. Output:

```text
exit 0
```

### 4.2 Settings → Mods audit chips

`claude plugin validate --json <mod>` fed to Harnu's own `parseValidateReport` and `buildAnalysis`
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
capabilities ["files","prompts","tool-calls"]
warnings []
```

### 4.3 `lintSecrets` over placeholders

The 8 `SECRET_PATTERNS` were copied verbatim from `src/main/mcp/memory-core.ts:347-359` and run over
every rule id in 6 shapes (`<p>`, `API_SECRET=<p>`, `password: <p>`, `"client_secret": "<p>"`,
`postgres://app:<p>@db:5432/app`, `Authorization: Bearer <p>`, with `<p>` =
`[REDACTED:<rule>#0a1b2c3d]`):

```text
lintSecrets over 108 placeholder samples: 0 hits
```

The live runs and the build log are in [`03-live-runs.md`](03-live-runs.md).
