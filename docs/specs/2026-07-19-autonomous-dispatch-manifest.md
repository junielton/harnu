# Spec: autonomous dispatch — remove the human from the manifest go-door

**Status:** proposed
**Supersedes the posture of:** T104 §2.1 (`submit_manifest` as an always-confirm verb)

## Problem

An operator plans a batch of work with the models, moves the cards to Ready, walks
away, and expects the fleet to boot itself overnight. It does not. The run stalls at
the dispatch manifest, waiting on a modal that nobody is there to click.

This is a **second** approval for a decision the human already made. Moving a card to
Ready — or authorizing the folder for orchestration at all — is the consent gesture.
Asking again at dispatch time makes the human a funnel in the one place the product
exists to remove them from.

The autonomy is not missing. It is stranded one step behind a gate:

- `gateAndReserve` (`src/main/roadmap-ipc.ts:1017`) already resolves `askOff` and,
  via `decideDispatchGate`, already returns `mode: 'auto'` with `grantId: null` for a
  stamped card when "Ask before agent actions" is off (the default). The unattended
  drain is built, works, and shadow-logs itself (`roadmap:manifest-dispatch`,
  `roadmap-ipc.ts:1050` and `:1076`).
- The stamp that unlocks that path (`approved` + `approvedBodyHash`) is written by
  `stampManifestApprovals` (`src/main/roadmap-ipc.ts:1490`), called **only** from
  `submitManifestHandler` (`src/main/mcp/tool-handlers.ts:1266`) — which itself reads
  exclusively from `ctx.opts.manifest` (`:1272-1274`), a field populated **only** by
  the operator-Allow path (`actuateAllow` → `runOptsFor`, `src/main/mcp/server.ts`,
  `def.op === 'submit_manifest'` branch around `:1077`). If `ctx.opts.manifest` is
  absent the handler hard-refuses: `'BAD_ARGS: no cards to stamp — this manifest was
never disclosed.'` (`tool-handlers.ts:1276`).
- `submit_manifest` is the only verb that can reach that handler, and it is
  deliberately declared without `silentAllowInAgentFolder`
  (`src/main/mcp/tool-catalog.ts:782-783`), so it always raises a confirm — the
  handler's disk-free, request-free design is not an oversight, it is the intended
  shape of an always-confirmed verb.

Net effect: everything after the carimbo is autonomous; the carimbo itself requires a
human, and the handler that writes it is architecturally wired to need one. That
single step is the whole reported failure.

**Corroborating context:** `a32dbdf` (`fix(roadmap): dispatch race + collision warn`,
BUG-40, 2026-07-20) already closed the worktree-orphan/dispatch-race failure mode that
would have made an unattended overnight fan-out materially more dangerous — a stalled
first attempt no longer poisons every retry with a collided worktree. This spec does
not touch that code path; it is cited because it already reduces the blast radius of
what this spec enables. Likewise `BUG-43`/`BUG-62`/`BUG-63` (manifest-drain fixes,
board status `review`, already merged to `main` as of this writing) hardened the exact
drain path this spec's autonomy relies on — worth knowing this is a well-exercised
system, not a build from a shaky base.

## Non-goals

- **Not** weakening the folder block. `FOLDER_NOT_ALLOWED` stays absolute — it is
  checked before every promotion layer (`plan-tool-call.ts:241`, guarding `:268`).
- **Not** removing the "Ask before agent actions" brake. It stays as the global
  opt-out and keeps forcing a confirm on every mutation, `submit_manifest` included.
- **Not** touching `delete_card`. Irreversible with no undo; it keeps its confirm.
- **Not** introducing a new per-folder setting. The existing global brake plus the
  per-folder block already express the two postures that matter.

## Design

### The consent model, restated

| Gesture                                  | Meaning                                   |
| ---------------------------------------- | ----------------------------------------- |
| Folder is not blocked                    | This folder may be orchestrated by agents |
| "Ask before agent actions" OFF (default) | …and I am not supervising each step       |
| Card in Ready                            | This work is approved to run              |

Once all three hold, dispatch is authorized. No further human event is required, and
the audit trail — not a modal — is how the operator reconstructs what happened.

### Change 1 — `submit_manifest` becomes silently allowed

`src/main/mcp/tool-catalog.ts`: add `silentAllowInAgentFolder: true` to the
`submit_manifest` def and rewrite the "ALWAYS asks the operator" comment and the
tool `description` (the description is agent-visible contract text and currently
states the opposite of the new behavior).

This alone yields the correct verdict matrix through the existing composition in
`plan-tool-call.ts:257-260`, with no new branch:

| Posture                           | Verdict                                                                  |
| --------------------------------- | ------------------------------------------------------------------------ |
| default (ask off), folder allowed | `allow`, silent                                                          |
| ask ON                            | `confirm` (the base gate never emits `allow` for a mutation in ask mode) |
| folder blocked                    | `deny FOLDER_NOT_ALLOWED`                                                |

### Change 2 — teach the handler to resolve a silent-allow batch itself

**Revision note:** the original draft of this change proposed extracting the stamping
logic out of `server.ts` into a new shared function. That is unnecessary — the two
functions it would have extracted already exist and are already exported,
independent of the confirm machinery:

- `buildManifestDisclosure(folder, cards, labels)` (`roadmap-ipc.ts:1432`) — rebuilds
  disclosure rows from disk for a set of requested slugs.
- `stampManifestApprovals(folder, resolved, selectedSlugs, now, substrateOverrides)`
  (`roadmap-ipc.ts:1490`) — stamps `approved` + `approvedBodyHash` on the selected
  rows.

The real gap is narrower and lives entirely in `submitManifestHandler`
(`tool-handlers.ts:1266`). Today it takes `(_args, ctx)` and **ignores `_args`
entirely** — it only ever reads `ctx.opts.manifest`, which is populated exclusively
by the operator-Allow path. Once `submit_manifest` is silently allowed, calls will
arrive with `ctx.opts.manifest` absent and real data sitting unread in `args.cards`.

Fix: the handler branches on `ctx.opts?.manifest` being present.

- **Present** (operator Allow, unchanged): read `ctx.opts.manifest` exactly as today.
- **Absent** (silent-allow path): read `args.cards` (the verb's own validated input —
  already shaped as `{ slug, substrate?, model?, effort? }[]`), call
  `buildManifestDisclosure(folder, args.cards, labels)` to resolve rows from disk, and
  treat every resolved slug as selected (`selectedSlugs = resolved.map(r => r.slug)`)
  — there is no operator to uncheck a card, so partial-go does not apply here; a
  batch either resolves and stamps in full or a card-level failure is reported per
  `buildManifestDisclosure`'s existing `ManifestBuildError` shape.

**Open implementation question for the executor:** `buildManifestDisclosure` requires
a `labels: BootPromptLabels` argument that today is only assembled on the `server.ts`
side of the confirm flow. Locate where the **normal single-card dispatch** path
(`dispatchCardSession` / `buildDispatchPrompt`, `roadmap-ipc.ts`, feeding
`gateAndReserve`) sources its labels and reuse that same source for the handler's
disk read — do not invent a second `BootPromptLabels` shape.

Invariants that must survive this change:

- The disclosure rows are **always** rebuilt from disk (`buildManifestDisclosure`),
  never taken verbatim from the agent's request beyond the slug/override fields the
  schema already validates. The agent names slugs; the server decides what those
  slugs currently say.
- `approved` / `approvedBodyHash` remain unwritable by any verb — `update_card` keeps
  refusing them as CONTROLLED fields (`tool-handlers.ts:508`).
- On the silent path every resolved card is treated as checked — see the security
  note below for what this collapses.

**Security note — what changes meaning, not what breaks.** `stampManifestApprovals`'s
own doc comment states the fingerprint it stamps is the one "the operator actually
saw in the disclosure... NOT re-read from disk here, so a body swapped between
disclosure and Allow can never get waved through on content the human never
reviewed." That guarantee assumes a human and a time gap between disclosure and
Allow. On the silent path there is neither: disclosure and stamp happen in the same
call, against the same disk read, with no reviewer in between. This is **not a
regression in the fail-closed property** — a card edited _after_ the silent stamp
still falls into `manifest-stale` at dispatch time exactly as today (T104 §2.3,
unchanged, see AC-7) — but the specific promise "a human saw this content" no longer
holds on this path, because there is deliberately no human on this path. State this
plainly in the PR description; do not describe the invariant as "preserved
unqualified."

### Change 3 — audit, since there is no longer a modal

With the confirm gone, the shadow log becomes the **only** record that a batch was
authorized. Push a shadow entry at stamp time on the silent path
(`event: 'roadmap:manifest-stamp'`) naming the folder, the slugs, and the resolved
substrate — so the Inbox's "Would have" tab shows the batch that self-approved, not
just the per-card dispatches that followed.

Also fire `notify` for a silently-approved batch, so an operator who is present sees
the fan-out start without having gated it.

## Risk — stated plainly

This changes the **default posture of the shipped product**, not just this machine. A
fresh clone gains the ability to stamp and dispatch N sessions with no human gesture
in the loop. That is the intended zero-friction principle, and it is also the largest
blast-radius default in the app: a mis-specified batch now spawns real sessions that
write real branches and burn real tokens unattended.

Accepted deliberately. The mitigations are the ones already in place — the folder
block, the global ask brake, the WIP ceiling, and the audit trail — plus Change 3,
which exists specifically because removing the modal removes the operator's only
synchronous signal.

## Acceptance criteria

- **AC-1** With ask off and the folder allowed, `submit_manifest` returns an ACK
  without raising a confirm, and the named Ready cards come back stamped.
- **AC-2** The stamped cards then drain unattended in the declared order, respecting
  the WIP ceiling.
- **AC-3** With "Ask before agent actions" ON, `submit_manifest` still raises the
  full checklist confirm, and partial-go still works.
- **AC-4** In a blocked folder, `submit_manifest` returns `FOLDER_NOT_ALLOWED`.
- **AC-5** `delete_card` still always confirms.
- **AC-6** `update_card` still refuses `approved` / `approvedBodyHash`.
- **AC-7** Editing a card after a silent stamp still voids it, and the card falls
  back to a per-card confirm at dispatch time (unchanged from T104 §2.3).
- **AC-8** A silent stamp produces a shadow-log entry naming folder + slugs.

## Test plan

- `tests/mcp-plan-tool-call.test.ts` — the `describe('planToolCall — the verbs that
STILL face a human', ...)` block (currently `:142`, asserting `submit_manifest`
  confirms "even in the free mode") narrows to `plan_mission` + `delete_card`; add a
  case asserting `submit_manifest` is silently allowed by default (AC-1) and still
  confirms with ask ON (AC-3).
- `tests/mcp-permission-core.test.ts` — unchanged; the base gate is not touched.
- New handler-level coverage for `submitManifestHandler`'s two branches: given
  `ctx.opts.manifest` (existing Allow path, unchanged behavior) vs. given only
  `args.cards` with `ctx.opts.manifest` absent (new silent path) — same rows
  resolved, same stamp written, from both entry points (AC-1, AC-3).
- Existing `delete_card` / CONTROLLED-field tests guard AC-5 and AC-6.

## Docs contract (repo gates)

- `CHANGELOG.md` — user-facing entry under `## 2026-07-20`, `### Changed`.
- `docs/capy-features.md` — **agent-facing**: the "Only **three verbs still face the
  user**" paragraph (currently `:38`) and the dispatch-manifest section (`:351` area)
  both assert the old behavior. Rewrite both — the new claim is **two** verbs
  (`plan_mission`, `delete_card`) — and bump `<!-- capy-features vN -->`. Enforced by
  `scripts/ci/awareness-gate.mjs`.
- `docs/user/agent-control.md` — currently states (line 62) that dispatch "always
  shows up in your Approval Inbox as an explicit checklist (never silently, never
  covered by a mission grant)" and (line 66) that Allow is only needed "with 'Ask
  before agent actions' off." Both sentences describe the behavior this spec removes;
  rewrite in human prose. Enforced by `scripts/ci/user-docs-gate.mjs`.
- `src/main/mcp/instructions.ts:47` — the MCP server instructions name
  `submit_manifest` as one of the two go-doors still facing a human; update in the
  same change since this spec removes it from that set.
