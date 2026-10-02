// TDD 1 — the flow matrix guards. Each break is fed to matrixViolations() on
// a copy of the real inputs; the real inputs themselves must pass.
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { STREAMS } from '@gremion/ports/broker'
import { FLOWS, NO_BROKER, NO_STREAM, OWNER_TO_MODULE, type MatrixInput, matrixViolations, loadRegistryAddresses } from '../src/flows.ts'

const REPO = path.resolve(import.meta.dirname, '../../..')

const moduleIds = (): string[] =>
  readdirSync(path.join(REPO, 'modules')).filter((d) => statSync(path.join(REPO, 'modules', d)).isDirectory())

const realInput = (): MatrixInput => ({
  flows: structuredClone(FLOWS) as MatrixInput['flows'],
  noBroker: [...NO_BROKER.ids],
  streams: structuredClone(STREAMS) as MatrixInput['streams'],
  registry: loadRegistryAddresses(REPO),
  ownerToModule: { ...OWNER_TO_MODULE },
  noStream: structuredClone(NO_STREAM.entries) as MatrixInput['noStream'],
  moduleIds: moduleIds(),
})

describe('flow matrix (TDD 1)', () => {
  test('the real matrix passes and checks at least one address', () => {
    const input = realInput()
    expect(matrixViolations(input)).toEqual([])
    // today 9: cal 4 + pub 5
    const checked = input.registry.filter((a) => a.owner in input.ownerToModule).length
    expect(checked).toBeGreaterThan(0)
  })

  test('the directory scan found the catalogue modules', () => {
    expect(moduleIds().length).toBeGreaterThan(0)
  })

  test('two publishers on one stream fail', () => {
    const input = realInput()
    input.flows.content = { publishes: ['CONTENT', 'NEWSLETTER'], consumes: [] }
    expect(matrixViolations(input).join('\n')).toMatch(/NEWSLETTER has 2 publishers/)
  })

  test('overlapping stream filters fail', () => {
    const input = realInput()
    input.streams.CONTENT = { name: 'CONTENT', subjects: ['gremion.*.>'] }
    expect(matrixViolations(input).join('\n')).toMatch(/overlap/)
  })

  test('an unmapped registry owner fails', () => {
    const input = realInput()
    delete input.ownerToModule.cal
    expect(matrixViolations(input).join('\n')).toMatch(/owner cal .*neither mapped/)
  })

  test('a mapped address outside its module stream fails', () => {
    const input = realInput()
    input.ownerToModule.pub = 'calendar'
    expect(matrixViolations(input).join('\n')).toMatch(/gremion\.\{tenantId\}\.content\.publish\.succeeded.*not under/)
  })

  test('a stale no-stream entry fails', () => {
    const input = realInput()
    input.noStream.push({ owner: 'gov', segment: 'retired', until: 'TASK-000' })
    expect(matrixViolations(input).join('\n')).toMatch(/stale no-stream entry gov\/retired/)
  })

  test('a no-stream entry whose segment a stream now captures is stale', () => {
    const input = realInput()
    input.streams.GOV = { name: 'GOV', subjects: ['gremion.*.gov.>'] }
    input.flows.kernel = { ...input.flows.kernel!, publishes: [...input.flows.kernel!.publishes, 'GOV'] }
    expect(matrixViolations(input).join('\n')).toMatch(/stale no-stream entry gov\/gov/)
  })

  test('zero checked addresses fail', () => {
    const input = realInput()
    input.registry = input.registry.filter((a) => !(a.owner in input.ownerToModule))
    expect(matrixViolations(input).join('\n')).toMatch(/zero registry addresses checked/)
  })

  test('a modules/* id in neither FLOWS nor NO_BROKER fails', () => {
    const input = realInput()
    input.noBroker = input.noBroker.filter((id) => id !== 'votes')
    expect(matrixViolations(input).join('\n')).toMatch(/module votes is in neither FLOWS nor NO_BROKER/)
  })

  test('a module in both FLOWS and NO_BROKER fails', () => {
    const input = realInput()
    input.noBroker.push('finance')
    expect(matrixViolations(input).join('\n')).toMatch(/finance is in both/)
  })

  test('a consumed stream nobody publishes fails', () => {
    const input = realInput()
    input.flows.kernel = { publishes: [], consumes: ['NEWSLETTER'] }
    expect(matrixViolations(input).join('\n')).toMatch(/ORGUNIT has 0 publishers/)
  })

  test('a flow naming a stream the topology does not know fails', () => {
    const input = realInput()
    input.flows.finance = { publishes: [], consumes: ['LEDGER'] }
    expect(matrixViolations(input).join('\n')).toMatch(/finance names unknown stream LEDGER/)
  })

  test('FLOWS covers the four NATS callers and the kernel', () => {
    expect(Object.keys(FLOWS).sort()).toEqual(['calendar', 'content', 'finance', 'kernel', 'publishing'])
  })
})
