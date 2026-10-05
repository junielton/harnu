# Claude Boot

"Claude Boot" is Harnu's name for the launch options that control how a `claude` process actually gets started — which model, how much effort, which permission mode, which flags. The same form is reused at three levels that layer on top of each other, most specific wins:

- **Global** (Settings → Startup) — your defaults for every session.
- **Folder** (right-click a folder → **Startup options…**) — overrides for everything launched in that folder.
- **Session** (the New Session dialog's **Advanced** section) — a one-shot override for just the session you're about to start; it's never saved anywhere, it only applies to that launch.

## What you can configure

The form covers: model (Opus, Sonnet, Haiku, Fable) and effort/reasoning level; permission mode; integrations like Chrome and IDE hooks; context options (a system-prompt append, a pre-prompt, extra directories); allowed/disallowed tools; MCP config; session identity (agent name, resuming from a PR); and a handful of advanced flags (verbose output, a "bare" launch, safe mode). There's also a free-text field for any raw CLI flag not otherwise exposed, with a live warning if something you type there would actually get stripped before launch. A separate danger-zone toggle exists for `--dangerously-skip-permissions` — off by default, and worth leaving off unless you specifically know why you need it.

Each field is tri-state (inherit the level above / explicit on / explicit off) so a folder-level override only needs to specify what's actually different from your global defaults, not repeat the whole form.

Per-folder launch settings are also where you configure the model-routing table used when dispatching [roadmap board](roadmap-board.md#model-routing) cards.

## Custom endpoints

If you want a session to talk to a different Claude-compatible endpoint instead of Anthropic's API directly (a local model, a proxy, an alternate provider), register it under **Settings → Endpoints**: a name, the model it serves, a base URL, and an auth token. Once registered, you can pick it from the provider selector in any Claude Boot form — picking a non-default provider switches the model field to free text, since the routing table doesn't know that provider's model names.

**Auth tokens for custom endpoints are stored in plaintext** in a `claude-boot.json` file inside Harnu's app data directory — they are not encrypted at rest. Treat that file as sensitive, and be aware the Endpoints screen itself doesn't currently warn you about this in the UI; this is the one place documenting it clearly.

There's no "test connection" button yet — adding an endpoint doesn't verify it actually works until you launch a session against it.
