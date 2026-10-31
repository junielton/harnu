---
name: step-by-step
description: "Walk the operator through a list of manual actions only they can perform — dashboard clicks, commands on a machine the agent cannot reach, secrets to create, DNS to point, a release to cut — one step per message, and record each action as a human check on the relevant Mission step so the list survives the session. Checks are added with `mission_add_check`, deduped by label; the skill reports which remain unticked and never ticks one itself (only the operator can). Use when the operator says '/step-by-step', 'walk me through this', 'me guia passo a passo', 'passo a passo isso', or reacts to a 'pending with you' list by asking how to do it. Do NOT use to resolve decisions (one-by-one), to stress-test a plan (grill-me), for a fixed runbook of a known procedure, or when the agent can run the actions itself — then just do them."
effort: medium
---

# Step by Step

Turns an ad-hoc list of manual actions into a guided runbook **and** into checks on
the mission, so "what is still owed by the operator" is a fact Harnu shows, not
something a chat scrolled past.

**It guides; the operator executes.** The list exists because only they can do these
things. Sister skills: `harnu:one-by-one` drains _decisions_; this drains _actions_.

> Lessons: if a `LESSONS.md` exists in this skill's folder, read it first and apply its rules.

<HARD-GATE>
Never perform a step yourself. Never run anything that changes the world (deploys,
pushes, DNS, secrets, restarts). The only commands you run are read-only checks:
`dig`, `curl`, `gh ... list/view`, `git log`, reading files.
Never tick a check. Ticking is the operator's door; no verb of yours can do it, and
you never describe a check as done because the operator said "done" in chat.
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
6. **Every manual action is a check on a step** (see _Persistence_) — created before
   the walk starts, never ticked by you.

## Phase 0 — Locate the list and the mission

The list, in order: text the operator pasted or pointed at; the most recent message
with the "pending with you" block; the mission's own open checks and `youItems`
(`mission_get`).

Find the mission with `mission_get({ folder, ownerSessionId })` (or `mission_list`).
Read its `steps` — each manual action must land on the step whose deliverable it
belongs to (the DNS record on the step that ships the tunnel, the secret on the step
that needs it). If no mission exists, run the walk anyway, write no checks, and say
so in the first message; offer to create the mission with `mission_create` only when
the operator wants the list to survive the session.

## Phase 1 — Roadmap (one message)

1. **Extract** atomic steps: one action, one observable result. Split bundles.
2. **Order by dependency.** The source's order is a hint, not the truth.
3. **Read state before asking.** Read-only checks tell you what is already done
   (`gh secret list`, `dig`, a health endpoint). Done steps go in as ✔ with evidence
   and get **no** check — nothing is owed.
4. **For each step record** (in the task description, so it survives compaction): the
   action, where it happens, the expected observation, the read-only check (or
   "none"), what it blocks, how to undo it, and the mission step it belongs to.
5. **Write the checks** — see _Persistence_ — then show the roadmap and stop with an
   `AskUserQuestion` ("Start with 1?" / reorder / something is already done):

```
## Step by step — 8 steps (3 already done ✔) · 5 checks on the mission
Order follows the dependencies: 1 → 3 → 4, 2 is independent.

1. Create the Access service token — I can't check this one · check on Step 3 of 5
3. Ingress rule on the VM — I'll check: `curl` from the tunnel hostname · check on Step 3 of 5
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
  Then tell the operator the check is theirs to tick: "tick **<label>** on Step N of M
  in the Mission popover when you are satisfied" — once per step, in one clause.
- **❌ Failed** → failure loop: ask for the error if it is not in the message (one
  question), diagnose from the error text, give **one** correction, re-serve the same
  step. No attempt limit, no list of possible causes.
- **↩ Back** → reopen N−1; if it changed something, lead with how to undo it.
- **⏭ Skip** → stays open as skipped, resurfaces at the end; a dependent step waits.

Text controls: `done` / `next` · `erro: <text>` · `back` · `skip` · `list` · `stop`.
Anything else is a follow-up on the current step.

## Persistence

### One check per manual action

Right after the roadmap is ordered (before step 1 is served), add one check per step
that is **not** already ✔:

```
mission_add_check({ folder, missionId, stepId: "<the step it belongs to>", label: "<label>" })
```

- **The label is the action, stable and specific:** imperative, no step numbers, no
  dates, no counters — `Create the Access service token (Cloudflare)`, not
  `Step 1: token`. Reordering or re-running must produce the _same_ label, because
  the verb dedupes by label (case-insensitive, whitespace collapsed, ≤200 chars).
- **Re-running with the same list adds nothing.** A deduped call comes back
  `deduped: true`; the first creator's check stands. Do not "fix" a label by changing
  it a little — that creates a second check. If the action truly changed, say so and
  add the new label.
- **Several actions on one step** are several checks on that step.
- **Never delete or edit a check.** You cannot, and an action the operator no longer
  needs is theirs to delete in the popover.
- A check never moves the step or the headline — it is the operator's to-do, shown
  under **You**. That is the point.

### What you may and may not say about a check

You may report a check as **open** (unticked) or **ticked** — read it from
`mission_get` (`steps[].checks[].ticked`), never from the chat. You may never tick,
untick or "treat as done". When the operator says ✅ in chat and the check is still
unticked, the step is closed _for the walk_ but the check stays open; say so once.

## Phase 3 — Close out

Re-read the mission (`mission_get`) and end with a `harnu:report-back` checklist: one
line per step with how it was verified, which checks are still unticked, then skipped
and unverified items:

```
✅ 1. Access service token — operator ✅ (unverifiable from here) · check open
✅ 4. DNS route — dig resolves to the tunnel CNAME · check open
⚠️ 5. Rejected without token — operator ✅, my curl got 200 (followed anyway)
⏭️ 6. Host key — skipped
Checks still unticked (Mission popover → the step → tick): 1, 4, 5, 6.
Skipped: 6. Unverified: 5. Want cards for them?
```

Offer board cards for skipped items; only offer.

## Red flags

| Thought                                        | Reality                                                           |
| ---------------------------------------------- | ----------------------------------------------------------------- |
| "They said done, I'll mark the check"          | You cannot. Say it is theirs to tick.                             |
| "I'll reword the label so it's clearer"        | A new label is a second check. Keep it stable.                    |
| "I'll add the checks as we go"                 | Before step 1 — the list on the mission is the no-skip guarantee. |
| "I'll just run this myself to speed it up"     | If you could, it wouldn't be on the list.                         |
| "Then step 2, which is on the VM…"             | That is a preview. The next step appears when this one closes.    |
| "Three things to diagnose, let me ask for all" | One fact per message.                                             |
