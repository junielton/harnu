/* parts/monitor-head.js — the System Monitor's TakeoverShell header (Cpu icon, title,
 * subtitle, inline heap gauge, close). Light DOM so tokens cascade. Attribute: sub. */
customElements.define(
  'mk-monitor-head',
  class extends HTMLElement {
    connectedCallback() {
      const sub = this.getAttribute('sub') || '5 processes · 4 live · 2 parked'
      const svg = (p) =>
        `<svg class="ic" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`
      this.innerHTML = `
      <div class="thead" data-dsqa-part="monitor-head">
        <span class="accent">${svg('<rect width="16" height="16" x="4" y="4" rx="2"/><rect width="6" height="6" x="9" y="9" rx="1"/><path d="M15 2v2"/><path d="M15 20v2"/><path d="M2 15h2"/><path d="M2 9h2"/><path d="M20 15h2"/><path d="M20 9h2"/><path d="M9 2v2"/><path d="M9 20v2"/>')}</span>
        <span class="ttl">System Monitor</span>
        <span class="sub">${sub}</span>
        <span class="sp"></span>
        <span class="heapmini"><span class="heap-ok">heap <span class="bar"><b style="width:3%"></b></span> 3%</span><span class="heap-warn">heap <span class="bar is-warn"><b style="width:78%"></b></span> 78%</span></span>
        <button type="button" class="iconbtn" aria-label="Close">${svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>')}</button>
      </div>`
    }
  }
)
