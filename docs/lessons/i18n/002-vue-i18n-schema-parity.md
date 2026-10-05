# 002-vue-i18n-schema-parity: every key in `en.json` MUST be in `pt-BR.json`

**Category:** i18n
**Discovered in:** pre-existing constraint, codified during `5375e13`
**Status:** active

## The constraint

`src/renderer/src/i18n/index.ts` derives the type schema from `en.json`:

```ts
import en from './en.json'
import ptBR from './pt-BR.json'

export type MessageSchema = typeof en
export const i18n = createI18n<{ message: MessageSchema }, Locale>({
  // ...
  messages: { en, 'pt-BR': ptBR }
})
```

When you add `actions.fork: "Fork session"` to `en.json` but not to
`pt-BR.json`, `vue-tsc` fails with:

```
TS2322: Type '{ ... }' is not assignable to type '{ ... actions: {
  rename: string; fork: string; resume: string; ... } ... }'.
  Property 'fork' is missing in pt-BR.json#actions
```

This is enforcement-by-build — there's no "I'll add the translation
later" path. The build refuses.

## Why this matters for reviews

The dtk's review skills check `typecheck:web` as part of the analysis.
A PR that adds an English key without the pt-BR counterpart will fail
typecheck — but if the dev runs `typecheck:node` only or somehow misses
it, the broken state can land. The lesson is **always update both
locales in the same commit**.

## The pattern to follow

When adding a new visible string:

```diff
--- a/src/renderer/src/i18n/en.json
+++ b/src/renderer/src/i18n/en.json
   "sessionMenu": {
+    "forkFailedRace": "The source session is no longer available. ..."

--- a/src/renderer/src/i18n/pt-BR.json
+++ b/src/renderer/src/i18n/pt-BR.json
   "sessionMenu": {
+    "forkFailedRace": "A sessão de origem não está mais disponível. ..."
```

Both files, same commit. Key shapes must match — same nesting, same
field names.

## Untranslated technical nouns

Per `design.md` §8 ("Voice & copy" → "Principles"): _"Termos técnicos sem
tradução: worktree, commit, branch, tool call, PR, diff"_ (translated: "Technical
terms left untranslated: worktree, commit, branch, tool call, PR, diff"). The set is
slightly larger in practice — we also keep `fork`, `synth`, `repo`,
`PTY`, `IPC`, `JSONL`, `slug` untranslated. Reasoning: these are loan
words developers already think in English, and translating them creates
ambiguity ("bifurcação" could be a fork OR a Y-junction in a flowchart).

Rendering pattern when the word is also a verb in en but a noun in pt-BR:

```json
// en — verb form
"fork": "Fork session"
// pt-BR — noun + qualifier
"fork": "Fork da sessão"
```

The pt-BR "fazer fork" / "fazer commit" / "fazer push" verb construction
is idiomatic in Brazilian dev culture.

## How to detect in reviews

1. **Check every i18n diff is symmetric**:
   ```bash
   diff <(git show HEAD:src/renderer/src/i18n/en.json | jq 'paths | join(".")' | sort) \
        <(git show HEAD:src/renderer/src/i18n/pt-BR.json | jq 'paths | join(".")' | sort)
   ```
   Empty output = schema parity.
2. **Verify build passes**:
   ```bash
   npm run typecheck
   ```
3. **Look for fresh English literals in pt-BR.json** — usually means
   someone copy-pasted en.json content without translating.

## Related

- `CLAUDE.md` §i18n — the contract
- `src/renderer/src/i18n/index.ts` — schema derivation
- `design.md` §8 — voice + copy + which technical nouns stay
  untranslated
