/* parts/footer.js — StatusFooter.vue with the GitHub budget slot. Light DOM.
 * Attributes:
 *   gh    = "fleet" (A: a segment inside the fleet pill) | "pill" (B: its own pill)
 *           | "alert" (C: only when low) | "none"
 *   data-goto = the GitHub element's target (the popover state). Declared on the host so the
 *               checker sees it; moved onto the GitHub element at render time.
 * Levels follow the screen's data-state via [data-show]: healthy (closed/healthy),
 * low (low/low-open), exhausted. */
const GH_ICON =
  '<svg class="ic" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/></svg>'
const ICON = {
  cpu: '<svg class="ic" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6"/></svg>',
  gauge:
    '<svg class="ic" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/></svg>',
  branch:
    '<svg class="ic" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="6" cy="18" r="2"/><circle cx="6" cy="6" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 8v8"/><path d="M18 10c0 4-6 3-10 6"/></svg>',
  recycle:
    '<svg class="ic" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M7 19H4.8a1.8 1.8 0 0 1-1.6-2.7L7 9.6"/><path d="m11 19 3 3 3-3"/><path d="M14 22v-9"/><path d="m9.3 6.4 1.2-2a1.8 1.8 0 0 1 3.1 0l3.9 6.6"/><path d="m13.4 9 3.9 1.1 1.1-3.9"/></svg>',
  clock:
    '<svg class="ic" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  alert:
    '<svg class="ic" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>'
}

customElements.define(
  'mk-footer',
  class extends HTMLElement {
    connectedCallback() {
      const gh = this.getAttribute('gh') || 'none'
      const goto = this.dataset.goto || ''
      this.removeAttribute('data-goto')
      const g = goto ? ' data-gh-goto' : ''

      const fleetGh =
        gh !== 'fleet'
          ? ''
          : `
      <span class="sep"></span>
      <span class="seg" data-show="closed healthy"><span class="t3">gh</span><span class="t2 num">·38m</span><span class="num t2">18%</span></span>
      <span class="seg" data-show="low"><span class="t3">gh</span><span class="t2 num">·21m</span><span class="num is-accent">87%</span></span>
      <span class="seg" data-show="exhausted"><span class="t3">gh</span><span class="t2 num">·12m</span><span class="num is-red">100%</span></span>`

      const ownPill =
        gh !== 'pill'
          ? ''
          : `
      <button type="button" class="fpill" data-dsqa-part="gh-pill" data-show="closed healthy"${g}>${GH_ICON}<span class="num">4,112 left</span></button>
      <button type="button" class="fpill tone-warn" data-dsqa-part="gh-pill" data-show="low"${g}>${GH_ICON}<span class="num">640 left</span></button>
      <button type="button" class="fpill tone-red" data-dsqa-part="gh-pill" data-show="exhausted"${g}>${GH_ICON}<span class="num">0 left · 12m</span></button>`

      const alertPill =
        gh !== 'alert'
          ? ''
          : `
      <button type="button" class="fpill tone-warn" data-dsqa-part="gh-pill" data-show="low low-open"${g}>${ICON.alert}<span>GitHub</span><span class="num">13% left</span></button>
      <button type="button" class="fpill tone-red" data-dsqa-part="gh-pill" data-show="exhausted"${g}>${ICON.alert}<span>GitHub limit</span><span class="num">· 12m</span></button>`

      this.innerHTML = `
      <footer class="footer" data-dsqa-part="footer">
        <span class="chip">${ICON.cpu}Opus 5.5</span>
        <span class="chip">${ICON.gauge}<span class="num">42%</span></span>
        <span class="chip mono">${ICON.branch}feat/checkout-v2</span>
        <span class="chip num">$3.12</span>
        <div class="right">
          <span class="chip"><span class="dot7 bg-green"></span><span class="num">3</span></span>
          <span class="dot bg-green" title="Claude status"></span>
          <span class="heap">heap<span class="track"><i style="width: 31%"></i></span><span class="num">31%</span></span>
          ${alertPill}
          ${ownPill}
          <button type="button" class="fpill">${ICON.recycle}<span class="num">4.2 GB</span></button>
          <button type="button" class="fpill is-quiet">${ICON.clock}<span>Scheduler</span></button>
          <button type="button" class="fleet" data-dsqa-part="fleet-pill"${gh === 'fleet' ? g : ''}>
            <span class="seg"><span class="t3">5h</span><span class="num">·2h14m</span><span class="num">42%</span></span>
            <span class="seg"><span class="t3">7d</span><span class="num">·3d</span><span class="num">61%</span></span>
            <span class="num">$18.40</span>
            ${fleetGh}
          </button>
        </div>
      </footer>`
      if (goto)
        this.querySelectorAll('[data-gh-goto]').forEach((el) => el.setAttribute('data-goto', goto))
    }
  }
)
window.MK_GH_ICON = GH_ICON
