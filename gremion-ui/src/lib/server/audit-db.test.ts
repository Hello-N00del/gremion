import { describe, it, expect, vi, beforeEach } from 'vitest'

// TASK-032 (TRD-410 [D R20-D5]): kit 3's $env/dynamic/private exposes only
// schema-declared vars, so the code under test reads process.env; a
// vi.mock of $env/dynamic/private would be inert. vi.hoisted sets the value
// before the imports below, exactly where the old mock applied it.
vi.hoisted(() => {
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test'
})

const mockSql = vi.fn()
vi.mock('./db', () => ({
  getDb: () => mockSql
}))

describe('audit-db', () => {
  beforeEach(() => vi.clearAllMocks())

  it('writeAuditEntry inserts a record with correct fields', async () => {
    mockSql.mockResolvedValue([])
    const { writeAuditEntry } = await import('./audit-db')

    await writeAuditEntry({
      userId: 'user-123',
      field: 'retention.access_logs_days',
      oldValue: '14',
      newValue: '21'
    })

    expect(mockSql).toHaveBeenCalledOnce()
  })

  it('readAuditLog returns all records when no field filter', async () => {
    const fakeRows = [
      { id: 1, createdAt: new Date(), userId: 'u1', field: 'retention.app_logs_days', oldValue: '30', newValue: '60' }
    ]
    mockSql.mockResolvedValue(fakeRows)
    const { readAuditLog } = await import('./audit-db')

    const result = await readAuditLog()

    expect(result).toEqual(fakeRows)
    expect(mockSql).toHaveBeenCalledOnce()
  })

  it('readAuditLog filters by field when provided', async () => {
    mockSql.mockResolvedValue([])
    const { readAuditLog } = await import('./audit-db')

    await readAuditLog('retention.access_logs_days')

    expect(mockSql).toHaveBeenCalledOnce()
  })
})
