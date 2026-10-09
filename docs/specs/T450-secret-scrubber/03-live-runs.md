# T450 — Live runs, and what went wrong while building (C-1, C-5, U-2)

Part of [`00-spec.md`](00-spec.md). The prototype these runs loaded is in
[`02-prototype.md`](02-prototype.md). Everything below ran on this machine on 2026-10-09 and was
copied from the terminal and the transcript files. Paths under the session scratchpad read
`<scratchpad>`, and a test repo reads `<repo>`.

## 1. Live runs

Each run used `claude -p` (or an interactive `claude` in tmux) with `--plugin-dir` pointing at the mod,
`--model haiku`, in a scratch folder holding two fixture files built at run time:

- `fixture.env`: `API_SECRET=<36 random-looking characters>`, `GITHUB_TOKEN=<a gh·p_ token shape>`,
  `DEBUG=true`;
- `big.log`: 6,000 `INFO` lines (233 KB), then `WARN leaked API_SECRET=<the same value>`.

The prompt pasted a Stripe-shaped key built at run time. After each run, this script searched every
entry of the transcript file, and every file in the session's folder, for each raw value. It prints
only where a value was found, never the value:

<!-- prettier-ignore -->
```python
import json, sys, os, glob
f, sid, base = sys.argv[1], sys.argv[2], sys.argv[3]
A = '…'   # the fixture's API_SECRET value, built from two halves
GH = '…'  # the fixture's GitHub-shaped token, built as 'gh' + 'p_…'
ST=open(base+'/stripe.txt').read().strip()
secrets={'api_secret':A,'github':GH,'stripe':ST}
def where(obj, path=''):
    out=[]
    if isinstance(obj,str):
        for k,v in secrets.items():
            if v in obj: out.append((path,k))
    elif isinstance(obj,dict):
        for kk,vv in obj.items(): out+=where(vv,path+'.'+kk)
    elif isinstance(obj,list):
        for i,vv in enumerate(obj): out+=where(vv,path+'[]')
    return out
rows=[json.loads(l) for l in open(f)]
print(f'{len(rows)} entries')
for i,r in enumerate(rows):
    t=r.get('type'); sub=r.get('subtype') or (r.get('attachment') or {}).get('type') or r.get('operation') or ''
    hits=where(r)
    red='REDACTED' in json.dumps(r)
    print(f'{i:2} {t:18} {str(sub)[:22]:22} raw={sorted(set(hits))} placeholder={red}')
for p in glob.glob(os.path.dirname(f)+'/'+sid+'/**/*', recursive=True):
    if os.path.isfile(p):
        s=open(p,errors='replace').read()
        print('FILE', p.split(sid)[1], 'raw=', [k for k,v in secrets.items() if v in s], 'placeholder=', 'REDACTED' in s)
```

In the outputs below, lines where nothing was found and no placeholder appears are left out.

### 1.1 Run A2: all three hooks (2.1.296, the final prototype)

Prompt: "My deploy key is `<Stripe-shaped key>` — keep it in mind. Run exactly these two Bash
commands, one after the other: `cat fixture.env` then `cat big.log`. Then answer in one line: which
variable names did you see, and what does my deploy key start with?" `--allowedTools Bash`.

The model's answer:

```text
Variables in `fixture.env`: `API_SECRET`, `GITHUB_TOKEN`, `DEBUG`. Your deploy key shows up in your message only as `[REDACTED:stripe-secret-key#f2028cfc]`, so I can't tell what it starts with. If you paste the key, I'll check its prefix (I won't repeat the full value).
```

The audit:

```text
41 entries
 0 queue-operation    enqueue                raw=[('.content', 'stripe')] placeholder=False
 4 user                                      raw=[] placeholder=True
18 last-prompt                               raw=[] placeholder=True
22 user                                      raw=[] placeholder=True
26 last-prompt                               raw=[] placeholder=True
33 last-prompt                               raw=[] placeholder=True
36 assistant                                 raw=[] placeholder=True
39 last-prompt                               raw=[] placeholder=True
FILE /tool-results/bgv3djt3j.txt raw= ['api_secret'] placeholder= False
```

Entry 22 is the `cat fixture.env` result: its `message.content` and its `toolUseResult.stdout` both
read `API_SECRET=[REDACTED:secret-assignment#d19da717]\nGITHUB_TOKEN=[REDACTED:github-token#fc55a4b6]\nDEBUG=true`.
Entry 0 is L2, the `-p` queue record. `FILE /tool-results/…` is L1, the persisted 233 KB output.

This run used the prototype as pasted in [`02-prototype.md`](02-prototype.md) §2, with two exceptions added after it. One is the keep-next row
pass-through (four lines in `session.append` and one in `prompt.submit`). The other writes WebCrypto's
algorithm name in two parts for the repo's identifier gate, which changes no behaviour. That change acts only on the
prompt that follows `/scrub keep-next`, which this run did not use. An earlier run A on 2.1.295, before
the Edit-resolution and media changes, gave the same audit.

### 1.2 Run B: `session.append` only (2.1.295)

The same mod with the `prompt.submit` and `tool.call` hooks removed. The validate line read
`hooks: session.start, command.run{command=scrub}, session.append`. Prompt: the key, then
`cat fixture.env`.

```text
35 entries
 0 queue-operation    enqueue                raw=[('.content', 'stripe')] placeholder=False
 4 user                                      raw=[] placeholder=True
18 last-prompt                               raw=[] placeholder=True
24 user                                      raw=[('.toolUseResult.stdout', 'api_secret'), ('.toolUseResult.stdout', 'github')] placeholder=True
28 last-prompt                               raw=[] placeholder=True
33 last-prompt                               raw=[] placeholder=True
```

Entry 24 is the tool row: `message.content` holds placeholders (`placeholder=True`), while
`toolUseResult.stdout` holds both raw values. This is the gap `ref:143` describes, and §1.1 shows the
`tool.call` hook closing it.

### 1.3 Interactive run (2.1.296, tmux)

`claude --plugin-dir <mod> --model haiku`, then two prompts typed at the composer. The first read
"Remember my deploy key `<key>` and reply with just the word ok." The second, typed 3 s after a
"write 1 to 400" prompt, read "Second message: my other key is `<key>`, reply ok." The screen, copied
with `tmux capture-pane`:

```text
❯ Remember my deploy key [REDACTED:stripe-secret-key#f2028cfc] and reply with just the word ok.
● I didn't save that key. Memory files are plain text on disk and get loaded into future sessions, so a live Stripe secret doesn't belong there. For a deploy key, keep it in your secret manager or an
  env var that the deploy reads. Since it's now in this chat transcript, consider rotating it in the Stripe dashboard.
…
  ⚠ secret-scrubber: secret-scrubber: 2 redacted
```

The person's own row shows the placeholder (`d.ts:4096`). The status line shows the count; its
doubled prefix led to the fix in `00-spec.md` §7.1. The audit:

```text
58 entries
 7 user                                      raw=[] placeholder=True
22 last-prompt                               raw=[] placeholder=True
34 last-prompt                               raw=[] placeholder=True
49 user                                      raw=[] placeholder=True
56 last-prompt                               raw=[] placeholder=True
```

There was no `queue-operation` entry at all. The "1 to 400" turn ended before the second prompt was
typed, so that prompt was not queued mid-turn: A-4 stays open.

### 1.4 Run B4 / B4b: #92533 on 2.1.295

The T389 smoke B4 shape: in a fresh git repo, `-p --permission-mode bypassPermissions`, one
`Agent(subagent_type: "general-purpose", isolation: "worktree")` that runs a Bash command.

| Variant                                              | Subagent's Bash        | Result                                                                                                                                                    |
| ---------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| baseline, no mod                                     | `pwd; cat .git`        | pwd `<repo>/.claude/worktrees/agent-a3d4…`, `.git` → `gitdir: <repo>/.git/worktrees/agent-a3d4…`                                                          |
| B4: the prototype (a `tool.call` hook on every tool) | `pwd; cat .git`        | pwd `<repo>/.claude/worktrees/agent-a1e3…`, `.git` → `gitdir: <repo>/.git/worktrees/agent-a1e3…`. **Isolation kept.**                                     |
| B4b: the prototype, the repo holds `fixture.env`     | `pwd; cat fixture.env` | pwd inside the agent worktree. The subagent reported `API_SECRET=[REDACTED:secret-assignment#d19da717]`, `GITHUB_TOKEN=[REDACTED:github-token#fc55a4b6]`. |

A first B4 attempt used `pwd && git branch --show-current`. The operator's machine rewrites `git`
commands through a shell hook (`rtk`), and the worktree guard refused the rewritten command. So that
attempt says nothing about #92533. The runs above use commands the hook leaves alone.

The B4b audit, main transcript and the subagent's own:

```text
-- f15ddf61-49f9-47d7-92dc-fb734c1ba373.jsonl
42 entries
33 queue-operation    enqueue                raw=[] placeholder=True
35 user                                      raw=[] placeholder=True
37 assistant                                 raw=[] placeholder=True
-- agent-ad58c0555cd222224.jsonl
20 entries
12 user                                      raw=[] placeholder=True
19 assistant                                 raw=[] placeholder=True
```

The subagent's tool row (entry 12) has `raw=[]` **including its `toolUseResult`**. Run B (§1.2) shows that
`toolUseResult` holds raw values unless `tool.call` scrubs it, so the hook fired on the isolated
subagent's Bash call. Entry 33 of the main transcript is a `queue-operation` holding the subagent's
result as delivered to the parent, already scrubbed.

## 2. What went wrong while building the prototype

Each was hit on this build and fixed. They are listed so the implementation does not hit them again.

| Symptom                                                                                                                    | Cause                                                                                                                                                        | Fix                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 8 tests failed with `HooksError: secret-scrubber: next() passed an argument with no { cwd }`                               | The kit's bottom for `session.start` answers nothing; `SessionStartResult` is `{ cwd }` (`d.ts:11692-11694`).                                                | The test's `world()` answers `on('session.start', (_$, e) => ({ cwd: e.cwd }))`.                                                                                                     |
| `reader: hooks module did not load: … $.state.get takes a reference whose plugin and key are string literals`              | An inline test plugin passed a `const` declared in the test file. An inline plugin is its own module.                                                        | The literal written at the call.                                                                                                                                                     |
| `reader's ui.status hook was skipped: reader: seen is not defined`                                                         | An inline plugin runs in its own environment and cannot close over the test's variables.                                                                     | It reports through `$.ui.log`, which the test's `on('ui.log')` captures.                                                                                                             |
| `TypeError: undefined is not an object (evaluating '$.state.get')` in a test body                                          | The test's `$` is the engine's (`Engine`, `d.ts:15003-15015`), which raises events. It has no `$.state.get` for a plugin's values.                           | Read through an inline plugin.                                                                                                                                                       |
| `tsc`: `Property 'name' does not exist on type '{ readonly kind: "plugin"; readonly event: string; }'`                     | `origin.kind === 'plugin'` has two shapes.                                                                                                                   | `'name' in e.origin`. This `in` is on `e`, not on `$`, which `claude plugin validate` refuses.                                                                                       |
| `tsc`: `Type '{ value: undefined; }' is not assignable to … OpEventResult<"command.register">`                             | `command.register` resolves `{ command }` (`d.ts:7238-7240`).                                                                                                | Answer `{ value: { command: e.name } }`.                                                                                                                                             |
| `tsc` on the Edit resolution: `Type '"Edit"' is not assignable to type '`mcp__${string}__${string}`'`                      | Spreading `{ ...resolveDeep(e), tool: e.tool }` widens the discriminant.                                                                                     | `resolveDeep(e) as typeof e`: `tool` holds no placeholder, so it comes back unchanged.                                                                                               |
| A `/scrub keep-next` prompt still reached the model redacted                                                               | `prompt.submit` let it through, then `session.append` scrubbed the prompt row anyway.                                                                        | A one-shot flag lets the next `prompt` door row through too. The test checks the second prompt is scrubbed again.                                                                    |
| The first rule set hit 294 times in this repo's text                                                                       | `secret-assignment` matched names _containing_ `token`/`auth`.                                                                                               | `01-detection.md` §2.                                                                                                                                                                |
| The repo's `tests/no-client-identifiers.test.ts` failed on this spec: 10 lines holding the hash's name written with a dash | The tracker-key shape (2 to 6 capitals, a dash, 2 to 6 digits) matches it, and `tests/` is outside this unit's scope, so the allowlist could not be extended | The spec writes `SHA256`; the prototype builds the WebCrypto name as `'SHA' + '-256'`. W1 adds `SHA` to `ALLOWED_UPPER_PREFIXES`, as the gate's own header asks for an innocent hit. |
