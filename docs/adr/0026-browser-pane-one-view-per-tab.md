# ADR-0026 — A browser pane holds tabs; each tab is its own view; the pane stays the unit of partition and access

**Status:** Proposed (accepted with the spec's approval)
**Date:** 2026-11-18
**Author:** agent
**Technical context:** `docs/specs/2026-11-18-browser-tabs/spec.md`, `docs/prds/browser-tabs.md`, `docs/design/browser-tabs/`

---

## 1. Context

The T564 browser pane binds one `WebContentsView` to one pane record. Every rule hangs on the pane: its partition is fixed at creation, access tiers and leases are judged per pane, the connection chip, network capture, emulation and the discard sweep are per pane, and every agent verb takes a `paneId`. The operator now wants several pages in one pane (tabs), a start page for a pane with no address, and an error page for a failed load.

## 2. Options

One view per tab owned by the pane (chosen), tabs as grouped panes, and one view with tabs as addresses. The comparison lives in the PRD's "Alternatives considered" (`docs/prds/browser-tabs.md` §6), per the D-11 rule that alternatives live in the PRD only.

## 3. Decision

1. **The pane is the unit of partition, access and layout.** Partition, `openedBy`, `ownerSessionId`, Disconnect, pause, chip, emulation, zoom and network capture stay on the pane and apply to all its tabs. A lease stays per view and origin, so it belongs to a tab. A tab cannot change partition; "Move to a new pane" moves it to a new pane of the same partition and `openedBy`.
2. **The tab is the unit of page.** A tab owns one `WebContentsView` and its view entry (URL, title, history, console buffer, snapshot refs, activity word) and its discard state. Host methods keep their `paneId` signature, act on the active tab, and take an optional `tabId`.
3. **Only the active tab's view is attached.** Inactive views are detached (not destroyed) and discarded by the existing sweep after `HIDDEN_DISCARD_MS`; a revived tab reloads its address.
4. **Start and error pages are renderer DOM, not page code.** When the active tab has no address, or its last main-frame load failed, main hides the view and the renderer draws the placeholder in the host div, as it already does for a discarded pane. No `harnu-page://` page, no ticket, no guest preload is involved.
5. **A pane holds at most 8 tabs** (`TAB_LIMIT`), on top of the existing 4 agent panes per folder.

## 4. Consequences

- Memory grows with live tabs; the discard sweep bounds it the same way it bounds hidden panes today.
- Every verb that resolved `paneId → view` resolves `paneId (+ tabId) → tab → view`; refs and cursors are scoped per tab.
- The persisted pane state gains a `tabs` array; a file without it restores as one tab (backward compatible).
- Popups no longer create panes, so the per-folder pane count shrinks in practice.

## 5. Revisit when

Tabs need to cross partitions or panes by drag, or a pane needs more than 8 tabs.
