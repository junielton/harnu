# Bake-off report: 20261109-230156

- split: dev
- status: done
- dryRun: true
- models.contestant: claude-haiku-5-5
- models.operator: claude-haiku-5-5
- models.judge: claude-haiku-5-5
- pins.harnu-spec: e03f1636a93e3e162b65650a32eaf8b703b7bb10

## Hidden-test pass rate (%)

| problem       | contestant | r1     | mean   | spread |
| ------------- | ---------- | ------ | ------ | ------ |
| slugify-basic | harnu-spec | 100.00 | 100.00 | 0.00   |
| (summary)     | harnu-spec |        | 100.00 | 0.00   |

## Coverage (% of atoms, judge mean)

| problem       | contestant | r1     | mean   | spread |
| ------------- | ---------- | ------ | ------ | ------ |
| slugify-basic | harnu-spec | 100.00 | 100.00 | 0.00   |
| (summary)     | harnu-spec |        | 100.00 | 0.00   |

## Decisions left to the implementer (judge mean)

| problem       | contestant | r1   | mean | spread |
| ------------- | ---------- | ---- | ---- | ------ |
| slugify-basic | harnu-spec | 4.00 | 4.00 | 0.00   |
| (summary)     | harnu-spec |      | 4.00 | 0.00   |

## Contradictions (judge mean)

| problem       | contestant | r1   | mean | spread |
| ------------- | ---------- | ---- | ---- | ------ |
| slugify-basic | harnu-spec | 1.00 | 1.00 | 0.00   |
| (summary)     | harnu-spec |      | 1.00 | 0.00   |

## Executable-proof share (judge mean)

| problem       | contestant | r1   | mean | spread |
| ------------- | ---------- | ---- | ---- | ------ |
| slugify-basic | harnu-spec | 1.00 | 1.00 | 0.00   |
| (summary)     | harnu-spec |      | 1.00 | 0.00   |

## Builder guesses (judge mean)

| problem       | contestant | r1   | mean | spread |
| ------------- | ---------- | ---- | ---- | ------ |
| slugify-basic | harnu-spec | 5.00 | 5.00 | 0.00   |
| (summary)     | harnu-spec |      | 5.00 | 0.00   |

## Assumptions logged (builder)

| problem       | contestant | r1    | mean  | spread |
| ------------- | ---------- | ----- | ----- | ------ |
| slugify-basic | harnu-spec | 10.00 | 10.00 | 0.00   |
| (summary)     | harnu-spec |       | 10.00 | 0.00   |

## Tokens per run, total (spec and build)

| problem       | contestant | r1         | mean       | spread |
| ------------- | ---------- | ---------- | ---------- | ------ |
| slugify-basic | harnu-spec | 2669129.00 | 2669129.00 | 0.00   |
| (summary)     | harnu-spec |            | 2669129.00 | 0.00   |

## Tokens per run, output (spec and build)

| problem       | contestant | r1       | mean     | spread |
| ------------- | ---------- | -------- | -------- | ------ |
| slugify-basic | harnu-spec | 53797.00 | 53797.00 | 0.00   |
| (summary)     | harnu-spec |          | 53797.00 | 0.00   |

## Wall time (ms)

| problem       | contestant | r1        | mean      | spread |
| ------------- | ---------- | --------- | --------- | ------ |
| slugify-basic | harnu-spec | 317654.00 | 317654.00 | 0.00   |
| (summary)     | harnu-spec |           | 317654.00 | 0.00   |

## Operator turns

| problem       | contestant | r1   | mean | spread |
| ------------- | ---------- | ---- | ---- | ------ |
| slugify-basic | harnu-spec | 3.00 | 3.00 | 0.00   |
| (summary)     | harnu-spec |      | 3.00 | 0.00   |

## Sub-agents spawned

| problem       | contestant | r1   | mean | spread |
| ------------- | ---------- | ---- | ---- | ------ |
| slugify-basic | harnu-spec | 4.00 | 4.00 | 0.00   |
| (summary)     | harnu-spec |      | 4.00 | 0.00   |

## Spec lines

| problem       | contestant | r1    | mean  | spread |
| ------------- | ---------- | ----- | ----- | ------ |
| slugify-basic | harnu-spec | 66.00 | 66.00 | 0.00   |
| (summary)     | harnu-spec |       | 66.00 | 0.00   |

## Spec words

| problem       | contestant | r1     | mean   | spread |
| ------------- | ---------- | ------ | ------ | ------ |
| slugify-basic | harnu-spec | 646.00 | 646.00 | 0.00   |
| (summary)     | harnu-spec |        | 646.00 | 0.00   |

## Runs

| contestant | done | incomplete | failed | judges invalid reply | flaky |
| ---------- | ---- | ---------- | ------ | -------------------- | ----- |
| harnu-spec | 1.00 | 0.00       | 0.00   | 0.00                 | 0.00  |

## Budget

- cap: 10000000.00
- spent: 2687863.00
- remaining: 7312137.00
- status: done

| phase      | tokens     |
| ---------- | ---------- |
| contestant | 2568954.00 |
| operator   | 15493.00   |
| judge      | 14941.00   |
| build      | 84682.00   |
| discarded  | 3793.00    |

| contestant   | tokens     |
| ------------ | ---------- |
| harnu-spec   | 2684070.00 |
| unattributed | 3793.00    |

## Confounds

- Bundles keep their structure: contestant names are replaced and front matter is stripped, but the structural shape of an artifact (an acceptance-criteria table, a plan checklist) can still identify the method to a judge.
- Judges run from a neutral directory, but the default work root path contains the word `harnu` for every contestant alike, so it cannot say which contestant is being scored.
- Real-CLI `--resume` behaviour and "no MCP server loads under `--strict-mcp-config`" are first exercised by the dry run; rounds that use a fake `claude` prove neither.
- The operator is simulated from a written answer sheet, so a question the sheet does not cover gets its default answer rather than a human judgement.
- Judges share one model and read one contestant at a time; their scores are not calibrated against a human grader.
- Hidden tests measure one reference behaviour: a spec that legitimately decides otherwise scores lower.
- Run-to-run spread comes from few repeats, so it is a coarse noise estimate, not a statistical test.

## Details

### slugify-basic · harnu-spec · r1

- judge note: All three atoms are covered by R-2 and their ACs (AC-2, AC-3, AC-4). The preamble contradicts itself on whether the slice builds while D-1 is open, and non-string input is left unspecified. All nine ACs name a test title as their proof.
