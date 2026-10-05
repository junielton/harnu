# BUG-81 — context window is hardcoded at 200k, so every context % is ~5× too high

**Date:** 2026-08-05 · **Status:** specified (not implemented) · **Card:** `.capy/memory/roadmap/BUG-81-context-window-is-hardcoded-at-200k-sonnet-5-and-opus-5-are-1m.md`
**Audit:** `.capy/out/claude-code-sync-audit.md` §1.1 (and §3.2 — partly wrong, see §2.4)

## 1. Symptom

Every context percentage Capy computes for a session on a current model is ~**5× too
high**: a session actually 8% full reads 40%; one at 20% reads 100% and paints the red
"near `/compact`" treatment. Affected — verified against this machine's transcripts and
telemetry (§2.5) — are `claude-sonnet-5`, `claude-opus-5`, `claude-opus-4-8`, i.e. the
current defaults. Only `claude-haiku-4-5` is genuinely 200k.

Two surfaces are wrong for two reasons: the **transcript path** divides by a hardcoded
200k (§2.1), and the Usage Dashboard's **"Peak context"** divides by a _second, separate_
hardcoded 200k (§2.3 — not on the card). The statusline path is already correct and is
being shadowed by the wrong one (§2.4).

## 2. Current behaviour, verified

### 2.1 The hardcoded window — `src/main/transcript-truth.ts:291-300`

```ts
export const DEFAULT_CONTEXT_WINDOW = 200_000
export const LARGE_CONTEXT_WINDOW = 1_000_000

export function contextWindowForModel(model: string | null | undefined): number {
  if (typeof model === 'string' && /\[1m\]/i.test(model)) return LARGE_CONTEXT_WINDOW
  return DEFAULT_CONTEXT_WINDOW
}
```

`computeCtxPct` (`:345-368`) keeps the last `message.model` seen (`:353`) and the last
assistant `usage` (`:356-357`), then divides at `:365-366`.

**Card correction.** The card cites `:316,340` for the `compact_boundary.postTokens`
baseline reset. `:316-325` is the `postTokensOf` helper and `:340` is inside a docstring —
the reset is the `else if` at **`:359-362`**. It is orthogonal to this fix (numerator, not
divisor) and must keep passing unchanged.

**Edge:** `model` is scoped to the window passed in. `deltaTruth`
(`claude-watcher.ts:429-451`) passes only _new_ JSONL lines, so a delta carrying `usage`
but no `message.model` resolves to the fallback. The table needs a defensible fallback,
not just a correct one.

### 2.2 Consumers — everything downstream inherits it

| Consumer                                 | Path                                                                                                           | Source                                           |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Session entry field                      | `claude-reader.ts:164,402,644,876` → `preload/index.ts:498` → `stores/sessions.ts:192,4373`                    | transcript                                       |
| Live delta updates                       | `claude-watcher.ts:431,444-445`                                                                                | transcript                                       |
| Hover preview + its "near /compact" line | `SessionPreview.vue:61-62,175-181,190`                                                                         | `session.ctxPct ?? tele.contextPercent`          |
| Fleet card chip                          | `FleetBoardCard.vue:65,258`                                                                                    | `session.ctxPct ?? usage.contextPercentFor(...)` |
| Footer context chip                      | `footer-format.ts:37`, `StatusFooter.vue:131`                                                                  | statusline only                                  |
| Footer "near /compact" badge             | `footer-format.ts:60-63`, `StatusFooter.vue:104-106`                                                           | statusline only                                  |
| Usage Dashboard "Peak context"           | `usage-bi-core.ts:256-259,381` → `UsageDashboardAnatomy.vue:392-415`, `UsageDashboardExplorerTable.vue:96,467` | own table (§2.3)                                 |

Colour thresholds (`usage-format.ts:32-46` at 80/95, `:57-60`) need no change — they are
correct once the input is.

### 2.3 The second hardcode — `src/main/usage-bi-core.ts:35-45`

```ts
export const CONTEXT_WINDOW_DEFAULT = 200_000
export const CONTEXT_WINDOW_1M = 1_000_000
export function contextWindowFor(modelId: string): number {
  return modelId.includes('[1m]') ? CONTEXT_WINDOW_1M : CONTEXT_WINDOW_DEFAULT
}
```

Feeds `peakContextRatio` (`:256-259`) → `peakContextPct` (`:381`).
`UsageDashboardAnatomy.vue:405-415` already ships a comment _and_ a user-facing hint
(`usageDashboard.anatomy.peakContextOverflowHint`) apologising that >100% readings are the
heuristic undercounting the window — obsolete once fixed.

### 2.4 The statusline already has the true window — audit §3.2 is wrong

The audit says Capy ignores `context_window.used_percentage`. It does not:
`statusline-parse.ts:135-137` parses all three fields (typed at `:27-30`) —

```ts
contextPercent: numOrNull(ctx.used_percentage),
contextWindowSize: numOrNull(ctx.context_window_size),
exceeds200k: obj.exceeds_200k_tokens === true,
```

— consumed by the footer (`footer-format.ts:37`) and as a _second-choice_ fallback in
`SessionPreview.vue:62` / `FleetBoardCard.vue:65`. **`contextWindowSize` is parsed and used
by nobody.** The real defect on this axis is **precedence**: both `??` chains prefer the
transcript value, which is present for essentially every live session, so the correct
statusline number is permanently shadowed by the wrong one.

### 2.5 Ground truth measured here (CLI `2.1.222`)

Model ids across 30 sampled transcripts under `~/.claude/projects/` — **not one carries a
`[1m]` marker**: `claude-sonnet-5` (2608), `claude-opus-5` (2261), `claude-opus-4-8`
(1510), `claude-haiku-4-5-20251001` (11), `<synthetic>` (3).

Capy's persisted telemetry (`~/.config/capy/statusline/telemetry-cache.json`, 53 entries) —
the CLI's own answer: `claude-opus-5` → `context_window_size: 1000000` (49×),
`claude-sonnet-5` → `1000000` (4×).

So: 1M is native and unmarked, `[1m]` no longer appears, and `<synthetic>` is a real
model-id value that must not crash the parser.

### 2.6 The canonicalizer to reuse — `src/main/usage-cost-core.ts`

- `familyVersion(id, family)` — **`:157-161`, NOT exported**. Returns
  `{ major: number; minor: number | null } | null`, tolerating date stamps via a `(?!\d)`
  lookahead (doc `:148-156`).
- `canonicalizeModel(modelId, speed): { tier: PricingTier; estimated: boolean }` —
  `:174-223`, exported. Pricing only; exposes no family/version, so it is not reusable
  as-is for sizing.

**Card correction:** "`usage-cost-core.ts:151-224`" is the right neighbourhood, but the
reusable primitive is the _private_ `familyVersion`, not the exported `canonicalizeModel`.
The file has **zero imports**, so anything may import it without a cycle.

## 3. Decision

### 3.1 One table, one home: extend `usage-cost-core.ts`

Export `familyVersion` (public name `parseModelFamilyVersion`) and add beside it:

```ts
export const CONTEXT_WINDOW_200K = 200_000
export const CONTEXT_WINDOW_1M = 1_000_000
/** CLI-default context window for a model id. 200k for anything unrecognized. */
export function contextWindowForModelId(modelId: string | null | undefined): number
```

Order: explicit `[1m]` → 1M (kept, back-compat); else family+version lookup; else 200k.

| Family / version                                                  | Window |
| ----------------------------------------------------------------- | ------ |
| `opus` 4.6 / 4.7 / 4.8 / 5                                        | 1M     |
| `sonnet` 4.6 / 5                                                  | 1M     |
| `fable` 5, `mythos` 5                                             | 1M     |
| `sonnet` ≤ 4.5 and 3.x; `opus` 4.0 / 4.1 / 4.5; `haiku` 3.5 / 4.5 | 200k   |
| anything else (`<synthetic>`, future ids, `null`)                 | 200k   |

`transcript-truth.ts` and `usage-bi-core.ts` both delegate; `contextWindowForModel` and
`contextWindowFor` become thin re-exports (keep the names — three test files import them)
and `usage-bi-core.ts`'s duplicate constants are deleted.

**Rejected.** (a) A new `src/main/context-window.ts` — an added top-level `src/main/` file
trips the user-docs gate (`user-docs-gate-core.mjs:53`) for a pure refactor and creates a
_third_ home for model-id knowledge. (b) Widening `canonicalizeModel`'s return type — it is
a pricing API with an `estimated` contract; the two concerns share a parser, not a result
shape. Accepted trade-off: "cost core" becomes the model-id knowledge base; say so in its
file header.

### 3.2 Statusline is authoritative for a live session; the transcript is the offline path

Invert both `??` chains to `tele.contextPercent ?? session.ctxPct`
(`SessionPreview.vue:62`, `FleetBoardCard.vue:65`).

`used_percentage` is the CLI's own arithmetic against the window it actually granted
**this** session — it already accounts for entitlement, `CLAUDE_CODE_DISABLE_1M_CONTEXT`,
and any future gating, with zero guessing. §3.1 is a model-level _default_; the statusline
is a session-level _fact_.

The transcript path can never be deleted: statusline blobs land in
`<userData>/statusline/inbox/` (`statusline.ts:63-64`), that directory is **wiped on every
Capy start** (`statusline.ts:286`), telemetry has a 24h TTL (`statusline-parse.ts:66`), a
user passing `--settings <file>` silently disables the writer (audit §3.8), and parked /
historical / externally-launched sessions never write one. It is also the only source for
the Usage Dashboard's retrospective per-file peak (§2.3), computed long after a session ends.

### 3.3 Do not silently claim 1M for a user who does not have it

Capy cannot read the plan; the table encodes the **CLI default**. So on a 1M-capable model
Capy today **over**-reports ~5× (a 20%-full session paints red and the operator compacts a
session with 800k of headroom); after the fix a user _without_ 1M would be
**under**-reported ~5× (a full session reads 18% and the badge never fires). Under-reporting
is quieter but not free — it mutes exactly the warning the badge exists for. Three things
bound it, and the spec claims no more:

1. **The badge is not window-derived.** `exceeds200k` (`statusline-parse.ts:137`) comes
   from the CLI and drives `nearCompactReason → 'over200k'` (`footer-format.ts:60-63`) at
   _any_ percentage, so a 200k-entitled user on a 1M model still gets a real warning.
2. **§3.2 confines the risk to where it is least actionable** — any session live enough to
   near its ceiling has telemetry, and telemetry now wins.
3. **Optional cheap guard:** clamp to 200k when `CLAUDE_CODE_DISABLE_1M_CONTEXT` is truthy
   in Capy's env. PTYs inherit it (`pty.ts:733`), so this is exact for Capy-spawned
   sessions and a no-op for others; it never _adds_ a wrong 1M claim.

### 3.4 Open questions — flagged, not guessed

- **Learn the window instead of tabulating it?** `contextWindowSize` is already parsed and
  cached per session; feeding observed `(modelId → window)` pairs back into the transcript
  path would make the table a self-correcting bootstrap default. Needs telemetry state
  wired into `claude-reader`/`claude-watcher`, which are today pure of it. Out of scope for
  a "simple" card; the right second slice.
- **Is 1M the CLI default, or opt-in for models that merely support it?** §2.5 shows the
  CLI granting 1M unprompted on this account on `2.1.222`. One account cannot settle
  model-level vs entitlement-level; the table encodes the observed behaviour and §3.3
  bounds the cost of being wrong.
- **`opus` 4.6 / 4.7 and `sonnet` 4.6** are 1M per the published model table but were not
  observed live here. Listed as 1M; verify against a real transcript before merging if one
  exists.

## 4. Acceptance

- Context % is computed against a per-model window resolved from a canonicalized model id,
  **200k** for an unknown id, never throwing on `<synthetic>`, `''`, or `null`.
- `claude-sonnet-5`, `claude-opus-5`, `claude-opus-4-8` → 1M; `claude-haiku-4-5-20251001`
  → 200k; a `[1m]`-suffixed id → 1M regardless of family.
- Exactly **one** table exists; `usage-bi-core.ts`'s duplicates are gone and "Peak context"
  uses the same resolution.
- The post-`/compact` baseline reset (`transcript-truth.ts:359-362`) is unchanged and still
  correct at the new windows.
- For a session with statusline telemetry, the displayed % is the CLI's `used_percentage`,
  not Capy's computation.
- `CHANGELOG.md` gets an entry under **Fixed**.

## 5. Test plan

| Test                                                                                                   | File                                                                                                                                                | Asserts         |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| Table: sonnet-5 / opus-5 / opus-4-8 → 1M; dated haiku-4-5 → 200k; `<synthetic>` / `''` / `null` → 200k | `tests/usage-cost-core.test.ts` (existing — the canonicalizer's home)                                                                               | §3.1 + fallback |
| `[1m]` still forces 1M on any family                                                                   | `tests/usage-cost-core.test.ts`                                                                                                                     | back-compat     |
| `contextWindowForModel` re-export keeps its signature                                                  | `tests/transcript-truth.test.ts:323-330` — **rewrite in place**: it currently asserts `claude-opus-4-8` → 200k, which becomes the wrong expectation | no API break    |
| `computeCtxPct` scales per model: 500k on `claude-sonnet-5` → 50%, not 100%                            | `tests/transcript-truth.test.ts:332-393` — two fixtures pin `claude-opus-4-8` (`:344-355`, `:381-388`) and must be re-based                         | §1              |
| `postTokens` baseline still wins / still loses to a later assistant                                    | `tests/transcript-truth.test.ts:367-388` (unchanged semantics, new window)                                                                          | AC 4            |
| A delta with `usage` but no `message.model` falls back to 200k, no throw                               | `tests/claude-watcher.test.ts:37-41` (fixture uses `claude-opus-4-8`; its `30` moves)                                                               | §2.1 edge       |
| `contextWindowFor` delegates; `peakContextRatio` scales per model                                      | `tests/usage-bi-core.test.ts:181-188` and `:190-212`                                                                                                | §2.3            |
| Session `ctxPct` end-to-end from a scraped transcript                                                  | `tests/claude-reader-truth.test.ts:121,170,188` (re-based)                                                                                          | §2.2            |
| Statusline still parses all three ctx fields                                                           | `tests/statusline-parse.test.ts:53-55` (unchanged)                                                                                                  | no regression   |
| `nearCompactReason` still fires on `exceeds200k` at a low %                                            | `tests/footer-format.test.ts:51-68` (unchanged)                                                                                                     | §3.3 (1)        |

**Honest gaps.**

- The **precedence inversion** (§3.2) lives in two `computed`s inside `.vue` SFCs
  (`SessionPreview.vue:62`, `FleetBoardCard.vue:65`) with no extracted helper and no
  component harness in `tests/`. Either extract the fallback into a small exported helper
  (`usage-format.ts`) and unit-test that, or verify by hand with
  `docs/dev/live-verify-second-instance.md`. Do not fake it with a test that only asserts
  the raw store fields.
- The **`CLAUDE_CODE_DISABLE_1M_CONTEXT` guard** is testable only if the env value is
  injected; reading `process.env` inline inside `usage-cost-core.ts` would make it
  untestable _and_ break that file's zero-dependency purity. Pass it in, or skip the guard.
- **Whether the CLI grants 1M to a 200k-entitled account** cannot be tested from this repo
  at all. It is a §3.4 open question, not a test.

## 6. Contracts touched

- **`CHANGELOG.md` — YES.** `### Fixed`: "context percentage is now computed against each
  model's real context window (1M for Sonnet 5 / Opus 5 / Opus 4.8) instead of assuming
  200k, and prefers Claude Code's own reading for a live session."
- **`docs/capy-features.md` — NO.** No MCP verb, ACK field, grant/confirm change, or new
  agent-offerable affordance. The gate fires only on `src/main/mcp/tool-catalog.ts` or
  `src/main/capy-features.ts`, neither touched — no `no-awareness` label needed.
- **`docs/user/` — NO.** The gate fires on an _added_ top-level component, an _added_
  top-level `src/main/` file, or a `tool-catalog.ts` change
  (`user-docs-gate-core.mjs:53-56`); §3.1 adds none, so no `no-user-docs` label is needed.
  If any `docs/user/` page states a 200k window in prose, fix it there — grep before merging.
- **`design.md` — NO.** No new token, component, state, or threshold; only the number fed
  into the existing 80/95 breakpoints changes.
- **i18n — YES, one key pair.** `usageDashboard.anatomy.peakContextOverflowHint`
  (`en.json:1231` / `pt-BR.json:1231`) apologises for the very heuristic being fixed.
  Reword, or delete the key **and** the `v-if` at `UsageDashboardAnatomy.vue:413-415` plus
  the comment at `:405-412` — in **both** locale files in the same change, or
  `MessageSchema = typeof en` breaks `vue-tsc`.

## 7. Definition of done

- [ ] `parseModelFamilyVersion` exported and `contextWindowForModelId` + the §3.1 table
      added to `src/main/usage-cost-core.ts`
- [ ] `transcript-truth.ts:291-300` delegates; `contextWindowForModel` kept as a re-export
- [ ] `usage-bi-core.ts:35-45` duplicates deleted; `contextWindowFor` delegates
- [ ] `SessionPreview.vue:62` and `FleetBoardCard.vue:65` prefer statusline telemetry
- [ ] §3.3 (3) env guard shipped, or dropped with a one-line reason in the PR
- [ ] every §5 test green, including the re-based existing expectations
- [ ] the §5 precedence gap covered by an extracted-helper test or a live CDP check
- [ ] `peakContextOverflowHint` reworded/removed in `en.json` **and** `pt-BR.json`
- [ ] `CHANGELOG.md` entry under `### Fixed`
- [ ] `npm run typecheck` and `npm run build` pass
