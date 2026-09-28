// services/calendar/src/nats-broker.ts
//
// Re-export shim — T15 (D-P1-7) lifted the canonical NatsBroker implementation
// into @gremion/ports/nats so both the calendar leaf and the gremion-ui monolith
// share ONE class. All existing imports in this package continue to resolve here
// and transparently get the shared impl.
export { NatsBroker, DEFAULT_STREAM } from '@gremion/ports/nats'
