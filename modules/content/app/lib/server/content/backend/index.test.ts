import { describe, it, expect, afterEach } from 'vitest'
import { getContentBackend } from './index'

// Hermetic env handling: capture the ambient values and RESTORE them after each
// test (rather than unconditionally deleting). This keeps the factory suite
// correct when it runs under an inherited CONTENT_BACKEND=service — e.g. the
// flag-on seam CI job (.github/workflows/services.yml) — where an unconditional
// delete would both mask the inherited flag and make the "unset → inprocess"
// case depend on ambient process state. Mirrors the sibling calendar seam test
// (calendar/backend/index.test.ts), which already saves/restores its env.
const savedBackend = process.env.CONTENT_BACKEND
const savedUrl = process.env.CONTENT_SERVICE_URL
const savedSecret = process.env.INTERNAL_CONTENT_SECRET

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

afterEach(() => {
  restoreEnv('CONTENT_BACKEND', savedBackend)
  restoreEnv('CONTENT_SERVICE_URL', savedUrl)
  restoreEnv('INTERNAL_CONTENT_SECRET', savedSecret)
})

describe('getContentBackend', () => {
  it('unset → inprocess', () => {
    delete process.env.CONTENT_BACKEND
    expect(getContentBackend().kind).toBe('inprocess')
  })

  it("'inprocess' → inprocess", () => {
    process.env.CONTENT_BACKEND = 'inprocess'
    expect(getContentBackend().kind).toBe('inprocess')
  })

  it("'service' → service", () => {
    process.env.CONTENT_BACKEND = 'service'
    process.env.CONTENT_SERVICE_URL = 'http://x'
    process.env.INTERNAL_CONTENT_SECRET = 's'
    expect(getContentBackend().kind).toBe('service')
  })

  it('unknown value throws', () => {
    process.env.CONTENT_BACKEND = 'nope'
    expect(() => getContentBackend()).toThrow(/CONTENT_BACKEND/)
  })
})
