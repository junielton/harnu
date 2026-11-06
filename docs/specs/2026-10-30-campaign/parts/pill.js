/* eslint-disable @typescript-eslint/explicit-function-return-type -- standalone mockup runtime (browser script), not app code */
/* parts/pill.js — the Topbar pill (design.md §6 "Mission progress"). Light DOM.
 * attrs: tone=neutral|accent|warning|green  label="Ch. 9/12"  sub="· Step 1/4"
 *        icon=list|check|flag  goto="screen?state=…" (optional) */
customElements.define(
  'mk-pill',
  class extends HTMLElement {
    connectedCallback() {
      const tone = this.getAttribute('tone') || 'accent'
      const label = this.getAttribute('label') || ''
      const sub = this.getAttribute('sub') || ''
      const icon = this.getAttribute('icon') || 'list'
      const goto = this.getAttribute('goto')
      const icons = {
        list: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/></svg>',
        check:
          '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
        flag: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 22V4a1 1 0 0 1 .4-.8A6 6 0 0 1 8 2c3 0 5 2 7.3 2 1.5 0 2.6-.4 3.7-1v10c-1.1.6-2.2 1-3.7 1C13 14 11 12 8 12a6 6 0 0 0-4 1"/></svg>'
      }
      this.innerHTML = `<button type="button" class="pill pill--${tone}" data-dsqa-part="pill" data-tone="${tone}" ${goto ? `data-` + `goto="${goto}"` : ''}>${icons[icon] || icons.list}<span class="num">${label}</span>${sub ? `<span class="sub num">${sub}</span>` : ''}</button>`
    }
  }
)
