// "Neuer Mandant" (Q6): the form is validated, board is refused by name, and
// gremion-tenant create is started with an argv -- one element per value, no
// shell -- as the signed-in operator.
import { describe, expect, it } from 'vitest'
import { createArgv, startCreate, validateNewCustomer, type NewCustomerInput } from './executor'

const OP = '5b8e0a52-2f9f-4b46-9e3a-0b5c7f1a2d33'
const good: NewCustomerInput = {
  slug: 'musterstadt',
  host: 'rat.musterstadt.example',
  itAdmin: 'IT@musterstadt.example',
  councilAdmin: 'rat@musterstadt.example',
  enable: ['vault', 'calendar'],
  configFile: '/opt/gremion/etc/tenants/musterstadt.json',
}

describe('validateNewCustomer', () => {
  it('accepts a complete form', () => {
    expect(validateNewCustomer(good)).toEqual({})
  })

  it.each([
    ['slug', { slug: '1ab' }],
    ['slug', { slug: 'platform' }],
    ['slug', { slug: 'a--b' }],
    ['host', { host: 'Not A Host' }],
    ['itAdmin', { itAdmin: 'nope' }],
    ['councilAdmin', { councilAdmin: '' }],
    ['enable', { enable: ['board'] }],
    ['enable', { enable: ['calendar; rm -rf /'] }],
  ])('refuses a bad %s', (field, over) => {
    expect(Object.keys(validateNewCustomer({ ...good, ...over }))).toContain(field)
  })
})

describe('createArgv / startCreate', () => {
  it('builds one argv element per value, sorted modules, lower-cased emails, the operator id', () => {
    expect(createArgv(good, OP)).toEqual([
      'create',
      'musterstadt',
      '--host',
      'rat.musterstadt.example',
      '--config',
      '/opt/gremion/etc/tenants/musterstadt.json',
      '--it-admin',
      'it@musterstadt.example',
      '--council-admin',
      'rat@musterstadt.example',
      '--operator',
      OP,
      '--enable',
      'calendar,vault',
    ])
  })

  it('refuses an operator id that is not a uuid', () => {
    expect(() => createArgv(good, 'root')).toThrow(/uuid/)
  })

  it('starts gremion-tenant through the spawner, never a shell string', () => {
    const calls: [string, string[]][] = []
    startCreate(good, OP, (cmd, argv) => void calls.push([cmd, argv]))
    expect(calls).toHaveLength(1)
    expect(calls[0]![0]).toBe('gremion-tenant')
    expect(calls[0]![1][0]).toBe('create')
  })
})
