// modules/board/test/support/tenants.ts
//
// The board suites' fixture tenants: fixed canonical UUIDv7 ids (kernel tenant
// ids are v7; the leaf's guard refuses anything else). Their (tenant, board)
// databases t_<hex32>__board are the ONLY tenant databases a destructive suite
// may create, migrate or drop (assertScratchTenantDb in pg-test-guard.ts).
//   A, B — provisioned in the isolation and api suites
//   C    — valid but never provisioned (the unprovisioned case, A3)
import type { TenantRef } from '../../src/store/index.ts'

export const TENANT_A: TenantRef = { id: '01920000-0000-7000-8000-00000000000a', slug: 'tenant-a' }
export const TENANT_B: TenantRef = { id: '01920000-0000-7000-8000-00000000000b', slug: 'tenant-b' }
export const TENANT_C: TenantRef = { id: '01920000-0000-7000-8000-00000000000c', slug: 'tenant-c' }

export const FIXTURE_TENANTS: readonly TenantRef[] = [TENANT_A, TENANT_B, TENANT_C]
