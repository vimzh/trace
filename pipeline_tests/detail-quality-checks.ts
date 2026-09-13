// Offline source-anchored regression probes; passing these is not a whole-plan fidelity assessment.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { pointInPolygon, segmentsCross } from '../packages/floor-model/src/fit'
import { floorModelSchema, type FloorModel, type Point } from '../packages/floor-model/src/schema'
import cases from './detail-quality-cases.json'

const ROOT = path.resolve(import.meta.dir, '..')
const REVIEW = 'pipeline_tests/gallery-audit-20260912/'
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
type Check = { id: string, passed: boolean, evidence: unknown }
const dimensions: Record<string, [number, number]> = {
  'buffalo-downtown-central-library': [1139, 2000],
  'test-public-restrooms': [973, 713],
  'fountain-hills-community-center': [2000, 1629],
  'caa-ed-mirvish-theatre': [1787, 2000],
}

function distanceToSegment(p: Point, a: Point, b: Point) {
  const dx = b.x - a.x, dy = b.y - a.y
  const lengthSq = dx * dx + dy * dy
  const t = lengthSq ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq)) : 0
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy)
}

function polygonBlocks(a: Point, b: Point, polygon: Point[]) {
  return pointInPolygon(a, polygon) || pointInPolygon(b, polygon)
    || polygon.some((p, i) => segmentsCross(a, b, p, polygon[(i + 1) % polygon.length]!))
}

function sourceChecks(slug: string, model: FloorModel): Check[] {
  const size = dimensions[slug]
  if (!size) return []
  const checks: Check[] = []
  const point = (x: number, y: number): Point => ({ x: x * model.plan.widthPx / size[0], y: y * model.plan.heightPx / size[1] })
  const tolerance = (pixels: number) => pixels * Math.max(model.plan.widthPx / size[0], model.plan.heightPx / size[1])
  const add = (id: string, passed: boolean, evidence: unknown) => checks.push({ id, passed, evidence })
  add('model-has-structure', model.walls.length > 0 && model.rooms.length > 0,
    { walls: model.walls.length, rooms: model.rooms.length })
  const open = (id: string, x0: number, y0: number, x1: number, y1: number, reference: string) => {
    const a = point(x0, y0), b = point(x1, y1)
    const walls = model.walls.filter(wall => segmentsCross(a, b, wall.a, wall.b))
    add(id, walls.length === 0, { reference, a, b, crossingWallIds: walls.map(wall => wall.id) })
  }
  const divider = (id: string, anchors: [number, number][], pixels: number, reference: string) => {
    const probes = anchors.map(([x, y]) => {
      const at = point(x, y)
      const near = model.walls.filter(wall => distanceToSegment(at, wall.a, wall.b) <= tolerance(pixels))
      return { at, nearWallIds: near.map(wall => wall.id) }
    })
    add(id, probes.every(probe => probe.nearWallIds.length > 0), { reference, tolerance: tolerance(pixels), probes })
  }
  const labeled = [...model.rooms, ...model.furniture, ...model.features].flatMap(element => {
    if (!('label' in element) || typeof element.label !== 'string') return []
    const at = 'at' in element ? element.at : {
      x: element.polygon.reduce((sum, p) => sum + p.x, 0) / element.polygon.length,
      y: element.polygon.reduce((sum, p) => sum + p.y, 0) / element.polygon.length,
    }
    return [{ id: element.id, label: element.label, at }]
  })
  const named = (id: string, pattern: RegExp, x: number, y: number, radius: number, reference: string) => {
    const at = point(x, y)
    const matches = labeled.filter(item => pattern.test(item.label) && Math.hypot(item.at.x - at.x, item.at.y - at.y) <= tolerance(radius))
    add(id, matches.length > 0, { reference, at, radius: tolerance(radius), matches })
  }

  if (slug === 'buffalo-downtown-central-library') {
    const reference = `${REVIEW}final-buffalo-yonkers-review.md#material-losses-and-unresolved-issues`
    open('copy-zone-has-no-false-vertical-wall', 775, 1320, 950, 1320, reference)
    open('teen-space-has-no-false-bottom-wall', 650, 1640, 650, 1790, reference)
    named('ring-of-knowledge-retained', /ring of knowledge/i, 650, 1100, 100, reference)
    named('teen-space-separately-anchored', /^teen\s+space$/i, 660, 1690, 160, reference)
    for (const [index, [x, y]] of ([[671, 265], [428, 996], [700, 1350]] as [number, number][]).entries()) {
      named(`information-desk-name-${index + 1}`, /information\s+desk/i, x, y, 70, reference)
    }
    const staffedCheckout = model.features.filter(feature => (feature.kind === 'reception' || feature.kind === 'info-point')
      && /\bself\W*check\W*out\b/i.test(feature.label ?? ''))
    add('self-checkout-not-a-staffed-service', staffedCheckout.length === 0,
      { reference: 'Source legend identifies the S icons as Self Check-Out, not staffed information or reception desks',
        sourceAnchors: [[731, 640], [726, 1426], [953, 1425]].map(([x, y]) => point(x!, y!)), staffedCheckout })
    const copierIcons = [[565, 390], [773, 391], [453, 898]].map(([x, y]) => point(x!, y!))
    const iconBlocks = model.furniture.filter(item => copierIcons.some(at => pointInPolygon(at, item.polygon)))
    add('copier-icons-not-promoted-to-obstacles', iconBlocks.length === 0,
      { reference: 'Three boxed C symbols are legend-decoded device markers, with no independent physical footprint; the separately drawn Copy Corner service area remains eligible',
        sourceAnchors: copierIcons, iconBlockIds: iconBlocks.map(item => item.id) })
    named('copy-corner-service-name-retained', /copy\s+corner.*scan.*fax.*print/i, 831, 1454, 90,
      'Printed Copy Corner Scan • Fax • Print service area; exclude its C icon without dropping the named destination')
    const librarySecurity = labeled.filter(item => /library\s+security/i.test(item.label))
    add('library-security-name-retained', librarySecurity.length > 0,
      { reference: 'Retain the Library Security name, distinct from the freestanding Security object; its parent region may span the full Borrower Services area, so centroid proximity is not a valid omission test', matches: librarySecurity })
    named('auditorium-entrance-source-location', /entrance\s+to\s+auditorium/i, 830, 1800, 55,
      'Source-labeled southern bay x787–873; not blank Teen Space to its west')
    named('washington-doors-source-location', /doors\s+to\s+washington/i, 920, 1780, 55,
      'Source-labeled southern bay x873–972, between the Auditorium bay and Elevator bay')
  } else if (slug === 'test-public-restrooms') {
    const reference = `${REVIEW}heldout-review.md#public-restrooms`
    for (const x of [375, 450, 530]) open(`central-approach-open-at-${x}`, x, 680, x, 712, reference)
    divider('bottom-left-real-boundary-retained', [[100, 707], [200, 707], [300, 707]], 8, 'Visible black source perimeter left of the white central approach')
    divider('bottom-right-real-boundary-retained', [[650, 707], [800, 707], [950, 707]], 8, 'Visible black source perimeter right of the white central approach')
    divider('far-right-real-boundary-retained', [[969, 500], [969, 600], [969, 680]], 8, 'Visible black source perimeter of the right-side extension')
    divider('urinal-privacy-divider-present', [[500, 378], [540, 378], [570, 378]], 10, reference)
    open('urinal-bay-remains-open-to-right', 545, 420, 620, 420,
      'The privacy divider ends near x579,y373; no wall connects its tip to the shaft cap below. The lower urinal bay opens east into restroom circulation')
    divider('central-shaft-cap-present', [[365, 462], [405, 462], [450, 462]], 8, 'Continuous black source partition above the lower approach; the narrow white shaft is not a passage into it')
    divider('right-extension-short-return-present', [[888, 430]], 4, 'Short black source return joins the inner right-side divider to the outer junction; not a second doorway')
    const restrooms = model.features.filter((feature) => feature.kind === 'restroom')
    add('both-restroom-zones-retained', restrooms.some((feature) => feature.at.x < point(425, 0).x)
      && restrooms.some((feature) => feature.at.x > point(480, 0).x), { reference, restrooms })
    const inventedEntries = model.features.filter((feature) => feature.kind === 'entrance' || feature.kind === 'exit')
    add('no-unmarked-entrance-exit-features', inventedEntries.length === 0, { reference, inventedEntries })
    const bowls = [[348, 77], [348, 230], [348, 383], [556, 74], [556, 227]] as [number, number][]
    const fixtureBlocks = model.furniture.filter((item) => bowls.some(([x, y]) => pointInPolygon(point(x, y), item.polygon)))
    add('toilet-bowls-not-promoted-to-furniture', fixtureBlocks.length === 0,
      { reference: 'Source toilet-bowl/cistern symbols inside five stalls; not tables or navigation furniture', fixtureBlockIds: fixtureBlocks.map((item) => item.id) })
  } else if (slug === 'fountain-hills-community-center') {
    const reference = `${REVIEW}heldout-review.md#fountain-hills-community-center`
    divider('yavapai-south-enclosure-retained', [[790, 778], [850, 778], [920, 778], [985, 778]], 8,
      'Continuous physical south boundary, including its central window, between the two actual corner doorways; room polygons alone are not tactile walls')
    for (const [side, x] of [['west', 741], ['east', 1019]] as const) {
      divider(`yavapai-${side}-glazing-retained`, [[x, 671], [x, 684]], 8,
        'Visible gray parallel glazing lines bridge the solid side-wall ends; these are impassable window spans, not circulation openings')
    }
    divider('w-m-divider-present-through-restrooms', [[880, 910], [880, 990], [880, 1070]], 18, reference)
    divider('lounge-side-returns-present', [[740, 1260], [1020, 1260]], 18, reference)
    const lounge = model.rooms.filter(room => /\blounge\b/i.test(room.label ?? '') && pointInPolygon(point(880, 1250), room.polygon))
    const nonAxisEdges = lounge.flatMap(room => room.polygon.flatMap((a, index) => {
      const b = room.polygon[(index + 1) % room.polygon.length]!
      return Math.abs(a.x - b.x) > tolerance(2) && Math.abs(a.y - b.y) > tolerance(2) ? [{ roomId: room.id, a, b }] : []
    }))
    add('lounge-retains-nonrectangular-boundary', lounge.some(room => room.polygon.length > 4) && nonAxisEdges.length >= 2,
      { reference, roomIds: lounge.map(room => room.id), nonAxisEdges })
  } else if (slug === 'caa-ed-mirvish-theatre') {
    const solidRun = [410, 440, 475, 491].map(x => {
      const at = point(x, 694)
      const walls = model.walls.filter(wall => distanceToSegment(at, wall.a, wall.b) <= tolerance(7))
      const doors = model.openings.filter(opening => opening.kind === 'door'
        && Math.hypot(opening.at.x - at.x, opening.at.y - at.y) <= opening.width / 2)
      return { at, wallIds: walls.map(wall => wall.id), doorIds: doors.map(door => door.id) }
    })
    add('west-stair-wall-has-no-false-passage', solidRun.every(probe => probe.wallIds.length > 0 && probe.doorIds.length === 0),
      { reference: 'Source horizontal wall is continuous approximately x=334..502 at y=694; only the separate x=503..520 gap is open. Removing a false door record must also restore the physical wall.', solidRun })
    const reference = `${REVIEW}final-secondary-review.md#caa-ed-mirvish-theatre`
    for (const [name, x, y, radius] of [['w', 401, 428, 150], ['m', 551, 757, 110]] as const) {
      const at = point(x, y)
      const facilities = model.features.filter(feature => feature.kind === 'restroom'
        && Math.hypot(feature.at.x - at.x, feature.at.y - at.y) <= tolerance(radius))
      add(`${name}-restroom-function-retained`, facilities.length > 0,
        { reference: 'Paired W/M visitor-amenity badges and service-core context identify restroom destinations without requiring plumbing fixtures; labeled room regions alone lose the standard facility glyph', at, facilities })
    }
    for (const [index, [x, y]] of ([[585, 839], [1099, 829], [781, 1409], [989, 1409]] as [number, number][]).entries()) {
      named(`wheelchair-seating-name-${index + 1}`, /(?:wheelchair|accessible).*seat|seat.*(?:wheelchair|accessible)/i, x, y, 65, reference)
    }
    const exitAt = point(360, 620)
    const exits = model.features.filter(feature => (feature.kind === 'exit' || feature.kind === 'stairs')
      && /o['’]?keefe/i.test(feature.label ?? '') && /\bexit\b/i.test(feature.label ?? '')
      && Math.hypot(feature.at.x - exitAt.x, feature.at.y - exitAt.y) <= tolerance(110))
    add('okeefe-lane-exit-route-retained', exits.length > 0, { reference: 'Source callout points down the stair flight toward the exit, not a separate same-floor exit glyph', at: exitAt, radius: tolerance(110), exits })
    named('okeefe-lane-exit-name-present', /o['’]?keefe/i, 360, 620, 230, reference)
    const stairLeader = point(417, 618)
    const leaderExits = model.features.filter(feature => feature.kind === 'exit'
      && Math.hypot(feature.at.x - stairLeader.x, feature.at.y - stairLeader.y) <= tolerance(45))
    add('okeefe-stair-leader-has-no-exit-glyph', leaderExits.length === 0,
      { reference: 'The Down to O’Keefe Lane Exit leader points to a stair flight; its destination text does not draw a second exit feature there',
        at: stairLeader, radius: tolerance(45), leaderExits })
    for (const [side, x, y] of [['left', 735, 379], ['right', 1014, 380]] as const) {
      const at = point(x, y)
      const flights = model.features.filter(feature => feature.kind === 'stairs'
        && Math.hypot(feature.at.x - at.x, feature.at.y - at.y) <= tolerance(60))
      add(`${side}-mezzanine-stair-flight-retained`, flights.length > 0,
        { reference: 'Two leaders from the upper mezzanine callout point to separate side flights, not one averaged location',
          at, radius: tolerance(60), flights })
    }
    const laneInside = [[260, 950], [195, 1350], [330, 1350], [260, 1750]].map(([x, y]) => point(x!, y!))
    const laneOutside = [[130, 1350], [390, 1350]].map(([x, y]) => point(x!, y!))
    const laneRoads = model.roads.filter(road => /o['’]?keefe\s+lane/i.test(road.label ?? '')).map(road => {
      const covers = (at: Point) => road.points.slice(1).some((b, index) => distanceToSegment(at, road.points[index]!, b) <= road.widthPx / 2)
      return { id: road.id, points: road.points, widthPx: road.widthPx,
        insideCovered: laneInside.map(covers), outsideCovered: laneOutside.map(covers) }
    })
    add('okeefe-lane-road-band-retained', laneRoads.some(road => road.insideCovered.every(Boolean) && !road.outsideCovered.some(Boolean)),
      { reference: 'Source O’Keefe Lane is the long exterior band between approximately x=165 and x=360 below the western stair access; a room label alone does not retain the road band',
        laneInside, laneOutside, laneRoads })
    const a = point(878, 900), b = point(878, 1380)
    const blockers = model.furniture.filter(item => polygonBlocks(a, b, item.polygon))
    const seating = model.furniture.filter(item => /seat|chair/i.test(item.label))
    add('central-seating-aisle-retained', blockers.length === 0
      && seating.some(item => pointInPolygon(point(650, 1100), item.polygon))
      && seating.some(item => pointInPolygon(point(1100, 1100), item.polygon)),
    { reference, a, b, blockingFurnitureIds: blockers.map(item => item.id), seatingIds: seating.map(item => item.id) })
    for (const [side, coordinates] of [
      ['left', [740, 1400, 790, 1400]], ['right', [910, 1390, 990, 1390]],
    ] as const) {
      const [x0, y0, x1, y1] = coordinates
      const from = point(x0, y0), to = point(x1, y1)
      const crossing = model.furniture.filter(item => polygonBlocks(from, to, item.polygon))
      add(`${side}-transverse-seating-aisle-retained`, crossing.length === 0,
        { reference: 'Source blank transverse gap separates the upper and lower tapered seating banks, not ordinary intra-bank row spacing', from, to, blockingFurnitureIds: crossing.map(item => item.id) })
    }
  }
  return checks
}

async function audit(runDirectory: string, only?: string) {
  const selected = only ? only.split(',').map(slug => slug.trim()) : cases.map(item => item.slug)
  assert.equal(new Set(selected).size, selected.length, 'Selected slugs must be unique')
  for (const slug of selected) assert(cases.some(item => item.slug === slug), `Unknown case slug: ${slug}`)
  const results = []
  for (const slug of selected) {
    const item = cases.find(item => item.slug === slug)!
    try {
      const directory = path.join(runDirectory, slug)
      const snapshot = await Bun.file(path.join(directory, 'model.json')).json()
      const model = floorModelSchema.parse(snapshot.model)
      const run = await Bun.file(path.join(directory, 'run.json')).json()
      const hash = sha256(await Bun.file(path.join(ROOT, item.source)).bytes())
      assert.equal(run.source?.sha256, hash, 'Saved run source does not match the source used to define these checks')
      const checks = sourceChecks(slug, model)
      results.push({ slug, modelVersion: snapshot.version, runStatus: run.status, sourceSha256: hash,
        status: checks.length ? checks.every(check => check.passed) ? 'checks-passed' : 'failed' : 'not-scored',
        requiresSourceReview: true, checks,
        ...(checks.length ? {} : { reason: 'Source-only control has no predeclared source assertions; manual source review required' }) })
    } catch (error) {
      results.push({ slug, status: 'failed', requiresSourceReview: true, checks: [], error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { runDirectory, manifestSha256: sha256(await Bun.file(path.join(import.meta.dir, 'detail-quality-cases.json')).bytes()),
    checkerSha256: sha256(await Bun.file(import.meta.path).bytes()), sourceCoordinateFrames: dimensions,
    limitation: 'Sparse regression probes in reviewed source pixel coordinates, scaled to model dimensions. They do not assess the whole drawing, tactile clearance, physical usability, or delivery success. Raw wall probes reject unsupported boundary walls even if a modeled door cuts them. Divider proximity and nonrectangular lounge outlines are geometry hints, not proof of a faithful continuous curve. Label probes use feature locations or polygon vertex averages. Controls without assertions are not scored; missing models or mismatched sources fail.',
    results }
}

if (import.meta.main) {
  if (process.argv[2] === '--self-check') {
    const model: FloorModel = { schemaVersion: 1, title: null, plan: { widthPx: 973, heightPx: 713, pixelsPerMeter: null, north: null },
      walls: [{ id: 'bottom', kind: 'wall', a: { x: 344, y: 707 }, b: { x: 562, y: 707 }, thickness: 8, confidence: 1 }],
      rooms: [{ id: 'room', kind: 'room', polygon: [{ x: 0, y: 0 }, { x: 973, y: 0 }, { x: 973, y: 713 }], label: null, confidence: 1 }],
      openings: [], features: [], furniture: [], paths: [], roads: [] }
    assert.equal(sourceChecks('test-public-restrooms', model).filter(check => check.id.startsWith('central-approach') && !check.passed).length, 3)
    model.walls = [{ ...model.walls[0]!, id: 'privacy', a: { x: 485, y: 378 }, b: { x: 579, y: 378 } }]
    assert(sourceChecks('test-public-restrooms', model).filter(check => check.id.startsWith('central-approach') || check.id === 'urinal-privacy-divider-present').every(check => check.passed))
    assert(sourceChecks('test-public-restrooms', model).find(check => check.id === 'urinal-bay-remains-open-to-right')!.passed)
    model.walls.push({ ...model.walls[0]!, id: 'false-return', a: { x: 579, y: 378 }, b: { x: 563, y: 462 } })
    assert.equal(sourceChecks('test-public-restrooms', model).find(check => check.id === 'urinal-bay-remains-open-to-right')!.passed, false)
    assert.deepEqual(sourceChecks('office-dime-building-1st', model), [])
    assert(polygonBlocks({ x: 0, y: 5 }, { x: 10, y: 5 }, [{ x: 4, y: 0 }, { x: 6, y: 0 }, { x: 6, y: 10 }, { x: 4, y: 10 }]))
    const checkPassed = (slug: string, id: string) => {
      const check = sourceChecks(slug, model).find(check => check.id === id)
      assert(check, `Missing source assertion: ${id}`)
      return check.passed
    }
    const buffalo = 'buffalo-downtown-central-library'
    model.plan = { ...model.plan, widthPx: 1139, heightPx: 2000 }
    for (const kind of ['reception', 'info-point'] as const) {
      model.features = [{ id: 'checkout', kind, label: 'Self Check-Out', at: { x: 731, y: 640 }, rotation: 0, confidence: 1 }]
      assert.equal(checkPassed(buffalo, 'self-checkout-not-a-staffed-service'), false)
    }
    model.features[0]!.label = 'Information Desk'
    assert(checkPassed(buffalo, 'self-checkout-not-a-staffed-service'))
    assert(checkPassed(buffalo, 'copier-icons-not-promoted-to-obstacles'))
    model.furniture = [{ id: 'icon-box', kind: 'furniture', label: 'Copier', confidence: 1,
      polygon: [{ x: 552, y: 370 }, { x: 580, y: 370 }, { x: 580, y: 410 }, { x: 552, y: 410 }] }]
    assert.equal(checkPassed(buffalo, 'copier-icons-not-promoted-to-obstacles'), false)
    model.furniture = []
    model.features = [{ id: 'auditorium', kind: 'entrance', label: 'Entrance to Auditorium', at: { x: 612, y: 1801 }, rotation: 0, confidence: 1 }]
    assert.equal(checkPassed(buffalo, 'auditorium-entrance-source-location'), false)
    model.features[0]!.at = { x: 830, y: 1800 }
    assert(checkPassed(buffalo, 'auditorium-entrance-source-location'))
    model.plan = { ...model.plan, widthPx: 2000, heightPx: 1629 }
    model.walls = []
    const fountain = 'fountain-hills-community-center'
    for (const id of ['yavapai-south-enclosure-retained', 'yavapai-west-glazing-retained', 'yavapai-east-glazing-retained']) {
      assert.equal(checkPassed(fountain, id), false)
    }
    model.walls = [
      { id: 'south', kind: 'wall', a: { x: 764, y: 778 }, b: { x: 997, y: 778 }, thickness: 5, confidence: 1 },
      ...[741, 1019].map((x, i) => ({ id: `glazing-${i}`, kind: 'wall' as const, a: { x, y: 660 }, b: { x, y: 695 }, thickness: 5, confidence: 1 })),
    ]
    for (const id of ['yavapai-south-enclosure-retained', 'yavapai-west-glazing-retained', 'yavapai-east-glazing-retained']) {
      assert(checkPassed(fountain, id))
    }
    const theatre = 'caa-ed-mirvish-theatre'
    model.plan = { ...model.plan, widthPx: 1787, heightPx: 2000 }
    const wallProbe = 'west-stair-wall-has-no-false-passage'
    assert.equal(checkPassed(theatre, wallProbe), false)
    model.walls = [{ id: 'stair-wall', kind: 'wall', a: { x: 334, y: 694 }, b: { x: 502, y: 694 }, thickness: 8, confidence: 1 }]
    assert(checkPassed(theatre, wallProbe))
    model.openings = [{ id: 'fake-door', kind: 'door', at: { x: 440, y: 694 }, width: 80, wallId: 'stair-wall', confidence: 1 }]
    assert.equal(checkPassed(theatre, wallProbe), false)
    model.openings = [{ ...model.openings[0]!, id: 'real-gap', at: { x: 511.5, y: 694 }, width: 17 }]
    assert(checkPassed(theatre, wallProbe))
    model.openings = []
    model.features = []
    assert.equal(checkPassed(theatre, 'w-restroom-function-retained'), false)
    assert.equal(checkPassed(theatre, 'm-restroom-function-retained'), false)
    model.features = [[401, 428], [551, 757]].map(([x, y], index) => ({ id: `wc-${index}`, kind: 'restroom', at: { x: x!, y: y! }, rotation: 0, confidence: 1 }))
    assert(checkPassed(theatre, 'w-restroom-function-retained'))
    assert(checkPassed(theatre, 'm-restroom-function-retained'))
    model.features = [{ id: 'lane-stairs', kind: 'stairs', label: 'Down to O’Keefe Lane Exit', at: { x: 417, y: 618 }, rotation: 0, confidence: 1 }]
    assert(checkPassed(theatre, 'okeefe-lane-exit-route-retained'))
    assert(checkPassed(theatre, 'okeefe-stair-leader-has-no-exit-glyph'))
    model.features.push({ ...model.features[0]!, id: 'duplicate-exit', kind: 'exit' })
    assert.equal(checkPassed(theatre, 'okeefe-stair-leader-has-no-exit-glyph'), false)
    model.features = [{ ...model.features[0]!, at: { x: 870, y: 381 } }]
    for (const side of ['left', 'right']) assert.equal(checkPassed(theatre, `${side}-mezzanine-stair-flight-retained`), false)
    model.features = [735, 1014].map((x, index) => ({ ...model.features[0]!, id: `flight-${index}`, at: { x, y: 380 } }))
    for (const side of ['left', 'right']) assert(checkPassed(theatre, `${side}-mezzanine-stair-flight-retained`))
    model.rooms[0]!.label = 'O’Keefe Lane'
    assert.equal(checkPassed(theatre, 'okeefe-lane-road-band-retained'), false)
    model.roads = [{ id: 'lane', kind: 'road', label: 'O’Keefe Lane', points: [{ x: 260, y: 700 }, { x: 260, y: 1900 }], widthPx: 190, confidence: 1 }]
    assert(checkPassed(theatre, 'okeefe-lane-road-band-retained'))
    model.roads[0]!.widthPx = 500
    assert.equal(checkPassed(theatre, 'okeefe-lane-road-band-retained'), false)
    assert.equal(distanceToSegment({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 }), 5)
    const missing = await audit(path.join(ROOT, 'pipeline_tests/missing-source-check-run'), 'school-skyline-high')
    assert.equal(missing.results[0]!.status, 'failed')
    console.log('Source probes reject blocked approaches, invented staffed services, duplicate exits, merged flights, missing/widened roads and missing models; controls stay unscored; no API calls made')
  } else {
    assert(process.argv[2] && process.argv.length <= 4, 'Usage: bun pipeline_tests/detail-quality-checks.ts <run-directory> [slug,slug] | --self-check')
    const report = await audit(path.resolve(process.argv[2]), process.argv[3])
    console.log(JSON.stringify(report, null, 2))
    if (report.results.some(result => result.status === 'failed')) process.exitCode = 1
  }
}
