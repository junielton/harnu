customElements.define(
  'mk-attention',
  class extends HTMLElement {
    connectedCallback() {
      const urgent = statusPriority
        .slice(0, 2)
        .flatMap((status) => allSessions.filter((session) => session.status === status))
      const open = this.getAttribute('variant') !== 'folded'
      this.innerHTML = `<div class="attn" data-dsqa-part="attention">
      <button type="button" class="attn-head" aria-expanded="${open}">
        ${icon('right', 12)} Needs attention <span class="attn-count">${urgent.length}</span>
      </button>
      <div ${open ? '' : 'hidden'}>
        ${urgent
          .map(
            (
              session
            ) => `<button type="button" class="arow" data-attention-session="${session.id}" title="${session.reason}">
          ${ring(session.status)}
          <span class="arow-txt"><span class="truncate arow-title">${session.title}</span><span class="truncate arow-folder">${session.folder}</span></span>
        </button>`
          )
          .join('')}
      </div>
    </div>`

      const head = this.querySelector('.attn-head')
      head.addEventListener('click', () => {
        const expanded = head.getAttribute('aria-expanded') === 'false'
        head.setAttribute('aria-expanded', expanded)
        head.nextElementSibling.hidden = !expanded
      })
    }
  }
)
