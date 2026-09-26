// SEEDED VIOLATION (TDD 6): a service opening a tenant database directly.
import postgres from 'postgres'

export const sql = postgres(process.env.TENANT_URL!)
