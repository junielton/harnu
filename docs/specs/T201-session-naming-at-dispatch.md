# T201 — Name sessions with `--name` at dispatch; delete the Haiku auto-namer

**Date:** 2026-08-05 · **Status:** specified (not implemented) · **Card:** `.capy/memory/roadmap/T201-name-sessions-with-name-at-dispatch-and-retire-the-haiku-auto.md`
**Audit:** `.capy/out/claude-code-sync-audit.md` §3.3 · **Verified against:** repo `main` @ `c71eef5`, Claude Code **2.1.222** (`claude --version`, this machine)

## 1. Goal and the cost being removed

A board-dispatched session should be **born** with the card's name — `T201-session-naming-at-dispatch` — instead of Capy paying a second `claude` process afterwards to invent one. Naming at dispatch is also traceability the board wants anyway: the name is greppable in the CLI picker and terminal title, and `claude -p --resume <name>` accepts titles (CC v2.1.101).

**Correction to the card.** The card says the namer costs "one `claude -p` process per session". Verified: it is **opt-in and default OFF** — `session-autoname.ts:19-26` reads `om2tab.haikuAutoname` from `localStorage` and returns `false` when absent, and the Settings toggle (`SettingsDialog.vue:646-660`) is the only writer. So the cost being removed is _one Haiku process per born-synthetic session, for operators who turned the toggle on_ — plus the permanent carrying cost of ~350 lines across 4 source files, 2 test files, an IPC channel, a preload function and 2 i18n key pairs, for a feature the CLI now does itself.

## 2. Current behaviour, verified — the naming pipeline end to end

**2.1 What Haiku actually does.** `session-autoname.ts:55-79` (`maybeAutoname`, called from `sessions.ts:4386` on the `onSessionUpdated` stream) fires at most once per session, guarded by: the toggle, `bornSyntheticIds.has(id)` (so it **never** touches a session Capy did not launch), `!s.summary`, `!s.aiSummary`, non-empty `firstPrompt`, and an `autonameInFlight` set. It calls `window.api.haikuAutoname` (`preload/index.ts:1590-1594`) → `ipcMain.handle('haiku:autoname')` (`haiku.ts:108-125`) → `runHaiku` (`haiku.ts:86-103`): single-flight per `key: autoname:<sessionId>`, sha1 content-hash cache with a 10-minute TTL (`haiku.ts:27-28`), `execFile` of `claude -p <prompt> --model haiku --append-system-prompt <AUTONAME_SYSTEM>` (`haiku-autoname.ts:33-37`) with `cwd: homedir()`, sanitized env, **20 s timeout**, never rejects. The "one call per session" claim holds: the in-flight set plus the `!s.aiSummary` guard plus `bornSyntheticIds.delete(id)` on success mean at most one spawn per session per app run.

**2.2 Where the title lands — it is NOT a transcript entry.** On success the handler's `{title, summary}` is written to `cur.aiSummary` (`session-autoname.ts:71`), a **renderer runtime overlay** on the `Session` row (`sessions.ts:199`), re-attached across reloads at `sessions.ts:3700-3768` and never persisted to the JSONL. It is consumed only by the label cascades — `Topbar.vue:107`, `SidebarFolder.vue:155`, `FleetBoardCard.vue:60`, all `s.summary || s.aiSummary?.title || s.firstPrompt || t('session.unnamed')`. So Haiku's title already ranks **below** every transcript title.

**2.3 The transcript title chain.** `deriveTitles` (`transcript-truth.ts:220-248`) scans for four entry types, **latest occurrence of each wins**: `custom-title` (a `/rename`), `ai-title` (the CLI's own generated title), `task-summary`, `last-prompt`. `pickTitle` (`transcript-truth.ts:254-256`) is `customTitle || aiTitle || ''`; `pickWhatsHappening` (`:262-267`) is `taskSummary || lastPrompt || firstPrompt`. The reader applies the same rule inline: `summary: header.customTitle || header.aiTitle` (`claude-reader.ts:854`), and `whatsHappening` at `:872`. **A CLI-generated name arrives here** — as an `ai-title` or `custom-title` line the CLI appends — which is exactly one rung above `aiSummary` and one below `/rename`.

**2.4 `--name` is already emitted; the cascade already carries it.** `ClaudeBootConfig.name` (`claude-args.ts:36-37`) → `buildClaudeArgs` pushes `--name <trimmed>` (`claude-args.ts:376`). `name` is **not** in `ACCUMULATE_TEXT_KEYS`/`ACCUMULATE_LIST_KEYS` (`claude-args.ts:248,256-261`), so it is a plain **replace** field in `mergeBootConfig` (`:299-330`); `mergeFromFile` folds global → folder → session (`claude-config.ts:195-208`), so a **session-scope** name beats a folder or global one. The session-scope value reaches there as `Session.bootOverride` → `resolveSpawnSpec` → `ptyCreate` (`TerminalPane.vue:483-507`) → `resolveClaudeBootArgs` (`pty.ts:683`, `claude-config.ts:258-272`). No new plumbing is needed — only call sites.

**2.5 The dispatch call sites.** (a) Board: `RoadmapBoard.vue:648` `sessions.dispatchCardSession(spawnFolder, prompt, routing)` inside `spawnAndBind`, which has the full `card` in scope. (b) Background drain: `manifest-drain-shell.ts:126-140` dispatches the `session.dispatchCard` bridge command with `bootOverride: { model, effort }`; the pure driver `manifest-drain.ts:251` has `card.slug` in scope (`DrainCardView.slug`, `:18-29`). (c) The renderer end, `handleSessionDispatchCard` (`command-router.ts:453-472`), re-projects the payload to **exactly** `{model?, effort?}` — this is the one allowlist that must widen. `dispatchCardSession` (`sessions.ts:2524-2569`) then attaches the object as the synthetic's `bootOverride`.

**2.6 `agent-boot.ts` is untouched — and compatibly so.** `ALLOWED_KEYS = {model, effort}` (`mcp/agent-boot.ts:42`) gates the **MCP `create_session`** path (`tool-handlers.ts:695,734` → `session.create` → `insertAgentSession`), not `session.dispatchCard`. T201's name is minted by Capy from the card slug on the dispatch path; an agent never supplies it. The gate stays exactly as frozen.

**2.7 Field evidence: the CLI does not name everything.** On CC 2.1.222, of the 25 most recently modified transcripts under `~/.claude/projects/`, **1 carries an `ai-title`** and 1 a `custom-title`. The one that does reads `"aiTitle":"Sincronizar features entre Claude Code e Capy"` — Portuguese, i.e. the CLI's generated-title language follows CC's own `language` setting (v2.1.176), not Capy's app locale. Also relevant: CC 2.1.152+ stopped writing `sessions-index.json` in new slugs (`claude-reader.ts:362-364`), so the JSONL scrape is the live path. **Conclusion: "the CLI names sessions now" is weaker than the card assumes** — but it does not change the decision, because the Haiku namer never covered those sessions either (they are not born-synthetic, and the toggle is off).

## 3. Decision

**3.1 Emit `--name` at both dispatch call sites.** Add a pure `cardSessionName(slug: string): string` beside `slugifyTitle` in `roadmap-core.ts:962` — trim to `[a-z0-9-]`, collapse hyphens, cap at 60 chars on a hyphen boundary, return `''` when nothing survives (caller then omits `name`, never emits an empty flag). Card slugs are already filename-safe, and `buildClaudeArgs` pushes the value as its own argv token through `node-pty` with no shell, so this is belt-and-braces, not the security boundary.

- `RoadmapBoard.vue` `spawnAndBind`: `dispatchCardSession(spawnFolder, prompt, { ...routing, name: cardSessionName(card.slug) })`.
- `manifest-drain.ts`: widen `DrainPassDeps.spawnSession` with a `name` argument, derived in the pure driver from `card.slug`; `manifest-drain-shell.ts` puts it on the forwarded `bootOverride`.
- `command-router.ts` `handleSessionDispatchCard`: accept `name` alongside `model`/`effort`, re-sanitized through `cardSessionName` on arrival (the router is a trust border; it must not trust the sender's shaping).

**3.2 The Haiku auto-namer is deleted, not gated.** Delete `src/main/haiku-autoname.ts`, `src/main/haiku.ts`, the `haiku:autoname` handler + its `registerHaikuHandlers`/`closeHaiku` wiring in `index.ts:136`, `preload/index.ts:1590-1594`, `src/renderer/src/stores/session-autoname.ts` and its use at `sessions.ts:27,1451-1455,4386`, the Settings block (`SettingsDialog.vue:643-660,771,1549-1575`), the two i18n key pairs, and `tests/haiku-autoname.test.ts` + `tests/session-autoname.test.ts` + `tests/haiku-service.test.ts`. `Session.aiSummary` and its reload re-attach (`sessions.ts:199,3700-3768`) go with it, and the three label cascades collapse to `s.summary || s.firstPrompt || t('session.unnamed')`.

Why delete rather than keep behind the existing toggle: the feature is **already inert in the case it was built for**. Its guard is `!s.summary` (`session-autoname.ts:59`) and `summary = customTitle || aiTitle` (`claude-reader.ts:854`) — so the moment the CLI writes an `ai-title`, the namer never fires. What remains is a default-OFF toggle whose only reachable effect is a title that ranks below the transcript's. A dead flag is a worse liability than a deleted module, and `git revert` is the cheap undo.

`haiku.ts` (`runHaiku`) goes too: `haiku:autoname` is its **only** consumer (grep: no other `runHaiku` import in `src/main/`), and `usage.ts:44-46` spawns its own `claude -p '/usage' --model haiku` independently. Audit §3.6 wants a `--json-schema` Haiku substrate later; rebuilding 140 lines from git history when a real second consumer exists beats carrying dead substrate.

**3.3 Title precedence is preserved in both possible CLI behaviours.** Open question O-1 below is _which_ entry `--name` persists. It does not matter for `/rename`: if `--name` writes an `ai-title`, `pickTitle` prefers `customTitle` (`transcript-truth.ts:254-256`); if it writes a `custom-title`, `deriveTitles` is latest-wins per type (`:220-248`) so a later `/rename` overwrites it. Either way the user's explicit rename is the label. And because the deleted `aiSummary` sat _below_ both, deleting it cannot move any title up.

**3.4 Sessions Capy did not launch do not regress.** They were never Haiku-named (the `bornSyntheticIds` gate, `session-autoname.ts:58`). Their label stays `summary || firstPrompt || 'Untitled'` — the CLI's own name when it writes one (v2.1.196), the first user prompt otherwise. Nothing about that path is touched.

**3.5 Capy's exclusion of its own background `claude` runs keeps its purpose.** BUG-77's `classifyTranscriptLines` (`claude-watcher.ts:458-490`, applied at `:720-737`) and the scan-path twin (`claude-reader.ts:842`) exist because Capy spawns `claude -p` with `cwd: homedir()` into a watched slug. After T201 the `/usage` poller (`usage.ts:44-46`) still does exactly that — so **keep both guards unchanged**; only the module doc-comment in `claude-watcher.ts:466` that lists "the Haiku auto-namer" as an example needs its wording trimmed.

**Alternatives rejected.** _(a) Keep behind the setting_ — leaves a default-OFF flag whose reachable effect is a title below every other title; §3.2. _(b) `SessionStart` hook returning `hookSpecificOutput.sessionTitle` (v2.1.152)_ — Capy already subscribes `SessionStart` (`hook-installer.ts:44`), but its handlers are **observers**: a loopback POST (`http` transport, or `curl -s -X POST` in `command` mode, `hook-installer.ts:79-81`) installed **globally** in `~/.claude/settings.json`, firing for every session on the machine including ones Capy did not launch. Turning an observer into a decision-emitting hook means the bridge must synchronously resolve which card a brand-new session belongs to and return a JSON body on the hook's response — new coupling, new failure mode, and it would have to no-op for most sessions. `--name` is the same outcome with an argv token. _(c) `--json-schema` for the Haiku call (audit §3.6)_ — hardens a call this card removes.

**Open questions (resolve before/while implementing).**

- **O-1 (blocking the acceptance assertion, not the change):** does `claude --name X` persist `X` into the transcript as `custom-title`, as `ai-title`, or nowhere Capy's reader can see? Verify by launching `claude -n t201-probe` in a scratch folder and grepping the fresh JSONL for `"type":"custom-title"|"ai-title"`. If it persists **nowhere**, the name is still worth emitting (CLI picker, terminal title, `--resume <name>`), but Capy's sidebar label continues to come from `firstPrompt` and the card's traceability claim must be stated honestly in the CHANGELOG.
- **O-2:** the CC `language` setting (v2.1.176) pins generated-title language; §2.7 shows a Portuguese `ai-title` on this machine. Capy's app locale (`om2tab.locale` → `app-locale.ts` → `memoryLanguageLine`, `memory-language.ts:36-42`) is a _different_ knob and governs project-memory writes only. **Deliberately not coupled here.** Dispatched names are ASCII card slugs, so they are language-neutral by construction. Exposing CC's `language` belongs in `claude-config-catalog.ts` (which today declares exactly 5 keys: `model`, `cleanupPeriodDays`, `includeCoAuthoredBy`, `permissions.defaultMode`, `tui`) — audit §3.5, a separate card.

## 4. Acceptance

- A card dispatched from the board **and** one drained from the manifest both launch with `--name <card-slug>` in the spawned argv, capped and sanitized, and omit the flag entirely when the slug sanitizes to empty.
- The name is a **session-scope** override: it wins over a `name` set in the global or per-folder Claude Boot config, and does not leak into any other session.
- A `/rename` still wins the sidebar/topbar label after a `--name` launch.
- No `claude -p` process is spawned for naming any more; `grep -r haiku src/renderer src/preload` returns nothing, and `src/main/haiku*.ts` is gone.
- Sessions Capy did not launch label identically to today.
- The MCP `create_session` boot allowlist is unchanged (`{model, effort}`).
- `npm run typecheck`, `npm run lint`, `npm run test:coverage`, `npm run build` pass.

## 5. Test plan

| Test                                                                                                                           | File                                                                     | Asserts                                                                |
| ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `cardSessionName` — slugifies, caps on a hyphen boundary, returns `''` for unusable input                                      | `tests/roadmap-core.test.ts` (existing, beside the `slugifyTitle` cases) | §3.1                                                                   |
| `buildClaudeArgs` emits `--name <v>`, omits it when blank/whitespace                                                           | `tests/claude-args.test.ts` (existing)                                   | `claude-args.ts:376`; today only `--remote-control` is covered (`:70`) |
| `mergeBootConfig` — a session-scope `name` REPLACES a global/folder one (not accumulated)                                      | `tests/claude-args.test.ts` (existing)                                   | §2.4, `ACCUMULATE_*` exclusion                                         |
| `session.dispatchCard` forwards a sanitized `name` alongside `model`/`effort`; a garbage `name` is dropped, not passed through | `tests/command-router.test.ts` (existing `describe` at `:437`)           | §3.1 trust border                                                      |
| the drain passes each card's own name to `spawnSession` (per-card, not shared)                                                 | `tests/manifest-drain.test.ts` (existing `runDrainPass` suite, `:111`)   | §3.1 (b)                                                               |
| MCP boot allowlist still rejects `name` as a forbidden agent field                                                             | `tests/mcp-agent-boot.test.ts` (existing)                                | §2.6 — regression guard, must stay red-on-widening                     |
| `/rename` (`custom-title`) still beats `ai-title`, latest-wins per type                                                        | `tests/transcript-truth.test.ts:278-294` (existing, unchanged)           | §3.3 — proves precedence survives the deletion                         |
| `tests/haiku-autoname.test.ts`, `tests/session-autoname.test.ts`, `tests/haiku-service.test.ts`                                | **deleted**                                                              | dead code has no tests                                                 |

Not unit-testable here: **O-1** (what `--name` writes to the JSONL) is a live-CLI fact. Verify it with the scratch-folder probe in §3, or the second-instance recipe in `docs/dev/live-verify-second-instance.md`. Do not assert it from a mock.

## 6. Contracts touched

- **`CHANGELOG.md` — YES.** One `### Changed` bullet (dispatched sessions are named after their card) and one `### Removed` bullet (the Haiku auto-name toggle, superseded by the CLI's own naming). Both are user-facing.
- **`docs/capy-features.md` — NO.** No MCP verb added or changed, no ACK field, no grant/confirm semantics, no affordance the session should offer. `src/main/mcp/tool-catalog.ts` and `src/main/capy-features.ts` are untouched, so `scripts/ci/awareness-gate.mjs` does not trip and **no `no-awareness` label is needed**.
- **`docs/user/` — YES, one page.** `docs/user/roadmap-board.md` gains a sentence that a dispatched session is named after its card. `docs/user/settings.md` needs **no** edit: it has no Intelligence section (headings are `Settings`, `Sidebar`, `Hibernation policy`), so the removed toggle was never documented. The gate itself does not trip (no new top-level component, no new `src/main/` file, no `tool-catalog.ts` change) — this update is on merit.
- **i18n parity — YES, by deletion.** `settings.intelligence.autonameLabel` and `.autonameHint` are removed from **both** `en.json:867-868` and `pt-BR.json:867-868` in the same change; if the whole `intelligence` object is left empty, drop it from both. No new keys are added (the name is a slug, never displayed as prose).
- **`design.md` — NO.** No new token, component, motion spec or row; a Settings row is removed, which §6 does not enumerate individually.
- **English-only — YES, trivially.** All new code, comments, tests and the CHANGELOG entry are English; the only Portuguese touched is the `pt-BR.json` deletion, which is the i18n exception.

## 7. Definition of done

- [ ] O-1 verified against the real CLI, and its answer written into this spec + the CHANGELOG wording
- [ ] `cardSessionName` in `roadmap-core.ts`, pure and unit-tested
- [ ] `--name` emitted from the board dispatch (`RoadmapBoard.vue` `spawnAndBind`)
- [ ] `--name` emitted from the manifest drain (`manifest-drain.ts` driver + `manifest-drain-shell.ts` shell)
- [ ] `command-router.ts` `handleSessionDispatchCard` accepts + re-sanitizes `name`
- [ ] `haiku.ts`, `haiku-autoname.ts`, `session-autoname.ts`, the IPC channel, the preload fn, the `index.ts` wiring and the Settings block deleted
- [ ] `Session.aiSummary` and the three label cascades collapsed; reload re-attach at `sessions.ts:3700-3768` cleaned
- [ ] `claude-watcher.ts:466` doc-comment no longer cites the auto-namer; both BUG-77 guards left functionally unchanged
- [ ] i18n keys removed from `en.json` **and** `pt-BR.json`
- [ ] tests in §5 green; the three deleted test files gone
- [ ] `CHANGELOG.md` entry under `## 2026-08-05`
- [ ] `docs/user/roadmap-board.md` updated
- [ ] `npm run typecheck` and `npm run build` pass
