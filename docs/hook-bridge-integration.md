# Harnu ↔ Claude Code Hook Bridge — integration guide

> What the Hook Bridge is, how the opt-out works, how to uninstall it cleanly,
> and a **copy-paste prompt to recreate the hooks on a new computer**.

## 1. What it does (in one paragraph)

Harnu used to **guess** each session's state from "did the JSONL grow recently."
That can't tell a session **blocked on an approval for 20 minutes** apart from a
session that **finished** — both just stop writing. The Hook Bridge fixes that by
**listening to what Claude Code actually emits** (its hooks). On startup Harnu
runs a tiny loopback HTTP server and registers a set of **observer hooks** in your
global `~/.claude/settings.json`. Every hook POSTs an event to that server; Harnu
folds the events into a real per-session **task-state** — `working`,
**`needs-input`** (blocked on approval — amber, sorts up), `idle`, `failed`,
`completed` — and paints the sidebar dot accordingly.

## 2. It is a pure observer (safety)

- **It can never block or change a session.** The bridge always answers `200 {}`
  with **no** `decision`/`permissionDecision` field. It only reads.
- **Localhost only.** The server binds `127.0.0.1` on an ephemeral port, and the
  hook URL carries a random per-launch **token** so other local processes can't
  spoof events.
- **Non-destructive.** The installer does a read-modify-write that preserves every
  existing key and any hooks you already have. Each handler Harnu adds carries a
  `"_harnu": "v1"` **sentinel** so uninstall removes _exactly_ ours.

## 3. Opt-out model (default ON)

Hooks install automatically on first launch — the feature is worthless if it
defaults off. You stay in control:

- **Disable anytime:** Settings → turn the integration off. Harnu runs
  `uninstallHooks()` immediately (sentinel-scoped clean removal) and persists the
  choice in `<userData>/hook-prefs.json` (`{ "enabled": false }`), so it stays off
  across launches. Re-enable to reinstall.
- **Programmatic:** the renderer calls `window.api.hooksSetEnabled(false)` /
  `hooksStatus()` (preload), backed by the `hooks:setEnabled` / `hooks:status` IPC.

### Lifecycle

| Moment                  | What happens                                                                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Harnu launch (enabled)  | install/refresh hooks with the live port + a fresh token                                                                                                                              |
| Harnu launch (disabled) | nothing installed                                                                                                                                                                     |
| Harnu quit              | server closes; hooks are **left in place** (they fail-fast — instant `ECONNREFUSED` — while Harnu is down, and are refreshed on next launch). Minimizes writes to your global config. |
| You opt out             | hooks removed cleanly (sentinel filter)                                                                                                                                               |

> A session already running when Harnu launches won't carry the hooks until its
> next start (Claude reads hooks at session startup). Until then it rides the old
> activity heuristic — the bridge is always **additive and degradable**, never a
> hard dependency. If `~/.claude/settings.json` is unwritable, Harnu logs it and
> falls back to the heuristic; nothing breaks.

## 4. Which events are registered

`Notification` (matchers `permission_prompt`, `idle_prompt`), `Stop`,
`StopFailure`, `UserPromptSubmit`, `SessionStart`, `SessionEnd`, `PreToolUse`
(matcher `*`), `PermissionRequest`. High-frequency `PostToolUse`/`PostToolBatch`
are deliberately **not** registered in v1 (the watcher already signals "writing"
= working). Each handler is `type: "http"` by default, with a `curl`-based
`type: "command"` fallback for Claude versions lacking the native `http` hook.

The URL encodes the event + a semantic tag so the bridge can recover them without
guessing payload field names:
`http://127.0.0.1:<PORT>/hook/<TOKEN>/<EVENT>/<TAG>`.

---

## 5. 🧳 Recreate the hooks on a new computer

**The easy way — you don't need to do anything manual.** Install and launch Harnu
on the new machine. It auto-installs these hooks on startup (opt-out; default on).
That's the whole story for 99% of cases.

The PORT is **ephemeral** — Harnu rewrites it on every launch — so a hand-written
hook config goes stale the moment Harnu restarts. Manual recreation only makes
sense while Harnu is running and you use its **live** port. Prefer letting Harnu
manage them.

### 5.1 Portable prompt (paste into a Claude Code session)

If you still want Claude to recreate them by hand — for transparency, a manual
restore, or a machine where you set up before installing Harnu — paste this:

> Add Harnu's observer hooks to my global Claude Code settings at
> `~/.claude/settings.json`, **non-destructively**: preserve every existing key and
> any hooks I already have. Add `"_harnu": "v1"` to each handler you add (so they
> can be cleanly removed later) and `"timeout": 5`. Register these events, each as a
> `type: "http"` handler POSTing to
> `http://127.0.0.1:<PORT>/hook/<TOKEN>/<EVENT>/<TAG>` — ask me for PORT and TOKEN
> (Harnu prints them in its logs / Settings → Integrations):
>
> - `Notification` with matcher `"permission_prompt"` → TAG `permission_prompt`
> - `Notification` with matcher `"idle_prompt"` → TAG `idle_prompt`
> - `Stop`, `StopFailure`, `UserPromptSubmit`, `SessionStart`, `SessionEnd`,
>   `PermissionRequest` → TAG `_` (no matcher)
> - `PreToolUse` with matcher `"*"` → TAG `_`
>
> Do **not** add any `decision`/`permissionDecision` field — these are pure
> observers that must only read. Show me the diff before writing the file.

### 5.2 The literal structure (fill in PORT and TOKEN)

```jsonc
{
  "hooks": {
    "Notification": [
      {
        "matcher": "permission_prompt",
        "hooks": [
          {
            "type": "http",
            "url": "http://127.0.0.1:PORT/hook/TOKEN/Notification/permission_prompt",
            "timeout": 5,
            "_harnu": "v1"
          }
        ]
      },
      {
        "matcher": "idle_prompt",
        "hooks": [
          {
            "type": "http",
            "url": "http://127.0.0.1:PORT/hook/TOKEN/Notification/idle_prompt",
            "timeout": 5,
            "_harnu": "v1"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "http",
            "url": "http://127.0.0.1:PORT/hook/TOKEN/Stop/_",
            "timeout": 5,
            "_harnu": "v1"
          }
        ]
      }
    ],
    "StopFailure": [
      {
        "hooks": [
          {
            "type": "http",
            "url": "http://127.0.0.1:PORT/hook/TOKEN/StopFailure/_",
            "timeout": 5,
            "_harnu": "v1"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "http",
            "url": "http://127.0.0.1:PORT/hook/TOKEN/UserPromptSubmit/_",
            "timeout": 5,
            "_harnu": "v1"
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "http",
            "url": "http://127.0.0.1:PORT/hook/TOKEN/SessionStart/_",
            "timeout": 5,
            "_harnu": "v1"
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "http",
            "url": "http://127.0.0.1:PORT/hook/TOKEN/SessionEnd/_",
            "timeout": 5,
            "_harnu": "v1"
          }
        ]
      }
    ],
    "PermissionRequest": [
      {
        "hooks": [
          {
            "type": "http",
            "url": "http://127.0.0.1:PORT/hook/TOKEN/PermissionRequest/_",
            "timeout": 5,
            "_harnu": "v1"
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "http",
            "url": "http://127.0.0.1:PORT/hook/TOKEN/PreToolUse/_",
            "timeout": 5,
            "_harnu": "v1"
          }
        ]
      }
    ]
  }
}
```

> **`curl` fallback** (Claude without the native `http` hook type): swap each
> handler for
> `{ "type": "command", "command": "curl -s -X POST --data-binary @- http://127.0.0.1:PORT/hook/TOKEN/<EVENT>/<TAG>", "timeout": 5, "_harnu": "v1" }`.

### 5.3 Remove the hooks (uninstall prompt)

> In `~/.claude/settings.json`, remove **every** hook handler that has an
> `"_harnu"` field, then drop any matcher entries and event arrays left empty.
> Preserve all my other settings and any hooks without that field. Show me the diff
> first.

(Harnu does exactly this when you turn the integration off in Settings.)

---

## 6. Where it lives in the code

| Piece                                                       | File                                                                |
| ----------------------------------------------------------- | ------------------------------------------------------------------- |
| Pure reducer (hook event → task-state FSM)                  | `src/main/hook-state.ts` (`reduceTaskState`)                        |
| Loopback HTTP server + opt-out orchestration                | `src/main/hook-bridge.ts` (`startHookServer`, `registerHookBridge`) |
| `~/.claude/settings.json` read-modify-write                 | `src/main/claude-settings.ts`                                       |
| Install / uninstall + sentinel + transports                 | `src/main/hook-installer.ts`                                        |
| Preload bridge (`onHook`, `hooksStatus`, `hooksSetEnabled`) | `src/preload/index.ts`                                              |
| Store: `Session.taskState` + `onHook` handler               | `src/renderer/src/stores/sessions.ts`                               |
| Sidebar dots (amber `needs-input`, red `failed`)            | `src/renderer/src/components/SidebarFolder.vue` + `design.md` §6    |

Tests: `tests/hook-state.test.ts`, `tests/hook-installer.test.ts`,
`tests/hook-bridge.test.ts`.

## 7. Troubleshooting

- **Dots never change beyond green/grey:** hooks may be disabled (Settings), or
  the sessions predate install (restart them through Harnu). The app still works
  on the legacy heuristic.
- **Your `claude` feels slightly slower with Harnu closed:** dead-port hooks
  fail-fast (instant `ECONNREFUSED`), so this should be negligible. If it bothers
  you, opt out — that removes the hooks entirely.
- **A session stuck amber after you approved:** the clearing event
  (`PreToolUse`/`Stop`) may have been missed; the next turn re-drives it, or
  `pty:exit` resolves it. File a bug with the session's hook log if it persists.
