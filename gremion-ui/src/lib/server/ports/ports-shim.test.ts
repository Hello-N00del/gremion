// gremion-ui/src/lib/server/ports/ports-shim.test.ts
// P1 (D-P1-7): broker.ts and tracer.ts are now one-line re-export shims of
// @gremion/ports. This test proves the shims forward the SAME objects as the package
// (so `$lib/server/ports/broker` stays byte-stable for every existing importer) and
// keeps a real spec in this directory — without it a bare
// `vitest run src/lib/server/ports` would exit 1 "No test files found" (fake-green).
import { describe, it, expect } from 'vitest'

import * as brokerShim from './broker'
import * as tracerShim from './tracer'
import * as brokerPkg from '@gremion/ports/broker'
import * as tracerPkg from '@gremion/ports/tracer'

describe('@gremion/ports re-export shims', () => {
  it('broker shim re-exports the SAME runtime objects as @gremion/ports/broker', () => {
    expect(brokerShim.InMemoryBroker).toBe(brokerPkg.InMemoryBroker)
    expect(brokerShim.makeEnvelope).toBe(brokerPkg.makeEnvelope)
    expect(brokerShim.provisioningSubject).toBe(brokerPkg.provisioningSubject)
    expect(brokerShim.newsletterSubject).toBe(brokerPkg.newsletterSubject)
  })
  it('broker shim surfaces the full export set (no member dropped)', () => {
    expect(Object.keys(brokerShim).sort()).toEqual(Object.keys(brokerPkg).sort())
  })
  it('tracer shim re-exports the SAME runtime objects as @gremion/ports/tracer', () => {
    expect(tracerShim.noopTracer).toBe(tracerPkg.noopTracer)
    expect(tracerShim.newCorrelationId).toBe(tracerPkg.newCorrelationId)
    expect(tracerShim.CORRELATION_HEADER).toBe(tracerPkg.CORRELATION_HEADER)
  })
  it('tracer shim surfaces the full export set (no member dropped)', () => {
    expect(Object.keys(tracerShim).sort()).toEqual(Object.keys(tracerPkg).sort())
  })
  it('the moved helpers behave identically through the shim', () => {
    expect(brokerShim.newsletterSubject('default', 'send.succeeded'))
      .toBe('gremion.default.newsletter.send.succeeded')
    expect(tracerShim.CORRELATION_HEADER).toBe('x-correlation-id')
  })
})
