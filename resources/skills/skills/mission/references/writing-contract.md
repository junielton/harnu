# The writing contract

Every title, criterion, ask and blocker you write is read by someone tired, across several sessions, who was not in the session that wrote it. A line that looks like noise gets skipped. Write for that reader.

Harnu refuses text over a cap or breaking a checkable rule, and says which rule and how long the text was. Harnu never cuts or rewrites your text: you write the shorter or clearer one.

## Rules of thumb

| Rule                                                     | Instead of                           | Write                                                                                                                  |
| -------------------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Zero context: no word the reader must look up            | "Build the bake-off harness"         | "A tool that scores a spec"                                                                                            |
| A milestone is named for what becomes true               | "Measuring stick and holdout corpus" | "A test set we can trust"                                                                                              |
| A step starts with a verb                                | "Runner CLI"                         | "One command to run a round"                                                                                           |
| The next step says what to do and what it unlocks        | "Approve spec"                       | "Approve the plan for the scoring tool" and "9 finished steps wait for it."                                            |
| A blocker shows the exact thing needed, never a label    | "Blocked on env"                     | "This machine doesn't know where the private test files are. Set HARNU_CORPUS_DIR to their folder and the run starts." |
| A criterion is a fact that is true when it is done       | "Verifier gate"                      | "Every reviewer question has an answer"                                                                                |
| States in words people say                               | "in review", "driver"                | "waiting for review", "leads the mission"                                                                              |
| Ids and numbers go to the side, dimmed                   | "T685 E2E round"                     | the name, with `#256` at the right                                                                                     |
| One line each; numbers only where they answer a question | counts everywhere                    | the count lives in the progress bar                                                                                    |

## Caps

In characters, enforced on every write. They are not applied when a record is read.

| Field       | Cap | What it limits                           |
| ----------- | --- | ---------------------------------------- |
| `mission`   | 60  | the mission title                        |
| `milestone` | 45  | a milestone title                        |
| `step`      | 50  | a step title                             |
| `ask`       | 90  | what the operator is asked to do         |
| `why`       | 60  | what it unlocks (a blocker's `unblocks`) |
| `criterion` | 70  | one criterion                            |
| `button`    | 16  | a button label                           |

## Checkable rules

Exactly these five. The verbs refuse text that breaks one.

| Rule                                                                                                                                                                               | Refused                                        | Accepted                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| An id or number is not the start or end of a title: `T685`, `#256`, `PROJ-231`, `stp-3`, `mls-2`, in parentheses or not                                                            | `T685 E2E round`, `Load the test files (#256)` | `Run the tool on the whole test set`                                                                                   |
| A criterion has at least 3 words                                                                                                                                                   | `Done`, `Gate green`                           | `Every reviewer question has an answer`                                                                                |
| A blocker reason has at least 6 words and one exact reference: an ALL-CAPS name of 4 or more characters, a backticked token, a path, a URL, a #number, a quoted string or a number | `Blocked on env`, `Waiting for the thing`      | `This machine doesn't know where the private test files are. Set HARNU_CORPUS_DIR to their folder and the run starts.` |
| Internal words are refused anywhere in a title, ask, why or criterion: `needs-human`, `self-verified`, `radiant`, `declared end`, `fixed end`                                      | `Second pass, self-verified`                   | `A second session checked it`                                                                                          |
| A milestone or step title is never only a state word: `in review`, `blocked`, `done`, `running`, `to do`, `driver`                                                                 | `In review`                                    | `Review the scoring plan`                                                                                              |

The list is closed: a word is added only by an amendment to the spec, so honest text is not refused by a growing list.
