import { expect, test } from 'bun:test'
import { inspectBinaryStl } from './run-corpus'

test('STL verification rejects empty, truncated, and mismatched binary meshes', () => {
  const storage = new Uint8Array(140)
  const stl = storage.subarray(6)
  new DataView(stl.buffer, stl.byteOffset, stl.byteLength).setUint32(80, 1, true)
  expect(inspectBinaryStl(stl)).toEqual({ bytes: 134, triangles: 1 })
  expect(() => inspectBinaryStl(stl.subarray(0, 83))).toThrow('binary header')
  expect(() => inspectBinaryStl(stl.subarray(0, 133))).toThrow('byte length')
  expect(() => inspectBinaryStl(new Uint8Array(84))).toThrow('no triangles')
})
