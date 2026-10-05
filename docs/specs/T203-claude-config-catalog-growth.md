# T203 — Grow the Claude config catalog, adopt `attribution`, fix the permission-mode select

**Date:** 2026-08-05 · **Status:** specified (not implemented) · **Card:** `.capy/memory/roadmap/T203-grow-the-claude-config-catalog-past-5-keys-adopt-attribution.md`

## 0. How the CLI was interrogated (record of observation)

Installed binary: **native `2.1.222`**, `/home/u/.local/share/claude/versions/2.1.222` (`claude doctor` → `Config install method: native`).

- **`claude --help`** — there is **no `config` subcommand** any more. The command list is `agents · auth · auto-mode · doctor · gateway · import · install · mcp · plugin · project · setup-token · ultrareview · update`. `claude config --help` prints the _root_ help, and `claude config list` is parsed as a **prompt**, not a command. So the CLI cannot enumerate settings keys for us.
- **`claude --help` does** pin one enum we care about: `--permission-mode <mode> (choices: "acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan")`.
- **`claude doctor` is the real oracle.** It validates every settings file in the cwd against the embedded schema and names the offending dot-path. Unknown keys pass silently, but a **wrong-typed known key errors by name** — so writing a deliberately wrong type is a positive existence-and-type proof. Every row in §4 was proven this way, in `/tmp/ccval/.claude/settings.json`.
- Cross-checked against the schema description strings inside the binary (`strings`), which is where the defaults quoted in §4 come from.

Two claims in the card/audit were **falsified** by this and are corrected below: `default` is _not_ a removed permission mode (§3.2), and `respectGitignore` is _top-level_, not under `fileSuggestion` (§4).

## 1. Goal

Take the Settings → **Claude config** pane from 5 typed controls to 15, replace the deprecated `includeCoAuthoredBy` toggle with the `attribution` object, and make the permission-mode select match what CC 2.1.222 actually accepts — without weakening the main-side write allowlist and without ever hiding an on-disk key.

## 2. Current behaviour, verified

**The five typed entries** — `claude-config-catalog.ts:48-105`: `model` (text), `cleanupPeriodDays` (number, min 1), `includeCoAuthoredBy` (toggle), `permissions.defaultMode` (select: `default|acceptEdits|plan|dontAsk`), `tui` (select: `default|fullscreen`). The header comment (`:1-13`) states the reason the list is hand-curated: **Claude Code publishes no machine-readable schema**, and keys the user never set are simply absent from the file, so the GUI cannot introspect.

**The allowlist is duplicated.** `claude-settings.ts:65-71` hardcodes the same five dot-paths as `ALLOWED_SETTINGS_PATHS`, with a doc comment (`:49-64`) saying it MUST stay in sync with the catalog and is _deliberately not imported_ so the main-side guard never depends on renderer code. It is enforced in `claude-settings-ipc.ts:83-95`: a non-allowlisted path is dropped and **only `console.warn`ed** — the renderer gets `ok: true` and the pane shows a successful save for an edit that never landed. Refusals are exact-match, so `hooks.*`, `statusLine.command` and `permissions.allow|deny|ask` are rejected (`claude-settings.ts:73-81`, pinned by `tests/claude-settings-allowlist.test.ts:26-42`).

**The raw block and its quirk.** `knownTopLevelKeys()` (`claude-config-catalog.ts:119-125`) adds a key only for a **top-level** catalog entry; a nested entry (`permissions.defaultMode`) does not exclude its parent. `ClaudeConfigPane.uncoveredValue()` (`:154-163`) then subtracts the covered leaves, so `permissions` still surfaces read-only with just `allow`/`deny`/`ask`. That is the drift safety valve, pinned by `tests/claude-config-catalog.test.ts:29-34`. **This is correct and stays** — and it is what makes nested `attribution.*` / `worktree.baseRef` entries safe (their uncovered siblings keep showing).

**Out-of-catalog tolerance is real — confirmed.** `SegmentedControl.vue:77-81` appends a synthetic pill for a `modelValue` not present in `options`, so a value from a newer Claude renders as selected instead of showing nothing; `ClaudeConfigPane.vue:140-146` documents that it relies on exactly this. **Preserve both.**

**A gap:** `ControlType` declares `'tags'` (`claude-config-catalog.ts:15`) but no entry uses it and the pane has **no branch for it** — the template falls through `toggle|select|number` to a plain text `v-else` (`ClaudeConfigPane.vue:304-356`). `tags` today silently renders a string input that would write a `string` where CC wants an array.

## 3. The two deprecations

### 3.1 `includeCoAuthoredBy` → `attribution`

Binary schema description, verbatim: _"Deprecated: Use attribution instead. Whether to include Claude's co-authored by attribution in commits and PRs (defaults to true)"_. `attribution` is an **object**, not a boolean — _"Customize attribution text for commits and PRs. Each field defaults to the standard Claude Code attribution if not set."_ Its fields (all type-probed):

- `attribution.commit` — **string**. _"Attribution text for git commits, including any trailers. Empty string hides attribution."_
- `attribution.pr` — **string**. _"Attribution text for pull request descriptions. Empty string hides attribution."_ (The card guessed `pullRequest`; `attribution.pullRequest` is **silently ignored** by the validator — the key is `pr`.)
- `attribution.sessionUrl` — **boolean, default `true`**. _"Whether to append the claude.ai session link to commits and PRs created from web or Remote Control sessions."_

So the UI is **three rows**, not one control: two text inputs + one toggle. (The operator's own `~/.claude/settings.json` already carries `attribution.sessionUrl` _and_ legacy `includeCoAuthoredBy` — the migration case is live, not hypothetical.)

**Migration-on-read rule — no silent rewrite.** CC still reads `includeCoAuthoredBy`, so a file that has it keeps working. The pane must not translate it into `attribution.*` behind the user's back: the patch layer's whole contract is "one toggle = a one-key diff" (`claude-settings.ts:237-249`), and a write the user did not make is exactly the clobber class this module exists to prevent. Instead the catalog entry gains `legacy: true`, and the pane renders a legacy row **only when `isSet(path)`** — i.e. only when the key is on disk — with a deprecation hint pointing at Attribution and a working reset button (unset ⇒ the key disappears and the row with it). The entry stays in `SETTINGS_CATALOG` (so `knownTopLevelKeys()` keeps it out of the raw block, no double display) and stays in the allowlist (so unsetting it is permitted).

### 3.2 The permission mode — the card's premise is wrong, the defect is different

`claude doctor` on an invalid value: `permissions.defaultMode: Invalid value. Expected one of: "acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan"`. And the schema description: _"Default permission mode when Claude Code needs access (**'manual' is accepted as an alias for 'default'**)"_.

So: **`default` is the canonical stored value and is not deprecated**; `manual` is the alias and it is what CC 2.1.200 renamed the _label_ to. `agent-boot.ts:176-186` calls `manual` "the safe mode's canonical name … the old `default` survives only as a hidden alias" — that is backwards for **settings**, but correct for its own surface: the **flag** `--permission-mode` accepts `acceptEdits · auto · bypassPermissions · manual · dontAsk · plan` and has **no `default`**. Two different enums on two different surfaces; the app is not contradicting itself so much as conflating two vocabularies.

The real defects, then: (a) the label says "Default" where the CLI now says **Manual**; (b) **`auto` is missing** from the select. Fix both. Do **not** add `bypassPermissions`: its absence is a deliberate safety posture (`forceDowngradePermission`, `agent-boot.ts:183-186`, CHANGELOG 2026-07-xx "dropped the removed `bypassPermissions`") — keep it out and say so in the code comment, since the CLI does accept it. A `manual` already on disk must resolve to the `default` pill: add `aliases?: string[]` to `SelectOption` and a pure `resolveSelectValue(def, diskValue)` helper, rather than letting `SegmentedControl` render a bare orphan `manual` pill.

## 4. New keys

Every row proven against installed `claude 2.1.222` by a wrong-type `claude doctor` probe. **Confirmed = the validator named the dot-path and its expected type.**

| Key (dot-path)                    | Control                           | Default (per binary schema)     | CC ver  | Confirmed | Probe verdict                                                                    |
| --------------------------------- | --------------------------------- | ------------------------------- | ------- | --------- | -------------------------------------------------------------------------------- |
| `attribution.commit`              | text (`git`)                      | CC standard attribution         | 2.0.62  | **yes**   | `Expected string, but received number`                                           |
| `attribution.pr`                  | text (`git`)                      | CC standard attribution         | 2.0.62  | **yes**   | `attribution.pr: Expected string…` (not `pullRequest`)                           |
| `attribution.sessionUrl`          | toggle (`git`)                    | `true`                          | 2.1.183 | **yes**   | `Expected boolean, but received string`                                          |
| `language`                        | text (`general`)                  | unset                           | 2.1.0   | **yes**   | `Expected string, but received number`                                           |
| `fallbackModel`                   | tags → **array** (`general`)      | unset                           | 2.1.166 | **yes**   | `Expected array, but received string`; `fallbackModel.0: Expected string`        |
| `showTurnDuration`                | toggle (`interface`)              | undocumented → render "not set" | 2.1.7   | **yes**   | `Expected boolean, but received string`                                          |
| `autoScrollEnabled`               | toggle (`interface`)              | undocumented → render "not set" | 2.1.110 | **yes**   | `Expected boolean, but received string`                                          |
| `respectGitignore`                | toggle (`general`)                | `true`                          | 2.1.0   | **yes**   | **top-level**, `Expected boolean…`; `fileSuggestion.respectGitignore` is ignored |
| `plansDirectory`                  | text (`general`)                  | `~/.claude/plans/`              | 2.1.10  | **yes**   | `Expected string, but received number`                                           |
| `worktree.baseRef`                | select `fresh\|head` (`worktree`) | `fresh`                         | 2.1.133 | **yes**   | `Invalid value. Expected one of: "fresh", "head"`                                |
| `permissions.defaultMode` +`auto` | select option                     | (`default`, labelled Manual)    | —       | **yes**   | enum from the validator, §3.2                                                    |

`fallbackModel` is an **array of strings** (`--fallback-model` takes a comma-separated list; the _setting_ is a real array). It is the only entry needing the unimplemented `tags` type — see §5.

Out of scope, deliberately: `emojiCompletionEnabled` / `spinnerTipsEnabled` (real keys, cosmetic, not on the card) and everything under `fileSuggestion` (its object **requires** `type: "command"` + `command: <string>` — a command-executing field the renderer must never write).

## 5. Decision

**Allowlist: keep the two lists separate, make drift un-shippable.** Do not import the catalog into `src/main/`. The stated reason (`claude-settings.ts:56-64`) still holds — the guard is a _security_ boundary and must not derive its permissions from the surface it is guarding — and the two lists genuinely answer different questions ("what do we render" vs "what may be written"). Instead: (a) upgrade `tests/claude-settings-allowlist.test.ts:50-54` from a hardcoded literal to a **derived set-equality assertion** — it imports `SETTINGS_CATALOG`, maps to `path`, and asserts equality with `ALLOWED_SETTINGS_PATHS` modulo an explicit, commented `NOT_WRITABLE` exception array (empty today). A new control without an allowlist entry then fails CI instead of silently no-op-ing on save. (b) Make the drop **visible**: `applyWirePatch` returns the rejected paths in `ClaudeSettingsPatchResult`, and the pane surfaces them in its existing error banner instead of reporting a clean save.

**UI shape.** No new component file, no new token. Rows reuse the existing anatomy; `attribution` is three rows in a new `git` group; `worktree.baseRef` is one select in a new `worktree` group. `SETTING_GROUPS` becomes `general · git · permissions · worktree · interface`. `tags` is implemented as a **comma-separated text input** over the existing text anatomy (`join(', ')` on read, `split(/,\s*/)` + trim + drop-empties on write, empty ⇒ reset), not a new pill widget.

**design.md.** §6 → Settings dialog → **"### Claude config (settings.json)"** (`design.md:4287-4322`) governs this pane, and must be edited **first, same change**, for four things: (1) the group list gains **Git** and **Worktree**; (2) the **list (comma-separated)** control is documented under the control-type list; (3) the **legacy row** rule (a deprecated field renders only when set on disk, with a deprecation hint); (4) a stale line is corrected while we are in there — `:4309` still says selects are a bordered `<select>`, but the pane has used `SegmentedControl` pills since T-. No new color, radius, easing or row height is introduced, so **no new component variant is required beyond those doc entries.**

**The two type additions** (`claude-config-catalog.ts`), both additive and optional so the existing five entries are untouched:

```ts
export interface SelectOption {
  value: string
  labelKey?: string
  /** On-disk values CC accepts as synonyms of `value` (e.g. `manual` → `default`).
   *  Resolved on READ only; the catalog always WRITES the canonical `value`. */
  aliases?: string[]
}

export interface SettingDef {
  // …unchanged…
  /** Deprecated upstream. The row renders ONLY when the key is present on disk,
   *  carries `deprecatedKey` as a hint, and is never written implicitly. */
  legacy?: boolean
  /** i18n key for the deprecation hint (required when `legacy`). */
  deprecatedKey?: string
}

/** Disk value → the option that should read as selected. Pure; unit-tested. */
export function resolveSelectValue(def: SettingDef, disk: unknown): string | undefined
```

`tags` encode/decode is fixed and total: read `Array.isArray(v) ? v.join(', ') : ''`; write `raw.split(',').map(s => s.trim()).filter(Boolean)`, and an empty result calls `resetField` (delete the key) rather than writing `[]` — `[]` is a meaningful value for some CC array settings and must not be produced by "the user cleared the box".

**i18n keys** (every one in **both** `en.json` and `pt-BR.json`): `claudeConfig.groups.git`, `claudeConfig.groups.worktree`; `claudeConfig.fields.<f>.{label,desc}` for `attributionCommit`, `attributionPr`, `attributionSessionUrl`, `language`, `fallbackModel`, `showTurnDuration`, `autoScrollEnabled`, `respectGitignore`, `plansDirectory`; `claudeConfig.fields.worktreeBaseRef.{label,desc,optFresh,optHead}`; `claudeConfig.fields.defaultMode.optAuto` (new) and a **reworded** `optDefault` → "Manual"; `claudeConfig.fields.includeCoAuthoredBy.deprecated`; `claudeConfig.listHint`. ≈27 leaf paths × 2 files.

## 6. Acceptance

- The pane renders 15 typed controls; every one writes a value the installed `claude doctor` accepts.
- `attribution.commit` / `.pr` / `.sessionUrl` are editable; a legacy `includeCoAuthoredBy` on disk still renders (as a deprecated row) and can be unset, and is **never** rewritten into `attribution.*` implicitly.
- The permission-mode select offers `default` (labelled **Manual**), `acceptEdits`, `plan`, `dontAsk`, `auto` — and not `bypassPermissions`. A `manual` on disk selects the Manual pill instead of an orphan pill.
- `hooks.*`, `statusLine.command`, `permissions.allow|deny|ask` and `fileSuggestion.command` stay refused by `isAllowedSettingsPath`.
- A catalog path with no allowlist entry fails a test, not a user's save. A dropped path is shown to the user.
- Uncovered siblings of `permissions`, `attribution` and `worktree` still surface read-only in Advanced.
- `en.json` and `pt-BR.json` are at parity; `npm run typecheck` and `npm run build` pass.

## 7. Test plan

| Test                                                                                                                                                                  | File                                                                                | Asserts                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------- |
| `permissions.defaultMode` offers exactly `default·acceptEdits·plan·dontAsk·auto`, never `bypassPermissions`                                                           | `tests/claude-config-catalog.test.ts` (**replaces** `:69-73`)                       | §3.2                                      |
| `worktree.baseRef` offers exactly `fresh\|head`, default `fresh`; `tui` still exactly `default\|fullscreen`                                                           | `tests/claude-config-catalog.test.ts` (existing BUG-16 block)                       | §4                                        |
| `resolveSelectValue` maps a disk `manual` to the `default` option; leaves an unknown value untouched (pill fallback)                                                  | `tests/claude-config-catalog.test.ts` (new describe)                                | §3.2, `SegmentedControl.vue:77-81`        |
| `knownTopLevelKeys()` excludes `includeCoAuthoredBy` but **not** `attribution`/`worktree`/`permissions`                                                               | `tests/claude-config-catalog.test.ts` (extends `:29-34`)                            | §2 raw-block quirk stays intact           |
| catalog paths ≡ `ALLOWED_SETTINGS_PATHS` (derived, not literal), modulo a commented `NOT_WRITABLE` list                                                               | `tests/claude-settings-allowlist.test.ts` (**replaces** `:50-54`)                   | §5 de-dup call                            |
| refusals hold for `hooks.*`, `statusLine.command`, `permissions.allow\|deny\|ask`, plus new near-misses `fileSuggestion.command`, bare `worktree`, bare `attribution` | `tests/claude-settings-allowlist.test.ts` (extends `:26-42`)                        | §6                                        |
| patching `attribution.commit` + `worktree.baseRef` creates the intermediate objects, preserves siblings and key order; `UNSET` deletes the leaf only                  | `tests/claude-settings-write.test.ts` (existing)                                    | `applyPatch` `claude-settings.ts:210-249` |
| `applyWirePatch` reports rejected paths in its result                                                                                                                 | `tests/claude-settings-allowlist.test.ts` or a sibling for `claude-settings-ipc.ts` | §5(b)                                     |
| every new i18n key exists in both locales                                                                                                                             | `tests/ci-i18n-parity.test.ts` (existing, automatic)                                | i18n contract                             |

**Not unit-testable, do it by hand:** that each written value survives `claude doctor`. Save every new control once and run `claude doctor` against `~/.claude/settings.json` — that is the same loop that caught BUG-16 (`tui: "inline"`).

## 8. Contracts touched

- **i18n parity — YES, hard.** ~27 new leaf paths must land in `en.json` **and** `pt-BR.json` in the same change; `MessageSchema = typeof en` makes a missing pt-BR key a `vue-tsc` build failure, and `tests/ci-i18n-parity.test.ts` fails first with a named path.
- **`design.md` — YES.** Four edits to §6 "Claude config (settings.json)" (`:4287-4322`), landed **before** the code, per §5.
- **`CHANGELOG.md` — YES.** `### Added` (ten new settings) + `### Changed` (Co-authored-by row replaced by Attribution; permission mode relabelled Manual and gains Auto).
- **`docs/user/` — YES.** `docs/user/settings.md:8` currently says "the handful of settings Capy understands (model, cleanup period, permission defaults, and a few others)" — that sentence becomes wrong. Note: the CI gate `scripts/ci/user-docs-gate.mjs` will **not** fire (no new top-level component, no new `src/main/` file, no `tool-catalog.ts` change) — this is the contract, not the gate, and the contract wins.
- **`docs/capy-features.md` — NO.** No MCP verb, no ACK field, no grant/confirm semantics, no affordance the session should offer the user. Nothing here is agent-actionable. `no-awareness` if the gate trips on an unrelated file.
- **English-only — YES, applies.** All new prose (comments, changelog, user doc, `en.json`) in English; `pt-BR.json` is the sole exception.

## 9. Definition of done

- [ ] `design.md` §6 "Claude config" updated first (Git + Worktree groups, list control, legacy row, `<select>`→segmented correction)
- [ ] `claude-config-catalog.ts`: 10 new entries, `auto` added to the permission select, `SelectOption.aliases`, `SettingDef.legacy`, `resolveSelectValue()`
- [ ] `ClaudeConfigPane.vue`: `tags` branch (comma-separated), legacy-row visibility + deprecation hint, alias-aware select value, rejected-path surfacing
- [ ] `claude-settings.ts`: `ALLOWED_SETTINGS_PATHS` extended to the 15 paths; refusal comment updated to name `fileSuggestion.command`
- [ ] `claude-settings-ipc.ts`: `ClaudeSettingsPatchResult` carries `rejected: string[]`
- [ ] `en.json` + `pt-BR.json` at parity for all new keys
- [ ] Tests in §7 green (`tests/claude-config-catalog.test.ts`, `tests/claude-settings-allowlist.test.ts`, `tests/claude-settings-write.test.ts`, `tests/ci-i18n-parity.test.ts`)
- [ ] Manual `claude doctor` sweep after saving each new control — zero "Invalid settings"
- [ ] `CHANGELOG.md` entry under `## 2026-08-05` (or the landing date); `docs/user/settings.md` updated
- [ ] `npm run typecheck` and `npm run build` pass
