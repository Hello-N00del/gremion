// packages/ports/src/provisioning-contract.test.ts
//
// The provisioning AsyncAPI contract pinned to provisioningSubject().
//
// contracts/kernel/asyncapi.provisioning.json was the ONE AsyncAPI doc in this
// repo with no contract-tie test: calendar-contract.test.ts and
// content-contract.test.ts each pin their doc's channel addresses to the
// matching wire helper, but the provisioning doc's address was a free-floating
// string. A subject-root rename (SUBJECT_ROOT in ./broker.ts) therefore moved
// provisioningSubject() while the contract kept advertising the old root, and
// nothing in the repo noticed — precisely the drift the sibling tests exist to
// prevent.
//
// provisioningSubject() is deliberately still producer-less (see its CONTRACT
// ANCHOR comment in ./broker.ts). That makes this test the only thing holding
// the helper and the published contract together, so it asserts on EVERY
// channel in the doc, not just the one that happens to exist today.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { provisioningSubject, SUBJECT_ROOT } from './broker'

const portsRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = join(portsRoot, '..', '..')
const contractPath = join(repoRoot, 'contracts', 'kernel', 'asyncapi.provisioning.json')

type Channel = {
  address: string
  parameters?: Record<string, { enum?: string[] }>
}

const doc = JSON.parse(readFileSync(contractPath, 'utf8')) as {
  asyncapi: string
  channels: Record<string, Channel>
  operations: Record<string, { action: string }>
}

const AGGREGATES = ['org-unit', 'member'] as const
const EVENTS = ['requested', 'succeeded', 'failed', 'abandoned'] as const

/** The address the doc MUST carry: the helper's own output with the doc's
 *  parameter placeholders substituted for its three arguments. Built from the
 *  helper so a SUBJECT_ROOT or grammar change moves both sides together. */
const TEMPLATE_ADDRESS = provisioningSubject(
  '{tenantId}',
  '{aggregate}' as (typeof AGGREGATES)[number],
  '{event}' as (typeof EVENTS)[number],
)

describe('provisioning AsyncAPI contract', () => {
  it('is structurally present (AsyncAPI 3.0) and declares at least one channel', () => {
    expect(doc.asyncapi).toBe('3.0.0')
    expect(Object.keys(doc.channels).length).toBeGreaterThan(0)
  })

  // The contract↔runtime tie. EVERY channel, not just a named one: a second
  // channel added with a hand-written address would otherwise drift unseen.
  it('every channel address equals provisioningSubject() with the doc placeholders', () => {
    for (const [id, channel] of Object.entries(doc.channels)) {
      expect(
        channel.address,
        `channel "${id}" address "${channel.address}" !== provisioningSubject('{tenantId}', ` +
          `'{aggregate}', '{event}') === "${TEMPLATE_ADDRESS}" — the doc and the wire helper have drifted`,
      ).toBe(TEMPLATE_ADDRESS)
    }
  })

  it('every channel address is rooted at SUBJECT_ROOT', () => {
    for (const [id, channel] of Object.entries(doc.channels)) {
      expect(
        channel.address.startsWith(`${SUBJECT_ROOT}.`),
        `channel "${id}" address "${channel.address}" is not rooted at "${SUBJECT_ROOT}."`,
      ).toBe(true)
    }
  })

  // The address is parameterized, so the tie above only pins the SHAPE. These
  // pin the value space: the doc's enums must be exactly the unions
  // provisioningSubject() accepts, or the doc advertises subjects the helper
  // cannot build (or omits ones it can).
  it('the {aggregate} and {event} enums match the provisioningSubject() unions', () => {
    for (const [id, channel] of Object.entries(doc.channels)) {
      const params = channel.parameters ?? {}
      expect([...(params.aggregate?.enum ?? [])].sort(), `channel "${id}" aggregate enum`).toEqual(
        [...AGGREGATES].sort(),
      )
      expect([...(params.event?.enum ?? [])].sort(), `channel "${id}" event enum`).toEqual(
        [...EVENTS].sort(),
      )
    }
  })

  // Every concrete subject the enums permit must be buildable by the helper and
  // must be an instance of the advertised template.
  it('every enum combination resolves to a subject matching the advertised address', () => {
    const tokens = TEMPLATE_ADDRESS.split('.')
    for (const aggregate of AGGREGATES) {
      for (const event of EVENTS) {
        const subject = provisioningSubject('t1', aggregate, event)
        const parts = subject.split('.')
        expect(parts).toHaveLength(tokens.length)
        expect(parts[0]).toBe(SUBJECT_ROOT)
        expect(parts[2]).toBe('provisioning')
        expect(parts[3]).toBe(aggregate)
        expect(parts[4]).toBe(event)
      }
    }
  })

  it('declares both a send and a receive operation for the lifecycle channel', () => {
    const actions = Object.values(doc.operations).map((op) => op.action)
    expect(actions).toContain('send')
    expect(actions).toContain('receive')
  })
})
