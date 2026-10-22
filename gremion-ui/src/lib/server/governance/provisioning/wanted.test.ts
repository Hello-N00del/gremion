import { describe, it, expect, vi } from 'vitest'
vi.mock('../../db', () => ({ getDb: () => ({}) }))
vi.mock('../../keycloak-admin', () => ({ getKeycloakAdminClientForCurrentTenant: () => ({}) }))
import { wantedSubsystems } from './orchestrator'

const u = { wants_matrix_room: true, wants_nextcloud_folder: true }
describe('wantedSubsystems module gating (F7)', () => {
  it('skips matrix and nextcloud when messaging and files are OFF', () => {
    expect(wantedSubsystems(u, { messages: false, files: false })).toEqual(['keycloak'])
  })
  it('keeps only the enabled module subsystem', () => {
    expect(wantedSubsystems(u, { messages: true, files: false })).toEqual(['keycloak', 'matrix'])
    expect(wantedSubsystems(u, { messages: false, files: true })).toEqual(['keycloak', 'nextcloud'])
  })
  it('both ON honours the wants_* flags as before', () => {
    expect(wantedSubsystems(u, { messages: true, files: true })).toEqual(['keycloak', 'matrix', 'nextcloud'])
    expect(wantedSubsystems({ wants_matrix_room: false, wants_nextcloud_folder: true }, { messages: true, files: true })).toEqual(['keycloak', 'nextcloud'])
  })
})
