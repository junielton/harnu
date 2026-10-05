<!-- Thanks for contributing to Harnu! Please fill out the checklist below. -->

## Summary

<!-- What does this PR change, and why? -->

## Related issue

<!-- e.g. Closes #123 -->

## Checklist

- [ ] `npm run typecheck` passes (node + web).
- [ ] `npm run lint` passes.
- [ ] `npm test` passes.
- [ ] `CHANGELOG.md` updated with a dated, user-facing entry (required for any behavior change; not needed for pure refactors/docs/tests).
- [ ] For UI changes: consulted `design.md` first (and updated it in this same PR if a new token/size/motion/component was needed). No raw colors or off-system sizes.
- [ ] For new visible strings: i18n keys added to **both** `src/renderer/src/i18n/en.json` and `pt-BR.json` (schema parity).
- [ ] For UI changes: screenshots or a short recording attached below.
- [ ] For a user-visible capability: the matching page under `docs/user/` is updated.
- [ ] For an agent-facing change (MCP verb, ACK shape, confirm semantics): `docs/harnu-features.md` is updated and its version marker bumped.
- [ ] For a runtime dependency change: `THIRD-PARTY-NOTICES.md` regenerated (`node scripts/gen-third-party-notices.mjs`).

<!-- If a gate does not apply (pure refactor, docs-only, catalog-internal change), say which
     escape label it needs: `no-changelog`, `no-awareness` or `no-user-docs`. A maintainer
     will add it; pull requests from forks cannot set labels. -->

## Screenshots / recording

<!-- Required for visible UI changes. Drag-and-drop here. -->
