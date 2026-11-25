// The notes list: every note is drawn as a row with a data-note attribute.
export const notes = ['Milk run', 'Plan the week', 'Call the vet', 'Water the plants']

export function drawList(filter = '') {
  const word = filter.trim().toLowerCase()
  return notes
    .filter((n) => n.toLowerCase().includes(word))
    .map((n, i) => `<li data-note="${i}">${n}</li>`)
}
