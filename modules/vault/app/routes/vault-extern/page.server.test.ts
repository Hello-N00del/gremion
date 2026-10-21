import { describe, it, expect, vi, beforeEach } from 'vitest'

// Kernel /vault-extern launch page — inert-until-configured stub (disabled
// governance module). The load function's ONLY job is to surface whether
// VAULTWARDEN_BASE_URL is set, and if so, what URL the launch button should
// point at. It must never throw when the var is absent — the page itself
// renders the "activation pending" state in that case.
const hoisted = vi.hoisted(() => ({
  VAULTWARDEN_BASE_URL: undefined as string | undefined,
}))

vi.mock('$env/dynamic/private', () => ({
  env: {
    get VAULTWARDEN_BASE_URL() {
      return hoisted.VAULTWARDEN_BASE_URL
    },
  },
}))

import { load } from './+page.server'

beforeEach(() => {
  hoisted.VAULTWARDEN_BASE_URL = undefined
})

describe('/vault-extern load — inert-until-configured', () => {
  it('returns configured:false and vaultUrl:null when VAULTWARDEN_BASE_URL is unset', async () => {
    hoisted.VAULTWARDEN_BASE_URL = undefined
    const data = await load({} as never)
    expect(data).toEqual({ configured: false, vaultUrl: null })
  })

  it('returns configured:false and vaultUrl:null when VAULTWARDEN_BASE_URL is an empty string', async () => {
    hoisted.VAULTWARDEN_BASE_URL = ''
    const data = await load({} as never)
    expect(data).toEqual({ configured: false, vaultUrl: null })
  })

  it('returns configured:true and the vaultUrl when VAULTWARDEN_BASE_URL is set', async () => {
    hoisted.VAULTWARDEN_BASE_URL = 'https://vault.example.org'
    const data = await load({} as never)
    expect(data).toEqual({ configured: true, vaultUrl: 'https://vault.example.org' })
  })
})
