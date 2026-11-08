// verifyRowExport must tell "the export is missing" from "the export volume cannot be inspected": only a missing
// component (ENOENT / ENOTDIR) is reported as a missing export; any other lstat error (permissions, I/O, a link
// loop) refuses the drop with its own diagnosis instead of being swallowed. node:fs is wrapped so that one path
// fails the way an unreadable export volume does; no platform can be relied on to produce EACCES on demand.
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    lstatSync: ((path: string, ...rest: unknown[]) => {
      const code = /unreadable-(\w+)/.exec(String(path))?.[1]
      if (code) throw Object.assign(new Error(`${code}: lstat ${path}`), { code })
      return (actual.lstatSync as (...a: unknown[]) => unknown)(path, ...rest)
    }) as typeof actual.lstatSync,
  }
})

const { verifyRowExport } = await import('./karenz.js')

const T = '0192f0c1-2b3c-7d4e-8f00-112233445566'
const sha = createHash('sha256').update('x').digest('hex')
const row = (exportDir: string) => ({
  karenz_id: 'k1',
  customer_id: T,
  module_id: 'm1',
  module_key: 'lcfix',
  state: 'open' as const,
  export_path: `${exportDir}/${T}/lcfix/a.dump`,
  export_sha256: sha,
  export_deleted_at: null,
  platform_done_at: null,
  tenant_done_at: null,
  retained_ok_at: null,
})

describe('verifyRowExport: an lstat error other than a missing component is its own refusal', () => {
  for (const code of ['EACCES', 'EIO', 'ELOOP']) {
    it(`${code} refuses with TARGET_REFUSED naming the error, not "missing"`, async () => {
      const err = await verifyRowExport(`/nowhere/unreadable-${code}`, row(`/nowhere/unreadable-${code}`)).catch((e: unknown) => e)
      expect(err).toMatchObject({ code: 'TARGET_REFUSED' })
      expect((err as Error).message).toContain(code)
      expect((err as Error).message).not.toMatch(/is missing/)
    })
  }

  it('ENOENT and ENOTDIR stay a missing export (EXPORT_MISSING)', async () => {
    for (const code of ['ENOENT', 'ENOTDIR']) {
      await expect(verifyRowExport(`/nowhere/unreadable-${code}`, row(`/nowhere/unreadable-${code}`)), code).rejects.toMatchObject({ code: 'EXPORT_MISSING' })
    }
  })
})
