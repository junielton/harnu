# Export retry — spec

## 1. Problem

Exports fail silently when the upstream returns a 429.

## 3. Slices

- S-1 — retry wrapper in the client
- S-2 — surface the failure in the UI

## 5. Open decisions

| D-n | question                         | options                | default | status                         |
| --- | -------------------------------- | ---------------------- | ------- | ------------------------------ |
| D-0 | Which HTTP client do we use?     | fetch · undici         | fetch   | resolved · fetch · 2026-10-20  |
| D-1 | Where does the retry live?       | client · server · both | client  | resolved · client · 2026-10-31 |
| D-2 | Maximum number of retry attempts | 3 · 5 · unlimited      | 3       | resolved · 5 · 2026-10-31      |

## 6. Amendments

| date | section | change | why |
| ---- | ------- | ------ | --- |
