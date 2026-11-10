---
name: your-move
description: 'Tell the operator, in a card they can act on, the moment a turn leaves something only they can unblock. Applies the end-of-turn test, picks one of five kinds (decide, go_no_go, provide, do, check), writes the card so it makes sense with no other context, and files it with the `your_move` verb when that is available. Use at the end of any turn where you stop to ask, park on an approval, hand off a manual step, or hit a blocker nobody else can clear, and whenever a question raised earlier is still open after you moved on to other work. Do NOT use for a tool permission (that stays in the Approval Inbox), for a question you can settle by reading the code or the docs, for work another agent or a running process will finish by itself, or to close or dismiss a card — no agent can.'
effort: low
---

# Your move

The operator runs many sessions and cannot watch them. Harnu keeps one global queue of
**cards**, one per thing that only the operator can unblock, each with a running clock.
This skill makes yours good: the right items, written so the operator can act on them
without opening your session.

## The end-of-turn test

Before you stop, and whenever you notice something is waiting, ask:

> if the operator never comes back, does this still get done?

Walk everything the turn leaves unfinished. If you, another agent or a process that is
already running will finish it, it is not a card. If only the operator can unblock it, it is.

Not a card: waiting on CI or a build you will act on yourself; a question to a worker or a
subagent; an optional extra offered after the requested work is complete ("let me know if you
also want X"); a reviewer's comment you have not been told to relay; something you could have
found out with a search or a file read (do that instead).

A question you raised early is still a card after you moved on. Re-read the turn, not just
its last message.

## The five kinds

Pick the one that matches what the operator has to do. One card per distinct item; two
items make two cards.

- `decide` — choose between options. "Ship PROJ-231 behind the flag or all at once?" with
  `options: ["Behind the flag", "All at once"]` and the one you would pick in `recommended`.
- `go_no_go` — a yes or no to proceed. "Go to delete the 12 stale branches in org/proj/www?"
- `provide` — information or a credential only they hold. "Which Acme sandbox account should
  the integration tests use?" Never ask for the secret itself in a card: ask where it lives.
- `do` — a manual action only they can take: merge, log in, press a button, test on a
  device. "Merge PR #305, then tell me so I can rebase PROJ-232."
- `check` — look at something and confirm it is right. "Open the staging page and confirm
  the new empty state reads correctly."

## Write a self-contained card

A self-contained card makes sense to an operator with no memory of your session. Say what is being asked, in one
line, in the language the session uses.

- Never "D-9 is unanswered". Always what D-9 is: "Should the Acme export keep the legacy
  column order?"
- Put what stays stuck in `blocks`: "PROJ-231 cannot ship until this is answered".
- For a `decide`, give `options` (at most 6, short) and `recommended` (it must be one of
  them). Say what each costs in the `ask` or `blocks` when it is not obvious.
- No paths to a plan file, no "see above", no ticket keys without their title.

## When to call `your_move`

If the `your_move` verb is available, call it the moment you know the ball is the
operator's — mid-turn, do not wait for the end:

```
your_move({
  folder: "/org/proj/www",
  sessionId: "<your own session id>",
  kind: "decide",
  ask: "Ship PROJ-231 behind the flag or all at once?",
  blocks: "PROJ-231 stays unmerged until this is answered",
  options: ["Behind the flag", "All at once"],
  recommended: "Behind the flag"
})
```

- The ACK returns `cardId`. If the same item changes (new facts, a sharper question), call
  again with that `cardId` to refresh the card in place: its clock keeps running.
- Without `cardId` a new card is filed. Do not re-file the same item; refresh it.
- `YOUR_MOVE_OFF` means Your move is off for this install or this folder: nothing was filed
  and retrying will not help. Say what you need in your reply instead.
  `YOUR_MOVE_RATE_LIMIT` means you filed 30 cards this hour: say it in your reply.
- `your_move` cannot close a card, and nothing else you can call does either. A card leaves
  when the operator deals with it (an answer typed in the session, a button on the card) or
  when its source is resolved. Do not tell the operator a card is closed.

## Reply as well

A card is not a substitute for the message. End the turn with the question in plain words
too, so a person reading the transcript sees what you see.

## What guarantees a card

The judge, not this skill. Harnu inspects every turn that stops on its own: two detector
runs plus an enrichment call read what the turn left behind and file a card for what only the
operator can unblock, whether or not this skill is on or `your_move` is called. This skill
and the verb improve the quality of the card — a better ask, the right kind, a recommendation,
filed earlier — they are not what makes sure the operator hears about it. If you are unsure
whether something is a card, say it clearly in your reply and let the judge decide.
