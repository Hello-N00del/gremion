// Kernel issue #89, the part CONNECT alone does not fix: a customer made by the release before the purge run
// logs in has neither the purger's CONNECT nor its schema USAGE nor its SELECT/DELETE on the purge tables, and
// no upgrade step re-runs the create-time grants. The `purger-connect` check of `reconcile` must therefore read
// and repair ALL of it, not only CONNECT: with CONNECT alone the scheduled purge moves from "permission denied
// for database" to "refused: the purger lacks SELECT, DELETE" while the report reads green. The real grants are
// proven against a real server in packages/tenant-store/test/integration/purger-connect.test.ts; this file pins
// that the check is wired to the full access pair of tenant-store and not to the CONNECT-only pair.
import { describe, expect, it, vi } from 'vitest'
import type { ModuleServer } from '@gremion/tenant-store/lifecycle'

const lifecycle = vi.hoisted(() => ({
  kernelPurgerAccessProblems: vi.fn(async (): Promise<string[]> => []),
  ensureKernelPurgerAccess: vi.fn(async () => ({ repaired: true })),
  // the CONNECT-only pair: wired to the check, the grants would stay missing
  kernelPurgerConnectProblems: vi.fn(async (): Promise<string[]> => []),
  ensureKernelPurgerConnect: vi.fn(async () => ({ granted: true })),
}))
vi.mock('@gremion/tenant-store/lifecycle', () => lifecycle)

import { purgerConnectPort } from './reconcile-reensure'

const server = {} as ModuleServer

describe('the purger-connect check reads and repairs the whole purge access (CONNECT, schema USAGE, purge-table grants)', () => {
  it('problems() is the access read, never the CONNECT-only read', async () => {
    lifecycle.kernelPurgerAccessProblems.mockResolvedValueOnce(['the purger role k_x_purger lacks SELECT, DELETE on event_consumption'])
    expect(await purgerConnectPort(server, 'tenant-x').problems()).toEqual(['the purger role k_x_purger lacks SELECT, DELETE on event_consumption'])
    expect(lifecycle.kernelPurgerAccessProblems).toHaveBeenCalledWith(server, 'tenant-x')
    expect(lifecycle.kernelPurgerConnectProblems).not.toHaveBeenCalled()
  })

  it('repair() is the access repair, never the CONNECT-only grant', async () => {
    await purgerConnectPort(server, 'tenant-x').repair()
    expect(lifecycle.ensureKernelPurgerAccess).toHaveBeenCalledWith(server, 'tenant-x')
    expect(lifecycle.ensureKernelPurgerConnect).not.toHaveBeenCalled()
  })
})
