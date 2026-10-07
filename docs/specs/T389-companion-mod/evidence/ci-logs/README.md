# T389 P1 local pipeline logs (evidence)

Preserved from `/tmp` so the `†` verdicts in `docs/reports/T389-P1-delivery-verification.md` (§6.1) stay durable.
Each `harnu-local-ci-<id>` directory is one local-ci run; files are `<PR>-<id>-<step>.log` (steps: mod, cli, test, e2e, build, lint, typecheck, format, i18n, english, changelog, awareness, user-docs).
Scrubbed: home path → `~`, session uuids → first 8 chars, auth headers/bearer tokens redacted. No log needed trimming (all under 200 KB).

| Files                                      | PR  | Wave                  | Backs (report section)                                      |
| ------------------------------------------ | --- | --------------------- | ----------------------------------------------------------- |
| `PR9-PJi9DD-*`                             | #9  | P1W2 mod skeleton     | §3.P1W2 `†` rows (mod.log, cli.log)                         |
| `PR10-UXoYtQ-*`, `PR10-p1w3.json`          | #10 | P1W3 handshake        | §3.P1W3, the 23 mod-test rows marked `†`                    |
| `PR11-5jB46t-*`, `PR11-p1w4.json`          | #11 | P1W4 arbitration      | AC-14, AC-15 (mod.log, cli.log)                             |
| `PR12-gnORpR-*`, `PR12-p1w5.json`          | #12 | P1W5 fleet state      | §3.P1W5 (47 pass, claude 2.1.291)                           |
| `PR13-K1kFK6-*`                            | #13 | P1W6 telemetry S1     | S1 log; predates the S1 tip (see note in §3.P1W6)           |
| `PR15-5XfEtH-*`, `PR15-7sTyjJ-*`           | #15 | P1W6 telemetry S2     | S2 `†` rows (mod.log, cli.log)                              |
| `PR18-yY3zL5-*`                            | #18 | P1W6 telemetry S3     | S3 `†` rows (cli.log)                                       |
| `PR7-sAbC8Y-*`                             | #7  | P4W1 Mods tab, part A | AC-7, AC-9, AC-17 `†` rows                                  |
| `PR16-fOrGHC-*`                            | #16 | P4W1 Mods tab, part B | P4W1 `†` rows                                               |
| `PR14-EZ6oCW-*`                            | #14 | P2W1 command channel  | per-test output after the final edit (build + e2e included) |
| `PR17-lv-app.log`, `PR17-lv-cli-suite.log` | #17 | P4W3 outside-Harnu    | live-verify rows in §3.P4W3                                 |

Screenshots (one level up): `P1W4-01-disclosure-toast-fullpage.png`, `P1W4-05-hover-unloaded.png`, `P1W4-06-system-monitor-unloaded.png` back the PR #11 live-verify rows.

## Missing

Nothing from the §6.1 list was missing. Not preserved (outside the list): the other `/tmp/p1w4-lv` artefacts (other screenshots, electron logs, driver scripts) and the other `/tmp/harnu-local-ci-*` runs.
