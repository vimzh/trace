// Text rendering must fit the same top-left rectangles used by layout validation.
import { expect, test } from 'bun:test'
import { BRAILLE_MM, cellDotCenters, textBrailleSize, textDotCenters } from '../src'

test('text dots, including their radius, fit the reserved top-left footprint', () => {
  const origin = { x: 13.25, y: 27.5 }
  const radius = BRAILLE_MM.dotDiameter / 2
  for (const text of ['a', 'c', 'wf', 'qx', '123', 'a 9', ' x ', '', ' ']) {
    const size = textBrailleSize(text)
    for (const dot of textDotCenters(text, origin)) {
      expect(dot.x - radius).toBeGreaterThanOrEqual(origin.x)
      expect(dot.y - radius).toBeGreaterThanOrEqual(origin.y)
      // Arithmetic grouping can differ by a few double-precision ULPs.
      expect(dot.x + radius - origin.x - size.widthMm).toBeLessThanOrEqual(1e-12)
      expect(dot.y + radius - origin.y - size.heightMm).toBeLessThanOrEqual(1e-12)
    }
  }
  const dots = textDotCenters('qx', origin)
  const size = textBrailleSize('qx')
  expect(Math.min(...dots.map(dot => dot.x - radius))).toBe(origin.x)
  expect(Math.min(...dots.map(dot => dot.y - radius))).toBe(origin.y)
  expect(Math.max(...dots.map(dot => dot.x + radius))).toBeCloseTo(origin.x + size.widthMm, 12)
  expect(Math.max(...dots.map(dot => dot.y + radius))).toBe(origin.y + size.heightMm)
})

test('text origin offset preserves cell spacing, number prefixes, and cell-level centers', () => {
  const origin = { x: 10, y: 20 }
  expect(cellDotCenters([1, 4, 6], origin)).toEqual([
    { x: 10, y: 20 }, { x: 12.3, y: 20 }, { x: 12.3, y: 25 },
  ])
  const centers = textDotCenters('a a', origin)
  expect(centers[0]).toEqual({ x: 10.75, y: 20.75 })
  expect(centers[1]!.x - centers[0]!.x).toBeCloseTo(2 * BRAILLE_MM.cellPitch, 12)
  // Number sign occupies a full cell before the digit's letter-a cell.
  expect(textDotCenters('1', origin).at(-1)).toEqual({ x: 10.75 + BRAILLE_MM.cellPitch, y: 20.75 })
})
