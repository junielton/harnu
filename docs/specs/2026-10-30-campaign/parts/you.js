/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-unused-vars -- standalone mockup runtime (browser script), not app code */
/* parts/you.js — the "You" lane: what the operator owes, aged and risk-sorted.
 * attrs: tone=clear|warning|success  first="sentence"  items='[{"text":"…","age":"2h","risk":"high|mid|low","goto":"…"}]'
 *        more=n  action="Button label"  action-goto="screen?state=…"  action-tone=primary|success|warning */
customElements.define(
  'mk-you',
  class extends HTMLElement {
    connectedCallback() {
      const tone = this.getAttribute('tone') || 'clear'
      const first = this.getAttribute('first') || "Nothing — you're clear."
      let items = []
      try {
        items = JSON.parse(this.getAttribute('items') || '[]')
      } catch (e) {
        items = []
      }
      const more = this.getAttribute('more')
      const action = this.getAttribute('action')
      const actionGoto = this.getAttribute('action-goto')
      const actionTone = this.getAttribute('action-tone') || 'primary'
      const warn =
        '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>'
      const ok =
        '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>'
      const head =
        tone === 'clear'
          ? `<div class="you-clear">${first}</div>`
          : `<div class="you-box you-box--${tone}">${tone === 'success' ? ok : warn}<div><div>${first}</div>${action ? `<div style="margin-top:6px"><button type="button" class="btn btn--${actionTone}" ${actionGoto ? `data-` + `goto="${actionGoto}"` : ''}>${action}</button></div>` : ''}</div></div>`
      const list = items.length
        ? `<div class="you-list" style="margin-top:6px">${items.map((i) => `<div class="you-item" ${i.goto ? `data-` + `goto="${i.goto}"` : ''}><span class="risk risk--${i.risk || 'low'}">●</span><span>${i.text}</span><span class="sp"></span><span class="age">${i.age || ''}</span></div>`).join('')}</div>`
        : ''
      this.innerHTML = `<div class="you" data-dsqa-part="you"><div class="eyebrow">You</div>${head}${list}${more ? `<button type="button" class="you-more">+${more} more</button>` : ''}</div>`
    }
  }
)
