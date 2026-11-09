import assert from 'node:assert/strict'
import { test } from 'node:test'
import { slugify } from '../index.js'

test('A-1 lowercases the text', () => {
  assert.equal(slugify('AbC'), 'abc')
})

test('A-2 collapses each run into one hyphen', () => {
  assert.equal(slugify('a  b__c!!d'), 'a-b-c-d')
})

test('A-3 trims hyphens from both ends', () => {
  assert.equal(slugify('  a b  '), 'a-b')
})
