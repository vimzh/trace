import { expect, mock, test } from 'bun:test'

const currentDesign = {
  design: { elements: [] as { id: string; kind: string; texture: string }[] },
  floorModelVersion: 1,
  id: 'current-design',
  status: 'done',
  valid: true,
  violations: [],
}
let latestModelVersion = 1
let exportRows: ({ kind: string; path: string } | undefined)[] = []

mock.module('./db', () => ({
  db: {
    query: {
      exports: { findFirst: async () => exportRows.shift() },
      floorModels: { findFirst: async () => ({ version: latestModelVersion }) },
      projects: { findFirst: async () => undefined },
      tactileDesigns: { findFirst: async () => currentDesign },
    },
  },
}))

const { exportRoutes, likePrefix } = await import('./export')

test('escapes SQL LIKE metacharacters in export path prefixes', () => {
  expect(likePrefix('data/a_b%\\c/')).toBe('data/a\\_b\\%\\\\c/%')
})

test('GET rejects an export after the tactile design becomes stale', async () => {
  latestModelVersion = 2
  exportRows = []

  const response = await exportRoutes.request('/project/export/map.stl')

  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({
    error: 'Tactile design is stale — convert the latest floor model',
  })
})

test('GET does not use an obsolete artifact outside the current batch', async () => {
  latestModelVersion = 1
  exportRows = [
    { kind: 'map', path: 'data/uploads/project/export/current-design/batch/map.stl' },
    undefined,
    { kind: 'legend', path: 'data/uploads/project/export/old-design/batch/legend.stl' },
  ]

  const response = await exportRoutes.request('/project/export/legend.stl')

  expect(response.status).toBe(404)
  expect(await response.json()).toEqual({ error: 'No current export file' })
  expect(exportRows).toHaveLength(1)
})

test('GET and POST reject unsupported area textures without writing an export', async () => {
  latestModelVersion = 1
  currentDesign.design.elements = [{ id: 'area', kind: 'area', texture: 'dots' }]
  try {
    for (const [url, method] of [['/project/export', 'POST'], ['/project/export/map.stl', 'GET']]) {
      const response = await exportRoutes.request(url!, { method })
      expect(response.status).toBe(409)
      expect((await response.json() as { error: string }).error).toContain('unsupported dots texture')
    }
  } finally {
    currentDesign.design.elements = []
  }
})
