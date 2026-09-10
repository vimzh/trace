import { expect, test } from 'bun:test'
import { sourceInventorySchemaForDimensions, type SourceInventory } from './source-reader'

test('source inventory retains located structural evidence and enforces full-plan bounds', () => {
  const schema = sourceInventorySchemaForDimensions({ widthPx: 1000, heightPx: 800 })
  const inventory: SourceInventory = {
    landmarks: [{
      category: 'feature', label: 'Accessible restroom', featureKind: 'restroom',
      at: { x: 600, y: 200 }, evidence: 'Wheelchair symbol inside the restroom beside its label.',
    }],
    openConnections: [{ at: { x: 1000, y: 800 }, evidence: 'Passage remains open at the cropped edge.' }],
    structuralDetails: [{ at: { x: 590, y: 210 }, evidence: 'Short privacy partition beside the restroom entry stops before the corridor.' }],
    notation: [],
    omit: [],
  }
  expect(schema.parse(inventory)).toEqual(inventory)
  for (const field of ['landmarks', 'openConnections', 'structuralDetails'] as const) {
    for (const at of [{ x: -1, y: 0 }, { x: 0, y: -1 }, { x: 1001, y: 0 }, { x: 0, y: 801 }]) {
      expect(schema.safeParse({ ...inventory, [field]: [{ ...inventory[field][0], at }] }).success).toBe(false)
    }
  }
  expect(schema.safeParse({ ...inventory, structuralDetails: [{ at: { x: 0, y: 0 }, evidence: '' }] }).success).toBe(false)
  expect(schema.safeParse({ ...inventory, structuralDetails: Array.from({ length: 2_001 }, () => inventory.structuralDetails[0]) }).success).toBe(false)
})
