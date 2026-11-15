---
name: step-by-step
description: "Walk the operator through a list of manual actions only they can perform — dashboard clicks, commands on a machine the agent cannot reach, secrets to create, DNS to point, a release to cut — one step per message, and record each action as an operator criterion on the relevant Mission step so the list survives the session. Criteria are added with `mission_add_ac` (`by: 'operator'`); the skill reports which remain open and never settles one itself (the operator ticks them in the Mission pane). Use when the operator says '/step-by-step', 'walk me through this', 'guide me step by step', or reacts to a 'pending with you' list by asking how to do it. Do NOT use to resolve decisions (one-by-one), to stress-test a plan (grill-me), for a fixed runbook of a known procedure, or when the agent can run the actions itself — then just do them."
effort: medium
---

# Step by Step

Turns an ad-hoc list of manual actions into a guided runbook **and** into operator
criteria on the mission, so "what is still owed by the operator" is a fact Harnu shows,
not something a chat scrolled past.

**It guides; the operator executes.** The list exists because only they can do these
things. Sister skills: `harnu:one-by-one` drains _decisions_; this drains _actions_.

> Lessons: if a `LESSONS.md` exists in this skill's folder, read it first and apply its rules.

<HARD-GATE>
Never perform a step yourself. Never run anything that changes the world (deploys,
pushes, DNS, secrets, restarts). The only commands you run are read-only checks:
`dig`, `curl`, `gh ... list/view`, `git log`, reading files.
Never tick a criterion. The operator ticks it in the Mission pane; no verb of yours can,
and you never describe a criterion as done because the operator said "done" in chat.
</HARD-GATE>

## The contract

1. **The whole roadmap exists before the first step.** Create every step in the task
   list in one go, numbered. A step found mid-walk is appended and announced.
2. **One step per message. Exactly one.** No preview, no bundling. A failure
   investigation is also one thing per message.
3. **Every message ends in `AskUserQuestion` with four outcomes:** ✅ Done · ❌ Failed
   · ↩ Back one step · ⏭ Skip. Trivial steps included.
4. **A step closes on the operator's ✅ plus your read-only check**, when one exists.
   Silence, "ok" and "it should have worked" never close a step.
5. **Check failed → show the evidence and let the operator decide.** Lock the step
   only when a later step depends on it; otherwise offer _follow anyway_, recorded as
   unverified.
6. **Every manual action is an operator criterion on a mission step** (see
   _Persistence_), added before the walk starts, never ticked by you.

## Phase 0 — Locate the list and the mission

The list, in order: text the operator pasted or pointed at; the most recent message
with the "pending with you" block; the mission's own open operator criteria and
`waiting` (`mission_get`).

Find the mission with `mission_get({ folder, sessionId })` (or `mission_list({ folder })`).
Each manual action lands on the step whose deliverable it belongs to (the DNS record on
the step that ships the tunnel, the secret on the step that needs it). If no mission
exists, or you do not lead it (`mission_add_ac` is the leader's verb), run the walk
anyway, write no criteria, and say so in the first message; offer the `mission` skill
only when the operator wants the list to survive the session.

## Phase 1 — Roadmap (one message)

1. **Extract** atomic steps: one action, one observable result. Split bundles.
2. **Order by dependency.** The source's order is a hint, not the truth.
3. **Read state before asking.** Read-only checks tell you what is already done
   (`gh secret list`, `dig`, a health endpoint). Done steps go in as ✔ with evidence
   and get **no** criterion — nothing is owed.
4. **For each step record** (in the task description, so it survives compaction): the
   action, where it happens, the expected observation, the read-only check (or
   "none"), what it blocks, how to undo it, and the mission step it belongs to.
5. **Add the criteria** — see _Persistence_ — then show the roadmap and stop with an
   `AskUserQuestion` ("Start with 1?" / reorder / something is already done):

```
## Step by step — 8 steps (3 already done ✔) · 5 criteria on the mission
Order follows the dependencies: 1 → 3 → 4, 2 is independent.

1. Create the Access service token — I can't check this one · criterion on "Ship the tunnel"
3. Ingress rule on the VM — I'll check: `curl` from the tunnel hostname · criterion on "Ship the tunnel"
…
✔ 7. Secret DEPLOY_KNOWN_HOSTS — already present (gh secret list)
```

## Phase 2 — Walk the roadmap

One step per message:

```
## Step 3/8 — <short title>   (blocks 4 and 5)

<What to do, imperative, 1–5 lines. A command in a code block, ready to paste, real
values filled in. A dashboard path click by click.>

**Where:** <URL / menu path / machine>
**Observe:** <what must be true for it to have worked>
**I'll check:** <the read-only command> | nothing from here
```

Then `AskUserQuestion` (header `Step N`) with the four outcomes, labels adapted to the
step. A dashboard path you cannot confirm is marked "(path approximate — if the screen
differs, tell me what you see)", never asserted.

- **✅ Done** → run your check. Pass: one line "Done: …", close the task, serve N+1.
  Then tell the operator the criterion is theirs to tick: "tick **<criterion>** on
  <step> in the Mission pane when you are satisfied" — once per step, in one clause.
- **❌ Failed** → failure loop: ask for the error if it is not in the message (one
  question), diagnose from the error text, give **one** correction, re-serve the same
  step. No attempt limit, no list of possible causes.
- **↩ Back** → reopen N−1; if it changed something, lead with how to undo it.
- **⏭ Skip** → stays open as skipped, resurfaces at the end; a dependent step waits.

Text controls: `done` / `next` · `erro: <text>` · `back` · `skip` · `list` · `stop`.
Anything else is a follow-up on the current step.

## Persistence

### One operator criterion per manual action

Load `../mission/references/writing-contract.md` first: Harnu refuses a criterion over 70
characters or under 3 words, and never rewrites it. Right after the roadmap is ordered
(before step 1 is served), read the step with `mission_get`, then add one criterion for
each action that is **not** already ✔:

```json
{
  "folder": "<absolute path of the repo>",
  "missionId": "<mnt-… of the mission>",
  "sessionId": "<your own session id>",
  "stepId": "<stp-n of the step it belongs to>",
  "text": "The Access service token exists",
  "by": "operator"
}
```

- **The text is a fact that is true when the action is done:** no step numbers, no
  dates, no counters — `The Access service token exists`, not `Step 1: token`.
- **Harnu does not dedupe a criterion, and a plan only grows**, so re-running the same
  list must not add twice: read the step's criteria first and add only the ones whose
  wording is not there. Never reword one to "fix" it; if the action truly changed, say
  so and add the new one.
- **Several actions on one step** are several criteria on that step.
- **You can neither edit nor remove a criterion**: an action no longer needed is the
  operator's to deal with in the pane. Once its step starts, it shows under what they owe.

### What you may and may not say about a criterion

You may report a criterion as **open** or **settled**: read it from `mission_get`
(`criteria[].settled` on each step), never from the chat. You may never tick it or "treat
it as done". When the operator says ✅ in chat and the criterion is still open, the step
is closed _for the walk_ but the criterion stays open; say so once.

## Phase 3 — Close out

Re-read the mission (`mission_get`) and end with a `harnu:report-back` checklist: one
line per step with how it was verified, which criteria are still open, then skipped and
unverified items:

```
✅ 1. Access service token — operator ✅ (unverifiable from here) · criterion open
✅ 4. DNS route — dig resolves to the tunnel CNAME · criterion open
⚠️ 5. Rejected without token — operator ✅, my curl got 200 (followed anyway)
⏭️ 6. Host key — skipped
Criteria still open (Mission pane → the step → tick): 1, 4, 5, 6.
Skipped: 6. Unverified: 5. Want cards for them?
```

Offer board cards for skipped items; only offer.

## Red flags

| Thought                                        | Reality                                                          |
| ---------------------------------------------- | ---------------------------------------------------------------- |
| "They said done, I'll mark the criterion"      | You cannot. Say it is theirs to tick.                            |
| "I'll reword the criterion so it's clearer"    | A reworded one is a second criterion. Keep it stable.            |
| "I'll add the criteria as we go"               | Before step 1: the list on the mission is the no-skip guarantee. |
| "I'll just add the whole list again"           | Nothing dedupes it. Read the step first.                         |
| "I'll just run this myself to speed it up"     | If you could, it wouldn't be on the list.                        |
| "Then step 2, which is on the VM…"             | That is a preview. The next step appears when this one closes.   |
| "Three things to diagnose, let me ask for all" | One fact per message.                                            |
