// services/content/src/nats-broker.ts
//
// Re-export shim — the canonical NatsBroker implementation lives in
// @gremion/ports/nats so both the content leaf and the gremion-ui monolith
// share ONE class. All existing imports in this package continue to resolve
// here and transparently get the shared impl.
export { NatsBroker, DEFAULT_STREAM } from '@gremion/ports/nats'
