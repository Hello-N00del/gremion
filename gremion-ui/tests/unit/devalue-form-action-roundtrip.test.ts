// R26-DEVALUE (GHSA-9rgm-9g3h-6x36, Dependabot #7): form-action round trip through
// the devalue copy SvelteKit actually loads.
//
// A form action's result reaches the browser as `{type, status, data}` where
// `data` is a devalue string: the server side is kit's stringify_action_response
// (devalue.stringify with the transport encoders), the client side is
// `deserialize` from `$app/forms` (devalue.parse). The advisory is a DoS on the
// parse side through malformed input, so this suite drives kit's REAL
// `deserialize` rather than a stand-in:
//
//   1. a well-formed action result (Date, Map, Set, BigInt, undefined, a shared
//      reference) survives the round trip unchanged;
//   2. a malformed payload whose back-reference points past the end of the value
//      table is REJECTED. devalue 5.8.1 silently hydrated it (dropping the key);
//      5.9.x throws `Invalid input`. This is the behaviour the floor buys.
//   3. the devalue resolved from @sveltejs/kit's own directory sits inside the
//      bounded override `>=5.9.2 <6` in pnpm-workspace.yaml.
//
// devalue is not a direct dependency of gremion-ui, so it is resolved from kit's
// package directory: that is the exact module kit's runtime imports.

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { describe, it, expect, vi } from 'vitest'
import { deserialize } from '$app/forms'

// Outside a started app kit has not registered its transport decoders: in the
// browser build `deserialize` reads them from the client runtime, which `start()`
// initialises. Stand in ONLY for that runtime object (this app defines no custom
// transport, so the decoder table is empty); `deserialize` itself and the devalue
// it calls stay kit's real code.
vi.mock('../../node_modules/@sveltejs/kit/src/runtime/client/client.js', () => ({
  app: { decoders: {} },
  applyAction: () => {}
}))

const requireHere = createRequire(import.meta.url)
const kitDir = dirname(requireHere.resolve('@sveltejs/kit/package.json'))
const requireFromKit = createRequire(join(kitDir, 'package.json'))
const devalueEntry = requireFromKit.resolve('devalue')
// devalue's `exports` map does not expose package.json; walk up from the entry.
const devalueDir = dirname(devalueEntry)
const devalueVersion: string = JSON.parse(readFileSync(join(devalueDir, 'package.json'), 'utf8')).version

type Devalue = { stringify: (value: unknown, reducers?: Record<string, (v: unknown) => unknown>) => string }
const loadDevalue = async (): Promise<Devalue> => import(/* @vite-ignore */ pathToFileURL(devalueEntry).href)

function core(v: string): number[] {
  return v.split('-')[0].split('.').map(Number)
}
function cmp(a: string, b: string): number {
  const pa = core(a)
  const pb = core(b)
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1
  return 0
}

describe('form-action round trip through kit-linked devalue (GHSA-9rgm-9g3h-6x36)', () => {
  it('the devalue kit loads is inside the bounded floor >=5.9.2 <6', () => {
    expect(cmp(devalueVersion, '5.9.2'), `kit resolves devalue ${devalueVersion}`).toBeGreaterThanOrEqual(0)
    expect(cmp(devalueVersion, '6.0.0'), `kit resolves devalue ${devalueVersion}`).toBeLessThan(0)
  })

  it('a well-formed failure result survives stringify -> deserialize unchanged', async () => {
    const devalue = await loadDevalue()
    const shared = { id: 'c-1' }
    const payload = {
      message: 'Name ist erforderlich',
      at: new Date('2026-09-26T20:40:00.000Z'),
      fields: new Map([['name', 'required']]),
      tags: new Set(['fraktion']),
      quota: 12n,
      missing: undefined,
      first: shared,
      again: shared
    }
    // Same wire shape kit's handle_action_json_request emits for fail(400, …).
    const wire = JSON.stringify({ type: 'failure', status: 400, data: devalue.stringify(payload, {}) })

    const result = deserialize<undefined, typeof payload>(wire)

    expect(result.type).toBe('failure')
    if (result.type !== 'failure') return
    expect(result.status).toBe(400)
    const data = result.data as typeof payload
    expect(data.message).toBe(payload.message)
    expect(data.at).toBeInstanceOf(Date)
    expect(data.at.toISOString()).toBe('2026-09-26T20:40:00.000Z')
    expect(data.fields).toBeInstanceOf(Map)
    expect(data.fields.get('name')).toBe('required')
    expect(data.tags).toBeInstanceOf(Set)
    expect([...data.tags]).toEqual(['fraktion'])
    expect(data.quota).toBe(12n)
    expect('missing' in data).toBe(true)
    expect(data.missing).toBeUndefined()
    expect(data.first).toBe(data.again)
  })

  it('a malformed action payload with an out-of-range reference is rejected, not hydrated', () => {
    // Value table has one entry; key "a" points at index 5. devalue 5.8.1 returned {}
    // for this; 5.9.x throws "Invalid input".
    const wire = JSON.stringify({ type: 'success', status: 200, data: '[{"a":5}]' })
    expect(() => deserialize(wire)).toThrow(/Invalid input/)
  })
})
