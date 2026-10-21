// packages/events/src/backoff.ts (@gremion/events)
//
// The delivery limits (TASK-079 Q3) as pure functions. Kept in their own file
// so a later `@gremion/events/queue` extraction (the operator request queue,
// TASK-043d) is a move, not a refactor.

/** Relay: attempts before an outbox row becomes dead_lettered [A]. */
export const RELAY_MAX_ATTEMPTS = 10
/** Relay: the cap of the exponential delay, in ms (1 h). */
export const RELAY_BACKOFF_CAP_MS = 3_600_000

/** The delay before the relay's next attempt, once `attempt` (1-based) attempts have failed: min(2^n s, 1 h). */
export function relayBackoffMs(attempt: number): number {
  if (!Number.isInteger(attempt) || attempt < 1) throw new RangeError(`attempt must be an integer >= 1, got ${attempt}`)
  return Math.min(2 ** Math.min(attempt, 30) * 1000, RELAY_BACKOFF_CAP_MS)
}

/** Consumer: deliveries before a message is dead-lettered (JetStream MaxDeliver). */
export const CONSUMER_MAX_DELIVER = 5
/** Consumer: JetStream BackOff, 1 s, 10 s, 60 s, 300 s. NATS needs BackOff length <= MaxDeliver. */
export const CONSUMER_BACKOFF_MS: readonly number[] = Object.freeze([1_000, 10_000, 60_000, 300_000])

/** The nak delay after delivery number `deliveryCount` (1-based) failed: the BackOff entry, the last one repeated. */
export function nakDelayMs(deliveryCount: number, backoff: readonly number[] = CONSUMER_BACKOFF_MS): number {
  if (!Number.isInteger(deliveryCount) || deliveryCount < 1) throw new RangeError(`deliveryCount must be an integer >= 1, got ${deliveryCount}`)
  if (backoff.length === 0) throw new RangeError('backoff must not be empty')
  return backoff[Math.min(deliveryCount, backoff.length) - 1]!
}

/** NATS rejects a consumer whose BackOff is longer than MaxDeliver. */
export function assertConsumerLimits(maxDeliver: number, backoff: readonly number[]): void {
  if (!Number.isInteger(maxDeliver) || maxDeliver < 1) throw new RangeError(`maxDeliver must be an integer >= 1, got ${maxDeliver}`)
  if (backoff.length === 0 || backoff.some((b) => !Number.isInteger(b) || b < 1)) throw new RangeError('backoff must be a non-empty list of positive integer ms')
  if (backoff.length > maxDeliver) throw new RangeError(`backoff has ${backoff.length} entries but maxDeliver is ${maxDeliver} (NATS requires BackOff length <= MaxDeliver)`)
}

/** The delivery horizon after which a received/failed inbox row counts as stalled (10 min [A]). */
export const STALLED_AFTER_MS = 600_000
