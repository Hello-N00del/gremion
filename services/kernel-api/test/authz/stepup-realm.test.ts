// Plan step 1 (Q3 gate), kept as a guard: the step-up check (stepup.ts) refuses a token with no
// auth_time, and Keycloak 26.6.1 emits none unless the CLIENT carries the auth_time mapper (measured
// by kc-auth-time-probe.mjs: absent without it even with max_age=300, present and advancing with it).
// The customer realm's gremion-ui client is the one kernel-api's step-up reads, so it carries the mapper.
// The ops realm's control-panel client does NOT: the plan dropped G4(a), and the panel's own evidence check
// (request-verify.ts) falls back to the ID token's iat, so nothing there needs the claim. The probe adds the
// mapper to its scratch copy of that client at run time instead.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (f: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../../../docker/keycloak/${f}`, import.meta.url)), 'utf8')) as {
  clients: { clientId: string; protocolMappers?: { name: string; protocolMapper: string; config: Record<string, string> }[] }[]
}

describe('step-up clients emit auth_time (Keycloak 26.6.1 measurement)', () => {
  for (const [file, clientId] of [['realm-export.base.json', 'gremion-ui']] as const) {
    it(`${file}: ${clientId} carries an auth_time session-note mapper into the id AND access token`, () => {
      const client = read(file).clients.find((c) => c.clientId === clientId)
      expect(client, `${clientId} in ${file}`).toBeDefined()
      const m = (client!.protocolMappers ?? []).find((x) => x.config['claim.name'] === 'auth_time')
      expect(m, 'auth_time mapper').toBeDefined()
      expect(m!.protocolMapper).toBe('oidc-usersessionmodel-note-mapper')
      expect(m!.config['user.session.note']).toBe('AUTH_TIME')
      expect(m!.config['jsonType.label']).toBe('long')
      expect(m!.config['id.token.claim']).toBe('true')
      expect(m!.config['access.token.claim']).toBe('true')
    })
  }
})
