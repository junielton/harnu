# 001-no-hardcoded-strings-in-stores: render labels via `$t()`, not in the store

**Category:** i18n
**Discovered in:** `1677063` (post-review fix on `feat/fork-session`, May 2026)
**Status:** active

## The bug

`createForkedSession()` in `src/renderer/src/stores/sessions.ts` was
composing the fork's display label inline:

```ts
const summary = sourceLabel ? `Fork of ${sourceLabel}` : 'Fork of Untitled session'
const synthetic: Session = { /* ... */ summary /* ... */ }
```

That English literal `'Fork of '` got baked into `synth.summary` and then
rendered verbatim by `SidebarFolder#labelFor` and `Topbar#displayTitle`.
**Pt-BR users saw "Fork of …" in their sidebar despite the locale being
set to pt-BR.** The i18n keys `session.forkPlaceholder` (en: "Fork of
{summary}", pt-BR: "Fork de {summary}") existed in both locales but had
zero consumers — dead code.

This violated `CLAUDE.md` §i18n: _"All visible strings must go through
`$t('namespace.key')`. No string literals in templates."_ The rule
extends to stores: any value that **ends up rendered to the user** must
go through `$t()`, regardless of where it was composed.

## Root cause

Pinia stores feel like a natural place to "resolve once and store the
display string", especially when the store action runs at a moment the
component has good context (the source's summary, the synth's id, etc.).
Two pulls against doing it there:

1. **i18n composables (`useI18n`) work best inside Vue components.**
   From a Pinia store action you can reach the module-level
   `i18n.global.t(...)`, but that's a less-tested path and won't
   re-translate when the user changes locale at runtime (the resolved
   string is cached in store state).
2. **The store is the wrong layer for presentation.** Stores hold
   semantic state ("this is a fork of session X"); components decide
   how to _show_ that ("Fork of {sourceLabel}").

## The fix (and why)

Lazy translation in the renderer, semantic state in the store:

```ts
// Store action: holds semantic state, no display strings
const synthetic: Session = {
  /* ... */
  summary: '', // empty by design — see comment
  forkSourceId: sourceSessionId
}

// Sidebar component: renders lazily via $t
function labelFor(s: Session): string {
  if (isForkSynthetic(s)) {
    const source = sessions.allSessions.find((x) => x.sessionId === s.forkSourceId)
    const sourceLabel = source?.summary || source?.firstPrompt || t('session.unnamed')
    return t('session.forkPlaceholder', { summary: sourceLabel })
  }
  // ... rest of cases
}

// Topbar: same lookup + same $t pattern
```

**Free bonus:** the label is now **reactive to source rename**. If the
user `/rename`s the source session, the fork's label updates next render.
The old approach froze the fork's label at fork-creation time.

## How to detect in reviews

1. **Grep every Pinia store for English literals** in template-rendered
   fields:
   ```bash
   git grep -nE "summary\s*[:=].*'[A-Z]" src/renderer/src/stores/
   git grep -nE 'firstPrompt\s*[:=].*"[A-Z]' src/renderer/src/stores/
   ```
2. **Look at any string assigned to a `Session.summary`,
   `Session.firstPrompt`, `Project.alias`, `Worktree.branch`, or any
   field that ends up in a `{{ }}` interpolation.** If it's a literal,
   it should be a key.
3. **Check that every `session.<X>Placeholder` i18n key has at least one
   consumer** via `git grep "session.forkPlaceholder"` etc. Orphan keys
   are usually a sign the consumer is doing hardcoded composition
   somewhere else.

## Related

- `CLAUDE.md` §i18n — the contract
- `src/renderer/src/i18n/index.ts` — `MessageSchema = typeof en` enforces
  schema parity (see `i18n/002-vue-i18n-schema-parity.md`)
- `src/renderer/src/components/SidebarFolder.vue#labelFor` — canonical
  lazy-translation pattern for synthetic flavors
