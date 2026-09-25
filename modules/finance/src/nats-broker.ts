// services/finance/src/nats-broker.ts
//
// Re-export shim — the canonical NatsBroker implementation lives in
// @gremion/ports/nats so the finance leaf, the content/calendar leaves and the
// gremion-ui monolith all share ONE class. The finance leaf is (Lane E1) a NATS
// CONSUMER: src/index.ts connects a NatsBroker bound to the ORGUNIT stream and
// wires the org-unit mirror consumer onto it.
export { NatsBroker, DEFAULT_STREAM } from '@gremion/ports/nats'
