---
id: mnt-5c0de007
slug: stored-stale
folder: /home/user/Workspace/org/www
owner:
  sessionId: 3f1c9a52-7d4e-4b8a-9c21-5e6a0b7d8f10
  folder: /home/user/Workspace/org/www
status: stale
declaredEnd:
  kind: code
  target: The importer reads every row of the sample export and reports the count
  evidence: The suite passes and the sample export imports 120 rows
steps:
  - id: stp-1
    ordinal: 1
    kind: custom
    title: Investigate the slow query
    verification: existence
    proof: unproven
    links: []
    blockers: []
    addedAt: '2026-10-20T09:05:00.000Z'
  - id: stp-2
    ordinal: 2
    kind: fixed-end
    title: Delivered and verified
    verification: verifier
    proof: unproven
    links: []
    blockers: []
    addedAt: '2026-10-20T09:05:00.000Z'
blockers: []
openQuestions: []
createdAt: '2026-10-20T09:00:00.000Z'
updatedAt: '2026-10-21T10:00:00.000Z'
provenance:
  author: agent
  at: '2026-10-20T09:00:00.000Z'
  branch: card/T700-example
---
# Find the slow query

## Log
