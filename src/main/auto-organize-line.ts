/**
 * The auto-organize toggle-awareness line (T106/D6), as a pure string builder.
 *
 * `getUserProjectAutoOrganize` (`user-projects.ts`) resolves the per-repo
 * boolean (own value, else inherited from the parent repo, else default ON);
 * this module turns it into the ONE runtime line appended to the self-
 * awareness preamble (`pty.ts`, mirroring `memory-language.ts`'s pattern for
 * the T85 language line) so a session always sees the CURRENT toggle for its
 * own folder, not a stale doc snapshot.
 *
 * Framework-free + side-effect-free per ADR-0001 (pure-core / thin-shell) —
 * unit-testable without electron.
 */

/**
 * The single runtime line the self-awareness preamble appends (T106): states
 * plainly whether this repo's auto-organize toggle is ON or OFF, so a session
 * that can see the roadmap board (`docs/harnu-features.md` — "Roadmap board")
 * knows whether drafting cards from conversation on its own initiative is
 * welcome here. No enforcement lives behind this — it is model behavior,
 * governed by the conservative task-smell contract in
 * `docs/harnu-orchestrator.md`.
 *
 * @param enabled - the resolved per-repo toggle (own value, else inherited).
 * @returns one Markdown line for the preamble.
 */
export function autoOrganizeLine(enabled: boolean): string {
  return (
    `**Auto-organize toggle.** This repo's "Auto-organize conversation into draft ` +
    `cards" folder setting is currently **${enabled ? 'ON' : 'OFF'}**. When ON, drafting a ` +
    `\`backlog\` card from a deferred-change intent in conversation (never from ` +
    `exploratory talk) is welcome, following the conservative task-smell contract. ` +
    `When OFF, do not create cards on your own initiative for this repo — only when ` +
    `explicitly asked.`
  )
}
