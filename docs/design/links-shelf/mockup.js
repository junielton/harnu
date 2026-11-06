/* mockup.js — runtime shared by every screen of a mockup. Copied verbatim from the
 * create-mockup skill; never edited per project. Works over file:// and http://.
 *
 * What it does, nothing more:
 *  1. ?state=<name>  → sets data-state on <html> and on the [data-dsqa] root.
 *  2. data-goto="<screen>[?state=x]" on any element → navigates to ../screens/<screen>.html
 *     (query params other than state are carried over, e.g. ?lang=en). "back" = history.back().
 *  3. <form> never really submits; a form with data-goto navigates instead.
 *  4. Reports its size and position to the embedding index.html via postMessage, so the
 *     index can size the iframe without touching its document (cross-origin under file://).
 */
(() => {
  const params = new URLSearchParams(location.search);
  const root = document.querySelector('[data-dsqa]');
  const declared = (document.body.dataset.states || 'default').split(/\s+/).filter(Boolean);
  const state = params.get('state') || declared[0] || 'default';
  if (!declared.includes(state)) console.warn(`[mockup] state "${state}" is not declared in <body data-states>`);
  document.documentElement.dataset.state = state;
  if (root) root.dataset.state = state;

  const screenId = root ? root.dataset.dsqa : document.title.replace(/^screen:\s*/, '');

  const resolve = (target) => {
    if (target === 'back') return null;
    const [screen, query = ''] = target.split('?');
    const next = new URLSearchParams(location.search);
    next.delete('state');
    for (const [k, v] of new URLSearchParams(query)) next.set(k, v);
    const qs = next.toString();
    return `${screen}.html${qs ? '?' + qs : ''}`;
  };

  const go = (target) => {
    const href = resolve(target);
    if (href === null) return history.back();
    location.href = href;
  };

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-goto]');
    if (!el) return;
    e.preventDefault();
    go(el.dataset.goto);
  });

  document.addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.target.closest('form');
    if (form && form.dataset.goto) go(form.dataset.goto);
  });

  // Tell the embedding index who we are and how tall we are.
  const post = () => {
    if (window.parent === window) return;
    // content height, not viewport height: body margin is 0 by convention, fixed overlays don't count
    const height = Math.ceil(document.body.getBoundingClientRect().height);
    window.parent.postMessage({ type: 'mockup:size', screen: screenId, state, height }, '*');
  };
  const announce = () => {
    if (window.parent === window) return;
    window.parent.postMessage({ type: 'mockup:nav', screen: screenId, state }, '*');
  };
  addEventListener('load', () => { announce(); post(); });
  if ('ResizeObserver' in window) new ResizeObserver(post).observe(document.body);
  addEventListener('resize', post);
})();
