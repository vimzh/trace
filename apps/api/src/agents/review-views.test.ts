import { expect, test } from 'bun:test'
import { sampleFloorModel } from '@bumps/floor-model'
import { combineRegionalCritiques, critiqueSchema, critiqueSchemaForRegions, type Critique } from './critique'
import { buildReviewViews } from './review-views'

const source = { mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' }

test('pairs source quadrants with identical overlay bounds, including smaller plans', () => {
  const model = { ...sampleFloorModel, plan: { ...sampleFloorModel.plan, widthPx: 1600, heightPx: 1200 } }
  const { parts, regions, regionalParts } = buildReviewViews(model, source)
  expect(parts.filter(part => 'inlineData' in part)).toHaveLength(10)
  expect(parts[1]).toEqual({ inlineData: source })
  expect(regionalParts).toHaveLength(4)
  expect(regions.map(region => region.region)).toEqual(['top-left', 'top-right', 'bottom-left', 'bottom-right'])
  for (let i = 0; i < regions.length; i++) {
    const { x0, y0, x1, y1 } = regions[i]!
    const bounds = `x=${x0}..${x1}, y=${y0}..${y1}`
    const sourceCaption = parts[4 + i * 4] as { text: string }
    const overlayCaption = parts[6 + i * 4] as { text: string }
    expect(sourceCaption.text).toContain(`SOURCE ${regions[i]!.region}`)
    expect(overlayCaption.text).toContain(`MATCHING TOPOLOGY OVERLAY ${regions[i]!.region}`)
    expect(sourceCaption.text).toContain(bounds)
    expect(overlayCaption.text).toContain(bounds)
    expect(regionalParts[i]!.filter(part => 'inlineData' in part)).toHaveLength(4)
    expect(regionalParts[i]!.slice(0, 4)).toEqual(parts.slice(0, 4))
    expect(regionalParts[i]!.slice(4)).toEqual(parts.slice(4 + i * 4, 8 + i * 4))
  }
  const small = buildReviewViews(sampleFloorModel, source)
  expect(small.parts.filter(part => 'inlineData' in part)).toHaveLength(10)
  expect(small.regions.map(region => region.region)).toEqual(regions.map(region => region.region))
})

test('live review requires every region and located major findings for unresolved boundaries', () => {
  const regions = [{ region: 'left', x0: 0, y0: 0, x1: 50, y1: 100 }, { region: 'right', x0: 50, y0: 0, x1: 100, y1: 100 }]
  const schema = critiqueSchemaForRegions(regions)
  const complete = { verdict: 'pass', findings: [], confidenceAdjustments: [],
    regionChecks: regions.map(({ region }) => ({ region, status: 'clear', evidence: 'Visible perimeter and open approach checked in paired views.' })) }
  expect(schema.safeParse(complete).success).toBe(true)
  expect(schema.safeParse({ ...complete, regionChecks: complete.regionChecks.slice(1) }).success).toBe(false)
  expect(schema.safeParse({ ...complete, regionChecks: [complete.regionChecks[0], complete.regionChecks[0]] }).success).toBe(false)
  const unresolved = { ...complete, verdict: 'needs_refinement', regionChecks: [
    { ...complete.regionChecks[0], status: 'finding' }, complete.regionChecks[1],
  ] }
  expect(schema.safeParse(unresolved).success).toBe(false)
  const finding = { kind: 'missing', elementId: null, at: { x: 25, y: 50 }, bounds: null, description: 'A visible glazed boundary has no supporting wall.', severity: 'major' }
  expect(schema.safeParse({ ...unresolved, findings: [finding] }).success).toBe(true)
  expect(schema.safeParse({ ...unresolved, verdict: 'pass', findings: [finding] }).success).toBe(false)
  expect(schema.safeParse({ ...unresolved, findings: [{ ...finding, at: { x: 75, y: 50 } }] }).success).toBe(false)
  expect(schema.safeParse({ ...unresolved, findings: [{ ...finding, severity: 'minor' }] }).success).toBe(false)
  expect(schema.safeParse({ ...unresolved, findings: [finding, { ...finding, at: { x: 200, y: 50 } }] }).success).toBe(false)
  expect(schema.safeParse({ ...complete, verdict: 'needs_refinement', findings: [{ ...finding, at: null }] }).success).toBe(false)
  const bounded = { ...finding, bounds: { x0: 20, y0: 10, x1: 30, y1: 90 } }
  const historical = { ...unresolved, findings: [{ ...finding, bounds: undefined }] }
  expect(schema.safeParse(historical).success).toBe(false)
  expect(critiqueSchema.safeParse(historical).success).toBe(true)
  expect(schema.safeParse({ ...unresolved, findings: [bounded] }).success).toBe(true)
  for (const bounds of [{ x0: 30, y0: 10, x1: 20, y1: 90 }, { x0: 30, y0: 10, x1: 40, y1: 90 }]) {
    expect(schema.safeParse({ ...unresolved, findings: [{ ...finding, bounds }] }).success).toBe(false)
  }
})

test('regional synthesis preserves findings and takes conservative overlapping confidence', () => {
  const finding: Critique['findings'][number] = { kind: 'missing', elementId: null, at: { x: 25, y: 50 },
    description: 'Physical return absent', severity: 'major', bounds: { x0: 20, y0: 10, x1: 30, y1: 90 } }
  const reviews: Critique[] = ['left', 'right'].map(region => ({ verdict: 'needs_refinement', findings: [finding],
    confidenceAdjustments: [{ elementId: 'wall', confidence: region === 'left' ? .9 : .6 }],
    regionChecks: [{ region, status: 'finding', evidence: 'Observed missing boundary' }] }))
  const result = combineRegionalCritiques(reviews)
  expect(result.verdict).toBe('needs_refinement')
  expect(result.findings).toEqual([finding])
  expect(result.regionChecks).toHaveLength(2)
  expect(result.confidenceAdjustments).toEqual([{ elementId: 'wall', confidence: .6 }])
})
