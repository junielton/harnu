# Goldfish review

## Reviewers

| reviewer      | round | model  | status |
| ------------- | ----- | ------ | ------ |
| comprehension | 1     | sonnet | ran    |
| critic        | 1     | sonnet | ran    |
| readiness     | 1     | sonnet | ran    |

## Findings

| id  | reviewer  | severity | finding                                       | disposition  | evidence             |
| --- | --------- | -------- | --------------------------------------------- | ------------ | -------------------- |
| F-1 | critic    | Major    | Nothing proves the badge resets.              | —            |                      |
| F-2 | readiness | Blocker  | S-1 leaves the hibernated-session rule open.  | escalate D-7 | Asked as a decision. |
| F-3 | critic    | Nit      | The repo group header could show a badge too. | decline NG-9 | Out of scope.        |
| F-4 | critic    | Nit      | The title is vague.                           | ignore       | Not worth it.        |
