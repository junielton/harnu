/**
 * The shared merge fixture table (T536 U3). One table, two consumers:
 * `tests/canvas-style.test.ts` runs it through the renderer's `mergeCanvasStyle`,
 * and `tests/canvas-style-parity.test.ts` runs it through BOTH that function and
 * the real `applyCanvasOps` `update_node` `style` path in `src/main`, so the two
 * implementations of the merge cannot disagree about a single case.
 *
 * Every `patch` is valid for a `box` (which takes all seven keys), because the
 * agent path validates the patch against the node's shape before merging.
 * `props`/`expected` are built with `JSON.parse` where a key is `__proto__`: an
 * object literal would set the prototype instead of an own property, and the
 * point of those cases is a file that really carries such a key.
 */

export interface StyleMergeCase {
  name: string
  /** The node's `props` before the merge (`undefined` = the node has none). */
  props: Record<string, unknown> | undefined
  patch: Record<string, string | number | null>
  /** The node's `props` after the merge (`undefined` = the key is gone). */
  expected: Record<string, unknown> | undefined
}

const json = (text: string): Record<string, unknown> => JSON.parse(text)

export const STYLE_MERGE_CASES: readonly StyleMergeCase[] = [
  {
    name: 'sets a key on a node with no props',
    props: undefined,
    patch: { tone: 'green' },
    expected: { style: { tone: 'green' } }
  },
  {
    name: 'merges per key and keeps the keys it was not told about',
    props: { style: { tone: 'green', stroke: 'dashed' } },
    patch: { stroke: 'dotted', fontSize: 'xl' },
    expected: { style: { tone: 'green', stroke: 'dotted', fontSize: 'xl' } }
  },
  {
    name: 'null removes a key',
    props: { style: { tone: 'green', stroke: 'dashed' } },
    patch: { tone: null },
    expected: { style: { stroke: 'dashed' } }
  },
  {
    name: 'a value equal to the default removes the key',
    props: { style: { tone: 'green', opacity: 50 } },
    patch: { opacity: 100 },
    expected: { style: { tone: 'green' } }
  },
  {
    name: 'writing a default over nothing leaves nothing behind',
    props: undefined,
    patch: { tone: 'default' },
    expected: undefined
  },
  {
    name: 'a key this build does not know is kept verbatim',
    props: { style: { tone: 'green', glow: 'max' } },
    patch: { stroke: 'dashed' },
    expected: { style: { tone: 'green', glow: 'max', stroke: 'dashed' } }
  },
  {
    name: 'an unknown value for a known key, not named by the patch, is kept verbatim',
    props: { style: { tone: 'purple' } },
    patch: { stroke: 'dashed' },
    expected: { style: { tone: 'purple', stroke: 'dashed' } }
  },
  {
    name: 'an emptied style is dropped, and props that held only it go with it',
    props: { style: { tone: 'green' } },
    patch: { tone: null },
    expected: undefined
  },
  {
    name: 'an emptied style is dropped but the other props stay',
    props: { src: 'assets/a.png', style: { opacity: 50 } },
    patch: { opacity: null },
    expected: { src: 'assets/a.png' }
  },
  {
    name: 'props that were already empty are not dropped by a style write that changes nothing',
    props: {},
    patch: { tone: 'default' },
    expected: {}
  },
  {
    name: 'props without a style survive a reset patch',
    props: { src: 'assets/a.png' },
    patch: { tone: null },
    expected: { src: 'assets/a.png' }
  },
  {
    name: 'a non-object style in the file is replaced by the merge',
    props: { style: 'red' },
    patch: { tone: 'green' },
    expected: { style: { tone: 'green' } }
  },
  {
    name: 'file keys named __proto__ and constructor survive as data',
    props: json('{"style":{"__proto__":"x","constructor":"y","tone":"green"}}'),
    patch: { stroke: 'dashed' },
    expected: json('{"style":{"__proto__":"x","constructor":"y","tone":"green","stroke":"dashed"}}')
  },
  {
    name: 'file keys named __proto__ and constructor survive a removal of a known key',
    props: json('{"style":{"__proto__":"x","constructor":"y","tone":"green"}}'),
    patch: { tone: null },
    expected: json('{"style":{"__proto__":"x","constructor":"y"}}')
  }
]
