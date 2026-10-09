# T450 — The prototype's tests (U-1 matrix, C-5)

Part of [`00-spec.md`](00-spec.md). The mod under test is in [`02-prototype.md`](02-prototype.md).

## 1. `tests/scrubber.test.ts`

Every secret-shaped sample is assembled at run time (`S`, at the top), so the file holds no string a
scanner would flag. `world()` is the engine beneath the plugin:

- a held clock;
- a store seeded with a fixed salt, so a test can compute the placeholder it expects;
- the session recorder;
- answers for `session.start`, `command.register`, `ui.status` and `ui.toast`;
- a `git` stand-in that answers `ls-files` and `check-ignore` by path.

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
    ['SSH public key', `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${mix(43)} dev@laptop`],
    ['go.sum hash', `github.com/pkg/errors v0.9.1 h1:${mix(43)}=`],
    ['CSP nonce', `script-src 'nonce-${mix(32)}'`],
    ['certificate body', `-----BEGIN CERTIFICATE-----\nMIIDdzCC${mix(56)}\n${mix(64)}\n-----END CERTIFICATE-----`],
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

const START = { cwd: '/repo', surface: null, isInteractive: true };
const SALT = 'test-salt';
const PRESENT = { presentation: { isFullscreen: false, columns: 80 }, origin: { kind: 'composer' } } as const;

async function placeholderOf(rule: string, value: string): Promise<string> {
  const digest = await crypto.subtle.digest(SHA256, new TextEncoder().encode(SALT + value));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `[REDACTED:${rule}#${hex.slice(0, 8)}]`;
}

// The world beneath the plugin. `git` answers by the path it is asked about:
// `tracked` paths are in the index, `ignored` ones are gitignored.
function world(on: On, git: { tracked?: string[]; ignored?: string[] } = {}) {
  const clock = mock.clock(on);
  mock.store(on, { salt: SALT });
  const session = mock.session(on);
  const toasts: string[] = [];
  on('session.start', (_$, e) => ({ cwd: e.cwd }));
  on('command.register', (_$, e) => ({ value: { command: e.name } }));
  on('ui.status', () => ({ value: undefined }));
  on('ui.toast', (_$, e) => {
    toasts.push(e.text);
    return { value: undefined };
  });
  on('process.run', (_$, e) => {
    const path = e.argv.at(-1) ?? '';
    const yes = e.argv[1] === 'ls-files' ? (git.tracked ?? []).includes(path) : (git.ignored ?? []).includes(path);
    return { value: { exitCode: yes ? 0 : 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never;
  });
  return { session, clock, toasts };
}

describe('session.append', () => {
  test('a tool result is stored with placeholders, never the value', async ($, on) => {
    const { session } = world(on);
    await $.session.start(START);
    await $.session.append(toolResultRow(`API_SECRET=${S.envValue}\nGH=${S.github}`));
    const stored = JSON.stringify(session.appended().at(-1)?.message);
    expect(stored).not.toContain(S.envValue);
    expect(stored).not.toContain(S.github);
    expect(stored).toContain(await placeholderOf('secret-assignment', S.envValue));
    expect(stored).toContain(await placeholderOf('github-token', S.github));
  });

  test('the same value gets the same placeholder in two rows', async ($, on) => {
    const { session } = world(on);
    await $.session.start(START);
    await $.session.append(toolResultRow(`first ${S.stripe}`, 'r1'));
    await $.session.append(toolResultRow(`again ${S.stripe}`, 'r2'));
    const tags = session.appended().map((r) => JSON.stringify(r.message).match(/#[0-9a-f]{8}/)?.[0]);
    expect(tags[0]).toBeDefined();
    expect(tags[0]).toBe(tags[1]);
  });

  test('a value seen once is caught by its literal in a new context', async ($, on) => {
    const { session } = world(on);
    await $.session.start(START);
    await $.session.append(toolResultRow(`DATABASE_URL=postgres://app:${S.dbPassword}@db:5432/app`, 'r1'));
    // No rule matches the bare word here: only the vault's literal does.
    expect(rulesIn(`the password is ${S.dbPassword}, keep it`)).toEqual([]);
    await $.session.append(toolResultRow(`the password is ${S.dbPassword}, keep it`, 'r2'));
    const stored = JSON.stringify(session.appended().at(-1)?.message);
    expect(stored).not.toContain(S.dbPassword);
    expect(stored).toContain(await placeholderOf('url-credentials', S.dbPassword));
  });

  test('a prompt row is scrubbed; thinking and tool_use are left alone', async ($, on) => {
    const { session } = world(on);
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
    expect(seen).toBe('{"total":2,"byRule":{"anthropic-key":1,"private-key":1},"off":false,"tripped":false}');
    expect(seen).not.toContain(S.anthropic.slice(8));
  });
});

describe('when the person means it', () => {
  test('/scrub keep-next lets exactly one prompt reach the model as typed', async ($, on) => {
    const { session } = world(on);
    on('prompt.submit', (_$, e) => ({ text: e.text }));
    const promptRow = (text: string, uuid: string): SessionAppendInput => ({
      message: { type: 'user', role: 'user', content: [{ type: 'text', text }] },
      door: 'prompt',
      origin: { kind: 'composer' },
      uuid,
    });
    await $.session.start(START);
    const ran = await $.command.run({ command: 'scrub', args: 'keep-next', ...PRESENT });
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
    const { session } = world(on);
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
  // A row whose result holds a null block makes the scrub throw before `next`.
  const broken: SessionAppendInput = {
    message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_9', content: [null, { type: 'text', text: `GH=${S.github}` }] }] },
    door: 'tool-result',
    origin: { kind: 'tool', tool: 'Bash' },
    uuid: 'bad',
  } as never;

  test('a row the scrubber cannot check is stored withheld, not raw (fail-closed)', async ($, on) => {
    const { session } = world(on);
    await $.session.start(START);
    await $.session.append(broken);
    const stored = JSON.stringify(session.appended().at(-1)?.message);
    expect(stored).not.toContain(S.github);
    expect(stored).toContain('secret-scrubber failed: result withheld');
  });

  test('a failed count write never withholds a row (bookkeeping fails open)', async ($, on) => {
    const { session } = world(on);
    on('state.get', () => ({ value: null, version: 1 }) as never);
    await $.session.start(START);
    await $.session.append(toolResultRow(`GH=${S.github}`));
    const stored = JSON.stringify(session.appended().at(-1)?.message);
    expect(stored).toContain(await placeholderOf('github-token', S.github));
    expect(stored).not.toContain('withheld');
  });

  test('three failures in a row trip the breaker: the person is told how to turn it off', async ($, on) => {
    const { toasts } = world(on);
    await $.session.start(START);
    for (const uuid of ['b1', 'b2']) await $.session.append({ ...broken, uuid });
    expect(toasts).toEqual([]);
    await $.session.append({ ...broken, uuid: 'b3' });
    expect(toasts.length).toBe(1);
    expect(toasts[0]).toContain('/scrub off');
  });

  test('/scrub off passes rows through and leaves a notice in the transcript', async ($, on) => {
    const { session } = world(on);
    await $.session.start(START);
    const ran = await $.command.run({ command: 'scrub', args: 'off', ...PRESENT });
    expect(ran.text).toContain('off');
    const notice = session.appended().find((r) => r.door === 'note');
    expect(JSON.stringify(notice?.message)).toContain('Secret scrubbing is off for this session (/scrub off)');
    await $.session.append(toolResultRow(`GH=${S.github}`));
    expect(JSON.stringify(session.appended().at(-1)?.message)).toContain(S.github);
  });

  test("Harnu's flag file turns a running session off within one 5 s check", async ($, on) => {
    const { session, clock } = world(on);
    let flagged = false;
    const asked: string[] = [];
    on('fs.exists', (_$, e) => {
      asked.push(e.path);
      return { value: flagged && e.path.endsWith('/scrubber-off') } as never;
    });
    await $.session.start(START);
    await $.session.append(toolResultRow(`GH=${S.github}`, 'before'));
    expect(JSON.stringify(session.appended().at(-1)?.message)).not.toContain(S.github);
    flagged = true;
    await clock.advance(5000);
    expect(asked.length).toBe(1);
    expect(asked[0]).toMatch(/scrubber-off$/);
    await $.session.append(toolResultRow(`GH=${S.github}`, 'after'));
    expect(JSON.stringify(session.appended().at(-1)?.message)).toContain(S.github);
    expect(JSON.stringify(session.appended())).toContain('(Harnu Settings)');
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

  test('an errored result that holds a secret becomes a deny carrying the redacted text', async ($, on) => {
    world(on);
    on('tool.call', { tool: 'Bash' }, () => ({ isError: true, result: `Error: Exit code 3\nAPI_SECRET=${S.envValue}`, text: `Exit code 3\nAPI_SECRET=${S.envValue}` }) as never);
    await $.session.start(START);
    const out = (await $.tool.call({ tool: 'Bash', command: 'cat fixture.env; exit 3' } as never)) as { deny?: string };
    expect(out.deny).toContain('ran and failed');
    expect(out.deny).toContain(await placeholderOf('secret-assignment', S.envValue));
    expect(JSON.stringify(out)).not.toContain(S.envValue);
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
});

describe('resolution', () => {
  const editOf = (path: string, placeholder: string) =>
    ({ tool: 'Edit', file_path: path, old_string: `API_SECRET=${placeholder}`, new_string: `API_SECRET=${placeholder}\nDEBUG=1` }) as never;

  test('into a gitignored file the real value goes back with no question', async ($, on) => {
    world(on, { ignored: ['/repo/.env'] });
    let edit: { old_string?: string; new_string?: string } = {};
    on('tool.call', { tool: 'Edit' }, (_$, e) => {
      edit = e as typeof edit;
      return { result: { filePath: '/repo/.env' } } as never;
    });
    await $.session.start(START);
    await $.session.append(toolResultRow(`API_SECRET=${S.envValue}`));
    const p = await placeholderOf('secret-assignment', S.envValue);
    const out = (await $.tool.call(editOf('/repo/.env', p))) as { context?: readonly string[] };
    expect(out.context?.join(' ')).toContain('put the real value back');
    expect(edit.old_string).toBe(`API_SECRET=${S.envValue}`);
    expect(edit.new_string).toBe(`API_SECRET=${S.envValue}\nDEBUG=1`);
  });

  test('into a tracked file it is refused, and nothing is written', async ($, on) => {
    world(on, { tracked: ['/repo/src/config.ts'] });
    let wrote = false;
    on('tool.call', { tool: 'Edit' }, () => {
      wrote = true;
      return { result: {} } as never;
    });
    await $.session.start(START);
    await $.session.append(toolResultRow(`API_SECRET=${S.envValue}`));
    const out = (await $.tool.call(editOf('/repo/src/config.ts', await placeholderOf('secret-assignment', S.envValue)))) as { deny?: string };
    expect(out.deny).toContain('tracked by git');
    expect(wrote).toBe(false);
  });

  test('into any other path the person is asked; "Keep redacted" writes nothing', async ($, on) => {
    world(on);
    let asked = '';
    let answer = 'Keep redacted';
    on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
      const q = (e as { questions: { question: string }[] }).questions[0]?.question ?? '';
      asked = q;
      return { result: { questions: (e as { questions: unknown[] }).questions, answers: { [q]: answer } } } as never;
    });
    let written = '';
    on('tool.call', { tool: 'Write' }, (_$, e) => {
      written = (e as { content: string }).content;
      return { result: {} } as never;
    });
    await $.session.start(START);
    await $.session.append(toolResultRow(`API_SECRET=${S.envValue}`));
    const p = await placeholderOf('secret-assignment', S.envValue);
    const out = (await $.tool.call({ tool: 'Write', file_path: '/tmp/x', content: p } as never)) as { deny?: string };
    expect(asked).toContain('/tmp/x');
    expect(out.deny).toContain('Nothing was written');
    expect(written).toBe('');
    answer = 'Allow once';
    await $.tool.call({ tool: 'Write', file_path: '/tmp/x', content: p } as never);
    expect(written).toBe(S.envValue);
  });

  test('with nobody to answer the question (a -p run), nothing is written', async ($, on) => {
    world(on);
    // No AskUserQuestion hook: the ask rejects, as it does in a headless run.
    let wrote = false;
    on('tool.call', { tool: 'Write' }, () => {
      wrote = true;
      return { result: {} } as never;
    });
    await $.session.start(START);
    await $.session.append(toolResultRow(`API_SECRET=${S.envValue}`));
    const p = await placeholderOf('secret-assignment', S.envValue);
    const out = (await $.tool.call({ tool: 'Write', file_path: '/tmp/x', content: p } as never)) as { deny?: string };
    expect(out.deny).toContain('Nothing ran');
    expect(wrote).toBe(false);
  });

  test('a path the repo lists under resolveInto resolves with no question', async ($, on) => {
    world(on);
    on('fs.read', () => ({ value: JSON.stringify({ resolveInto: ['config/local.env'] }) }) as never);
    let written = '';
    on('tool.call', { tool: 'Write' }, (_$, e) => {
      written = (e as { content: string }).content;
      return { result: {} } as never;
    });
    await $.session.start(START);
    await $.session.append(toolResultRow(`API_SECRET=${S.envValue}`));
    await $.tool.call({ tool: 'Write', file_path: '/repo/config/local.env', content: await placeholderOf('secret-assignment', S.envValue) } as never);
    expect(written).toBe(S.envValue);
  });

  test('a placeholder this session cannot resolve (resumed, parked, reloaded) stops the write; re-reading restores it', async ($, on) => {
    world(on, { ignored: ['/repo/.env'] });
    let written = '';
    on('tool.call', { tool: 'Write' }, (_$, e) => {
      written = (e as { content: string }).content;
      return { result: {} } as never;
    });
    await $.session.start(START);
    // The salt persisted in $.store, so the placeholder is the one minted before.
    const p = await placeholderOf('secret-assignment', S.envValue);
    const write = { tool: 'Write', file_path: '/repo/.env', content: `API_SECRET=${p}\n` } as never;
    const refused = (await $.tool.call(write)) as { deny?: string };
    expect(refused.deny).toContain('not known in this session');
    expect(written).toBe('');
    await $.session.append(toolResultRow(`API_SECRET=${S.envValue}`));
    await $.tool.call(write);
    expect(written).toBe(`API_SECRET=${S.envValue}\n`);
  });

  test('a placeholder resolves for Bash only after the person allows it', async ($, on) => {
    const { session } = world(on);
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

## 2. `claude plugin test .` (2.1.296)

```text

tests/scrubber.test.ts:
(pass) detection: positives > aws-access-key-id: AWS access key id [1.65ms]
(pass) detection: positives > github-token: GitHub token [0.32ms]
(pass) detection: positives > github-pat: GitHub fine-grained PAT [0.16ms]
(pass) detection: positives > gitlab-token: GitLab PAT [0.13ms]
(pass) detection: positives > slack-token: Slack bot token [0.11ms]
(pass) detection: positives > slack-webhook: Slack incoming webhook [0.12ms]
(pass) detection: positives > sendgrid-key: SendGrid key [0.11ms]
(pass) detection: positives > stripe-secret-key: Stripe live secret key [0.10ms]
(pass) detection: positives > anthropic-key: Anthropic key [0.10ms]
(pass) detection: positives > openai-key: OpenAI project key [0.09ms]
(pass) detection: positives > google-api-key: Google API key [0.11ms]
(pass) detection: positives > npm-token: npm token [0.10ms]
(pass) detection: positives > jwt: JWT [0.10ms]
(pass) detection: positives > private-key: PEM private key block [0.09ms]
(pass) detection: positives > url-credentials: postgres URL password [0.11ms]
(pass) detection: positives > auth-header: Authorization bearer header [0.11ms]
(pass) detection: positives > secret-assignment: .env assignment [0.11ms]
(pass) detection: positives > secret-assignment: JSON password field [0.11ms]
(pass) detection: positives > high-entropy: unlabelled random token [0.33ms]
(pass) detection: negatives > clean: git commit sha [0.38ms]
(pass) detection: negatives > clean: sha256 hex digest [0.16ms]
(pass) detection: negatives > clean: lockfile integrity [0.12ms]
(pass) detection: negatives > clean: UUID [0.10ms]
(pass) detection: negatives > clean: base64 image data URI [0.11ms]
(pass) detection: negatives > clean: env var reference [0.10ms]
(pass) detection: negatives > clean: placeholder password [0.10ms]
(pass) detection: negatives > clean: angle-bracket placeholder [0.09ms]
(pass) detection: negatives > clean: long identifier [0.09ms]
(pass) detection: negatives > clean: CamelCase word run [0.10ms]
(pass) detection: negatives > clean: URL without credentials [0.10ms]
(pass) detection: negatives > clean: already redacted [0.09ms]
(pass) detection: negatives > clean: publishable stripe key [0.09ms]
(pass) detection: negatives > clean: token from a function call [0.09ms]
(pass) detection: negatives > clean: counter named tokens [0.12ms]
(pass) detection: negatives > clean: card slug with a mixed-case id [0.14ms]
(pass) detection: negatives > clean: branch slug with digits [0.11ms]
(pass) detection: negatives > clean: ULID in a URL path [0.11ms]
(pass) detection: negatives > clean: SSH public key [0.09ms]
(pass) detection: negatives > clean: go.sum hash [0.09ms]
(pass) detection: negatives > clean: CSP nonce [0.10ms]
(pass) detection: negatives > clean: certificate body [0.11ms]
(pass) session.append > a tool result is stored with placeholders, never the value [37.23ms]
(pass) session.append > the same value gets the same placeholder in two rows [29.79ms]
(pass) session.append > a value seen once is caught by its literal in a new context [17.52ms]
(pass) session.append > a prompt row is scrubbed; thinking and tool_use are left alone [15.88ms]
(pass) session.append > counts hold rule names and numbers only, and another plugin reads them [18.72ms]
(pass) when the person means it > /scrub keep-next lets exactly one prompt reach the model as typed [16.89ms]
(pass) repo config > a value the repo allowlists by digest, and a rule it turns off, pass through [15.07ms]
(pass) failure > a row the scrubber cannot check is stored withheld, not raw (fail-closed) [13.70ms]
(pass) failure > a failed count write never withholds a row (bookkeeping fails open) [14.54ms]
(pass) failure > three failures in a row trip the breaker: the person is told how to turn it off [15.77ms]
(pass) failure > /scrub off passes rows through and leaves a notice in the transcript [15.34ms]
(pass) failure > Harnu's flag file turns a running session off within one 5 s check [15.73ms]
(pass) tool.call > the tool's structured record is scrubbed before core stores it [25.08ms]
(pass) tool.call > an errored result that holds a secret becomes a deny carrying the redacted text [13.75ms]
(pass) tool.call > media bytes in a tool's record are left alone [14.52ms]
(pass) resolution > into a gitignored file the real value goes back with no question [16.27ms]
(pass) resolution > into a tracked file it is refused, and nothing is written [14.61ms]
(pass) resolution > into any other path the person is asked; "Keep redacted" writes nothing [19.86ms]
(pass) resolution > with nobody to answer the question (a -p run), nothing is written [18.86ms]
(pass) resolution > a path the repo lists under resolveInto resolves with no question [15.16ms]
(pass) resolution > a placeholder this session cannot resolve (resumed, parked, reloaded) stops the write; re-reading restores it [14.90ms]
(pass) resolution > a placeholder resolves for Bash only after the person allows it [15.07ms]

 63 pass
 0 fail
Ran 63 tests across 1 file. [0.52s]
```

## 3. What the tests cover

**Detection matrix (U-1).**

- **19 positives:** one per rule, plus a second `secret-assignment` shape.
- **22 negatives:** every false-positive class in `01-detection.md` §3, including the five public
  shapes a verifier probed in round 1 (an SSH public key, a `go.sum` hash, a CSP nonce, a certificate
  body and a ULID), plus the placeholder itself.

**Behaviour tests (22).**

| Group                    | What it proves                                                                                                                                                                                                                                                                      |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session.append`         | A row is stored with placeholders. A value keeps its placeholder across rows. A value seen once is caught by its literal in a context no rule matches. Pinned blocks are left alone. Counts hold no value or tag, and another plugin reads them.                                    |
| when the person means it | `/scrub keep-next` lets exactly one prompt through.                                                                                                                                                                                                                                 |
| repo config              | Digest allowlist and `disable` work.                                                                                                                                                                                                                                                |
| failure                  | Fail-closed on a safety failure. Fail-open on a bookkeeping failure. The breaker trips at three with a toast naming `/scrub off`. `/scrub off` passes rows and leaves a notice. Harnu's flag file turns a running session off within one 5 s check.                                 |
| `tool.call`              | The structured record is scrubbed. An errored result with a secret becomes a deny carrying the redacted text. Media bytes are skipped.                                                                                                                                              |
| resolution               | Gitignored → silent, with a context note to the model. Tracked → refused. Other path → asked; "Keep redacted" writes nothing. Nobody to ask → refused. `resolveInto` → silent. Unknown placeholder (resumed, parked, reloaded) → refused, then restored by a re-read. Bash → asked. |
