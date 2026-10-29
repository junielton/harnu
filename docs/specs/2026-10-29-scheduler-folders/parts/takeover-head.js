/* parts/takeover-head.js — the Scheduler's TakeoverShell header, unchanged from today.
 * Light DOM so tokens cascade. Attribute: sub (the live subtitle). */
customElements.define(
  'mk-takeover-head',
  class extends HTMLElement {
    connectedCallback() {
      const sub = this.getAttribute('sub') || '17 workers · 1 running'
      const svg = (p) =>
        `<svg class="ic" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`
      this.innerHTML = `
      <div class="thead" data-dsqa-part="takeover-head">
        <span class="accent">${svg('<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>')}</span>
        <span class="ttl">Scheduler</span>
        <span class="sub">${sub}</span>
        <span class="sp"></span>
        <button type="button" class="btn-primary">${svg('<path d="M5 12h14"/><path d="M12 5v14"/>')}New worker</button>
        <button type="button" class="iconbtn" aria-label="Close">${svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>')}</button>
      </div>`
    }
  }
)
