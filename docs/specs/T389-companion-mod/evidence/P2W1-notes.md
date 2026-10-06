# P2W1 hand-back notes

Executor notes for the command channel (PR #14). Evidence beside this file: `LV-P2W1-a`, `-b` (and `-b-cq7-fake-host`), `-c`, `-d`
(ndjson, one JSON object per step) and `P2W1-ping.png`. Everything ran on Claude Code 2.1.290 (the tested
ceiling; the machine's `claude` is 2.1.291, which the gate would cap at `shadow`, so the live runs put a
2.1.290 binary first on PATH of a throwaway HOME and user-data dir).

## Spec defects and deviations

1. **`registerCommandHandler(name, fn)` cannot exist** (spec §7.7, master §12.2). The engine refuses a module
   that passes `$` through a dynamic callee: `$ itself is passed as an argument ... $ is always spelled
$.noun.event(...) at the call site`. Replaced by a closed `switch` in `runHandler` plus
   `IMPLEMENTED_COMMANDS` in `lib/command-core.ts`; a later wave adds one `case` and one name. The handler
   returns its result (`ok` or `{code, message, data}`) so the executor can send the single `command.result`.
2. **Closed poll requests cannot unpark** (spec §7.3 step 7). `server.ts` hands a poll handler no close signal
   and is outside this wave's file list. A poll whose socket closed stays parked until its hold ends
   (at most `POLL_HOLD_MS`) or the next poll supersedes it, which is the reload case and is observed
   (`superseded` in the ledger, one per reload).
3. **`commandSource` carries no `bootId`** (spec §7.3, events piggyback): `server.ts` passes only the cursor,
   so a stale `bootId` on an `events` request cannot answer `resync`. Mitigation in the mod: the cursor is
   reset whenever a hello brings a new boot id, and a `resync: true` poll answer makes the mod re-read the
   rendezvous file, see the new `bootId` and say hello again (LV: host restart, L4 `host restart drops the queue`).
   Without that last rule a host that restarts under a live `conn` (the dev `restartListener`) is never noticed.
4. **Headless commands are unreachable.** Spec §7.4 says a headless binding admits `flush` and `config.update`,
   but `computeEnable` gives headless bindings `sense.*` only, so the feature check (`act.channel`) answers
   `FEATURE_OFF` first. AC-36 (`HEADLESS` for `turn.abort`) is unaffected because the profile check runs before
   the feature check. The piggyback path (`pendingFor` with a cursor, the `events` request fields, the mod
   running commands from `events` and `hello` responses) is built and unit-tested but has no live producer.
5. **`EnqueueRefusal` needs `AUDIT_FAILED`** (spec §7.4, §7.5): when the audit append throws the command is not
   queued, and that is none of the listed reasons. Added; `ChannelRefusal` in `command-channel.ts`.
6. **`GateRow.validate` added.** Argument checks of later waves' commands need a home; this wave's six are in
   `command-gate-core.ts`, any other command with no validator is `BAD_ARGS`.
7. **May-touch list was short.** Also touched: `src/main/companion/{host,command-types}.ts` (wiring, shared types),
   `src/preload/index.ts` (`companionPing`, `companionDebugEnqueue`), `SystemMonitor.vue` (the click handler),
   `src/renderer/src/lib/companion-view.ts` (`pingToast`), `tests/cli/support/**`.
8. **Three more i18n keys.** The fixed refusal map of spec §10 needs words: `harnuMod.channel.reason.{legacy,shadow,headless}`.
9. **Spec §7.7 "`$.state` key `channel` ... `bootId: BootId`"**: the in-memory twin starts with `bootId: null`;
   only a non-null value is ever written.
10. **`config.update.pollHoldMs`** has no client-side effect (`$.http.fetch` takes no timeout). The host tracks the
    value from a successful result and holds accordingly; a re-hello resets it with the rest of `hello.config`.
11. **Spec §11 AC-20/-37 harness limit.** In the mod test harness a hook that throws is skipped, so the engine's
    rejection text cannot be injected for `$.session.compact`; the mapping is covered by a pure test, and the
    real texts by LV-P2W1-c. The 30 s fetch abort cannot be injected with its message either, so the mod also
    treats a transport failure that took at least `FETCH_HARD_CAP_MS - 500` ms as the hard cap.
12. **Finding in P1W3's pump, not fixed here.** While the host keeps answering `events` with `resync: true`
    (a sid mismatch nobody resolves), the mod re-sends a `resync` snapshot on every answer, in a tight loop.
    The app's identity adapter resolves the mismatch through `session.rebound`; the test rig had to do the same.

## Live-verify deviations

- LV-P2W1-c used a local stand-in for the Messages API (no credential, no real model call) instead of `haiku`,
  to hold a turn open for the abort and compact steps. Copying the operator's OAuth credentials into a throwaway
  HOME could rotate the refresh token under their running sessions, so it was not done.
- LV-P2W1-d freezes the session's own `claude` (SIGSTOP, by recorded pid) so a command stays undelivered
  until Harnu quits.
- The window is Electron under Xvfb, driven by Playwright; no CDP port. A `out/main/resources -> ../../resources`
  symlink in the (gitignored) build output lets an unpackaged build stage the mod.
- AC-31 is a human acceptance criterion. `P2W1-ping.png` is a machine capture of the same screen (row, button,
  toast) from a scripted click, not the operator's confirmation.
