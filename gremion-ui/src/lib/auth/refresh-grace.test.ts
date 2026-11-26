// @vitest-environment node
import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { REFRESH_GRACE_MS } from './refresh-grace'

test('the grace is one minute', () => {
  expect(REFRESH_GRACE_MS).toBe(60_000)
})

test('the session layer reads the grace from the shared module and keeps no number of its own', () => {
  const src = readFileSync(new URL('../../auth.ts', import.meta.url), 'utf-8')
  expect(src).toMatch(/import \{ REFRESH_GRACE_MS \} from '\$lib\/auth\/refresh-grace'/)
  expect(src).not.toMatch(/const REFRESH_GRACE_MS\b/)
})
