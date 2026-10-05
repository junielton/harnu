# ADR-0004 — The MCP bearer token persists across control-server restarts

**Status:** Accepted
**Date:** 2026-07-19
**Author:** junielton (via dispatched agent)
**Deciders:** junielton
**Technical context:** `src/main/mcp/server.ts`, `src/main/mcp/config-file.ts`, BUG-35
**Spec:** `docs/specs/2026-07-19-mcp-token-persistence.md`
**Answers:** AC16 / T123 §9 OQ1

---

## 1. Context

Capy's MCP control server mints a **fresh** bearer token on every start:

```ts
async function start(): Promise<void> {
  if (httpServer) return
  token = randomUUID()                       // src/main/mcp/server.ts:1170
  …
  await writeConfigFile(listeningPort, token) // :1183
  running = true
}
```

`writeConfigFile` (`:230-238`) rewrites `<userData>/capy.mcp.json` with the new
port and the new token, atomically at mode `0o600` inside a `0o700` directory.

A spawned `claude` session reads that config **once, at spawn**, and holds the
token for its whole life. So when the operator toggles the control server off and
on — or it restarts for any reason — every already-running session is left holding a
token the server no longer recognizes. `http-guard.ts` rejects it (constant-time
compare, 403, `:146`) and the session's Capy verbs fail for the rest of its
existence. The agent has no way to recover: it cannot re-read the config, and
nothing tells it why every call suddenly 403s.

The sibling half of this problem — a session spawned _while_ the server was
mid-start picking up a config the server wasn't yet serving — is already fixed via
`shouldInjectMcpConfig` (`config-file.ts:150`), which gates injection on
`running && autoRegisterEnabled && configExists`. That fix closed the spawn-time
race. It does nothing for the restart-time invalidation, because the session in
question was spawned correctly and only later had the ground moved under it.

T123 §9 left this as OQ1: rotate-and-document, or persist? This ADR settles it.

## 2. Decision

**Persist the token.** It is generated once, stored in a dedicated file
(`src/main/mcp/token-store.ts`, `<userData>/mcp-token.json`, mode `0o600` in the
existing `0o700` userData dir), and reused on every subsequent `start()`. A restart
rewrites `capy.mcp.json` with the new port and the **same** token, so an in-flight
session's bearer keeps authenticating.

The server remains loopback-only (`listen(0, '127.0.0.1')`, `server.ts:1178`) and
the guard's constant-time compare is untouched. The port still changes per start;
only the secret is stable.

An explicit operator-initiated **rotate** action remains available (and is the
correct response to a suspected leak), but it is a deliberate act, not a side effect
of toggling a switch.

**Why, per Capy's product rules.** The zero-friction principle says human gates
belong at the execute/accept/route doors and nowhere else — and, more directly:
**never break a running agent session.** A session that was working, that the
operator never touched, that holds correct context, silently losing its tool access
because an unrelated setting was toggled is precisely the invisible-breakage the
principle exists to forbid. It also fails the honest-errors bar twice over: the
agent sees an opaque 403, and the operator sees nothing at all.

## 3. Alternatives considered

- **Option B — rotate per boot, document the consequence.** _Rejected._ This is the
  status quo plus a paragraph. Documenting a footgun does not disarm it: the operator
  who toggles the server off and on is not reading the MCP page at that moment, and
  the agent that starts 403-ing cannot read docs at all. It also makes a routine,
  reversible-looking UI toggle silently destructive to every running session — the
  worst shape a control can have. The one real argument for it, "a fresh secret per
  boot is more hygienic", does not survive §4's threat model: the token's blast
  radius is bounded by loopback + file mode, neither of which per-boot rotation
  improves.
- **Re-broadcast the new token to running sessions.** _Rejected._ There is no channel
  for it. `claude` reads `--mcp-config` once at spawn; Capy cannot make a running
  child re-read a file, and inventing a side channel to push a secret into a live
  session is a materially larger attack surface than persisting one file.
- **Keep the old token valid alongside the new one for a grace period.** _Rejected._
  Two live secrets with a timer is more complexity and a strictly larger window than
  one stable secret, and it only defers the failure — a session outliving the grace
  period breaks exactly as before, now unpredictably.
- **Drop the token, rely on loopback alone.** _Rejected outright._ Loopback is not an
  authorization boundary: any local process, including a browser page issuing
  requests to `127.0.0.1`, could reach the control server. The bearer check is what
  makes the origin of a request meaningful; removing it to solve a rotation problem
  would trade a usability bug for a security hole.

## 4. Security posture — stated honestly

What the decision does and does not buy:

**Protects against:** remote network access (the listener binds `127.0.0.1` only);
other local _users_ on a multi-user machine (file mode `0o600` inside a `0o700`
directory, written atomically with the mode applied to the temp file before rename,
`atomic-write.ts:23-49` — the target never exists world-readable, even momentarily);
and unauthenticated local processes that never read the file (constant-time bearer
compare in `http-guard.ts`).

**Does NOT protect against:** any process running **as the same user**. Such a
process can already read `capy.mcp.json` — which contains the token today, by
construction, because that is how a spawned `claude` receives it. Persisting the
token adds no new reader; it only extends the lifetime of a secret that is already
readable by the same principal for as long as the config file exists.

**What persistence genuinely changes:** the token's lifetime goes from "one server
start" to "until rotated". A token exfiltrated by a same-user process was already
usable for the remainder of that server session; it is now usable until the operator
rotates. That is a real, bounded increase in exposure window, and it is the price
being paid — knowingly — for not breaking running sessions. Given that the threat
model already concedes same-user processes entirely, the marginal risk is small; the
usability defect it removes is not.

**Not claimed:** this is not encryption at rest, not OS-keychain storage, and not
protection against a compromised user account. If Capy later needs a defensible
answer to same-user threats, that is a keychain-backed credential design and it
needs its own ADR — it is not a reason to keep the per-boot rotation, which does not
address that threat either.

## 5. Consequences

- Toggling the control server off/on, or restarting it, no longer breaks in-flight
  sessions. AC16 / T123 §9 OQ1 is answered: **persist**.
- One new secret-bearing file (`<userData>/mcp-token.json`). Its mode and directory
  are asserted on every write, and a rotate action rewrites it.
- A token that leaks stays valid until rotated, rather than until the next restart.
  Documented above; rotation is the remedy.
- **The token is necessary but not sufficient, and this must not be glossed over.**
  The listener binds `listen(0, …)` (`server.ts:1178`), so the OS assigns a _new
  ephemeral port_ on every start. A session spawned before a restart holds the old
  port in its `--mcp-config`; with a persisted token it now presents a _valid_
  credential to an endpoint that is no longer there — `ECONNREFUSED` instead of 403.
  The session is equally broken, just with a different error.

  Therefore persisting the token **requires** persisting and re-binding the port to
  actually deliver the outcome this ADR is chosen for. The spec makes port reuse a
  first-class part of the change: store the port alongside the token, attempt to
  re-listen on it, and fall back to an ephemeral port only if it is taken (in which
  case in-flight sessions are unavoidably orphaned and Capy says so). Shipping the
  token half alone would satisfy the letter of this ADR and none of its intent.
