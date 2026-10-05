# 001-english-lingua-franca: non-English prose outside i18n is a review finding

**Category:** conventions
**Discovered in:** OSS-readiness audit, `chore/english-lingua-franca` (Jul 2026)
**Status:** active

## The bug class

Portuguese content accumulated across the repo over time — in `design.md` (the
visual-system contract, ~2,400 lines of it), code comments, doc-string quotes of
UI copy, generated markdown templates, plan/spec documents, and even a doc's own
filename (`docs/adr/0001-cobertura-como-gate-de-regressao-confiavel-por-agente.md`).
None of it was malicious or even wrong at the time — the author's working language
is Portuguese — but once the repo goes open source, a contributor who doesn't read
Portuguese can't review, extend, or trust a "single source of truth" doc half of
which they can't parse. A design contract, an ADR, or a code comment that only
half the team can read isn't really documented.

## Root cause

There was no stated policy. Nothing said English was required anywhere outside the
`en.json`/`pt-BR.json` i18n files, so the working language leaked into whatever the
author was thinking in at the time — including places meant to be the durable,
citable contract (`design.md`, ADRs) rather than a private note.

## The fix (and why)

`CLAUDE.md` and `CONTRIBUTING.md` now state a **Language policy**: English is the
lingua franca for all code, comments, docs, specs, PRDs, commit messages, PR
descriptions, and project-memory content. The **only** exception is i18n
resources — `src/renderer/src/i18n/*` locale files (`pt-BR.json` and any future
non-English locale) and test fixtures that exist specifically to exercise
i18n/locale behavior. Everything else translates, with technical nouns (worktree,
branch, commit, tool call, diff, PTY) staying untranslated per `design.md` §8.

## Good / bad examples

**1. Code comment**

```ts
// ❌ Bad — comment only readable by PT speakers
// Convenção núcleo-puro / casca-fina (ADR-0001): só a superfície testável entra na métrica.

// ✅ Good
// Pure-core / thin-shell convention (ADR-0001): only the testable surface enters the metric.
```

**2. A doc quoting UI copy or a PRD term**

```md
<!-- ❌ Bad — the citation itself is untranslated prose, not a legitimate PT quote -->

The hot snapshot is a PROPOSAL only (PRD §3.4 — "sugerida, não silenciosa").

<!-- ✅ Good -->

The hot snapshot is a PROPOSAL only (PRD §3.4 — "suggested, not silent").
```

**3. Test names/descriptions**

```ts
// ❌ Bad — parenthetical annotation left in Portuguese
it("carries inheritScope:'once' onto the settled outcome (Só esta)", async () => { ... })

// ✅ Good
it("carries inheritScope:'once' onto the settled outcome (Only this)", async () => { ... })
```

**4. What stays PT — the i18n exception (NOT a finding)**

```json
// ✅ Fine — src/renderer/src/i18n/pt-BR.json is the locale file itself
{ "sessionMenu": { "fork": "Fork da sessão" } }
```

```ts
// ✅ Fine — arbitrary PT test data verifying i18n/unicode handling, not prose
const payload = { title: 'Precisa de você', body: 'harnu · fix bug' }
```

The distinguishing question: is this PT text _documentation/comments meant to be
read_, or is it _data a test/locale file is intentionally carrying_? The first is
a finding; the second is not.

## How to detect in reviews

1. **Scan added/changed lines for Portuguese signals**: accented characters
   (`ção`, `ções`, `ã`, `õ`, `é`, `á`, `í`, `ó`, `ê`, `â`, `ô`, `ç`) AND common
   unaccented stopwords (`não`, `também`, `já`, `código`, `usuário`, `sessão`,
   `função`, `então`, `porém`, `pra`, `pro`, `sem`, `está`, `será`).
2. **Check the file path**: is it under `src/renderer/src/i18n/*` (locale files) or
   a test whose whole point is testing i18n/locale/unicode behavior? If yes, KEEP.
   Otherwise it's a finding.
3. **Check doc filenames too**, not just content — a PT-named file (e.g. an ADR
   slug) is as much a barrier to a non-PT reader as PT prose inside it.
4. **Cross-references**: if a PT heading gets translated, grep the repo for other
   files quoting that heading by its old name (`design.md §6 — <old PT name>`) and
   fix those too — a stale citation is as confusing as an untranslated one.
5. **Do not flag**: `pt-BR.json` itself, i18n test fixtures, or a lesson (like
   `i18n/002`) whose entire point is teaching PT translation patterns.

## Related

- `CLAUDE.md` §Language policy — the contract
- `CONTRIBUTING.md` §Language policy — the contributor-facing mirror
- `design.md` §8 (Voice & copy) — which technical nouns stay untranslated
- [`i18n/002-vue-i18n-schema-parity.md`](../i18n/002-vue-i18n-schema-parity.md) — the
  i18n-specific parity rule this lesson complements (that one is about _symmetry
  between locales_; this one is about _where non-English prose is allowed at all_)
