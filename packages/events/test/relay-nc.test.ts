// R33 item 6: relay.ts reads the NATS connection off the JetStream client's `nc`
// property (isClosed/isDraining/rtt/close). If a library update renames it, the
// closed-connection recovery would silently become a no-op: this fails first.
import { describe, expect, it } from 'vitest'
import { jetstream } from '@nats-io/jetstream'
import { ncOf } from '../src/relay.ts'

describe('ncOf', () => {
  it('finds the connection on a REAL @nats-io/jetstream client (fails if the property disappears)', () => {
    const fakeNc = { options: { inboxPrefix: '_INBOX' }, isClosed: () => false, isDraining: () => false, info: undefined } as never
    const js = jetstream(fakeNc)
    expect(ncOf(js as never)).toBe(fakeNc)
  })
  it('is undefined for a publisher without a connection-shaped nc', () => {
    expect(ncOf({} as never)).toBeUndefined()
    expect(ncOf({ nc: 'x' } as never)).toBeUndefined()
    expect(ncOf({ nc: null } as never)).toBeUndefined()
  })
})
