// TASK-032 round-1 MEDIUM (deletion-aware): migrating `$app/stores` to
// `$app/state` must keep every removed `$page` subscription REACTIVE. The two
// legacy-mode (`export let` / `$:`) SMTP forms read the tenant brand for the
// "from name" placeholder; a legacy `$:` statement tracks only compile-time
// component variables, so `$: brand = resolveBrand(page.data.brand)` would
// run once and never follow a page.data change. Both components are pinned
// here against a real rune-backed page.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/svelte'
import { tick } from 'svelte'

vi.mock('$app/state', async () => ({
  page: (await import('../../../../tests/unit/reactive-page.svelte')).reactivePage,
}))

import { reactivePage } from '../../../../tests/unit/reactive-page.svelte'
import { resolveBrand } from '$lib/brand'
import TabEmail from './TabEmail.svelte'
import Step4Smtp from '../../setup/steps/Step4Smtp.svelte'

const SMTP = { configured: false, host: 'mailpit', port: 1025, from_address: 'noreply@example.org', from_name: '' }

beforeEach(() => {
  reactivePage.data = { brand: null }
})

describe('brand placeholder follows page.data.brand after mount', () => {
  it('TabEmail.svelte', async () => {
    const { container } = render(TabEmail, { props: { smtp: SMTP } })
    const input = () => container.querySelector('#e-name') as HTMLInputElement
    expect(input().placeholder).toBe(resolveBrand(null).product)
    reactivePage.data = { brand: { product: 'Rat Nord' } }
    await tick()
    expect(input().placeholder).toBe('Rat Nord')
  })

  it('Step4Smtp.svelte', async () => {
    const { container } = render(Step4Smtp, { props: { smtp: SMTP, itAdminEmail: 'it@example.org' } })
    const input = () => container.querySelector('#smtp-name') as HTMLInputElement
    expect(input().placeholder).toBe(resolveBrand(null).product)
    reactivePage.data = { brand: { product: 'Rat Nord' } }
    await tick()
    expect(input().placeholder).toBe('Rat Nord')
  })
})
