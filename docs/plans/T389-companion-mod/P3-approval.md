# T389 P3 — Approval: implementation plan

**Waves:** P3W1, P3W2 · **Master plan:** [`00-master-plan.md`](00-master-plan.md) · **Specs:** `docs/specs/T389-companion-mod/P3W1-approval-hold.md`, `P3W2-structured-sentinel.md`

Safety rules for both waves (master spec §7.1): only renderer IPC resolves a held approval (SEC-2); any companion failure yields the engine's own verdict, never an allow (SEC-1); the Inbox states coverage honestly and never claims a guarantee (SEC-7); a Sentinel decision is only ever a deny. A kill of P3 alone is allowed by ADR-0018 if a hold drops on hot reload with no recoverable signal (AC-P3W1-30 proves the recovery). Common definition of done and executor hygiene: master plan §9.

---

## P3W1 — Approval hold

| Field  | Value                                                                                      |
| ------ | ------------------------------------------------------------------------------------------ |
| Branch | `feat/t389-p3w1-approval-hold`                                                             |
| Base   | `feat/t389-p2w3-messaging` (P1W5 and P2W2 are below it)                                    |
| Spec   | `docs/specs/T389-companion-mod/P3W1-approval-hold.md` · contract §5.4, §10.1, §11.4, §11.6 |
| Size   | L: 39 ACs (12 mod-test, 7 live-verify, 2 human)                                            |
| Labels | none (CHANGELOG `Changed` and `Fixed`; agent-facing)                                       |

**Files.** Mod: `resources/companion/hooks/register.ts` (steps in the five shared registrations of contract §11.4: `tool.check`, `classic.PermissionRequest`, `classic.PostToolUse`, `turn.complete`, optional `classic.PostToolUseFailure`), `hooks/approval-core.ts`, the `ask($, req)` client (first-lander with P4W2: create it with the signature of master §12.2 unless P4W2 already did), `api-surface.json`. Host under `src/main/companion/`: `ask-core.ts` (pure ticket state machine), `ask-broker.ts` (tranche parking under `hold(b)`, resolver chain, IPC), `coverage-core.ts` (pure; its `other-mod` reason calls `permissionHookers(folder)` from P4W1 part A, which is in `main` by merge order 1; if the base lacks it, leave `other-mod` out and say so under Spec defects, master Q31), `bridge-standdown-core.ts` (add clause 2 of contract §11.6, keep P2W3's `SendMessage` clause), `registerAskKind('permission', …)`. Edit `src/main/approval-parse.ts` (`PendingApprovalWire`: `transport`, `toolUseId`, `agentType`, `permissionMode`, `ambiguous`; `deadlineMs === 0` means no deadline), `src/main/approval-resolver.ts` (`parks = true`, already set by P2W3 per its module table; keep it idempotent), `src/main/responder-registry.ts` and `responder-dispatch.ts` (transport, superseded settle, ramp). IPC `approval:coverage`. Renderer: `ApprovalRow.vue`, `InboxRail.vue`, `src/renderer/src/stores/session-approvals.ts` (chime and attention once per `askId`). Docs: `harnu-features.md` Approval Inbox paragraph (lines 10 to 12) + marker, `docs/user/{approval-inbox,troubleshooting}.md`, `docs/hook-bridge-integration.md` (the stand-down rule), `design.md` §6 (Inbox rail, Safety confirms, Hook responder) and §8, keys `approvalInbox.coverage.*`, `approvalInbox.moreInTerminal`, `approvalInbox.answeredInTerminal`.

**Steps**

| #   | Commit group            | Tests first (file → ACs)                                                                                                                                                                                                                      | Then                                                                                                                                                                             |
| --- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | mod hold                | `resources/companion/tests/approval.test.ts` → AC-P3W1-1, -2, -3, -4, -5, -6, -7, -8, -10, -11, -12, -38; `tests/companion/api-surface.test.ts` → AC-P3W1-9 (exactly one allow site)                                                          | `approval-core.ts`, `ask()` client, hook steps: `tool.check` is a pass-through recorder, the hold lives in `classic.PermissionRequest`; every failure returns the engine verdict |
| 2   | ask core and broker     | `tests/companion/ask-core.test.ts` → AC-P3W1-15; `ask-broker.test.ts` → AC-P3W1-13, -14, -16, -19, -20, -21, -37, -39                                                                                                                         | `ask-core.ts`, `ask-broker.ts`, wire fields, no responder deadline on a ticket, orphan timer `ASK_ORPHAN_MS`                                                                     |
| 3   | stand-down              | `tests/companion/bridge-standdown-core.test.ts` (P2W3 creates it; add the approval clause cases) → AC-P3W1-17; `tests/responder-bridge.test.ts` → AC-P3W1-18 (a Sentinel deny still runs)                                                     | clause 2 in `shouldStandDown`; `recordFact('approval','legacy', …)` rows (`would-stand-down` in shadow)                                                                          |
| 4   | authority and coverage  | `tests/companion/ask-authority.test.ts` → AC-P3W1-22 (nothing but renderer IPC imports `respondApproval`); `coverage-core.test.ts` → AC-P3W1-23, -24                                                                                          | `coverage-core.ts`, `approval:coverage` IPC, the `contested` runtime signals                                                                                                     |
| 5   | renderer (design first) | `tests/session-approvals.test.ts` → AC-P3W1-25; human AC-P3W1-33, -34                                                                                                                                                                         | `design.md`, both locales, `ApprovalRow.vue` fragments, `InboxRail.vue` coverage line, chime and attention                                                                       |
| 6   | L4                      | `tests/cli/approval-hold.cli.test.ts` → AC-P3W1-26, -27                                                                                                                                                                                       | none                                                                                                                                                                             |
| 7   | live-verify and docs    | LV-P3W1-a (AC-32 subagent; human -33, -34), -b (AC-28 permission-mode matrix, AC-36 `auto` and a `tool.check` deny, Q18, Q27), -c (AC-29, a 60-minute hold, Q20), -d (AC-30, reload, `/clear`, `--resume`), -e (AC-31, CQ12), -f (AC-35, Q26) | `harnu-features.md` + marker (`/harnu-awareness`), user docs, hook-bridge doc, CHANGELOG                                                                                         |

**Notes.** `OD-2` (recorded): hold only when the engine would ask; sessions in `acceptEdits` or `bypassPermissions` lose the 3.5 s window per call and the CHANGELOG, user docs and Hook responder copy say so. The dialog-suppressing variant is Appendix A of the spec: do not build it.

**Rollout.** `approval` `shadow` at merge: the mod asks, the host answers `released: shadow`, the bridge decides. Gate 1 and gate 2 are in master plan §7.

**Pipeline.** `scripts/ci/local-pipeline.sh --base feat/t389-p2w3-messaging --with-cli --with-e2e --json /tmp/p3w1.json`.

**Boot packet**

```text
Objective: hold approvals through the Harnu mod (spec P3W1): the mod correlates classic.PermissionRequest with its tool.check record and holds in <=20 s tranches against the host's ask broker, which parks the ticket in the existing resolver chain; only renderer IPC resolves it; bridge stands down for owned sessions (Sentinel deny still runs); per-session coverage state in the Inbox; held tickets always chime and raise attention. Failures return the engine verdict, never an allow.
Setup: new worktree from feat/t389-p2w3-messaging, branch feat/t389-p3w1-approval-hold; npm ci.
Read first: docs/specs/T389-companion-mod/P3W1-approval-hold.md; 01-contract.md 5.4, 10.1, 11.4, 11.6; design.md section 6 (Inbox, Safety confirms); plan P3-approval.md (P3W1); master plan section 9; run /harnu-awareness before docs/harnu-features.md.
May touch: resources/companion/**, src/main/companion/{ask-*,coverage-core,bridge-standdown-core}.ts, src/main/{approval-parse,approval-resolver,responder-registry,responder-dispatch}.ts, ApprovalRow.vue, InboxRail.vue, stores/session-approvals.ts, design.md, en.json, pt-BR.json, docs/harnu-features.md, docs/user/{approval-inbox,troubleshooting}.md, docs/hook-bridge-integration.md, CHANGELOG.md, tests/**, docs/specs/T389-companion-mod/evidence/**.
Satisfy: AC-P3W1-1 to -39 (-33, -34 human); recipes LV-P3W1-a to -f.
Skills: /local-ci, /harnu-awareness, plugin-authoring, superpowers:test-driven-development (if available; otherwise follow test-first as listed).
Out of scope: holding headless or dontAsk sessions, always-allow or input amendment, suppressing the dialog (Appendix A), any remote approve, the Sentinel engine.
Return: pipeline JSON (cli and e2e), AC table, recipe logs and screenshots, rev-list count, Spec defects.
Autonomy: decide within the spec, do not ask, commit each plan step before reporting.
```

---

## P3W2 — Structured Sentinel rules

| Field  | Value                                                                                                                                                             |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Branch | `feat/t389-p3w2-sentinel`                                                                                                                                         |
| Base   | `feat/t389-p3w1-approval-hold`                                                                                                                                    |
| Spec   | `docs/specs/T389-companion-mod/P3W2-structured-sentinel.md` · contract §10.2                                                                                      |
| Size   | M: 29 ACs (4 mod-test, 3 integration, 1 human)                                                                                                                    |
| Labels | `no-changelog` (the CHANGELOG entry lands with the engine flip); three new top-level main files fire the user-docs gate, covered by `docs/user/approval-inbox.md` |

**Files.** New top-level `src/main/sentinel-rules.ts`, `sentinel-structured-core.ts`, `shell-lex-core.ts` (a conservative tokenizer; anything it cannot tokenize is `unparsed` and falls back to the regex engine). Edit `src/main/sentinel-resolver.ts` (engine seam: E1 ask payload, E2 legacy hook, E3 a `tool.check` query), `src/main/companion/ask-broker.ts` (Sentinel decides before the Inbox parks), `registerAskKind('sentinel', …)`, `beforeHello` carrying `sentinel.set`, `registerPrefsKey('sentinel', {default:'regex', observeCap:'shadow'})`. Mod: `register.ts` (step 2 of the shared `tool.check` registration; never a `tool.call` hook), `api-surface.json`. `src/main/sentinel-core.ts` (the regex engine) stays untouched. Corpus under `tests/fixtures/companion-parity/sentinel/`.

**Steps**

| #   | Commit group              | Tests first (file → ACs)                                                                                                                                                                                                  | Then                                                                                                                       |
| --- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 1   | lexer and structured core | `tests/sentinel-structured-core.test.ts` → AC-P3W2-1 (every positive case of `tests/sentinel-core.test.ts`), -2, -3, -4, -5, -7 (64 KiB under 50 ms), -8                                                                  | `shell-lex-core.ts`, `sentinel-rules.ts` (nine built-ins, `action` is the literal `'deny'`), `sentinel-structured-core.ts` |
| 2   | parity corpus             | `tests/sentinel-parity.test.ts` → AC-P3W2-9                                                                                                                                                                               | corpus: the existing cases, an adversarial set, shadow rows                                                                |
| 3   | resolver seam and key     | `tests/sentinel-resolver.test.ts` → AC-P3W2-6, -10, -11, -12, -14, -20, -27                                                                                                                                               | engine modes `regex`, `shadow`, `structured`; the legacy transport keeps the regex engine                                  |
| 4   | broker path               | `tests/companion/ask-broker.test.ts` → AC-P3W2-13, -26                                                                                                                                                                    | `sentinel` ask kind, E1 before the Inbox parks                                                                             |
| 5   | mod gate                  | `resources/companion/tests/sentinel.test.ts` → AC-P3W2-15, -16, -17, -19, -28; `tests/companion/api-surface.test.ts` → AC-P3W2-18; `tests/companion/contract.test.ts` → AC-P3W2-29 (append a case: P1W1 created the file) | `tool.check` step with a race against a `$.clock` budget; watched list from `sentinel.set`                                 |
| 6   | L4                        | `tests/cli/sentinel.cli.test.ts` → AC-P3W2-21, -22, -23                                                                                                                                                                   | none                                                                                                                       |
| 7   | live-verify and docs      | LV-P3W2-a (AC-24; human AC-25 screenshots `LV-P3W2-a-check.png`, `LV-P3W2-a-request.png`)                                                                                                                                 | `docs/user/approval-inbox.md` Sentinel subsection, `design.md` §6 one sentence                                             |

**Rollout.** The key ships `regex` (today's engine). `regex` to `shadow` records the corpus; `structured` (companion transport only) needs the gate in master plan §7. With `channel` `off` no watched set reaches the mod, so E3 never asks.

**Pipeline.** `scripts/ci/local-pipeline.sh --base feat/t389-p3w1-approval-hold --with-cli --labels no-changelog --json /tmp/p3w2.json`.

**Boot packet**

```text
Objective: structured Sentinel rules (spec P3W2): rules over typed tool and input instead of a regex over a Bash string, evaluated on the permission ask payload (E1), on the legacy hook (E2) and through a tool.check query for watched tools (E3). Migrate the nine built-in patterns; deny-only; the regex engine stays on the legacy transport and is never deleted.
Setup: new worktree from feat/t389-p3w1-approval-hold, branch feat/t389-p3w2-sentinel; npm ci.
Read first: docs/specs/T389-companion-mod/P3W2-structured-sentinel.md; 01-contract.md 10.2; plan P3-approval.md (P3W2); master plan section 9.
May touch: src/main/{sentinel-rules,sentinel-structured-core,shell-lex-core,sentinel-resolver}.ts, src/main/companion/ask-broker.ts and the sentinel ask registration, resources/companion/**, tests/**, tests/fixtures/companion-parity/sentinel/**, docs/user/approval-inbox.md, design.md (one sentence).
Satisfy: AC-P3W2-1 to -29 (-25 human); recipe LV-P3W2-a.
Skills: /local-ci, plugin-authoring, superpowers:test-driven-development (if available; otherwise follow test-first as listed).
Out of scope: a rule editor or rules file, any allow rule, evaluation inside the mod, a tool.call hook, file-tool rules.
Return: pipeline JSON, AC table, recipe log and screenshots, rev-list count, Spec defects.
Autonomy: decide within the spec, do not ask, commit each plan step before reporting.
```

---

### Spec defects touching P3

- P2W3's module table sets `approvalResolver.parks = true`, and P3W1 §7.2 item 1 says "this wave marks the Approval Inbox resolver `parks: true`". Both waves claim the same one-line edit; the plan makes it idempotent (whichever lands second is a no-op).
- `tests/companion/contract.test.ts` is now owned by P1W1 (spec and plan fixed by the plan review); P3W2 and P4W2 only append a case.
- P3W1 AC-P3W1-17 cited `tests/bridge-standdown-core.test.ts` while P2W3 creates `tests/companion/bridge-standdown-core.test.ts` for the same module; both now name the `tests/companion/` path.
