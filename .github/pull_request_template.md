<!--
  Title: Conventional Commits, e.g. `fix(cleanup): …` / `feat(mission): …` / `docs(spec): …`
  HTML comments like this one are hidden in the rendered PR, so you can leave them.
-->

## Description

<!-- What changes and why, in 2–5 lines. Lead with the user-visible effect. -->

**Card / issue:** <!-- T123 · BUG-123 · #123 — or "none" -->

## Type of change

- [ ] Fix
- [ ] Feature
- [ ] Refactor / perf (no behavior change)
- [ ] Docs / spec only
- [ ] Chore / CI / deps

## Screenshots

<!--
  Required for any UI change. Drag images straight into this box.
  Show both themes when colors or surfaces changed. Delete this section if nothing visible changed.
-->

|       | Before | After |
| ----- | ------ | ----- |
| Dark  |        |       |
| Light |        |       |

<!-- Motion or a multi-step flow? Attach a short GIF/video instead of (or after) the table. -->

## How to test

<!-- Steps a reviewer can follow to see it working. -->

1.

## Checklist

- [ ] `CHANGELOG.md` entry (or not needed: internal / docs / test-only)
- [ ] `docs/harnu-features.md` updated + version bumped (agent-facing change)
- [ ] `docs/user/` updated (user-visible change)
- [ ] `design.md` updated first (new token, size, motion or component)
- [ ] New i18n keys in both `en.json` and `pt-BR.json`
- [ ] No client identifiers (names, ticket keys, paths)
- [ ] `npm run typecheck` and `npm run build` pass
