/* parts/session-term.js — the main Claude Code terminal, sample output. */
customElements.define(
  'mk-session-term',
  class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `<div class="term" data-dsqa-part="session-term"><span class="m">╭─ Claude Code ─────────────────╮</span>
<span class="u">&gt; walk me through publishing a page</span>

<span class="a">●</span> Opened a guided walk with 7 checks
  and a browser pane on the CMS.

<span class="a">●</span> Waiting for check 3.

<span class="g">✓</span> Check 1 passed
<span class="g">✓</span> Check 2 passed

<span class="m">───────────────────────────────</span>
<span class="u">&gt;</span> </div>`
    }
  }
)
