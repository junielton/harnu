---
name: doc-reader
description: Docs only. Refuses a whole read of a documentation file over the folder's line threshold (350 by default) and sends the question to a Haiku doc-reader agent, so only the answer enters the main model's context. Measured at -63% cost with no quality loss.
---

# doc-reader (bundled feature)

Not a skill: nothing in this file is staged. It is the Settings → Skills entry for a feature
made of two staged parts.

- `agents/doc-reader.md`, a Haiku subagent (`Read, Grep, Glob`) the session sees as
  `harnu:doc-reader`.
- A `PreToolUse` hook (matcher `Read|Bash`) of `type: "http"` that `bundled-skills.ts` writes at
  staging time, pointing at the running Harnu's Hook Bridge. The bridge runs `decideDocRead`
  (`src/main/doc-reader/gate-core.ts`). When Harnu is not running the POST fails and the read goes
  ahead.

Never staged into a Scheduler `observe` tick or a steward: they have no `Agent` tool, so a refused
read would strand them. Evidence: `docs/studies/T1-doc-reader-spike.md`.
