/* parts/tuck-strip.js — the edge strip left where the tucked session was.
 * attrs: orient = v | h, state = idle | hover | needs. The screen wraps it in the data-goto that restores. */
customElements.define(
  'mk-tuck-strip',
  class extends HTMLElement {
    connectedCallback() {
      const h = this.getAttribute('orient') === 'h'
      const st = this.getAttribute('state') || 'idle'
      const cls = [
        'tuck',
        h ? 'h' : '',
        st === 'hover' ? 'hover' : '',
        st === 'needs' ? 'needs' : ''
      ].join(' ')
      const needs = st === 'needs'
      this.innerHTML = `
      <div class="${cls}" data-dsqa-part="tuck-strip" role="button" tabindex="0"
           aria-label="Show session Walk the CMS editor">
        <span class="dot" data-dsqa-part="tuck-dot"></span>
        <span class="grip"><i></i><i></i><i></i></span>
        <svg class="chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
        <span class="tag">Needs you</span>
        <div class="chip" data-dsqa-part="tuck-chip">
          <div class="n"><span class="dot"></span>Walk the CMS editor</div>
          <div class="s">${needs ? 'Waiting for your approval' : 'Idle · harnu / main'}</div>
          <div class="h">Click or drag to bring it back</div>
          <div class="k"><kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>J</kbd></div>
        </div>
      </div>`
    }
  }
)
