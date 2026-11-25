customElements.define(
  'mk-dock',
  class extends HTMLElement {
    connectedCallback() {
      const open = this.getAttribute('variant') === 'open'
      const needs =
        '<span>Needs you</span><span class="dk-n">1</span><span class="dk-age">11m</span>'
      const returns =
        '<span>Return here</span><span class="dk-n">2</span><span class="dk-age">25m</span>'
      const moves = [
        {
          kind: 'Decide',
          ask: 'Pick the cache backend for the rate limiter',
          folder: 'api-gateway',
          blocks: 'PROJ-231',
          age: '25m'
        },
        {
          kind: 'Go / no-go',
          ask: 'Merge the OSC 8 hyperlink fix (PR 381)?',
          folder: 'harnu',
          blocks: 'release',
          age: '1h'
        }
      ]
      const dockHead = (
        text
      ) => `<button type="button" class="dk-head chrome-hover" aria-expanded="${open}"
      ${open ? 'data-goto="sidebar"' : 'data-goto="sidebar?state=dock-open"'}>${text}${icon('right', 12)}</button>`
      this.innerHTML = `
      <section class="island dk" data-dsqa-part="needs-you">
        ${dockHead(needs)}
        <div class="dk-content" ${open ? '' : 'hidden'}>
          <div class="permission">
            <div class="permission-head">${ring('needs')}<span class="truncate">Allow Bash?</span>
              <span class="permission-folder">${icon('folder', 11)}api-gateway</span>
            </div>
            <div class="mono truncate permission-command">npm run migrate -- --step 3</div>
            <div class="permission-actions">
              <button type="button" class="primary">Allow</button><button type="button">Deny</button>
            </div>
          </div>
        </div>
      </section>
      <section class="island dk" data-dsqa-part="return-here">
        ${dockHead(returns)}
        <div class="dk-content" ${open ? '' : 'hidden'}>
          ${moves
            .map(
              (move) => `<div class="return-card">
            <div class="return-head"><span class="return-kind">${move.kind}</span><span>${move.folder}</span></div>
            <div class="return-ask">${move.ask}</div>
            <div class="return-meta">blocks: ${move.blocks} · ${move.age}</div>
          </div>`
            )
            .join('')}
        </div>
      </section>
      <div class="island sb-add">
        <button type="button" class="add-folder chrome-hover">${icon('plus')}Add folder</button>
        <button type="button" class="tb" title="Settings" aria-label="Settings">${icon('settings')}</button>
      </div>`

      if (!this.closest('[data-dsqa="sidebar"]')) {
        this.querySelectorAll('.dk-head').forEach((head) => head.removeAttribute('data-goto'))
      }
    }
  }
)
