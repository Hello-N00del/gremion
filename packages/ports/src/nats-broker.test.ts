// packages/ports/src/nats-broker.test.ts
//
// The PORT (@gremion/ports/broker) exports the error classes and the timing
// bounds NatsBroker implements, so a downstream that only ever imports the
// port — a boot path, a BrokerSubscription mock, a handler matching on
// `err.name` — can name them without pulling the NATS transport. This file
// imports ./broker.js ONLY, so it is safe under gremion-ui's jsdom vitest run
// (which collects ../packages/ports/src/**/*.test.ts and must never load
// nats-broker.ts — see the header of nats-topology.test.ts). The identity of
// these exports with the ones on @gremion/ports/nats is pinned where that
// module may be loaded: nats-broker-subscribe.integration.test.ts.
import { describe, it, expect } from 'vitest'
import * as broker from './broker.js'

describe('@gremion/ports/broker exports the port error classes', () => {
  const cases: Array<[keyof typeof broker, () => Error]> = [
    ['StreamCoverError', () => new broker.StreamCoverError('S', 'p.>', ['q.>'])],
    ['NoStreamError', () => new broker.NoStreamError('S', 'p.x', ['q.>'])],
    ['StreamRepointedError', () => new broker.StreamRepointedError('S', 'p.>', ['p.>'], ['q.>'])],
    ['StreamGoneError', () => new broker.StreamGoneError('S', 'p.>')],
    ['ConsumerGoneError', () => new broker.ConsumerGoneError('S', 'p.>', 'consumer deleted')],
    ['ConsumerStalledError', () => new broker.ConsumerStalledError('S', 'p.>', 3)],
    ['SetupTimeoutError', () => new broker.SetupTimeoutError('S', 'p.>', 'the cover check', 100)],
  ]

  it.each(cases)('%s is an Error subclass whose name is itself and which names the stream and the pattern', (name, make) => {
    const ctor = broker[name]
    expect(typeof ctor, `${name} is not exported`).toBe('function')
    const err = make()
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(ctor as new (...args: never[]) => Error)
    expect(err.name).toBe(name)
    expect(err.message).toContain('S')
    expect(err.message).toContain('p.')
  })
})

describe('@gremion/ports/broker exports the timing bounds NatsBroker implements', () => {
  it.each(['LIVENESS_FAULT_BOUND_MS', 'SETUP_TIMEOUT_MS', 'CLOSE_TIMEOUT_MS'] as const)(
    '%s is a positive whole number of milliseconds',
    (name) => {
      const value = broker[name]
      expect(typeof value, `${name} is not exported`).toBe('number')
      expect(Number.isInteger(value)).toBe(true)
      expect(value).toBeGreaterThan(0)
    },
  )
})
