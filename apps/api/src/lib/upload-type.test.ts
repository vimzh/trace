import { expect, test } from 'bun:test'
import { detectUploadExtension } from './upload-type'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

test('detects upload content independently of request metadata', () => {
  expect(detectUploadExtension(PNG)).toBe('png')
  expect(detectUploadExtension(Buffer.from('%PDF-broken'))).toBe('pdf')
  expect(detectUploadExtension(Buffer.from('not an image'))).toBeUndefined()
})
