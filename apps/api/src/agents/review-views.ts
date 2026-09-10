// Matched source/overlay views keep physical-boundary review in one coordinate frame.
import { Resvg } from '@resvg/resvg-js'
import { renderFloorTopologyOverlaySvg, type FloorModel } from '@bumps/floor-model'
import { cropPlanImage, downscalePlanImage } from '../lib/rasterize'
import { DETAIL_CROPS } from './parser'
import type { MessagePart } from './llm'

export type ReviewRegion = { region: string; x0: number; y0: number; x1: number; y1: number }

export function buildReviewViews(
  model: FloorModel,
  source: { data: string; mimeType: string },
): { parts: MessagePart[]; regions: ReviewRegion[]; regionalParts: MessagePart[][] } {
  const { widthPx, heightPx } = model.plan
  const png = new Uint8Array(new Resvg(renderFloorTopologyOverlaySvg(model,
    `data:${source.mimeType};base64,${source.data}`)).render().asPng())
  const prepared = downscalePlanImage(png, 'image/png') ?? png
  const parts: MessagePart[] = [
    { text: `FULL SOURCE — x=0..${widthPx}, y=0..${heightPx}:` },
    { inlineData: source },
    { text: 'MATCHING FULL TOPOLOGY OVERLAY:' },
    { inlineData: { data: Buffer.from(prepared).toString('base64'), mimeType: 'image/png' } },
  ]
  const bytes = Buffer.from(source.data, 'base64')
  const regionalParts: MessagePart[][] = []
  const regions = DETAIL_CROPS.map(({ crop, label }) => {
    const bounds = { region: label, x0: Math.round(crop.left * widthPx), y0: Math.round(crop.top * heightPx),
      x1: Math.round((crop.left + crop.width) * widthPx), y1: Math.round((crop.top + crop.height) * heightPx) }
    const caption = `${label} — FULL PLAN bounds x=${bounds.x0}..${bounds.x1}, y=${bounds.y0}..${bounds.y1}`
    const pair: MessagePart[] = []
    for (const [name, image, mimeType] of [['SOURCE', bytes, source.mimeType], ['MATCHING TOPOLOGY OVERLAY', png, 'image/png']] as const) {
      const detail = cropPlanImage(image, mimeType, crop)
      pair.push({ text: `${name} ${caption}; report coordinates in FULL PLAN space:` },
        { inlineData: { data: Buffer.from(detail).toString('base64'), mimeType: 'image/png' } })
    }
    regionalParts.push([...parts.slice(0, 4), ...pair])
    parts.push(...pair)
    return bounds
  })
  return { parts, regions, regionalParts }
}
