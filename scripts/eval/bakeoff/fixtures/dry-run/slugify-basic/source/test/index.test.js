import assert from 'node:assert/strict'
import { test } from 'node:test'
import { identity } from '../index.js'

test('identity returns its argument', () => {
  assert.equal(identity(1), 1)
})
