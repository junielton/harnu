# P4W5 — Compaction digest and durable context

## 1. Status

Specified, not implemented · 2026-10-02 · Epic T389 · Late wave: the product panel paper asked to
defer this idea (it depends on upstream bugs and writes to project memory unprompted). It is
specified in full; the digest half ships behind a switch that is **off** by default.

Verified against Claude Code CLI 2.1.287 and repo `main` @ `46d70c7d` (line references re-checked after the Harnu rename; the earlier base `b35a2c06` is not in this repository). "types L<n>" is a line of
that release's `claude-code.d.ts`.

## 2. Depends on / Unblocks

- **Depends on:** P2W4 (the context registry and injector, `context.append`, the `durableRows`
  state key, the `context` prefs key), P2W1 (the `session.compact` command and its result), P1W6
  (`recordAuxSpend`), P1W4 (`registerPrefsKey`, the Harnu mod settings region), P1W3
  (`session.rebound`, `beforeHello`). Base branch: P2W4.
- **Interfaces used** (master §12): `frameContext` and `deliver` (P2W4; this wave adds the
  `harnu.mission` document to `context-registry.ts` and the re-issue rules to
  `context-injector.ts`, which stays the only issuer of `context.append` and `context.drop`);
  `companionHost.beforeHello` and `onBindingChange` (P1W1); `enqueue` (P2W1);
  `recordAuxSpend({ kind: 'compaction', sid, usage, ts })` (P1W6); `registerPrefsKey('recap', …)`
  and `prefsKey` (P1W4); mod helpers `ensureHello`, `emit`, `enabled`, `boundSid`,
  `reportModError`.
- **Changes to P2W4's code, stated here because this wave lands them:** it removes P2W4's deferred
  append on `classic.SessionStart {source: compact}` and the `reinject` state key (contract §22),
  and registers the one `session.compact` body in the order of contract §11.4.
- **Unblocks:** nothing.
- **Related, not a dependency:** `docs/specs/2026-08-02-t195-precompact-consolidation-handoff.md`
  (T195: a legacy `PreCompact` trigger and a typed handoff, not implemented). This wave adds the
  digest entry point T195 would also call; it does not implement T195.

## 3. Summary

Two things happen when a conversation is compacted.

1. **Digest.** The mod reports `compact.done` with the token counts, the summarizer's usage and,
   when the operator allowed it, the summary text. The host checks that the text is a summary and
   not a refusal, then appends a bounded "compaction recap" to the session's digest page in project
   memory, under the existing evidence gate.
2. **Re-injection.** Context that Harnu appended mid-session as hidden rows (P2W4's live
   orchestrator contract, a pointer to the mission the session owns) is summarized away by a
   compaction. The mod keeps those rows in `$.state` and hands them back through the compaction
   result's `messages`; when it triggered the compaction itself, it appends them shortly after.

v1 adds **no instructions** to the compaction: an added instruction can make the summarizer
refuse, and the refusal is then installed as the conversation summary (smoke D5).

## 4. Evidence

| Source                    | What it shows                                                                                                                                                                              | Verdict                |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------- |
| smoke D5                  | `next(e)` resolves `{messages, tokensBefore, tokensAfter, usage}`; the summary is `messages[0].text`; `classic.PostCompact` carries `compact_summary`                                      | CONFIRMED              |
| smoke D5, variant A       | `$.session.append` inside the hook, right after `await next(e)`, is written before the `compact_boundary` row and dropped from context                                                     | CONFIRMED (trap)       |
| smoke D5, variants B, C   | A `$.clock.after(1500, …)` append is seen by the model; so is a row added to the returned `messages` as `{role: 'user', text, toolUses: []}`                                               | CONFIRMED              |
| smoke D5                  | `$.session.compact()` rejects from a `command.run` hook and works deferred; **the caller's own `session.compact` hook does not run**; `classic.PostCompact` fires with `trigger: "manual"` | CONFIRMED (trap)       |
| smoke D5                  | An added instruction made the Haiku summarizer treat it as an injection; the refusal became the summary. A plain content request worked                                                    | CONFIRMED (trap)       |
| smoke C2, C3              | `$.session.compact()` rejects mid-turn; a hidden user-role row is read on the next request, cache intact, and a later row with the same key supersedes                                     | CONFIRMED              |
| smoke D7                  | Compaction spend is in no `turn.complete`                                                                                                                                                  | CONFIRMED              |
| types L10140              | `SessionCompactTrigger = 'manual' \| 'auto' \| 'plugin' \| 'precompute'`; `precompute` "installs nothing: its result is kept for the compaction that comes"                                | documented, not smoked |
| types L10050–10071        | `tokensBefore`, `tokensAfter`, `usage` are optional; `usage` is absent when core reused a precomputed summary; "the session's cost ledger … already holds it"                              | documented, not smoked |
| types L10086–10094        | `agentId` is set when a subagent's or a fork's own transcript compacts                                                                                                                     | documented, not smoked |
| upstream #95328, #96485   | `session.compact` hook results are lost on `--resume`                                                                                                                                      | not reproduced here    |
| master Q23, contract CQ20 | `trigger: "auto"` and `precompute` were not run; whether `classic.SessionStart {source: compact}` fires for them is unknown                                                                | NOT TESTED → AC 17, 18 |

## 5. Deviations from the study

| Study claim (new item 5)                  | Deviation                                                                                                                                                        | Basis           |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| "re-injects the mission state afterwards" | D7: through the result `messages` or a deferred append; never a synchronous append in the hook, never `prompt.compose`                                           | smoke D5, C3    |
| "writes the summary into project memory"  | A bounded recap, only after a summary check, under the digest's evidence gate, with the operator's switch on                                                     | smoke D5; SEC-8 |
| Implied: Harnu may steer the summary      | No instruction is added in v1 (§7.7)                                                                                                                             | smoke D5; R18   |
| Implied: mission **state** is re-injected | A **pointer** is: the mission's id and "read it with `mission_get`", with no title (R29). State lives in Harnu (ADR-0015) and would be stale inside a transcript | design; R29     |

## 6. Scope / Non-goals

**In scope.** The mod's `session.compact` hook and its `classic.PostCompact` fallback; the durable
rows in `$.state`; `compact.done`; the host adapter, the summary classifier, the digest entry
point; the `harnu.mission` document and the re-issue rules added to P2W4's context registry and
injector; the mission-ownership notifier; the `recap` switch; the refusal warning.

**Non-goals.**

- No operator-facing "compact" button (master §1).
- No rewrite of `e.instructions` or `e.messages` on the way down; no `{ skip }`; no `messages` of
  our own in place of core's.
- No legacy `PreCompact` / `PostCompact` HTTP hook (T202 §4.5 rejected the latter). With no legacy
  rival, `sense.compact` has no fact family (contract §11.1).
- No change to `hot.md` on compaction: the session continues.
- No handling of a subagent's or a fork's compaction (`e.agentId`).
- No re-injection without a live lease: a legacy session keeps the spawn-time
  `--append-system-prompt`, which a compaction rebuilds and does not lose (smoke C3).

## 7. Design

### 7.1 Modules

| Path                                         | Kind            | Responsibility                                                                                                                                         |
| -------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `resources/companion/hooks/register.ts`      | change          | `onCompact`, `onPostCompact`, `afterOwnCompact`, `appendDurable` (top-level, MOD-1); removes P2W4's `source: compact` step and the `reinject` key      |
| `src/main/companion/compact-summary-core.ts` | new, pure       | `classifyCompactSummary`, `extractSummaryBody`, `clipRecap`                                                                                            |
| `src/main/companion/compact-adapter.ts`      | new             | ingests `compact.done`: spend, classification, digest call, warning                                                                                    |
| `src/main/companion/context-registry.ts`     | extend (P2W4's) | the `harnu.mission` document: a fixed template and the mission id                                                                                      |
| `src/main/companion/context-injector.ts`     | extend (P2W4's) | the re-issue rules (`beforeHello`, `onRebound`, `onCompactDone`) and two ledger fields, `appendedAt` and `lostAfter`. It stays the only issuer         |
| `src/main/companion/mission-context.ts`      | new             | the mission-ownership notifier (§7.5)                                                                                                                  |
| `src/main/memory-digest.ts`                  | change          | exported `digestOnCompaction(input)`; `maybeDigest` takes an optional recap                                                                            |
| `src/main/mcp/digest-core.ts`                | change          | `DigestEndReason` gains `'compacted'` (`:248`); `formatDigest` renders a "Compaction recap" section                                                    |
| `companion-prefs.json` (P1W4)                | change          | the key `recap` (boolean, default `false`), registered with `registerPrefsKey('recap', …)`. Re-injection follows P2W4's key `context` (default `true`) |

### 7.2 Mod: the `session.compact` hook

One registration, whose body follows contract §11.4:

```ts
on('session.compact', ($, e, next) => onCompact($, e, next))

async function onCompact($, e, next) {
  // 0. ensureHello($)
  // 1. pass through, emit nothing: e.trigger === 'precompute' · e.agentId set ·
  //    neither sense.compact nor act.context is enabled
  // 2. mem.inCompactHook = true;  r = await next(e)   // e as received: no instruction is added
  //    r.skip !== undefined → return r                 // vetoed by another hook or a classic PreCompact
  // 3. act.context: rows = the framed texts of $.state durableRows ([] when not enabled)
  //    add = rows whose frame marker (as frameContext writes it) is not already in r.messages
  //    out = add.length ? { ...r, messages: [...r.messages, ...add.map(toMessage)] } : r
  // 4. sense.compact: emit($, { t: 'compact.done', d: { via: 'hook', trigger: e.trigger,
  //      tokensBefore, tokensAfter, usage, summary?, summaryChars, reinjected: add.length } })
  // 5. finally mem.inCompactHook = false;  return out
}
```

- MOD-2's wrapper has two arms: a failure **before** `next(e)` returns `next(e)`; a failure
  **after** it returns `r` unchanged and calls `reportModError('compact', err)`. `next` is never
  called twice.
- `toMessage(text)` is `{ role: 'user', text, toolUses: [] }` (smoke D5 variant C); the text is the
  framed row exactly as P2W4 appended it.
- `summary` is `r.messages[0].text`, cut to `COMPACT_SUMMARY_WIRE_MAX_CHARS`, and is sent only when
  `HelloResponse.opts.compactSummary` is set (contract §5.1; the `recap` key); otherwise the event
  carries `summaryChars` alone.
- The hook awaits nothing but `next(e)`: no `$.session.append`, no awaited fetch, no `$.model.*`
  (MOD-6). `emit` is not awaited.
- The marker check in step 3 covers the untested `precompute` case: a row is never added twice.

### 7.3 Mod: the two other paths

**Own compaction (`session.compact` command).** The mod's own hook is skipped, so nothing can be
added to the result. P2W1 fires `$.session.compact()` un-awaited and owns the command's result
(a skipped compaction is `ok: true` with `data: { skipped: true }`); this wave adds a step to the
continuation:

```
mem.selfCompacting = true
$.session.compact(args).then(r => afterOwnCompact($, r)).finally(() => mem.selfCompacting = false)

afterOwnCompact: r.skip → nothing (no compact.done; P2W1 reports the skip)
  else emit compact.done { via: 'command', trigger: 'plugin', …, summary? = r.messages[0].text,
                           reinjected: rows.length }            // rows queued, not yet appended
       $.clock.after(REINJECT_DELAY_MS, () => appendDurable($))  // smoke D5 variant B
```

`appendDurable` calls `$.session.append` once per durable row. A failed append is reported with
`reportModError('compact.reinject', err)`; the host then clears `appendedAt` for the session's
rows, so the next re-issue rule that fires appends them (§7.5). It is the only place this wave
appends, and `REINJECT_DELAY_MS` is P2W4's constant (contract §7.2).

**`classic.PostCompact`** (optional registration) is a sensor that always returns `next(e)`:

| `inCompactHook` | `selfCompacting` | Action                                                                                                                                                                |
| --------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| true            | —                | nothing: the hook path emits                                                                                                                                          |
| false           | true             | nothing: the command path emits                                                                                                                                       |
| false           | false            | emit `compact.done { via: 'classic', trigger: e.trigger, summary? = e.compact_summary, reinjected: rows.length }`; schedule `appendDurable` after `REINJECT_DELAY_MS` |

The third row covers a compaction for which the `session.compact` hook did not run (a failed
registration on a newer CLI, or an engine path that skips it). Under `sec-default`, `classic.*` is
pinned and this fallback is silent; the hook path does not need it. This row replaces P2W4's
deferred append on `classic.SessionStart {source: compact}`.

### 7.4 Durable rows

The state key is P2W4's `durableRows`, in the canonical shape of contract §22:
`{ sid: Sid; rows: Partial<Record<ContextKey, string>> }` — the framed text per key, at most
`DURABLE_MAX_ROWS`. Hashes stay host-side. This wave extends P2W4's command, it does not redefine
it:

- `context.append { durable: true }` appends the row and stores it under `key` (P2W4);
  `retainOnly: true` stores it without appending; `context.drop { key }` removes it (both added by
  this wave, contract §9). `CONTEXT_MAX_CHARS` is the only size cap.
- On `session.rebound` the mod clears the set when `sid` changes (contract §22); the host
  re-issues (§7.5).
- `$.state` survives a hot reload (types L3153). Whether it survives a process restart is CQ3; the
  host assumes it does not.

### 7.5 Host

**Documents.** `ContextKey` is `'harnu.orchestrator' | 'harnu.mission'` (contract §4).

| Key                  | Owner | Active when                                           | Revoked when                        | Text                                                                                                                                |
| -------------------- | ----- | ----------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `harnu.orchestrator` | P2W4  | P2W4 promotes a live session to orchestrator          | the operator demotes it             | P2W4's document                                                                                                                     |
| `harnu.mission`      | P4W5  | this session becomes the owner of an `active` mission | the mission closes or changes owner | `You own the Harnu mission <id>. Its state lives in Harnu, not in this conversation: read it with mission_get before acting on it.` |

The `harnu.mission` text is a fixed template plus the mission id, which is validated against
Harnu's own id pattern before framing. It carries **no title**: the registry's rule is that text is
never caller-supplied (SEC-5a, R29). It is a pointer on purpose: it changes only with ownership or
status, so a step update appends nothing.

**Mission-ownership notifier** (`mission-context.ts`, part of this wave). `mission-ipc.ts` is
pull-only today, so nothing tells main that ownership changed. The notifier exports
`missionOwnershipChanged(missionId, ownerSid | null, status)`, called after every successful
mission write: the `mission_*` verb handlers that create, close or re-own a mission, and
`runOperatorDoor` (`mission-ipc.ts:300`). It calls
`deliver(ownerSid, 'harnu.mission', 'active' | 'revoked')`; a `revoked` delivery issues
`context.drop`.

**Re-issue rules**, added to `context-injector.ts`. Its per-session ledger gains `appendedAt`
(last time the row was written into the transcript) and `lostAfter` (set by a `compact.done` whose
re-injection came through `messages`).

| Trigger                                                                                        | Host action                                                                                                                             |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `beforeHello(b, 'resume')` (hot reload, host restart)                                          | `context.append { durable: true, retainOnly: true }` per active row: prime `durableRows`, append nothing                                |
| the same, within 4 × `REINJECT_DELAY_MS` of a `compact.done` with `via` `command` or `classic` | append and retain instead: the reload may have cancelled the deferred append                                                            |
| `beforeHello(b, 'spawn')`, PTY kind `claude-resume`                                            | per row: `lostAfter !== null` or `appendedAt === null` → append and retain; else `retainOnly`                                           |
| `session.rebound { cause: 'clear' }`                                                           | append and retain every row that still applies                                                                                          |
| `session.rebound { cause: 'resume' }`                                                          | the rows of the conversation resumed into, as for `spawn`                                                                               |
| `compact.done`, `via: 'hook'`, `reinjected > 0`                                                | `lostAfter = ev.ts`: upstream #95328/#96485 say a hook's result is lost on `--resume`, so the next process start appends the rows again |
| `compact.done`, `via: 'command'` or `'classic'`                                                | `appendedAt = ev.ts`, `lostAfter = null` (the rows become ordinary transcript rows)                                                     |
| `mod.error { where: 'compact.reinject' }`                                                      | `appendedAt = null` for the session's rows                                                                                              |
| `compact.done`, `reinjected: 0`, active rows exist                                             | queue an append per row; the mod delays any append that arrives within `REINJECT_DELAY_MS` of a compaction                              |

Appended rows of the last three paths are commands, so they need `channel: active`; the
`messages` path needs no command.

P2W4's injector takes the row path only when `probes.classic` is true, because its re-injection
needed `classic.SessionStart`. With the `session.compact` hook that reason is gone: this wave
removes that precondition, so a session under `sec-default` can receive a context row.

The `spawn` rule costs one small hidden row per resume after a compaction. It is the designed
fallback for the upstream bug and is removed if AC-P4W5-19 shows the rows survive.

**`compact-adapter.ts`**, on `compact.done`:

1. Validate; drop the event if `sid` does not match the binding (contract §15).
2. `recordAuxSpend({ kind: 'compaction', sid, usage, ts })` (P1W6), tokens only: the session's
   cost ledger already holds the dollars (types L10065–10066).
3. The injector's `onCompactDone`.
4. With a `summary`: `classifyCompactSummary`. `'summary'` and `recap` on → `digestOnCompaction`.
   `'refusal'` → no digest, `companion:compactWarning` to the renderer, and `{ verdict, chars }`
   in the audit log. `'unknown'` → nothing.
5. Nothing reaches the task-state hub: a compaction is state-neutral (`hook-state.ts:30`).

**`classifyCompactSummary`** is a pure heuristic and is described as one:

| Check, in order                                                                                                                                | Verdict     |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| a refusal phrase in the first 400 characters ("I can't", "I cannot", "I won't", "unable to") and no `<summary>` element or numbered section    | `'refusal'` |
| at least `COMPACT_SUMMARY_MIN_CHARS`, the continuation preamble or a `<summary>` element present, `tokensAfter` absent or below `tokensBefore` | `'summary'` |
| otherwise                                                                                                                                      | `'unknown'` |

Phrases and markers live in one constant, with one synthetic fixture per verdict.

**`digestOnCompaction`** reuses `maybeDigest` (`memory-digest.ts:264`) with these differences:

- `endReason: 'compacted'`; `formatDigest` adds `### Compaction recap` with the clipped text and an
  explicit `… (truncated)` marker.
- The evidence gate is unchanged (`isRelevantWork`, `:279-284`): no commit, no write.
- The HEAD dedupe (`:286`) is replaced, for this path, by a recap-hash dedupe: two compactions on
  one HEAD append two recaps; one summary delivered twice appends one. `lastDigestedHead` is not
  advanced, so the end-of-session digest still runs.
- The page stays `sessions/YYYY-MM-DD-<id8>`, written through `appendMemoryEntry`: one page per
  session and day, appended, as T195 §1 requires. `applyHot` is not called.

### 7.6 Contract additions

None — merged into `01-contract.md`: the `compact.done` payload with `AuxUsage` (§8),
`context.append.retainOnly` and `context.drop` as extensions of P2W4's command (§9),
`ModOptions.compactSummary` (§5.1), `sense.compact` with its optional `classic.PostCompact`
(§11.1), the `session.compact` body order (§11.4), the key `recap` (§11.5), the `durableRows`
state key (§22), and the constant `COMPACT_SUMMARY_WIRE_MAX_CHARS` (§7.2). `DURABLE_MAX_ROWS`,
`REINJECT_DELAY_MS` and `CONTEXT_MAX_CHARS` are P2W4's. There is no per-row cap besides
`CONTEXT_MAX_CHARS`.

Host-only values, not contract constants:

| Value                       | Default | Meaning                                        |
| --------------------------- | ------- | ---------------------------------------------- |
| `COMPACT_SUMMARY_MIN_CHARS` | 200     | below this a text is not accepted as a summary |
| `COMPACT_RECAP_MAX_CHARS`   | 1 500   | recap written to project memory                |

### 7.7 Deferred: a content request to the summarizer

Not built. If a later change adds one, it must (a) phrase it as a plain content request, never as
an order to keep a marker; (b) add it only when the session holds a durable row; (c) run
`classifyCompactSummary` on the result and, on `'refusal'`, raise the warning and stop adding it
for that session; (d) pass its own live-verify on haiku and on the session model.

## 8. Arbitration & fallback

No fact family is involved, so no family's `shadow` governs this wave (contract §11.5).
`sense.compact` is a sensor and needs no key. The recap needs `recap` on, the companion mode not
`off` and a live lease. Re-injection through the hook needs `context` on and involves no command;
the appended rows of the other paths also need `channel: active`.

| Situation                                               | Digest                                                                                                                                   | Re-injection                                                                                  |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Mod absent, CLI < 2.1.287, policy block                 | none; the end and idle digests still run                                                                                                 | none; spawn-time context is rebuilt by the CLI                                                |
| Kill switch turned off mid-session                      | the `conn` is revoked and the re-hello is answered `enable: []`: the mod is inert at once, no `compact.done` is sent, nothing is written | the hook passes through; legacy behaviour (no re-injection) at once, with no TTL wait         |
| `recap` off                                             | `compact.done` carries no summary; spend is still recorded                                                                               | unaffected                                                                                    |
| `context` off, or the CLI above the tested ceiling      | unaffected (`recap` is capped to off above the ceiling)                                                                                  | the hook returns the engine's result unchanged; nothing is appended                           |
| `channel` in `shadow`                                   | unaffected                                                                                                                               | the `messages` path works; the deferred-append and re-issue commands are not sent             |
| `sec-default` (classic pinned)                          | the hook path works (`session.*` passes)                                                                                                 | the hook path works; the classic fallback is silent                                           |
| Host down during the compaction                         | the event waits in the ring (contract §6)                                                                                                | unaffected: rows come from `$.state`, no request is made                                      |
| Lease lost earlier                                      | the event is sent on reconnect; no recap without a live lease                                                                            | the mod returns the rows it holds; the host cannot refresh them                               |
| Hot reload before the compaction                        | unaffected                                                                                                                               | rows are read from `$.state`                                                                  |
| Hot reload during the hook, or before a deferred append | possibly no event (OQ4)                                                                                                                  | the resume-hello rule and the `reinjected: 0` rule repair                                     |
| `/clear`, in-session `/resume`                          | —                                                                                                                                        | the mod clears its set; the host re-issues                                                    |
| `claude --resume` in a new process                      | —                                                                                                                                        | the `spawn` rule appends the rows marked lost                                                 |
| Another hook answers `{ skip }`                         | no event                                                                                                                                 | nothing changed                                                                               |
| Another mod replaces `messages` on the way up           | the summary may be absent or forged; the classifier decides                                                                              | the marker check adds missing rows if our hook is outer; else the `reinjected: 0` rule        |
| `precompute`, or a subagent's compaction                | no event                                                                                                                                 | untouched                                                                                     |
| Headless (`-p`)                                         | the sensor event is sent; recap as configured                                                                                            | the hook path works; no commands are issued (contract §16), so rows exist only if set earlier |
| Summary classified `refusal`                            | not written; warning shown                                                                                                               | re-injected as usual: the rows matter most when the summary is damaged                        |

## 9. Security requirements

SEC-1 to SEC-9 apply. Wave-specific:

1. **The summary is model output about the user's work.** It crosses the wire only with the recap
   switch on. It is never written to a log, the parity ledger, the audit log, the shadow log or a
   fixture; those hold `summaryChars`, a sha256 prefix and the verdict (SEC-8).
2. **Project memory can be committed and pushed.** The recap lands in `.harnu/memory/sessions/`.
   That is why it is off by default, bounded, gated on real commits, and explained in the switch's
   hint. It is written through `appendMemoryEntry` with `author: 'agent'` provenance.
3. **A recap is context, not instructions**: it sits under a labelled heading in a page the memory
   verbs already serve as context. This wave injects it into no prompt.
4. **Durable rows are Harnu-authored.** The host's closed registry is their only source; the mod
   never derives a row from the conversation, a file or a response (SEC-3d). `context.drop` takes
   a key only. No row carries user-controlled text: the mission row holds an id, never a title
   (SEC-5a, R29).
5. **Re-injection is not laundering**: rows keep P2W4's framing and are never `asUser` (SEC-5d).
6. **Fail to the engine** (SEC-1): any failure in the hook returns the engine's own result. The
   hook cannot veto, delay or replace a compaction.

## 10. UX & copy

`design.md` first (DOC-4): the Harnu mod settings region defined by P1W4 (later the Mods tab), and
§8. No new component.

| Key                             | English                                                                                                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `harnuMod.recap.label`          | Compaction recap in project memory                                                                                                                                             |
| `harnuMod.recap.hint`           | When a session compacts after committing work, add a short recap of the summary to its digest page. The text is written by the model and is saved in the repo's memory folder. |
| `harnuMod.context.label`        | Keep Harnu context across compaction                                                                                                                                           |
| `harnuMod.context.hint`         | Puts the orchestrator contract and the mission pointer back after a session compacts.                                                                                          |
| `harnuMod.compactWarning.title` | Compaction summary looks wrong                                                                                                                                                 |
| `harnuMod.compactWarning.body`  | {session} compacted, and the summary reads like a refusal. The session may have lost its context.                                                                              |

The warning is one `warning` toast per compaction plus an Activity bell entry, under the existing
attention rules. It needs the summary text, so it exists only with the recap switch on (slice S4);
the user docs say so. The `harnuMod.context.*` keys label P2W4's `context` switch, which this wave
extends; if P2W4 already shipped the row, only its hint changes.

## 11. Acceptance criteria

```
AC-P4W5-1 [mod-test] Given two durable rows in $.state, When a manual compaction resolves, Then
  the hook returns the engine's messages followed by the two rows as user messages.
  Evidence: resources/companion/tests/compact.test.ts › "returns durable rows through messages"

AC-P4W5-2 [mod-test] Given any trigger, When the hook runs, Then `session.append` is not called
  before the hook has returned.
  Evidence: resources/companion/tests/compact.test.ts › "never appends inside the hook"

AC-P4W5-3 [mod-test] Given a compaction, When the hook calls next, Then `instructions` and
  `messages` equal what it received.
  Evidence: resources/companion/tests/compact.test.ts › "passes the input on as received"
  Guards: R18

AC-P4W5-4 [mod-test] Given `trigger: 'precompute'` or an input with `agentId`, When the hook runs,
  Then it returns next(e) unchanged and queues no event.
  Evidence: resources/companion/tests/compact.test.ts › "precompute and subagent pass through"

AC-P4W5-5 [mod-test] Given next(e) resolves `{ skip }`, When the hook returns, Then the skip is
  returned unchanged and no event is queued.
  Evidence: resources/companion/tests/compact.test.ts › "a veto passes through"

AC-P4W5-6 [mod-test] Given the code after next(e) throws, When the hook returns, Then it returns
  the engine's result unchanged and next was called once.
  Evidence: resources/companion/tests/compact.test.ts › "fails to the engine result"

AC-P4W5-7 [mod-test] Given `opts.compactSummary` unset in the hello response, When a compaction resolves,
  Then compact.done has summaryChars and no summary.
  Evidence: resources/companion/tests/compact.test.ts › "withholds the summary"

AC-P4W5-8 [mod-test] Given a session.compact command, When $.session.compact resolves, Then one
  compact.done with via `command` is emitted and the append runs only after REINJECT_DELAY_MS on
  the stubbed clock.
  Evidence: resources/companion/tests/compact.test.ts › "own compaction defers the append"

AC-P4W5-9 [mod-test] Given classic.PostCompact in each row of the §7.3 table, When the fallback
  runs, Then exactly the listed action happens.
  Evidence: resources/companion/tests/compact.test.ts › "one compact.done per compaction"

AC-P4W5-10 [unit] Given the fixtures (summary, refusal, short, empty, forged), When
  classifyCompactSummary runs, Then each yields its expected verdict.
  Evidence: tests/companion/compact-summary-core.test.ts › "verdict table"
  Guards: R18

AC-P4W5-11 [unit] Given a `refusal` verdict, When the adapter handles compact.done, Then no memory
  write is requested and one compactWarning is sent.
  Evidence: tests/companion/compact-adapter.test.ts › "a refusal is not digested"

AC-P4W5-12 [unit] Given a session with no commit, When digestOnCompaction runs, Then no page is
  written.
  Evidence: tests/memory-digest-compaction.test.ts › "evidence gate holds"

AC-P4W5-13 [unit] Given two compactions with different summaries and then a session end, When the
  digests run, Then one page exists for the session and day, with two recaps and the end entry.
  Evidence: tests/memory-digest-compaction.test.ts › "compact twice, end once, one page"

AC-P4W5-14 [unit] Given a compact.done with a summary, When the audit log and the logger are
  inspected, Then neither holds the summary text.
  Evidence: tests/companion/compact-adapter.test.ts › "summary never reaches audit or logs"

AC-P4W5-15 [unit] Given each trigger of the re-issue table, When it occurs, Then the injector
  issues exactly the listed commands.
  Evidence: tests/companion/context-injector.test.ts › "re-issue rules"

AC-P4W5-16 [unit] Given `recap` off, When a compact.done carrying a summary arrives, Then nothing
  is written to memory and the spend is still recorded.
  Evidence: tests/companion/compact-adapter.test.ts › "recap off writes nothing"

AC-P4W5-25 [unit] Given `channel` at `shadow` and one active row, When a compact.done with
  reinjected 0 arrives, Then no context.append is queued.
  Evidence: tests/companion/context-injector.test.ts › "no command without an active channel"

AC-P4W5-26 [mod-test] Given a revoked binding answered `enable: []` (the kill switch), When a
  compaction runs, Then the hook returns next(e) unchanged and emits nothing.
  Evidence: resources/companion/tests/compact.test.ts › "inert after the kill switch"

AC-P4W5-27 [unit] Given a mission whose title contains markup, When the `harnu.mission` document is
  framed, Then the text holds the mission id and no character of the title.
  Evidence: tests/companion/context-registry.test.ts › "the mission row carries no title"

AC-P4W5-28 [unit] Given a successful mission create, close or owner change, When the handler
  returns, Then missionOwnershipChanged was called once with the new owner and status.
  Evidence: tests/companion/mission-context.test.ts › "notifies on ownership change"

AC-P4W5-29 [unit] Given a mod.error with where `compact.reinject`, When the injector handles it,
  Then `appendedAt` is cleared and the next resume hello appends the rows.
  Evidence: tests/companion/context-injector.test.ts › "a failed deferred append is repaired"

AC-P4W5-17 [live-verify] Given a session driven past its auto-compact threshold, When the engine
  compacts, Then the hook's trigger, the arrival of compact.done, the survival of the sentinel row
  and whether `classic.SessionStart {source: compact}` and `classic.PostCompact` fired are
  recorded (master Q23, contract CQ20, P2W4's OQ4).
  Evidence: LV-P4W5-b steps 1–4

AC-P4W5-18 [live-verify] Given that run, When a `precompute` dispatch appears in the debug file,
  Then the order of dispatches and the number of sentinel rows are recorded (master Q23).
  Evidence: LV-P4W5-b step 5

AC-P4W5-19 [live-verify] Given a compaction with a row re-injected through `messages`, When the
  process is restarted with `--resume` and the host's re-issue is blocked, Then whether the model
  still sees the row is recorded (contract CQ20; upstream #95328/#96485).
  Evidence: LV-P4W5-c

AC-P4W5-20 [integration] Given a session holding a durable row with a sentinel word, When
  `/compact` runs and the next prompt asks for the word, Then the model answers it.
  Evidence: tests/cli/compact.cli.test.ts › "durable row survives a manual compaction" (haiku, 3 calls)

AC-P4W5-21 [live-verify] Given a host-issued session.compact on an idle session, When it
  completes, Then compact.done arrives with via `command` and the model sees the sentinel row.
  Evidence: LV-P4W5-a step 5

AC-P4W5-22 [live-verify] Given companion mode `off`, When `/compact` runs, Then no compact.done
  reaches the host and the session compacts as today.
  Evidence: LV-P4W5-a step 7

AC-P4W5-30 [live-verify] Given a classic PreCompact hook that blocks, When the host issues
  session.compact, Then the `skip` text of the result is recorded and judged worth surfacing or
  not (P2W1's OQ-5).
  Evidence: LV-P4W5-b step 7

AC-P4W5-23 [live-verify] Given another plugin that calls `$.session.compact()`, When it runs, Then
  whether the companion's hook fires, and with which trigger, is recorded.
  Evidence: LV-P4W5-b step 6
```

**Human**

```
AC-P4W5-24 [human] Given the recap switch on in a real repo for a week, When the operator reads
  the recaps in the Memory pane, Then the operator records whether any held text that should not
  be in the repo.
  Evidence: Delivery Report note
```

**LV-P4W5-a** (second isolated Harnu; haiku)

1. Launch with every family and `channel` at `active` for a scratch git repo; turn `recap` on
   (`context` is on by default).
2. Start a session, promote it to orchestrator mid-session, make one commit through it.
3. Run `/compact`; the debug file has no `hook skipped` line for `harnu-companion`.
4. Ask which contract the session is under: it names the orchestrator contract. The Memory pane
   shows one "Compaction recap" on the session's digest page.
5. Queue `session.compact` from the dev console for the idle session; repeat the question.
6. Grep the app log and `<userData>/companion/` for a distinctive word of the summary: no hit.
7. Set mode `off`, restart the session, run `/compact`: no event in the host trace.

**LV-P4W5-b** (`HARNU_CLI_LIVE=1`, cap USD 1.00)

1. Start a haiku session with `--debug-file`; set a durable row carrying a sentinel word.
2. Feed large file reads until the context passes the auto-compact threshold.
3. Record `e.trigger`, the `compact.done` fields and `usage`.
4. Ask for the sentinel word.
5. Search the debug file for a `precompute` dispatch; record the dispatch order and how many
   sentinel rows the result holds.
6. Load a scratch plugin whose command calls `$.session.compact()` deferred; record whether the
   companion's hook ran and its trigger.
7. Add a blocking `PreCompact` command hook through `--settings`; queue `session.compact`; record
   the result's `skip` text.

In steps 3 and 5 also record whether `classic.SessionStart {source: compact}` and
`classic.PostCompact` fired.

**LV-P4W5-c**: after LV-P4W5-a step 4, exit the CLI, block the `spawn` re-issue with the dev flag,
run `claude --resume <id>`, ask for the sentinel word, record the answer; unblock and repeat.

## 12. Docs deliverables

| Deliverable              | Content                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CHANGELOG.md`           | `Added`: compaction recap in project memory (off by default). `Fixed`: a session promoted to orchestrator keeps its contract after it compacts                                                                                                                                                                                                                                                                   |
| `docs/harnu-features.md` | **Yes; bump the marker**: after a compaction your orchestrator contract and mission pointer come back as context rows; mission state is not in the conversation, read it with `mission_get`; a digest page may hold a compaction recap. Follow `/harnu-awareness`                                                                                                                                                |
| `docs/user/`             | `project-memory.md` (what a recap is, model-written, bounded, saved with the repo's memory); `sessions.md` (what survives a compaction, with and without the Harnu mod; with a Claude Code newer than the version Harnu has tested, the orchestrator contract is not re-injected after a compaction until Harnu's tested version moves, contract §11.5); `troubleshooting.md` ("Compaction summary looks wrong") |
| `design.md`              | the two switches in the Harnu mod settings region; §8 copy for the warning                                                                                                                                                                                                                                                                                                                                       |
| i18n                     | the six keys of §10 in `en.json` and `pt-BR.json`                                                                                                                                                                                                                                                                                                                                                                |
| `01-contract.md`         | already merged (§7.6); `contract.ts` and the fixtures land with the code (DOC-7)                                                                                                                                                                                                                                                                                                                                 |

## 13. Rollout & parity gate

- **Fact family:** none. No legacy source reports a compaction, so there is no parity comparison.
  With `recap` off (the default) the event is still recorded with `summaryChars`, so real
  compactions can be inspected before any text crosses the wire.
- **Slices:** S1 `compact.done` and spend (sensor only; no summary on the wire, so no warning) ·
  S2 durable rows through `messages`, the `harnu.mission` document, the notifier and the re-issue
  rules · S3 own-compaction path and the classic fallback, replacing P2W4's deferred append ·
  S4 the `recap` switch: the summary on the wire, the classifier, the refusal warning and the
  recap in project memory.
- **Gate for S2:** AC-P4W5-20 green and LV-P4W5-b recorded. If an `auto` compaction does not
  dispatch the hook, re-injection for it falls to the `reinjected: 0` rule, and the docs say so.
- **Gate for S4 default-on:** one of the further confirmation points of master §13 (the `recap`
  switch, ARB-6d), with AC-P4W5-24 as input.
- **Demotes:** nothing.

## 14. Open questions

| #   | Question                                                                                                                                                              | Default until settled                                        | Owner             |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ----------------- |
| OQ1 | Does an `auto` compaction dispatch the hook with the same result shape, and does `classic.SessionStart {source: compact}` fire for it? (master Q23, CQ20, P2W4's OQ4) | assume yes; the classic fallback covers a no                 | P4W5 (AC-P4W5-17) |
| OQ2 | `precompute`: is an added message kept, and does the hook fire again at the real compaction? (master Q23, CQ20)                                                       | never touch `precompute`; the marker check prevents a double | P4W5 (AC-P4W5-18) |
| OQ3 | Do hook-added `messages` survive `--resume`? (CQ20; upstream #95328/#96485)                                                                                           | assume lost; re-append at the next process start             | P4W5 (AC-P4W5-19) |
| OQ4 | What happens when the mod hot-reloads inside the hook?                                                                                                                | the `reinjected: 0` rule repairs; production never reloads   | P4W5, dev only    |
| OQ5 | Is 1 500 ms needed after an own compaction, or is the boundary row already written when the call resolves?                                                            | keep the smoke-proven delay                                  | P4W5 (AC-P4W5-21) |
| OQ6 | Should the mission row carry the current step?                                                                                                                        | pointer only                                                 | product           |
| OQ7 | Does the skipped form of an own compaction carry a reason worth surfacing? (P2W1's OQ-5, re-owned here)                                                               | `{ skipped: true }` only                                     | P4W5 (AC-P4W5-30) |

## 15. Risks

| Risk                                                                                 | Sev    | Mitigation                                                                                           |
| ------------------------------------------------------------------------------------ | ------ | ---------------------------------------------------------------------------------------------------- |
| An instruction makes the summarizer refuse and the refusal becomes the summary (R18) | Medium | no instruction in v1 (AC-P4W5-3); the classifier and warning also catch refusals Harnu did not cause |
| A recap puts sensitive model-written text into a tracked folder                      | Medium | off by default; bounded; evidence-gated; AC-P4W5-24                                                  |
| Re-injected rows are lost on `--resume` (upstream)                                   | Medium | `lostAfter` and the `spawn` rule; AC-P4W5-19                                                         |
| A row is injected twice                                                              | Low    | marker check; hash-idempotent `deliver`; one emitter per compaction (AC-P4W5-9)                      |
| Text written by one session reaches another session's model through a row (R29)      | Medium | closed registry; the mission row holds an id only (AC-P4W5-27)                                       |
| The engine changes the result shape (`messages[0]` is no longer the summary)         | Medium | QA-6 drift checks; the classifier returns `unknown` and nothing is written                           |
