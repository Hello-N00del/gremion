// TASK-043 TDD 18 (provisioning side): renderCustomerRouter always carries the
// realm router on the primary host, and refuses a render that would silently
// drop a host.
import { describe, expect, it } from 'vitest'
import { ProvisioningError, renderCustomerRouter } from '../src/index.ts'

const policy = {
  normaliseHost: (h: string) => h.trim().toLowerCase().replace(/\.$/, '') || null,
  isReservedHost: (h: string) => h === 'platform.example' || h.endsWith('.platform.example'),
  certResolver: 'le-http',
}

describe('renderCustomerRouter', () => {
  it('renders the app router and the realm router for the primary host', () => {
    const yaml = renderCustomerRouter({ slug: 'musterstadt', hosts: ['rat.musterstadt.example'], primaryHost: 'rat.musterstadt.example', ...policy })
    expect(yaml).toContain('tenant-musterstadt:')
    expect(yaml).toContain('tenant-musterstadt-kc:')
    expect(yaml).toContain('PathPrefix(`/auth/realms/musterstadt/`) || PathPrefix(`/auth/resources/`)')
    expect(yaml).not.toMatch(/\/auth\/admin/)
  })

  it('refuses a reserved host rather than render without it', () => {
    expect(() => renderCustomerRouter({ slug: 'musterstadt', hosts: ['x.platform.example'], primaryHost: 'x.platform.example', ...policy })).toThrow(ProvisioningError)
  })

  it('refuses a primary host that is not among the hosts, and a bad slug', () => {
    expect(() => renderCustomerRouter({ slug: 'musterstadt', hosts: ['a.example'], primaryHost: 'b.example', ...policy })).toThrow(/routed hosts/)
    expect(() => renderCustomerRouter({ slug: 'platform', hosts: ['a.example'], primaryHost: 'a.example', ...policy })).toThrow(ProvisioningError)
  })
})
