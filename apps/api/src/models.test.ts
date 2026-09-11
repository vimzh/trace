import { expect, test } from 'bun:test'
import {
  parseExpectedModelVersion,
  parseModelVersionQuery,
} from './lib/request-version'

test('parses bare and quoted model-version preconditions', () => {
  expect(parseExpectedModelVersion(undefined)).toBeUndefined()
  expect(parseExpectedModelVersion('0')).toBe(0)
  expect(parseExpectedModelVersion('"42"')).toBe(42)
  expect(parseExpectedModelVersion('W/"42"')).toBeNull()
  expect(parseExpectedModelVersion('-1')).toBeNull()
  expect(parseExpectedModelVersion('1.5')).toBeNull()
  expect(parseExpectedModelVersion('9007199254740992')).toBeNull()
})

test('accepts only safe one-based historical model versions', () => {
  expect(parseModelVersionQuery(undefined)).toBeUndefined()
  expect(parseModelVersionQuery('1')).toBe(1)
  expect(parseModelVersionQuery('42')).toBe(42)
  expect(parseModelVersionQuery('0')).toBeNull()
  expect(parseModelVersionQuery('-1')).toBeNull()
  expect(parseModelVersionQuery('1.5')).toBeNull()
  expect(parseModelVersionQuery('abc')).toBeNull()
  expect(parseModelVersionQuery('9007199254740992')).toBeNull()
})
