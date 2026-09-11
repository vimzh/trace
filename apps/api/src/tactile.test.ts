import { expect, test } from 'bun:test'
import { isRunningTactileJobConflict } from './lib/postgres-errors'

test('only the one-running-job constraint is treated as an existing job', () => {
  expect(
    isRunningTactileJobConflict({
      cause: {
        constraint: 'tactile_designs_one_running_per_project',
        errno: '23505',
      },
    }),
  ).toBe(true)
  expect(
    isRunningTactileJobConflict({ code: '23505', constraint: 'tactile_designs_pkey' }),
  ).toBe(false)
  expect(isRunningTactileJobConflict({ code: '23505' })).toBe(false)
  expect(
    isRunningTactileJobConflict({
      cause: { constraint: 'tactile_designs_one_running_per_project', errno: '23503' },
    }),
  ).toBe(false)
})
