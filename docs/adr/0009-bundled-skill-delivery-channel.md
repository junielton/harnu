# ADR-0009 — Capy delivers its bundled skills through `--plugin-dir`, staged from userData

**Status:** Proposed
**Date:** 2026-08-22
**Author:** Claude (drafting), from the T217 investigation against Claude Code 2.1.239
**Deciders:** operator (this ADR is not accepted until read)
**Technical context:** `src/main/pty.ts`, `src/main/claude-args.ts`, `src/main/session-modes.ts`, `src/main/orchestrator-guard.ts`, `resources/`

> Related: [`docs/specs/T217-bundled-skills.md`](../specs/T217-bundled-skills.md)
> · [`docs/research/2026-08-22-delivery-assurance-north-star.md`](../research/2026-08-22-delivery-assurance-north-star.md) §9.2
> · card `T217-bundled-skills`

---

## 1. Context

Capy's delivery loop — `orchestrate-delivery`, `delivery-verifier`, `mission`, the
orchestrator/conductor contracts — currently lives **only** in the operator's personal
user-level configuration: `~/.claude/commands/orchestrate-delivery.md` (203 lines) and
`~/.claude/skills/{delivery-verifier,mission,orchestrator}/` (140 / 128 / 173 lines).

A packaged Capy installed by anyone else has none of it. The whole "orchestrate a
fan-out, then assure delivery" story — the thing the north-star research (§6–§9) builds
toward — is therefore **unshippable**. §9.2 of that research made the decision: Capy must
bundle its own skills and expose them with a per-skill on/off panel. It left one question
open, and that question is this ADR:

> **How does a Capy-bundled skill actually reach a spawned Claude Code session?**

Capy today has exactly one mechanism for injecting behaviour into a session: **modes**
(`src/main/session-modes.ts`) — a versioned markdown doc concatenated into the
`--append-system-prompt` preamble at spawn (`pty.ts:653-680`), alongside
`CAPY_FEATURES_DOC` (T55) and `CAPY_ORCHESTRATOR_DOC` (T98). That mechanism is
_always-on prose_: whatever it injects is paid for in context on every single turn of
every session, and it cannot be invoked on demand. Four full skills would be roughly
650 lines of permanently-resident context. Modes are the wrong shape for this.

The decision matters beyond ergonomics, because it determines:

- whether Capy writes files into the user's repository (and whether those files survive
  `git clean`, or get committed by accident);
- whether a bundled `orchestrate-delivery` silently shadows the operator's personal one;
- whether the operator's own terminal sessions — ones Capy did not spawn — see the skills;
- whether per-skill on/off is even expressible, or is all-or-nothing.

## 2. Decision

**Capy ships its skills as plugin directories under `resources/skills/`, stages the
subset enabled for the target folder into a folder-keyed directory under `<userData>/skills/`,
and passes that staged directory to the `claude-*` spawn as `--plugin-dir`.**

Concretely:

- One bundled plugin, named `capy`, staged as
  `<userData>/skills/<folder-hash>/capy/{.claude-plugin/plugin.json, skills/<name>/SKILL.md}`.
- **The staging is keyed by folder, not global**, and happens at spawn time rather than at
  app boot: the enabled set is per-folder (spec §4), and one shared directory cannot express
  two folders with different enabled sets while both have live sessions. Spec §13 Q1 records
  the cost (the catalog is duplicated per folder) and the dedupe options left open.
- The staging step copies **only the skills the user switched on** for the folder being
  spawned into. Per-skill on/off is therefore expressed by _what gets staged_, not by any
  CLI filtering the CLI does not offer.
- `pty.ts` appends `--plugin-dir <staged path>` to the argv it already builds, next to
  where it injects `--mcp-config` and the T92 hook `--settings`.
- Nothing is ever written inside the user's repository.

Skills arrive in the session **namespaced** as `capy:<skill-name>`.

A **secondary, explicitly opt-in** channel is also specified (not default): installing a
skill into `~/.claude/skills/<name>/SKILL.md`, which auto-loads for _every_ session on
the machine including ones Capy did not spawn. It is offered as a per-skill "also outside
Capy" checkbox, off by default, because it writes into the operator's personal
configuration and lands **unnamespaced** — the one place a real name collision can occur.

## 3. Evidence

Every claim below was verified against the CLI actually installed on this machine.

**Installed version.** `claude --version` → `2.1.239 (Claude Code)`; binary resolves to
`~/.local/share/claude/versions/2.1.239` (ELF, `BUILD_TIME 2026-08-21T04:40:30Z`,
`GIT_SHA 9bf8e9521f`). **ANSWERED.**

**`--plugin-dir` exists.** `claude --help`:

> `--plugin-dir <path>  Load a plugin from a directory or .zip for this session only
(repeatable: --plugin-dir A --plugin-dir B.zip) (default: [])`

**ANSWERED.**

**Required on-disk shape.** A directory containing `.claude-plugin/plugin.json`
(`{name, version, description}`) and `skills/<name>/SKILL.md` with YAML frontmatter
(`name`, `description`). `claude plugin validate --strict <dir>` on exactly that shape
returned only one warning (`author: No author information provided`) and no structural
error. **ANSWERED.**

**It actually reaches the session, namespaced.** A uniquely-named probe skill
(`capy-t217-probe`, marker `ZQ7RIVERBED`) was staged into a plugin dir named `capy` and a
headless session asked whether it was listed:

- with `--plugin-dir <dir>` → **YES**, reported as `capy:capy-t217-probe`;
- **control**, same prompt, same cwd, no flag → **NO**, "not listed in the available
  skills".

The control arm is what makes this evidence rather than a coincidence: the probe name
exists nowhere in the operator's configuration, so the YES can only have come from the
flag. **ANSWERED.**

**It does not shadow the operator's personal skills.** Two per-skill plugin dirs were
staged carrying skills named `orchestrate-delivery` and `mission` — names the operator
already has personally. A session launched with both dirs and asked to list every
matching skill name returned all four:

```
mission
orchestrate-delivery
capy-orchestrate-delivery:orchestrate-delivery
capy-mission:mission
```

Personal skills stay unnamespaced; bundled ones are prefixed by their plugin name. They
**coexist**; neither is suppressed. **ANSWERED.**

**It writes nothing into the repo and survives `git clean`.** `--plugin-dir` takes an
absolute path to a directory that lives outside the repository; the flag is
session-scoped ("for this session only") and leaves no on-disk trace in the working tree.
This follows from the flag being a spawn argument, and was observed: the probe runs used a
`projtest` cwd whose working tree was never modified. **ANSWERED.**

**It does NOT reach a session Capy did not spawn.** Direct consequence of it being a spawn
flag, and directly observed in the control arm above. **ANSWERED.**

**`~/.claude/skills/<name>/SKILL.md` auto-loads for every session, unnamespaced.**
`claude plugin init --help`:

> `init|new [options] <name>  Scaffold a new plugin at ~/.claude/skills/<name>/
(auto-loads next session as <name>@skills-dir)`

Verified empirically: a probe at `~/.claude/skills/capy-t217-autoload/SKILL.md` was
reported **YES** by a headless session launched with **no flags at all**, listed as
`capy-t217-autoload` (unnamespaced). A nested layout
(`~/.claude/skills/<name>/skills/<name>/SKILL.md`) was **NOT** picked up — the flat
`SKILL.md` directly under `~/.claude/skills/<name>/` is the shape that works. The probe
was removed after the test. **ANSWERED.**

**A project-level `.claude/skills/<name>/SKILL.md` loads, unnamespaced.** Verified: a
probe at `<cwd>/.claude/skills/capy-t217-projprobe/SKILL.md` was reported **YES** by a
no-flag session, listed as `capy-t217-projprobe`. **ANSWERED.**

**There is no settings.json key that adds a plugin directory.** Tested:
`.claude/settings.local.json` containing `{"pluginDirs": ["<abs path>"]}` — the probe was
**NOT** visible (**NO**). Grepping the CLI binary for `pluginDirs` returns hits only from
the `claude plugin eval` subsystem (it builds child argv with `for (let i of
e.pluginDirs) n.push("--plugin-dir", i)`); `syncedPluginDirs` is an in-memory host
extensions config (`replaceSyncedPluginDirs`/`getSyncedPluginDirs`), not a user settings
key. `extraKnownMarketplaces` exists and can declare inline plugin entries in
settings.json, but its sources are marketplace sources (all five installed marketplaces on
this machine are `{"source":"github","repo":...}`) and the policy path is gated by managed
settings. **ANSWERED — no such key for a plain local directory.**

**Interaction with other Capy boot flags.** `--plugin-dir` is not in Capy's argv denylist
(`claude-args.ts` `DENY_BOOL`/`DENY_VALUE` cover `--resume`, `-r`, `--session-id`,
`--output-format`, `--input-format` and a set of booleans), so nothing in Capy strips it.
Two user-settable Boot flags do defeat it, per the CLI's own help text:

- `--safe-mode` — "Start with all customizations (CLAUDE.md, **skills, plugins**, hooks,
  MCP servers, custom commands and agents, …) disabled". Bundled skills will not load.
  **ANSWERED (doc quote).**
- `--bare` — skips plugin _sync_, but its help explicitly names `--plugin-dir` as one of
  the ways to "explicitly provide context" in bare mode, so an explicit `--plugin-dir`
  still applies. **ANSWERED (doc quote); not empirically re-tested under `--bare`.**

## 4. Alternatives considered and rejected

### (a) Extend `session-modes.ts` — inject the skills as `--append-system-prompt` prose

**Rejected.** This is the mechanism Capy already has, which is why it deserves a real
answer rather than a dismissal.

- **Cost: permanent context.** The preamble is prepended to the system prompt for the
  whole session. The four seed skills total ~650 lines; `capy-features.md` alone is
  already a substantial always-on doc. Skills exist precisely so their body is loaded
  _on invocation_; converting them to preamble throws that away and taxes every turn of
  every session, including the ones that never orchestrate anything.
- **Cost: no invocation.** A mode cannot be called. `orchestrate-delivery` is a
  _procedure the operator triggers_, not a standing role — `/orchestrate-delivery` has no
  equivalent as preamble prose.
- **Cost: no progressive disclosure.** The `orchestrator` seed carries
  `references/delivery-contract.md` and `references/enforcement.md`, read only when
  needed. Preamble injection has no "read this file if" affordance.
- It does have one genuine advantage — it works today with zero new CLI dependency — and
  that is why modes are kept for what they are good at (see §5).

### (b) Materialize enabled skills into the folder's `.claude/skills/`

**Verified to work** (evidence above) and rejected on cost, not capability.

- **Cost: writes into the user's repository.** This is the decisive one. Capy would be
  creating tracked-path files in a tree the user commits from. The orchestrator guard's
  precedent (`.claude/settings.local.json`) is narrower — it is a single file that the
  Claude Code ecosystem already conventionally gitignores, and it holds _configuration_,
  not several hundred lines of Capy product content.
- **Cost: `git clean` deletes it.** The skills vanish from a tree the user cleans, and
  reappear on the next Capy boot — a confusing, invisible churn.
- **Cost: accidental commit.** A user who does not gitignore it commits Capy's skills into
  their project, and they then diverge from the shipped version with no update path.
- **Cost: real shadowing.** These land **unnamespaced** (verified: `capy-t217-projprobe`).
  A bundled `orchestrate-delivery` here would collide by name with the operator's personal
  `orchestrate-delivery`, which is exactly the failure the card asks us to prevent.
- **Benefit it does buy:** it works for sessions Capy did not spawn. That benefit is
  preserved, better, by the opt-in `~/.claude/skills/` channel in §2 — which at least does
  not touch the repo.

### (c) A settings.json-level plugin path

**Rejected: it does not exist for a local directory.** `pluginDirs` in project settings was
tested and had no effect; the key belongs to the `plugin eval` subsystem. The only
settings-declared route is `extraKnownMarketplaces`, whose sources are marketplaces (git /
GitHub), with the inline-plugin form gated behind managed-settings policy. Building on it
would mean Capy publishing and maintaining a marketplace — which §7 of the spec explicitly
puts out of scope for v1.

### (d) A Capy-published plugin marketplace the user installs

**Rejected for v1**, deferred deliberately. It is the natural v2: it gives skill updates
decoupled from app releases and covers every session on the machine. It also requires a
hosted marketplace repo, an install flow, a trust story, and version pinning — none of
which the delivery-assurance work is blocked on. The `--plugin-dir` layout chosen here is
_forward-compatible with it_: `resources/skills/` is already a valid plugin tree, so
publishing it later is packaging work, not a redesign.

## 5. Consequences

**Good.**

- The repository is never written to. This was the stated preference and it is met
  absolutely, not approximately.
- Per-skill on/off is expressible and honest: an off skill is simply not staged, so the
  session genuinely cannot see it. The panel's promise ("nothing hidden") is enforced by
  construction rather than by prompt discipline.
- No shadowing. `capy:orchestrate-delivery` and the operator's `orchestrate-delivery`
  coexist, verified.
- Skills stay lazily loaded — only frontmatter costs context until invoked.
- `resources/skills/` matches the two existing bundled-resource precedents
  (`resources/board-templates/`, `resources/orchestrator-guard/`) including the
  `app.isPackaged ? process.resourcesPath : app.getAppPath()/resources` resolution and the
  `extraResources` packaging step.

**Bad, and accepted.**

- **Sessions Capy did not spawn see nothing** by default. Mitigated by the opt-in
  user-level install, which the user must consciously enable.
- **A staging step now exists** that can fail. It follows `installOrchestratorGuard()`'s
  fail-soft posture: a copy error logs and never throws, and a missing staged dir means
  no `--plugin-dir` is passed, which degrades to today's behaviour rather than breaking
  the spawn.
- **Toggling a skill does not affect running sessions.** `--plugin-dir` is read at spawn.
  The panel must say so; a changed toggle applies to the next session.
- **`--safe-mode` disables them**, correctly and by design.
- **Two near-identical skills can be offered at once** (bundled + the operator's personal
  copy of the same thing). No shadowing means no silent breakage, but it does mean
  ambiguous triggering. This is a real cost of coexistence and is handled in the spec
  (§6) by detection and disclosure, not by suppression.

## 6. What this ADR does not decide

- The catalog's content — which skills ship, and their text. (Spec §3, §8.)
- Whether Learning/Orchestrator modes migrate onto the catalog. (Spec §5 recommends
  coexistence; that recommendation is not part of this decision.)
- Update cadence for bundled skills (app release vs. independent). v1 is app-release.
