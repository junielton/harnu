# Lessons learned — Harnu

Each file under `docs/lessons/<category>/<NNN>-<slug>.md` records a bug class this
project actually hit: what broke, why the codebase allowed it, how it was fixed, and
what a reviewer should look for so it does not come back. Read the lessons in a
category before you change code in that area, and check a diff against them when you
review one.

They are specific to this stack (**Vue 3 + Electron + TypeScript + Pinia + node-pty +
xterm.js**), not generic advice.

## Anatomy of a good lesson

```markdown
# {NNN}-{slug}: {short title}

**Category:** security | i18n | reactivity | synthetic-sessions | ipc | pty | ...
**Discovered in:** {commit-sha or PR #} ({date})
**Status:** active | resolved | superseded by {file}

## The bug

{1-2 paragraphs explaining what went wrong, what the user saw,
and why it happened. Concrete, not abstract.}

## Root cause

{What about the codebase made this possible? Architectural pattern,
missing invariant, anti-pattern that should be flagged.}

## The fix (and why)

{Code diff or pattern that resolved it.}

## How to detect in reviews

{Specific things a reviewer should grep for / mentally check.}

## Related

- {Links to spec sections, finding files, other lessons}
```

## Categories

| Category              | What lives here                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------- |
| `security/`           | IPC payload validation, path traversal, defense-in-depth at process boundaries              |
| `i18n/`               | String localization rules, schema parity en↔pt-BR, what stays untranslated                  |
| `reactivity/`         | Vue 3 reactivity gotchas, Pinia store mutation timing, computed cascade                     |
| `synthetic-sessions/` | Synth-real migration patterns, race conditions, Claude CLI version drift                    |
| `framework/`          | xterm.js, web fonts, Claude Code / settings.json, third-party lib lifecycle gotchas         |
| `frontend/`           | CSS/font matching, layout, accessibility, component patterns                                |
| `testing/`            | TDD discipline, Vitest assertion pitfalls, coverage blind spots                             |
| `performance/`        | startup cost, filesystem fan-out, concurrency caps, main-thread blocking                    |
| `code-patterns/`      | session-model projections, shared-collection filters, output sanitization                   |
| `privacy/`            | data egress, content sent off-machine, "local/no-cloud" claims, redaction-is-not-a-boundary |
| `qa/`                 | verifying a fix actually works — gate-vs-actuation gaps, what a green suite can't tell you  |
| `conventions/`        | repo-wide contracts that aren't a specific bug class (language policy, etc.)                |

New categories can be added freely. `index.md` files are not lessons; tools that load
every lesson in the tree should skip them.

## Current lessons

- [`security/001-ipc-path-validation.md`](./security/001-ipc-path-validation.md) — defense against renderer compromise on file-touching IPCs
- [`i18n/001-no-hardcoded-strings-in-stores.md`](./i18n/001-no-hardcoded-strings-in-stores.md) — the "Fork of …" bug class
- [`i18n/002-vue-i18n-schema-parity.md`](./i18n/002-vue-i18n-schema-parity.md) — typecheck enforces every key in both locales
- [`synthetic-sessions/001-age-filter-anti-pattern.md`](./synthetic-sessions/001-age-filter-anti-pattern.md) — B-6/B-7 root cause class
- [`synthetic-sessions/002-missing-sessions-index.md`](./synthetic-sessions/002-missing-sessions-index.md) — B-8 root cause (Claude 2.1.152+ disk format drift)
- [`reactivity/001-stale-comment-rot.md`](./reactivity/001-stale-comment-rot.md) — line-number references in comments rot quickly
- [`framework/001-await-document-fonts-load-before-measuring-terminal-cell-size.md`](./framework/001-await-document-fonts-load-before-measuring-terminal-cell-size.md) — await bundled font before xterm cell measurement
- [`framework/002-claude-code-strips-settings-hook-keys.md`](./framework/002-claude-code-strips-settings-hook-keys.md) — CC strips custom keys from settings.json hooks; identify by URL, not a sentinel
- [`frontend/001-bundle-every-font-weight-a-consumer-uses-in-font-face.md`](./frontend/001-bundle-every-font-weight-a-consumer-uses-in-font-face.md) — partial `@font-face` weights resolve within-family, not down-stack
- [`testing/001-blind-assertion-false-green.md`](./testing/001-blind-assertion-false-green.md) — an assertion routed through the function-under-test can't observe the change
- [`testing/002-remote-debugging-port-flips-is-dev-in-packaged-verify.md`](./testing/002-remote-debugging-port-flips-is-dev-in-packaged-verify.md) — the debug flag that also switches dev mode; verify packaged builds without it
- [`framework/003-invalid-semver-crashes-electron-updater-at-boot.md`](./framework/003-invalid-semver-crashes-electron-updater-at-boot.md) — `"0.2.01"` threw in electron-updater; keep version strict-semver + guard init
- [`framework/004-http-hooks-obey-response-body-decisions.md`](./framework/004-http-hooks-obey-response-body-decisions.md) — Claude Code obeys `permissionDecision` in an `http` hook response body, even a ~3s-delayed one; `active` mode is real, parked Allow/Deny is viable
- [`performance/001-bound-filesystem-fanout-at-startup.md`](./performance/001-bound-filesystem-fanout-at-startup.md) — unbounded `Promise.all` over ~999 JSONL files stalled boot / froze the desktop
- [`reactivity/002-mutate-through-the-store-proxy-not-the-raw-object.md`](./reactivity/002-mutate-through-the-store-proxy-not-the-raw-object.md) — writing a captured raw object doesn't trigger a computed
- [`code-patterns/001-new-session-views-must-reuse-all-visibility-filters.md`](./code-patterns/001-new-session-views-must-reuse-all-visibility-filters.md) — archived sessions leaked into the board; reuse every visibility filter
- [`code-patterns/002-sanitize-terminal-output-strip-nf-and-osc-not-just-csi.md`](./code-patterns/002-sanitize-terminal-output-strip-nf-and-osc-not-just-csi.md) — stripping ESC alone left `(B` residue; match nF + OSC families
- [`code-patterns/003-derived-classifier-must-mirror-its-canonical-source.md`](./code-patterns/003-derived-classifier-must-mirror-its-canonical-source.md) — board showed live sessions as idle; `classifyBoardState` paraphrased `dotFor` instead of replicating it
- [`testing/003-assert-expected-from-requirement-not-implementation.md`](./testing/003-assert-expected-from-requirement-not-implementation.md) — a green test that asserted the buggy output; derive the oracle from the spec, not the code
- [`security/002-no-shell-string-interpolation-of-paths.md`](./security/002-no-shell-string-interpolation-of-paths.md) — proven command injection in `buildMissingDirNotice`; never interpolate a disk/renderer path into a `sh -c` string
- [`security/003-confine-renderer-write-and-open-targets.md`](./security/003-confine-renderer-write-and-open-targets.md) — write/open IPCs must pin the destination + allowlist keys, not just block `..` (the write-side counterpart to `security/001`)
- [`security/004-harden-local-http-servers.md`](./security/004-harden-local-http-servers.md) — a localhost HTTP server is still an attack surface; constant-time token, Host/Origin DNS-rebind guard, 0600 token files
- [`security/005-electron-hardening-beyond-context-isolation.md`](./security/005-electron-hardening-beyond-context-isolation.md) — header CSP (not just `<meta>`) + `will-navigate` guard + window-open scheme allowlist
- [`privacy/001-spawning-claude-p-is-network-egress.md`](./privacy/001-spawning-claude-p-is-network-egress.md) — shelling out to `claude -p <content>` sends user content off-machine; keep opt-in + disclose
- [`testing/004-referenced-safety-nets-must-run.md`](./testing/004-referenced-safety-nets-must-run.md) — an unenforced coverage gate / a dead e2e suite is false assurance; a control only counts when CI fails without it
- [`framework/005-exit-cleanup-must-be-instance-exact.md`](./framework/005-exit-cleanup-must-be-instance-exact.md) — a dev/verify instance's exit stripped prod's statusLine via a loose basename match; deletes need instance-exact identity + a self-heal loop
- [`conventions/001-english-lingua-franca.md`](./conventions/001-english-lingua-franca.md) — non-English prose outside i18n resources is a review finding, not a style nit
- [`qa/001-permission-verdict-is-not-an-actuation-result.md`](./qa/001-permission-verdict-is-not-an-actuation-result.md) — a gate saying `allow` doesn't mean the effect happened; PR #113's permission gate opened while a separate existence gate still rejected the same call
- [`qa/002-live-binary-smoke-test-required-before-claiming-a-security-posture-change-works.md`](./qa/002-live-binary-smoke-test-required-before-claiming-a-security-posture-change-works.md) — 3254 green tests shipped alongside two bugs only a packaged-binary smoke test caught
- [`code-patterns/004-ok-true-ack-must-not-carry-a-nested-error.md`](./code-patterns/004-ok-true-ack-must-not-carry-a-nested-error.md) — `{"ok":true,"result":{"error":...}}` recurred at a new call site after an earlier post-mortem on the same shape
- [`testing/005-mcp-gate-tests-never-exercised-the-renderer-actuation-path.md`](./testing/005-mcp-gate-tests-never-exercised-the-renderer-actuation-path.md) — exhaustive per-gate unit tests missed a bug that only existed in the full chain
- [`framework/006-electron-builder-skips-publish-when-release-type-mismatches.md`](./framework/006-electron-builder-skips-publish-when-release-type-mismatches.md) — v0.3.3/v0.3.5 shipped with zero assets; electron-builder silently skips upload when `releaseType` doesn't match an already-published release
- [`testing/006-eval-harness-grades-state-through-the-real-transport.md`](./testing/006-eval-harness-grades-state-through-the-real-transport.md) — "eval harness" is a house term: grade `.harnu/missions/*.md` state through Harnu's real MCP transport, never a model verdict, and prove every grader fails on a deliberately broken copy

## How to add a lesson

1. Create the file under the right category
2. Use the next sequential number for that category (e.g. `security/002-...`)
3. Add a row in this README's "Current lessons" list
4. Reference the lesson in the commit message of the fix that motivated it (so future archaeologists can find the rationale)
5. **Do not** put generic advice here — only bugs we actually hit
