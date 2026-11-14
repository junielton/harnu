---
id: mnt-5c0de003
slug: delivered-pending-close
folder: /home/user/Workspace/org/www
owner:
  sessionId: 3f1c9a52-7d4e-4b8a-9c21-5e6a0b7d8f10
  folder: /home/user/Workspace/org/www
status: delivered
declaredEnd:
  kind: code
  target: The importer reads every row of the sample export and reports the count
  evidence: The suite passes and the sample export imports 120 rows
scope:
  - kind: worktree
    ref: docs/specs/2026-10-20-sample-import/spec.md
steps:
  - id: stp-1
    ordinal: 1
    kind: custom
    title: Build the parser
    verification: existence
    proof: unproven
    links:
      - kind: pr
        ref: '388'
    blockers: []
    addedAt: '2026-10-20T09:05:00.000Z'
  - id: stp-2
    ordinal: 2
    kind: fixed-end
    title: Delivered and verified
    verification: verifier
    proof: verified
    verifiedBy:
      sessionId: c4e6a8b0-5d7f-4c9a-a1b3-6e8a0c2e4f60
      at: '2026-10-22T11:50:00.000Z'
      verdict: met
      evidenceRequired: true
    links:
      - kind: worktree
        ref: .harnu/evidence/mnt-5c0de003/stp-2
    blockers: []
    addedAt: '2026-10-20T09:05:00.000Z'
blockers: []
openQuestions: []
pendingClose:
  at: '2026-10-22T12:00:00.000Z'
  requestedBy: 3f1c9a52-7d4e-4b8a-9c21-5e6a0b7d8f10
createdAt: '2026-10-20T09:00:00.000Z'
updatedAt: '2026-10-21T10:00:00.000Z'
provenance:
  author: agent
  at: '2026-10-20T09:00:00.000Z'
  branch: card/T700-example
ledger:
  - at: '2026-10-22T11:00:00.000Z'
    kind: pr-merged
    stepId: stp-1
    ref: '#388'
    pr: 388
  - at: '2026-10-22T11:50:00.000Z'
    kind: verified
    stepId: stp-2
    ref: stp-2
    sessionId: c4e6a8b0-5d7f-4c9a-a1b3-6e8a0c2e4f60
    detail: met
outcome:
  declaredEnd:
    kind: code
    target: The importer reads every row of the sample export and reports the count
    evidence: The suite passes and the sample export imports 120 rows
  actualEnd: The importer reads every row and reports the count
  deviations:
    - The report layout changed once
  blockers:
    - reason: The sample export was late
      resolution: The operator uploaded it
  verificationGaps: []
  surprises:
    - Rows can carry a trailing comma
  perStep:
    - stepId: stp-1
      openedAt: '2026-10-20T11:00:00.000Z'
      mergedAt: '2026-10-22T11:00:00.000Z'
      commits: 6
      reverifications: 1
memoryDrafts:
  - id: drf-1
    kind: decision
    page: decisions
    entry: Rows are read with a tolerant parser because exports carry trailing commas.
    cites:
      - kind: pr
        ref: '388'
    mission: mnt-5c0de003
    validFrom: '2026-10-22T12:00:00.000Z'
    watches:
      - src/importer
---
# Ship the sample parser

## Log
