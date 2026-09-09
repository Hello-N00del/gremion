import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { contentSubject, type ContentEvent } from './broker'

// Resolve repo root regardless of which package CWD vitest uses
// (packages/ports standalone run or gremion-ui monolith run both point to the same file)
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')

describe('content AsyncAPI contract', () => {
  const doc = JSON.parse(readFileSync(join(repoRoot, 'contracts/content/asyncapi.content.json'), 'utf8'))
  const events: ContentEvent[] = ['publish.succeeded', 'publish.failed', 'channel.email.sent', 'channel.portal.sent', 'channel.instagram.enqueued']
  it('declares a channel for every ContentEvent the relay builds', () => {
    const channels = Object.keys(doc.channels ?? {})
    for (const ev of events) {
      const subj = contentSubject('{tenantId}', ev)
      // Exact address match only. A trailing-suffix match is satisfied by ANY subject
      // root, so it stayed green through a root rename while the contract drifted — the
      // guard must compare the full subject contentSubject() builds.
      expect(channels, `contract declares no channel with the exact address ${subj}`).toContain(subj)
    }
  })

  // The check above reads the channel KEY. That key is a JSON object name and carries
  // NO wire meaning: AsyncAPI 3 puts the subject in the channel's `address` field, and
  // `address` is what a generator emits and a consumer binds to. A contract whose keys
  // were renamed but whose addresses were left on the retired root therefore passes the
  // key check while publishing on a subject nothing subscribes to. Assert the field
  // that is actually on the wire, and assert it agrees with its own key.
  it('every declared channel ADDRESS equals contentSubject({tenantId}, event)', () => {
    const entries = Object.entries(doc.channels ?? {}) as Array<[string, { address?: unknown }]>
    expect(entries.length, 'contract declares no channels at all').toBeGreaterThan(0)
    for (const [key, ch] of entries) {
      expect(typeof ch.address, `channel ${key} declares no string address field`).toBe('string')
      expect(ch.address, `channel ${key}: address disagrees with its own channel key`).toBe(key)
    }
    const declared = entries.map(([, ch]) => ch.address as string).sort()
    const expected = events.map((ev) => contentSubject('{tenantId}', ev)).sort()
    expect(declared).toEqual(expected)
  })
})
