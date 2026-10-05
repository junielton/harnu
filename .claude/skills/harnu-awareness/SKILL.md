---
name: harnu-awareness
description: Use when a change touches Harnu's agent-facing surface and the self-awareness doc (docs/harnu-features.md) must be updated to match — i.e. you added or changed an MCP verb in src/main/mcp/tool-catalog.ts, changed the shape of an ACK a verb returns, changed grant/confirm semantics, or added a UI affordance the agent should proactively offer the user. Also use when the CI "Self-awareness doc updated" gate fails, or when someone asks how to keep harnu-features.md current. This skill codifies the editorial judgment: what belongs in the doc, what does NOT, the tone, and the version-marker bump. Do NOT use for CHANGELOG entries (that is the separate Changelog-is-mandatory contract) or for renderer-only styling changes.
---

# Keeping Harnu's self-awareness doc true

`docs/harnu-features.md` is prepended to every `claude` session's system prompt (T55,
`src/main/harnu-features.ts`). It is how a session knows what it can do **from inside
Harnu**. Like the CHANGELOG, it is a contract: an agent-facing change that doesn't
update it ships a session that lies about its own environment. A narrowly-scoped CI
gate (`scripts/ci/awareness-gate.mjs`) enforces it whenever
`src/main/mcp/tool-catalog.ts` or `src/main/harnu-features.ts` is touched.

This skill is the **editorial judgment** the gate can't check: whether an edit is
even needed, and if so, what to write.

## Step 1 — Decide if the doc needs to change

The doc describes **actionable capabilities the session itself uses or offers** — not
release notes. Ask: _does this change something the agent can now call, read, or
proactively offer the user?_

**In scope (update the doc):**

- A **new or changed MCP verb** in `tool-catalog.ts` (a new `create_*`, a renamed
  arg, a verb that now needs a grant).
- A **new field in an ACK** the agent should read (e.g. `grantBudgetRemaining` on
  actions run under a mission grant — the agent uses it to know how much budget is
  left).
- **Grant / confirm semantics**: what a `plan_mission` grant buys, when a confirm
  fires vs. runs free, budget/TTL behavior.
- A **UI affordance the agent should offer the user** in words — "open this .md
  report in the viewer", "enable agent control from the folder menu". If the agent
  should _say_ it exists, the doc must teach it.

**Out of scope (leave the doc alone):**

- Internal heuristics the agent can't act on: fleet-state / `stuck` classification,
  activity dot tuning, watcher or persistence internals.
- Renderer styling, design tokens, layout.
- Anything that's just "what shipped this release" — that's the CHANGELOG's job.

**Litmus test:** `budget-with-no-ACK` (T77c) — the agent reads a new field →
**in**. `fleet-state/stuck` classifier changes — nothing new to call or offer →
**out**. When genuinely unsure, ask: "what NEW sentence would a session need to act
correctly?" If you can't write one, the doc doesn't change — apply the
`no-awareness` label to the PR instead.

## Step 2 — Write it in the doc's voice

- **Second person, terse, imperative.** You are talking to the session about itself.
  "Observe `grantBudgetRemaining` on the ACK to know how much of the grant is left."
  Not "A new field called grantBudgetRemaining was added to the acknowledgement
  payload in order to..."
- **One capability per bolded lead-in.** Match the existing `**Approval Inbox.**`,
  `**MCP verbs (when enabled).**` paragraph shape.
- **Hedge capabilities that depend on config** with "(when enabled)" — the doc ships
  to every session, including ones where agent control is off.
- **Name the exact verb / field / button.** Vague capabilities don't get used.
- **No version numbers, no dates, no "we added".** It's a description of the present
  environment, not a history.

### Good vs. bad

- ✅ **Grants.** "Actions run under a `plan_mission` grant return
  `grantBudgetRemaining` in the ACK — read it to see how much of the batch budget is
  left before the grant is spent."
- ❌ "T77c (rodada 5) introduced a budget field. See the grant-core module."
  (release-note framing, points at code, teaches nothing actionable)
- ✅ **Guiding the UI.** "You can offer to open a Markdown report in Harnu's viewer —
  tell the user to hit **Open markdown file** in the topbar."
- ❌ "The markdown pane now supports file-backed rendering with a 4-pane cap."
  (internal capability the agent can't invoke; not phrased as an offer)

## Step 3 — Bump the version marker

The first line is `<!-- harnu-features vN (YYYY-MM-DD) -->`. **Every** content change
bumps `N` and updates the date. `src/main/harnu-features.ts` parses this marker
(`HARNU_FEATURES_VERSION`) for staleness/debugging — a content change without a bump
is a silent drift. One bump per change-set is enough (group same-day edits under one
new version).

## Step 4 — Verify

- Confirm the marker was bumped and the date is today's.
- If you touched `tool-catalog.ts` / `harnu-features.ts`, run the gate locally:
  `GATE_CHANGED_FILES="src/main/mcp/tool-catalog.ts,docs/harnu-features.md" node scripts/ci/awareness-gate.mjs`
  should print ✓.
- If the change was genuinely catalog-internal (no new agent-usable semantics) and
  you're skipping the doc, the PR needs the **`no-awareness`** label, not a bump.
