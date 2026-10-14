# ADR-0020 — Agent terminals read a resolved screen model (`@xterm/headless` in main) and are spawned by main, not by the pane

**Status:** Proposed (dependency and Disconnect semantics approved by the operator, 2026-10-13)
**Date:** 2026-10-13
**Author:** agent (T474)
**Technical context:** `docs/specs/T474-agent-terminals/spec.md`, `src/main/pty.ts`, `src/main/pty-ring-buffer.ts`, `src/renderer/src/components/HelperPane.vue`, ADR-0013

---

## 1. Context

An agent that opens a terminal today cannot see what happens in it, and cannot type into it. Making that possible forces three architectural choices, each with a real alternative.

1. **What does "read the terminal" return?** Main already keeps a 256 KiB raw ring of each PTY's byte stream, for renderer replay. The stream contains escape sequences, carriage-return overwrites (progress bars), cursor moves and full-screen programs.
2. **Who creates the PTY of an agent terminal?** Today the renderer does, when the helper pane mounts (`HelperPane.vue:383`), and only the current folder's panes are mounted. A terminal opened for a folder the operator is not viewing has no process at all until they look.
3. **What does the owner id mean?** The MCP transport has no per-session identity (ADR-0013). An `ownerSessionId` is whatever the caller says it is.

## 2. Decision

**D-1 — A resolved screen model, via `@xterm/headless@6.0.0` in the main process.** One headless `Terminal` per agent-readable PTY, fed from the PTY's `onData` and following its resizes. `read_terminal` serializes its buffer (resolved lines, scrollback, cursor, alternate-screen flag); "output since" uses xterm markers, which follow a line through scrolling and report disposal when it leaves scrollback. The raw ring stays, for replay only.

**D-2 — Main spawns the PTY at the verb; the pane adopts it.** `spawn_terminal` creates the shell PTY itself, registers it under a `terminalId` equal to the helper pane id, and hands `ptyId` to the renderer with the `pane.split` command. The pane skips its own `ptyCreate` and attaches through the existing `pty:replay` path.

**D-3 — Ownership is attribution only.** `ownerSessionId` labels the terminal (chip, `get_session`, audit). Authorization comes from the terminal's _origin_ (agent-spawned or operator-opened), whether the operator disconnected it, the folder gate and the operator's prefs — never from who the caller claims to be.

## 3. Alternatives considered

| Option                                                  | Why not                                                                                                                                                                                                                             |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Ring buffer + ANSI stripping** (no dependency)        | Confidently wrong on exactly the cases that motivated the feature: progress output, `[y/N]` prompts, REPLs, `less`/`vim`. A regex cannot recover the screen from a repaint. The failure is silent — the agent acts on garbled text. |
| **Serialize the renderer's xterm on demand over IPC**   | The renderer's `Terminal` exists only while the pane has mounted; a hidden folder has none (D-2's problem again), and a read would depend on the window being alive and the pane attached.                                          |
| **`xterm-addon-serialize` in the renderer**             | Same dependency on a mounted pane, plus an IPC round trip per read and per `waitFor` poll.                                                                                                                                          |
| **Keep the renderer as PTY creator; return `starting`** | An agent would have to poll an unbounded wait for a human to navigate. A `terminalId` that is not yet backed by a process is a promise the system cannot keep.                                                                      |
| **Authenticate the owner** (per-session token)          | The transport carries one shared token by design (ADR-0013, `2026-07-13-agent-pane-routing-design.md`). A per-session identity is a separate, larger project; this feature must not depend on it.                                   |
| **Reconnectable Disconnect**                            | A second consent door; the operator decided Disconnect is permanent and stops reads and writes (2026-10-13). An agent that still needs a shell opens a new, visible terminal.                                                       |

## 4. Consequences

- **A new runtime dependency** (`@xterm/headless`, same major as the shipped `@xterm/xterm`), and PTY output is now parsed twice: once in the renderer, once in main — only for agent-readable terminals, bounded at 2,000 lines of scrollback each. Measured in unit B2 (`AC-B2-10`).
- **`pty.ts` gains an exported `createPty`.** The IPC handler delegates to it; behaviour for every existing caller must stay byte-identical (`AC-B1-10`).
- **The pane no longer always owns its PTY.** `HelperPane.vue` has one new branch (adopt vs create). The module-level `liveHelpers`/`creatingHelpers` guards still apply.
- **Terminal PTYs must never gain a `sessionKey`.** It would make them fleet rows and parkable. A test pins it (`AC-B1-7`).
- **An agent-spawned terminal does not survive a restart** and its pane is not persisted: an id that an agent holds must never come back bound to a different process.
- **Ownership spoofing is possible and harmless:** a caller can claim any owner. The worst outcome is a misleading chip label; it gains no access. The spec says so rather than pretending to a check, as `message_session` does.
- **Typing into a terminal is a side door around Claude Code's own Bash permission rules.** The operator decided (2026-10-13) to keep Harnu's existing posture — free unless the folder is blocked or `ask` is on — and added a **global kill-switch** (Settings → Control server, "Allow agents to type into terminals", default on; off refuses every `send_terminal` before any confirm). An audit line per send, a visible chip and a permanent, one-click Disconnect remain.
- **`send_terminal` must opt out of the idempotency registry** (a new catalog field, `replayable: false`), or two identical keystrokes collapse into one. This is a general property of any non-idempotent verb the catalog may gain later.
- **Everything an agent receives is scrubbed** (`redactTranscript`, best-effort, both terminal kinds), while `waitFor` matches on unscrubbed text so a pattern matches reality.
- **Terminal queries need exactly one answerer.** An unmounted terminal has no renderer xterm to answer `nvim`/`fzf` queries, so the headless model answers until the adopting pane takes the replay snapshot; from that instant the renderer answers and the model stays silent. A pane that adopts must drop the replies its xterm generates while the replay is being written.
- **Access rules are decided in the plan layer** from a terminal state `server.ts` resolves first. A handler-level refusal would fire after a confirm was raised in `ask` mode. A write lease is a documented confirm→allow promotion scoped to one terminal, and for `send_terminal` an Allow never types the call that asked (a parked confirm could otherwise type minutes later).
- **Main owns teardown.** A PTY a pane never mounted is still killed when the pane is removed, and re-dispatched to a reloaded renderer, so no writable, invisible terminal survives a reload.
