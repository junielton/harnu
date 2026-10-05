---
session: 3f2a9c10-5b7d-4e21-9a8c-0d1e2f3a4b5c
slug: proj-231-export
started: 2026-08-14
---

# Goal — PROJ-231 CSV export

## North star

Ship the CSV export for Acme's reporting screen: one PR merged into main with the
exporter, its tests and the settings toggle.

## Done criteria

- [ ] PR merged into main with green CI
- [ ] delivery-verifier report with every AC met
- [x] spec approved by the operator

## Executors

| id | card(s) | substrate | expected deliverable | ACs met/total | state |
| --- | --- | --- | --- | --- | --- |
| 7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f | T231 | worktree | exporter + tests (PR #412) | 3/5 | working |
| 0e9d8c7b-6a5f-4e3d-9c2b-1a0f9e8d7c6b | T232 | session | settings toggle | 0/2 | idle |

## Pending gates

- approval apr-7f3e: operator to allow the schema migration
- blocked on the org/proj/www staging deploy

## Tick checklist

- check CI on the exporter PR every tick

## Log

<!-- newest first, ONE line per tick: date time — state → action taken -->
- 2026-08-15 10:40 — T231 working, T232 idle → nudged T232
- 2026-08-14 17:05 — mission set, two executors dispatched
