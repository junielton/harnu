/* eslint-disable @typescript-eslint/explicit-function-return-type -- standalone mockup runtime (browser script), not app code */
/* parts/gates.js — four facts that make a step "done": PR · CI · main · verifier.
 * attrs: pr|ci|main|verifier = green|red|running|off|na   labels=1 (print the words) */
customElements.define(
  'mk-gates',
  class extends HTMLElement {
    connectedCallback() {
      const keys = ['pr', 'ci', 'main', 'verifier']
      const names = {
        pr: 'PR merged',
        ci: 'CI green on PR',
        main: 'main green after merge',
        verifier: 'Verifier verdict'
      }
      const labels = this.hasAttribute('labels')
      const dots = keys
        .map((k) => {
          const v = this.getAttribute(k) || 'off'
          return `<span class="gate gate--${v}" title="${names[k]}: ${v}" data-gate="${k}"></span>${labels ? `<span class="lbl">${k}</span>` : ''}`
        })
        .join('')
      this.innerHTML = `<span class="gates" data-dsqa-part="gates">${dots}</span>`
    }
  }
)
