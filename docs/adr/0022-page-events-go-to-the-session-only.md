# ADR-0022 — Browser-page events go to the owning session only; mods subscribing to them directly is deferred

**Status:** Accepted (approved by the operator, 2026-10-21; conditions to revisit below)
**Date:** 2026-10-21
**Author:** agent (T565, design card for T564)
**Technical context:** `docs/specs/2026-10-21-T564-browser-pane.md` (§5.4, §8.5, §8.7), `docs/prds/T564-browser-pane.md`, ADR-0018, ADR-0019, ADR-0020, `docs/user/mods.md`

---

## 1. Context

The browser pane has two ways for a page to talk back to Harnu:

- the **point-and-comment overlay** — the operator picks a node and types a request (`[harnu-comment]`);
- **`harnu.emit(event)`** — a page that Harnu serves (`harnu-page://`) reports something the operator did in
  it, such as pressing "Approve" on a panel (`[harnu-page-event]`).

Both are delivered to a session as a **user turn**. Claude Code mods and Scheduler workers also write to
panes (they use the same `browser_*` verbs). It is natural to ask whether a mod should be able to **subscribe**
to those events instead of, or as well as, the session. The question has teeth because of what the substrate
looks like today:

1. **Mods are not an authority boundary.** ADR-0019 states that the `harnu` mod's filters are a speed bump,
   not a boundary, that mods share the session's MCP access, and that attribution of a mod's call lags. The
   wire cannot tell a mod from a session, and `sessionId` is self-declared (ADR-0013).
2. **A subscription is a read channel with no audit.** A verb call is a request/response Harnu logs. A
   subscription would push operator-originated data to any installed mod continuously, and nothing in the
   current mod model says what a mod may do with it.
3. **A page event is a user turn by design.** The session receives it with the operator's authority attached
   to its marker. A second consumer that can act on the same event, concurrently, multiplies the surface a
   hostile page can aim at.
4. **There is no use case that needs it today.** Every scenario on the T564 card — preview, live panel,
   dev-server verification, comment-to-session — ends in a session. A mod that wants to react to a page can
   already be told by that session.

## 2. Decision

**Page events go to the owning session and nowhere else. Mods cannot subscribe to them directly. A mod that
needs one is told by a session (through its own verbs), not by Harnu.**

- **D-1 — One consumer per event.** `[harnu-comment]` and `[harnu-page-event]` are delivered to the pane's
  owner session; an operator-opened pane with no owner delivers to the folder's selected session; with
  neither, the event is held on the pane and the operator is told (spec §5.4, §8.7). There is no fan-out.
- **D-2 — No new channel for mods.** Mods and workers use the existing `browser_*` verbs, over the existing
  door (decision 4). There is no socket, HTTP endpoint, event bus or `$.harnu` method that streams page events
  to a mod. No `harnu.onPageEvent` is added to the SDK noun (ADR-0019).
- **D-3 — The authority split stays with the session path.** `[harnu-comment]` is the operator speaking;
  `[harnu-page-event]` is data, never instructions, and accepted only after a real user gesture in the page
  with no agent input around it. A direct subscriber would need its own answer to both, and none exists
  (spec §5.4, §8.5).
- **D-4 — Mods may still write.** Deferring subscription does not remove a mod's ability to open, patch and
  `setData` a panel through the verbs, under the same tiers as a session (spec §7.3). A mod's writes carry the
  same attribution caveat ADR-0019 records.

## 3. Alternatives considered

| Option                                                 | Why not (today)                                                                                                                                                                                                                                          |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Mods subscribe through a new MCP-side stream**       | MCP verbs here are request/response; there is no server push, and adding one for mods only is a second transport (ADR-0019 chose one door). A poll verb (`browser_events`) would turn every event into a read any writer may drain, including a worker.  |
| **Fan out to the session and to subscribed mods**      | Two consumers of a user-authority event. If a mod acts on `harnu.emit` while the session also does, the operator sees two reactions to one click and neither knows about the other. A hostile page gets two targets for one gesture.                     |
| **A new `$.harnu.onPageEvent` on the SDK noun**        | ADR-0019 deliberately limited the command channel to host → mod notification with no data. Streaming page payloads into a mod reverses that rule and would need its own ADR plus an attribution story the noun does not have.                            |
| **Let the page post directly to a mod's endpoint**     | Hands an external or agent-authored page a network path out of the guest, which the guest hardening forbids (spec §3, §4.3).                                                                                                                             |
| **Do nothing special; let mods read the sidecar file** | Not rejected, merely outside the decision: a mod can already read `.harnu/out/browser/state/*.json` through its own file access. That is `setData` state, not events, and it is polling the page's own data, not subscribing to the operator's gestures. |

## 4. Consequences

- **A mod that wants to react to a click cannot.** The workaround is explicit and visible: the session
  receives the `[harnu-page-event]` and can call a mod's verb, or update a panel. This keeps one consumer
  and one transcript of what happened.
- **The `harnu` SDK noun stays smaller.** No event method is added, so ADR-0019's surface, drift manifest
  and `api-surface.json` do not grow because of this card.
- **No new audit gap.** Every consumption of a page event is a session turn, which Harnu already records
  (an Activity row and an audit entry with batch size and destination, never the text).
- **A busy or parked owner still receives it,** queued between turns or after a headless wake (spec §8.7),
  so "session only" does not mean "lost when the session is idle".
- **Reversible without migration.** Adding subscribers later is purely additive: new verb or noun method, new
  ADR, no change to the session path. The event payload shapes (spec §5.4, §8.3) are already versioned
  by the marker line, so a new consumer reads the same data.
- **The user-docs and awareness text must say so.** The agent-facing note in `docs/harnu-features.md` states
  that page events arrive as turns in the owner session and that there is no subscription; the Mods page
  does not promise one.

## 5. Conditions to revisit

Re-open this decision, with a new ADR, if **any** of these becomes true:

1. **A concrete mod use case exists that a session cannot serve** — for example, a mod that must react while
   no session is running, or one that must see events from panes it did not open. Until a real one is named
   on a card, the answer to "should a mod hear this?" is "ask the session".
2. **Mods gain an authority boundary.** The CLI offers authenticated host channels or isolation between
   mods, so the companion can carry authority and not just correlation (ADR-0019's own revisit condition), or
   Harnu's MCP server gains per-session identity (ADR-0013 changes). Then a subscription can be scoped to a
   known consumer.
3. **The command channel's host → mod, no-data rule is relaxed** by its own ADR (ADR-0019 D3), giving page
   events a sanctioned way into a mod.
4. **Attribution for mod calls ships** (the audit can say which mod made a call, ADR-0019 P2W5), so a
   subscriber's actions on an event would be traceable to it.
5. **The gesture gate is proven unforgeable** — the spike results for assumptions A1 and A2 (spec §13) show a
   page event can be attributed to a real operator gesture with no residual agent-input race (the U0 results show
   that for keyboard input only, not for pointer input, spec §5.4) — and the
   operator wants unattended reactions to such events, which would then need an explicit, per-mod opt-in.

Any revisit must answer, in the new ADR: who receives the event, what authority it carries, what the page
can do to the consumer, how it is audited, and how the operator turns it off.
