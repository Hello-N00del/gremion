import { describe, it, expect } from 'vitest'
import { Role } from '$lib/auth/types'
import { vaultManifest } from './vault'
import { MODULE_MANIFESTS } from '../registry'

// Vault module manifest (#405 design v11). The KERNEL half of the vault
// subsystem: page segment, route prefixes and — since design v11 part 2 — the
// Verwaltung Tresor rail entry. No migrations/realm attribution by design (the
// data plane lives entirely in the vault leaf service).
describe('vault manifest — shape conforms (golden)', () => {
	it('declares the stable id and is toggleable', () => {
		expect(vaultManifest.id).toBe('vault')
		expect(vaultManifest.toggleable).toBe(true)
	})

	it('registers at order 115 (between handover 110 and vaultwarden 120)', () => {
		expect(vaultManifest.order).toBe(115)
	})

	it('owns the member-gated /vault page segment and both route prefixes', () => {
		expect(vaultManifest.pages).toEqual([{ segment: 'vault', minRole: Role.Member }])
		expect(vaultManifest.routePrefixes).toEqual(['/vault', '/api/vault'])
	})

	it('owns the Tresor rail entry (Verwaltung anchor, module-tagged, icon lock)', () => {
		expect(vaultManifest.nav).toEqual([
			{
				kind: 'item',
				href: '/vault',
				label: 'Tresor',
				icon: 'lock',
				role: Role.Member,
				moduleId: 'vault',
			},
		])
	})

	it('owns NO migrations and NO realm fragment (the data plane is the leaf)', () => {
		expect(vaultManifest.migrations).toBeUndefined()
		expect(vaultManifest.realm).toBeUndefined()
	})

	it('is registered in MODULE_MANIFESTS', () => {
		expect(MODULE_MANIFESTS).toContain(vaultManifest)
		expect(MODULE_MANIFESTS.map((m) => m.id)).toContain('vault')
	})
})
