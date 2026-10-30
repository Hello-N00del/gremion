// org-unit-outbox-not-draining.test.ts
//
// THIS is the not-draining coverage (there is no `org-unit-event-outbox.test.ts`;
// the signal's tests live in this file, next to what they are about).
//
// The outbox's per-row failure handling (last_error, attempts, capped backoff)
// is the design working, so a single failed publish deliberately says nothing.
// The state that had NO signal at all is the one that matters: the outbox is
// owed work and nothing is getting through — which is precisely what a stream
// still on the retired wire root produces, silently, while the queue grows.
//
// Round 3: the signal is PER TENANT. It was process-global, and a global counter
// answers the wrong question on a multi-tenant deployment: one tenant whose rows
// all fail is masked by any other tenant draining normally (the counter resets on
// somebody else's success), and when it does fire it cannot say WHOSE outbox is
// stuck — which is the only thing that makes the line actionable.
//
// Round 5: and the owed state is DERIVED from the drain outcome rather than
// counted by a query. Round 4 asked the database for `count(*) WHERE status <>
// 'ok' AND …` inside the drain transaction, per tenant, every 5 seconds, on a
// never-purged table with no index that predicate can use — a full heap scan on
// the hot path whose cost grows forever, and one that no test touched (inverting
// its WHERE kept every gate green). The three outcomes a pass can have are all
// the signal needs: failed > 0 means the tenant OWES; failed = 0 with ok > 0
// CLEARS it; nothing due changes nothing, because on a stuck tenant that is the
// backoff. The end-to-end proof of the seam lives in
// org-unit-outbox-drain-seam.test.ts, which drives drainOutbox itself.
//
// Round 4: the signal could still never reach its threshold IN PRODUCTION.
// markOutboxFailed sets next_attempt_at = now() + 30 * 2^attempts seconds — 60s
// after the first failure — while the relay ticks every 5s. So the pass after a
// failure fetched ZERO due rows, reported (ok 0, failed 0), and the old
// "consecutive all-failing passes" counter read that as "nothing due, this
// tenant is fine" and reset itself. Counting PASSES is the bug: the passes in
// between a backed-off row's retries are not evidence of health, they are the
// backoff. The signal is now a DURATION over a state the pass can actually
// observe — rows are owed, nothing has been delivered — which is why these tests
// model the backoff explicitly instead of pretending every pass finds work.

import { describe, it, expect, beforeEach } from 'vitest'
import {
  recordDrainOutcome,
  NOT_DRAINING_THRESHOLD,
  NOT_DRAINING_LOG_INTERVAL_MS,
  NOT_DRAINING_WINDOW_MS,
  ORG_UNIT_RELAY_INTERVAL_MS,
  _resetNotDrainingSignalForTests,
} from './org-unit-event-outbox'

const A = 'a0000000-0000-4000-8000-00000000000a'
const B = 'b0000000-0000-4000-8000-00000000000b'

let clock = 1_000_000
const errors: string[] = []
const deps = { now: () => clock, error: (m: string) => errors.push(m) }

/** A pass that tried rows and every one of them failed. */
const allFailed = (t: string, failed = 1) => recordDrainOutcome(t, { ok: 0, failed }, deps)
/** A pass where the rows exist but are all inside their backoff — nothing was DUE. */
const nothingDue = (t: string) => recordDrainOutcome(t, { ok: 0, failed: 0 }, deps)
/** A pass that published something. */
const delivered = (t: string, ok = 3) => recordDrainOutcome(t, { ok, failed: 0 }, deps)
/** A pass on an outbox that owes nothing at all — indistinguishable, per pass, from a backoff. */
const idle = (t: string) => recordDrainOutcome(t, { ok: 0, failed: 0 }, deps)

beforeEach(() => {
  _resetNotDrainingSignalForTests()
  errors.length = 0
  clock = 1_000_000
})

describe('the outbox not-draining signal', () => {
  it('says nothing for a single failing pass — the backoff is the design working', () => {
    allFailed(A)
    expect(errors).toEqual([])
  })

  it('an EMPTY outbox is not a stuck one — an idle tenant must never look stuck', () => {
    for (let i = 0; i < NOT_DRAINING_THRESHOLD * 20; i += 1) {
      idle(A)
      clock += ORG_UNIT_RELAY_INTERVAL_MS
    }
    expect(errors).toEqual([])
  })

  // THE round-4 defect, as the relay actually runs.
  //
  // t=0     one row fails      → next_attempt_at = now + 60s
  // t=5,10  the row is NOT due → the old counter saw (0,0) and RESET to zero
  // t=15    still not due      → the window has elapsed and the tenant has never
  //                              published anything: this is the moment to speak.
  it('reaches the threshold with the row BACKED OFF between passes, inside the documented window', () => {
    const started = clock
    let firedAt: number | null = null

    allFailed(A, 1) // t+0: the only row fails; it will not be due again for 60s
    for (let i = 0; i < 12 && firedAt === null; i += 1) {
      clock += ORG_UNIT_RELAY_INTERVAL_MS
      nothingDue(A) // the row exists, it is simply inside its backoff
      if (errors.length === 1) firedAt = clock
    }

    expect(firedAt, 'a backed-off row must not read as a healthy pass').not.toBeNull()
    expect(firedAt! - started).toBeLessThanOrEqual(NOT_DRAINING_WINDOW_MS)
    expect(errors[0]).toContain('NOT DRAINING')
    expect(errors[0]).toContain(A)
    // The remedy points at what the operator can actually inspect: the row-level
    // last_error and the broker's refusal to repoint the ORGUNIT stream.
    expect(errors[0]).toContain('last_error')
    expect(errors[0]).toContain('refusing to repoint stream ORGUNIT')
    expect(errors[0]).not.toContain('nats:migrate-streams')
    // The window is what the runbook promises an operator: three passes at the
    // relay's own cadence. A signal that needs longer is one nobody is still
    // watching for.
    expect(NOT_DRAINING_WINDOW_MS).toBe(NOT_DRAINING_THRESHOLD * ORG_UNIT_RELAY_INTERVAL_MS)
  })

  it('fires on repeated failing passes too — both shapes are the same stuck state', () => {
    const started = clock
    for (let i = 0; i <= NOT_DRAINING_THRESHOLD; i += 1) {
      allFailed(A, 2)
      if (errors.length > 0) break
      clock += ORG_UNIT_RELAY_INTERVAL_MS
    }
    expect(errors).toHaveLength(1)
    expect(clock - started).toBeLessThanOrEqual(NOT_DRAINING_WINDOW_MS)
  })

  // TWO tenants, injected clock, rows backed off between attempts — the shape the
  // relay actually produces, and the one a global counter could not survive.
  it('is PER TENANT under the real backoff: the stuck one fires, its healthy neighbour does not silence it', () => {
    allFailed(A, 2)
    delivered(B)
    for (let i = 0; i < 6; i += 1) {
      clock += ORG_UNIT_RELAY_INTERVAL_MS
      nothingDue(A) // A's rows are inside their backoff the whole time
      delivered(B) // B drains normally on every single tick
    }
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain(A)
    expect(errors[0]).not.toContain(B)
  })

  it('two stuck tenants each get their OWN line, each naming itself', () => {
    allFailed(A, 1)
    allFailed(B, 3)
    for (let i = 0; i < 6 && errors.length < 2; i += 1) {
      clock += ORG_UNIT_RELAY_INTERVAL_MS
      nothingDue(A)
      nothingDue(B)
    }
    expect(errors).toHaveLength(2)
    expect(errors.filter((e) => e.includes(A))).toHaveLength(1)
    expect(errors.filter((e) => e.includes(B))).toHaveLength(1)
  })

  it('is THROTTLED per tenant — the relay runs every 5s and an unthrottled error is why a log gets ignored', () => {
    allFailed(A, 2)
    allFailed(B, 2)
    for (let i = 0; i < NOT_DRAINING_THRESHOLD + 50; i += 1) {
      clock += ORG_UNIT_RELAY_INTERVAL_MS
      nothingDue(A)
      nothingDue(B)
    }
    expect(errors).toHaveLength(2) // one per tenant, not one per pass

    clock += NOT_DRAINING_LOG_INTERVAL_MS
    nothingDue(A)
    expect(errors).toHaveLength(3)
    expect(errors[2]).toContain(A)
  })

  it('resets the moment anything gets through for THAT tenant, so a recovered relay goes quiet', () => {
    allFailed(A, 1)
    for (let i = 0; i < NOT_DRAINING_THRESHOLD + 1; i += 1) {
      nothingDue(A)
      clock += ORG_UNIT_RELAY_INTERVAL_MS
    }
    expect(errors).toHaveLength(1)

    delivered(A) // recovered
    clock += NOT_DRAINING_LOG_INTERVAL_MS * 10
    nothingDue(A)
    clock += ORG_UNIT_RELAY_INTERVAL_MS
    nothingDue(A)
    // The stuck clock restarts from the recovery: two passes inside the window
    // are not a second outage.
    expect(errors).toHaveLength(1)
  })

  // The KNOWN cost of deriving the owed state from the pass outcome instead of
  // querying it: a pass that fetched nothing is indistinguishable from a pass
  // whose rows are inside their backoff, so a tenant whose rows all aged out
  // past the give-up horizon keeps saying it is not draining — throttled — until
  // something publishes for it. The round-4 count excluded aged-out rows and
  // went quiet. Going quiet about a mirror that is permanently behind is the
  // worse of the two failure modes; this pins the behaviour so the trade is a
  // decision and not a surprise.
  it('keeps naming a tenant whose rows aged out — only a DELIVERY clears the signal', () => {
    allFailed(A, 1)
    for (let i = 0; i < NOT_DRAINING_THRESHOLD + 1; i += 1) {
      nothingDue(A)
      clock += ORG_UNIT_RELAY_INTERVAL_MS
    }
    expect(errors).toHaveLength(1)

    idle(A) // the row aged out — but a pass cannot tell that from a backoff
    clock += NOT_DRAINING_LOG_INTERVAL_MS
    nothingDue(A)
    expect(errors, 'still owing, so the throttled line comes round again').toHaveLength(2)

    delivered(A) // ONLY this clears it
    clock += NOT_DRAINING_LOG_INTERVAL_MS * 10
    nothingDue(A)
    clock += ORG_UNIT_RELAY_INTERVAL_MS
    nothingDue(A)
    expect(errors).toHaveLength(2)
  })

  // A monotonic-clock double, an injected `now` in another test, or a container
  // whose first tick lands on the epoch: `lastLogAt = 0` meant BOTH "never
  // logged" and "logged at time zero", so on a zero-epoch clock the very first
  // line was emitted and then re-emitted on every pass — the throttle read its
  // own sentinel as a timestamp inside the interval.
  it('throttles correctly on a clock whose epoch is 0', () => {
    clock = 0
    allFailed(A, 1)
    for (let i = 0; i < NOT_DRAINING_THRESHOLD + 20; i += 1) {
      nothingDue(A)
      clock += ORG_UNIT_RELAY_INTERVAL_MS
    }
    expect(errors, 'a zero epoch must not defeat the throttle').toHaveLength(1)

    clock += NOT_DRAINING_LOG_INTERVAL_MS
    nothingDue(A)
    expect(errors).toHaveLength(2)
  })
})
