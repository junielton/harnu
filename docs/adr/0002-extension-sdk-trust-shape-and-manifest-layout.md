# ADR-0002 — Extension SDK: trust shape and manifest layout

**Status:** Accepted
**Date:** 2026-07-14
**Author:** junielton (with agent-assisted research)
**Deciders:** junielton
**Technical context:** T136 (Extension SDK), prerequisites T120 (PR #97) and T121 (PR #96)

> Companion to [`docs/specs/2026-07-14-extension-sdk-study.md`](../specs/2026-07-14-extension-sdk-study.md),
> which works the two concrete cases (themes, modes) in detail and ranks every other
> candidate surface. This ADR records the two decisions that generalize across all of them:
> the trust shape, and the manifest layout. It differs from `docs/lessons/` (retrospective)
> and `docs/specs/` (per-feature design) — this is the forward-looking architectural call.

---

## 1. Context

Capy already has one working extension mechanism — terminal-state detectors
(`~/.claude/detectors/<agent>.json`, `src/main/detect/*`): a JSON manifest on disk,
hot-reloaded via chokidar, validated by a pure function that rejects structurally-invalid
input with a reason but never lets one broken rule take down the rest, folded with builtins
via override-then-standalone precedence.

The question raised in conversation (2026-07-12) was whether Capy should grow a
VS Code-style or an Obsidian-style extension system, prompted by wanting themes and
session "Modes" (`Modes ▸ Learning`, T123) to become user-installable without a fork.

A structured audit (three independent research passes against code.visualstudio.com,
docs.obsidian.md, and Capy's own source) found:

- **VS Code's safety does NOT come from `contributes` being declarative.** It comes from
  the **Extension Host** — a separate process; every `vscode.*` call not backed by a
  locally-mirrored document/editor model is an RPC proxy across that boundary. `contributes`
  is a static _slot_ registration; the content behind a slot (a `TreeDataProvider`, a
  webview) is still imperative code, wired in `activate()`.
- **Obsidian's plugins run unsandboxed in the app's own renderer process**, with `require()`
  access to Node and the DOM. Obsidian's own docs state it plainly: _"plugins will inherit
  Obsidian's access levels."_ Safety is a distribution-time gate (scan, scorecard, manual
  review for popular plugins) — never a runtime one.
- Capy's blast radius is categorically different from a notes app: a session in Capy can
  hold PTYs, git worktrees, MCP grants, and other people's repositories. The Obsidian trust
  model is not appropriate here regardless of how convenient it is to build.
- Building a real Extension Host (a second process, RPC marshaling, proxy identifiers) is
  real engineering investment that only pays for itself once there are multiple,
  **untrusted, unreviewed** third-party authors at scale — the same inflection point that
  justified it for VS Code. Capy is not at that point; extensions today are power users
  authoring for themselves or a small circle.

## 2. Decision

### 2.1 Trust shape: VS Code's isolation posture, without VS Code's engineering cost

Adopt **process/DOM isolation and mediated UI as the target shape**, but reach it through
the cheapest mechanism that satisfies it at today's scale, re-evaluating only when evidence
of untrusted third-party authorship appears:

- **Phase 1–2 (declarative extensions — themes, modes, board templates): pure data.**
  No code execution at all. The worst case is a bad theme or a badly-written mode prompt —
  bounded, inspectable, uninstallable with one file delete. This needs no process boundary
  beyond what a JSON/Markdown parser already provides.
- **Phase 3 (behavior extensions — MCP verbs, panes): mediated, not isolated-by-process
  yet.** An installed extension is **trusted content** — the same class as a repo's
  `WORKTREE.md` setup script ("trusted, committed content… not agent-supplied input" is
  this repo's own established language for that class of risk, `worktree-manifest.ts:13-18`).
  It is disclosed to the operator at install/confirm time, not sandboxed in a separate
  process. A real Extension Host is deferred until there's a marketplace of unreviewed
  third-party authors — not built speculatively ahead of that need.
- **The one hard boundary that holds regardless of phase:** `window.api` never grows a
  generic `invoke(channel, …)` escape hatch for extension code. Every extension capability
  reaches the app exclusively through an existing mediated registry (the MCP tool catalog,
  the pane registry, the mode registry) — never a bespoke new IPC channel per extension.
  This is what keeps Phase 3 safe-by-construction even without process isolation: an
  extension verb still passes through the same declarative gate fields T120 put in place
  (`mutates`, `grantable`, `discloses`, …), defaulting fail-closed.

### 2.2 Manifest layout: one folder, one `contributes` block — the detector triad, generalized once

Reuse the exact three-layer shape already proven by the detector system, generalized to
serve every contribution kind instead of reimplementing it per surface:

```
~/.claude/capy-extensions/<id>/
  manifest.json        # { id, label, version, contributes: { themes?, modes?, boardTemplates?, … } }
  modes/*.md            # referenced by contributes.modes[].doc
  templates/*.md         # referenced by contributes.boardTemplates
```

- **Pure validator** (mirrors `manifest-load-core.ts`): validates the whole manifest
  structurally, but validates **each `contributes` key independently** — a broken theme
  must never disable a working mode in the same pack.
  - **Origin gate:** every contributed theme (§2.1 of the study — a missing token today
    silently inherits the default) is validated for its full 36-token contract; extension
    content is held to a **stricter** bar than in-repo content, not a looser one, because
    there is no code review backstop.
- **Registry fold** (mirrors `manifest-registry.ts`): builtins first, then extension
  contributions layered on top; an extension contributing a kind with no builtin equivalent
  composes standalone (the same "a user can add a brand-new agent without a code change"
  property that makes the detector system work).
- **Impure shell** (mirrors `screen-detect.ts`): one chokidar watcher over
  `~/.claude/capy-extensions/`, 100 ms debounce, one change event fanned out to every
  consuming registry (themes, modes, templates) rather than one watcher per surface.

**One manifest per extension, not one directory per contribution kind** (rejected
alternative: `~/.claude/capy-themes/`, `~/.claude/capy-modes/`, … in parallel). A single
`contributes` block gives one install/uninstall gesture, one place to show provenance in
the UI (an "installed by `<id>`" origin badge — required for modes specifically, since a
mode's contract is injected into the session's system prompt: prompt injection by design,
disclosed by design), and one validation entry point whose per-key fail-soft property
still holds.

A per-repo variant (`.capy/extensions/`, project-scoped) is left open for later — the fold
function's signature (`buildRegistry(overrides)`) already supports layering a second
override source without a redesign.

## 3. Alternatives considered

| Alternative                                                                                   | Rejected because                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Obsidian-style: extension code runs unsandboxed in the renderer, full `window.api`/DOM access | Capy's blast radius (PTYs, grants, other repos) is categorically higher-stakes than a notes app; the app already invested in a security posture (Approval Inbox, declarative gates) that this would bypass entirely for extension code.     |
| Full VS Code-style Extension Host now (separate process, RPC protocol, proxy identifiers)     | Real engineering cost that only pays off at marketplace scale with unreviewed third-party authors; Capy is not there. Building it speculatively is premature investment the study explicitly warns against.                                 |
| One directory per contribution kind (`capy-themes/`, `capy-modes/`, …)                        | N watchers instead of one; no single install/uninstall/provenance surface; doesn't compose with future contribution kinds without adding another parallel directory each time.                                                              |
| Skip the pure-validator layer, parse manifests inline in the shell (fastest to ship)          | Loses the fail-soft-per-entry property that makes the detector system trustworthy today — a single malformed extension would either crash the loader or silently no-op the whole pack instead of degrading one `contributes` key at a time. |

## 4. Consequences

**Positive:**

- Themes and modes (§2, §3 of the study) both fit Phase 1–2 without touching the trust
  question again — they're pure data from the start.
- The detector triad's resilience properties (structural rejection with reason, per-entry
  fail-soft, builtins-then-overrides) transfer wholesale instead of being rediscovered.
- The `window.api` boundary (identified in the 2026-07-12 recon as the single hardest wall
  in the codebase) stays exactly where it is — this ADR treats that as a feature, not a
  gap to close.

**Negative / accepted cost:**

- Phase 3 extensions are trusted-content, not sandboxed — an installed malicious MCP-verb
  or pane extension has the same access a human-written PR would, mitigated only by the
  existing confirm/disclosure machinery, not by process isolation. Acceptable at
  today's scale (self-authored / small-circle extensions); **must be revisited** before
  any public extension marketplace ships (see `docs/specs/2026-07-14-extension-sdk-study.md`
  §6 Phase 3 non-goals).
- One shared watcher/loader is more work up front than one watcher per surface, in exchange
  for not paying that cost N times as more `contributes` keys are added.

**Follow-ups:**

- Card [[T136]] holds the phased implementation plan; this ADR is its architectural spec.
- Re-open this ADR's §2.1 trust-shape decision if/when third-party (not self-authored)
  extension authorship becomes a real request — that is the signal to start the Extension
  Host conversation, not before.
