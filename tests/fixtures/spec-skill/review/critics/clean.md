# Goldfish review

Author model: opus · reviewer model: sonnet
Persona files are read by a general-purpose sub-agent, so `CLAUDE.md` may reach the reviewer (D-9).

## Reviewers

| reviewer      | round | model  | status                          |
| ------------- | ----- | ------ | ------------------------------- |
| comprehension | 1     | sonnet | ran                             |
| critic        | 1     | sonnet | not run — the sub-agent errored |
| critic        | 2     | sonnet | ran                             |
| readiness     | 1     | sonnet | ran                             |

## Findings

| id  | reviewer      | severity | finding                                        | disposition  | evidence                                                         |
| --- | ------------- | -------- | ---------------------------------------------- | ------------ | ---------------------------------------------------------------- |
| F-1 | comprehension | Major    | The paraphrase says the badge counts messages. | fix          | R-1 now says sessions; the AC-1 statement names sessions.        |
| F-2 | critic        | Major    | Nothing proves the badge resets.               | contest      | AC-2's proof `test:tests/badge-count.test.ts::resets` covers it. |
| F-3 | critic        | Nit      | The repo group header could show a badge too.  | decline NG-1 | Out of scope for this request.                                   |
| F-4 | readiness     | Blocker  | S-1 leaves the hibernated-session rule open.   | escalate D-1 | Asked as D-1; S-1 is gated by it.                                |
