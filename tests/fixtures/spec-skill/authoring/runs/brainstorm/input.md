# Brainstorm output — archive the idle sessions of a folder

_The output of a `brainstorming` session (one question per turn, no code), as it reached
`/harnu:spec`. Written for this fixture; the feature does not exist in Harnu today._

## Objective

Put a folder's finished sessions away in one click instead of archiving them one row at a time.

## What was asked

- A folder's menu gets one action that archives every idle session in that folder.
- A session that is working, or that has an approval waiting, is left alone.
- A toast says how many sessions were archived and how many were left alone, with Undo.
- Undo restores exactly the sessions that action archived, nothing else.

## Answers given during the brainstorm

- "Idle" means what the sidebar's own Archive allows: not working, nothing waiting on me.
- Only the folder I clicked; a worktree has its own menu.
