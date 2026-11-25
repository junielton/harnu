customElements.define(
  'mk-toolbar',
  class extends HTMLElement {
    connectedCallback() {
      const state = this.getAttribute('state')
      const level = state === 'folders-folded' ? 0 : state === 'sessions-folded' ? 1 : 2
      const label = ['Expand all', 'Collapse folders', 'Collapse sessions'][level]
      const destinations = [
        'data-goto="sidebar"',
        'data-goto="sidebar?state=folders-folded"',
        'data-goto="sidebar?state=sessions-folded"'
      ]
      this.innerHTML = `<div class="toolbar" data-dsqa-part="toolbar">
      <button type="button" class="tb" title="Rescan folders" aria-label="Rescan folders">${icon('refresh')}</button>
      <button type="button" class="tb lvl" data-level="${level}" title="${label}" aria-label="${label}" ${destinations[level]}>
        ${icon(level === 0 ? 'expand' : 'collapse')}
      </button>
      <button type="button" class="tb hidden-count" title="Hidden (46)" aria-label="Hidden (46)">${icon('hidden')}46</button>
      <span class="sep"></span>
      <button type="button" class="tb" title="Jump to a folder or session" aria-label="Jump to a folder or session">${icon('search')}</button>
    </div>`
    }
  }
)
