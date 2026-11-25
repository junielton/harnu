/* parts/helper-panes.js — sample helper stack: a guided walk + a browser pane on a CMS.
 * attr layout = column | row. */
customElements.define(
  'mk-helper-panes',
  class extends HTMLElement {
    connectedCallback() {
      const row = this.getAttribute('layout') === 'row'
      const ico = (d) =>
        `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`
      const close = ico('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>')
      const max = ico(
        '<path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="m21 3-7 7"/><path d="m3 21 7-7"/>'
      )
      this.style.display = 'contents'
      this.innerHTML = `
      <div class="helpers ${row ? 'row' : ''}" data-dsqa-part="helper-stack">
        <section class="pane" data-dsqa-part="walk-pane" style="flex: ${row ? '36' : '40'} 1 0">
          <div class="pane-head">${ico('<path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>')}<span class="t">Guided walk</span><span>Publish a page</span><span class="sp"></span>${max}${close}</div>
          <div class="pane-body walk">
            <div class="count">Check 3 of 7</div>
            <h4>Fill the page summary</h4>
            <p>The summary shows on the listing card, so it must be filled before publishing.</p>
            <ol><li>Open the Content tab</li><li>Click the Summary field</li><li>Type one sentence</li></ol>
            <p><b>Passes when</b> the field turns from red to normal.</p>
            <div class="acts"><button class="btn primary" type="button">Done</button><button class="btn" type="button">Failed</button><button class="btn" type="button">Skip</button></div>
          </div>
        </section>
        <section class="pane" data-dsqa-part="browser-pane" style="flex: ${row ? '64' : '60'} 1 0">
          <div class="pane-head">${ico('<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 0 20"/>')}<span class="t">Edit page · Example CMS</span><span class="sp"></span>${max}${close}</div>
          <div class="addr"><span class="bar">localhost:8080/admin/pages/42/edit</span></div>
          <div class="pane-body"><div class="cms">
            <div class="nav"><i></i><i class="on"></i><i></i><i></i><i></i><i></i></div>
            <div class="doc">
              <div class="field"><label>Title</label><div class="in">Spring catalog</div></div>
              <div class="field"><label>Summary</label><div class="in focus">|</div></div>
              <div class="field"><label>Body</label><div class="area ${row ? 'tall' : ''}"></div></div>
            </div>
          </div></div>
        </section>
      </div>`
    }
  }
)
