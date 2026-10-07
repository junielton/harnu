# T389 delivery verification

Verifier: independent session, 2026-10-02. Branch `docs/t389-companion-mod-specs`.
_Historical record: the branch name, commit ids and file counts below are from the pre-rename repository (those commits are not in this repository); the epic card's board slug (`T389-t389-capy-companion-mod-…`) is kept as it appears on the maintainer's local board._
Nothing was edited, committed, pushed or merged except this file.

## Hygiene commands

| Command                                                                                                   | Result                                                                                    |
| --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `git log --oneline -6`                                                                                    | 5 T389 commits (`f8b99cb1`, `e8ed8c60`, `ad17ebf7`, `479f5a53`, `1509bcbe`) on `ab844b1e` |
| `git status --porcelain`                                                                                  | empty (clean) before this report was written                                              |
| `npx vitest run tests/no-client-identifiers.test.ts`                                                      | `PASS (4) FAIL (0)`                                                                       |
| `npx prettier --check docs/specs/T389-companion-mod docs/plans/T389-companion-mod docs/reports/T389-*.md` | `All files formatted correctly` (run before this report was added)                        |

## Clause 1: documents committed on the branch: met

`git ls-files` on the branch shows all of these tracked:

- Study and evidence: `docs/studies/T389-claude-mods-x-harnu.md` (233 lines), `docs/studies/T389-smoke-evidence.md` (1617 lines).
- ADR: `docs/adr/0018-harnu-mod-as-integration-substrate.md`.
- Specs: `00-master.md`, `01-contract.md`, and 19 wave files (`git ls-files … | grep -c '/P[1-5]W[0-9]-'` = 19): P1W1–W6, P2W1–W5, P3W1–W2, P4W1–W5, P5W1.
- Plans: `00-master-plan.md`, `P1-sensor.md`, `P2-actuator.md`, `P3-approval.md`, `P4-surface-and-governance.md`, `P5-retirement.md`.
- Reports: `T389-spec-review-a.md`, `T389-spec-review-b.md`, `T389-plan-review.md`.

## Clause 2: reviewer reports show zero open blocking findings: met

Each report ends with `Blocking findings open: 0` (spec-review-a line 150, spec-review-b line 184, plan-review line 86).
The reports list BLOCKING findings RA_1–RA_7, RB_1–RB_4 and RP_1–RP_5, all marked fixed.
Findings left open are only MINOR/NOTE (e.g. RB_12, RB_13, RB_15, reported and left).

### Spot-check of fixed blocking findings (11 checked, all landed)

| Finding | Claimed fix                                                       | Evidence in the named document                                                                                                                                     | Landed |
| ------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| RA_1    | `listenerWanted()` seam; AC-P1W1-34                               | `P1W1-host-server.md`: 3 hits for `listenerWanted`, 1 for `AC-P1W1-34`; `00-master.md`: 1 hit                                                                      | yes    |
| RA_3    | `computeEnable` returns `[]` when the mode is `off`; AC-P1W4-30   | `P1W4-arbitration-and-rollout.md`: `AC-P1W4-30` present; row 412 (`enable: []`) and row 451 (kill switch, re-hello answered `enable: []`)                          | yes    |
| RA_4    | generic `markProven` rule; AC-P2W1-34                             | `P2W1-command-channel.md`: `AC-P2W1-34` present                                                                                                                    | yes    |
| RA_5    | `dropped`/`delivered:false` goes to `legacy`; AC-P2W2-29          | `P2W2-start-prompt.md`: `AC-P2W2-29` present                                                                                                                       | yes    |
| RA_6    | gate rows and cause mapping; AC-P2W4-32                           | `P2W4-live-contract-and-guard.md`: `AC-P2W4-32` present                                                                                                            | yes    |
| RA_7    | AC-P2W5-25 settles CQ16 / OQ4                                     | `P2W5-mcp-attribution.md`: 2 hits for `AC-P2W5-25` (definition plus the OQ4 pointer)                                                                               | yes    |
| RB_1    | one hooks module per plugin                                       | `P4W2-terminal-band-and-commands.md` line 92: `modules: ["./register.ts"]`, one module only; study line 54 records the reproduced `claude plugin validate` refusal | yes    |
| RB_2    | active-turn test reads `fleet.activeTurnId`, not `channel.turnId` | `P4W4-resume-micro-plan.md` lines 157 and 172–173                                                                                                                  | yes    |
| RP_1    | P4W2 no longer rebases onto an unmerged P4W3                      | no `rebase P4W3` string remains in `docs/plans/T389-companion-mod/`                                                                                                | yes    |
| RP_3    | P4W2 creates the `ask($, req)` client                             | `P4-surface-and-governance.md` line 126: "this wave creates it"                                                                                                    | yes    |
| RP_5    | executors never merge                                             | `00-master-plan.md` line 221: a "merge only after…" packet is "a condition the operator checks, not a permission"; line 17 "never merges"                          | yes    |

## Clause 3: study verdicts with smoke references: met

- The study states the rule at lines 18–20 and adds a "Live verdict" column to the cross table (header line 81, columns "Verdict" and "Live verdict").
- All 12 cross-table rows (1–6, 6b, 7–11) carry a verdict and a smoke reference. Examples: row 1 PARTIAL (B1), row 6 REFUTED (C3), row 8 CONFIRMED (C1), row 11 PARTIAL (A2), row 7 CONFIRMED (A1).
- All 7 "new things" items carry a `Live verdict:` line with references. Items 1–7 are PARTIAL (C2/A2), PARTIAL (D2), CONFIRMED (C4/C5), CONFIRMED (D4), CONFIRMED (D5), PARTIAL (B1), CONFIRMED/PARTIAL (D7/A3).
- Risks that a smoke test could check carry verdicts too: lines 186, 190, 194, 202, 206, 210. The trust item is UNTESTED as a claim (D6/D13).
- The smoke references used (A1–A4, B1.x, B3–B6, C1–C5, D1–D7) all exist in `T389-smoke-evidence.md` (each id appears at least twice there).

## Clause 4: wave cards on the board: met

- `.harnu/memory/roadmap/T397-*.md` (the maintainer's local board, gitignored and not tracked in this repository) … `T415-*.md`: 19 files, one per number (confirmed by listing T397–T405 and T406–T415 separately).
- Each card names its spec path under `docs/specs/T389-companion-mod/`, and every referenced spec exists on the branch (a loop over all referenced paths printed no `MISSING`).
- Frontmatter `parent: T389-t389-capy-companion-mod-claude-mods-as-the-integration` on 19 of 19 cards (`grep -l '^parent: *T389'` = 19).
- Card-to-spec mapping verified: T397 P1W1, T398 P1W2, T399 P4W1, T400 P1W3, T401 P1W4, T402 P1W5, T403 P1W6, T404 P2W1, T405 P4W3, T406 P2W2, T407 P4W2, T408 P2W5, T409 P2W3, T410 P2W4, T411 P4W4, T412 P3W1, T413 P4W5, T414 P3W2, T415 P5W1.

## Caveats (not blocking)

- The rtk proxy mangled some `ls` and `grep` output during verification, so counts were re-derived with `git ls-files`.
- Verification covers document consistency and presence only. The designs themselves have not been implemented or run.
- The study marks some mechanisms PARTIAL or REFUTED (e.g. a single held `$.http.fetch` hard-aborts at 30 s). That is recorded honestly in the study and the specs adapt to it, so it is not a defect of the delivery.

Overall: met
