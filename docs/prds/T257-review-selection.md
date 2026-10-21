# Review selection — point at the lines you are reading, and let the companion see them

**Status:** PRD v1 (2026-10-20) — **U0 of the T257 delivery**, written against `main` at `f0ceeca8`. Not yet signed: three operator decisions are open (§8) and the spec names the guards each one touches.
**Card:** `T257` (parent `T164`) · **Mission:** `mnt-71c908f4`, step `stp-1` · **Spec:** `docs/specs/2026-10-20-t257-review-selection.md`
**Base:** `docs/prds/T245-review-companion-session.md` §3 Tier 2 (the question this PRD answers) · `docs/specs/2026-08-27-t244-approve-from-review.md` · `docs/specs/2026-08-28-t245-u2-companion-corrective.md` (T247) · `docs/specs/T389-companion-mod/` (the transport)
**Supersedes:** the 2026-09-10 U0 of this card. It was committed on `feat/t257-inline-comments`, which exists in no ref today, and it predates the Harnu mod. It is not recovered; this document is rewritten from `main`.

---

## 0. Premise

The review companion (T245) gives the operator a stranger to talk to beside the diff. What it cannot do today is know **which lines the operator is looking at**. The operator has to say "lines 85–92 of `speech.ts`" in words, and the companion has to find them. The T245 PRD already named the fix and priced it as Tier 2: _"the selection is the subject"_ (§3).

This delivery builds the smallest honest version of that:

1. **Select** lines (or a whole file) in the Review takeover's diff and see the selection highlighted.
2. **Deliver** that selection to the companion as context, through the Harnu mod's command channel, on an explicit operator gesture.
3. **Show** both sides what happened: a line in the companion's terminal, and a chip on the diff that says sent / answered.

The selection is _also_ the primitive a later wave (U3) uses to post an inline thread to GitHub. That is why its shape is fixed now, even though nothing in this delivery posts anything.

## 1. The user flow

1. The operator has the Review takeover open and has opened a companion with **Ask a fresh session** (unchanged, T245).
2. They click a line number in the diff gutter. The row is highlighted. Shift-click (or drag across gutters) extends it to a range inside the same hunk. A button in the file header selects the whole file instead.
3. A selection bar names what is selected (`src/main/speech.ts · L85–92`) and offers **Ask about this**, **Copy as text** and **Clear**.
4. **Ask about this** hands the selection to the companion. The companion's terminal shows one line above its prompt (`⧉ speech.ts L85–92`). The bar's chip moves through _sending → sent → asked → answered_.
5. The operator types their question in the companion. The companion's next turn includes the selection. **Nothing is sent to the model by the send itself** — it is context, not a turn.
6. Every way the send can fail ends in a stated reason and a next step. **Copy as text** is always available, so a failed delivery is never the end of the road.

## 2. Problem

- **Typing coordinates is lossy and slow.** "The `child.kill()` in the catch, around line 85" costs the operator a re-read and costs the model a search. The Q1 trial (§4, D5) measured the model's side of this: six tool calls, three files, to resolve one pointer.
- **The old transport candidates are all wrong.** Pasting into the composer (`pasteAndSubmit`) is "Harnu typing into a session" — the thing T245 AC-4 forbids. `message_session` reaches only sessions Harnu spawned _for an agent_, and the companion is a helper-pane PTY. The mod's `context.append` is a hidden context row with no composer involved (T257 card re-plan, 2026-10-20).
- **The mod has no consumer for the thing this needs.** `context.append` and `ui.band.set` are in the wire contract but nothing in `main` or the mod implements or gates them (spec §5). Part of this delivery is the first real consumer of the actuator half of T389.

## 3. Scope

| Unit    | What                                                                                                                                                                                  | Depends on |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| **U1**  | The selection model over the rendered diff, in `addPullRequestReviewThread`'s shape, plus its native highlight and the selection bar (without the send). No consumer, no transport.   | this PRD   |
| **U2a** | Mod and host: the `harnu.review-selection` context key, the host composer, the gate rows and feature policies, the mod's `context.append` and `ui.band.set` handlers, delivery state. | U1         |
| **U2b** | Renderer: **Ask about this**, **Copy as text**, the sent / answered chip, the refusal outcomes. Needs U2a's IPC.                                                                      | U2a        |

U2a is the large unit and the spec says where it may split further (spec §10). The unit boundaries, ACs, file ownership and stacking are in the spec; this PRD fixes only _what_ and _why_.

## 4. Decisions already taken

None of these is reopened here. Each carries its source so a reader can tell a decision from a proposal.

| #       | Decision                                                                                                                                                                                                                                                                       | Source                                                                                   |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| **D1**  | The interlocutor is always a **fresh, read-only (plan-mode) session**. No picker, no "ask the author session".                                                                                                                                                                 | T245 PRD §1, §2.1                                                                        |
| **D2**  | Conversation is **pulled, never pushed**. Nothing the session says may render as evidence in the pane; no auto-summary; Harnu never volunteers a message.                                                                                                                      | T245 PRD §2; T245 AC-3, AC-4                                                             |
| **D3**  | The selection is modelled on `addPullRequestReviewThread`'s input — `path`, `line`, `side`, `startLine`, `startSide` — _before anything is posted anywhere_.                                                                                                                   | T245 PRD §3 Tier 2; T257 card "The primitive"                                            |
| **D4**  | A line anchor is valid only against the commit it was read on. It travels with the base and head SHAs. Posting (U3) reuses T244's head guard and its confirm gate — **no second gate**.                                                                                        | T257 card "The hazard"; T244 spec (quoted in the card)                                   |
| **D5**  | **Q1 is answered: carry coordinates, not a context window.** A trial against a real 1,924-line PR showed the needed context was unpredictable (a spawn call in another hunk, a caller in another file); a bigger payload would only be vaguer.                                 | T257 card, "Q1 — ANSWERED by experiment, 2026-08-28"                                     |
| **D6**  | **Q4 is resolved: a moved head is disclosed, never silently re-anchored.** A silent re-anchor violates "you may only approve what you read". Re-anchor, where offered, is a per-selection gesture with a text fingerprint and falls back to refuse-and-say-why when ambiguous. | T257 card, "Design decision — a moved head re-anchors by content fingerprint, disclosed" |
| **D7**  | Selections and threads render as **a list, never a count or a ratio**. No `3 selections`, no `n/m`, no progress indicator, at any data combination. Tested structurally, to T243 AC-8's standard.                                                                              | T257 card "Constraint"; T243 AC-8                                                        |
| **D8**  | Claude-authored triage (which files matter) is **out**, and nothing here may ship its substrate.                                                                                                                                                                               | T257 card "Not this card"; T248                                                          |
| **D9**  | **Posting a thread to GitHub (U3) is out of this delivery.** It stays on the card for a later wave.                                                                                                                                                                            | T257 card re-plan, 2026-10-20                                                            |
| **D10** | **The transport is the Harnu mod's command channel**: `context.append` for the content and `ui.band.set` for the terminal line. It replaces the PTY-paste and `message_session` candidates.                                                                                    | T257 card re-plan, 2026-10-20; T389 contract §9                                          |
| **D11** | The review-pane scope for this delivery is U1 (selection + highlight) and U2 (delivery + band + chip), as the operator stated it.                                                                                                                                              | Operator, 2026-10-20 (card re-plan)                                                      |
| **D12** | The T245 Tier-1 usage gate ("used for a few real reviews") is lifted by the operator. Recorded so the build is not later read as a skipped gate.                                                                                                                               | T257 card, "Delivery started — 2026-09-10"                                               |

## 5. Decisions this PRD proposes

These are new. Each is argued in the spec; each can be overruled without redoing the others.

| #      | Proposal                                                                                                                                                                 | Why                                                                                                                                                                                                                                                  |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P1** | **Sending is an explicit gesture**, not a side effect of selecting. Selecting is local and free; **Ask about this** is the only thing that reaches the companion.        | D2: "nothing appears that they did not request." It also keeps U1 shippable with no transport.                                                                                                                                                       |
| **P2** | **The send is one non-durable context row, latest-wins.** `durable: false`.                                                                                              | A selection is a moment, not a standing contract. A durable row would be re-injected after every compaction and go stale invisibly.                                                                                                                  |
| **P3** | **The text is built in `main` from git, not accepted from the renderer.** The renderer sends coordinates and SHAs; `main` reads the selected lines at the pinned commit. | The contract says `context.append` text "is built by the host from a closed registry, never caller-supplied" (T389 contract §9). It also makes the quoted lines exactly what is at that commit, whatever the renderer thinks it showed.              |
| **P4** | **Payload = coordinates + the selected lines verbatim (capped) — no hunk header, no surrounding context.**                                                               | D5 says coordinates. The lines are the operator's subject and spare the model a `side`/line-number mistake. The hunk header is git's guess at a function name and would need a second `git diff` in `main`. See spec §6.4 and open question **O-1**. |
| **P5** | **One live selection at a time.** A new selection replaces the old; there is no selection list in this delivery.                                                         | The transport is latest-wins, so a list would show things the companion no longer has. It also makes D7 trivial: nothing to count.                                                                                                                   |
| **P6** | **A moved head clears the live selection with a stated notice; the fingerprint is captured now and consumed by U3.**                                                     | In this delivery a delivered selection stays correct (it carries its own SHAs), so the hazard D6 guards is U3's. Building the re-anchor UI with no consumer is guessing. See **O-2**.                                                                |
| **P7** | **Every refusal has a defined outcome and a way forward; "Copy as text" is the universal one.**                                                                          | Operator memory "Cleanup: no dead ends": a refusal with no path pushes people to workarounds.                                                                                                                                                        |
| **P8** | **Selection state lives in its own store**, `stores/review-selection.ts`, not in `stores/review.ts`.                                                                     | `tests/review-pane-contract.test.ts:122-134` pins `review.ts`'s whole IPC surface, and its header says the pin holds _because that file is short_ (`stores/review.ts:10-12`).                                                                        |

## 6. Non-goals

- **Posting an inline thread to GitHub** (`addPullRequestReviewThread`) — U3, a later wave (D9). The shape is built to make it cheap, nothing more.
- **Claude-authored triage** of which files or lines matter (T248, D8). The companion is told where the operator is looking, never where to look.
- **Any count or total** of selections, threads or sent items (D7). Not as a number, a ratio, a badge, a bar or a tooltip.
- **The reverse path** — `$.ui.selection()`, reading a selection made in the companion's terminal to seed a comment draft. An idea, not scope; it would make the companion's terminal an input to the review surface, which D2 has to be re-argued for.
- **Multiple simultaneous selections**, a selection history, or selections across files (P5).
- **Re-anchoring** a selection on a moved head (P6) — captured, not built.
- **Putting the selection into the companion's system prompt or spawn argv.** The five-scalar corrective (T247) is unchanged; the selection never rides on it.
- **Making the band general.** The band is lifted for the review companion only (spec §8) — not for other spawned sessions.

## 7. What must not regress

These are merged guarantees this delivery touches the edge of. The spec (§11) names the exact test lines and the narrow amendments, each as an operator-signature gate.

- **Harnu never volunteers a message** (T245 AC-4 as amended by T247). A selection send is an operator gesture after spawn, carries no turn, and writes nothing to the composer.
- **Nothing the session emits renders as evidence** (T245 AC-3). The chip shows _the state of the delivery_ in a closed vocabulary — never a word the model wrote.
- **No model call, no agent-produced claim in the pane** (T164 AC-12, `tests/review-pane-contract.test.ts:72-135`).
- **The companion is read-only.** A context row is not a write; the plan-mode argv is untouched.
- **No MCP verb reaches this.** The send is an operator gesture constructed inside one `ipcMain` handler, exactly like T244's submit.

## 8. Open questions for the operator

Everything else in this PRD stands without an answer. These three change what U2 builds.

- **O-1 — payload.** D5 says _coordinates_. P4 adds the selected lines verbatim (capped at 200 lines / 8,000 characters). Recommendation: **keep the lines** — they are exactly what the operator selected and cost nothing to include. If you want strict D5, U2a drops the quoted block and the rest is unchanged.
- **O-2 — moved head.** P6 clears the selection with a notice in this delivery and defers the re-anchor to U3. Recommendation: **accept**. The card's resolution (D6) says selections "survive, with disclosure"; this narrows it to "survive as a delivered record, not as a live anchor" until something can post.
- **O-3 — the channel gate.** `context.append` is not in the contract's observe-only set, and the channel defaults to `shadow` with no UI to change it (spec §7.3). Either **(A)** require `channel: active` — the feature is inert for everyone until that flip ships — or **(B)** a narrow carve-out admitting _only_ this key, from _only_ this gesture, on a `read-only` binding while the channel is in `shadow`. Recommendation: **B**. Both are operator-signature gates because they amend T389 contract §9. Under A the `MODE_SHADOW` outcome is the day-one experience, which is why it has a defined UI.

The spec also flags the other signature gates (§11): the band lift (P4W2 §3), the T245 AC-4 pins, the `review-pane-contract` pins, and T247's blind-companion corrective.

## 9. Acceptance criteria (PRD level)

Per-unit criteria with ids, verify modes and sources are in the spec (§10). At PRD level the delivery is done when:

- **PRD-1** — An operator can select a range of lines or a whole file in the Review diff, see it highlighted in every theme, and clear it. — verify: visual
- **PRD-2** — With a companion open, **Ask about this** delivers the selection as one context row; the companion's next turn can quote its coordinates and lines. — verify: live-verify
- **PRD-3** — The sent / answered chip and the companion's band line are driven by mod events and never show model-authored words. — verify: test
- **PRD-4** — Every refusal the channel can produce has a stated outcome and a next step; none is a silent drop. — verify: test
- **PRD-5** — No count, total or ratio of selections appears anywhere, at any data combination. — verify: test
- **PRD-6** — Every merged guard amended is amended narrowly, by the operator's signature, with its test updated rather than loosened. — verify: review
