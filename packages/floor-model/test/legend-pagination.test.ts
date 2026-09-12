import { expect, test } from 'bun:test'
import { BRAILLE_MM, paginateBrailleRows, textBrailleSize, textToBrailleCells } from '../src'

const narrowPlate = { heightMm: 44, marginMm: 10, widthMm: 60 }
const usableWidth = narrowPlate.widthMm - 2 * narrowPlate.marginMm
const rowHeight = textBrailleSize('a').heightMm
const maxRows = Math.floor(
  (narrowPlate.heightMm - 2 * narrowPlate.marginMm - rowHeight) / BRAILLE_MM.linePitch,
) + 1

test('paginates long destination names without losing words or numeric tokens', () => {
  const row = 'north entrance to community services 202612345678901234567890'
  const pages = paginateBrailleRows([row], narrowPlate)
  const lines = pages.flat()

  expect(lines.length).toBeGreaterThan(1)
  expect(pages.every((page) => page.length <= maxRows)).toBe(true)
  expect(lines.every((line) => textBrailleSize(line).widthMm <= usableWidth)).toBe(true)
  expect(lines.join('').replaceAll(' ', '')).toBe(row.replaceAll(' ', ''))
  expect(lines.filter((line) => /\d/.test(line)).length).toBeGreaterThan(1)
  expect(lines.every((line) => textToBrailleCells(line).length <= Math.floor(usableWidth / BRAILLE_MM.cellPitch))).toBe(true)
})

test('keeps a short legend row unchanged on one page', () => {
  expect(paginateBrailleRows(['a  lobby'], { ...narrowPlate, widthMm: 100 })).toEqual([['a  lobby']])
})
