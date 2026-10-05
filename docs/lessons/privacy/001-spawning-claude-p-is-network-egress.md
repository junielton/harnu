# 001-spawning-claude-p-is-network-egress: shelling out to `claude -p <content>` sends user content off-machine

**Category:** privacy
**Discovered in:** OSS-readiness audit, `feat/capy-mcp-server` (Jun 2026)
**Status:** active

## The bug class

Several features spawn the user's own CLI with session content as the prompt —
session auto-naming (`src/main/haiku.ts`, `haiku-autoname.ts`) and live-pulse
(`src/main/pulse-prompt.ts`) run `claude -p '<prompt/transcript text>' --model haiku`.
Even though it "just shells out to the local CLI," that **transmits session
content to Anthropic over the network** on the user's subscription. So the
README's "no daemon, no cloud, no account — a faithful UI over local files" is
imprecise. There are also background HTTP destinations the same claim glosses
over: `status.claude.com` (service status), the raw `CHANGELOG` on GitHub, and
GitHub Releases (auto-update).

## Root cause

Conflating "runs locally" with "stays local". Spawning a network-backed CLI with
user content **is** egress. Redaction helpers (`src/main/mcp/transcript-redact.ts`)
are explicitly best-effort and miss most modern secret formats — they are a
backstop, never the boundary.

## The fix (and why)

1. Keep content-egress features **opt-in** (auto-name already defaults OFF — keep
   it that way) and make the toggle copy state **exactly what is sent and where**.
2. Ship a "Network activity" section in the README that enumerates every outbound
   destination, separating always-on telemetry-free pings from the opt-in
   LLM-content features.
3. Gate any transcript disclosure (e.g. an MCP `get_session`) behind an explicit
   **folder allowlist**; treat redaction as defense-in-depth, and if you do redact,
   cover the modern prefixes (`ghp_`, `sk-`, `xox[bp]-`, `AIza`, `sk_live_`),
   colon-delimited `key: value`, URL-embedded credentials, and JWTs.

## How to detect in reviews

1. `git grep -nE "claude'|'claude'|-p'|'-p'" src/main` — does any spawn pass
   user/transcript/prompt text to a network-backed CLI? Is it opt-in + disclosed?
2. Any new outbound `fetch`/`request`/host, or any feature that reads transcript
   text and forwards it anywhere.
3. Any "local / offline / no cloud / private" claim in UI or docs — reconcile it
   against the actual egress list.

## Related

- `src/main/haiku.ts`, `src/main/pulse-prompt.ts` — the content-egress features
- `src/main/mcp/transcript-redact.ts` — best-effort redactor (not a boundary)
- `src/main/claude-status.ts`, `src/main/updater.ts` — always-on background HTTP
