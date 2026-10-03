// Default (jsdom) environment, like the sibling root-redirect.test.ts — these
// loads import `$app/paths`, whose client shim touches `window` at import time.
import { it, expect } from 'vitest'
import { load as pollsLoad } from './+page.server'
import { load as pollsNewLoad } from './new/+page.server'

// #197 folded the standalone /polls list + /polls/new create form into /votes.
// Both stubs are redirect-only, so the 308 + Location IS the whole contract —
// it had no test at all before #449(e). `base` is '' under test (BASE_PATH
// unset); the base-prefixed build is pinned by redirect-shims.base-path.test.ts.
// (/polls/[id] is a real page and is deliberately NOT redirected.)

it('redirects /polls to /votes', async () => {
  await expect(pollsLoad({} as never)).rejects.toMatchObject({ status: 308, location: '/votes' })
})

it('redirects /polls/new to /votes', async () => {
  await expect(pollsNewLoad({} as never)).rejects.toMatchObject({ status: 308, location: '/votes' })
})
