# T217 — Bundled skills: Capy ships its own skills with a per-skill on/off panel

**Status:** Design (no code)
**Date:** 2026-08-22
**Card:** `T217-bundled-skills-capy-ships-its-own-skills-orchestrate-delivery` (backlog, feature, complex, substrate `worktree`)
**ADR:** [`docs/adr/0009-bundled-skill-delivery-channel.md`](../adr/0009-bundled-skill-delivery-channel.md)
**Research:** [`docs/research/2026-08-22-delivery-assurance-north-star.md`](../research/2026-08-22-delivery-assurance-north-star.md) §9.2 + the "Open follow-up" paragraph
**Blocks:** T216 stage S3 (delivery assurance) — this card is a hard dependency
**Related:** T50 Skills manager (ready) — see §10

---

## 1. Problem

Capy's delivery loop lives entirely in the operator's personal user-level configuration:

| Content                | Where it lives today                                                                                              | Size             |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------- |
| `orchestrate-delivery` | `~/.claude/commands/orchestrate-delivery.md`                                                                      | 203 lines        |
| `delivery-verifier`    | `~/.claude/skills/delivery-verifier/SKILL.md`                                                                     | 140 lines        |
| `mission`              | `~/.claude/skills/mission/SKILL.md` (+ `LESSONS.md`)                                                              | 128 lines        |
| `orchestrator`         | `~/.claude/skills/orchestrator/` (+ `LESSONS.md`, `references/delivery-contract.md`, `references/enforcement.md`) | 173 lines + refs |
| `capy-conductor`       | `.claude/skills/capy-conductor/SKILL.md` (this repo only)                                                         | —                |

A packaged Capy installed by anyone else gets **none** of it. Capy has an actuator (the
MCP verbs, the dispatch manifest, worktrees) and ships no method for using it. The
north-star research calls this out directly (§9.2): _"Until that exists, S0 is a prototype
on the owner's machine, not a shippable feature."_

Capy's only existing injection mechanism is **modes** (`src/main/session-modes.ts`) — a
versioned markdown doc concatenated into the `--append-system-prompt` preamble at spawn
(`pty.ts:653-680`). That is always-on prose, not an invocable skill. §5 explains why the
two coexist rather than merge.

## 2. Delivery channel — the decision

**Chosen: a Capy-owned plugin directory passed at spawn via `--plugin-dir`, staged into
userData from `resources/skills/`.** Full reasoning, the rejected alternatives and their
costs are in [ADR-0009](../adr/0009-bundled-skill-delivery-channel.md). The essentials:

### 2.1 What was verified, against Claude Code 2.1.239

Every line below is **ANSWERED** with the evidence named. Nothing here is inferred.

| Claim                                             | Verdict                                            | Evidence                                                                                                                                                                                                                             |
| ------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Installed CLI version                             | ANSWERED                                           | `claude --version` → `2.1.239 (Claude Code)`; binary `~/.local/share/claude/versions/2.1.239`, `BUILD_TIME 2026-08-21T04:40:30Z`                                                                                                     |
| `--plugin-dir` exists and is repeatable           | ANSWERED                                           | `claude --help`: _"Load a plugin from a directory or .zip for this session only (repeatable: `--plugin-dir A --plugin-dir B.zip`)"_                                                                                                  |
| Required on-disk shape                            | ANSWERED                                           | `.claude-plugin/plugin.json` + `skills/<name>/SKILL.md`; `claude plugin validate --strict` on that shape → only an `author` warning, no structural error                                                                             |
| The skill actually reaches the session            | ANSWERED                                           | Probe `capy-t217-probe` (marker `ZQ7RIVERBED`): **with** the flag → YES; **control, no flag, same cwd** → NO                                                                                                                         |
| Skills arrive **namespaced** `capy:<name>`        | ANSWERED                                           | The same probe was reported by the session as `capy:capy-t217-probe`                                                                                                                                                                 |
| It does **not** shadow personal skills            | ANSWERED                                           | Two bundled dirs carrying `orchestrate-delivery` + `mission` alongside the operator's own → the session listed all four: `mission`, `orchestrate-delivery`, `capy-orchestrate-delivery:orchestrate-delivery`, `capy-mission:mission` |
| Writes nothing to the repo; survives `git clean`  | ANSWERED                                           | Absolute path outside the tree, "for this session only"; probe runs left the `projtest` working tree untouched                                                                                                                       |
| Does **not** reach a session Capy did not spawn   | ANSWERED                                           | It is a spawn flag; directly observed in the control arm                                                                                                                                                                             |
| Not stripped by Capy's own argv denylist          | ANSWERED                                           | `claude-args.ts` `DENY_BOOL`/`DENY_VALUE` cover `--resume`, `-r`, `--session-id`, `--output-format`, `--input-format` + booleans — `--plugin-dir` is absent                                                                          |
| `--safe-mode` disables bundled skills             | ANSWERED (doc quote)                               | `claude --help`: _"all customizations (CLAUDE.md, skills, plugins, hooks, …) disabled"_                                                                                                                                              |
| `--bare` still honours an explicit `--plugin-dir` | ANSWERED (doc quote; not re-tested under `--bare`) | `claude --help` for `--bare` names `--plugin-dir` among the ways to "explicitly provide context"                                                                                                                                     |

Rejected channels, also verified rather than assumed:

| Channel                                       | Verdict                                   | Evidence                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Project `.claude/skills/<name>/SKILL.md`      | **Works**, rejected on cost               | Probe `capy-t217-projprobe` → YES with no flags, listed **unnamespaced** — writes into the repo, dies to `git clean`, and genuinely shadows by name                                                                                                                                                                                                                      |
| `pluginDirs` in `.claude/settings.local.json` | **Does not work**                         | `{"pluginDirs":["<abs path>"]}` → probe NOT visible (NO). Binary grep: every `pluginDirs` hit belongs to `claude plugin eval`; `syncedPluginDirs` is an in-memory host config, not a settings key                                                                                                                                                                        |
| `extraKnownMarketplaces` in settings.json     | Exists, rejected for v1                   | Sources are marketplace sources (all five installed marketplaces are `{"source":"github","repo":…}`); inline-plugin form is gated behind managed-settings policy                                                                                                                                                                                                         |
| `~/.claude/skills/<name>/SKILL.md`            | **Works**, adopted as an opt-in secondary | `claude plugin init --help`: _"Scaffold a new plugin at `~/.claude/skills/<name>/` (auto-loads next session as `<name>@skills-dir`)"_. Probe → YES with **no flags at all**, listed unnamespaced. Note the layout: flat `SKILL.md` directly under `~/.claude/skills/<name>/` works; a nested `skills/<name>/SKILL.md` under it did **not**. Probe removed after the test |

### 2.2 The mechanism

```
resources/skills/                        ← checked in, human-owned product asset
  .claude-plugin/plugin.json             ← { name: "capy", version, description }
  skills/
    orchestrate-delivery/SKILL.md
    delivery-verifier/SKILL.md
    mission/SKILL.md
    conductor/SKILL.md
        │
        │  app boot / toggle change: copy ONLY the enabled skills
        ▼
<userData>/skills/capy/                  ← staged, Capy-owned, outside every repo
  .claude-plugin/plugin.json
  skills/<enabled>/SKILL.md
        │
        │  pty.ts appends at spawn
        ▼
claude … --plugin-dir <userData>/skills/capy
        │
        ▼
session sees:  capy:orchestrate-delivery, capy:delivery-verifier, …
```

**Per-skill on/off is expressed by what gets staged.** The CLI offers no per-skill filter,
so an "off" skill is simply not copied — the session cannot see it even in principle. This
makes the panel's promise ("nothing hidden") enforced by construction rather than by prompt
discipline, and it is what makes AC-2's negative half falsifiable.

**Resolution + fail-soft** follow `orchestrator-guard.ts` exactly:

```ts
// mirrors guardResourceDir() / installOrchestratorGuard()
function skillsResourceDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'skills')
    : path.join(app.getAppPath(), 'resources', 'skills')
}
```

A copy failure logs and never throws; a missing staged directory means no `--plugin-dir`
is passed, degrading to today's behaviour rather than breaking the spawn.

**Injection point.** `pty.ts` already composes argv for `claude-*` kinds and injects
`--mcp-config` (`orderMcpArgs`) and the T92 hook `--settings` (`injectHookSettings`). The
`--plugin-dir` append belongs alongside them, after `resolveClaudeBootArgs`. It applies to
agent and non-agent spawns alike; the staged content is Capy's own product asset, so there
is no `agentControlled` reason to withhold it.

**Staging is per-folder.** Because the enabled set is per-folder (§4), the staged directory
is keyed by folder: `<userData>/skills/<folder-hash>/capy/`. A single shared directory
cannot express two folders with different enabled sets when both have live sessions.

### 2.3 What this costs, stated plainly

- **Sessions Capy did not spawn see nothing.** The operator's own `claude` in a terminal
  gets no bundled skills. Mitigated only by the opt-in in §4.3.
- **Toggling does not affect running sessions.** `--plugin-dir` is read at spawn. The
  panel must say this; the change applies to the next session.
- **`--safe-mode` turns them off**, correctly.
- **Duplicate offerings are possible** — a bundled `capy:orchestrate-delivery` and the
  operator's personal `orchestrate-delivery` can both be listed. See §6.

## 3. Catalog

### 3.1 Layout

`resources/skills/` — a valid plugin tree, checked in, shipped via `extraResources` in
`electron-builder.yml` (the same packaging step `board-templates` and `orchestrator-guard`
already use). One `SKILL.md` per skill, plus `references/` where a skill has progressive
disclosure.

A skill's `SKILL.md` frontmatter is the CLI's, not Capy's: `name`, `description`. The
`description` is also **what the panel renders as the one-line purpose** — one source of
truth, so the panel can never describe a skill differently from what the session sees.
Descriptions in `resources/skills/**` are English-only and are **not** i18n'd: they are
model-facing trigger text, and translating them would change triggering behaviour. The
panel's own chrome (title, hints, the switch's aria-label) is i18n'd normally.

### 3.2 Versioning

Mirror the `capy-features` pattern — a marker comment in a catalog manifest, parsed at
build/boot:

```
<!-- capy-skills v1 (2026-08-22) -->
```

`src/main/bundled-skills.ts` exposes `BUNDLED_SKILLS_VERSION` the way
`capy-features.ts` exposes `CAPY_FEATURES_VERSION`. The version is what the staging step
compares against `<userData>/skills/.stamp` to decide whether to re-stage after an app
update. Individual skills are **not** independently versioned in v1 — the catalog moves
with the app release. (Independent skill updates are the marketplace story; out of scope.)

### 3.3 First entries

| Skill                  | One-line purpose (the `description`, verbatim into the panel)                                                                                                                                 | Seed                                                       |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `orchestrate-delivery` | Decompose an objective into board cards, dispatch one Capy session per unit, monitor until each opens a PR, verify every acceptance criterion independently, and hand back a Delivery Report. | `~/.claude/commands/orchestrate-delivery.md`               |
| `delivery-verifier`    | Verify that a finished unit satisfies its acceptance criteria one at a time, from repo evidence rather than the executor's own report, then produce the Delivery Report.                      | `~/.claude/skills/delivery-verifier/SKILL.md`              |
| `mission`              | Run one coordination tick over dispatched work: read goal state, check executors, poll approvals, act on what is unblocked, report one line.                                                  | `~/.claude/skills/mission/SKILL.md`                        |
| `conductor`            | Drive the Capy fleet through the `capy` MCP verbs — see every session/worktree and create sessions, terminals and worktrees.                                                                  | `.claude/skills/capy-conductor/SKILL.md` (already in-repo) |

`orchestrator` is deliberately **not** in the v1 catalog — it is a role contract, and it
already has a delivery mechanism (promotion + the structural guard). See §5.

## 4. Toggle persistence

### 4.1 Two scopes, tri-state folder override

Reuse the exact cascade `ClaudeBootConfig` already uses (`mergeBootConfig`): a folder value
of `undefined` means **inherit**, `true`/`false` are explicit — so a folder can turn OFF a
skill the global config turned ON, and vice versa.

**Global** — `<userData>/bundled-skills.json`:

```json
{
  "version": 1,
  "enabled": { "orchestrate-delivery": true, "delivery-verifier": true },
  "userLevelInstall": { "orchestrate-delivery": false }
}
```

**Per-folder** — the folder's entry in Capy's existing user-projects store, **not** a file
inside the repo:

```json
{ "skills": { "mission": false, "conductor": true } }
```

Resolution: `folder[skill] ?? global[skill] ?? false`.

Putting the folder override in Capy's own store rather than in the repo is what satisfies
AC-3's second half absolutely: **no Capy-managed file is created inside the user's
repository at all** — not a gitignored one, not `.claude/settings.local.json`. (The
orchestrator guard does write there; this feature deliberately does not follow it. A skill
catalog is several hundred lines of product content, not one config key.)

### 4.2 Default state

**All skills OFF by default.** The card's AC-1 phrasing ("off by default except where the
user opted in") is read as: a fresh install enables nothing; every skill is a deliberate
opt-in.

This is the right default even though it means the delivery loop is off out of the box,
because a skill silently added to a user's session catalog changes model behaviour without
consent, and the whole point of the panel is that nothing is hidden. The onboarding cost is
paid once, visibly, in the panel.

### 4.3 The opt-in user-level install

Per skill, a second switch: **"Also outside Capy"**, default OFF, disclosed as writing to
`~/.claude/skills/<name>/SKILL.md`.

When ON, Capy writes the flat-layout skill there (verified working, §2.1) so the operator's
own terminal sessions see it too. This is the only part of the design that writes outside
Capy's own userData, it is never on by default, and turning it off removes the file.

Cost, stated in the panel: skills installed this way land **unnamespaced**, so a name
collision with a personal skill of the same name is real here — unlike the `--plugin-dir`
path. §6 covers what happens.

## 5. Relationship to modes (`session-modes.ts`)

**Recommendation: they coexist. Learning and Orchestrator do NOT migrate onto the skills
catalog.** They are different mechanisms answering different questions, and the difference
is not cosmetic:

|                        | Mode                              | Bundled skill                  |
| ---------------------- | --------------------------------- | ------------------------------ |
| Delivery               | `--append-system-prompt` preamble | `--plugin-dir` plugin          |
| When it loads          | Always, whole session             | On invocation                  |
| Context cost           | Every turn                        | Frontmatter only until invoked |
| Question it answers    | _What is this session?_           | _What can this session do?_    |
| Chosen                 | at spawn, per session             | per folder, standing           |
| Can be invoked by name | No                                | Yes                            |
| Reversible mid-session | No (it is the boot identity)      | N/A                            |

A mode is a **boot identity**: a Learning session _is_ a teaching session for its whole
life, and an orchestrator-promoted session carries a structural guard
(`Edit`/`Write`/`NotebookEdit` blocked outside `.capy/`) that a skill cannot arm. Turning
those into "a skill auto-invoked at boot" would either (a) re-inject the whole contract as
preamble anyway — the same context cost, one more indirection — or (b) rely on the model
choosing to invoke it, which makes a _contract_ optional. Neither is an improvement.

Conversely `orchestrate-delivery` is a procedure the operator triggers, not a role, and
`delivery-verifier` runs as a subagent inside another session. Neither is a boot identity.

**One thing to share, though.** Modes are already extensible — `contributes.modes` in the
extension manifest (T138, `src/main/extensions/extension-manifest-core.ts:248-297`, per-entry fail-soft
validation, ADR-0002). When the extension SDK grows a `contributes.skills` key, it should
be validated by the same per-key independent machinery and staged through the same
`--plugin-dir` (extensions get their own plugin dir; `--plugin-dir` is repeatable). That is
a later card; the layout chosen here does not block it.

## 6. Collision with the operator's existing personal skills

**What happens is verified, not assumed** (§2.1): with `--plugin-dir`, both are listed and
neither is suppressed. The probe that established this staged **one plugin per skill**, so
it produced plugin-name-prefixed entries:

```
mission
orchestrate-delivery                              ← the operator's personal ones
capy-orchestrate-delivery:orchestrate-delivery    ← bundled, namespaced (probe layout)
capy-mission:mission
```

**Under the adopted layout — one plugin named `capy` holding N skills (§2.2) — the same
listing reads `capy:mission` / `capy:orchestrate-delivery`.** That is the form the panel's
disclosure copy (step 2 below) and AC-2 use. Carrying the coexistence result across the two
layouts is an inference, not an observation: namespacing is a property of plugin-sourced
skills either way, and nothing in the CLI's help ties suppression to plugin count — but the
no-shadow assertion was **not** re-run on the single-plugin shape. §9.3's "no-shadow" step
exists to close that gap during implementation; treat it as required, not confirmatory.

So the failure the card is worried about — a bundled skill silently shadowing
`~/.claude/commands/orchestrate-delivery.md` — **does not occur on the chosen channel**.
Nothing is overwritten, nothing is hidden.

The residual problem is the opposite one: **two near-identical skills offered at once**,
which makes triggering ambiguous and wastes catalog space. The design handles it by
disclosure, not suppression:

1. **Detect.** At panel render, Capy scans `~/.claude/skills/` and `~/.claude/commands/`
   for a name matching a bundled skill (a cheap `readdir`, no parsing of content).
2. **Disclose.** The row gains a `SettingHint`: _"You already have a personal skill with
   this name. Both will be available — yours as `<name>`, Capy's as `capy:<name>`."_
3. **Never suppress.** Capy does not delete, rename, move or disable a user's personal
   skill. Ever. The user's own configuration is not Capy's to edit.
4. **The one place it does bite** is the §4.3 user-level install, which lands unnamespaced
   in the same directory. There, if `~/.claude/skills/<name>/` already exists and was not
   written by Capy, the install is **refused** with an explicit message rather than
   overwriting. Capy marks its own installs (a `# capy-managed` frontmatter key or a
   sidecar stamp) so it can distinguish "mine, safe to update" from "the user's, hands
   off".

**Migration note for the operator specifically:** once the bundled versions ship, the
personal copies are redundant. Removing them is the operator's call, not Capy's; the panel
says so and does nothing on its own.

## 7. UI

### 7.1 Placement

A new **Skills** tab in the Settings dialog (`design.md` §6 → "Settings dialog", line
4155), in the configuration cluster next to **MCP** and **Memory**. New file
`src/renderer/src/components/BundledSkillsPane.vue`.

The Settings dialog has a fixed card size (`min(92vw, 940px)` × `min(80vh, 720px)`) and a
190px vertical nav — a new tab is a row in that nav with the standard 2px accent left bar.
Per the dialog's search contract, the tab registers keyword hints ("skill", "orchestrate",
"delivery", "verifier"); v1 gives the tab a **tab match** only, not per-setting anchors
(same treatment as Claude Boot / MCP / Endpoints sub-panes).

### 7.2 Row shape

**This reuses an existing pattern verbatim — no new component, no new token.** The MCP
pane's per-folder block list (`design.md` §6 → "Control server (MCP)", line 4489) is
already exactly this shape: one row per item, label + secondary line, a `ToggleSwitch` on
the right, and a `SettingHint` above the list stating the default.

```
┌──────────────────────────────────────────────────────────────────────┐
│ BUNDLED SKILLS                                       ← eyebrow, §6    │
│ Skills Capy ships. All off by default — turn on what you want this    │
│ project's sessions to be able to use.            ← SettingHint        │
│                                                                       │
│  orchestrate-delivery                                      [ ●──]     │
│  Decompose an objective into board cards, dispatch one Capy…          │
│                                                                       │
│  delivery-verifier                                         [──● ]     │
│  Verify that a finished unit satisfies its acceptance criteria…       │
│  ⚠ You already have a personal skill with this name. Both will be     │
│    available — yours as `delivery-verifier`, Capy's as                │
│    `capy:delivery-verifier`.                                          │
└──────────────────────────────────────────────────────────────────────┘
```

Tokens used, all existing (`design.md` §9, mirrored in `themes.css`):

- Eyebrow — Inter 11px/500 uppercase, `letter-spacing 0.06em`, `--text-3`.
- Skill name — Inter 12.5px/500, `--text`.
- Purpose line — **`SettingHint`** (`--text-3`, 11px, line-height 1.5). Per §6's rule this
  is the _only_ help-text component; not `--text-4`, which is reserved for paths, counts
  and timestamps.
- The switch — **`ToggleSwitch`** (34×20, knob 14; `--accent` track when on with an
  `--accent-ink` knob, `--surface-2` when off). §6 is explicit that this is the only
  boolean control and that homemade switches are forbidden.
- Namespace strings (`capy:delivery-verifier`) — `font-mono` 11px `--text-4`. Technical
  nouns stay untranslated per §8.

### 7.3 Scope switch (global vs. this project)

At the top of the pane, a **`SegmentedControl`** — the only "pick 1 of N" per §6 — with
two options: **Global** · **This project**. Selecting a folder scope switches every row to
the tri-state form the component already supports (`allowDefault` → a neutral
"Default/Inherit" pill mapping to _unset_; `inheritedValue` → the inherited option keeps
an accent border only). This is precisely the affordance Claude Boot already uses for
global-vs-folder, so the interaction is learned, not new.

**This project** is disabled (`opacity 0.4`, non-interactive — the documented disabled
treatment) when no folder is selected, with a hint saying so.

### 7.4 The "Also outside Capy" switch

A second `ToggleSwitch` per row, in a collapsed **Advanced** sub-block (default collapsed),
labelled "Also outside Capy" with a `SettingHint` naming the exact path it writes
(`~/.claude/skills/<name>/SKILL.md`) and stating that it is unnamespaced. Global scope only
— it is a machine-level install, so it does not appear under "This project".

### 7.5 Restart notice

A `SettingHint` under the list: _"Changes apply to sessions started from now on."_ No toast
needed — this is a standing property of the pane, not an event.

### 7.6 Design-contract gaps

**None found.** Every control, token and row shape this pane needs already exists in
`design.md` (§6 form controls, §6 Settings dialog, §6 Control server per-folder list, §9
tokens). The implementation must still add a **"Bundled skills (Settings tab, T217)"**
subsection under `design.md` §6 documenting this pane, and a row in `CLAUDE.md`'s
"Design entity → file map" for `BundledSkillsPane.vue` — but it adds **no new token, no new
radius, no new easing, no new component**. If implementation discovers otherwise, the rule
stands: edit `design.md` first, in the same change.

## 8. Migration — how the personal skills become the seed

1. **Copy, do not move.** `~/.claude/commands/orchestrate-delivery.md` and the three
   `~/.claude/skills/*` become `resources/skills/skills/<name>/SKILL.md`. The operator's
   originals stay untouched (§6.3).
2. **`orchestrate-delivery` changes shape.** It is a _command_ today
   (`~/.claude/commands/*.md`); as a bundled skill it becomes a `SKILL.md` with `name` +
   `description` frontmatter. The body is largely portable; the trigger phrasing moves
   into `description`.
3. **Strip what is personal.** This is the step that must not be skipped:
   - **`LESSONS.md` files are excluded.** `mission/LESSONS.md` and
     `orchestrator/LESSONS.md` are accumulated corrections from the operator's own
     sessions. They are personal, they reference the operator's habits, and they are
     exactly the kind of content the OSS-launch NDA scrub exists to catch.
   - **`evals/` is excluded** from the shipped catalog (`orchestrator/evals/evals.json`).
   - **Remove operator-specific references**: personal paths, the operator's name, client
     or employer names, ClickUp/Slack workspace ids, non-English prose. The repo's English
     lingua-franca contract applies to everything under `resources/skills/**`.
4. **Generalize the assumptions.** The personal skills assume the operator's environment:
   `dtk:` plugin skills, `juni-vox`, a specific tracker. Bundled versions must degrade
   gracefully when those are absent — reference them as optional, never as required steps.
5. **`references/` ships.** `orchestrator/references/{delivery-contract,enforcement}.md`
   are genuine progressive-disclosure content and are part of the bundle for whichever
   skill inherits them.
6. **Language.** Several current sources contain Portuguese prose. All bundled skill
   content is rewritten in English (CLAUDE.md → Language policy; the i18n exception does
   not cover `resources/**`).

## 9. Test plan

### 9.1 Unit (vitest, node env)

Pure logic only — per ADR-0001, anything electron/`app`-bound is e2e.

- `resolveSkillEnabled(global, folder, name)` — the tri-state cascade: folder `undefined`
  inherits; folder `false` beats global `true`; folder `true` beats global `false`; neither
  set → `false` (the default-off rule, AC-1).
- Catalog parse — `SKILL.md` frontmatter → `{ name, description }`; a malformed
  frontmatter drops **that** skill and never the catalog (per-entry fail-soft, matching
  `contributes.themes`/`contributes.modes`).
- `BUNDLED_SKILLS_VERSION` marker parse, including the `v0` fallback on a missing marker
  (mirrors `capy-features.ts`).
- argv composition — given an enabled set, `--plugin-dir <path>` is appended exactly once;
  given an empty enabled set, **no** `--plugin-dir` is emitted.
- Collision detection — a personal `~/.claude/skills/<name>` or
  `~/.claude/commands/<name>.md` present → the row is flagged (pure function over a
  directory listing, filesystem injected).

### 9.2 Integration / e2e

- **Staging** — enabled set `{a, c}` from a catalog of `{a, b, c, d}` produces a staged
  tree containing `skills/a` and `skills/c` and **no** `skills/b`, `skills/d`.
- **Re-stage on version bump** — a changed `.stamp` re-stages; an unchanged one does not.
- **Fail-soft** — an unreadable `resources/skills/` logs and leaves the spawn working with
  no `--plugin-dir`.
- **Toggle off removes** — flipping a skill off re-stages without it; the file is gone.
- **User-level install refusal** — a pre-existing, non-Capy-managed
  `~/.claude/skills/<name>/` causes the "Also outside Capy" install to refuse, not
  overwrite.

### 9.3 Live verification against the real CLI

The channel is only real if it works in a real session. Use the second-instance recipe in
`docs/dev/live-verify-second-instance.md`, then the same method this spec's investigation
used — which is itself the regression test:

- **Positive** — with a skill ON, a spawned session asked "is `capy:<name>` available?"
  answers YES.
- **Negative (this is the one that matters for AC-2)** — with the skill OFF, the same
  question answers NO. A positive-only test would pass even if Capy staged everything and
  the toggle did nothing.
- **Control** — the same prompt with no `--plugin-dir` answers NO, proving the YES came
  from Capy and not from ambient user-level configuration. **Every** such assertion must
  use a probe name that exists nowhere in the tester's own `~/.claude/`, or the result is
  meaningless.
- **No-shadow** — with a personal skill of the same name present, both names are listed.
- **No repo write** — `git status --porcelain` is empty after a full spawn cycle.

## 10. Acceptance criteria, restated falsifiably

| #    | Card AC                                                                                    | Falsifiable restatement                                                                                                                                                                                                                                                            | How it fails                                                                                                                                                                                           |
| ---- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| AC-1 | Fresh install lists bundled skills with name, purpose, on/off; off by default              | On a Capy with an empty `<userData>`, Settings → Skills lists exactly the catalog's entries; each row shows the skill's `name` and its `SKILL.md` `description` verbatim; **every** `ToggleSwitch` reads OFF; `<userData>/bundled-skills.json` does not exist or has `enabled: {}` | Any row on by default; a row whose purpose text differs from the shipped `description`; a catalog entry missing from the panel                                                                         |
| AC-2 | On → invocable by name; off → absent from the session's catalog                            | With `orchestrate-delivery` ON for folder F, a session spawned in F reports `capy:orchestrate-delivery` as available **and** can invoke it. With it OFF, the same probe reports NOT available, **and** the staged dir contains no `skills/orchestrate-delivery/`                   | The skill is listed when off (staging leaked); the skill is listed when on but cannot be invoked (frontmatter invalid); the off-case is only asserted by absence-of-mention rather than a direct probe |
| AC-3 | Per-project override beats global; nothing written into the repo's tracked files           | Global ON + folder OFF → session in that folder does **not** see it; global OFF + folder ON → it does. After a full spawn cycle, `git status --porcelain` in that repo is **empty** and no `.claude/skills/` exists                                                                | Global wins over folder; any file appears under the repo — gitignored counts as a failure here, since the requirement is _nothing written_, not _nothing committed_                                    |
| AC-4 | `docs/capy-features.md` + `docs/user/` describe the panel and the channel; CHANGELOG entry | `docs/capy-features.md` gains a paragraph on bundled skills with the version marker bumped (`vN` → `vN+1`); `docs/user/` gains a section naming the Settings → Skills tab; `CHANGELOG.md` has a dated `### Added` bullet                                                           | Any of the three missing — and the CI gates below will catch two of them mechanically                                                                                                                  |

**Two places where this restatement deliberately departs from the card's literal wording —
flagged so the departure is a decision, not a drift:**

- **AC-3 is graded stricter than the card asks.** The card says "nothing written into the
  repo's **tracked** files"; the table above fails the AC on _any_ file appearing under the
  repo, gitignored included. §4.1 is why: the whole point of putting the folder override in
  Capy's own store is that the repo is untouched, and "gitignored" is a weaker promise that
  still leaves artifacts in the user's working tree.
- **AC-2's invocation name cannot be the card's literal one.** The card says invocable as
  `/orchestrate-delivery`; on the chosen channel every plugin-sourced skill is namespaced,
  so the achievable name is `capy:orchestrate-delivery`. The personal, unnamespaced
  `/orchestrate-delivery` keeps working and keeps belonging to the operator (§6) — the two
  coexist, which is the outcome the AC was protecting.

## 11. Repo contracts the implementation must satisfy

**This spec itself is docs-only** and therefore needs no CHANGELOG entry, no `docs/user/`
update and no `docs/capy-features.md` bump. The **implementation** owes all of them:

| Contract                                                      | Owed?   | Why                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CHANGELOG.md` dated entry                                    | **Yes** | New user-facing capability                                                                                                                                                                                                                                                                                                                                                                 |
| `docs/capy-features.md` + marker bump                         | **Yes** | Agent-facing: a session gains skills it can invoke, and Capy should proactively point the user at Settings → Skills — that is exactly the "UI affordance the agent should offer" trigger. Note the **CI gate** (`scripts/ci/awareness-gate.mjs`) fires on `tool-catalog.ts`/`capy-features.ts` diffs; this change touches neither, so the gate will **not** catch a miss — it is on review |
| `docs/user/` page                                             | **Yes** | New top-level component (`BundledSkillsPane.vue`) **and** a new top-level `src/main/` file (`bundled-skills.ts`) — both are explicit triggers. The **CI gate** (`scripts/ci/user-docs-gate.mjs`) will enforce this one                                                                                                                                                                     |
| `design.md` §6 subsection + `CLAUDE.md` design-entity map row | **Yes** | New pane. No new token needed (§7.6), but the component must be documented                                                                                                                                                                                                                                                                                                                 |
| i18n parity `en.json` + `pt-BR.json`                          | **Yes** | Every new panel key in both files or `vue-tsc` breaks. Skill `description`s are **not** i18n keys (§3.1)                                                                                                                                                                                                                                                                                   |
| English-only                                                  | **Yes** | Everything under `resources/skills/**`, `docs/**`, code comments. Called out because the seed content is partly Portuguese today (§8.6). Note `src/main/session-modes.ts` has pre-existing Portuguese comments — **out of scope for this card**, flagged only so it is not copied as a pattern                                                                                             |
| `npm run typecheck` + `npm run build`                         | **Yes** | Both must pass before the work is reported done                                                                                                                                                                                                                                                                                                                                            |

## 12. Out of scope (explicit)

- **A marketplace.** No Capy-published plugin marketplace, no `extraKnownMarketplaces`
  entry, no hosted catalog. ADR-0009 §4(d) explains why the chosen layout stays
  forward-compatible with it.
- **Third-party skill installation.** No install-from-URL, no install-from-git, no
  user-authored skills entering the bundled catalog.
- **A skill editing UI.** The panel switches skills on and off. It does not view, edit,
  create, delete or benchmark them. That is **T50 (Skills manager)**, a separate ready
  card scoped to managing the _user's own_ `~/.claude/skills` — a different surface with a
  different owner. T217 ships the _bundled_ catalog; T50 manages the _personal_ one. They
  will eventually share a viewer; they are not the same card.
- **Independent skill versioning / update-without-app-release.** v1 moves with the app.
- **Migrating Learning/Orchestrator modes onto the catalog.** §5 recommends against it.
- **`contributes.skills` in the extension SDK.** Noted as forward-compatible in §5; a
  separate card.
- **Fixing the Portuguese comments in `session-modes.ts`.**

## 13. Open questions

1. **Per-folder staging cost.** §2.2 stages one directory per folder to express per-folder
   enabled sets. With many pinned folders this is N copies of the same content. A
   content-addressed shared store with per-folder symlinks would deduplicate, but symlinks
   are a Windows liability. **Unresolved** — needs a call before implementation; the
   simple N-copies version is correct and small (four `SKILL.md` files), just inelegant.
2. **Does `--plugin-dir` compose with a user's own `--plugin-dir` in Claude Boot's
   `extraArgs`?** The flag is documented repeatable, so it should; **NOT ANSWERED** —
   not empirically tested with both a Capy-injected and a user-supplied instance.
3. **Behaviour under `--bare`.** The help text names `--plugin-dir` as a supported way to
   provide context in bare mode, so it should work; **NOT ANSWERED empirically** — no
   `--bare` probe was run.
4. **Should `conductor` move out of `.claude/skills/` in this repo** once it is bundled, or
   stay for contributors working on Capy itself? Leaning stay (contributors are not running
   a packaged Capy), but unresolved.
5. **Marking Capy-managed user-level installs.** §6.4 needs a durable marker so Capy can
   tell its own file from the user's. A `# capy-managed` frontmatter key is visible to the
   model and pollutes the skill; a sidecar stamp file is invisible but can desync.
   Unresolved.
6. **Does an invalid `SKILL.md` in a staged plugin break the whole plugin load, or just
   that skill?** Capy validates before staging either way, but the CLI's failure mode
   determines how defensive the staging step must be. **NOT ANSWERED** — not tested.
