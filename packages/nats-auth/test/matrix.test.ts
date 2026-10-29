// TDD 1 — the flow matrix guards. Each break is fed to matrixViolations() on
// a copy of the real inputs; the real inputs themselves must pass.
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { STREAMS } from '@gremion/ports/broker'
import { FLOWS, NO_BROKER, NO_STREAM, OWNER_TO_MODULE, SYSTEM_STREAMS, type MatrixInput, matrixViolations, loadRegistryAddresses } from '../src/flows.ts'
import { TENANT_JETSTREAM_LIMITS } from '../src/render.ts'
import { modulePermissions } from '../src/permissions.ts'

const REPO = path.resolve(import.meta.dirname, '../../..')

const moduleIds = (): string[] =>
  readdirSync(path.join(REPO, 'modules')).filter((d) => statSync(path.join(REPO, 'modules', d)).isDirectory())

const realInput = (): MatrixInput => ({
  flows: structuredClone(FLOWS) as MatrixInput['flows'],
  noBroker: [...NO_BROKER.ids],
  streams: structuredClone(STREAMS) as MatrixInput['streams'],
  systemStreams: structuredClone(SYSTEM_STREAMS) as MatrixInput['streams'],
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

  test('TASK-079 G5: the DLQ system stream is disjoint from every flow stream, and a flow filter that captures a dead-letter subject fails', () => {
    expect(SYSTEM_STREAMS.DLQ!.subjects).toEqual(['gremion.*.dlq.>', '$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.>'])
    const input = realInput()
    input.streams.CONTENT = { name: 'CONTENT', subjects: ['gremion.*.>'] }
    expect(matrixViolations(input).join('\n')).toMatch(/streams CONTENT .* and DLQ .* overlap/)
  })

  test('a system stream that overlaps a flow stream (or takes its name) fails', () => {
    const input = realInput()
    input.systemStreams!.DLQ = { name: 'DLQ', subjects: ['gremion.*.calendar.>'] }
    expect(matrixViolations(input).join('\n')).toMatch(/overlap/)
    const named = realInput()
    named.systemStreams!.CONTENT = { name: 'CONTENT', subjects: ['gremion.*.x.>'] }
    expect(matrixViolations(named).join('\n')).toMatch(/system stream CONTENT has the name of a flow stream/)
  })

  test('the DLQ adds no publisher requirement (the one-publisher-per-stream rule stays flow-only)', () => {
    expect(matrixViolations(realInput()).join('\n')).not.toMatch(/DLQ has/)
  })

  test('the per-tenant stream limit leaves headroom: flow + system streams <= max_streams - 1 (TASK-080/084 add more)', () => {
    const max = Number(/max_streams: (\d+)/.exec(TENANT_JETSTREAM_LIMITS)![1])
    const used = Object.keys(STREAMS).length + Object.keys(SYSTEM_STREAMS).length
    expect(used).toBe(6) // NEWSLETTER CONTENT CALENDAR ORGUNIT IDT + DLQ
    expect(used).toBeLessThanOrEqual(max - 1)
  })

  test('TASK-080-a headroom: IDT makes 6 of 8; TASK-084 adds GOV (7 of 8) and nothing else fits after it', () => {
    const max = Number(/max_streams: (\d+)/.exec(TENANT_JETSTREAM_LIMITS)![1])
    const used = Object.keys(STREAMS).length + Object.keys(SYSTEM_STREAMS).length
    expect(max).toBe(8)
    expect(used + 1).toBeLessThanOrEqual(max - 1) // GOV
    expect(used + 2).toBeGreaterThan(max - 1) // a further stream is a render-limit decision, not a quiet edit
  })

  test('TASK-080-a: the kernel API is its own NATS identity and the only IDT publisher; the kernel cannot publish gremion.<t>.idt.>', () => {
    expect(FLOWS['kernel-api']).toEqual({ publishes: ['IDT'], consumes: [] })
    expect(OWNER_TO_MODULE.idt).toBe('kernel-api')
    expect(FLOWS.kernel!.publishes).not.toContain('IDT')
    const kernelApi = modulePermissions('0192f0c12b3c7d4e8f001122334455aa', 'kernel-api').publish.allow
    expect(kernelApi).toContain('gremion.0192f0c12b3c7d4e8f001122334455aa.idt.>')
    expect(kernelApi.some((a) => a.includes('org-unit'))).toBe(false)
    const kernel = modulePermissions('0192f0c12b3c7d4e8f001122334455aa', 'kernel').publish.allow
    expect(kernel.some((a) => a.includes('.idt.'))).toBe(false)
  })

  test('TASK-080-a guard: STREAMS.IDT removed -> the matrix is RED (unknown stream + the idt registry addresses under no stream)', () => {
    const input = realInput()
    delete (input.streams as Record<string, unknown>).IDT
    const v = matrixViolations(input).join('\n')
    expect(v).toMatch(/flow kernel-api names unknown stream IDT/)
    expect(v).toMatch(/gremion\.\{tenantId\}\.idt\..*not under any stream kernel-api publishes/)
  })

  test('the provisioning no-stream entry is re-dated to TASK-080 (TASK-079 Q12)', () => {
    expect(NO_STREAM.entries.find((e) => e.segment === 'provisioning')?.until).toBe('TASK-080')
  })

  test('FLOWS covers the four NATS callers, the kernel and the kernel API', () => {
    expect(Object.keys(FLOWS).sort()).toEqual(['calendar', 'content', 'finance', 'kernel', 'kernel-api', 'publishing'])
  })
})
