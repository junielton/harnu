/**
 * The CSS of the guest-drawn layers (T564 U6, design.md "Point-and-comment overlay"). They live in a closed
 * shadow root inside ANOTHER document, so they cannot use the app's Tailwind classes or CSS variables; the two
 * theme colours arrive with the overlay state and are set as custom properties on the shadow host. The rest are
 * the literal dark-theme values the design contract names, kept in this one block.
 */
export const OVERLAY_CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.layer { position: fixed; inset: 0; pointer-events: none; overflow: hidden; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
.hl { position: absolute; border: 1.5px solid var(--accent); background: color-mix(in srgb, var(--accent) 14%, transparent); border-radius: 3px; pointer-events: none; display: none; }
.hl-tag { position: absolute; left: -1.5px; top: calc(100% + 3px); background: var(--accent); color: var(--accent-ink); font: 10.5px/1.3 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; padding: 2px 6px; border-radius: 0 3px 3px 3px; white-space: nowrap; }
.hl.flip .hl-tag { top: auto; bottom: calc(100% + 3px); border-radius: 3px 3px 3px 0; }
.hint { position: absolute; top: 8px; left: 50%; transform: translateX(-50%); background: rgba(23, 18, 14, 0.92); color: #e8e6e3; font-size: 11px; line-height: 1.4; padding: 4px 10px; border-radius: 999px; display: none; gap: 8px; align-items: center; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4); white-space: nowrap; pointer-events: none; }
.hint.on { display: flex; }
.hint svg { width: 12px; height: 12px; flex: none; }
.pin { position: absolute; left: 0; top: 0; width: 20px; height: 20px; border-radius: 50% 50% 50% 2px; display: grid; place-items: center; font-size: 10.5px; font-weight: 600; box-shadow: 0 2px 6px rgba(0, 0, 0, 0.35); pointer-events: auto; cursor: pointer; transition: background-color 80ms ease, opacity 80ms ease; padding: 0; margin: 0; border: 0; font-family: inherit; }
.pin.draft { background: #fff; color: var(--accent); border: 2px solid var(--accent); }
.pin.sent { background: var(--accent); color: var(--accent-ink); opacity: 0.55; }
.pin.detached { border: 2px dashed #7f849c; color: #7f849c; background: #fff; opacity: 0.85; }
.pin.sent.detached { background: transparent; color: #7f849c; }
.kbd { font: 10.5px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; border: 1px solid #5b6078; border-bottom-width: 2px; border-radius: 4px; padding: 0 4px; color: #c8c6c3; }
@media (prefers-reduced-motion: reduce) { .pin { transition: none; } }
`
