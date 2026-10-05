# BUG-84 — A dispatched card's boot prompt does reach argv, but the card mis-states who can read it, when, and what is new about it

**Date:** 2026-08-08 · **Status:** specified (not implemented) · **Card:** `.capy/memory/roadmap/BUG-84-a-dispatched-card-s-boot-prompt-goes-through-argv-and-is-world.md`
**Verified against:** repo `main` @ `f35a79d` (docs-only tip; last product-code commit `2706083`), Claude Code **2.1.226**

> The card's core claim survives verification: a dispatched card's boot prompt **is** an argv
> positional. Three of its supporting claims do not, and the corrections move severity in both
> directions. §2 is the verification; §3 is the honest verdict; §4 is the threat model; §5 evaluates
> mitigations; §6 recommends one.

---

## 1. Symptom

Recorded on this machine, 2026-08-08, from a live Capy-spawned session (pid 758734):

```
$ tr '\0' '\n' < /proc/758734/cmdline
/usr/local/bin/claude
--mcp-config
/home/u/.config/capy/capy.mcp.json
--allowedTools
mcp__capy
--resume
ec5d3c8c-5d33-4bb4-8bbc-e3a7aead69c5
--model
opus
--effort
high
--permission-mode
auto
--append-system-prompt
<!-- capy-features v34 (2026-07-31) -->

# You are running inside Capy
...
```

The entire `capy-features.md` doc is in clear text in the process table. The card's field evidence
is accurate.

```
$ stat -c '%A %n' /proc/self/cmdline /proc/self/environ
-r--r--r-- /proc/self/cmdline
-r-------- /proc/self/environ
$ grep -w proc /proc/mounts
proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0      # no hidepid=
```

---

## 2. What actually reaches argv — the verified trace

### 2.1 The positional prompt

`src/main/claude-args.ts:418` is the whole mechanism, and it is not new:

```ts
if (cfg.prePrompt?.trim()) push('--', cfg.prePrompt.trim())
```

`ClaudeBootConfig.prePrompt` (`claude-args.ts:48-49`) has always been emitted this way — it is the
operator's per-folder "pre-prompt" from the Claude Boot form (`docs/user/claude-boot.md:11`).

What changed on **2026-07-23** (`CHANGELOG.md:447-455`) is _which_ prompts take that road. Two
renderer call sites now write an agent/card prompt into the synthetic's `bootOverride.prePrompt`:

| Call site                                       | Feeds it                                                            |
| ----------------------------------------------- | ------------------------------------------------------------------- |
| `src/renderer/src/stores/sessions.ts:2556-2557` | `dispatchCardSession` — a roadmap card's boot prompt                |
| `src/renderer/src/stores/sessions.ts:2655-2656` | `insertAgentSession` — `create_session`'s `prePrompt` from an agent |

Both are gated on the same constant:

```ts
// src/renderer/src/stores/sessions.ts:605
export const AGENT_PREPROMPT_ARGV_MAX_CHARS = 8000
```

`> 8000` chars falls through to `pendingAgentPrompts` (`:2559`, `:2658`) — the pre-existing
paste-after-boot path. **The threshold is 8000 characters exactly, enforced in the renderer store,
against the `.trim()`ed prompt.** The doc's "~8000" (`docs/capy-features.md:285`) is precise, not
approximate.

Downstream is mechanical and confirmed end to end:
`spawn-spec.ts:137` (`toPlainBootOverride`) → `TerminalPane.vue:507` → `ptyCreate` →
`pty.ts:683` (`resolveClaudeBootArgs`) or `pty.ts:692-694` (the `agentControlled` rebuild) →
`buildClaudeArgs` → `claude-args.ts:418`.

Both roadmap dispatch doors reach `dispatchCardSession`: the board's own Dispatch
(`RoadmapBoard.vue:632`) and the background manifest drain (`command-router.ts:469`). There is no
third path.

### 2.2 Everything else already on the argv road

`buildClaudeArgs` puts several other operator- or agent-influenced strings in argv:

| Line                     | Value                                                                              |
| ------------------------ | ---------------------------------------------------------------------------------- |
| `claude-args.ts:383`     | `--system-prompt <verbatim>`                                                       |
| `claude-args.ts:386-387` | `--append-system-prompt` = Capy preamble ⊕ **the user's own `appendSystemPrompt`** |
| `claude-args.ts:377`     | `--settings <file-or-inline-JSON>`                                                 |
| `claude-args.ts:396`     | `--mcp-config <file-or-inline-JSON>`                                               |
| `claude-args.ts:413-416` | `extraArgs`, tokenized + denylist-filtered but otherwise verbatim                  |

Capy's own MCP bearer token is **not** among them: it passes `--mcp-config` as a _path_
(`/home/u/.config/capy/capy.mcp.json`, mode `-rw-------`, written at `0600` inside a `0700`
dir — `mcp/token-store.ts:26-27,75,112`). A user who types an _inline_ `--mcp-config '{…"token":…}'`
into the Claude Boot form would put a bearer token in argv, but that is their own construction.

Capy's one real credential — an `EndpointProfile.authToken` — becomes `ANTHROPIC_AUTH_TOKEN` /
`ANTHROPIC_API_KEY` env vars (`claude-config.ts:243-246`), landing in `/proc/<pid>/environ`, mode
`-r--------`. **Capy's only secret already takes the private road.** Everything on the argv road is
text a human or an agent authored.

### 2.3 The secret lint that exists, and the two doors it does not cover

`lintSecrets` (`src/main/mcp/memory-core.ts:349-373`) is a fail-closed regex lint over eight
credential shapes: `private-key-block`, `aws-access-key-id`, `github-token`, `slack-token`,
`google-api-key`, `openai-key`, `jwt`, and a generic `credential-assignment`
(`password|passwd|secret|api[_-]?key|access[_-]?token|client[_-]?secret|private[_-]?key` followed by
`:`/`=` and ≥12 credential-ish chars). It reports the matched **kind**, never the value.

It is applied to a **card body** at every door that folds one into a prompt:

- `roadmap-ipc.ts:1021` — `buildDispatchPrompt`, shared by `roadmap:bootPrompt` and `roadmap:planDispatch`
- `roadmap-ipc.ts:1178` — the Docs → Generate prompt
- `roadmap-ipc.ts:1283`, `:1322` — `replaceBody` / `appendBody` writes
- `roadmap-ipc.ts:1480` — `buildManifestDisclosure`; a match refuses the **whole batch**, surfaced as
  `CONTAINS_SECRET: card "<slug>"'s body looks like it contains a secret — refusing to fold it into a boot prompt.` (`mcp/server.ts:306-307`)

**It is applied to neither of the two strings that now ride argv on their own:**

1. **`create_session`'s `prePrompt`.** `mcp/tool-handlers.ts:707-708` forwards it verbatim
   (`if (prePrompt) payload.prePrompt = prePrompt`). `mcp/plan-input.ts` has no `create_session`
   translator that inspects it, and the confirm disclosure (`mcp/server.ts:418,427`) _renders_ it to
   the operator but never lints it. An MCP agent can put arbitrary text in argv today.
2. **The 8000-char argv branch itself** (`sessions.ts:2556`, `:2655`). It is a renderer-side length
   check with no content check. Note the direct consequence: a card whose body the manifest door
   already refused could still reach argv through `create_session`, because the two doors are
   different code paths — which is exactly the asymmetry the card names, verified.

`agent-boot.ts:42` (`ALLOWED_KEYS = {model, effort}`) does **not** help here. It gates the agent's
`bootOverride` object, and `prePrompt` is correctly on its forbidden list (`agent-boot.ts:13-14`) —
but `prePrompt` reaches the spawn through the _renderer's own_ write to `synthetic.bootOverride`, not
through the MCP override. The gate is intact and is simply not on this path.

### 2.4 Facts that bound the exposure

- **No shell is involved.** `pty.ts:799` is `spawn(runCommand, runArgs, …)` — node-pty exec, not a
  shell. There is no `.bash_history` / `HISTFILE` / shell-audit entry for a Capy spawn. The
  shell-history vector does not exist here.
- **Capy's own UI never renders argv.** The System Monitor reads `/proc/<pid>/stat`
  (`monitor/proc-linux.ts:53`) for `comm` only; it never opens `cmdline`. Screen-sharing _Capy_ leaks
  nothing. Screen-sharing a terminal running `ps -ef` / `htop -c` does.
- **argv carries the prompt for the FIRST process only.** `resumeBootOverride`
  (`spawn-spec.ts:102-108`) deliberately strips `prePrompt` from every resume spawn — it was added
  because the prompt was being _replayed_ on every respawn. Waking a hibernated session, or closing
  and reopening a tab, produces an argv with no prompt. The window is one process lifetime, not the
  session's.
- **The >8000-char fallback is the _more_ private path.** A long prompt is written to the PTY as
  keystrokes and never touches argv. The 2026-07-23 change made the common case less private and the
  rare case unchanged — an inversion worth naming, because it means "just lower the threshold" is a
  real (if blunt) lever.

---

## 3. Verdict on the card — what holds, what does not

**Holds.**

- A card's boot prompt does reach argv (§2.1), and `create_session`'s `prePrompt` does too.
- The entire `--append-system-prompt` payload is in the process table (§1).
- `submit_manifest` lints the board's dispatch door and **not** the process table; the two defenses
  are unrelated and only one exists (§2.3). This is the card's sharpest and most correct point.

**Does not hold — the card understates the audience.** The card says "every local process"; the task
framing says "same-user only". `/proc/<pid>/cmdline` is mode `0444` and `/proc` here carries no
`hidepid=`, so **any user account on the machine can read it**, not just the owner. The card is
closer to right than the framing that was meant to temper it. On a single-user laptop this is a
distinction without a difference; on a shared build box, a multi-tenant CI runner, or a machine with
a service account, it is a genuine cross-user read.

**Does not hold — the card frames this as new.** It is a **scope widening of a pre-existing
exposure**, not a new class. `claude-args.ts:418` predates the change; `--system-prompt`,
`--append-system-prompt`, inline `--settings` and inline `--mcp-config` have always been argv values
(§2.2). What 2026-07-23 changed is that a card's boot prompt and an agent's `create_session` prompt
joined a road the operator's own pre-prompt was already on. That matters for the fix: reverting the
argv delivery would not close the exposure, it would only shrink it back to the operator's own
pre-prompt.

**Does not hold — "for the lifetime of the session".** One process lifetime (§2.4). A long-lived,
frequently-resumed session spends most of its life with a prompt-free argv.

**Net.** The card is right about the mechanism and right about the missing defense. It is wrong about
novelty and about duration, and it is _more_ right than intended about reach.

---

## 4. Threat model and severity

**What is exposed:** the text of a card body / boot prompt / `create_session` prompt, the T55
self-awareness doc, the user's own `appendSystemPrompt`, and any inline `--settings` /
`--mcp-config` JSON the user typed. **Not** exposed: Capy's MCP bearer token (file path only,
`0600`), and any endpoint auth token (env, `0400`).

**Who can read it:**

| Reader                                                           | Real?  | Note                                                                        |
| ---------------------------------------------------------------- | ------ | --------------------------------------------------------------------------- |
| Another process under the same user                              | Yes    | `/proc/<pid>/cmdline`, no privilege needed                                  |
| **Another user on the same machine**                             | Yes    | `0444` + no `hidepid` — the card's framing, verified                        |
| A monitoring/EDR/telemetry agent that records full command lines | Yes    | Common on managed corporate laptops; the payload lands in a log pipeline    |
| Someone watching a shared screen                                 | Partly | Only if a terminal is running `ps -ef` / `htop -c`; never through Capy's UI |
| Shell history / `.bash_history`                                  | **No** | No shell in the spawn path (§2.4)                                           |
| Remote / network                                                 | **No** | No vector at all                                                            |

**Severity: medium-low, and honestly so.** No privilege escalation, no remote reach, no
Capy-owned credential on the wire. The realistic harm is a two-step: an operator or an agent writes a
credential into a card body or a `create_session` prompt (a thing people _do_ — "here's the staging
token, go fix the deploy"), and it then sits in a world-readable process table and, on a managed
machine, in a command-line telemetry log. That is a real incident shape, but it needs a human or an
agent to plant the secret first. Capy never puts one there itself.

The reason it is not _lower_ is the asymmetry: Capy already decided this class of leak was worth
defending (`lintSecrets` at five roadmap doors, §2.3) and then opened a door beside it with no lock.
A defense that exists on one path and not its twin is worse than either a consistent defense or a
consistent absence, because it produces false confidence.

---

## 5. Mitigations evaluated

### 5.1 stdin / fd delivery — **not available**

Verified against 2.1.226:

```
$ claude --prompt-file /tmp/x --print --model haiku
error: unknown option '--prompt-file'
$ claude --bogus-flag-xyz … --print       # control: unknown flags DO fail loudly
error: unknown option '--bogus-flag-xyz'
```

There is no file or fd door for the positional prompt. `claude --help` documents the prompt as a
bare positional (`Usage: claude [options] [command] [prompt]`). stdin is the operator's keyboard —
the session is interactive in a PTY, so writing the prompt to stdin _is_ the existing paste path
(§5.3), not a new one. **Rejected on feasibility, not on cost.**

### 5.2 A `0600` temp file — **partially available, wrong shape for the prompt**

`--append-system-prompt-file` **does exist** in 2.1.226 (undocumented in the main option list, but
referenced in `--bare`'s help text and verified working):

```
$ printf 'test' > /tmp/x; claude --append-system-prompt-file /tmp/x --print --model haiku 'say ok'
ok
```

So the _system-prompt_ payload — the largest block of argv text — could move to a `0600` file, and
Capy already has the exact idiom for it (`token-store.ts:26-27` writes `0600` inside a `0700`
userData dir; `claude-config.ts:145` does the same for `claude-boot.json`). That is genuinely worth
doing, but it does **not** address this card: today that payload is a public doc plus the user's own
append.

For the **positional prompt** there is no equivalent flag. The only file-based construction is to
write the prompt to a `0600` file and pass a positional like `Read <path> and follow it`. That is a
real behavior change, not a transport change: it costs a tool-call round trip, may raise a `Read`
permission prompt, removes the prompt from the transcript as a user message, and re-introduces a
"did the model actually do the thing?" uncertainty — precisely what the 2026-07-23 change existed to
eliminate (`CHANGELOG.md:449-453` lists BUG-57/58/59/60/61/62/63/64/66/67 + T172 as the family it
closed). **Rejected for the prompt; recommended as a separate follow-up for the system prompt
(§7 O2).**

### 5.3 Revert to paste-only (drop `AGENT_PREPROMPT_ARGV_MAX_CHARS` to 0) — **rejected**

Cheapest possible diff, and it does close the argv window for dispatched prompts. It also re-opens
the entire BUG-57..67 / T172 delivery-race family and re-arms the `prompt_undelivered` reaper as the
common case (`sessions.ts:1355`, `docs/capy-features.md:284-303`). Trading a bounded confidentiality
issue for a restored reliability bug is a bad trade. It also does not close §2.2 — the operator's own
pre-prompt still rides argv.

### 5.4 Enforce the existing `lintSecrets` contract at the two uncovered doors — **recommended**

Apply the _same_ `lintSecrets` the board already applies (`memory-core.ts:368`) to the two strings
that reach argv without it (§2.3):

- **`create_session`'s `prePrompt`** — refuse in `mcp/tool-handlers.ts`'s `createSessionHandler`
  (before the bridge dispatch at `:707-708`), returning a steer in the shape of the existing
  `CONTAINS_SECRET` (`server.ts:306-307`) so the agent gets the same named class it already knows
  from `submit_manifest` and can correct itself. Reports the **kind**, never the value.
- **The argv branch in the renderer store** (`sessions.ts:2556`, `:2655`) — a belt-and-suspenders
  content check beside the length check, so a prompt reaching that branch from any future caller is
  covered by construction rather than by every caller remembering.

**What it catches:** the eight shapes in `SECRET_PATTERNS` — the same set the operator already trusts
on the board. **What it does not catch, stated plainly:** a bare high-entropy string with no
assignment shape; a base64 blob; a short or custom-format internal token; a credential described in
prose ("the staging password is hunter2hunter2"); anything under 12 chars after the `=`. It is a
lint, not a guarantee, and the spec should not pretend otherwise — its value is that it makes the
two doors _consistent_, and consistency is what the card is actually complaining about.

**Deliberately out of scope: the operator's own Claude Boot `prePrompt`.** Refusing a string a human
typed into their own form, on their own machine, about their own repo, is friction at a door that is
not the threat (the operator authoring a secret into their own config is a choice, not an accident of
Capy's plumbing). Per the zero-friction principle, gates belong at the execute/accept/route doors —
this one is neither. Document it in `docs/user/claude-boot.md` instead.

---

## 6. Recommendation

**Ship §5.4 alone.** Justification against cost:

- **Cost is small and entirely in existing seams.** `lintSecrets` is already exported, already pure,
  already unit-tested (`tests/mcp-memory-core.test.ts`), and already wired to a steer string. The
  change is two guarded call sites, one reused error code, and tests. No new module, no new IPC, no
  new UI, no i18n (the MCP steer is a plain-English server string; the renderer path already has
  `roadmap…contains-secret` at `en.json:1705` for the board door).
- **It closes the exact gap the card identified** — "the scan protects the board's dispatch door, not
  the process table" — by making the two doors symmetric, rather than by rebuilding transport.
- **It does not regress the delivery guarantee.** A well-formed prompt is unaffected; nothing moves
  off argv, so no BUG-57..67 regression risk.
- **The alternatives are worse per unit of protection.** §5.1 is impossible, §5.3 trades a real
  reliability win for a partial confidentiality win, and §5.2 is either a behavior change (prompt) or
  addresses a payload that is public today (system prompt).

The honest counter-argument, recorded rather than buried: a lint does not _prevent_ the leak, it only
refuses the recognizable cases. If the operator's real requirement is "a boot prompt must never be
readable by another user on this box", the only complete answer is §5.3 (paste-only) plus §5.2 for
the system prompt, and that costs the delivery guarantee. This spec judges that trade not worth
making for a medium-low, human-planted, same-machine exposure — but the judgement is the deliverable,
not a fact, and O1 below is where to revisit it.

---

## 7. Open questions

- **O1 — is the operator's real threat model multi-user?** Everything above assumes a single-user
  developer machine where the cross-user read is theoretical. If Capy is ever run on a shared box, a
  CI runner, or a machine with command-line telemetry, §5.3 becomes the right answer and this spec's
  recommendation flips. Nothing in the codebase records that assumption today. Worth an explicit line
  in `docs/user/` either way.
- **O2 — move the system prompt to `--append-system-prompt-file`?** Verified to work (§5.2). It is
  independently valuable: it removes several kilobytes of argv text, and it takes the user's own
  `appendSystemPrompt` (which _can_ contain anything) off the process table. **Separate card** — it
  touches `pty.ts`/`claude-args.ts` and needs a fallback for a CLI that lacks the flag, which is
  BUG-83's version-gate problem, not this one. Do not widen this card into it.
- **O3 — should `lintSecrets` grow a high-entropy heuristic?** Would catch the bare-token case §5.4
  admits it misses, at the cost of false positives on hashes, uuids, and base64 test fixtures — which
  in a _refusal_ is a hard failure the agent cannot route around. Probably no; recorded so the next
  reader does not re-derive it.
- **O4 — does the refusal need a renderer surface?** The `create_session` path is MCP-only, so the
  steer reaches the agent and the operator sees nothing. If a refused dispatch should also raise a
  toast, that is a new i18n key pair and a design decision; this spec assumes not.
- **O5 — CLI version drift.** The task brief cites Claude Code 2.1.224; `claude --version` on this
  machine reports **2.1.226**, and the live session captured in §1 is running **2.1.223** (the native
  installer keeps versions side by side). All flag probes in §5.1/§5.2 were run against 2.1.226. The
  same "no version gate anywhere" problem BUG-83 documents applies to O2's flag probe.

---

## 8. Contracts touched

- **`CHANGELOG.md` — YES.** `### Fixed`: a `create_session` whose starting prompt looks like it
  contains a credential is now refused with a named reason, matching what the roadmap board already
  does — the prompt would otherwise be readable in the machine's process table.
- **`docs/capy-features.md` — YES, with a version-marker bump.** This is agent-facing under CLAUDE.md's
  litmus: `create_session` gains a refusal the session must read and correct for, in the same
  `CONTAINS_SECRET` class the agent already knows from `submit_manifest`. The CI awareness gate
  (`scripts/ci/awareness-gate.mjs`) fires as soon as `tool-catalog.ts`'s `create_session` description
  is updated to state the refusal — which it must be, since the description is the canonical agent API
  surface.
- **`docs/user/` — YES.** `tool-catalog.ts` changes, so `scripts/ci/user-docs-gate.mjs` fires
  regardless. `docs/user/agent-control.md` gains the refusal in human prose;
  `docs/user/claude-boot.md` gains the "never put a secret in a pre-prompt or a system-prompt append —
  it is visible in the process table" contract (§5.4's deliberate scope exclusion, documented rather
  than enforced).
- **`design.md` — NO.** No new component, state, token, or copy surface; the refusal is an MCP steer,
  not UI (subject to O4).
- **i18n — NO** (subject to O4). The MCP steer is a main-process English string; the board's
  `contains-secret` key already exists at `en.json:1705`.
- **English-only — YES.** Spec, comments, steer string and CHANGELOG in English.

## 9. Test plan

| Test                                                                                                                                                                                                           | File                                                 | Asserts |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------- |
| `create_session` with a `prePrompt` matching each of the eight `SECRET_PATTERNS` kinds is refused, naming the kind and **never echoing the value**                                                             | `tests/mcp-create-session-ack.test.ts` (existing)    | §5.4    |
| `create_session` with an ordinary prompt (including one containing the literal word "secret" with no assignment shape) still succeeds — no false-positive regression                                           | `tests/mcp-create-session-ack.test.ts` (existing)    | §5.4    |
| The renderer argv branch refuses a secret-bearing prompt at `AGENT_PREPROMPT_ARGV_MAX_CHARS` and does **not** silently fall through to `pendingAgentPrompts` (a fallthrough would move the leak, not close it) | `tests/sessions-store.test.ts` (existing, `:2190`)   | §5.4    |
| A prompt over the threshold still takes the paste path unchanged                                                                                                                                               | `tests/sessions-store.test.ts` (existing, `:2220`)   | §2.1    |
| `buildClaudeArgs` still emits `prePrompt` as a single `--`-separated positional (the delivery guarantee is untouched)                                                                                          | `tests/claude-args.test.ts` (existing, `:51`)        | §5.3    |
| `resumeBootOverride` still strips `prePrompt` on resume — the one-process-lifetime bound of §2.4 is load-bearing and must not silently regress                                                                 | `tests/spawn-spec.test.ts` (existing, `:89`, `:101`) | §2.4    |

**Honest gap.** No unit test can prove the process table is clean — that is an integration property of
the OS, not of the code. The evidence is the `tr '\0' '\n' < /proc/<pid>/cmdline` capture of §1,
re-run after the change against a session dispatched with a secret-shaped prompt (which must never
spawn) and one dispatched with an ordinary prompt (which must spawn, with the prompt still in argv —
this fix does not remove it). Record both captures in the PR.

## 10. Acceptance

- [ ] `lintSecrets` applied to `create_session`'s `prePrompt` in `mcp/tool-handlers.ts` before the
      bridge dispatch, refusing with the existing `CONTAINS_SECRET` class
- [ ] `lintSecrets` applied to the argv branch in `sessions.ts:2556` and `:2655`, refusing rather
      than falling through to the paste path
- [ ] The refusal names the pattern **kind** and never echoes the matched value
- [ ] The operator's own Claude Boot `prePrompt` is deliberately **not** linted (§5.4), and that
      decision is written down in `docs/user/claude-boot.md`, not left implicit
- [ ] `buildClaudeArgs` (`claude-args.ts:418`) unchanged; the argv delivery guarantee and the >8000-char paste fallback both behave exactly as today for well-formed prompts
- [ ] `resumeBootOverride` (`spawn-spec.ts:102-108`) verified unchanged
- [ ] `agent-boot.ts`'s `ALLOWED_KEYS` unchanged — `prePrompt` stays off the agent override allowlist
- [ ] O1 answered explicitly (single-user assumption recorded, or §5.3 reconsidered)
- [ ] O2 filed as a separate card; **not** implemented here
- [ ] `/proc/<pid>/cmdline` captures for both the refused and the allowed case recorded in the PR
- [ ] Tests in §9 green
- [ ] `CHANGELOG.md`, `docs/capy-features.md` (+ marker bump), `docs/user/agent-control.md`,
      `docs/user/claude-boot.md`
- [ ] `npm run typecheck` and `npm run build` pass
