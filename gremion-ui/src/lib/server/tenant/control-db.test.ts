import { describe, it, expect, beforeEach } from 'vitest'
import { getControlDb, _resetControlDbForTests } from './control-db'

describe('getControlDb (env guard)', () => {
  beforeEach(() => _resetControlDbForTests())
  it('throws a clear error when CONTROL_DATABASE_URL is unset', () => {
    const had = process.env.CONTROL_DATABASE_URL
    delete process.env.CONTROL_DATABASE_URL
    try {
      expect(() => getControlDb()).toThrow(/CONTROL_DATABASE_URL not configured/)
    } finally {
      if (had !== undefined) process.env.CONTROL_DATABASE_URL = had
    }
  })
})
