/**
 * The page-side functions of the input verbs (T564 U4), as source strings for CDP `Runtime.callFunctionOn` against
 * the target element (`this`). They only MEASURE or set a value; the real input is CDP `Input.*`. They run in the
 * page's main world next to its own script, so their answers decide actionability, never security: a page that
 * lies to them can only make its own click land somewhere else on itself.
 */

/**
 * Measure the element: its viewport box, whether it can take input, what is at the click point. Argument: the
 * `offset` {x,y} inside the box, or `null` for the centre. Returns an `ElementProbe` (see `act-plan.ts`).
 */
export const PROBE_FN = `function (offset) {
  var el = this;
  var none = { rect: null, disabled: false, hit: 'none', editable: false, isSelect: false, tag: '' };
  if (!el || !el.isConnected) return none;
  var tag = (el.tagName || '').toLowerCase();
  var style = getComputedStyle(el);
  var r = el.getBoundingClientRect();
  var visible = r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  var rect = visible ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
  var disabled = el.disabled === true ||
    !!(el.closest && (el.closest('[aria-disabled="true"]') || el.closest('fieldset[disabled]')));
  var type = (el.type || '').toLowerCase();
  var isSelect = tag === 'select';
  var editable = tag === 'textarea' || el.isContentEditable === true ||
    (tag === 'input' && ['button','submit','reset','checkbox','radio','file','image','color','range','hidden'].indexOf(type) < 0 && el.readOnly !== true);
  var hit = 'none';
  if (rect) {
    var cx = r.left + (offset ? offset.x : r.width / 2);
    var cy = r.top + (offset ? offset.y : r.height / 2);
    var h = document.elementFromPoint(cx, cy);
    while (h && h.shadowRoot) {
      var inner = h.shadowRoot.elementFromPoint(cx, cy);
      if (!inner || inner === h) break;
      h = inner;
    }
    if (h) {
      var root = h.getRootNode && h.getRootNode();
      hit = (h === el || el.contains(h) || (root && root.host && (root.host === el || el.contains(root.host)))) ? 'self' : 'other';
    }
  }
  return { rect: rect, disabled: disabled, hit: hit, editable: editable, isSelect: isSelect, tag: tag };
}`

/** Select the element's whole content so the next insertion replaces it (inputs, text areas, editable regions). */
export const SELECT_CONTENT_FN = `function () {
  if (typeof this.select === 'function') { this.select(); return true; }
  var range = document.createRange();
  range.selectNodeContents(this);
  var sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  return true;
}`

/** Fire the events a user's edit would end with, after the text was inserted. */
export const NOTIFY_CHANGE_FN = `function () {
  this.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}`

/** Choose a `<select>` option by value, then by visible label; fire input and change. Argument: the wanted text. */
export const SET_SELECT_FN = `function (wanted) {
  var opts = Array.prototype.slice.call(this.options || []);
  var o = opts.filter(function (x) { return x.value === wanted; })[0] ||
    opts.filter(function (x) { return (x.label || x.text) === wanted; })[0];
  if (!o) return false;
  this.value = o.value;
  this.dispatchEvent(new Event('input', { bubbles: true }));
  this.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}`

/** Serialise the value of an evaluated object, or `undefined` when it cannot be (circular, a function, a node). */
export const SERIALIZE_FN = `function () {
  try { return JSON.stringify(this); } catch (e) { return undefined; }
}`
