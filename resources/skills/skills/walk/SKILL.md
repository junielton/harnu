---
name: walk
description: "Open a guided walk in Harnu's walk pane: the operator checks or learns something one check at a time, you write the whole script once and run only read-only checks. Use when the operator says '/walk', '/harnu:walk', 'walk me through what we just built', 'walk me through this PR', 'test PR #48 with me', 'test this with me', 'let's test it together', 'guide me through testing this', 'check these acceptance criteria with me', or the same sentence in their own language. The source is your own work, a PR, a branch, a card or a mission; ask one question only when you cannot tell which. Also offers a walk once, in one line, when a feature is finished. Do NOT use to resolve decisions (one-by-one), to stress-test a plan (grill-me), for a fixed runbook of a known procedure, or when you can run the actions yourself, then just do them."
effort: medium
---

# Walk

A **walk** is a list of checks only the operator can do by hand: to test something you built, to learn
how it works, to hand-check a PR, a card or a mission's criteria. The operator walks it in a fixed pane,
one check at a time. **You write the whole script once; the pane serves it; you answer its
`[harnu-walk]` turns.** The walk belongs to the repo, not to a mission: a mission is one source among five.

**The full contract is `references/panel-contract.md`. Read it before you write the script.** It holds
the HARD-GATE, every rule of `step-by-step`, the persistence rules and the red flags, so nothing here
depends on which copy of `step-by-step` the session has.

<HARD-GATE>
Never perform a step yourself. Never run anything that changes the world. The only commands you run
are read-only checks. Never ask for a secret. Never tick or settle a criterion yourself. No walk verb
performs, presses or settles anything: the operator's clicks are theirs.
</HARD-GATE>

With a mission source, set `criterion` on every check that answers a criterion of the mission. When the
walk closes, Harnu settles each open `operator` criterion whose check closed on two signals: the
operator's Done and your `pass`. Nothing else settles, so never promise it.

## What to do

1. **Pick the source** from what you were told, in this order: the work you just did (`feature`), a PR
   number (`pr`), a branch (`branch`), a card (`card`), a mission (`mission`), a pasted list of manual
   actions (`feature`). You hold the context, so you read it yourself (your diff, your own `gh`, the
   card, `mission_get`). Ask **one** question only when you cannot tell which source is meant.
2. **Ask `walk_get({ folder, source })` before you write.** If the source already has a walk, say so in
   one line ("this PR already has a walk, 4 of 6 passed") and point at the Walks library instead of
   writing a duplicate.
3. **Write the script and call `walk_open` once.** Every check, every link as far as you have checked
   it, every expected value quoted, every pre-check proven. Pass your own `sessionId`. If it is
   refused, fix every violation it lists and call it again.
4. **Say in one line what you did**: that the walk is open in the folder's helper stack, or, when the ACK
   says `opened: false`, only that it is saved. Then stop: the next move is the operator's.
5. **Act only on `[harnu-walk]` turns**: run the read-only check and `walk_report`, give one correction,
   `walk_extend` for Explain more and "I didn't get this step", act on an escalation, and at the
   close-out answer in at most three lines of offers.

Only a **mission** source writes anything to a mission, and only the leader's `mission_add_ac`, before the
walk opens. Any other source writes nothing to any mission.

## Offer a walk when a feature is done

Once per finished feature, never for a trivial change (a typo, a rename, a one-line fix), and never
starting one on your own: ask in one line through `AskUserQuestion` with exactly three options, **Walk me
through it** (a `learn` walk), **Test it end to end** (a `check` walk) and **Not now**. "Not now" snoozes
the offer for that feature in your own context; do not ask again for it. A session with this skill off
never offers. The offer is the only time this skill uses `AskUserQuestion`: a served check is never
answered through a dialog.

## References

- `references/panel-contract.md`: the contract, the sources, the script, the turns, the persistence
  rules and the red flags.
