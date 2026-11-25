import { drawList } from './list.js'

// The search box: filters as you type, Escape clears it.
export function onInput(box, out) {
  out.innerHTML = drawList(box.value).join('') || '<p>No notes match</p>'
}

export function onKey(box, out, key) {
  if (key === 'Escape') {
    box.value = ''
    onInput(box, out)
  }
}
