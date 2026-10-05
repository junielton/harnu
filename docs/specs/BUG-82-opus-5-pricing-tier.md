# BUG-82 — Opus 5 has no pricing tier: the default Opus is billed at Sonnet rates

**Date:** 2026-08-05 · **Status:** specified (not implemented) · **Card:** `.capy/memory/roadmap/BUG-82-cost-engine-has-no-tier-for-opus-5-the-default-opus-is-priced.md`
**Audit:** `.capy/out/claude-code-sync-audit.md` §1.2 · **Sibling (not this card):** audit §1.1, the 200k context window (`transcript-truth.ts:292`).

## 1. Symptom

`claude-opus-5` — the default Opus since CC **v2.1.219** — matches no tier, so it lands on the
unknown fallback and is priced at **Sonnet rates**. Because every Sonnet rate is exactly `0.6×`
the corresponding Opus 5 rate (`3/5 = 15/25 = 3.75/6.25 = 0.3/0.5 = 6/10`), the engine reports
**exactly 60 % of the true cost — a uniform 40 % under-report** on every component, including
the 1h cache write.

Measured on this machine's CLI cost oracle (`~/.claude.json`, §2.3): `claude-opus-5` is
**$453.66 of $813.00 (55.8 %)** of all last-session spend. The majority of the dollars Capy
displays are 40 % low, everywhere cost is shown: Usage Dashboard, cost-by-model trajectory,
session anatomy, project/session rollups, plan-fit inputs.

**One card claim corrected:** it is not _silent_. `estimated: true` is set, is sticky through
bucket merge (`usage-cost-core.ts:575`, `:601`) and does render — as a `*` next to the model
(`UsageDashboardExplorerTable.vue:533`, `UsageHistoryPane.vue:607`) with a footnote
(`usageHistory.chart.estimatedNote`). What the UI cannot say is _which direction_ and _by how
much_. "Flagged but 40 % low" is the real symptom.

## 2. Current behaviour, verified

Line refs below supersede the card's, which were off by a few lines (tiers are `:45-141` not
`:45-140`; the fast tier `:95-107` not `:96-105`; the unknown fallback const `:141`; the
canonicalizer `:163-223` with `familyVersion` at `:148-161`).

### 2.1 How a model id becomes a tier, and what Opus 5 does — traced

`canonicalizeModel(modelId, speed)` (`usage-cost-core.ts:174-223`) lowercases the id and tries
families in order — **opus → sonnet → haiku → fable/mythos** — each via `familyVersion`
(`:157-161`), which parses `<family>-<major>[-<minor>]` and tolerates a trailing date stamp:

```ts
const m = id.match(new RegExp(`${family}-(\\d+)(?:-(\\d{1,2})(?!\\d))?`))
```

Only enumerated `(major, minor)` pairs return a tier; everything else reaches `:222` —
`return { tier: TIER_DEFAULT_UNKNOWN, estimated: true }`, and `TIER_DEFAULT_UNKNOWN` is literally
Sonnet under another label (`:141`): `{ ...TIER_SONNET, label: 'unknown-default' }`.

For `claude-opus-5`: `familyVersion` → `{ major: 5, minor: null }`; the opus block (`:177-193`)
only branches on `major === 4` (`minor null|1`, `5|6`, `7|8`) — none fire; the sonnet/haiku/fable
probes don't match the string → unknown + Sonnet rates. Datestamped and `[1m]` variants behave
identically, verified against the regex: in `claude-opus-5-20260715` the `(?!\d)` lookahead
rejects both `-20` and `-2`, so `minor` stays `null`; in `claude-opus-5[1m]` the `[` terminates
the match. The card's claim holds, with the §1 correction about "silently".

### 2.2 The rest of the pipeline — read, confirmed unaffected, out of scope

`parseAssistantLine` reads `usage.speed` verbatim (`:388`) and the 1h/5m `cache_creation` split
(`:392-403`). `priceFileLines` dedupes by `requestId` (fallback `message.id`), keeping the FIRST
of each group (`:429-435`) — the 2.61× block-split gotcha. `priceTokens` (`:279-303`) prices 1h
writes at `2× inPerM`, 5m at `1.25× inPerM` (`:260-265`), flat when no split is present. None of
this is model-specific; adding a tier cannot disturb it.

### 2.3 The oracle — how a tier is VERIFIED instead of trusted

The durable part of this spec. **Do not take a rate from a blog post or a changelog.** The CLI
persists its own per-model billing in `~/.claude.json` → `projects[<cwd>].lastModelUsage[<id>]` =
`{inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, webSearchRequests,
costUSD}` for that project's **most recent session** — the `cost-tracker.ts:143-175` surface named
in `memories/sessions/2026-07-07-claude-code-internals-03-usage.md:23-24`. One row per project is
one independent equation in the four unknown rates. Read-only; never write this file.

Method (reproducible, no repo code needed):

1. Collect every row for the target model id (83 projects on this machine → 11 opus-5 rows).
2. Assume a candidate `(in, out, cacheRead)` and solve each row for the **implied cache-write
   $/Mtok**: `(costUSD − webSearch·0.01 − in·I − out·O − cacheRead·R) / cacheCreation`. A correct
   candidate makes every implied value land on **exactly** `1.25×I` (all-5m session), **exactly**
   `2×I` (all-1h), or strictly between them (mixed). A wrong candidate scatters.
3. Keep the all-1h rows, substitute `cacheWrite = 2·I`, least-squares the remaining three
   unknowns. A correct tier gives **max residual 0.00000000**.

Controls first, then the target — every number below is a measured output of that procedure:

| Model id                    | rows | solved in/out/cacheRead | max residual | status                       |
| --------------------------- | ---- | ----------------------- | ------------ | ---------------------------- |
| `claude-opus-4-6` (control) | 18   | 5 / 25 / 0.5            | 0.00000000   | matches `TIER_OPUS_45` ✅    |
| `claude-opus-4-7[1m]`       | 9    | 5 / 25 / 0.5            | 0.00000000   | matches `TIER_OPUS_47_48` ✅ |
| `claude-opus-4-8`           | 4    | 5 / 25 / 0.5            | 0.00000000   | matches `TIER_OPUS_47_48` ✅ |
| **`claude-opus-5`**         | 10   | **5 / 25 / 0.5**        | 0.00000000   | **no tier exists — the bug** |
| `claude-sonnet-5`           | 4    | 3 / 15 / 0.3            | 0.00000000   | matches `TIER_SONNET_5` ✅   |

`[1m]` costs the same as the plain id — verified, not assumed. The controls reproducing known
tiers bit-exact is what licenses trusting the opus-5 row.

## 3. Decision

### D1 — Add `TIER_OPUS_5` + one canonicalizer branch

```ts
export const TIER_OPUS_5: PricingTier = {
  label: 'opus-5',
  inPerM: 5,
  outPerM: 25,
  cacheWritePerM: 6.25,
  cacheReadPerM: 0.5
}
// in canonicalizeModel's opus block (:177-193):
if (major === 5 && minor === null) return { tier: TIER_OPUS_5, estimated: false }
```

Rates are the §2.3 oracle output, not published-rate hearsay — hence `estimated: false`.
Numerically identical to `TIER_OPUS_45` / `TIER_OPUS_47_48`, but a **separate const with its own
label**: `tierLabel` is surfaced in rollups and the families will diverge. Do not alias.
`minor === null` mirrors the `TIER_SONNET_5` precedent (`:204-206`), so a future
`claude-opus-5-1` keeps falling to `TIER_DEFAULT_UNKNOWN` + `estimated: true` — the fail-safe
stays armed for anything unverified (card AC 4). Dated and `[1m]` forms need no extra code: §2.1
proves the regex already normalizes them.

### D2 — Opus 5 + `speed === 'fast'`: apply the 6× precedent, flag `estimated: true`

D1 alone creates a **new** hazard: `canonicalizeModel('claude-opus-5', 'fast')` would return
`TIER_OPUS_5` with `estimated: false` — a confident 6×-low number, strictly worse than today's
honest guess. So add `TIER_OPUS_5_FAST` (`30 / 150 / 37.5 / 3.0`, label `opus-5-fast`) and gate
it on `speed === 'fast'` with `estimated: true`. This is not an invented price: it is the same 6×
precedent already applied to `TIER_OPUS_47_48_FAST` (`:95-107`), carrying the same flag.
**Rejected:** pricing fast at standard rates — under-reports a premium mode 6× and, unlike an
over-estimate, hides money actually spent.

**OPEN — must be confirmed before implementation:** whether Opus 5 even _has_ a fast mode. Zero
local evidence: of **225,257** `usage.speed` values across `~/.claude/projects/**.jsonl` on this
machine, **all are `"standard"`** — not one `"fast"` record exists. If Opus 5 turns out to have no
fast mode, drop `TIER_OPUS_5_FAST` and ignore `speed` for the family, as Fable does (`:216-220`).

### D3 — Opus 4.7 fast mode: **no pricing change**; fix the stale comment and record why

`usage.speed` is a property of the **record**, not of the model's present capability. v2.1.219
removing Opus 4.7 from fast mode changes what future transcripts can contain; it does not
retro-change what past ones were billed. A 4.7 record carrying `usage.speed === 'fast'` was
billed at fast rates and **must keep pricing at the fast tier** — historical data is the majority
of what the cost engine reads. So the 4.7/4.8 fast branch (`:187-192`) is left exactly as it is.

What changes is the comment at `:95-100`, which reads as a claim about the present ("Fast mode
exists for these tiers"). Rewrite it to record: (a) 4.7-fast is a **closed historical set** post
v2.1.219, 4.8-fast is live; (b) the 6× multiplier remains unverified for both and stays
`estimated: true`; (c) **it is unverified because no `speed: "fast"` record exists on this machine
to run §2.3 against** — the moment one does, the same procedure settles it. That satisfies card
AC 2 ("verified, or explicitly flagged estimated with the reason recorded") honestly, rather than
by renaming things. **Rejected:** splitting `TIER_OPUS_47_48_FAST` per version — two labels, zero
pricing difference, and it churns `tierLabel` in every persisted bucket.

### D4 — Sonnet 5 introductory pricing: keep NOT modelling it — now proven, not preferred

The comment at `:52-57` defers this as a style choice. The oracle settles it: **the CLI itself
bills Sonnet 5 at the sticker rate.** Fitting the 4 all-1h `claude-sonnet-5` rows against the
intro rate (2/10/0.2) scatters the implied cache-write across 6.44–10.09 — impossible for a rate
that must be 2.5 or 4.0. The sticker rate (3/15/0.3) gives **6.0000 = 2×3 on every row, residual
0.00000000**. Capy's goal is to match the CLI's own numbers, so modelling the intro price would
make Capy _disagree_ with `/cost`. The window closing 2026-08-31 is a non-event for this engine.
Replace the "deterministic pricing beats a date branch" rationale at `:52-57` with the oracle
evidence and state that no date branch is planned. **Rejected:** a date-windowed rate — it
manufactures a divergence from the CLI that does not exist today.

### D5 — Dashboard model colours: **no code change required** (card claim corrected)

`MODEL_COLOR_RULES` (`usage-dashboard-format.ts:28-34`) is regex-based, and the generic `/opus/`
rule at `:30` already matches `claude-opus-5` → blue `#3987e5`; the more specific
`/opus-4-7(?!\d)/` at `:29` does not match. Opus 5 is **not** falling to `MODEL_COLOR_UNKNOWN`.
Giving it its own colour (as 4.7 has) is a `design.md` §6 categorical-palette decision, not a
correctness fix — deferred. Add a regression test (§5) so the coverage is pinned, not incidental.

### D6 — Deliberately out of scope, each with a reason

- **Bare-alias model ids** — transcripts here contain `"model":"sonnet"` (508), `"haiku"` (87),
  `"opus"` (83), `"fable"` (2). `familyVersion` returns `null` for an unversioned alias, so all
  four price as Sonnet + `estimated` (`haiku` over-reports 3×; `opus`/`fable` under-report). Not
  fixed here: an alias in a historical record meant whatever the default was _at write time_,
  unrecoverable from the record. Needs a timestamp→default-model map — its own card. **Open.**
- **Non-Anthropic ids** (`deepseek-v4-flash` ×669, `deepseek-v4-pro` ×191, `qwen/qwen3.5-9b` ×6)
  price as Sonnet + `estimated`. Correct-by-design; no Anthropic rate applies.
- **Audit §1.1**, the hardcoded 200k window (`transcript-truth.ts:292`, `usage-bi-core.ts:35`) —
  same v2.1.219 trigger, different engine, separate card.
- **Boot-form aliases** `['opus','sonnet','haiku','fable']` (`ClaudeBootForm.vue:65`) and
  `routing-policy.ts:49-53` — `--model` _inputs_ to the CLI, never priced. No change.

### D7 — Bump the cost cache version (the fix does nothing without it)

`src/main/usage-cost.ts:167` — `const CACHE_VERSION = 5`, whose own comment (`:156-159`) states
the rule: _"Cached buckets are ALREADY PRICED, so the version must be bumped whenever the pricing
table changes."_ Buckets for already-scanned files are keyed by `(path, size, mtimeMs)`
(`:140-149`); an untouched opus-5 transcript would keep serving Sonnet-priced buckets forever.
**Bump to 6** with a `// v6: opus-5 tier` note in the same comment block.

## 4. Acceptance

- `canonicalizeModel('claude-opus-5', …)` → `TIER_OPUS_5`, `estimated: false`, for the plain,
  datestamped, and `[1m]` forms. Opus 5 cost rises to exactly `1/0.6 ≈ 1.667×` today's figure.
- Every rate in `TIER_OPUS_5` is reproducible by re-running §2.3 — no number in the diff comes
  from anywhere else, and the tier comment says so.
- No unknown model id is ever priced without `estimated: true`; `TIER_DEFAULT_UNKNOWN` and the
  `:222` fallback are untouched. `claude-opus-5-1` still lands there.
- A 4.7 transcript carrying `speed: 'fast'` prices identically before and after this change.
- `CACHE_VERSION` bumped; a rescan reprices existing files instead of serving stale buckets.
- The Sonnet 5 intro-pricing comment states the oracle evidence and the explicit decision.

## 5. Test plan

All in existing files — no new test file is needed.

| Test                                                                                                                                        | File                                         | Asserts                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------- |
| `TIER_OPUS_5` prices 1 Mtok of each kind at 5/25/6.25/0.50 (sibling of the `Opus 4.7/4.8` test at `:321`)                                   | `tests/usage-cost-core.test.ts`              | D1                                                             |
| `canonicalizeModel` → `opus-5`, `estimated:false`, for `claude-opus-5`, `claude-opus-5-20260715`, `claude-opus-5[1m]`                       | `tests/usage-cost-core.test.ts`              | D1, §2.1                                                       |
| `claude-opus-5-1` still resolves to `unknown-default` with `estimated:true`                                                                 | `tests/usage-cost-core.test.ts`              | D1 fail-safe, card AC 4                                        |
| Opus 5 + `speed:'fast'` → `opus-5-fast`, `estimated:true`, each rate exactly `6×` `TIER_OPUS_5` (mirrors the 4.7/4.8-fast test at `:334`)   | `tests/usage-cost-core.test.ts`              | D2 — **skip entirely if D2's OPEN resolves to "no fast mode"** |
| `TIER_OPUS_5` (+ `TIER_OPUS_5_FAST`) added to the C6 TTL-derivation loop at `:360-385`                                                      | `tests/usage-cost-core.test.ts`              | 5m == flat column, 1h == `2× inPerM`                           |
| 4.7 + `speed:'fast'` → `opus-4.7-4.8-fast`, `estimated:true` — **unchanged**; test renamed to say "historical records keep pricing at fast" | `tests/usage-cost-core.test.ts:334`          | D3 (regression guard, not a behaviour change)                  |
| Sonnet 5 sticker test at `:349` gains an oracle-provenance comment; assertions unchanged                                                    | `tests/usage-cost-core.test.ts`              | D4                                                             |
| `modelColor('claude-opus-5')` equals `modelColor('claude-opus-4-8')` and is not `MODEL_COLOR_UNKNOWN`                                       | `tests/usage-dashboard-format.test.ts:75-87` | D5                                                             |

**Honest gap.** `CACHE_VERSION` is **not exported** (`usage-cost.ts:167`), so no test can pin the
bump — it stays a manual checkbox (§7). Exporting it and asserting `>= 6` is cheap optional
hardening; decide at implementation time, and don't fake it with a self-referential assertion.

## 6. Contracts touched

- **`CHANGELOG.md` — YES.** `### Fixed`: "Opus 5 sessions were priced at Sonnet rates — every
  Opus 5 cost was ~40 % low. Fixed; existing data is repriced on the next scan."
- **`docs/capy-features.md` — NO.** No MCP verb, no ACK field, no grant/confirm semantics, no new
  affordance to offer. A pricing table is a fact the session cannot act on — the gate's own
  "nothing new to call or offer" litmus. Label **`no-awareness`** if the gate trips.
- **`docs/user/` — NO.** No new top-level component, no new top-level `src/main/` file, no
  `tool-catalog.ts` change. `docs/user/usage.md` describes the dashboard's _shape_ and names no
  model and no rate (verified), so nothing there becomes untrue. Label **`no-user-docs`**.
- **`design.md` — NO.** No new token, component, or visual state; D5 defers the palette question
  that _would_ require a §6 edit.
- **i18n — NO.** No new key; the `*` marker and `usageHistory.chart.estimatedNote` already exist.
- **English-only — applies**, including the oracle-provenance comments.

## 7. Definition of done

- [ ] `TIER_OPUS_5` in `usage-cost-core.ts`, with a comment naming §2.3 as the source of the rates
- [ ] D2 resolved: `TIER_OPUS_5_FAST` + branch added, **or** the OPEN closed as "no fast mode" and
      `speed` documented as ignored for the family
- [ ] `canonicalizeModel` opus-5 branch; `minor !== null` still falls through to unknown
- [ ] `:95-100` fast-mode comment rewritten per D3 (closed set, still estimated, reason recorded)
- [ ] `:52-57` Sonnet 5 comment rewritten per D4 (oracle evidence + explicit no-date-branch call)
- [ ] `CACHE_VERSION` 5 → 6 in `usage-cost.ts:167` with its reason appended to `:156-166`
- [ ] Tests in §5 green
- [ ] `CHANGELOG.md` entry under `### Fixed`
- [ ] `npm run typecheck` and `npm run build` pass; `local-ci` clean
- [ ] Post-merge sanity: rescan, then confirm a known Opus 5 session's Capy cost matches its
      `lastModelUsage[…].costUSD` in `~/.claude.json` — the §2.3 oracle as an end-to-end check
