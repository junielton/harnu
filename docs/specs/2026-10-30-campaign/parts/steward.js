/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-unused-vars -- standalone mockup runtime (browser script), not app code */
/* parts/steward.js — the mission-bound headless agent's last action and next wake.
 * attrs: last="rebased #317 onto main"  age="4m ago"  next="on CI change"
 *        feed='[{"t":"18:21","text":"…"}]' (optional, expands a short event feed) */
customElements.define(
  'mk-steward',
  class extends HTMLElement {
    connectedCallback() {
      const last = this.getAttribute('last') || 'idle'
      const age = this.getAttribute('age') || ''
      const next = this.getAttribute('next') || ''
      let feed = []
      try {
        feed = JSON.parse(this.getAttribute('feed') || '[]')
      } catch (e) {
        feed = []
      }
      this.innerHTML = `<div data-dsqa-part="steward"><div class="steward"><span class="bot" aria-hidden="true"></span><span class="who">Steward</span><span>·</span><span>${last}</span>${age ? `<span class="dim">· ${age}</span>` : ''}${next ? `<span class="next">next: ${next}</span>` : ''}</div>${feed.length ? `<div class="steward-feed">${feed.map((e) => `<div class="ev"><span class="t">${e.t}</span><span>${e.text}</span></div>`).join('')}</div>` : ''}</div>`
    }
  }
)
